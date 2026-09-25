/**
 * The two ledgers.
 *
 * The property under test throughout: what the app expects and what the bank
 * did are recorded separately, and nothing reconciles them by editing one to
 * match the other. A discrepancy is information, and the moment either ledger
 * is allowed to write the other it stops being able to carry any.
 */
import { DatabaseSync } from 'node:sqlite';
import { draftFromCurrent, reviewAndPublish } from '../src/catalog/publish';
import { runMigrations, runSeed } from '../src/migrate';
import { actualTotals, entriesIn, recordActual, recordManualTotal } from '../src/rewards/ledger';
import { delayState, expectedTotals, expectedIn, recordExpected, roundingFor } from '../src/rewards/expected';
import { extractRewards, pendingCandidates, saveCandidates } from '../src/rewards/extract';
import { qualifyingSpend, roundReward, toleranceFor, withinTolerance, parseRounding } from '../src/rewards/rounding';
import { ingestTransaction } from '../src/transactions/ingest';
import { recalculateTransaction } from '../src/transactions/recalculate';
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
  DB: { prepare: (s: string) => wrap(s), batch: async (ss: any[]) => Promise.all(ss.map((x) => x.all())) },
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
const all = (s: string, ...a: unknown[]) => db.prepare(s).all(...(a as any)) as any[];
Date.now = () => Date.parse('2026-09-18T04:00:00Z');

await runMigrations(env);
await runSeed(env);

// --- how banks round -------------------------------------------------------
check('exact is the default when a card says nothing', parseRounding(null).mode === 'exact');
check('a block of S$5 ignores the change', qualifyingSpend(5340, { mode: 'exact', unit_cents: 500 }) === 5000, String(qualifyingSpend(5340, { mode: 'exact', unit_cents: 500 })));
check('and that is the deal, not a shortfall', qualifyingSpend(5000, { mode: 'exact', unit_cents: 500 }) === 5000);
check('no block means every cent counts', qualifyingSpend(5340, { mode: 'exact' }) === 5340);
check('flooring drops the fraction', roundReward(69.6, { mode: 'floor_per_transaction' }) === 69);
check('rounding to nearest does not', roundReward(69.6, { mode: 'nearest_per_transaction' }) === 70);

check('a tolerance covers small rounding', withinTolerance(1998, 2000, { absolute: 5 }));
check('but not a real gap', !withinTolerance(8400, 6900, { absolute: 5 }));
check(
  'and it grows with the rows it could have come from',
  toleranceFor(8400, { per_transaction: 1 }, 40) === 40,
  String(toleranceFor(8400, { per_transaction: 1 }, 40))
);

// --- a card with a real rule set -------------------------------------------
sql(`INSERT INTO card_products (product_key, issuer, product_name, reward_type, verification_status)
     VALUES ('t_card','T','Card','miles','draft')`);
