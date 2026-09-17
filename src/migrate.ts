import schemaSql from '../schema.sql';
import seedSql from '../seed.sql';
import { statements } from './sql';
import { migrateCardsToProducts, type ProductMigrationReport } from './catalog/migrate-products';
import { seedCardProducts, type SeedReport } from './catalog/seed-products';
import { seedAliases } from './onboarding/search';
import { seedOnboardingFields } from './onboarding/questions';
import { migrateLegacyBonuses } from './transfers/routes';
import { today } from './spend';
import type { Env } from './types';

/**
 * Columns added to tables that already existed in an earlier version. CREATE
 * TABLE IF NOT EXISTS cannot add them, and SQLite has no ADD COLUMN IF NOT
 * EXISTS, so each is checked against PRAGMA table_info first.
 */
const ADDED_COLUMNS: { table: string; column: string; ddl: string }[] = [
  // --- the product layer (P0 phase 1) ---
  { table: 'cards', column: 'product_id', ddl: 'ALTER TABLE cards ADD COLUMN product_id INTEGER' },
  { table: 'earn_rules', column: 'rule_set_id', ddl: 'ALTER TABLE earn_rules ADD COLUMN rule_set_id INTEGER' },
  {
    table: 'earn_rules',
    column: 'priority',
    ddl: 'ALTER TABLE earn_rules ADD COLUMN priority INTEGER NOT NULL DEFAULT 0',
  },
  {
    table: 'transactions',
    column: 'evaluated_rule_set_id',
    ddl: 'ALTER TABLE transactions ADD COLUMN evaluated_rule_set_id INTEGER',
  },
  { table: 'transactions', column: 'evaluation_version', ddl: 'ALTER TABLE transactions ADD COLUMN evaluation_version TEXT' },
  { table: 'transactions', column: 'evaluated_at', ddl: 'ALTER TABLE transactions ADD COLUMN evaluated_at TEXT' },
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
  {
    table: 'transactions',
    column: 'status',
    ddl: "ALTER TABLE transactions ADD COLUMN status TEXT NOT NULL DEFAULT 'posted'",
  },
  // --- transaction capture (P0 phase 4) ---
  // The statement text as printed, kept beside the tidied name rather than
  // instead of it: a normaliser that got a merchant wrong must be correctable
  // from the original, and the original is gone the moment it is overwritten.
  { table: 'transactions', column: 'merchant_raw', ddl: 'ALTER TABLE transactions ADD COLUMN merchant_raw TEXT' },
  { table: 'transactions', column: 'merchant_id', ddl: 'ALTER TABLE transactions ADD COLUMN merchant_id INTEGER' },
  // --- onboarding (P1 phase 1) ---
  // A requirement created from a welcome offer keeps a link to the offer it
  // came from, so "where did this minimum come from" has an answer later.
  { table: 'requirements', column: 'source_note', ddl: 'ALTER TABLE requirements ADD COLUMN source_note TEXT' },
  // Existing cards were set up by hand, so their statement day was answered.
  {
    table: 'cards',
    column: 'statement_day_known',
    ddl: 'ALTER TABLE cards ADD COLUMN statement_day_known INTEGER NOT NULL DEFAULT 1',
  },
  // --- the reward ledger (P1 phase 2) ---
  // How a bank rounds is a property of the card, not of the calculation. UOB
  // pays per S$5 block; DBS rounds the statement total. Without this, every
  // reconciliation invents discrepancies that are really just rounding.
  {
    table: 'rule_sets',
    column: 'reward_rounding_json',
    ddl: 'ALTER TABLE rule_sets ADD COLUMN reward_rounding_json TEXT',
  },
  // --- transfers (P2 phase 4) ---
  // A route is versioned like a reward rule: banks change ratios, and a
  // transfer made in June must still be explicable in December.
  { table: 'conversions', column: 'effective_from', ddl: "ALTER TABLE conversions ADD COLUMN effective_from TEXT" },
  { table: 'conversions', column: 'effective_until', ddl: 'ALTER TABLE conversions ADD COLUMN effective_until TEXT' },
  // How long the bank takes. A target date is not met by a transfer that lands
  // after it, however good the ratio.
  { table: 'conversions', column: 'processing_days_min', ddl: 'ALTER TABLE conversions ADD COLUMN processing_days_min INTEGER' },
  { table: 'conversions', column: 'processing_days_max', ddl: 'ALTER TABLE conversions ADD COLUMN processing_days_max INTEGER' },
  { table: 'programs', column: 'programme_type', ddl: "ALTER TABLE programs ADD COLUMN programme_type TEXT" },
  { table: 'programs', column: 'expiry_policy', ddl: 'ALTER TABLE programs ADD COLUMN expiry_policy TEXT' },
  { table: 'programs', column: 'status', ddl: "ALTER TABLE programs ADD COLUMN status TEXT NOT NULL DEFAULT 'active'" },
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
  { table: 'earn_rules', column: 'min_tier_cents', ddl: 'ALTER TABLE earn_rules ADD COLUMN min_tier_cents INTEGER' },
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

/**
 * Columns whose constraints had to change, which SQLite cannot alter in place.
 *
 * `earn_rules.card_id` was NOT NULL because a rule always belonged to one
 * card. A rule now belongs to a product's versioned rule set instead, shared by
 * everyone holding that product, so the column has to be nullable — and the
 * only way to relax NOT NULL in SQLite is to rebuild the table.
 *
 * The rebuild copies every row by name, so a column added later is carried
 * across without this list needing to know about it, and it runs only while the
 * old constraint is still there.
 */
async function relaxEarnRuleCardId(env: Env, created: string[], errors: string[]): Promise<void> {
  const { results } = await env.DB.prepare(`PRAGMA table_info(earn_rules)`).all<{ name: string; notnull: number }>();
  const cols = results ?? [];
  const cardId = cols.find((c) => c.name === 'card_id');
  if (!cardId || cardId.notnull !== 1) return;

  const names = cols.map((c) => c.name).filter((n) => n !== 'id');
  try {
    // A rebuild, not a migration of data: same rows, same ids, one constraint
    // fewer. Ordered so a failure part-way leaves the original table intact.
    await env.DB.prepare(`DROP TABLE IF EXISTS earn_rules_rebuild`).run();
    await env.DB.prepare(
      `CREATE TABLE earn_rules_rebuild (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         ${cols
           .filter((c) => c.name !== 'id')
           .map((c) => `${c.name} ${c.name === 'card_id' ? 'INTEGER' : 'TEXT'}`)
           .join(', ')}
       )`
    ).run();
    await env.DB.prepare(
      `INSERT INTO earn_rules_rebuild (id, ${names.join(', ')}) SELECT id, ${names.join(', ')} FROM earn_rules`
    ).run();
    await env.DB.prepare(`DROP TABLE earn_rules`).run();
    await env.DB.prepare(`ALTER TABLE earn_rules_rebuild RENAME TO earn_rules`).run();
    created.push('earn_rules (rebuilt so a rule can belong to a product, not a card)');
  } catch (e) {
    errors.push(`relaxing earn_rules.card_id — ${(e as Error).message}`);
  }
}

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
  /** Moving existing cards onto the product and rule-set model. */
  products?: ProductMigrationReport;
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

  // After the columns, before the indexes: the rebuild recreates the table, so
  // its indexes have to be laid down again afterwards.
  await relaxEarnRuleCardId(env, created, errors);

  for (const stmt of all.filter(isIndex)) {
    try {
      await env.DB.prepare(stmt).run();
    } catch (e) {
      errors.push(`${stmt.slice(0, 60)}… — ${(e as Error).message}`);
    }
  }

  // Now the data half: existing cards onto the product model. It is idempotent,
  // so it runs every time and reports nothing when there is nothing to do.
  let products: ProductMigrationReport | undefined;
  try {
    products = await migrateCardsToProducts(env, today(env));
  } catch (e) {
    errors.push(`linking cards to products — ${(e as Error).message}`);
  }

  const movedData = !!products && !products.alreadyDone;
  return {
    created,
    altered,
    alreadyCurrent: !created.length && !altered.length && !movedData,
    errors,
    products,
  };
}

