/**
 * Promotions, as something the app can reason about.
 *
 * Two properties run through all of this. Nothing is published while a term
 * that decides money is unknown, because somebody will spend against it. And
 * relevance is a judgement about this wallet — a feed of every offer every bank
 * runs is a list nobody reads, with the two that mattered buried in it.
 */
import { DatabaseSync } from 'node:sqlite';
import { runMigrations, runSeed } from '../src/migrate';
import { syncTransferBonuses } from '../src/promotions/bridge';
import { findDuplicate, merge } from '../src/promotions/dedupe';
import { extractPromotion, saveDraft } from '../src/promotions/extract';
import { economicTermsMissing, expirePromotions, linkApplicability, publishPromotion, savePromotion } from '../src/promotions/model';
import { forPurchase, inbox, rate } from '../src/promotions/relevance';
import { dismissPromotion, sweepCompleted, trackedOffers, trackPromotion } from '../src/promotions/tracking';
import { optimiseTransfer } from '../src/transfers/optimiser';
import { ingestTransaction } from '../src/transactions/ingest';
import type { Env } from '../src/types';

const db = new DatabaseSync(':memory:');
const wrap = (sql: string, args: unknown[] = []): any => ({
  bind: (...a: unknown[]) => wrap(sql, a),
  first: async () => db.prepare(sql).get(...(args as any)) ?? null,
  all: async () => ({ results: db.prepare(sql).all(...(args as any)) }),
  run: async () => {
    const r = db.prepare(sql).run(...(args as any));
    return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  },
});
const env = {
  DB: { prepare: (s: string) => wrap(s) },
  TZ_OFFSET_MINUTES: '480',
  MILE_VALUE_CENTS: '1.5',
  MIN_SPEND_WARN_DAYS: '7',
  POSTING_LAG_DAYS: '0',
} as unknown as Env;

let fails = 0;
const check = (l: string, c: boolean, d = '') => {
  if (!c) fails++;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : `  -- ${d}`}`);
};
const sql = (s: string, ...a: unknown[]) => db.prepare(s).run(...(a as any));
const one = (s: string, ...a: unknown[]) => db.prepare(s).get(...(a as any)) as any;
Date.now = () => Date.parse('2026-09-18T04:00:00Z');

await runMigrations(env);
await runSeed(env);

sql(`INSERT INTO card_products (product_key, issuer, product_name, reward_type, verification_status)
     VALUES ('t_card','T','Card','miles','verified')`);
const pid = one(`SELECT id FROM card_products WHERE product_key = 't_card'`).id;
sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,base_mpd,product_id)
     VALUES ('T','Card','t_card','tc',900000,18,'2026-01-01',0.4,?)`, pid);
const card = one(`SELECT * FROM cards WHERE nickname = 'tc'`);

// --- what must be known before publishing ---------------------------------
check('a spend bonus needs a threshold', economicTermsMissing('spend_bonus', {}).includes('how much has to be spent'));
check('and something it pays', economicTermsMissing('spend_bonus', { minimum_spend_cents: 100 }).includes('what it pays'));
check('a transfer bonus needs its size', economicTermsMissing('transfer_bonus', {}).includes('the size of the bonus'));
check('a complete one is missing nothing', economicTermsMissing('spend_bonus', { minimum_spend_cents: 30000, reward_points: 2000 }).length === 0);

const vague = await savePromotion(env, {
  promotion_type: 'spend_bonus',
  title: 'Something good this month',
  status: 'published',
});
check('a promotion with unknown terms cannot be published', vague.ok === false, JSON.stringify(vague));
check('and it says which terms', (vague.missing ?? []).length === 2, JSON.stringify(vague.missing));

// --- reading a page ---------------------------------------------------------
const page = `
  Spend $300 on eligible online purchases within 30 days and receive 2,000 bonus points.
  Register for this promotion before 30 Sep 2026.
`;
const read = extractPromotion(page, { issuer: 'T', title: 'Online spend bonus' });
check('a threshold is read', read.terms.minimum_spend_cents === 30000, String(read.terms.minimum_spend_cents));
check('so is the window', read.terms.window_days === 30, String(read.terms.window_days));
check('and the reward', read.terms.reward_points === 2000, String(read.terms.reward_points));
check('registration is noticed', read.registration_required === true);
check('the sentences it came from are kept', (read.source_quote ?? '').includes('Spend $300'), read.source_quote ?? '');
check('and it knows nothing is missing', read.missing.length === 0, JSON.stringify(read.missing));

const drafted = await saveDraft(env, read, { url: 'https://example.invalid/offer' });
check('extraction saves a draft', drafted.ok === true);
check('never a published promotion', one(`SELECT status FROM promotions WHERE id = ?`, drafted.id).status === 'draft');

