import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../src/migrate';
import { findRecurring, categoryTrends, findDuplicates } from '../src/patterns';
import type { Env } from '../src/types';

const db = new DatabaseSync(':memory:');
const wrap = (sql: string, args: unknown[] = []): any => ({
  bind: (...a: unknown[]) => wrap(sql, a),
  first: async () => db.prepare(sql).get(...(args as any)) ?? null,
  all: async () => ({ results: db.prepare(sql).all(...(args as any)) }),
  run: async () => { const r = db.prepare(sql).run(...(args as any)); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
});
const env = { DB: { prepare: (s: string) => wrap(s), batch: async (ss: any[]) => Promise.all(ss.map((x) => x.all())) }, TZ_OFFSET_MINUTES: '480', MILE_VALUE_CENTS: '1.5' } as unknown as Env;
Date.now = () => Date.parse('2026-09-11T04:00:00Z');

let fails = 0;
const check = (l: string, c: boolean, d = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : `  -- ${d}`}`); };
const sql = (s: string, ...a: unknown[]) => db.prepare(s).run(...(a as any));

await runMigrations(env);
sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at)
     VALUES ('Citi','Rewards','citi_rw','crw',500000,15,'2025-01-01')`);
const tx = (cents: number, d: string, merchant: string | null, cat: string | null = null) =>
  sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at,merchant,category) VALUES (1,?,?,?,?)`, cents, d, merchant, cat);

// A monthly subscription at a steady price.
for (const d of ['2026-04-08','2026-05-08','2026-06-09','2026-07-08','2026-08-08','2026-09-08']) tx(1590, d, 'Netflix', 'entertainment');
// One that stopped in June — the kind worth noticing.
for (const d of ['2026-03-14','2026-04-14','2026-05-14','2026-06-14']) tx(999, d, 'Spotify', 'entertainment');
// A shop visited often but at wildly varying amounts: not a subscription.
for (const [d, a] of [['2026-06-02',4500],['2026-07-04',12000],['2026-08-01',2300],['2026-09-03',9800]] as [string,number][]) tx(a, d, 'NTUC', 'groceries');
// Only twice — a coincidence, not a pattern.
tx(5000, '2026-07-01', 'Gym'); tx(5000, '2026-08-01', 'Gym');

const rec = await findRecurring(env);
const netflix = rec.find((r) => r.merchant === 'netflix');
check('detects a steady monthly charge', !!netflix, JSON.stringify(rec.map((r) => r.merchant)));
check('reads its cadence', netflix!.cadence_days >= 29 && netflix!.cadence_days <= 32, `got ${netflix!.cadence_days}`);
check('reads its typical amount', netflix!.typical_cents === 1590, `got ${netflix!.typical_cents}`);
check('annualises it', Math.abs(netflix!.annualised_cents - 19000) < 1500, `got ${netflix!.annualised_cents}`);
check('and knows it is still running', netflix!.lapsed === false, '');

const spotify = rec.find((r) => r.merchant === 'spotify');
check('detects one that has stopped', !!spotify && spotify.lapsed === true, JSON.stringify(spotify));

check('ignores a shop with erratic amounts', !rec.some((r) => r.merchant === 'ntuc'), JSON.stringify(rec.map((r) => r.merchant)));
check('ignores two occurrences', !rec.some((r) => r.merchant === 'gym'), JSON.stringify(rec.map((r) => r.merchant)));

// --- category baselines ---
for (const m of ['04','05','06','07','08']) tx(20000, `2026-${m}-10`, 'Restaurant', 'dining');
tx(90000, '2026-09-10', 'Restaurant', 'dining');           // a real spike
for (const m of ['04','05','06','07','08']) tx(30000, `2026-${m}-12`, 'Airline', 'travel');
tx(31000, '2026-09-12', 'Airline', 'travel');              // normal variation

const tr = await categoryTrends(env, '2026-09');
const dining = tr.find((t) => t.category === 'dining')!;
check('flags a genuine spike', dining.verdict === 'spike', JSON.stringify(dining));
check('against the category baseline, not last month alone', dining.baseline_cents === 20000, `got ${dining.baseline_cents}`);
check('and quantifies the excess', dining.delta_cents === 70000, `got ${dining.delta_cents}`);

const travel = tr.find((t) => t.category === 'travel')!;
check('leaves normal variation alone', travel.verdict === 'steady', JSON.stringify(travel));

// A category with no history is new, not a spike.
tx(4000, '2026-09-14', 'Vet', 'pets');
const tr2 = await categoryTrends(env, '2026-09');
check('a first-ever category is marked new', tr2.find((t) => t.category === 'pets')!.verdict === 'new', '');

// A large relative jump on a trivial amount is not news.
for (const m of ['04','05','06','07','08']) tx(200, `2026-${m}-20`, 'Post', 'utilities');
tx(900, '2026-09-20', 'Post', 'utilities');
const tr3 = await categoryTrends(env, '2026-09');
check('a big percentage on a tiny amount stays steady',
  tr3.find((t) => t.category === 'utilities')!.verdict === 'steady',
  JSON.stringify(tr3.find((t) => t.category === 'utilities')));

// --- duplicates ---
tx(7800, '2026-09-06', 'Cafe'); tx(7800, '2026-09-06', 'Cafe');
tx(4000, '2026-09-02', 'Bar'); tx(4000, '2026-09-20', 'Bar');   // far apart: not a duplicate
const dup = await findDuplicates(env, '2026-09');
check('spots a same-day double charge', dup.some((d) => d.merchant === 'cafe'), JSON.stringify(dup));
check('ignores the same amount weeks apart', !dup.some((d) => d.merchant === 'bar'), JSON.stringify(dup));

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall passed');
process.exit(fails ? 1 : 0);
