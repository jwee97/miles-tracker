import { DatabaseSync } from 'node:sqlite';
import { runMigrations, runSeed } from '../src/migrate';
import { mccMatrix } from '../src/mcc';
import { requirementProgress } from '../src/spend';
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
const base = {
  DB: { prepare: (s: string) => wrap(s), batch: async (ss: any[]) => Promise.all(ss.map((x) => x.all())) },
  TZ_OFFSET_MINUTES: '480',
  MILE_VALUE_CENTS: '1.5',
  MIN_SPEND_WARN_DAYS: '7',
  POSTING_LAG_DAYS: '0',
};
const env = base as unknown as Env;
Date.now = () => Date.parse('2026-09-14T04:00:00Z');

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
sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,base_mpd)
     VALUES ('Citi','Rewards','citi_rw','crw',500000,15,'2026-01-01',0.4)`);
sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,closed_at)
     VALUES ('DBS','Old','dbs_old','old',500000,15,'2024-01-01','2025-06-01')`);
const lady = (db.prepare(`SELECT * FROM cards WHERE nickname='lady'`).get() as Card).id;
const crw = (db.prepare(`SELECT * FROM cards WHERE nickname='crw'`).get() as Card).id;

sql(`INSERT INTO earn_rules (card_id,category,mpd,reward_type,cap_cents,cap_window) VALUES (?,'dining',4,'miles',100000,'calendar_month')`, lady);
sql(`INSERT INTO earn_rules (card_id,category,mpd,reward_type) VALUES (?,'*',0.4,'miles')`, lady);
sql(`INSERT INTO earn_rules (card_id,category,mpd,reward_type,mcc_include) VALUES (?,'online',4,'miles','5262,5964,5969')`, crw);
sql(`INSERT INTO earn_rules (card_id,category,mpd,reward_type) VALUES (?,'*',0.4,'miles')`, crw);
// A card-specific exclusion on top of the seeded blanket ones.
sql(`INSERT INTO exclusions (card_id,mcc,reason,source) VALUES (?, '5541', 'UOB excludes fuel on this card', 'user')`, lady);
// Spend, so the "codes you have used" view has something in it.
sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at,merchant,mcc,category) VALUES (?,8000,'2026-09-02','Din Tai Fung','5812','dining')`, lady);
sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at,merchant,mcc,category) VALUES (?,20000,'2026-09-03','IRAS','9311','bills')`, lady);

const m = await mccMatrix(env, { per_page: 200, page: 1 });
const all = await mccMatrix(env, { per_page: 200, page: 2 });
const row = (code: string) => [...m.rows, ...all.rows].find((r) => r.code === code)!;
const firstPage = await mccMatrix(env);
check('a default page holds 50', firstPage.rows.length === 50, String(firstPage.rows.length));
check('paging reports the page count', firstPage.pages === 7, String(firstPage.pages));
check('and a later page holds the remainder', (await mccMatrix(env, { page: 7 })).rows.length === 27, '');
check('the whole generic list is counted', m.total === 327, String(m.total));
check('individual carriers are hidden by default', m.carriers_hidden === 597, String(m.carriers_hidden));
check('and can be asked for', (await mccMatrix(env, { carriers: true })).total === 924, String((await mccMatrix(env, { carriers: true })).total));

check('only open cards are columns', m.cards.length === 2, JSON.stringify(m.cards.map((c) => c.nickname)));
check('a closed card is not', !m.cards.some((c) => c.nickname === 'old'), '');

const dining = row('5812');
const ladyDining = dining.cells.find((c) => c.nickname === 'lady')!;
check('a bonus category shows as a bonus', ladyDining.state === 'bonus', ladyDining.state);
check('at its real rate', ladyDining.rate === 4, String(ladyDining.rate));
check('carrying the cap', ladyDining.cap_cents === 100000 && ladyDining.cap_window === 'calendar_month', JSON.stringify(ladyDining));
const crwDining = dining.cells.find((c) => c.nickname === 'crw')!;
check('a card with only a base rate shows base', crwDining.state === 'base', crwDining.state);
check('at the base rate', crwDining.rate === 0.4, String(crwDining.rate));

