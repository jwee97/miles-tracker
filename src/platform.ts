import type { Env } from './types';

/**
 * What Cloudflare itself says this app is costing.
 *
 * The Settings tab already reports what the database holds, counted from the
 * inside. This is the other half: Worker invocations, D1 queries and rows read,
 * as Cloudflare's own meters record them — the numbers a bill would be based
 * on, rather than an estimate made from row counts.
 *
 * It reads the GraphQL Analytics API with a token you create yourself. The
 * token is a secret and lives as one: it is never returned by any endpoint and
 * never stored in the settings table. Everything else — the account, the script
 * name, the database — is configuration, because none of it is sensitive and
 * all of it has to match what you deployed.
 */

const GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';
const FREE_WORKER_REQUESTS_PER_DAY = 100_000;
const FREE_D1_ROWS_READ_PER_DAY = 5_000_000;
const FREE_D1_ROWS_WRITTEN_PER_DAY = 100_000;
const FREE_D1_STORAGE_BYTES = 5 * 1024 * 1024 * 1024;

export interface DayPoint {
  date: string;
  requests: number;
  errors: number;
  subrequests: number;
}

export interface D1Day {
  date: string;
  read_queries: number;
  write_queries: number;
  rows_read: number;
  rows_written: number;
}

export interface PlatformReport {
  configured: boolean;
  /** What is missing, in the order you would fix it. Never names the token's value. */
  missing: string[];
  account_id: string | null;
  script: string | null;
  database_id: string | null;
  from: string;
  to: string;
  days: number;
  worker: {
    days: DayPoint[];
    requests: number;
    errors: number;
    subrequests: number;
    /** Null when the account's plan does not expose them. */
    cpu_p50_ms: number | null;
    cpu_p99_ms: number | null;
    error: string | null;
    /** True when daily figures were unavailable and only a total came back. */
    totals_only: boolean;
  };
  d1: {
    days: D1Day[];
    read_queries: number;
    write_queries: number;
    rows_read: number;
    rows_written: number;
    size_bytes: number | null;
    error: string | null;
  };
  free_tier: {
    worker_requests_per_day: number;
    d1_rows_read_per_day: number;
    d1_rows_written_per_day: number;
    d1_storage_bytes: number;
    /** Busiest single day as a share of the daily allowance, 0-100. */
    worker_peak_percent: number | null;
    d1_rows_read_peak_percent: number | null;
    d1_rows_written_peak_percent: number | null;
    storage_percent: number | null;
  };
}

