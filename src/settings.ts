import { feedStorage } from './rss';
import { today } from './spend';
import type { Env } from './types';

/**
 * Settings that can be changed at runtime from the dashboard. Secrets are
 * deliberately absent: they live in Cloudflare's encrypted store and are never
 * readable or writable through the app.
 */
export const EDITABLE = [
  {
    key: 'TZ_OFFSET_MINUTES',
    label: 'Timezone offset',
    unit: 'minutes east of UTC',
    help: 'Decides date boundaries — which statement cycle a purchase lands in. 480 = SGT. Does NOT move the cron times, which are UTC and set in wrangler.toml.',
    kind: 'number' as const,
  },
  {
    key: 'MILE_VALUE_CENTS',
    label: 'Value of a mile',
    unit: 'cents',
    help: 'The exchange rate that lets a cashback card and a miles card be compared. Set it to what you actually get on redemption — economy redemptions are worth well under 1.5.',
    kind: 'number' as const,
  },
  {
    key: 'OBJECTIVE',
    label: 'Optimise for',
    unit: 'miles · cashback · balanced · minspend',
    help: 'What the card recommendation ranks by. balanced compares everything in dollars; minspend puts a card with an unmet minimum first, which can be worth more than a better rate.',
    kind: 'text' as const,
  },
  {
    key: 'UTIL_THRESHOLDS',
    label: 'Utilization alerts',
    unit: 'percent, comma separated',
    help: 'Alert when a card crosses these shares of its limit.',
    kind: 'text' as const,
  },
  {
    key: 'MIN_SPEND_WARN_DAYS',
    label: 'Minimum-spend warning',
    unit: 'days before the deadline',
    help: 'Also the window inside which an unmet minimum outranks a better earn rate in /which.',
    kind: 'number' as const,
  },
  {
    key: 'POSTING_LAG_DAYS',
    label: 'Posting lag',
    unit: 'days',
    help: 'Unconfirmed spend this close to a window’s end is reported as at risk of posting into the next one.',
    kind: 'number' as const,
  },
  {
    key: 'FEED_RETENTION_DAYS',
    label: 'Keep scanned items in full',
    unit: 'days',
    help: 'After this, a judged item is compacted each night: its excerpt, matched terms and offer link are dropped, keeping the id that stops it being shown to you again. 0 disables the nightly compaction.',
    kind: 'number' as const,
  },
  {
    key: 'RATE_RECHECK_DAYS',
    label: 'Re-check transfer rates',
    unit: 'days',
    help: 'A route older than this is flagged in the daily rates check.',
    kind: 'number' as const,
  },
];

const KEYS = new Set(EDITABLE.map((e) => e.key));

/**
 * Overlays stored settings onto the environment. Called once at the top of a
 * request or cron, so everything downstream reads resolved values without
 * needing to know settings are overridable at all.
 */
export async function withSettings(env: Env): Promise<Env> {
  let rows: { k: string; v: string }[] = [];
  try {
    const r = await env.DB.prepare(`SELECT k, v FROM settings`).all<{ k: string; v: string }>();
    rows = r.results ?? [];
  } catch {
    return env; // settings table not created yet; the config defaults stand
  }
  const overrides: Record<string, string> = {};
  for (const row of rows) if (KEYS.has(row.k) && row.v != null && row.v !== '') overrides[row.k] = row.v;
  return Object.keys(overrides).length ? ({ ...env, ...overrides } as Env) : env;
}

export async function readSettings(env: Env) {
  const { results } = await env.DB.prepare(`SELECT k, v FROM settings`).all<{ k: string; v: string }>();
  const stored = new Map((results ?? []).map((r) => [r.k, r.v]));
  return EDITABLE.map((e) => ({
    ...e,
    // The deployed default, before any override.
    default_value: String((env as unknown as Record<string, string>)[e.key] ?? ''),
    stored_value: stored.get(e.key) ?? null,
    value: stored.get(e.key) ?? String((env as unknown as Record<string, string>)[e.key] ?? ''),
  }));
}

export async function writeSetting(env: Env, key: string, value: string | null): Promise<{ ok: boolean; error?: string }> {
  const spec = EDITABLE.find((e) => e.key === key);
  if (!spec) return { ok: false, error: `${key} is not editable here` };

  if (value === null || value === '') {
    await env.DB.prepare(`DELETE FROM settings WHERE k = ?`).bind(key).run();
    return { ok: true };
  }
  if (spec.kind === 'number' && !Number.isFinite(Number(value))) {
    return { ok: false, error: `${spec.label} must be a number` };
  }
  if (key === 'UTIL_THRESHOLDS' && !/^\s*\d{1,3}(\s*,\s*\d{1,3})*\s*$/.test(value)) {
    return { ok: false, error: 'Thresholds must be whole percentages, comma separated' };
  }
  if (key === 'OBJECTIVE' && !['miles', 'cashback', 'balanced', 'minspend'].includes(value.trim())) {
    return { ok: false, error: 'Objective must be miles, cashback, balanced or minspend' };
  }
  if (key === 'TZ_OFFSET_MINUTES' && Math.abs(Number(value)) > 900) {
    return { ok: false, error: 'Offset must be within ±900 minutes' };
  }

  await env.DB.prepare(
    `INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`
  )
    .bind(key, value.trim())
    .run();
  return { ok: true };
}

// ---------------------------------------------------------------------------