// The MCC list on a rule is honoured, not just the category name.
const online = row('5262');
if (online) {
  const cell = online.cells.find((c) => c.nickname === 'crw')!;
  check('an MCC list on a rule is matched', cell.state === 'bonus' && cell.rate === 4, JSON.stringify(cell));
}
const notListed = row('5411');
check(
  'a code outside that list falls back to base',
  notListed.cells.find((c) => c.nickname === 'crw')!.state === 'base',
  JSON.stringify(notListed.cells)
);

const tax = row('9311');
check('a seeded exclusion applies to every card', tax.excluded_everywhere, '');
check('and every cell says so', tax.cells.every((c) => c.state === 'excluded'), JSON.stringify(tax.cells));
check('with the reason it was recorded with', /Tax/i.test(tax.exclusion_reason ?? ''), String(tax.exclusion_reason));

const fuel = row('5541');
check('a card-specific exclusion hits only that card', fuel.cells.find((c) => c.nickname === 'lady')!.state === 'excluded', '');
check('and leaves the others earning', fuel.cells.find((c) => c.nickname === 'crw')!.state !== 'excluded', JSON.stringify(fuel.cells));
check('which is not an exclusion everywhere', !fuel.excluded_everywhere, '');

check('your own spend is attached to the code', dining.spend_cents === 8000 && dining.txn_count === 1, JSON.stringify(dining));
check('the summary counts codes you have used', m.summary.codes_you_have_used === 2, String(m.summary.codes_you_have_used));
check('and what excluded codes have cost you', m.summary.excluded_spend_cents === 20000, String(m.summary.excluded_spend_cents));
check('blanket and per-card exclusions are counted apart', m.summary.excluded_everywhere > 0 && m.summary.excluded_somewhere === 1, JSON.stringify(m.summary));

// --- filtering --------------------------------------------------------------
check('search matches a code', (await mccMatrix(env, { q: '5812' })).rows.length === 1, '');
check('and a description', (await mccMatrix(env, { q: 'restaurant' })).rows.some((r) => r.code === '5812'), '');
check('and a category', (await mccMatrix(env, { q: 'dining' })).rows.every((r) => r.category === 'dining'), '');
const onlyExcluded = await mccMatrix(env, { filter: 'excluded' });
check('the excluded filter shows only those', onlyExcluded.rows.every((r) => r.cells.some((c) => c.state === 'excluded')), '');
check('including the card-specific one', onlyExcluded.rows.some((r) => r.code === '5541'), '');
const onlyBonus = await mccMatrix(env, { filter: 'bonus' });
check('the bonus filter shows only bonuses', onlyBonus.rows.every((r) => r.cells.some((c) => c.state === 'bonus')), '');
check('the used filter shows only what you spent on', (await mccMatrix(env, { filter: 'used' })).rows.length === 2, '');
check('a category filter narrows to it', (await mccMatrix(env, { category: 'groceries' })).rows.every((r) => r.category === 'groceries'), '');
check('the summary still counts the whole table', onlyBonus.summary.codes === m.summary.codes, '');

// --- excluded spend and minimum spend ---------------------------------------
sql(`INSERT INTO requirements (card_id,kind,amount_cents,window,active) VALUES (?, 'monthly_min', 50000, 'calendar_month', 1)`, lady);
const req = db.prepare(`SELECT * FROM requirements WHERE card_id = ?`).get(lady) as any;
const card = db.prepare(`SELECT * FROM cards WHERE id = ?`).get(lady) as Card;

const p = await requirementProgress(env, card, req);
check('tax spend does not count toward the minimum', p.spent_cents === 8000, String(p.spent_cents));
check('and the amount left out is reported', p.excluded_cents === 20000, String(p.excluded_cents));
check('so the minimum is not falsely met', !p.met, '');

const lenient = await requirementProgress(
  { ...base, MIN_SPEND_COUNTS_EXCLUDED: 'true' } as unknown as Env,
  card,
  req
);
check('an issuer that does count it can be configured', lenient.spent_cents === 28000, String(lenient.spent_cents));
check('and then nothing is reported as left out', lenient.excluded_cents === 0, String(lenient.excluded_cents));

console.log(fails ? `\n${fails} check(s) failed` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
