import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../src/migrate';
import { buildAnalytics } from '../src/analytics';
import type { Env } from '../src/types';

const db = new DatabaseSync(':memory:');
const wrap = (sql: string, args: unknown[] = []): any => ({
  bind: (...a: unknown[]) => wrap(sql, a),
  first: async <T>() => (db.prepare(sql).get(...(args as any)) ?? null) as T,
  all: async <T>() => ({ results: db.prepare(sql).all(...(args as any)) as T[] }),
  run: async () => {
    const r = db.prepare(sql).run(...(args as any));
    return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  },
});
const env = {
  DB: { prepare: (sql: string) => wrap(sql), batch: async (ss: any[]) => Promise.all(ss.map((x: any) => x.all())) },
  TZ_OFFSET_MINUTES: '480',
  MILE_VALUE_CENTS: '1.5',
} as unknown as Env;

Date.now = () => Date.parse('2026-09-11T04:00:00Z'); // 12:00 SGT, 11 Sep

let fails = 0;
const check = (label: string, cond: boolean, detail = '') => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  -- ${detail}`}`);
};
const sql = (s: string, ...a: unknown[]) => db.prepare(s).run(...(a as any));

await runMigrations(env);

sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at)
     VALUES ('Citi','Rewards','citi_rw','crw',500000,15,'2026-01-01')`);
sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at)
     VALUES ('UOB','Lady''s','uob_lady','lady',500000,15,'2026-01-01')`);
// Citi is poor on dining, Lady's is strong — so dining put on Citi is a loss.
sql(`INSERT INTO earn_rules (card_id,category,mpd,reward_type) VALUES (1,'shopping',4,'miles')`);
sql(`INSERT INTO earn_rules (card_id,category,mpd,reward_type) VALUES (1,'*',0.4,'miles')`);
sql(`INSERT INTO earn_rules (card_id,category,mpd,reward_type) VALUES (2,'dining',4,'miles')`);
sql(`INSERT INTO earn_rules (card_id,category,mpd,reward_type) VALUES (2,'*',0.4,'miles')`);