/** A GraphQL call that reports Cloudflare's own error rather than swallowing it. */
async function cfGraph(
  env: Env,
  query: string,
  variables: Record<string, unknown>
): Promise<{ data: any; error: string | null }> {
  let res: Response;
  try {
    res = await fetch(GRAPHQL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    return { data: null, error: `could not reach Cloudflare (${(e as Error).message})` };
  }

  if (res.status === 401 || res.status === 403)
    return {
      data: null,
      error: `Cloudflare refused the token (${res.status}). It needs Account → Account Analytics → Read.`,
    };

  const body = (await res.json().catch(() => null)) as any;
  if (!body) return { data: null, error: `Cloudflare returned ${res.status} with no readable body` };

  // GraphQL reports failures in the body with a 200, so the status alone is
  // not enough. Its own wording is kept: it names the field it did not like.
  const errs: string[] = (body.errors ?? []).map((e: any) => e?.message).filter(Boolean);
  if (errs.length) return { data: null, error: errs.join('; ') };
  if (!body.data) return { data: null, error: 'Cloudflare returned no data' };
  return { data: body.data, error: null };
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const WORKER_DAILY = `query W($account: string!, $script: string!, $start: Time!, $end: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    workersInvocationsAdaptive(
      limit: 1000
      filter: { scriptName: $script, datetime_geq: $start, datetime_leq: $end }
      orderBy: [date_ASC]
    ) {
      sum { requests errors subrequests }
      quantiles { cpuTimeP50 cpuTimeP99 }
      dimensions { date }
    }
  }}}`;

// Not every account exposes a `date` dimension on this node — it is still
// marked beta — so there is a shape to fall back to that asks only for totals.
const WORKER_TOTAL = `query W($account: string!, $script: string!, $start: Time!, $end: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    workersInvocationsAdaptive(
      limit: 1
      filter: { scriptName: $script, datetime_geq: $start, datetime_leq: $end }
    ) {
      sum { requests errors subrequests }
      quantiles { cpuTimeP50 cpuTimeP99 }
    }
  }}}`;

const D1_DAILY = `query D($account: string!, $db: string!, $start: Date!, $end: Date!) {
  viewer { accounts(filter: { accountTag: $account }) {
    d1AnalyticsAdaptiveGroups(
      limit: 1000
      filter: { date_geq: $start, date_leq: $end, databaseId: $db }
      orderBy: [date_ASC]
    ) {
      sum { readQueries writeQueries rowsRead rowsWritten }
      dimensions { date }
    }
    d1StorageAdaptiveGroups(
      limit: 1
      filter: { date_geq: $start, date_leq: $end, databaseId: $db }
      orderBy: [date_DESC]
    ) {
      max { databaseSizeBytes }
    }
  }}}`;

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export async function platformReport(env: Env, days = 7): Promise<PlatformReport> {
  const span = Math.min(30, Math.max(1, Math.round(days)));
  const end = Date.now();
  const start = end - (span - 1) * 86_400_000;
  const from = isoDay(start);
  const to = isoDay(end);

  const account = (env.CF_ACCOUNT_ID ?? '').trim() || null;
  const script = (env.CF_SCRIPT_NAME ?? '').trim() || null;
  const database = (env.CF_DATABASE_ID ?? '').trim() || null;

  const missing: string[] = [];
  if (!(env.CF_API_TOKEN ?? '').trim()) missing.push('CF_API_TOKEN (a secret: wrangler secret put CF_API_TOKEN)');
  if (!account) missing.push('CF_ACCOUNT_ID');
  if (!script) missing.push('CF_SCRIPT_NAME');
  if (!database) missing.push('CF_DATABASE_ID');

  const blank: PlatformReport = {
    configured: missing.length === 0,
    missing,
    account_id: account,
    script,
    database_id: database,
    from,
    to,
    days: span,
    worker: { days: [], requests: 0, errors: 0, subrequests: 0, cpu_p50_ms: null, cpu_p99_ms: null, error: null, totals_only: false },
    d1: { days: [], read_queries: 0, write_queries: 0, rows_read: 0, rows_written: 0, size_bytes: null, error: null },
    free_tier: {
      worker_requests_per_day: FREE_WORKER_REQUESTS_PER_DAY,
      d1_rows_read_per_day: FREE_D1_ROWS_READ_PER_DAY,
      d1_rows_written_per_day: FREE_D1_ROWS_WRITTEN_PER_DAY,
      d1_storage_bytes: FREE_D1_STORAGE_BYTES,
      worker_peak_percent: null,
      d1_rows_read_peak_percent: null,
      d1_rows_written_peak_percent: null,
      storage_percent: null,
    },
  };
  if (missing.length) return blank;

  // --- the Worker ---------------------------------------------------------
  const vars = { account, script, start: `${from}T00:00:00Z`, end: `${to}T23:59:59Z` };
  let w = await cfGraph(env, WORKER_DAILY, vars);
  let totalsOnly = false;
  if (w.error && /date|dimension|field/i.test(w.error)) {
    // The daily breakdown is the nicety; the totals are the point.
    const fallback = await cfGraph(env, WORKER_TOTAL, vars);
    if (!fallback.error) {
      w = fallback;
      totalsOnly = true;
    }
  }

  if (w.error) {
    blank.worker.error = w.error;
  } else {
    const groups: any[] = w.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
    blank.worker.totals_only = totalsOnly;
    blank.worker.days = totalsOnly
      ? []
      : groups.map((g) => ({
          date: g.dimensions?.date ?? '',
          requests: num(g.sum?.requests),
          errors: num(g.sum?.errors),
          subrequests: num(g.sum?.subrequests),
        }));
    blank.worker.requests = groups.reduce((n, g) => n + num(g.sum?.requests), 0);
    blank.worker.errors = groups.reduce((n, g) => n + num(g.sum?.errors), 0);
    blank.worker.subrequests = groups.reduce((n, g) => n + num(g.sum?.subrequests), 0);
    // A percentile cannot be summed, so the worst day's is reported rather
    // than an average of percentiles, which would mean nothing.
    const p50 = groups.map((g) => g.quantiles?.cpuTimeP50).filter((x) => typeof x === 'number');
    const p99 = groups.map((g) => g.quantiles?.cpuTimeP99).filter((x) => typeof x === 'number');
    blank.worker.cpu_p50_ms = p50.length ? Math.max(...p50) : null;
    blank.worker.cpu_p99_ms = p99.length ? Math.max(...p99) : null;
  }

  // --- D1 -----------------------------------------------------------------
  const d = await cfGraph(env, D1_DAILY, { account, db: database, start: from, end: to });
  if (d.error) {
    blank.d1.error = d.error;
  } else {
    const acct = d.data?.viewer?.accounts?.[0] ?? {};
    const groups: any[] = acct.d1AnalyticsAdaptiveGroups ?? [];
    blank.d1.days = groups.map((g) => ({
      date: g.dimensions?.date ?? '',
      read_queries: num(g.sum?.readQueries),
      write_queries: num(g.sum?.writeQueries),
      rows_read: num(g.sum?.rowsRead),
      rows_written: num(g.sum?.rowsWritten),
    }));
    blank.d1.read_queries = blank.d1.days.reduce((n, g) => n + g.read_queries, 0);
    blank.d1.write_queries = blank.d1.days.reduce((n, g) => n + g.write_queries, 0);
    blank.d1.rows_read = blank.d1.days.reduce((n, g) => n + g.rows_read, 0);
    blank.d1.rows_written = blank.d1.days.reduce((n, g) => n + g.rows_written, 0);
    const size = acct.d1StorageAdaptiveGroups?.[0]?.max?.databaseSizeBytes;
    blank.d1.size_bytes = typeof size === 'number' ? size : null;
  }

  // The free tier is a DAILY allowance, so the busiest day is what matters —
  // an average across a quiet week would hide the day that ran out.
  const pct = (peak: number, cap: number) => (cap > 0 ? Math.min(100, (peak / cap) * 100) : null);
  const peak = (xs: number[]) => (xs.length ? Math.max(...xs) : null);

  const wPeak = peak(blank.worker.days.map((x) => x.requests));
  blank.free_tier.worker_peak_percent = wPeak === null ? null : pct(wPeak, FREE_WORKER_REQUESTS_PER_DAY);
  const rPeak = peak(blank.d1.days.map((x) => x.rows_read));
  blank.free_tier.d1_rows_read_peak_percent = rPeak === null ? null : pct(rPeak, FREE_D1_ROWS_READ_PER_DAY);
  const wrPeak = peak(blank.d1.days.map((x) => x.rows_written));
  blank.free_tier.d1_rows_written_peak_percent = wrPeak === null ? null : pct(wrPeak, FREE_D1_ROWS_WRITTEN_PER_DAY);
  blank.free_tier.storage_percent =
    blank.d1.size_bytes === null ? null : pct(blank.d1.size_bytes, FREE_D1_STORAGE_BYTES);

  return blank;
}
