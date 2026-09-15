import schemaSql from '../schema.sql';
import seedSql from '../seed.sql';
import { statements } from './sql';
import type { Env } from './types';

/**
 * Columns added to tables that already existed in an earlier version. CREATE
 * TABLE IF NOT EXISTS cannot add them, and SQLite has no ADD COLUMN IF NOT
 * EXISTS, so each is checked against PRAGMA table_info first.
 */
const ADDED_COLUMNS: { table: string; column: string; ddl: string }[] = [
  { table: 'requirements', column: 'min_txns', ddl: 'ALTER TABLE requirements ADD COLUMN min_txns INTEGER' },
  { table: 'requirements', column: 'anchor_at', ddl: 'ALTER TABLE requirements ADD COLUMN anchor_at TEXT' },
  {
    table: 'requirements',
    column: 'per_month',
    ddl: 'ALTER TABLE requirements ADD COLUMN per_month INTEGER NOT NULL DEFAULT 0',
  },
  {
    table: 'requirements',
    column: 'prorate_first',
    ddl: 'ALTER TABLE requirements ADD COLUMN prorate_first INTEGER NOT NULL DEFAULT 0',
  },
  { table: 'transactions', column: 'posted_at', ddl: 'ALTER TABLE transactions ADD COLUMN posted_at TEXT' },
  { table: 'conversions', column: 'verified_at', ddl: 'ALTER TABLE conversions ADD COLUMN verified_at TEXT' },
  { table: 'conversions', column: 'source_url', ddl: 'ALTER TABLE conversions ADD COLUMN source_url TEXT' },
  { table: 'conversions', column: 'note', ddl: 'ALTER TABLE conversions ADD COLUMN note TEXT' },
  { table: 'feed_items', column: 'topic', ddl: 'ALTER TABLE feed_items ADD COLUMN topic TEXT' },
  { table: 'feed_items', column: 'score', ddl: 'ALTER TABLE feed_items ADD COLUMN score INTEGER' },
  { table: 'feed_items', column: 'terms', ddl: 'ALTER TABLE feed_items ADD COLUMN terms TEXT' },
  { table: 'feed_items', column: 'excerpt', ddl: 'ALTER TABLE feed_items ADD COLUMN excerpt TEXT' },
  { table: 'feed_items', column: 'apply_url', ddl: 'ALTER TABLE feed_items ADD COLUMN apply_url TEXT' },
  {
    table: 'feed_items',
    column: 'deep',
    ddl: 'ALTER TABLE feed_items ADD COLUMN deep INTEGER NOT NULL DEFAULT 0',
  },
  { table: 'feeds', column: 'kind', ddl: 'ALTER TABLE feeds ADD COLUMN kind TEXT' },
  { table: 'offer_rules', column: 'decision', ddl: 'ALTER TABLE offer_rules ADD COLUMN decision TEXT' },
  { table: 'offer_rules', column: 'decided_at', ddl: 'ALTER TABLE offer_rules ADD COLUMN decided_at TEXT' },
  { table: 'offer_rules', column: 'note', ddl: 'ALTER TABLE offer_rules ADD COLUMN note TEXT' },
  { table: 'cards', column: 'program_key', ddl: 'ALTER TABLE cards ADD COLUMN program_key TEXT' },
  { table: 'transactions', column: 'expected_program', ddl: 'ALTER TABLE transactions ADD COLUMN expected_program TEXT' },
  { table: 'transactions', column: 'credited_at', ddl: 'ALTER TABLE transactions ADD COLUMN credited_at TEXT' },
  {
    table: 'transactions',
    column: 'credited_tranche_id',
    ddl: 'ALTER TABLE transactions ADD COLUMN credited_tranche_id INTEGER',
  },
  {
    table: 'balance_tranches',
    column: 'source',
    ddl: "ALTER TABLE balance_tranches ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'",
  },
  { table: 'balance_tranches', column: 'period', ddl: 'ALTER TABLE balance_tranches ADD COLUMN period TEXT' },
  {
    table: 'mcc_codes',
    column: 'verified',
    ddl: 'ALTER TABLE mcc_codes ADD COLUMN verified INTEGER NOT NULL DEFAULT 0',
  },
  { table: 'transactions', column: 'category_source', ddl: 'ALTER TABLE transactions ADD COLUMN category_source TEXT' },
  {
    table: 'transactions',
    column: 'needs_review',
    ddl: 'ALTER TABLE transactions ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0',
  },
  { table: 'earn_rules', column: 'mcc_include', ddl: 'ALTER TABLE earn_rules ADD COLUMN mcc_include TEXT' },
  { table: 'earn_rules', column: 'mcc_exclude', ddl: 'ALTER TABLE earn_rules ADD COLUMN mcc_exclude TEXT' },
  { table: 'earn_rules', column: 'channel', ddl: 'ALTER TABLE earn_rules ADD COLUMN channel TEXT' },
  { table: 'earn_rules', column: 'min_txn_cents', ddl: 'ALTER TABLE earn_rules ADD COLUMN min_txn_cents INTEGER' },
  { table: 'transactions', column: 'mcc', ddl: 'ALTER TABLE transactions ADD COLUMN mcc TEXT' },
  { table: 'transactions', column: 'channel', ddl: 'ALTER TABLE transactions ADD COLUMN channel TEXT' },
  { table: 'transactions', column: 'expected_miles', ddl: 'ALTER TABLE transactions ADD COLUMN expected_miles INTEGER' },
  { table: 'transactions', column: 'expected_cashback_cents', ddl: 'ALTER TABLE transactions ADD COLUMN expected_cashback_cents INTEGER' },
  { table: 'transactions', column: 'actual_miles', ddl: 'ALTER TABLE transactions ADD COLUMN actual_miles INTEGER' },
  { table: 'transactions', column: 'actual_cashback_cents', ddl: 'ALTER TABLE transactions ADD COLUMN actual_cashback_cents INTEGER' },
  { table: 'transactions', column: 'reward_note', ddl: 'ALTER TABLE transactions ADD COLUMN reward_note TEXT' },
  {
    table: 'earn_rules',
    column: 'reward_type',
    ddl: "ALTER TABLE earn_rules ADD COLUMN reward_type TEXT NOT NULL DEFAULT 'miles'",
  },
];

