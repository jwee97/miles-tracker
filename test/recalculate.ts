/**
 * Re-pricing what the app believed.
 *
 * Two of these matter more than the rest. A recalculation must never overwrite
 * what the bank actually paid — that is the only thing the reward audit can
 * check a prediction against, and losing it is silent. And it must be
 * reproducible: re-pricing August has to give August's answer today, tomorrow
 * and after fifty more purchases, or the number is not a recalculation, it is
 * whatever the ledger happened to look like when someone pressed the button.
 */
import { DatabaseSync } from 'node:sqlite';
import { draftFromCurrent, reviewAndPublish } from '../src/catalog/publish';
import { runMigrations, runSeed } from '../src/migrate';
import { recalculateMany, recalculateTransaction } from '../src/transactions/recalculate';
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
     VALUES ('t_card','T','Card','miles','draft')`);
const pid = one(`SELECT id FROM card_products WHERE product_key = 't_card'`).id;
sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,base_mpd,product_id)
     VALUES ('T','Card','t_card','tc',900000,28,'2025-01-01',0.4,?)`, pid);
const card = one(`SELECT * FROM cards WHERE nickname = 'tc'`);

// Version 1: 4 mpd on online, capped at $1,000 a calendar month.
const v1 = await draftFromCurrent(env, pid, '2025-01-01', { today: '2025-01-01' });
sql(`INSERT INTO earn_rules (rule_set_id,category,mpd,reward_type,cap_cents,cap_window,active)
     VALUES (?,?,?,?,?,?,1)`, v1.draft.id, 'online', 4, 'miles', 100000, 'calendar_month');
sql(`INSERT INTO earn_rules (rule_set_id,category,mpd,reward_type,active) VALUES (?,?,?,?,1)`, v1.draft.id, '*', 0.4, 'miles');
await reviewAndPublish(env, v1.draft.id, '2025-01-01');

const log = async (amount: number, when: string, merchant: string) => {
  const r = await ingestTransaction(env, {
    source: 'manual',
    card_id: card.id,
    amount_cents: amount,
    occurred_at: when,
    merchant,
    category: 'online',
  });
  return r.transaction_id!;
};

// August: $600, then $600 — the second half runs past the $1,000 monthly cap.
const aug1 = await log(60000, '2026-08-05', 'Shopee');
const aug2 = await log(60000, '2026-08-20', 'Lazada');

check('the first purchase is all at the bonus rate', one(`SELECT expected_miles FROM transactions WHERE id = ?`, aug1).expected_miles === 2400, String(one(`SELECT expected_miles FROM transactions WHERE id = ?`, aug1).expected_miles));
check(
  'and the second is blended across the cap',
  one(`SELECT expected_miles FROM transactions WHERE id = ?`, aug2).expected_miles === 1680,
  String(one(`SELECT expected_miles FROM transactions WHERE id = ?`, aug2).expected_miles)
);

// What the bank actually paid, entered by hand.
sql(`UPDATE transactions SET actual_miles = 2400 WHERE id = ?`, aug1);
sql(`UPDATE transactions SET actual_miles = 1600 WHERE id = ?`, aug2);

// --- the cap position is as of the transaction, not as of now -------------
// More August spend, logged later. It must not change what the first purchase
// was worth: a cap fills in ledger order.
await log(30000, '2026-08-25', 'Qoo10');
const again = await recalculateTransaction(env, aug1);
check('re-pricing is not affected by later purchases', again.change!.after.miles === 2400, JSON.stringify(again.change));
check('so nothing changed', again.change!.changed === false, again.change?.summary);

const twice = await recalculateTransaction(env, aug1);
check('and running it again gives the same answer', twice.change!.after.miles === 2400);

check('what the bank actually paid is untouched', one(`SELECT actual_miles FROM transactions WHERE id = ?`, aug1).actual_miles === 2400);

// --- a rule corrected after the fact --------------------------------------
// The online rate was read wrong: it was 2 mpd, not 4, and always had been.
sql(`UPDATE earn_rules SET mpd = 2 WHERE rule_set_id = ? AND category = 'online'`, v1.draft.id);