const pid = one(`SELECT id FROM card_products WHERE product_key = 't_card'`).id;
sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,base_mpd,program_key,product_id)
     VALUES ('T','Card','t_card','tc',900000,18,'2025-01-01',0.4,'krisflyer',?)`, pid);
const card = one(`SELECT * FROM cards WHERE nickname = 'tc'`);

const v1 = await draftFromCurrent(env, pid, '2025-01-01', { today: '2025-01-01' });
sql(`INSERT INTO earn_rules (rule_set_id,category,mpd,reward_type,cap_cents,cap_window,active)
     VALUES (?,?,?,?,?,?,1)`, v1.draft.id, 'online', 4, 'miles', 100000, 'calendar_month');
sql(`INSERT INTO earn_rules (rule_set_id,category,mpd,reward_type,active) VALUES (?,?,?,?,1)`, v1.draft.id, '*', 0.4, 'miles');
await reviewAndPublish(env, v1.draft.id, '2025-01-01');

// --- what one purchase is owed, in parts -----------------------------------
const buy = await ingestTransaction(env, {
  source: 'manual',
  card_id: card.id,
  amount_cents: 20000,
  occurred_at: '2026-09-05',
  merchant: 'Shopee',
  category: 'online',
});
const parts = all(`SELECT component, expected_amount FROM expected_reward_entries WHERE transaction_id = ?`, buy.transaction_id);
check('a purchase is owed in parts, not one number', parts.length === 2, JSON.stringify(parts));
const base = parts.find((p) => p.component === 'base')!;
const bonus = parts.find((p) => p.component === 'category_bonus')!;
check('the base is the rate everything earns', base.expected_amount === 80, String(base.expected_amount));
check('and the bonus is only the uplift above it', bonus.expected_amount === 720, String(bonus.expected_amount));
check(
  'so the parts add up to what the engine predicted',
  base.expected_amount + bonus.expected_amount === one(`SELECT expected_miles FROM transactions WHERE id = ?`, buy.transaction_id).expected_miles,
  `${base.expected_amount}+${bonus.expected_amount}`
);

// Re-pricing must replace the split, not add a second one.
sql(`UPDATE earn_rules SET mpd = 2 WHERE rule_set_id = ? AND category = 'online'`, v1.draft.id);
await recalculateTransaction(env, buy.transaction_id!);
const after = all(`SELECT component, expected_amount FROM expected_reward_entries WHERE transaction_id = ?`, buy.transaction_id);
check('re-pricing replaces the expectation', after.length === 2, JSON.stringify(after));
check('rather than leaving the old one beside it', after.find((p) => p.component === 'category_bonus')!.expected_amount === 320, JSON.stringify(after));

// A refund is owed nothing at all.
const refund = await ingestTransaction(env, {
  source: 'manual',
  card_id: card.id,
  amount_cents: -5000,
  occurred_at: '2026-09-06',
  merchant: 'Shopee',
  category: 'online',
});
check('a refund is owed nothing', all(`SELECT * FROM expected_reward_entries WHERE transaction_id = ?`, refund.transaction_id).length === 0);

// --- what the bank actually did --------------------------------------------
const credited = await recordActual(env, {
  card_id: card.id,
  program_key: 'krisflyer',
  entry_type: 'base_reward',
  amount: 400,
  unit: 'miles',
  period_start: '2026-09-01',
  period_end: '2026-09-30',
  credited_at: '2026-09-18',
  source: 'statement',
  external_reference: 'stmt-2026-09-base',
  description: 'Points earned',
});
check('a credit can be recorded', credited.ok && !credited.duplicate_of, JSON.stringify(credited));

const again = await recordActual(env, {
  card_id: card.id,
  entry_type: 'base_reward',
  amount: 400,
  unit: 'miles',
  source: 'statement',
  external_reference: 'stmt-2026-09-base',
});
check('the same credit twice is recognised', again.duplicate_of === credited.id, JSON.stringify(again));
check('and nothing is double counted', all(`SELECT * FROM reward_ledger_entries`).length === 1, String(all(`SELECT * FROM reward_ledger_entries`).length));

// Without a reference, the same card, amount, type and day is the same event.
await recordActual(env, { card_id: card.id, entry_type: 'bonus_reward', amount: 250, unit: 'miles', credited_at: '2026-09-18', source: 'import', description: 'Bonus points' });
const dup2 = await recordActual(env, { card_id: card.id, entry_type: 'bonus_reward', amount: 250, unit: 'miles', credited_at: '2026-09-18', source: 'import', description: 'Bonus points' });
check('a repeat with no reference is still caught', dup2.duplicate_of !== undefined, JSON.stringify(dup2));

// A reversal nets off, because that is what the bank did.
await recordActual(env, { card_id: card.id, entry_type: 'reversal', amount: -100, unit: 'miles', credited_at: '2026-09-20', source: 'statement', external_reference: 'rev-1' });
const totals = await actualTotals(env, card.id, '2026-09-01', '2026-09-30');
check('credits are totalled by kind', totals.find((t) => t.component === 'base_reward')!.amount === 400, JSON.stringify(totals));
check('and a reversal is negative', totals.find((t) => t.component === 'reversal')!.amount === -100, JSON.stringify(totals));
check('the entries can be listed', (await entriesIn(env, card.id, '2026-09-01', '2026-09-30')).length === 3);

// --- a figure typed in by hand ---------------------------------------------
sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at)
     VALUES ('T','Other','t_other','oth',900000,18,'2025-01-01')`);
const other = one(`SELECT id FROM cards WHERE nickname = 'oth'`).id;
const byHand = await recordManualTotal(env, other, 6900, 'points', { start: '2026-08-01', end: '2026-08-31' });
check('a total can be entered by hand', byHand.ok === true, JSON.stringify(byHand));
check('and is marked as such', one(`SELECT source FROM reward_ledger_entries WHERE id = ?`, byHand.id).source === 'manual');

await recordActual(env, { card_id: other, entry_type: 'base_reward', amount: 7000, unit: 'points', period_start: '2026-07-01', period_end: '2026-07-31', source: 'statement', external_reference: 'jul' });
const refused = await recordManualTotal(env, other, 1, 'points', { start: '2026-07-01', end: '2026-07-31' });
check('a typed figure cannot displace an imported one', refused.ok === false, JSON.stringify(refused));
check('and says why', refused.error!.includes('read from a statement'), refused.error ?? '');