async function tableExists(env: Env, table: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
    .bind(table)
    .first<{ name: string }>();
  return !!row;
}

async function hasColumn(env: Env, table: string, column: string): Promise<boolean> {
  const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return (results ?? []).some((c) => c.name === column);
}

export interface MigrationReport {
  created: string[];
  altered: string[];
  alreadyCurrent: boolean;
  errors: string[];
}

/** Brings the database up to the schema the deployed code expects. Idempotent. */
export async function runMigrations(env: Env): Promise<MigrationReport> {
  const created: string[] = [];
  const altered: string[] = [];
  const errors: string[] = [];

  const before = new Set<string>();
  const { results: existing } = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type='table'`
  ).all<{ name: string }>();
  for (const t of existing ?? []) before.add(t.name);

  // Order matters on a database that predates a change. Tables first, then the
  // columns those tables are missing, and only then the indexes — an index over
  // a newly added column cannot be created before the column exists, and a
  // fresh database hides the problem because its CREATE TABLE already has it.
  const all = statements(schemaSql);
  const isIndex = (sql: string) => /^\s*CREATE\s+(UNIQUE\s+)?INDEX/i.test(sql);

  for (const stmt of all.filter((s) => !isIndex(s))) {
    try {
      await env.DB.prepare(stmt).run();
    } catch (e) {
      errors.push(`${stmt.slice(0, 60)}… — ${(e as Error).message}`);
    }
  }

  const { results: after } = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type='table'`
  ).all<{ name: string }>();
  for (const t of after ?? []) if (!before.has(t.name)) created.push(t.name);

  for (const col of ADDED_COLUMNS) {
    if (!(await tableExists(env, col.table))) continue;
    if (await hasColumn(env, col.table, col.column)) continue;
    try {
      await env.DB.prepare(col.ddl).run();
      altered.push(`${col.table}.${col.column}`);
    } catch (e) {
      errors.push(`${col.table}.${col.column} — ${(e as Error).message}`);
    }
  }

  for (const stmt of all.filter(isIndex)) {
    try {
      await env.DB.prepare(stmt).run();
    } catch (e) {
      errors.push(`${stmt.slice(0, 60)}… — ${(e as Error).message}`);
    }
  }

  return { created, altered, alreadyCurrent: !created.length && !altered.length, errors };
}

/** Loads the default feeds, programmes and transfer routes. INSERT OR IGNORE, so safe to repeat. */
export async function runSeed(env: Env): Promise<{ applied: number; errors: string[] }> {
  const errors: string[] = [];
  let applied = 0;
  for (const stmt of statements(seedSql)) {
    try {
      await env.DB.prepare(stmt).run();
      applied++;
    } catch (e) {
      errors.push(`${stmt.slice(0, 60)}… — ${(e as Error).message}`);
    }
  }
  return { applied, errors };
}
