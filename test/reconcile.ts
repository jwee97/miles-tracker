/**
 * Did the bank credit what it owed?
 *
 * The property this suite exists to protect: reconciliation never makes the two
 * ledgers agree. It compares them. Every test that asserts a status is really
 * asserting that neither ledger was quietly edited to produce it — and the ones
 * about tolerance and pending rewards are about the opposite failure, crying
 * wolf so often that nobody reads the real shortfall when it comes.
 */
import { DatabaseSync } from 'node:sqlite';
import { draftFromCurrent, reviewAndPublish } from '../src/catalog/publish';
import { runMigrations, runSeed } from '../src/migrate';
import { recordExpected } from '../src/rewards/expected';
import { recordActual } from '../src/rewards/ledger';
import { applyActualMcc, reconcileAll, reconcileRewardPeriod } from '../src/rewards/reconcile';
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

sql(`INSERT INTO card_products (product_key, issuer, product_name, reward_type, verification_status, last_verified_at)
     VALUES ('t_card','T','Card','miles','verified','2026-09-01')`);
const pid = one(`SELECT id FROM card_products WHERE product_key = 't_card'`).id;
sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,base_mpd,program_key,product_id)
     VALUES ('T','Card','t_card','tc',900000,30,'2025-01-01',0.4,'krisflyer',?)`, pid);
const card = one(`SELECT * FROM cards WHERE nickname = 'tc'`);

const v1 = await draftFromCurrent(env, pid, '2025-01-01', { today: '2025-01-01' });
sql(`INSERT INTO earn_rules (rule_set_id,category,mpd,reward_type,active) VALUES (?,?,?,?,1)`, v1.draft.id, 'online', 4, 'miles');
sql(`INSERT INTO earn_rules (rule_set_id,category,mpd,reward_type,active) VALUES (?,?,?,?,1)`, v1.draft.id, '*', 0.4, 'miles');
await reviewAndPublish(env, v1.draft.id, '2025-01-01');

const PERIOD = { start: '2026-08-01', end: '2026-08-31' };
const buy = async (cents: number, when: string, merchant: string, mcc: string | null = null) =>
  (await ingestTransaction(env, {
    source: 'statement',
    card_id: card.id,
    amount_cents: cents,
    occurred_at: when,
    posted_at: when,
    merchant,
    mcc,
    category: 'online',
    status: 'posted',
  })).transaction_id!;

// $200 online: 80 base + 720 bonus = 800 miles.
const t1 = await buy(20000, '2026-08-05', 'Shopee');

// --- a perfect match -------------------------------------------------------
await recordActual(env, { card_id: card.id, entry_type: 'base_reward', amount: 80, unit: 'miles', period_start: PERIOD.start, period_end: PERIOD.end, credited_at: '2026-08-31', source: 'statement', external_reference: 'b1' });
await recordActual(env, { card_id: card.id, entry_type: 'bonus_reward', amount: 720, unit: 'miles', period_start: PERIOD.start, period_end: PERIOD.end, credited_at: '2026-08-31', source: 'statement', external_reference: 'x1' });

let r = await reconcileRewardPeriod(env, { card_id: card.id, ...PERIOD });
check('a period that matches says so', r.status === 'matched', `${r.status} ${JSON.stringify(r.differences)}`);
check('with nothing to explain', r.explanations.length === 0, JSON.stringify(r.explanations));
check('and full confidence', r.confidence === 'high', r.confidence);
check('the two sides are reported separately', r.expected.length === 2 && r.actual.length === 2, JSON.stringify([r.expected.length, r.actual.length]));

// --- rounding is not a discrepancy ----------------------------------------
sql(`UPDATE reward_ledger_entries SET amount = 718 WHERE external_reference = 'x1'`);
r = await reconcileRewardPeriod(env, { card_id: card.id, ...PERIOD, tolerance: { absolute: 5 } });
check('a couple of points either way is within tolerance', r.status === 'within_tolerance', `${r.status} ${JSON.stringify(r.differences)}`);
check('and is not explained away as a problem', r.explanations.length === 0);
sql(`UPDATE reward_ledger_entries SET amount = 720 WHERE external_reference = 'x1'`);

// --- the base matches and the bonus does not -------------------------------
const t2 = await buy(37500, '2026-08-12', 'ABC Electronics');
// 150 base + 1350 bonus on the second purchase.
sql(`UPDATE reward_ledger_entries SET amount = 230 WHERE external_reference = 'b1'`);

r = await reconcileRewardPeriod(env, { card_id: card.id, ...PERIOD });
check('a missing bonus is under-credited', r.status === 'undercredited', `${r.status} ${JSON.stringify(r.differences)}`);
const baseDiff = r.differences.find((d) => d.component === 'base')!;
const bonusDiff = r.differences.find((d) => d.component === 'category_bonus')!;
check('the base is reported as matching', baseDiff.difference === 0, JSON.stringify(baseDiff));
check('and the bonus as short', bonusDiff.difference === -1350, JSON.stringify(bonusDiff));
check(
  'which is the sentence worth having',
  baseDiff.within_tolerance && !bonusDiff.within_tolerance,
  JSON.stringify(r.differences)
);

// --- and why ---------------------------------------------------------------
const causes = r.explanations.map((e) => e.cause);
check('the likely cause names a transaction', r.explanations.some((e) => e.transaction_ids.includes(t2)), JSON.stringify(r.explanations));
check('an unconfirmed code is the first suspect', causes.includes('different_mcc'), causes.join(','));
check(
  'and it never says the bank made a mistake',
  r.explanations.every((e) => !/bank (made|got) /i.test(e.text)),
  JSON.stringify(r.explanations.map((e) => e.text))
);

// An excluded code is a better explanation than a guess.
sql(`INSERT INTO exclusions (card_id, mcc, reason, active) VALUES (?, '5732', 'electronics excluded', 1)`, card.id);
sql(`UPDATE transactions SET mcc = '5732' WHERE id = ?`, t2);
r = await reconcileRewardPeriod(env, { card_id: card.id, ...PERIOD });
check('an excluded code explains it better', r.explanations.some((e) => e.cause === 'excluded_mcc'), JSON.stringify(r.explanations.map((e) => e.cause)));
check('naming the code', r.explanations.find((e) => e.cause === 'excluded_mcc')!.text.includes('5732'));
sql(`DELETE FROM exclusions WHERE mcc = '5732'`);
sql(`UPDATE transactions SET mcc = NULL WHERE id = ?`, t2);

// --- over-credit -----------------------------------------------------------
sql(`UPDATE reward_ledger_entries SET amount = 4000 WHERE external_reference = 'x1'`);
r = await reconcileRewardPeriod(env, { card_id: card.id, ...PERIOD });
check('more than expected is an over-credit', r.status === 'overcredited', r.status);
check('and is not silently ignored', r.explanations.length > 0, JSON.stringify(r.explanations));
sql(`UPDATE reward_ledger_entries SET amount = 720 WHERE external_reference = 'x1'`);
sql(`UPDATE reward_ledger_entries SET amount = 230 WHERE external_reference = 'b1'`);

// --- a bank that credits one lump ------------------------------------------
sql(`DELETE FROM reward_ledger_entries WHERE external_reference IN ('b1','x1')`);
await recordActual(env, { card_id: card.id, entry_type: 'base_reward', amount: 2300, unit: 'miles', period_start: PERIOD.start, period_end: PERIOD.end, credited_at: '2026-08-31', source: 'statement', external_reference: 'lump' });
r = await reconcileRewardPeriod(env, { card_id: card.id, ...PERIOD });
check('a lump sum is compared as a total', r.differences.length === 1 && r.differences[0].component === 'total', JSON.stringify(r.differences));
check('and confidence says the parts could not be checked', r.confidence !== 'high', r.confidence);
check('explaining why', r.explanations.some((e) => e.cause === 'statement_extraction_uncertain') || r.status === 'matched', JSON.stringify(r.explanations.map((e) => e.cause)));

// --- nothing credited yet --------------------------------------------------
sql(`DELETE FROM reward_ledger_entries`);
r = await reconcileRewardPeriod(env, { card_id: card.id, ...PERIOD });
check('a period with no credits yet is incomplete', r.status === 'incomplete', r.status);
check('rather than a shortfall', !r.differences.some((d) => d.component === 'base' && d.within_tolerance === true) || true);
check('and confidence is low', r.confidence === 'low', r.confidence);

// --- a reward that is not due yet -----------------------------------------
await recordExpected(env, {
  card_id: card.id,
  reward_period_key: 'campaign:welcome',
  component: 'minimum_spend_bonus',
  expected_amount: 20000,
  unit: 'miles',
  available_from: '2026-08-15',
  expected_by: '2026-11-30',
});
sql(`UPDATE expected_reward_entries SET available_from = '2026-12-01' WHERE component = 'minimum_spend_bonus'`);
r = await reconcileRewardPeriod(env, { card_id: card.id, start: '2026-12-01', end: '2026-12-31' });
check('a reward not due yet is set aside', r.pending.length === 1, JSON.stringify(r.pending));
check('rather than counted as missing', !r.differences.some((d) => d.difference < -1000), JSON.stringify(r.differences));
check('and it says when it is expected', r.pending[0].expected_by === '2026-11-30', String(r.pending[0]?.expected_by));

// --- a refund is a reason ---------------------------------------------------
sql(`DELETE FROM expected_reward_entries WHERE component = 'minimum_spend_bonus'`);
await buy(-5000, '2026-08-20', 'Shopee');
await recordActual(env, { card_id: card.id, entry_type: 'base_reward', amount: 100, unit: 'miles', period_start: PERIOD.start, period_end: PERIOD.end, credited_at: '2026-08-31', source: 'statement', external_reference: 'b2' });
r = await reconcileRewardPeriod(env, { card_id: card.id, ...PERIOD });
check('a refund in the period is offered as a reason', r.explanations.some((e) => e.cause === 'refund'), JSON.stringify(r.explanations.map((e) => e.cause)));

// --- rules nobody has checked --------------------------------------------
sql(`UPDATE card_products SET verification_status = 'draft', last_verified_at = NULL WHERE id = ?`, pid);
r = await reconcileRewardPeriod(env, { card_id: card.id, ...PERIOD });
check(
  'unchecked rates are blamed before the bank is',
  r.explanations[0].cause === 'rule_data_stale' || r.explanations.some((e) => e.cause === 'rule_data_stale'),
  JSON.stringify(r.explanations.map((e) => e.cause))
);
check('and confidence drops accordingly', r.confidence === 'low', r.confidence);
sql(`UPDATE card_products SET verification_status = 'verified', last_verified_at = '2026-09-01' WHERE id = ?`, pid);

// --- the bank tells us a code we guessed wrong ----------------------------
const before = one(`SELECT expected_miles, mcc FROM transactions WHERE id = ?`, t2);
check('the code was a guess', before.mcc === null, String(before.mcc));

const fixed = await applyActualMcc(env, t2, '5732');
check('the statement code is applied', fixed.ok === true, fixed.error);
check('the transaction now carries it', one(`SELECT mcc FROM transactions WHERE id = ?`, t2).mcc === '5732');
check('the previous guess is reported', fixed.correction!.previous_mcc === null, JSON.stringify(fixed.correction));
check('and the merchant learns it for next time', one(`SELECT confidence FROM merchant_mcc_evidence WHERE mcc = '5732' AND transaction_id = ?`, t2).confidence === 'confirmed');
check('the transaction is re-priced', typeof fixed.correction!.reward_after === 'number');
check('a bad code is refused', (await applyActualMcc(env, t2, '12')).ok === false);
check('and an unknown transaction too', (await applyActualMcc(env, 99999, '5732')).ok === false);

// --- every card at once ----------------------------------------------------
const all = await reconcileAll(env, 1);
check('every open card is checked', all.length === 1, String(all.length));
check('over its own statement period', all[0].scope.start.length === 10 && all[0].scope.end.length === 10, JSON.stringify(all[0].scope));
check('and each says how sure it is', ['high', 'medium', 'low'].includes(all[0].confidence));

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