// --- delayed rewards -------------------------------------------------------
await recordExpected(env, {
  card_id: card.id,
  reward_period_key: 'campaign:welcome',
  component: 'minimum_spend_bonus',
  expected_amount: 20000,
  unit: 'miles',
  available_from: '2026-11-01',
  expected_by: '2026-11-30',
  source_note: 'welcome offer',
});
check('a reward not due yet is pending', delayState({ available_from: '2026-11-01', expected_by: '2026-11-30' }, '2026-09-18') === 'pending');
check('one that is due is due', delayState({ available_from: '2026-09-01', expected_by: '2026-11-30' }, '2026-09-18') === 'due');
check('and one past its date is overdue', delayState({ available_from: '2026-09-01', expected_by: '2026-09-10' }, '2026-09-18') === 'overdue');

const owed = await expectedTotals(env, card.id, '2026-09-01', '2026-09-30', '2026-09-18');
check('what is owed is totalled by component', owed.length >= 2, JSON.stringify(owed));
check('with the base separate from the bonus', owed.some((o) => o.component === 'base') && owed.some((o) => o.component === 'category_bonus'));
check('and nothing due yet is flagged as pending', (await expectedTotals(env, card.id, '2026-11-01', '2026-11-30', '2026-09-18')).every((o) => o.all_pending), '');
check('the entries can be listed', (await expectedIn(env, card.id, '2026-09-01', '2026-09-30')).length >= 2);

// --- reading the rewards half of a statement -------------------------------
const text = `
STATEMENT OF ACCOUNT
Opening points balance            42,180
Points earned this statement       8,422
Bonus points earned                1,500
Cash back earned                 $ 18.40
Points redeemed                    5,000
Points expired                       250
Closing points balance            46,852
Total points earned to date      182,400
`;
const found = extractRewards(text, { program_key: 'krisflyer' });
const kinds = found.map((f) => `${f.entry_type}:${f.amount}`);
check('points earned are read', kinds.includes('base_reward:8422'), kinds.join(','));
check('bonus points are read separately', kinds.includes('bonus_reward:1500'), kinds.join(','));
check('rather than being rolled into the base', found.filter((f) => f.entry_type === 'base_reward').length === 1, kinds.join(','));
check('cashback is read in cents', kinds.includes('cashback:1840'), kinds.join(','));
check('a redemption is negative', kinds.includes('adjustment:-5000'), kinds.join(','));
check('so is an expiry', kinds.includes('adjustment:-250'), kinds.join(','));
check('an opening balance is not a credit', !kinds.some((k) => k.includes('42180')), kinds.join(','));
check('nor is a closing balance', !kinds.some((k) => k.includes('46852')), kinds.join(','));
check('nor a running total', !kinds.some((k) => k.includes('182400')), kinds.join(','));
check('and each says how sure it is', found.every((f) => ['high', 'medium', 'low'].includes(f.confidence)));
check('keeping the line it came from', found.every((f) => f.raw_line.length > 0));

// Nothing extracted is written to the ledger by itself.
const ledgerBefore = all(`SELECT * FROM reward_ledger_entries`).length;
const saved = await saveCandidates(env, card.id, found, { start: '2026-09-01', end: '2026-09-30' });
check('extraction saves candidates', saved.saved === found.length, JSON.stringify(saved));
check('and writes nothing to the ledger', all(`SELECT * FROM reward_ledger_entries`).length === ledgerBefore);
check('they wait to be accepted', (await pendingCandidates(env, card.id)).length === found.length);
check('and saving twice adds nothing', (await saveCandidates(env, card.id, found, { start: '2026-09-01', end: '2026-09-30' })).saved === 0);

// --- rounding comes from the card, not from the calculation ----------------
sql(`UPDATE rule_sets SET reward_rounding_json = ? WHERE id = ?`, JSON.stringify({ unit_cents: 500, mode: 'floor_per_transaction' }), v1.draft.id);
check('a card can declare how its bank rounds', (await roundingFor(env, v1.draft.id)).unit_cents === 500);
check('and the mode with it', (await roundingFor(env, v1.draft.id)).mode === 'floor_per_transaction');

const blocky = await ingestTransaction(env, {
  source: 'manual',
  card_id: card.id,
  amount_cents: 5340,
  occurred_at: '2026-09-07',
  merchant: 'Shopee',
  category: 'online',
});
const blockParts = all(`SELECT component, expected_amount FROM expected_reward_entries WHERE transaction_id = ?`, blocky.transaction_id);
const owedTotal = blockParts.reduce((t, p) => t + p.expected_amount, 0);
check(
  'a card paying per block earns on the block, not the change',
  owedTotal === Math.floor((5000 / 100) * 0.4) + Math.floor((5000 / 100) * (2 - 0.4)),
  `${owedTotal} from ${JSON.stringify(blockParts)}`
);
check('which is the deal rather than a discrepancy', owedTotal < (5340 / 100) * 2);

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
