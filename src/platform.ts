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
  response_bytes: number;
}

/** One SQL statement and what it cost, as D1 recorded it. */
export interface HeavyQuery {
  /** The SQL, with bound parameters already stripped by D1. */
  sql: string;
  runs: number;
  rows_read: number;
  rows_written: number;
  /** Rows read per run — a big number here means a scan, not a lookup. */
  rows_per_run: number;
  duration_ms: number | null;
  /** This query's share of all rows read in the window, 0-100. */
  share_percent: number;
}

/** An exception the Worker actually threw, as Workers Logs recorded it. */
export interface WorkerError {
  message: string;
  count: number;
  last_seen: string | null;
}

/** One query shape tried, and what Cloudflare said to it. */
export interface Attempt {
  query: string;
  ok: boolean;
  error: string | null;
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
  /** Every query shape tried, so an empty panel can be explained. */
  attempts: Attempt[];
  worker: {
    days: DayPoint[];
    requests: number;
    errors: number;
    subrequests: number;
    /** Errors as a share of requests, 0-100. */
    error_percent: number;
    /** Requests broken down by outcome, when the account reports it. */
    by_status: { status: string; requests: number }[];
    /**
     * CPU time per invocation. Cloudflare reports these in MICROSECONDS; they
     * are converted once, here, so nothing downstream has to remember.
     * The median is the typical request; p99 is the slowest one in a hundred.
     */
    cpu_median_ms: number | null;
    cpu_p99_ms: number | null;
    /** Requests per day, averaged over the window. */
    per_day: number;
    error: string | null;
    totals_only: boolean;
    /** What the exceptions actually were, when Workers Logs is on. */
    errors_seen: WorkerError[];
    errors_error: string | null;
  };
  d1: {
    days: D1Day[];
    read_queries: number;
    write_queries: number;
    rows_read: number;
    rows_written: number;
    response_bytes: number;
    /** Rows read per read query — the number that says whether a query scans. */
    rows_per_read: number | null;
    /** Batch latency, when the account reports it. */
    latency_avg_ms: number | null;
    latency_p90_ms: number | null;
    size_bytes: number | null;
    /** How the database has grown across the window, when there is a series. */
    size_change_bytes: number | null;
    /** The statements doing the most work, heaviest first. */
    heavy: HeavyQuery[];
    heavy_error: string | null;
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

/**
 * Recent exceptions, grouped by message.
 *
 * A different API from everything else here — Workers Logs is REST, not
 * GraphQL — and it returns nothing at all unless `[observability] enabled` is
 * set on the Worker, which is the likeliest reason for an empty list. Failures
 * are returned rather than thrown: one panel going quiet must not take the
 * numbers beside it down.
 */
async function readWorkerErrors(
  env: Env,
  account: string,
  script: string,
  from: number,
  to: number,
  out: WorkerError[],
  log: Attempt[]
): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/workers/observability/telemetry/query`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          queryId: 'miles-tracker-errors',
          timeframe: { from, to },
          limit: 50,
          parameters: {
            datasets: [],
            filters: [
              { key: '$metadata.service', operation: 'eq', type: 'string', value: script },
              { key: '$metadata.error', operation: 'exists', type: 'string' },
            ],
            calculations: [{ operator: 'count' }],
            groupBys: [{ type: 'string', value: '$metadata.error' }],
          },
          view: 'calculations',
        }),
        signal: AbortSignal.timeout(20_000),
      }
    );
  } catch (e) {
    log.push({ query: 'worker errors', ok: false, error: (e as Error).message });
    return `could not reach Workers Logs (${(e as Error).message})`;
  }

  const body = (await res.json().catch(() => null)) as any;
  if (!res.ok || body?.success === false) {
    const why =
      (body?.errors ?? []).map((e: any) => e?.message).filter(Boolean).join('; ') || `Cloudflare returned ${res.status}`;
    log.push({ query: 'worker errors', ok: false, error: why });
    return why;
  }
  log.push({ query: 'worker errors', ok: true, error: null });

  // The response shape varies with `view`, so several plausible places are
  // checked rather than one assumed.
  const groups: any[] =
    body?.result?.calculations?.[0]?.aggregates ??
    body?.result?.calculations?.[0]?.data ??
    body?.result?.events?.events ??
    [];
  for (const g of groups) {
    const message = String(g?.groups?.[0]?.value ?? g?.$metadata?.error ?? g?.message ?? '').trim();
    if (!message) continue;
    const found = out.find((x) => x.message === message);
    if (found) found.count += Number(g?.value ?? g?.count ?? 1) || 1;
    else
      out.push({
        message: message.slice(0, 300),
        count: Number(g?.value ?? g?.count ?? 1) || 1,
        last_seen: g?.timestamp ? new Date(Number(g.timestamp)).toISOString().slice(0, 16).replace('T', ' ') : null,
      });
  }
  out.sort((a, b) => b.count - a.count);
  return out.length ? null : 'nothing recorded — Workers Logs needs [observability] enabled in wrangler.toml, and keeps three days';
}

/**
 * Cloudflare's GraphQL is not one schema but many, and which fields a node
 * offers varies by dataset and by plan. Rather than assume, each family of
 * numbers is asked for in descending order of confidence and the first shape
 * that is accepted wins. What was tried, and what Cloudflare said to each, is
 * reported: a panel that silently shows nothing is the one thing worse than an
 * error message.
 *
 * Note the variable types. They are lowercase `string`, which is what
 * Cloudflare's own examples use — declaring `Time!` gets the whole document
 * rejected before a single field is read.
 */
interface Shape {
  label: string;
  query: string;
  /** Pulls the groups out of a successful response. */
  pick: (data: any) => any[];
  /** How a group's date comes out, when it has one. */
  day?: (g: any) => string;
}

const workerShape = (dim: string | null, label: string): Shape => ({
  label,
  query: `query W($account: string, $script: string, $start: string, $end: string) {
  viewer { accounts(filter: { accountTag: $account }) {
    workersInvocationsAdaptive(
      limit: 10000
      filter: { scriptName: $script, datetime_geq: $start, datetime_leq: $end }
    ) {
      sum { requests errors subrequests }
      quantiles { cpuTimeP50 cpuTimeP99 }
      ${dim ? `dimensions { ${dim} }` : ''}
    }
  }}}`,
  pick: (d) => d?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [],
  day: dim ? (g) => String(g?.dimensions?.[dim] ?? '').slice(0, 10) : undefined,
});

/**
 * The day breakdown, in the order most likely to be accepted.
 *
 * `date` is not a dimension on this node — the documented ones are datetime,
 * scriptName and status — but accounts differ, so it is still tried first and
 * costs one rejected request when it is not there. `datetimeHour` buckets to
 * the hour, which folds into days here; bare `datetime` is finest and last.
 */
const WORKER_SHAPES: Shape[] = [
  workerShape('date', 'by day'),
  workerShape('datetimeHour', 'by hour'),
  workerShape('datetime', 'by datetime'),
  workerShape(null, 'totals only'),
];

/** Success and error counts split by outcome, which is its own useful number. */
const WORKER_STATUS: Shape = {
  label: 'by status',
  query: `query S($account: string, $script: string, $start: string, $end: string) {
  viewer { accounts(filter: { accountTag: $account }) {
    workersInvocationsAdaptive(
      limit: 100
      filter: { scriptName: $script, datetime_geq: $start, datetime_leq: $end }
    ) {
      sum { requests }
      dimensions { status }
    }
  }}}`,
  pick: (d) => d?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [],
};

const d1Shape = (extra: boolean): Shape => ({
  label: extra ? 'with latency' : 'queries and rows',
  query: `query D($account: string, $db: string, $start: Date, $end: Date) {
  viewer { accounts(filter: { accountTag: $account }) {
    d1AnalyticsAdaptiveGroups(
      limit: 10000
      filter: { date_geq: $start, date_leq: $end, databaseId: $db }
      orderBy: [date_ASC]
    ) {
      sum { readQueries writeQueries rowsRead rowsWritten${extra ? ' queryBatchResponseBytes' : ''} }
      ${extra ? 'avg { queryBatchTimeMs }\n      quantiles { queryBatchTimeMsP90 }' : ''}
      dimensions { date }
    }
  }}}`,
  pick: (d) => d?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups ?? [],
  day: (g) => String(g?.dimensions?.date ?? '').slice(0, 10),
});

const D1_SHAPES: Shape[] = [d1Shape(true), d1Shape(false)];

/**
 * The queries doing the work, by rows touched.
 *
 * Rows read is where a free tier is actually spent, and it is never spread
 * evenly: one query with a missing index reads more in a week than everything
 * else put together. D1 keeps the SQL text (without bound parameters, so
 * nothing sensitive is in it), which makes the answer nameable rather than a
 * shrug about the total.
 *
 * The exact field names on this node are not in the published docs — wrangler
 * reads it through its own client — so three shapes are tried, richest first.
 */
const d1QueryShape = (fields: string, label: string): Shape => ({
  label: `intensive queries, ${label}`,
  query: `query Q($account: string, $db: string, $start: Date, $end: Date) {
  viewer { accounts(filter: { accountTag: $account }) {
    d1QueriesAdaptiveGroups(
      limit: 20
      filter: { date_geq: $start, date_leq: $end, databaseId: $db }
    ) {
      ${fields}
      dimensions { query }
    }
  }}}`,
  pick: (d) => d?.viewer?.accounts?.[0]?.d1QueriesAdaptiveGroups ?? [],
});

const D1_QUERY_SHAPES: Shape[] = [
  d1QueryShape('count\n      sum { rowsRead rowsWritten queryDurationMs }\n      avg { rowsRead rowsWritten queryDurationMs }', 'with timings'),
  d1QueryShape('count\n      sum { rowsRead rowsWritten }\n      avg { rowsRead rowsWritten }', 'rows only'),
  d1QueryShape('count\n      sum { rowsRead rowsWritten }', 'totals only'),
];

const D1_STORAGE: Shape = {
  label: 'storage',
  query: `query DS($account: string, $db: string, $start: Date, $end: Date) {
  viewer { accounts(filter: { accountTag: $account }) {
    d1StorageAdaptiveGroups(
      limit: 100
      filter: { date_geq: $start, date_leq: $end, databaseId: $db }
      orderBy: [date_DESC]
    ) {
      max { databaseSizeBytes }
      dimensions { date }
    }
  }}}`,
  pick: (d) => d?.viewer?.accounts?.[0]?.d1StorageAdaptiveGroups ?? [],
};

/** Walks the shapes until one is accepted, recording every attempt. */
async function firstThatWorks(
  env: Env,
  shapes: Shape[],
  vars: Record<string, unknown>,
  log: Attempt[]
): Promise<{ shape: Shape; groups: any[] } | null> {
  for (const shape of shapes) {
    const r = await cfGraph(env, shape.query, vars);
    log.push({ query: shape.label, ok: r.error === null, error: r.error });
    if (!r.error) return { shape, groups: shape.pick(r.data) };
  }
  return null;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Microseconds to milliseconds, which is what the figure is readable in. */
const usToMs = (us: unknown) => (typeof us === 'number' && Number.isFinite(us) ? Math.round(us / 10) / 100 : null);

/** Folds groups of any granularity into one row per calendar day. */
function byDay<T extends Record<string, number>>(
  groups: any[],
  day: (g: any) => string,
  fields: { [K in keyof T]: (g: any) => number }
): (T & { date: string })[] {
  const out = new Map<string, T & { date: string }>();
  for (const g of groups) {
    const date = day(g);
    if (!date) continue;
    const row = out.get(date) ?? ({ date, ...Object.fromEntries(Object.keys(fields).map((k) => [k, 0])) } as T & { date: string });
    for (const k of Object.keys(fields) as (keyof T)[]) {
      (row as any)[k] += fields[k](g);
    }
    out.set(date, row);
  }
  return [...out.values()].sort((a, b) => a.date.localeCompare(b.date));
}

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

  const attempts: Attempt[] = [];
  const blank: PlatformReport = {
    configured: missing.length === 0,
    missing,
    account_id: account,
    script,
    database_id: database,
    from,
    to,
    days: span,
    attempts,
    worker: {
      days: [],
      requests: 0,
      errors: 0,
      subrequests: 0,
      error_percent: 0,
      by_status: [],
      cpu_median_ms: null,
      cpu_p99_ms: null,
      per_day: 0,
      error: null,
      totals_only: false,
      errors_seen: [],
      errors_error: null,
    },
    d1: {
      days: [],
      read_queries: 0,
      write_queries: 0,
      rows_read: 0,
      rows_written: 0,
      response_bytes: 0,
      rows_per_read: null,
      latency_avg_ms: null,
      latency_p90_ms: null,
      size_bytes: null,
      size_change_bytes: null,
      heavy: [],
      heavy_error: null,
      error: null,
    },
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
  const wVars = { account, script, start: `${from}T00:00:00Z`, end: `${to}T23:59:59Z` };
  const w = await firstThatWorks(env, WORKER_SHAPES, wVars, attempts);

  if (!w) {
    blank.worker.error = attempts.filter((a) => !a.ok).pop()?.error ?? 'Cloudflare accepted none of the query shapes';
  } else {
    const g = w.groups;
    blank.worker.totals_only = !w.shape.day;
    blank.worker.requests = g.reduce((n, x) => n + num(x.sum?.requests), 0);
    blank.worker.errors = g.reduce((n, x) => n + num(x.sum?.errors), 0);
    blank.worker.subrequests = g.reduce((n, x) => n + num(x.sum?.subrequests), 0);
    blank.worker.error_percent = blank.worker.requests ? (blank.worker.errors / blank.worker.requests) * 100 : 0;
    blank.worker.per_day = Math.round(blank.worker.requests / span);

    if (w.shape.day) {
      blank.worker.days = byDay<Omit<DayPoint, 'date'>>(g, w.shape.day, {
        requests: (x: any) => num(x.sum?.requests),
        errors: (x: any) => num(x.sum?.errors),
        subrequests: (x: any) => num(x.sum?.subrequests),
      });
    }

    // A percentile cannot be summed or averaged into another percentile, so the
    // highest group's is reported and labelled for what it is.
    const q = (k: string) => {
      const xs = g.map((x) => x.quantiles?.[k]).filter((x) => typeof x === 'number');
      return xs.length ? Math.max(...xs) : null;
    };
    blank.worker.cpu_median_ms = usToMs(q('cpuTimeP50'));
    blank.worker.cpu_p99_ms = usToMs(q('cpuTimeP99'));

    // Outcomes, which say whether the errors are yours or the platform's.
    const st = await cfGraph(env, WORKER_STATUS.query, wVars);
    attempts.push({ query: WORKER_STATUS.label, ok: st.error === null, error: st.error });
    if (!st.error) {
      const rows = WORKER_STATUS.pick(st.data);
      const tally = new Map<string, number>();
      for (const r of rows) {
        const key = String(r?.dimensions?.status ?? 'unknown');
        tally.set(key, (tally.get(key) ?? 0) + num(r.sum?.requests));
      }
      blank.worker.by_status = [...tally].map(([status, requests]) => ({ status, requests })).sort((a, b) => b.requests - a.requests);
    }
  }

  // --- what the exceptions actually were ----------------------------------
  //
  // The counts above say 17 exceptions; they cannot say which line threw. That
  // lives in Workers Logs, behind its own permission and its own API, and only
  // when [observability] is enabled on the Worker — so a blank here is a real
  // state with a real cause, and it is reported rather than left empty.
  blank.worker.errors_error = await readWorkerErrors(env, account!, script!, start, end, blank.worker.errors_seen, attempts);

  // --- D1 -----------------------------------------------------------------
  const dVars = { account, db: database, start: from, end: to };
  const d = await firstThatWorks(env, D1_SHAPES, dVars, attempts);

  if (!d) {
    blank.d1.error = attempts.filter((a) => !a.ok).pop()?.error ?? 'Cloudflare accepted none of the query shapes';
  } else {
    const g = d.groups;
    blank.d1.days = byDay<Omit<D1Day, 'date'>>(g, d.shape.day!, {
      read_queries: (x: any) => num(x.sum?.readQueries),
      write_queries: (x: any) => num(x.sum?.writeQueries),
      rows_read: (x: any) => num(x.sum?.rowsRead),
      rows_written: (x: any) => num(x.sum?.rowsWritten),
      response_bytes: (x: any) => num(x.sum?.queryBatchResponseBytes),
    });
    blank.d1.read_queries = blank.d1.days.reduce((n, x) => n + x.read_queries, 0);
    blank.d1.write_queries = blank.d1.days.reduce((n, x) => n + x.write_queries, 0);
    blank.d1.rows_read = blank.d1.days.reduce((n, x) => n + x.rows_read, 0);
    blank.d1.rows_written = blank.d1.days.reduce((n, x) => n + x.rows_written, 0);
    blank.d1.response_bytes = blank.d1.days.reduce((n, x) => n + x.response_bytes, 0);

    // Rows read per read query: the number that says whether a query is
    // finding its rows by index or scanning the table to get to them.
    blank.d1.rows_per_read = blank.d1.read_queries
      ? Math.round((blank.d1.rows_read / blank.d1.read_queries) * 10) / 10
      : null;

    const avgs = g.map((x) => x.avg?.queryBatchTimeMs).filter((x) => typeof x === 'number');
    blank.d1.latency_avg_ms = avgs.length ? Math.round((avgs.reduce((a, b) => a + b, 0) / avgs.length) * 100) / 100 : null;
    const p90 = g.map((x) => x.quantiles?.queryBatchTimeMsP90).filter((x) => typeof x === 'number');
    blank.d1.latency_p90_ms = p90.length ? Math.round(Math.max(...p90) * 100) / 100 : null;
  }

  // Which statements are doing the work. Rows read is where a free tier is
  // actually spent, and it is never spread evenly.
  const heavy = await firstThatWorks(env, D1_QUERY_SHAPES, dVars, attempts);
  if (!heavy) {
    blank.d1.heavy_error = attempts.filter((a) => !a.ok).pop()?.error ?? null;
  } else {
    const rows = heavy.groups
      .map((g) => {
        const runs = num(g.count);
        const read = num(g.sum?.rowsRead);
        return {
          sql: String(g.dimensions?.query ?? '').replace(/\s+/g, ' ').trim(),
          runs,
          rows_read: read,
          rows_written: num(g.sum?.rowsWritten),
          rows_per_run: runs ? Math.round(read / runs) : read,
          duration_ms:
            typeof g.sum?.queryDurationMs === 'number' ? Math.round(g.sum.queryDurationMs) : null,
          share_percent: 0,
        };
      })
      .filter((r) => r.sql);

    // Share of the window's total, so "142,000 rows" becomes "22% of everything
    // this database read" — which is the sentence that decides whether to care.
    const total = blank.d1.rows_read || rows.reduce((n, r) => n + r.rows_read, 0);
    for (const r of rows) r.share_percent = total ? (r.rows_read / total) * 100 : 0;
    blank.d1.heavy = rows.sort((a, b) => b.rows_read - a.rows_read).slice(0, 10);
  }

  const storage = await cfGraph(env, D1_STORAGE.query, dVars);
  attempts.push({ query: D1_STORAGE.label, ok: storage.error === null, error: storage.error });
  if (!storage.error) {
    const rows = D1_STORAGE.pick(storage.data);
    const sizes = rows
      .map((r: any) => ({ date: String(r?.dimensions?.date ?? ''), bytes: r?.max?.databaseSizeBytes }))
      .filter((r: any) => typeof r.bytes === 'number')
      .sort((a: any, b: any) => a.date.localeCompare(b.date));
    if (sizes.length) {
      blank.d1.size_bytes = sizes[sizes.length - 1].bytes;
      // Growth across the window is the number that answers "is this a problem
      // later" — a single size never does.
      if (sizes.length > 1) blank.d1.size_change_bytes = sizes[sizes.length - 1].bytes - sizes[0].bytes;
    }
  } else if (!blank.d1.error) {
    blank.d1.error = storage.error;
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
