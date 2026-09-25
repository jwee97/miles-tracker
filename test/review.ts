import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../src/migrate';
import { decideRule, evaluateOffer } from '../src/eligibility';
import { parseExtraction, saveExtraction } from '../src/offers';
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
const env = { DB: { prepare: (s: string) => wrap(s), batch: async (ss: any[]) => Promise.all(ss.map((x) => x.all())) }, TZ_OFFSET_MINUTES: '480' } as unknown as Env;
Date.now = () => Date.parse('2026-09-13T04:00:00Z'); // 12:00 SGT

let fails = 0;
const check = (l: string, c: boolean, d = '') => {
  if (!c) fails++;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : `  -- ${d}`}`);
};
const sql = (s: string, ...a: unknown[]) => db.prepare(s).run(...(a as any));

await runMigrations(env);

// You hold a Citi card, opened this year and still open.
sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at)
     VALUES ('Citi','Rewards','citi_rewards','crw',500000,15,'2026-01-10')`);

sql(`INSERT INTO offers (id,status,source_url,source_title) VALUES (1,'pending','https://uob.com.sg/apply','UOB offer')`);

// --- extraction from the app ------------------------------------------------
const payload = {
  issuer: 'UOB',
  product: "Lady's Card",
  bonus_miles: 30000,
  min_spend: 1000,
  spend_window_days: 60,
  valid_until: '2026-12-31',
  rules: [
    { predicate: { type: 'no_issuer_card_within_months', issuer: 'UOB', months: 12 }, quote: 'no UOB card in 12 months' },
    { predicate: { type: 'min_income', amount_cents: 3000000, period: 'year' }, quote: 'income of S$30,000' },
    { predicate: { type: 'manual_review', note: 'Promo period wording is ambiguous.' }, quote: 'during the promo period' },
  ],
};
const saved = await saveExtraction(env, 1, payload);
check('saves every clause', saved.rules_saved === 3, String(saved.rules_saved));
const offer = db.prepare(`SELECT * FROM offers WHERE id = 1`).get() as any;
check('fills in the offer', offer.issuer === 'UOB' && offer.bonus_miles === 30000, JSON.stringify(offer));
check('converts the minimum to cents', offer.min_spend_cents === 100000, String(offer.min_spend_cents));
check('moves it out of pending', offer.status === 'tracked', offer.status);
check('two clauses need you', saved.eligibility.open_questions === 2, String(saved.eligibility.open_questions));
check('so the verdict is needs_review', saved.eligibility.verdict === 'needs_review', saved.eligibility.verdict);
check('and nothing is decided yet', saved.eligibility.decided_by_you === 0, '');

check('a fenced code block still parses', parseExtraction('```json\n{"issuer":"DBS"}\n```').issuer === 'DBS', '');
let threw = false;
try {
  parseExtraction('not json');
} catch {
  threw = true;
}
check('and rubbish is rejected, not half-saved', threw, '');
let missing = false;
try {
  await saveExtraction(env, 999, payload);
} catch {
  missing = true;
}
check('extracting onto a missing offer is an error', missing, '');

// --- answering a clause -----------------------------------------------------
const rules = db.prepare(`SELECT id, predicate FROM offer_rules WHERE offer_id = 1 ORDER BY id`).all() as any[];
const incomeRule = rules[1].id;
const manualRule = rules[2].id;

await decideRule(env, incomeRule, 'pass', 'Salary is well above it');
const afterOne = await evaluateOffer(env, 1);
const income = afterOne.rules.find((r) => r.id === incomeRule)!;
check('your answer sets the verdict', income.verdict === 'pass', income.verdict);
check('and is recorded as yours', income.decision === 'pass', String(income.decision));
check('with the date', income.decided_at === '2026-09-13', String(income.decided_at));
check('and the note', income.note === 'Salary is well above it', String(income.note));
check('the computed verdict is still there', income.computed === 'unknown', income.computed);
check('it is not called an override', income.overridden === false, '');
check('one question remains', afterOne.open_questions === 1, String(afterOne.open_questions));
check('so the offer is still under review', afterOne.verdict === 'needs_review', afterOne.verdict);

await decideRule(env, manualRule, 'na', 'I applied before the promo window');
const afterTwo = await evaluateOffer(env, 1);
check('n/a counts as satisfied', afterTwo.rules.find((r) => r.id === manualRule)!.verdict === 'pass', '');
check('but is not displayed as a pass', afterTwo.rules.find((r) => r.id === manualRule)!.decision === 'na', '');
check('with everything answered the offer clears', afterTwo.verdict === 'eligible', afterTwo.verdict);
check('and it says how many you decided', afterTwo.decided_by_you === 2, String(afterTwo.decided_by_you));

// --- overriding what the data says ------------------------------------------
sql(`INSERT INTO offers (id,status,issuer) VALUES (2,'tracked','Citi')`);
sql(`INSERT INTO offer_rules (offer_id,predicate,quote) VALUES (2,'{"type":"new_to_bank","issuer":"Citi"}','new-to-bank only')`);
const citiRule = (db.prepare(`SELECT id FROM offer_rules WHERE offer_id = 2`).get() as any).id;
const computed = await evaluateOffer(env, 2);
check('the data says you are not new to bank', computed.verdict === 'not_eligible', computed.verdict);

await decideRule(env, citiRule, 'pass', 'That card is supplementary, not principal');
const overridden = await evaluateOffer(env, 2);
check('you can override it', overridden.verdict === 'eligible', overridden.verdict);
check('and the override is flagged', overridden.rules[0].overridden === true, '');
check('with the computed verdict kept', overridden.rules[0].computed === 'fail', overridden.rules[0].computed);
check('and the reason it gave', overridden.rules[0].reason.includes('Citi'), overridden.rules[0].reason);

await decideRule(env, citiRule, null);
const cleared = await evaluateOffer(env, 2);
check('clearing restores the computed verdict', cleared.verdict === 'not_eligible', cleared.verdict);
check('and forgets the date', cleared.rules[0].decided_at === null, String(cleared.rules[0].decided_at));
check('deciding a missing rule is not an error', (await decideRule(env, 9999, 'pass')) === null, '');

// --- re-extraction keeps the answers ----------------------------------------
const redone = await saveExtraction(env, 1, payload);
check('a re-read keeps answers to unchanged clauses', redone.decisions_kept === 2, String(redone.decisions_kept));
check('so the verdict survives it', redone.eligibility.verdict === 'eligible', redone.eligibility.verdict);

const changed = {
  ...payload,
  rules: [
    { predicate: { type: 'no_issuer_card_within_months', issuer: 'UOB', months: 12 }, quote: 'no UOB card in 12 months' },
    { predicate: { type: 'min_income', amount_cents: 6000000, period: 'year' }, quote: 'income of S$60,000' },
  ],
};
const after = await saveExtraction(env, 1, changed);
check('but a clause that changed loses its answer', after.decisions_kept === 0, String(after.decisions_kept));
check('and the offer goes back to needing review', after.eligibility.verdict === 'needs_review', after.eligibility.verdict);
check('dropped clauses are gone', after.rules_saved === 2, String(after.rules_saved));

console.log(fails ? `\n${fails} check(s) failed` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
