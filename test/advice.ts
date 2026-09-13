import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../src/migrate';
import { optimise } from '../src/advice';
import type { Card, Env } from '../src/types';

const db = new DatabaseSync(':memory:');
const wrap = (sql: string, args: unknown[] = []): any => ({
  bind: (...a: unknown[]) => wrap(sql, a),
  first: async () => db.prepare(sql).get(...(args as any)) ?? null,
  all: async () => ({ results: db.prepare(sql).all(...(args as any)) }),
  run: async () => { const r = db.prepare(sql).run(...(args as any)); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
});
const env = { DB: { prepare: (s: string) => wrap(s) }, TZ_OFFSET_MINUTES: '480', MILE_VALUE_CENTS: '1.5' } as unknown as Env;
Date.now = () => Date.parse('2026-09-11T04:00:00Z');

let fails = 0;
const check = (l: string, c: boolean, d = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : `  -- ${d}`}`); };
const sql = (s: string, ...a: unknown[]) => db.prepare(s).run(...(a as any));
const card = (n: string) => db.prepare(`SELECT * FROM cards WHERE nickname = ?`).get(n) as Card;

await runMigrations(env);
sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,base_mpd)
     VALUES ('Citi','Citi PremierMiles','citi_pm','pm',900000,15,'2025-01-01',1.4)`);
sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,base_mpd)
     VALUES ('UOB','UOB Lady''s','uob_lady','lady',800000,15,'2025-01-01',0.4)`);
const pm = card('pm'), lady = card('lady');

sql(`INSERT INTO earn_rules (card_id,category,mpd,reward_type) VALUES (?,'*',1.4,'miles')`, pm.id);
// Lady's: 4 mpd on dining, $1,000 a month.
sql(`INSERT INTO earn_rules (card_id,category,mpd,reward_type,cap_cents,cap_window) VALUES (?,'dining',4,'miles',100000,'calendar_month')`, lady.id);
sql(`INSERT INTO earn_rules (card_id,category,mpd,reward_type) VALUES (?,'*',0.4,'miles')`, lady.id);

// Three months of dining, all on the wrong card.
for (const m of ['06','07','08']) {
  sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at,category,merchant) VALUES (?,40000,?,'dining','Restaurant')`, pm.id, `2026-${m}-10`);
}

let o = await optimise(env);
check('counts the months it actually has', o.months_analysed === 3, `got ${o.months_analysed}`);
const move = o.reallocations.find((r) => r.category === 'dining');
check('spots spend on the wrong card', !!move, JSON.stringify(o.reallocations));
check('names where it should go', move!.to_card.includes("Lady"), JSON.stringify(move));
check('and where it is now', move!.from_card.includes('PremierMiles'), '');
check('quotes both rates', move!.from_rate === '1.4 mpd' && move!.to_rate === '4 mpd', `${move!.from_rate}/${move!.to_rate}`);
// $400/mo moved from 1.4 to 4 mpd earns 1,040 EXTRA miles a month — the gain,
// not the 1,600 the target card earns in total.
check('prices the gain in miles a year', move!.gain_miles_year === 400 * 2.6 * 12, `got ${move!.gain_miles_year}`);
check('and not the target card total', move!.gain_miles_year !== 400 * 4 * 12, 'reported the total, not the gain');
// At 1.5c a mile: 1,040 × 1.5c = $15.60/mo = $187.20/yr.
check('and in dollars a year', move!.gain_cents_year === 18720, `got ${move!.gain_cents_year}`);
check('the headline total matches', o.total_gain_cents_year === 18720, `got ${o.total_gain_cents_year}`);

// A cap must limit what it suggests moving.
for (const m of ['06','07','08']) {
  sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at,category,merchant) VALUES (?,250000,?,'dining','Banquet')`, pm.id, `2026-${m}-20`);
}
o = await optimise(env);
const capped = o.reallocations.find((r) => r.category === 'dining')!;
check('never suggests moving more than the cap holds', capped.movable_cents === 100000, `got ${capped.movable_cents}`);
check('and says what limited it', /cap/.test(capped.capped_by ?? ''), String(capped.capped_by));
check('the monthly figure is still the real one', capped.monthly_cents === 290000, `got ${capped.monthly_cents}`);

// --- an allowance going to waste -----------------------------------------
sql(`DELETE FROM transactions`);
// Barely any dining, but a lot of groceries that Lady's does not currently boost.
for (const m of ['06','07','08']) {
  sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at,category,merchant) VALUES (?,8000,?,'dining','Cafe')`, lady.id, `2026-${m}-05`);
  sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at,category,merchant) VALUES (?,90000,?,'groceries','NTUC')`, pm.id, `2026-${m}-06`);
}
o = await optimise(env);
const idle = o.underused.find((u) => u.card.includes('Lady'));
check('flags a bonus allowance barely used', !!idle, JSON.stringify(o.underused));
check('with its utilisation', idle!.utilisation_pct === 8, `got ${idle!.utilisation_pct}`);
check('and what the unused part is worth', idle!.unused_value_cents_year > 0, String(idle!.unused_value_cents_year));
check('suggests a category worth switching to', idle!.better_category?.category === 'groceries', JSON.stringify(idle!.better_category));
check('sized by what you actually spend there', idle!.better_category!.monthly_cents === 90000, `got ${idle!.better_category!.monthly_cents}`);

// A well-used allowance is not flagged.
sql(`DELETE FROM transactions`);
for (const m of ['06','07','08']) {
  sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at,category,merchant) VALUES (?,95000,?,'dining','Restaurant')`, lady.id, `2026-${m}-05`);
}
o = await optimise(env);
check('leaves a well-used allowance alone', !o.underused.some((u) => u.card.includes('Lady')), JSON.stringify(o.underused));
check('and finds nothing to move', o.reallocations.length === 0, JSON.stringify(o.reallocations));
check('saying so plainly', o.notes.some((n) => /already on the best card/.test(n)), JSON.stringify(o.notes));

// Uncategorised spend has no rate, so it must be excluded and said so.
sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at) VALUES (?,50000,'2026-08-09')`, pm.id);
o = await optimise(env);
check('ignores uncategorised spend', !o.reallocations.some((r) => r.category === 'uncategorised'), '');
check('and explains why', o.notes.some((n) => /Uncategorised/.test(n)), JSON.stringify(o.notes));

// Trivial amounts are not worth a suggestion.
sql(`DELETE FROM transactions`);
sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at,category) VALUES (?,300,'2026-08-09','dining')`, pm.id);
o = await optimise(env);
check('ignores amounts too small to matter', o.reallocations.length === 0, JSON.stringify(o.reallocations));

// One month of history should say so rather than extrapolate confidently.
check('warns when the history is one month', o.notes.some((n) => /one month/.test(n)), JSON.stringify(o.notes));

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall passed');
process.exit(fails ? 1 : 0);