const fixed = await recalculateTransaction(env, aug1);
check('a corrected rate re-prices the purchase', fixed.change!.after.miles === 1200, JSON.stringify(fixed.change));
check('the change is reported in words', fixed.change!.summary === '2,400 miles → 1,200 miles', fixed.change?.summary);
check('and it is marked as changed', fixed.change!.changed === true);
check(
  'but what the bank paid still stands',
  one(`SELECT actual_miles FROM transactions WHERE id = ?`, aug1).actual_miles === 2400,
  String(one(`SELECT actual_miles FROM transactions WHERE id = ?`, aug1).actual_miles)
);
check('and the audit can now see the gap', one(`SELECT actual_miles - expected_miles AS d FROM transactions WHERE id = ?`, aug1).d === 1200);
check('the rule version is recorded', one(`SELECT evaluated_rule_set_id FROM transactions WHERE id = ?`, aug1).evaluated_rule_set_id === v1.draft.id);
check('with the date it was priced', one(`SELECT evaluated_at FROM transactions WHERE id = ?`, aug1).evaluated_at === '2026-09-18');

// --- a new version must not rewrite the past ------------------------------
const v2 = await draftFromCurrent(env, pid, '2026-09-01', { today: '2026-09-18' });
sql(`UPDATE earn_rules SET mpd = 10 WHERE rule_set_id = ? AND category = 'online'`, v2.draft.id);
await reviewAndPublish(env, v2.draft.id, '2026-09-18');

const stillAugust = await recalculateTransaction(env, aug1);
check(
  'an August purchase is re-priced by August rules, not by todays',
  stillAugust.change!.after.miles === 1200,
  JSON.stringify(stillAugust.change)
);
check('and stays on the version that applied then', stillAugust.change!.after.rule_set_id === v1.draft.id);

const sept = await log(10000, '2026-09-10', 'Shopee');
check('while September gets the new rate', one(`SELECT expected_miles FROM transactions WHERE id = ?`, sept).expected_miles === 1000, String(one(`SELECT expected_miles FROM transactions WHERE id = ?`, sept).expected_miles));

// --- the batch -------------------------------------------------------------
const report = await recalculateMany(env, { nickname: 'tc' });
check('a batch covers every purchase on the card', report.considered === 4, String(report.considered));
check('and nothing fails', report.failed.length === 0, JSON.stringify(report.failed));
check('it totals what changed', report.miles_after !== report.miles_before || report.changed === 0, JSON.stringify([report.miles_before, report.miles_after]));

const rerun = await recalculateMany(env, { nickname: 'tc' });
check('running the batch twice changes nothing the second time', rerun.changed === 0, JSON.stringify(rerun.changes.map((c) => c.summary)));
check('which is how a recalculation proves it is reproducible', rerun.unchanged === 4, String(rerun.unchanged));

// Filters.
const scoped = await recalculateMany(env, { nickname: 'tc', from: '2026-09-01' });
check('a batch can be scoped to a date', scoped.considered === 1, String(scoped.considered));
const byVersion = await recalculateMany(env, { rule_set_id: v1.draft.id });
check('or to the rule version that priced them', byVersion.considered === 3, String(byVersion.considered));
const nobody = await recalculateMany(env, { nickname: 'nope' });
check('an unknown card touches nothing', nobody.considered === 0, String(nobody.considered));

// --- a refund has nothing to re-price -------------------------------------
sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at,merchant,category,status)
     VALUES (?,-5000,'2026-09-12','Shopee','online','posted')`, card.id);
const refundId = one(`SELECT MAX(id) AS id FROM transactions`).id;
const refund = await recalculateTransaction(env, refundId);
check('a refund is not an error', refund.ok === true, refund.error);
check('it simply earns nothing', refund.change!.summary === 'a refund earns nothing', refund.change?.summary);
check('and a batch leaves it alone', (await recalculateMany(env, { nickname: 'tc' })).considered === 4, String((await recalculateMany(env, { nickname: 'tc' })).considered));

check('an unknown transaction is refused', (await recalculateTransaction(env, 99999)).ok === false);

// --- a code confirmed later --------------------------------------------------
// The common case: ingestion could not resolve a code, the review queue
// answered it, and the purchase should now be priced as the rules intended.
sql(`INSERT INTO earn_rules (rule_set_id,category,mpd,reward_type,mcc_include,active)
     VALUES (?,?,?,?,?,1)`, v2.draft.id, 'online', 12, 'miles', '5311');
const uncoded = await log(20000, '2026-09-14', 'Some New Shop');
check('with no code it earns the unrestricted rate', one(`SELECT expected_miles FROM transactions WHERE id = ?`, uncoded).expected_miles === 2000, String(one(`SELECT expected_miles FROM transactions WHERE id = ?`, uncoded).expected_miles));

sql(`UPDATE transactions SET mcc = '5311' WHERE id = ?`, uncoded);
const coded = await recalculateTransaction(env, uncoded);
check('once the code is known it is re-priced', coded.change!.after.miles === 2400, JSON.stringify(coded.change));
check('and says so plainly', coded.change!.summary === '2,000 miles → 2,400 miles', coded.change?.summary);

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
