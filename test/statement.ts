import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../src/migrate';
import { markDuplicates, parseStatement } from '../src/statement';
import { parseMerchantPage } from '../src/mccscan';
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
const env = { DB: { prepare: (s: string) => wrap(s) }, TZ_OFFSET_MINUTES: '480' } as unknown as Env;

let fails = 0;
const check = (l: string, c: boolean, d = '') => {
  if (!c) fails++;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : `  -- ${d}`}`);
};

const TODAY = '2026-09-14';

// --- the shapes a statement comes in ----------------------------------------
const sample = `
CREDIT CARD STATEMENT
TRANSACTION DATE   POSTING DATE   DESCRIPTION                     AMOUNT
14 SEP             15 SEP         NTUC FAIRPRICE SINGAPORE         23.45
15/09/2026                        GRAB *TRIP SINGAPORE             12.30
2026-09-16                        SHOPEE SINGAPORE                  1,240.00
16 SEP             17 SEP         REFUND LAZADA                    45.00 CR
17 SEP                            AMAZE* PAYMENT                  (10.00)
PREVIOUS BALANCE                                                  500.00
PAYMENT RECEIVED - THANK YOU                                    1,000.00
SUB-TOTAL                                                        1,275.75
`;

const p = parseStatement(sample, TODAY);
check('reads every purchase line', p.rows.length === 5, JSON.stringify(p.rows.map((r) => r.merchant)));
check('and no header or total', !p.rows.some((r) => /balance|payment received|sub-total/i.test(r.merchant)), JSON.stringify(p.rows.map((r) => r.merchant)));

const ntuc = p.rows[0];
check('takes the transaction date first', ntuc.occurred_at === '2026-09-14', ntuc.occurred_at);
check('and the posting date second', ntuc.posted_at === '2026-09-15', String(ntuc.posted_at));
check('with the merchant between', ntuc.merchant === 'NTUC FAIRPRICE SINGAPORE', ntuc.merchant);
check('and the amount in cents', ntuc.amount_cents === 2345, String(ntuc.amount_cents));

check('reads a slashed date', p.rows[1].occurred_at === '2026-09-15', p.rows[1].occurred_at);
check('with no posting date when only one is printed', p.rows[1].posted_at === null, String(p.rows[1].posted_at));
check('reads an ISO date', p.rows[2].occurred_at === '2026-09-16', p.rows[2].occurred_at);
check('and an amount with a thousands separator', p.rows[2].amount_cents === 124000, String(p.rows[2].amount_cents));

check('CR marks a refund', p.rows[3].credit === true, JSON.stringify(p.rows[3]));
check('which is stored negative', p.rows[3].amount_cents === -4500, String(p.rows[3].amount_cents));
check('brackets mean the same thing', p.rows[4].amount_cents === -1000 && p.rows[4].credit, JSON.stringify(p.rows[4]));
check('the total is what would be imported', p.total_cents === 2345 + 1230 + 124000 - 4500 - 1000, String(p.total_cents));
check('the raw line is kept for tracing', p.rows[0].raw.includes('NTUC'), p.rows[0].raw);

// --- a year that is not printed ---------------------------------------------
const decInJan = parseStatement('28 DEC   SOMETHING           10.00', '2026-01-05');
check('December read in January belongs to last year', decInJan.rows[0].occurred_at === '2025-12-28', decInJan.rows[0].occurred_at);
const janInJan = parseStatement('03 JAN   SOMETHING           10.00', '2026-01-05');
check('and January stays in this one', janInJan.rows[0].occurred_at === '2026-01-03', janInJan.rows[0].occurred_at);
const early = parseStatement('02 SEP   SOMETHING           10.00', TODAY);
check('an earlier day this month is this year', early.rows[0].occurred_at === '2026-09-02', early.rows[0].occurred_at);

// --- lines it cannot read are reported, never dropped ------------------------
const messy = parseStatement(
  ['SOME MERCHANT WITH NO DATE           12.00', '14 SEP   A MERCHANT WITH NO AMOUNT', '14 SEP   99.99'].join('\n'),
  TODAY
);
check('a line with no date is reported', messy.skipped.some((s) => /no date/.test(s.reason)), JSON.stringify(messy.skipped));
check('a line with no amount is reported', messy.skipped.some((s) => /no amount/.test(s.reason)), JSON.stringify(messy.skipped));
check('a line with no merchant is reported', messy.skipped.some((s) => /no merchant/.test(s.reason)), JSON.stringify(messy.skipped));
check('and nothing broken is imported', messy.rows.length === 0, JSON.stringify(messy.rows));

// --- importing the same statement twice --------------------------------------
await runMigrations(env);
db.prepare(
  `INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at)
   VALUES ('Citi','Rewards','citi_rw','crw',500000,15,'2026-01-01')`
).run();
const card = db.prepare(`SELECT * FROM cards`).get() as any;
db.prepare(
  `INSERT INTO transactions (card_id, amount_cents, occurred_at, merchant) VALUES (?, 2345, '2026-09-14', 'NTUC')`
).run(card.id);

const marked = await markDuplicates(env, card.id, p.rows);
check('a row already logged is flagged', marked[0].duplicate === true, JSON.stringify(marked[0]));
check('and the rest are not', marked.slice(1).every((r) => !r.duplicate), JSON.stringify(marked.map((r) => r.duplicate)));

// --- the merchant directory parser -------------------------------------------
const page = `<html><head><title>Grab MCC Code &amp; Best Credit Card Rewards | Singapore 2026</title></head>
  <body><header><h1>Grab</h1><p>MCC Code: 7399 ( Business Services (Not Elsewhere Classified) )</p>
  <span>Officially verified</span></header>
  <article><p>Grab uses MCC 7399. ${'Filler. '.repeat(80)}</p></article></body></html>`;
const m = parseMerchantPage(page, 'https://example.test/mcc/grab');
check('reads the merchant name from the title', m?.merchant === 'grab', JSON.stringify(m));
check('and its code', m?.mcc === '7399', String(m?.mcc));
check('and the description, parentheses and all', m?.description === 'Business Services (Not Elsewhere Classified)', String(m?.description));
check('and whether the directory verified it', m?.verified === true, String(m?.verified));
check('a page with no code returns nothing', parseMerchantPage('<html><title>Nothing</title><body>x</body></html>', 'u') === null, '');

console.log(fails ? `\n${fails} check(s) failed` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
