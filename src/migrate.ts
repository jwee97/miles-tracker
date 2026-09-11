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
  { table: 'transactions', column: 'posted_at', ddl: 'ALTER TABLE transactions ADD COLUMN posted_at TEXT' },
  { table: 'conversions', column: 'verified_at', ddl: 'ALTER TABLE conversions ADD COLUMN verified_at TEXT' },
  { table: 'conversions', column: 'source_url', ddl: 'ALTER TABLE conversions ADD COLUMN source_url TEXT' },
  { table: 'conversions', column: 'note', ddl: 'ALTER TABLE conversions ADD COLUMN note TEXT' },
  { table: 'feed_items', column: 'topic', ddl: 'ALTER TABLE feed_items ADD COLUMN topic TEXT' },
  { table: 'transactions', column: 'category_source', ddl: 'ALTER TABLE transactions ADD COLUMN category_source TEXT' },
  {
    table: 'transactions',
    column: 'needs_review',
    ddl: 'ALTER TABLE transactions ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0',
  },
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

  // Every CREATE in schema.sql is IF NOT EXISTS, so this only fills gaps.
  for (const stmt of statements(schemaSql)) {
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
