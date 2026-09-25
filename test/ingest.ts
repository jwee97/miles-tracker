/**
 * One way in, and what it protects.
 *
 * Nearly every assertion here is about a mistake that is expensive and quiet:
 * the same purchase counted twice, a purchase silently deleted, a code guessed
 * at, a statement that grows the ledger every time it is imported. None of
 * those announce themselves — they show up months later as advice that is
 * confidently wrong.
 */
import { DatabaseSync } from 'node:sqlite';
import { deriveMcc, recordEvidence } from '../src/merchants/evidence';
import { resolveMerchant, linkAlias } from '../src/merchants/lookup';
import { canonicalName, normalizeKey, similarity } from '../src/merchants/normalize';
import { runMigrations, runSeed } from '../src/migrate';
import { findDuplicate } from '../src/transactions/dedupe';
import { ingestTransaction } from '../src/transactions/ingest';
import { commitStatement, previewStatement } from '../src/transactions/reconcile';
import { resolveReview, reviewQueue } from '../src/transactions/review';
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
const count = (s: string, ...a: unknown[]) => (one(s, ...a) as any).n as number;
Date.now = () => Date.parse('2026-09-18T04:00:00Z');

await runMigrations(env);
await runSeed(env);

sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,base_mpd)
     VALUES ('DBS','Woman''s World Card','dbs_womans_world','wwmc',900000,18,'2025-01-01',0.4)`);
sql(`INSERT INTO earn_rules (card_id,category,mpd,reward_type) VALUES (1,'online',4,'miles')`);
sql(`INSERT INTO earn_rules (card_id,category,mpd,reward_type) VALUES (1,'*',0.4,'miles')`);

// --- normalising what a bank printed --------------------------------------
check('a processor prefix is not the merchant', normalizeKey('GRAB*RIDE 8829') === 'grab', normalizeKey('GRAB*RIDE 8829'));
check('nor is the country it was in', normalizeKey('GRAB SINGAPORE SG') === 'grab', normalizeKey('GRAB SINGAPORE SG'));
check('nor a domain', normalizeKey('GRAB.COM') === 'grab com', normalizeKey('GRAB.COM'));
check('a reference number is dropped', normalizeKey('NTUC FAIRPRICE 102938') === 'ntuc fairprice', normalizeKey('NTUC FAIRPRICE 102938'));
check('a short number is not', normalizeKey('7-ELEVEN 21') === '7 eleven 21', normalizeKey('7-ELEVEN 21'));
check('shouting becomes readable', canonicalName('NTUC FAIRPRICE 102938') === 'Ntuc Fairprice', canonicalName('NTUC FAIRPRICE 102938'));
check('two merchants that are not alike do not look alike', similarity('Din Tai Fung', 'Shell Petrol') < 0.3);
check('a truncated line resembles its full form', similarity('COLD STORAGE', 'COLD STORAGE JELITA') >= 0.6);

// --- merchants as entities -------------------------------------------------
const grab1 = await resolveMerchant(env, 'GRAB*RIDE 8829');
const grab2 = await resolveMerchant(env, 'GRAB SINGAPORE SG');
check('two spellings resolve to one merchant', grab1!.id === grab2!.id, `${grab1?.id} vs ${grab2?.id}`);
check('and it has a readable name', grab1!.canonical_name === 'Grab', grab1?.canonical_name);
check('only one merchant row was made', count(`SELECT COUNT(*) AS n FROM merchants`) === 1, String(count(`SELECT COUNT(*) AS n FROM merchants`)));

await linkAlias(env, 'GRABFOOD ORDER', grab1!.id, { source: 'user', confidence: 'confirmed' });
const grab3 = await resolveMerchant(env, 'GRABFOOD ORDER');
check('a taught spelling resolves without a new merchant', grab3!.id === grab1!.id);
await linkAlias(env, 'GRABFOOD ORDER', 999, { source: 'statement' });
const stillGrab = await resolveMerchant(env, 'GRABFOOD ORDER');
check('and a later guess cannot undo what a person said', stillGrab!.id === grab1!.id, String(stillGrab?.id));

// --- codes as evidence, not as fact ---------------------------------------
await recordEvidence(env, { merchant_id: grab1!.id, mcc: '4121', source: 'seed' });
await recordEvidence(env, { merchant_id: grab1!.id, mcc: '4121', source: 'statement', observed_at: '2026-08-01' });
let derived = await deriveMcc(env, grab1!.id);
check('the best-supported code wins', derived.mcc === '4121', String(derived.mcc));
check('and is called a guess until someone confirms it', derived.confidence === 'guess', derived.confidence);

await recordEvidence(env, { merchant_id: grab1!.id, mcc: '5812', source: 'statement', observed_at: '2026-09-01' });
derived = await deriveMcc(env, grab1!.id);
check('a second real code makes the answer ambiguous', derived.ambiguous === true, JSON.stringify(derived.candidates));
check('rather than being decided silently', derived.candidates.length === 2);

await recordEvidence(env, { merchant_id: grab1!.id, mcc: '4121', source: 'user', confidence: 'confirmed' });
derived = await deriveMcc(env, grab1!.id);
check('a person outranks any pile of observations', derived.mcc === '4121' && derived.confidence === 'confirmed');
check('and settles the ambiguity', derived.ambiguous === false);

// --- the pipeline ----------------------------------------------------------
const first = await ingestTransaction(env, {
  source: 'sms',
  card_hint: 'wwmc',
  amount_cents: 2470,
  occurred_at: '2026-09-14',
  merchant: 'GRAB*RIDE 8829',
  channel: 'online',
});
check('an SMS creates a transaction', !!first.transaction_id, JSON.stringify(first).slice(0, 160));
check('and it starts pending, because no statement has confirmed it', one(`SELECT status FROM transactions WHERE id = ?`, first.transaction_id).status === 'pending');
check('the merchant is resolved to the entity', first.resolved.merchant_id === grab1!.id);
check('the raw text is kept as printed', one(`SELECT merchant_raw FROM transactions WHERE id = ?`, first.transaction_id).merchant_raw === 'GRAB*RIDE 8829');
check('the code comes from the evidence', first.resolved.mcc === '4121', String(first.resolved.mcc));
check('and the arrival is recorded', count(`SELECT COUNT(*) AS n FROM transaction_sources WHERE transaction_id = ?`, first.transaction_id) === 1);

const repeat = await ingestTransaction(env, {
  source: 'sms',
  card_hint: 'wwmc',
  amount_cents: 2470,
  occurred_at: '2026-09-14',
  merchant: 'GRAB*RIDE 8829',
  channel: 'online',
});
check('the identical message a second time creates nothing', repeat.status === 'duplicate', repeat.status);
check('and points at the transaction it already had', repeat.duplicate_of === first.transaction_id);

// The statement, three days later, with the bank's own spelling.
const viaStatement = await ingestTransaction(env, {
  source: 'statement',
  external_id: 'stmt-1',
  card_hint: 'wwmc',
  amount_cents: 2470,
  occurred_at: '2026-09-14',
  posted_at: '2026-09-17',
  merchant: 'GRAB SINGAPORE SG',
  mcc: '4121',
  status: 'posted',
});
check('the statement recognises the SMS as the same purchase', viaStatement.transaction_id === first.transaction_id, JSON.stringify(viaStatement).slice(0, 200));
check('and does not create a second row', count(`SELECT COUNT(*) AS n FROM transactions`) === 1, String(count(`SELECT COUNT(*) AS n FROM transactions`)));
const settled = one(`SELECT * FROM transactions WHERE id = ?`, first.transaction_id);
check('the pending purchase becomes posted', settled.status === 'posted', settled.status);
check('with the date the bank gave it', settled.posted_at === '2026-09-17', String(settled.posted_at));
check('the statement is kept as a second source', count(`SELECT COUNT(*) AS n FROM transaction_sources WHERE transaction_id = ?`, first.transaction_id) === 2, String(count(`SELECT COUNT(*) AS n FROM transaction_sources WHERE transaction_id = ?`, first.transaction_id)));
check('and a replayed message does not add a third', count(`SELECT COUNT(*) AS n FROM transaction_sources WHERE transaction_id = ? AND source = 'sms'`, first.transaction_id) === 1);

// A different purchase at the same merchant, same day, is NOT a duplicate.
const other = await ingestTransaction(env, {
  source: 'sms',
  card_hint: 'wwmc',
  amount_cents: 1810,
  occurred_at: '2026-09-14',
  merchant: 'GRAB*RIDE 9001',
});
check('a different amount is a different purchase', other.transaction_id !== first.transaction_id);
check('and both are kept', count(`SELECT COUNT(*) AS n FROM transactions`) === 2);

// A resemblance is a question, never a merge.
const maybe = await ingestTransaction(env, {
  source: 'manual',
  card_hint: 'wwmc',
  amount_cents: 1810,
  occurred_at: '2026-09-16',
  merchant: 'Grab ride',
});
check('a resemblance does not merge by itself', maybe.transaction_id !== other.transaction_id, JSON.stringify(maybe).slice(0, 200));
check('it is queued as a question', maybe.warnings.some((w) => w.reason === 'possible_duplicate'), JSON.stringify(maybe.warnings));
check('with both rows still there', count(`SELECT COUNT(*) AS n FROM transactions`) === 3);

// --- an unknown card is refused, not guessed ------------------------------
const nope = await ingestTransaction(env, { source: 'manual', card_hint: 'nope', amount_cents: 100, occurred_at: '2026-09-14' });
check('an unknown card is rejected', nope.status === 'rejected', nope.status);
check('with a reason that names the problem', nope.warnings[0].reason === 'unknown_card');

// --- the review inbox ------------------------------------------------------
const queue = await reviewQueue(env);
check('the questions are queued', queue.length > 0, String(queue.length));
check('and a possible duplicate is asked first', queue[0].reason === 'possible_duplicate', queue.map((q) => q.reason).join(','));

const dupItem = queue.find((q) => q.reason === 'possible_duplicate')!;
const kept = await resolveReview(env, dupItem.id, { action: 'keep_both' });
check('keeping both is an answer', kept.ok === true);
check('and nothing is deleted by it', count(`SELECT COUNT(*) AS n FROM transactions`) === 3);

// A merchant with no code at all: one question, answered once, taught forever.
const unknown = await ingestTransaction(env, {
  source: 'manual',
  card_hint: 'wwmc',
  amount_cents: 4200,
  occurred_at: '2026-09-15',
  merchant: 'KOPITIAM 88',
  category: 'dining',
});
check('a merchant with no code is saved anyway', !!unknown.transaction_id);
check('and the uncertainty is queued rather than guessed', unknown.warnings.some((w) => w.reason === 'unknown_mcc'));

const q2 = await reviewQueue(env);
const codeItem = q2.find((i) => i.reason === 'unknown_mcc' && i.transaction_id === unknown.transaction_id)!;
const answered = await resolveReview(env, codeItem.id, { action: 'confirm', mcc: '5814' });
check('answering a code works', answered.ok === true, answered.error);
check('it is written to the transaction', one(`SELECT mcc FROM transactions WHERE id = ?`, unknown.transaction_id).mcc === '5814');
check('and remembered against the merchant', (await deriveMcc(env, unknown.resolved.merchant_id!)).mcc === '5814');

const next = await ingestTransaction(env, {
  source: 'manual',
  card_hint: 'wwmc',
  amount_cents: 900,
  occurred_at: '2026-09-16',
  merchant: 'KOPITIAM 88',
  category: 'dining',
});
check('so the next purchase there is not asked about', next.resolved.mcc === '5814', String(next.resolved.mcc));

// A new spelling is a new merchant until someone says otherwise. Merging on a
// resemblance would be invisible afterwards and would change which card the
// app advises, so the resemblance is offered instead.
const variant = await ingestTransaction(env, {
  source: 'statement',
  card_hint: 'wwmc',
  amount_cents: 1150,
  occurred_at: '2026-09-16',
  merchant: 'KOPITIAM 88 OUTLET 3',
  category: 'dining',
});
check('a new spelling is not merged on a resemblance', variant.resolved.merchant_id !== next.resolved.merchant_id);
check('it is asked about', variant.warnings.some((w) => w.reason === 'unknown_mcc'), JSON.stringify(variant.warnings));
check(
  'and the resemblance is named',
  variant.warnings.some((w) => w.detail.includes('Kopitiam 88')),
  JSON.stringify(variant.warnings)
);
const vq = (await reviewQueue(env)).find((i) => i.transaction_id === variant.transaction_id)!;
check('with the likely code offered, so answering is one tap', vq.suggestion === '5814', String(vq?.suggestion));

const stillOpen = await reviewQueue(env);
check('an answered question leaves the queue', !stillOpen.some((i) => i.id === codeItem.id));

// --- a statement, twice ----------------------------------------------------
const card = one(`SELECT id, nickname, product FROM cards WHERE nickname = 'wwmc'`);
const rows = [
  { occurred_at: '2026-09-02', posted_at: '2026-09-03', merchant: 'SHOPEE SINGAPORE', amount_cents: 12000, raw: 'SHOPEE SINGAPORE 12.00', credit: false },
  { occurred_at: '2026-09-05', posted_at: '2026-09-06', merchant: 'COLD STORAGE', amount_cents: 8340, raw: 'COLD STORAGE 83.40', credit: false },
  { occurred_at: '2026-09-14', posted_at: '2026-09-17', merchant: 'GRAB SINGAPORE SG', amount_cents: 2470, raw: 'GRAB SINGAPORE SG 24.70', credit: false },
  { occurred_at: '2026-09-10', posted_at: '2026-09-10', merchant: 'PAYMENT THANK YOU', amount_cents: -50000, raw: 'PAYMENT - THANK YOU', credit: true },
  { occurred_at: '2026-09-11', posted_at: '2026-09-11', merchant: 'ANNUAL FEE', amount_cents: -19260, raw: 'ANNUAL FEE 192.60', credit: true },
];

const preview = await previewStatement(env, card, rows as any, '2026-09-18');
check('a statement is classified before anything is written', preview.rows.length === 5);
check('a row the app already has is matched', preview.summary.matched === 1, JSON.stringify(preview.summary));
check('a bill payment is not spend', preview.rows[3].kind === 'payment', preview.rows[3].kind);
check('nor is an annual fee', preview.rows[4].kind === 'fee', preview.rows[4].kind);
check('and the new rows are counted as new', preview.summary.new === 2, JSON.stringify(preview.summary));

const before = count(`SELECT COUNT(*) AS n FROM transactions`);
const commit1 = await commitStatement(env, card, preview.rows);
check('committing creates only the new rows', commit1.created === 2, JSON.stringify(commit1));
check('the bank\'s own accounting is skipped', commit1.skipped.reduce((t, s) => t + s.count, 0) === 2, JSON.stringify(commit1.skipped));
check('and the ledger grew by exactly that', count(`SELECT COUNT(*) AS n FROM transactions`) === before + 2);

const preview2 = await previewStatement(env, card, rows as any, '2026-09-18');
check('the same statement again matches everything', preview2.summary.new === 0, JSON.stringify(preview2.summary));
const commit2 = await commitStatement(env, card, preview2.rows);
check('and importing it again creates nothing', commit2.created === 0, JSON.stringify(commit2));
check('the ledger is unchanged', count(`SELECT COUNT(*) AS n FROM transactions`) === before + 2);
check('every row is accounted for', commit2.processed === 5 && commit2.already_known === 3, JSON.stringify(commit2));

// --- the levels, checked directly -----------------------------------------
const lvl = await findDuplicate(env, {
  card_id: card.id,
  amount_cents: 12000,
  occurred_at: '2026-09-02',
  posted_at: '2026-09-03',
  merchant: 'SHOPEE SINGAPORE',
  source: 'statement',
  external_id: null,
});
check('the same card, amount and merchant is deterministic', lvl?.level === 'deterministic', JSON.stringify(lvl));
check('and may merge without being asked', lvl?.automatic === true);

const far = await findDuplicate(env, {
  card_id: card.id,
  amount_cents: 12000,
  occurred_at: '2026-10-02',
  posted_at: '2026-10-02',
  merchant: 'SHOPEE SINGAPORE',
  source: 'statement',
  external_id: null,
});
check('the same purchase a month later is not a duplicate', far === null, JSON.stringify(far));

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