const tx = (card: number, cents: number, date: string, cat: string | null, merchant: string | null = null) =>
  sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at,category,merchant) VALUES (?,?,?,?,?)`,
      card, cents, date, cat, merchant);

// August (previous month)
tx(1, 40000, '2026-08-03', 'shopping', 'Lazada');
tx(1, 20000, '2026-08-20', 'dining', 'Tiong Bahru');
// September
tx(1, 30000, '2026-09-02', 'shopping', 'Lazada');   // 2 Sep, Wednesday
tx(1, 24000, '2026-09-05', 'dining', 'Burnt Ends'); // dining on the WRONG card
tx(2, 15000, '2026-09-05', 'groceries', 'NTUC');
tx(1, 9000, '2026-09-09', 'shopping', 'Lazada');
tx(2, 6000, '2026-09-09', null, null);              // uncategorised

const a = await buildAnalytics(env, '2026-09');

check('reports the month asked for', a.month === '2026-09' && a.prev_month === '2026-08', `${a.month}/${a.prev_month}`);
check('totals September only', a.totals.spend_cents === 84000, `got ${a.totals.spend_cents}`);
check('carries last month for comparison', a.totals.prev_spend_cents === 60000, `got ${a.totals.prev_spend_cents}`);
check('counts transactions', a.totals.txn_count === 5, `got ${a.totals.txn_count}`);
check('counts distinct active days', a.totals.active_days === 3, `got ${a.totals.active_days}`);
check('finds the largest purchase', a.totals.largest_cents === 30000, `got ${a.totals.largest_cents}`);
check('averages correctly', a.totals.avg_txn_cents === 16800, `got ${a.totals.avg_txn_cents}`);

// The axis must be a real calendar, not just the days that happen to have spend.
check('daily series is zero-filled to month length', a.daily.length === 30, `got ${a.daily.length}`);
check('a quiet day is zero, not missing', a.daily[0].cents === 0 && a.daily[0].date === '2026-09-01', JSON.stringify(a.daily[0]));
check('a busy day carries its total', a.daily[4].cents === 39000, `got ${a.daily[4].cents}`);

check('cumulative runs to the month total', a.cumulative[29].cents === 84000, `got ${a.cumulative[29].cents}`);
check('cumulative is monotonic', a.cumulative.every((c, i) => i === 0 || c.cents >= a.cumulative[i - 1].cents));
check('last month runs alongside it', a.cumulative[29].prev_cents === 60000, `got ${a.cumulative[29].prev_cents}`);

check('categories ranked by spend', a.by_category[0].key === 'shopping' && a.by_category[0].cents === 39000, JSON.stringify(a.by_category[0]));
check('uncategorised spend is named, not dropped',
  a.by_category.some((c) => c.key === 'uncategorised' && c.cents === 6000),
  JSON.stringify(a.by_category));
check('cards ranked by spend', a.by_card[0].cents === 63000, JSON.stringify(a.by_card[0]));

const wed = a.by_weekday.find((d) => d.label === 'Wed')!;
// 2 and 9 September are both Wednesdays: 300 + 90 + 60.
check('weekday buckets aggregate every matching date', wed.cents === 45000, `got ${wed.cents}`);
check('a day with no spend stays at zero', a.by_weekday.find((d) => d.label === 'Mon')!.cents === 0, '');
check('every weekday is present even at zero', a.by_weekday.length === 7, `got ${a.by_weekday.length}`);

check('merchants are rolled up case-insensitively',
  a.top_merchants.find((m) => m.merchant.toLowerCase() === 'lazada')!.cents === 39000,
  JSON.stringify(a.top_merchants));
check('and counted', a.top_merchants.find((m) => m.merchant.toLowerCase() === 'lazada')!.count === 2, '');

// Rewards: shopping 390 at 4mpd = 1560 miles, dining 240 at 0.4 = 96,
// groceries 150 at 0.4 = 60, uncategorised 60 at 0.4 = 24.
check('miles estimated across cards', a.rewards.miles === 1560 + 96 + 60 + 24, `got ${a.rewards.miles}`);
check('valued at the configured rate', a.rewards.value_cents === Math.round(a.rewards.miles * 1.5), `got ${a.rewards.value_cents}`);
check('reports a return per dollar', a.rewards.per_dollar_cents > 0, `got ${a.rewards.per_dollar_cents}`);

// The distinctive one: $240 of dining went on Citi at 0.4 when Lady's pays 4.
const diningMiss = a.missed.find((m) => m.category === 'dining');
check('spotted spend on the wrong card', !!diningMiss, JSON.stringify(a.missed));
check('named the better card', diningMiss?.best_label.includes('Lady'), JSON.stringify(diningMiss));
// 240 * 4 = 960 miles vs 96; difference 864 miles = $12.96
check('priced the loss', diningMiss?.lost_value_cents === 1296, `got ${diningMiss?.lost_value_cents}`);
check('ranked losses largest first', a.missed.every((m, i) => i === 0 || m.lost_value_cents <= a.missed[i - 1].lost_value_cents));
check('does not flag spend already on the best card',
  !a.missed.some((m) => m.category === 'shopping'),
  JSON.stringify(a.missed.map((m) => m.category)));

check('writes a plain-language read', a.insights.length >= 3, JSON.stringify(a.insights));
check('names the month-on-month change', a.insights.some((s) => /higher than 2026-08/.test(s)), JSON.stringify(a.insights));
check('names the loss', a.insights.some((s) => /wrong card/.test(s)), JSON.stringify(a.insights));

// An empty month must not throw or divide by zero.
const empty = await buildAnalytics(env, '2026-04');
check('an empty month is safe', empty.totals.spend_cents === 0 && empty.daily.length === 30, JSON.stringify(empty.totals));
check('and reports no per-dollar return', empty.rewards.per_dollar_cents === 0, `got ${empty.rewards.per_dollar_cents}`);

// February, to catch a month-length assumption.
const feb = await buildAnalytics(env, '2026-02');
check('February is 28 days', feb.daily.length === 28, `got ${feb.daily.length}`);
check('and its previous month is January', feb.prev_month === '2026-01', feb.prev_month);

// The posting date decides which month a transaction belongs to.
tx(1, 50000, '2026-09-30', 'shopping', 'Late');
sql(`UPDATE transactions SET posted_at = '2026-10-02' WHERE merchant = 'Late'`);
const sep = await buildAnalytics(env, '2026-09');
check('a purchase posting in October leaves September', sep.totals.spend_cents === 84000, `got ${sep.totals.spend_cents}`);
const oct = await buildAnalytics(env, '2026-10');
check('and lands in October', oct.totals.spend_cents === 50000, `got ${oct.totals.spend_cents}`);

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall passed');
process.exit(fails ? 1 : 0);