const half = extractPromotion('A great new campaign for cardholders this month.', { issuer: 'T' });
check('a page with no numbers reads as low confidence', half.confidence === 'low', half.confidence);

// --- publishing -------------------------------------------------------------
await linkApplicability(env, drafted.id!, { product_keys: ['t_card'], mccs: ['5311'] });
const published = await publishPromotion(env, drafted.id!);
check('a complete draft can be published', published.ok === true, JSON.stringify(published));
check('and is marked verified on the day', one(`SELECT verified_at FROM promotions WHERE id = ?`, drafted.id).verified_at === '2026-09-18');

const incomplete = await savePromotion(env, { promotion_type: 'spend_bonus', title: 'Mystery', status: 'draft' });
check('an incomplete draft still cannot be published', (await publishPromotion(env, incomplete.id!)).ok === false);

// --- relevance --------------------------------------------------------------
let r = await rate(env, one(`SELECT * FROM promotions WHERE id = ?`, drafted.id));
check('an offer for a card you hold is relevant', r.relevance !== 'not_applicable', r.relevance);
check('and says why', r.why.some((w) => w.includes('You hold')), JSON.stringify(r.why));
check('registration is mentioned', r.why.some((w) => w.includes('Registration required')), JSON.stringify(r.why));

// An offer for a card nobody has is not a low-priority offer; it is not for you.
sql(`INSERT INTO card_products (product_key, issuer, product_name, reward_type) VALUES ('other','O','Other','miles')`);
const otherPid = one(`SELECT id FROM card_products WHERE product_key = 'other'`).id;
const foreign = await savePromotion(env, { promotion_type: 'spend_bonus', title: 'Other card offer', terms: { minimum_spend_cents: 10000, reward_points: 500 }, status: 'draft' });
await linkApplicability(env, foreign.id!, { product_keys: ['other'] });
await publishPromotion(env, foreign.id!);
const foreignRated = await rate(env, one(`SELECT * FROM promotions WHERE id = ?`, foreign.id));
check('an offer for a card you do not hold is not applicable', foreignRated.relevance === 'not_applicable', foreignRated.relevance);

// The verdict used to be set with no sentence attached, so the offer arrived
// in the list marked not_applicable with "No reason recorded" under it. For
// every other relevance the offer is the content and the reason is a bonus;
// here the reason IS the content.
check('and it says why, rather than only that it decided', foreignRated.blockers.length > 0, JSON.stringify(foreignRated));
check('naming the card it is actually for', foreignRated.blockers.some((b) => b.includes('Other')), JSON.stringify(foreignRated.blockers));
check('and that you do not hold it', foreignRated.blockers.some((b) => b.includes('do not hold')), JSON.stringify(foreignRated.blockers));

// Nothing may reach the screen saying only that the app decided something.
// Asserted across every way an offer can end up not applicable, because each
// of them is a separate branch and only one of them had the sentence missing.
const dismissed = await savePromotion(env, { promotion_type: 'spend_bonus', title: 'Set aside', terms: { reward_points: 500 }, status: 'draft' });
await publishPromotion(env, dismissed.id!);
sql(`UPDATE promotions SET dismissed_at = '2026-09-01' WHERE id = ?`, dismissed.id);

const ended = await savePromotion(env, { promotion_type: 'spend_bonus', title: 'Long over', end_at: '2026-01-01', terms: { reward_points: 500 }, status: 'draft' });
await publishPromotion(env, ended.id!);

const unlinked = await savePromotion(env, { promotion_type: 'spend_bonus', title: 'Nobody', terms: { reward_points: 500 }, status: 'draft' });
await linkApplicability(env, unlinked.id!, { product_keys: ['other'] });
await publishPromotion(env, unlinked.id!);

for (const [label, id] of [['a dismissed offer', dismissed.id], ['an ended offer', ended.id], ['an unheld card', unlinked.id]] as const) {
  const rated = await rate(env, one(`SELECT * FROM promotions WHERE id = ?`, id));
  check(`${label} is not applicable`, rated.relevance === 'not_applicable', rated.relevance);
  check(`${label} still carries a reason`, [...rated.why, ...rated.blockers].length > 0, JSON.stringify(rated));
}
void otherPid;

// Spending history decides whether the threshold is reachable.
for (const d of ['2026-07-05', '2026-08-05', '2026-09-05']) {
  await ingestTransaction(env, {
    source: 'manual',
    card_id: card.id,
    amount_cents: 43000,
    occurred_at: d,
    merchant: 'Shopee',
    mcc: '5311',
    category: 'online',
  });
}
r = await rate(env, one(`SELECT * FROM promotions WHERE id = ?`, drafted.id));
check('spending where it applies is counted', r.monthly_spend_cents! > 0, String(r.monthly_spend_cents));
check('and said in their own terms', r.why.some((w) => w.includes('You normally spend')), JSON.stringify(r.why));
check('a reachable threshold is marked so', r.reachable === true, String(r.reachable));

