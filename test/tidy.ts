import { DatabaseSync } from 'node:sqlite';
import { runMigrations, runSeed } from '../src/migrate';
import { merchantGroups, renameMerchant } from '../src/tidy';
import { assignMerchantCode } from '../src/mccscan';
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

let fails = 0;
const check = (l: string, c: boolean, d = '') => {
  if (!c) fails++;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : `  -- ${d}`}`);
};
const sql = (s: string, ...a: unknown[]) => db.prepare(s).run(...(a as any));
Date.now = () => Date.parse('2026-09-16T04:00:00Z');

await runMigrations(env);
await runSeed(env);
sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,base_mpd)
     VALUES ('UOB','One','uob_one','one',500000,18,'2026-01-01',0)`);

const tx = (merchant: string, cents = 500, cat: string | null = null, src: string | null = null) =>
  sql(
    `INSERT INTO transactions (card_id,amount_cents,occurred_at,merchant,category,category_source,needs_review)
     VALUES (1,?,'2026-09-01',?,?,?,1)`,
    cents,
    merchant,
    cat,
    src
  );

// --- spotting one merchant spelled many ways --------------------------------
for (const m of ['BUS/MRT 3948201', 'BUS/MRT 7712', 'BUS/MRT 22']) tx(m, 210);
tx('NTUC FAIRPRICE', 4000);
tx('NTUC INCOME', 9000);
tx('Cold Storage', 3000);

{
  const groups = await merchantGroups(env);
  const bus = groups.find((g) => /BUS\/MRT/i.test(g.prefix));
  check('spellings that differ only by an id are grouped', !!bus, JSON.stringify(groups.map((g) => g.prefix)));
  check('all three variants are in it', bus?.variants.length === 3, JSON.stringify(bus?.variants));
  check('the prefix stops at a word boundary', bus?.prefix === 'BUS/MRT', String(bus?.prefix));
  check('and the purchases are counted', bus?.txn_count === 3, String(bus?.txn_count));

  // Two shops that merely share an opening are not one merchant.
  const ntuc = groups.find((g) => /^NTUC/i.test(g.prefix));
  check('two different shops sharing a word are not merged', !ntuc, JSON.stringify(ntuc));
  check('a merchant with one spelling is not a group', !groups.some((g) => /Cold Storage/i.test(g.prefix)), '');
}

// --- renaming ----------------------------------------------------------------
{
  const preview = await renameMerchant(env, { match: 'BUS/MRT', to: 'BUS/MRT' });
  check('a preview reports what it would change', preview.matched === 3, String(preview.matched));
  check('and names every spelling first', preview.from.length === 3, JSON.stringify(preview.from));
  check('without touching anything', preview.updated === 0 && preview.preview === true, '');
  const still = db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE merchant = 'BUS/MRT'`).get() as any;
  check('the rows are untouched until you say so', Number(still.n) === 0, String(still.n));

  const done = await renameMerchant(env, { match: 'BUS/MRT', to: 'BUS/MRT', apply: true });
  check('applying rewrites them', done.updated === 3, String(done.updated));
  const after = db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE merchant = 'BUS/MRT'`).get() as any;
  check('and they are now one name', Number(after.n) === 3, String(after.n));

  const other = db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE merchant LIKE 'NTUC%'`).get() as any;
  check('nothing outside the match moved', Number(other.n) === 2, String(other.n));

  check('contains finds a name that does not start with it', (await renameMerchant(env, { match: 'FAIRPRICE', to: 'x', mode: 'contains' })).matched === 1, '');
  check('exact matches only the whole name', (await renameMerchant(env, { match: 'NTUC', to: 'x', mode: 'exact' })).matched === 0, '');

  // A merchant with a wildcard in its name must not widen the match.
  tx('50% OFF SHOP', 100);
  const wild = await renameMerchant(env, { match: '50%', to: 'y', mode: 'prefix' });
  check('a % in a name is matched literally, not as a wildcard', wild.matched === 1, JSON.stringify(wild.from));

  let threw = '';
  try {
    await renameMerchant(env, { match: '', to: 'x' });
  } catch (e) {
    threw = (e as Error).message;
  }
  check('renaming nothing is refused', /required/.test(threw), threw);
}

// --- a code brings its category with it --------------------------------------
{
  sql(`DELETE FROM transactions`);
  tx('kopitiam', 800);                       // no category at all
  tx('kopitiam', 900, 'shopping', 'learned'); // a guess, safe to correct
  tx('kopitiam', 1000, 'travel', 'manual');   // yours, and it stays yours

  const r = await assignMerchantCode(env, 'kopitiam', '5812');
  check('the code is applied to past purchases', r.updated === 3, String(r.updated));
  check("and the code's category comes with it", r.category === 'dining', String(r.category));
  check('for the rows that had none or only a guess', r.categorised === 2, String(r.categorised));

  const manual = db.prepare(`SELECT category FROM transactions WHERE category_source = 'manual'`).get() as any;
  check('a category you set by hand is never overwritten', manual.category === 'travel', String(manual.category));

  const rows = db.prepare(`SELECT category, category_source, needs_review FROM transactions WHERE category_source = 'mcc'`).all() as any[];
  check('the ones it set are marked as coming from the code', rows.length === 2, String(rows.length));
  check('and no longer ask to be reviewed', rows.every((r) => Number(r.needs_review) === 0), JSON.stringify(rows));

  // Opting out has to work, since a code's category is a generalisation.
  sql(`UPDATE transactions SET category = NULL, category_source = NULL, mcc = NULL`);
  const off = await assignMerchantCode(env, 'kopitiam', '5812', { categorise: false });
  check('and it can be turned off', off.categorised === 0, String(off.categorised));
}

console.log(fails ? `\n${fails} check(s) failed` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
