import { DatabaseSync } from 'node:sqlite';
import { runMigrations, runSeed } from '../src/migrate';
import { defaultCardPossible, METHODS, monthOfOther, otherMonths } from '../src/other';
import type { Card, Env } from '../src/types';

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
  OBJECTIVE: 'balanced',
} as unknown as Env;
Date.now = () => Date.parse('2026-09-20T04:00:00Z'); // 12:00 SGT

let fails = 0;
const check = (l: string, c: boolean, d = '') => {
  if (!c) fails++;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : `  -- ${d}`}`);
};
const sql = (s: string, ...a: unknown[]) => db.prepare(s).run(...(a as any));

await runMigrations(env);
await runSeed(env);

sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,base_mpd)
     VALUES ('UOB','Lady''s','uob_lady','lady',800000,15,'2026-01-01',0.4)`);
const lady = (db.prepare(`SELECT * FROM cards WHERE nickname='lady'`).get() as Card).id;
sql(`INSERT INTO earn_rules (card_id,category,mpd,reward_type) VALUES (?,'dining',4,'miles')`, lady);
sql(`INSERT INTO earn_rules (card_id,category,mpd,reward_type) VALUES (?,'*',0.4,'miles')`, lady);

// --- what a method implies ----------------------------------------------------
check('a wallet could have been a card', defaultCardPossible('paylah') === 1, '');
check('cash could not', defaultCardPossible('cash') === 0, '');
check('nor a transfer to a person', defaultCardPossible('paynow') === 0, '');
check('an unknown method is assumed possible', defaultCardPossible('nonsense') === 1, '');
check('every method has a label', METHODS.every((m) => m.key && m.label), '');

// --- a month of off-card spending --------------------------------------------
const row = (date: string, cents: number, method: string, category: string | null, possible = 1, merchant = 'x') =>
  sql(
    `INSERT INTO other_spend (occurred_at, amount_cents, method, merchant, category, card_possible)
     VALUES (?, ?, ?, ?, ?, ?)`,
    date,
    cents,
    method,
    merchant,
    category,
    possible
  );

row('2026-09-02', 4000, 'paylah', 'dining');
row('2026-09-05', 6000, 'paylah', 'dining');
row('2026-09-07', 3000, 'cash', 'dining', 0);        // a hawker: no card possible
row('2026-09-09', 5000, 'paynow', null, 0);          // a transfer, uncategorised
row('2026-09-11', 2500, 'grabpay', null, 1);         // could have been a card, no category
row('2026-08-30', 9900, 'paylah', 'dining');         // last month, must not count

// Card spend in the same month, so the share means something.
sql(`INSERT INTO transactions (card_id, amount_cents, occurred_at, category) VALUES (?, 30000, '2026-09-03', 'dining')`, lady);

const m = await monthOfOther(env);
check('only this month is counted', m.rows.length === 5, String(m.rows.length));
check('with the right total', m.total_cents === 20500, String(m.total_cents));
check('the share is of everything spent', Math.round(m.share_percent) === 41, String(m.share_percent));
check('card spend is reported beside it', m.card_spend_cents === 30000, String(m.card_spend_cents));

check('methods are ranked by spend', m.by_method[0].method === 'paylah' && m.by_method[0].spend_cents === 10000, JSON.stringify(m.by_method[0]));
check('with a readable label', m.by_method[0].label === 'DBS PayLah!', m.by_method[0].label);
check('categories are ranked too', m.by_category[0].category === 'dining', JSON.stringify(m.by_category));
check('and the uncategorised are named, not hidden', m.by_category.some((c) => c.category === '(uncategorised)'), JSON.stringify(m.by_category.map((c) => c.category)));

// --- what it cost you ---------------------------------------------------------
check('only spend a card could have taken is costed', m.avoidable_cents === 12500, String(m.avoidable_cents));
const dining = m.missed.find((x) => x.category === 'dining')!;
check('the cash hawker meal is left out of the costing', dining.spend_cents === 10000, String(dining.spend_cents));
check('the best card for it is named', dining.card === 'lady', String(dining.card));
check('with what it would have earned', dining.miles === 400, String(dining.miles));
check('valued at your mile rate', dining.value_cents === 600, String(dining.value_cents));
check('and totalled', m.missed_value_cents === 600 && m.missed_miles === 400, JSON.stringify({ v: m.missed_value_cents, m: m.missed_miles }));
check(
  'spend with no category is excluded but reported',
  m.uncategorised_cents === 2500,
  String(m.uncategorised_cents)
);

// --- other months -------------------------------------------------------------
const aug = await monthOfOther(env, '2026-08');
check('an earlier month can be asked for', aug.total_cents === 9900, String(aug.total_cents));
check('and it knows which month it is', aug.month === '2026-08', aug.month);
const months = await otherMonths(env);
check('the picker offers months that have rows', months.includes('2026-08') && months.includes('2026-09'), JSON.stringify(months));
check('and always this one', months[0] === '2026-09', JSON.stringify(months));

// --- an empty month is not an error ------------------------------------------
const empty = await monthOfOther(env, '2026-07');
check('an empty month totals zero', empty.total_cents === 0, String(empty.total_cents));
check('with no share to speak of', empty.share_percent === 0, String(empty.share_percent));
check('and nothing missed', empty.missed.length === 0 && empty.missed_value_cents === 0, '');

console.log(fails ? `\n${fails} check(s) failed` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