export interface Usage {
  db: {
    /** Bytes, when SQLite will report it; null when D1 refuses the pragma. */
    size_bytes: number | null;
    size_source: 'pragma' | 'estimated' | 'unavailable';
    limit_bytes: number;
    percent: number | null;
    rows: { table: string; count: number }[];
    total_rows: number;
  };
  storage: {
    /** Text bytes per table, for the two that actually grow. */
    feed_items: { rows: number; text_bytes: number; reclaimable_bytes: number; compactable: number; retention_days: number };
    transactions: { rows: number; text_bytes: number; bytes_per_row: number; oldest: string | null };
    /** Years of transactions at the current rate before 1% of the allowance. */
    transactions_years_to_1pct: number | null;
  };
  free_tier: { label: string; limit: string; note: string }[];
  worker: { available: boolean; note: string; requests_today?: number; cpu_ms_median?: number };
}

const TABLES = [
  'transactions',
  'cards',
  'requirements',
  'earn_rules',
  'offers',
  'offer_rules',
  'feeds',
  'feed_items',
  'balance_tranches',
  'programs',
  'conversions',
  'transfers',
  'merchant_categories',
  'alerts_sent',
];

/** D1's free allowance is 5 GB. */
const D1_LIMIT = 5 * 1024 * 1024 * 1024;

export async function readUsage(env: Env): Promise<Usage> {
  const rows: { table: string; count: number }[] = [];
  let totalRows = 0;
  for (const t of TABLES) {
    try {
      const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>();
      const n = r?.n ?? 0;
      rows.push({ table: t, count: n });
      totalRows += n;
    } catch {
      // Table not created yet; skip rather than fail the whole page.
    }
  }

  // D1 may or may not allow these pragmas. Try, and fall back to an estimate
  // rather than showing nothing — a rough number you can watch beats none.
  let sizeBytes: number | null = null;
  let source: Usage['db']['size_source'] = 'unavailable';
  try {
    const pc = await env.DB.prepare(`PRAGMA page_count`).first<Record<string, number>>();
    const ps = await env.DB.prepare(`PRAGMA page_size`).first<Record<string, number>>();
    const pages = pc ? Object.values(pc)[0] : null;
    const pageSize = ps ? Object.values(ps)[0] : null;
    if (typeof pages === 'number' && typeof pageSize === 'number') {
      sizeBytes = pages * pageSize;
      source = 'pragma';
    }
  } catch {
    /* fall through to the estimate */
  }
  if (sizeBytes === null && totalRows > 0) {
    // ~200 bytes per row is the right order of magnitude for these tables.
    sizeBytes = totalRows * 200;
    source = 'estimated';
  }

  // Where the space actually goes. Only two tables grow without bound, and
  // they grow at wildly different rates, so both are measured rather than
  // guessed at: a scanned article carries an excerpt, a transaction does not.
  const feed = await feedStorage(env);
  const tx = await env.DB.prepare(
    `SELECT COUNT(*) AS n,
            SUM(LENGTH(COALESCE(merchant,'')) + LENGTH(COALESCE(category,'')) + LENGTH(COALESCE(category_source,''))
                + LENGTH(COALESCE(occurred_at,'')) + LENGTH(COALESCE(posted_at,'')) + LENGTH(COALESCE(mcc,''))
                + LENGTH(COALESCE(channel,'')) + LENGTH(COALESCE(reward_note,'')) + LENGTH(COALESCE(source,''))
                + 40) AS bytes,
            MIN(COALESCE(posted_at, occurred_at)) AS oldest
     FROM transactions`
  ).first<any>();

  const txRows = tx?.n ?? 0;
  const txBytes = tx?.bytes ?? 0;
  const perRow = txRows ? Math.round(txBytes / txRows) : 0;

  // How long before transactions alone reach 1% of the 5 GB allowance, at the
  // rate this database is actually filling up.
  let yearsTo1pct: number | null = null;
  if (txRows > 20 && tx?.oldest && perRow > 0) {
    const days = Math.max(1, (Date.parse(today(env)) - Date.parse(tx.oldest)) / 86_400_000);
    const perYear = (txRows / days) * 365 * perRow;
    if (perYear > 0) yearsTo1pct = (D1_LIMIT * 0.01) / perYear;
  }

  return {
    storage: {
      feed_items: {
        rows: feed.total,
        text_bytes: feed.text_bytes,
        reclaimable_bytes: feed.reclaimable_bytes,
        compactable: feed.compactable,
        retention_days: feed.retention_days,
      },
      transactions: { rows: txRows, text_bytes: txBytes, bytes_per_row: perRow, oldest: tx?.oldest ?? null },
      transactions_years_to_1pct: yearsTo1pct,
    },
    db: {
      size_bytes: sizeBytes,
      size_source: source,
      limit_bytes: D1_LIMIT,
      percent: sizeBytes === null ? null : (sizeBytes / D1_LIMIT) * 100,
      rows: rows.sort((a, b) => b.count - a.count),
      total_rows: totalRows,
    },
    free_tier: [
      { label: 'Worker requests', limit: '100,000 / day', note: 'A busy day here is a few hundred.' },
      { label: 'Worker CPU', limit: '10 ms / invocation', note: 'These handlers run in single-digit milliseconds.' },
      { label: 'D1 rows read', limit: '5,000,000 / day', note: 'The analytics tab is the heaviest reader.' },
      { label: 'D1 rows written', limit: '100,000 / day', note: 'A few dozen on a normal day.' },
      { label: 'D1 storage', limit: '5 GB', note: 'Shown above.' },
      { label: 'Static assets', limit: 'unlimited', note: 'The dashboard itself.' },
    ],
    worker: {
      available: false,
      note: 'Per-request counts and CPU time come from Cloudflare’s analytics API, which needs an account ID and a read-only API token. Without them this page shows what the database can measure about itself. See Workers & Pages → miles-tracker → Metrics in the dashboard for the real figures.',
    },
  };
}