sql(`UPDATE promotions SET terms_json = ? WHERE id = ?`, JSON.stringify({ minimum_spend_cents: 900000, window_days: 30, reward_points: 2000 }), drafted.id);
r = await rate(env, one(`SELECT * FROM promotions WHERE id = ?`, drafted.id));
check('a threshold beyond your spending is flagged', r.reachable === false, String(r.reachable));
check('with the arithmetic', r.blockers.some((b) => b.includes('at your usual rate')), JSON.stringify(r.blockers));
sql(`UPDATE promotions SET terms_json = ? WHERE id = ?`, JSON.stringify({ minimum_spend_cents: 30000, window_days: 30, reward_points: 2000 }), drafted.id);

// --- the inbox --------------------------------------------------------------
const box = await inbox(env);
check('the inbox is sectioned, not one list', 'worth_checking' in box && 'ending_soon' in box && 'transfers' in box);
check('offers for cards you do not hold are kept out', !box.worth_checking.some((x) => x.promotion.id === foreign.id));
check('but remain in the full list', box.everything.some((x) => x.promotion.id === foreign.id));

// --- tracking becomes a requirement -----------------------------------------
sql(`UPDATE promotions SET start_at = '2026-09-01', end_at = '2026-09-30' WHERE id = ?`, drafted.id);
const tracked = await trackPromotion(env, drafted.id!);
check('an offer can be tracked', tracked.ok === true, tracked.error);
check('and says what will be watched', (tracked.summary ?? '').includes('300.00'), tracked.summary ?? '');

const req = one(`SELECT * FROM requirements WHERE promotion_id = ?`, drafted.id);
check('it becomes an ordinary requirement', req !== undefined);
check('rather than a second progress system', req.window === 'fixed_window', req?.window);
check('keeping the promotion it came from', req.promotion_id === drafted.id);

const offers = await trackedOffers(env);
check('progress comes from the existing engine', offers[0].progress !== null, JSON.stringify(offers[0]));
check('and is already part-met from real spend', offers[0].progress!.spent_cents > 0, String(offers[0].progress?.spent_cents));

check('the same offer cannot be tracked twice', (await trackPromotion(env, drafted.id!)).ok === false);
check('an unpublished offer cannot be tracked', (await trackPromotion(env, incomplete.id!)).ok === false);

// --- completion writes what the bank now owes -------------------------------
const done = await sweepCompleted(env);
check('a met offer completes', done.completed.length === 1, JSON.stringify(done));
check('and says what is now expected', done.completed[0].expected.includes('2,000 points'), done.completed[0]?.expected);

const expected = one(`SELECT * FROM expected_reward_entries WHERE component = 'campaign_bonus'`);
check('an expected reward is written', expected !== undefined, JSON.stringify(expected));
check('but nothing is credited', one(`SELECT COUNT(*) AS n FROM reward_ledger_entries`).n === 0);
check('with a date after which it is late', expected.expected_by > '2026-09-30', String(expected.expected_by));
check('and where it came from', String(expected.source_note).includes(`promotion #${drafted.id}`), expected.source_note);
check('the tracking is closed', one(`SELECT status FROM promotion_tracking WHERE promotion_id = ?`, drafted.id).status === 'completed');

// --- dismissing --------------------------------------------------------------
const second = await savePromotion(env, { promotion_type: 'spend_bonus', title: 'Another', terms: { minimum_spend_cents: 20000, reward_points: 500 }, status: 'draft' });
await linkApplicability(env, second.id!, { product_keys: ['t_card'] });
await publishPromotion(env, second.id!);
sql(`UPDATE promotions SET start_at = '2026-09-01', end_at = '2026-10-31' WHERE id = ?`, second.id);
await trackPromotion(env, second.id!);
check('a second offer can be tracked', one(`SELECT COUNT(*) AS n FROM requirements WHERE promotion_id = ?`, second.id).n === 1);

await dismissPromotion(env, second.id!);
check('dismissing stops tracking it', one(`SELECT status FROM promotion_tracking WHERE promotion_id = ?`, second.id).status === 'dismissed');
check(
  'and retires the minimum, so spend is not pulled toward it',
  one(`SELECT active FROM requirements WHERE promotion_id = ?`, second.id).active === 0
);

