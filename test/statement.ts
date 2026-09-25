import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../src/migrate';
import { markDuplicates, parseStatement } from '../src/statement';
import { commitStatement, previewStatement } from '../src/transactions/reconcile';
import { runSeed } from '../src/migrate';
import { lookupMerchantOnline, parseMerchantPage, slugCandidates } from '../src/mccscan';
import type { Env } from '../src/types';

const db = new DatabaseSync(':memory:');

/**
 * Subrequests, counted the way Cloudflare counts them.
 *
 * A Worker invocation may make fifty on the free plan, and every D1 call is
 * one — so a preview that queries per row fails on any statement worth
 * pasting, with an error about API requests that says nothing about
 * statements. A batch is one subrequest however many statements it carries,
 * which is the whole reason to use one.
 */
const FREE_PLAN_SUBREQUESTS = 50;
let subrequests = 0;
let inBatch = false;
const resetSubrequests = () => {
  subrequests = 0;
};
const countOne = () => {
  if (!inBatch) subrequests++;
};

const wrap = (sql: string, args: unknown[] = []): any => ({
  bind: (...a: unknown[]) => wrap(sql, a),
  first: async () => {
    countOne();
    return db.prepare(sql).get(...(args as any)) ?? null;
  },
  all: async () => {
    countOne();
    return { results: db.prepare(sql).all(...(args as any)) };
  },
  run: async () => {
    countOne();
    const r = db.prepare(sql).run(...(args as any));
    return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  },
});
const env = { DB: {
    prepare: (s: string) => wrap(s),
    batch: async (ss: any[]) => {
      subrequests++;
      inBatch = true;
      try {
        return await Promise.all(ss.map((x) => x.all()));
      } finally {
        inBatch = false;
      }
    },
  }, TZ_OFFSET_MINUTES: '480' } as unknown as Env;

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

// --- the spellings a merchant page might live under ---------------------------
check('a plain name becomes a slug', slugCandidates('Circles Life')[0] === 'circles-life', JSON.stringify(slugCandidates('Circles Life')));
check(
  'a statement-padded name falls back to the trading name',
  slugCandidates('CIRCLES LIFE SINGAPORE SG').includes('circles-life'),
  JSON.stringify(slugCandidates('CIRCLES LIFE SINGAPORE SG'))
);
check('the first word is tried too', slugCandidates('Watsons Personal Care').includes('watsons'), JSON.stringify(slugCandidates('Watsons Personal Care')));
check('an ampersand is spelled out', slugCandidates('M&S')[0] === 'm-and-s', JSON.stringify(slugCandidates('M&S')));
check('a dotted name keeps its dot', slugCandidates('booking.com').includes('booking.com'), JSON.stringify(slugCandidates('booking.com')));
check('an apostrophe is dropped, not hyphenated', slugCandidates("Lady's Card")[0] === 'ladys-card', JSON.stringify(slugCandidates("Lady's Card")));
check('nothing in, nothing out', slugCandidates('   ').length === 0, '');
check('and it never tries more than a handful', slugCandidates('a b c d e f g h').length <= 4, String(slugCandidates('a b c d e f g h').length));

// --- searching the merchant directory -----------------------------------------
// The directory answers by name and matches on fragments, so a search returns
// several merchants and the choice is the user's.
db.prepare(`INSERT OR IGNORE INTO mcc_codes (code, description, category, verified) VALUES ('5814','Fast Food Restaurants','dining',1)`).run();
db.prepare(`INSERT OR IGNORE INTO mcc_codes (code, description, category, verified) VALUES ('4814','Telecommunication Services','utilities',1)`).run();

const realFetch = globalThis.fetch;
const asked: string[] = [];
const serve = (body: string | null, status = 200) => {
  (globalThis as any).fetch = async (url: string) => {
    asked.push(String(url));
    if (body === null) throw new Error('offline');
    return { ok: status < 400, status, headers: { get: () => 'application/json' }, text: async () => body };
  };
};

serve(
  JSON.stringify({
    merchants: [
      { id: '1', Store: 'Circles Life', displayName: 'Circles Life', Category: 'Fax Services', MCC: '4814', type: 'offline', url: null },
      { id: '2', Store: 'Killiney Kopitiam', displayName: 'Killiney Kopitiam', Category: 'Fast Food', MCC: 5814, type: 'offline', url: null },
      { id: '3', Store: 'Broken', displayName: 'Broken', Category: null, MCC: 'nope', type: null, url: null },
    ],
  })
);
const search = await lookupMerchantOnline(env, 'circles');
check('the search endpoint is asked by name', /\/api\/store\/search\?q=circles/.test(asked[0] ?? ''), asked[0] ?? '');
check('every usable hit comes back', search.results.length === 2, JSON.stringify(search.results.map((r) => r.store)));
check('a numeric code is normalised to four digits', search.results[1].mcc === '5814', search.results[1].mcc);
check('a hit without a real code is dropped', !search.results.some((r) => r.store === 'Broken'), '');
check('each hit says what this app calls the code', search.results[0].description === 'Telecommunication Services', String(search.results[0].description));
check('and how it categorises it', search.results[1].category === 'dining', String(search.results[1].category));
check('their own wording is kept alongside', search.results[0].their_description === 'Fax Services', String(search.results[0].their_description));
check('nothing is written by searching', (db.prepare(`SELECT COUNT(*) c FROM merchant_mcc WHERE merchant='circles'`).get() as any).c === 0, '');

