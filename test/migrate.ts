import { DatabaseSync } from 'node:sqlite';
import { runMigrations, runSeed } from '../src/migrate';
import type { Env } from '../src/types';

// Same minimal D1 shim the e2e suite uses.
function makeEnv() {
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
  return {
    db,
    env: {
      DB: { prepare: (sql: string) => wrap(sql), batch: async (ss: any[]) => Promise.all(ss.map((x: any) => x.all())) },
    } as unknown as Env,
  };
}

let fails = 0;
const check = (label: string, cond: boolean, detail = '') => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  -- ${detail}`}`);
};
const tables = (db: DatabaseSync) =>
  (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((r) => r.name);
const cols = (db: DatabaseSync, t: string) =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((r) => r.name);
const indexes = (db: DatabaseSync) =>
  (db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as { name: string }[]).map((r) => r.name);

// --- an empty database gets the whole schema -------------------------------
{
  const { db, env } = makeEnv();
  const r = await runMigrations(env);
  check('no errors on a fresh database', r.errors.length === 0, r.errors.join(' | '));
  for (const t of ['cards', 'transactions', 'requirements', 'offers', 'programs', 'conversions', 'earn_rules', 'balance_tranches']) {
    check(`creates ${t}`, tables(db).includes(t), tables(db).join(','));
  }
  check('reports what it created', r.created.includes('conversions'), r.created.join(','));
  check('new tables already carry the later columns', cols(db, 'conversions').includes('verified_at'), cols(db, 'conversions').join(','));
}

// --- the exact failure reported: older tables, points tables missing --------
{
  const { db, env } = makeEnv();
  // A database as it stood before migration 003: cards exist, conversions do not.
  db.exec(`CREATE TABLE cards (id INTEGER PRIMARY KEY, issuer TEXT, product TEXT, product_key TEXT,
           nickname TEXT, credit_limit_cents INTEGER, statement_day INTEGER, opened_at TEXT,
           closed_at TEXT, signup_bonus_at TEXT, base_mpd REAL, created_at TEXT)`);
  db.exec(`CREATE TABLE requirements (id INTEGER PRIMARY KEY, card_id INTEGER, kind TEXT,
           amount_cents INTEGER, window TEXT, deadline TEXT, starts_at TEXT,
           bonus_cap_cents INTEGER, reward_note TEXT, active INTEGER)`);
  db.exec(`CREATE TABLE feed_items (id INTEGER PRIMARY KEY, guid TEXT UNIQUE, feed TEXT, title TEXT,
           link TEXT, published_at TEXT, seen_at TEXT, action TEXT, offer_id INTEGER)`);
  db.exec(`INSERT INTO cards (issuer, product, nickname) VALUES ('UOB', 'One Card', 'uobone')`);

  check('conversions really is missing first', !tables(db).includes('conversions'));

  const r = await runMigrations(env);
  check('creates only the missing tables', r.created.includes('conversions') && !r.created.includes('cards'), r.created.join(','));
  check('adds min_txns to the old requirements table', cols(db, 'requirements').includes('min_txns'), cols(db, 'requirements').join(','));
  check('adds topic to the old feed_items table', cols(db, 'feed_items').includes('topic'), cols(db, 'feed_items').join(','));
  check('reports the columns it added', r.altered.includes('requirements.min_txns'), r.altered.join(','));

  // The point of the exercise: existing rows survive.
  const kept = db.prepare(`SELECT nickname FROM cards`).all() as { nickname: string }[];
  check('existing data is untouched', kept.length === 1 && kept[0].nickname === 'uobone', JSON.stringify(kept));

  // Running again must be a clean no-op, not a duplicate-column error.
  const again = await runMigrations(env);
  check('second run is a no-op', again.alreadyCurrent && again.errors.length === 0, JSON.stringify(again));
}

// --- seeding is idempotent --------------------------------------------------
{
  const { db, env } = makeEnv();
  await runMigrations(env);
  const first = await runSeed(env);
  check('seed applies without error', first.errors.length === 0, first.errors.join(' | '));
  const routes = () => (db.prepare(`SELECT count(*) n FROM conversions`).get() as { n: number }).n;
  const n1 = routes();
  check('seed loads the transfer routes', n1 === 13, `got ${n1}`);
  check('every seeded route starts unverified',
    (db.prepare(`SELECT count(*) n FROM conversions WHERE verified_at IS NULL`).get() as { n: number }).n === 13,
    'seeded fees are placeholders and must be flagged');

  await runSeed(env);
  check('re-seeding does not duplicate', routes() === n1, `got ${routes()}`);
}

// --- an index over a column added later -------------------------------------
// The shape that broke a real migration: the database predates both the column
// and the index that uses it. A fresh database cannot catch this, because its
// CREATE TABLE already carries the column.
{
  const { db, env } = makeEnv();
  db.prepare(
    `CREATE TABLE programs (key TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT 'points', expiry_months INTEGER)`
  ).run();
  // The old shape: no source, no period.
  db.prepare(
    `CREATE TABLE balance_tranches (id INTEGER PRIMARY KEY AUTOINCREMENT, program_key TEXT NOT NULL,
      points INTEGER NOT NULL, earned_at TEXT, expires_at TEXT, note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`
  ).run();
  db.prepare(`INSERT INTO programs (key,name,kind) VALUES ('krisflyer','KrisFlyer','airline')`).run();
  db.prepare(`INSERT INTO balance_tranches (program_key, points) VALUES ('krisflyer', 1000)`).run();

  const report = await runMigrations(env);
  check('the old table gains its columns', cols(db, 'balance_tranches').includes('source'), cols(db, 'balance_tranches').join(','));
  check('and the period column', cols(db, 'balance_tranches').includes('period'), '');
  check('the index over them is created too', indexes(db).includes('tranche_auto'), indexes(db).join(','));
  check('with nothing reported as a problem', report.errors.length === 0, JSON.stringify(report.errors));
  check('the existing row survives', (db.prepare(`SELECT COUNT(*) c FROM balance_tranches`).get() as any).c === 1, '');
  check('defaulted to manual', (db.prepare(`SELECT source FROM balance_tranches`).get() as any).source === 'manual', '');

  // The index has to actually hold: one automatic tranche per programme/month.
  db.prepare(`INSERT INTO balance_tranches (program_key, points, source, period) VALUES ('krisflyer', 5, 'auto', '2026-09')`).run();
  let clashed = false;
  try {
    db.prepare(`INSERT INTO balance_tranches (program_key, points, source, period) VALUES ('krisflyer', 5, 'auto', '2026-09')`).run();
  } catch {
    clashed = true;
  }
  check('a second automatic tranche for that month is refused', clashed, '');

  const again = await runMigrations(env);
  check('migrating again is clean', again.errors.length === 0, JSON.stringify(again.errors));
  check('and reports nothing left to do', again.alreadyCurrent, JSON.stringify(again));
}

// --- a card pointing at a programme that is not there -------------------------
// Reported from the app: "/migrate" answered `1 problem(s): linking cards to
// products — D1_ERROR: FOREIGN KEY constraint failed`, and adding a card failed
// the same way. Both columns hold a programme key that references programs(key),
// so a name that is not in that table does not store badly — it refuses the
// insert, and one such card stopped every other card being linked.
{
  const { db, env } = makeEnv();
  await runMigrations(env);
  await runSeed(env);

  // A row from a database that predates the constraint, or whose programme was
  // renamed. Written with the constraint off, because that is the only way it
  // could have got there.
  db.exec('PRAGMA foreign_keys = OFF');
  db.prepare(
    `INSERT INTO cards (issuer, product, product_key, nickname, credit_limit_cents, statement_day, opened_at, base_mpd, program_key)
     VALUES ('Trust','Freedom Card','trust_freedom_card','freedom',3910000,19,'2026-09-19',1.5,'none')`
  ).run();
  db.prepare(
    `INSERT INTO cards (issuer, product, product_key, nickname, credit_limit_cents, statement_day, opened_at, base_mpd, program_key)
     VALUES ('UOB','One Card','uob_one_card','one',500000,18,'2026-01-01',0,NULL)`
  ).run();
  db.exec('PRAGMA foreign_keys = ON');

  const r = await runMigrations(env);
  check('one card with a dangling programme no longer fails the whole step', r.errors.length === 0, JSON.stringify(r.errors));

  const freedom = db.prepare(`SELECT product_id, program_key FROM cards WHERE nickname = 'freedom'`).get() as any;
  check('the card is linked to a product anyway', typeof freedom?.product_id === 'number', JSON.stringify(freedom));
  check('and the programme that does not exist is cleared', freedom?.program_key === null, JSON.stringify(freedom));
  check(
    'the repair is reported rather than silent',
    (r.products?.repaired ?? []).some((x) => x.nickname === 'freedom' && /does not exist/.test(x.what)),
    JSON.stringify(r.products?.repaired)
  );

  const other = db.prepare(`SELECT product_id FROM cards WHERE nickname = 'one'`).get() as any;
  check('and every other card is linked too', typeof other?.product_id === 'number', JSON.stringify(other));

  const prod = db.prepare(`SELECT program_key FROM card_products WHERE product_key = 'trust_freedom_card'`).get() as any;
  check('the product it created carries no invented programme', prod?.program_key === null, JSON.stringify(prod));

  const twice = await runMigrations(env);
  check('and a second run has nothing left to repair', (twice.products?.repaired ?? []).length === 0, JSON.stringify(twice.products));
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall passed');
process.exit(fails ? 1 : 0);