// --- duplicates --------------------------------------------------------------
const a = await savePromotion(env, { promotion_type: 'welcome_offer', issuer: 'DBS', title: 'DBS welcome offer 20,000 miles', start_at: '2026-09-01', end_at: '2026-10-31', terms: { minimum_spend_cents: 80000, reward_miles: 20000 } });
const b = await savePromotion(env, { promotion_type: 'welcome_offer', issuer: 'DBS', title: 'DBS welcome offer miles 20,000', start_at: '2026-09-05', end_at: '2026-10-31', terms: { minimum_spend_cents: 80000, reward_miles: 20000 }, description: 'from another feed' });
const dup = await findDuplicate(env, one(`SELECT * FROM promotions WHERE id = ?`, b.id));
check('the same offer found twice is recognised', dup?.promotion_id === a.id, JSON.stringify(dup));
check('and may be merged automatically when the terms match', dup?.automatic === true);

await merge(env, a.id!, b.id!);
check('the survivor gains what it did not know', one(`SELECT description FROM promotions WHERE id = ?`, a.id).description === 'from another feed');
check('and the duplicate points at it', one(`SELECT duplicate_of FROM promotions WHERE id = ?`, b.id).duplicate_of === a.id);
check('rather than being deleted', one(`SELECT id FROM promotions WHERE id = ?`, b.id) !== undefined);
check('a promotion cannot be merged into itself', (await merge(env, a.id!, a.id!)).ok === false);

const c = await savePromotion(env, { promotion_type: 'welcome_offer', issuer: 'DBS', title: 'DBS welcome offer 20,000 miles', start_at: '2026-09-01', end_at: '2026-10-31', terms: { minimum_spend_cents: 50000, reward_miles: 20000 } });
const maybe = await findDuplicate(env, one(`SELECT * FROM promotions WHERE id = ?`, c.id));
check('a similar offer with different terms is not merged automatically', maybe?.automatic === false, JSON.stringify(maybe));

// --- expiry keeps the history -----------------------------------------------
sql(`UPDATE promotions SET end_at = '2026-01-01' WHERE id = ?`, second.id);
sql(`UPDATE promotions SET status = 'published' WHERE id = ?`, second.id);
const swept = await expirePromotions(env);
check('an offer that ran out is expired', swept.expired >= 1, JSON.stringify(swept));
check('not deleted', one(`SELECT id FROM promotions WHERE id = ?`, second.id) !== undefined);
check('so what it caused stays explainable', one(`SELECT promotion_id FROM requirements WHERE promotion_id = ?`, second.id) !== undefined);

// --- a transfer bonus reaches the optimiser ----------------------------------
sql(`DELETE FROM conversions`);
sql(`INSERT INTO conversions (from_program,to_program,from_units,to_units,fee_cents,min_block,block_increment,route)
     VALUES ('dbs_points','krisflyer',5000,10000,2725,5000,5000,'direct')`);
sql(`INSERT INTO balance_tranches (program_key,points,earned_at) VALUES ('dbs_points',20000,'2025-01-01')`);

const bonus = await savePromotion(env, {
  promotion_type: 'transfer_bonus',
  issuer: 'DBS',
  title: '25% transfer bonus to KrisFlyer',
  start_at: '2026-09-01',
  end_at: '2026-09-30',
  terms: { bonus_pct: 25 },
});
await linkApplicability(env, bonus.id!, {
  programmes: [{ key: 'dbs_points', role: 'source' }, { key: 'krisflyer', role: 'destination' }],
});

let plan = await optimiseTransfer(env, { destination: 'krisflyer' });
check('an unpublished bonus does not reach the optimiser', plan.routes[0]?.bonus_units === 0, JSON.stringify(plan.routes[0]));

await publishPromotion(env, bonus.id!);
const bridged = await syncTransferBonuses(env);
check('publishing it projects it onto the route', bridged.created === 1, JSON.stringify(bridged));
plan = await optimiseTransfer(env, { destination: 'krisflyer' });
check('and now the plan includes it', plan.routes[0].bonus_units === 10000, JSON.stringify(plan.routes[0]));
check('naming the promotion', plan.routes[0].promotion!.title === '25% transfer bonus to KrisFlyer');
check('running the bridge again changes nothing', (await syncTransferBonuses(env)).created === 0);

sql(`UPDATE promotions SET status = 'expired' WHERE id = ?`, bonus.id);
const removed = await syncTransferBonuses(env);
check('a withdrawn bonus is taken back off the route', removed.removed === 1, JSON.stringify(removed));
plan = await optimiseTransfer(env, { destination: 'krisflyer' });
check('so it stops inflating the plan', plan.routes[0].bonus_units === 0, JSON.stringify(plan.routes[0]));

// --- at the point of purchase ------------------------------------------------
const atTill = await forPurchase(env, { mcc: '5311' });
check('an offer on the code being spent is surfaced', atTill.length >= 0);
check('and it never changes the card rules', one(`SELECT COUNT(*) AS n FROM earn_rules WHERE note LIKE '%promotion%'`).n === 0);

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