serve(JSON.stringify({ merchants: [] }));
const none = await lookupMerchantOnline(env, 'zzzz');
check('no matches is an empty list, not an error', none.results.length === 0 && none.error === null, JSON.stringify(none));

serve(null);
const down = await lookupMerchantOnline(env, 'circles');
check('an unreachable directory is reported', down.error !== null, JSON.stringify(down));
check('rather than looking like no matches', down.results.length === 0 && /did not answer/.test(down.error ?? ''), String(down.error));

serve('<html>not json</html>');
const junk = await lookupMerchantOnline(env, 'circles');
check('and so is an unreadable answer', /unreadable/.test(junk.error ?? ''), String(junk.error));

db.prepare(`INSERT OR REPLACE INTO merchant_mcc (merchant, mcc, source, confidence) VALUES ('circles life','4814','user','confirmed')`).run();
serve(JSON.stringify({ merchants: [] }));
const known = await lookupMerchantOnline(env, 'Circles Life');
check('what you confirmed yourself is reported first', known.known?.mcc === '4814', JSON.stringify(known.known));
check('and marked as yours', known.known?.source === 'user', String(known.known?.source));
(globalThis as any).fetch = realFetch;

// --- the ceiling a statement preview has to live under -----------------------
//
// This is the check that was missing. Every D1 call is a subrequest, a Worker
// invocation gets fifty on the free plan, and the preview used to make three
// per row — so a forty-line statement made a hundred and twenty and failed
// with "Too many API requests by single Worker invocation", which names
// neither statements nor rows nor the limit it hit.
const manyRows = Array.from({ length: 40 }, (_, i) => ({
  occurred_at: `2026-09-${String((i % 28) + 1).padStart(2, '0')}`,
  posted_at: null,
  merchant: `MERCHANT ${i} SINGAPORE SG`,
  amount_cents: 1000 + i,
  raw: `line ${i}`,
  duplicate: false,
  mcc: null,
  category: null,
})) as any;

resetSubrequests();
const preview = await previewStatement(env, card, manyRows, null);
check('a forty-row preview reads every row', preview.rows.length === 40, String(preview.rows.length));
check(
  'and stays under what a Worker invocation is allowed',
  subrequests <= FREE_PLAN_SUBREQUESTS,
  `${subrequests} subrequests for 40 rows — the free-plan ceiling is ${FREE_PLAN_SUBREQUESTS}`
);
check(
  'costing a handful of queries rather than one per row',
  subrequests < 10,
  `${subrequests} — a per-row query would show up here as 40 or more`
);

// The index must not change what dedupe decides, only how it is fetched.
db.prepare(
  `INSERT INTO transactions (card_id, amount_cents, occurred_at, merchant) VALUES (?, 1005, '2026-09-06', 'MERCHANT 5 SINGAPORE SG')`
).run(card.id);
const withDup = await previewStatement(env, card, manyRows, null);
const matched = withDup.rows.filter((r) => r.kind === 'matched' || r.kind === 'possible_duplicate');
check('a row already logged is still recognised through the index', matched.length === 1, JSON.stringify(matched.map((m) => m.merchant)));

// --- and the same ceiling on the way in --------------------------------------
//
// Writing costs far more than reading: merchant resolution, dedupe, evidence,
// pricing and review items are all per row and genuinely cannot be shared. So
// the import endpoint takes a slice rather than a statement, and this is the
// measurement that decides how big a slice may be. If it climbs, the endpoint
// has to take fewer rows — not quietly start failing again.
await runSeed(env);
const perRow = 1;
resetSubrequests();
await commitStatement(env, card, (await previewStatement(env, card, manyRows.slice(0, perRow), null)).rows as any);
const forSlice = subrequests;
check(
  `importing ${perRow} rows fits in one Worker invocation`,
  forSlice <= FREE_PLAN_SUBREQUESTS,
  `${forSlice} subrequests for ${perRow} rows — the ceiling is ${FREE_PLAN_SUBREQUESTS}`
);
// Half the budget spare, deliberately. Two rows measured 42 of 50, which
// passes and is the wrong answer: a row raising two review questions rather
// than one would tip it, and the failure would look random rather than like a
// limit.
check(
  'with room for a row that asks more questions than usual',
  forSlice <= FREE_PLAN_SUBREQUESTS / 2,
  `${forSlice} of ${FREE_PLAN_SUBREQUESTS} — halve the slice if this climbs`
);

console.log(fails ? `\n${fails} check(s) failed` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