/** Loads the default feeds, programmes and transfer routes. INSERT OR IGNORE, so safe to repeat. */
export async function runSeed(env: Env): Promise<{
  applied: number;
  errors: string[];
  catalog?: SeedReport;
  aliases?: { added: number };
  onboarding?: { declared: number };
  bonuses?: { moved: number };
}> {
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
  // The card catalogue. Identity only — who issues what, and where its terms
  // live. Not one rate, because a rate nobody verified is worse than none.
  let catalog: SeedReport | undefined;
  try {
    catalog = await seedCardProducts(env);
  } catch (e) {
    errors.push(`seeding the card catalogue — ${(e as Error).message}`);
  }

  // Aliases and per-product questions are derived from the catalogue, so a card
  // added tomorrow is searchable and asks for the right details the same day,
  // without anyone remembering to write its nicknames down.
  let aliases: { added: number } | undefined;
  let onboarding: { declared: number } | undefined;
  try {
    aliases = await seedAliases(env);
    onboarding = await seedOnboardingFields(env);
  } catch (e) {
    errors.push(`seeding card aliases — ${(e as Error).message}`);
  }

  // A promotional uplift written into a route's ratio would be believed for
  // ever. Move any legacy ones onto their own dated rows.
  let bonuses: { moved: number } | undefined;
  try {
    bonuses = await migrateLegacyBonuses(env);
  } catch (e) {
    errors.push(`moving transfer bonuses off their routes — ${(e as Error).message}`);
  }

  return { applied, errors, catalog, aliases, onboarding, bonuses };
}
