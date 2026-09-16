import { platformReport } from '../src/platform';
import type { Env } from '../src/types';

let fails = 0;
const check = (l: string, c: boolean, d = '') => {
  if (!c) fails++;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : `  -- ${d}`}`);
};

const CONFIG = {
  CF_API_TOKEN: 'tok',
  CF_ACCOUNT_ID: 'acct',
  CF_SCRIPT_NAME: 'miles-tracker',
  CF_DATABASE_ID: 'db-uuid',
} as unknown as Env;

/** Stands in for Cloudflare. Records what was asked and answers what it is told. */
function cloudflare(reply: (query: string, vars: any) => { status?: number; body: unknown }) {
  const seen: { query: string; vars: any; auth: string | null }[] = [];
  globalThis.fetch = (async (input: any, init: any) => {
    const body = JSON.parse(init.body);
    seen.push({ query: body.query, vars: body.variables, auth: init.headers?.Authorization ?? null });
    const r = reply(body.query, body.variables);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  return seen;
}

// Cloudflare reports cpuTime in MICROSECONDS, which is the whole reason the
// old panel showed a nonsense "41ms" for what was really 41 microseconds.
const workerGroups = (days: [string, number, number][], dim = 'date') =>
  days.map(([date, requests, errors]) => ({
    sum: { requests, errors, subrequests: requests * 2 },
    quantiles: { cpuTimeP50: 3400, cpuTimeP99: 41_000 },
    dimensions: { [dim]: date },
  }));

const d1Groups = (days: [string, number, number][]) =>
  days.map(([date, rowsRead, rowsWritten]) => ({
    sum: { readQueries: 10, writeQueries: 2, rowsRead, rowsWritten, queryBatchResponseBytes: 500 },
    avg: { queryBatchTimeMs: 1.5 },
    quantiles: { queryBatchTimeMsP90: 4 },
    dimensions: { date },
  }));

const ok = (worker: unknown[], d1: unknown[], sizes: [string, number][] | null = [['2026-09-15', 12_000_000]]) => ({
  data: {
    viewer: {
      accounts: [
        {
          workersInvocationsAdaptive: worker,
          d1AnalyticsAdaptiveGroups: d1,
          d1StorageAdaptiveGroups: (sizes ?? []).map(([date, bytes]) => ({
            max: { databaseSizeBytes: bytes },
            dimensions: { date },
          })),
        },
      ],
    },
  },
});

// --- nothing configured ------------------------------------------------------
{
  const r = await platformReport({} as Env, 7);
  check('with nothing set it reports that, rather than failing', r.configured === false, JSON.stringify(r.missing));
  check('and names every missing piece', r.missing.length === 4, JSON.stringify(r.missing));
  check('the token is named as a secret, never a setting', /secret/.test(r.missing[0]), r.missing[0]);
  check('no numbers are invented', r.worker.requests === 0 && r.d1.rows_read === 0, '');
}

// --- the ordinary case -------------------------------------------------------
{
  const seen = cloudflare(() =>
    ({ body: ok(workerGroups([['2026-09-14', 120, 1], ['2026-09-15', 340, 0]]), d1Groups([['2026-09-14', 9000, 40], ['2026-09-15', 25000, 90]])) })
  );
  const r = await platformReport(CONFIG, 7);

  check('it says it is configured', r.configured && r.missing.length === 0, JSON.stringify(r.missing));
  check('the token is sent as a bearer', seen[0].auth === 'Bearer tok', String(seen[0].auth));
  check('and never comes back in the report', !JSON.stringify(r).includes('tok'), '');
  check('it asks about the right worker', seen[0].vars.script === 'miles-tracker', JSON.stringify(seen[0].vars));
  check('and the right database', seen.some((c) => c.vars.db === 'db-uuid'), JSON.stringify(seen.map((c) => c.vars)));

  check('worker requests are totalled', r.worker.requests === 460, String(r.worker.requests));
  check('so are errors', r.worker.errors === 1, String(r.worker.errors));
  check('the daily series is kept for the chart', r.worker.days.length === 2, String(r.worker.days.length));
  check('cpu time is converted from microseconds', r.worker.cpu_p99_ms === 41, String(r.worker.cpu_p99_ms));
  check('and the typical request is reported, not only the worst', r.worker.cpu_median_ms === 3.4, String(r.worker.cpu_median_ms));
  check('requests per day are averaged over the window', r.worker.per_day === Math.round(460 / 7), String(r.worker.per_day));
  check('the error rate is a share, not a count', Math.abs(r.worker.error_percent - (1 / 460) * 100) < 0.001, String(r.worker.error_percent));

  check('rows read are totalled', r.d1.rows_read === 34000, String(r.d1.rows_read));
  check('rows written too', r.d1.rows_written === 130, String(r.d1.rows_written));
  check('queries are separated by kind', r.d1.read_queries === 20 && r.d1.write_queries === 4, JSON.stringify([r.d1.read_queries, r.d1.write_queries]));
  check('the database size comes through', r.d1.size_bytes === 12_000_000, String(r.d1.size_bytes));
  check('rows per read query are worked out', r.d1.rows_per_read === 1700, String(r.d1.rows_per_read));
  check('batch latency is reported when the account has it', r.d1.latency_avg_ms === 1.5, String(r.d1.latency_avg_ms));
  check('and its 90th percentile', r.d1.latency_p90_ms === 4, String(r.d1.latency_p90_ms));
  check('response bytes are totalled', r.d1.response_bytes === 1000, String(r.d1.response_bytes));
  check('every shape tried is recorded', r.attempts.length > 0 && r.attempts.every((a) => typeof a.ok === 'boolean'), JSON.stringify(r.attempts));

  // The free tier is a DAILY allowance, so a busy day inside a quiet week is
  // the number that matters — an average would hide it.
  check('the free tier is measured against the busiest day', Math.abs(r.free_tier.worker_peak_percent! - 0.34) < 0.001, String(r.free_tier.worker_peak_percent));
  check('and not against the total', r.free_tier.worker_peak_percent! < 0.5, String(r.free_tier.worker_peak_percent));
  check('rows read use the busiest day too', Math.abs(r.free_tier.d1_rows_read_peak_percent! - 0.5) < 0.001, String(r.free_tier.d1_rows_read_peak_percent));
  check('storage is a share of the 5 GB', r.free_tier.storage_percent !== null && r.free_tier.storage_percent < 1, String(r.free_tier.storage_percent));
}

// --- Cloudflare says no ------------------------------------------------------
{
  cloudflare(() => ({ status: 403, body: { errors: [{ message: 'nope' }] } }));
  const r = await platformReport(CONFIG, 7);
  check('a refused token is reported in plain words', /refused the token/.test(r.worker.error ?? ''), String(r.worker.error));
  check('and says which permission to add', /Account Analytics/.test(r.worker.error ?? ''), String(r.worker.error));
  check('the panel still renders rather than throwing', r.configured === true && r.worker.requests === 0, '');
}

{
  // GraphQL reports failures in a 200 body, so the status alone is not enough.
  cloudflare(() => ({ status: 200, body: { errors: [{ message: 'unknown field "rowsRead"' }] } }));
  const r = await platformReport(CONFIG, 7);
  check("a 200 carrying errors is not read as success", r.d1.error === 'unknown field "rowsRead"', String(r.d1.error));
  check("and Cloudflare's own wording is kept", /rowsRead/.test(r.d1.error ?? ''), '');
}

// --- the shape Cloudflare will actually accept -------------------------------
{
  // `date` is not a dimension on workersInvocationsAdaptive — the documented
  // ones are datetime, scriptName and status — so the panel has to find a shape
  // that works rather than assume one. This is exactly why it showed nothing.
  const seen = cloudflare((q) => {
    const worker = /workersInvocationsAdaptive/.test(q);
    if (worker && /dimensions \{ date \}/.test(q))
      return { body: { errors: [{ message: 'Unknown field "date" on type "ZoneWorkersInvocationsAdaptiveDimensions"' }] } };
    if (worker && /dimensions \{ datetimeHour \}/.test(q))
      return { body: ok(workerGroups([['2026-09-15T00:00:00Z', 120, 0], ['2026-09-15T06:00:00Z', 80, 1]], 'datetimeHour'), []) };
    if (worker) return { body: ok([], []) };
    return { body: ok([], d1Groups([['2026-09-15', 10, 1]])) };
  });
  const r = await platformReport(CONFIG, 7);
  check('a rejected dimension is not the end of it', r.worker.requests === 200, String(r.worker.requests));
  check('the next shape is tried', seen.length >= 3, String(seen.length));
  check('hourly buckets are folded into days', r.worker.days.length === 1 && r.worker.days[0].date === '2026-09-15', JSON.stringify(r.worker.days));
  check('and the day adds up', r.worker.days[0]?.requests === 200, String(r.worker.days[0]?.requests));
  check('so the chart is still drawn', r.worker.totals_only === false, '');
  check('no error is reported once a shape worked', r.worker.error === null, String(r.worker.error));
  check('but the rejection is still recorded', r.attempts.some((a) => !a.ok && /Unknown field/.test(a.error ?? '')), JSON.stringify(r.attempts));
  check('D1 is unaffected by the worker probing', r.d1.rows_read === 10, String(r.d1.rows_read));
}

// --- when nothing is accepted ------------------------------------------------
{
  cloudflare(() => ({ body: { errors: [{ message: 'no such node' }] } }));
  const r = await platformReport(CONFIG, 7);
  check('every shape failing is reported once, not silently', /no such node/.test(r.worker.error ?? ''), String(r.worker.error));
  check('and every attempt is listed so it can be diagnosed', r.attempts.filter((a) => !a.ok).length >= 4, String(r.attempts.length));
}

// --- database growth ---------------------------------------------------------
{
  cloudflare(() => ({ body: ok([], d1Groups([['2026-09-15', 10, 1]]), [['2026-09-10', 9_000_000], ['2026-09-16', 12_000_000]]) }));
  const r = await platformReport(CONFIG, 7);
  check('the newest size is the one reported', r.d1.size_bytes === 12_000_000, String(r.d1.size_bytes));
  check('and growth across the window comes with it', r.d1.size_change_bytes === 3_000_000, String(r.d1.size_change_bytes));
}

// --- the window --------------------------------------------------------------
{
  const seen = cloudflare(() => ({ body: ok([], []) }));
  const r = await platformReport(CONFIG, 90);
  check('the window is capped at what Cloudflare retains', r.days === 30, String(r.days));
  check('and the dates asked for match it', seen[0].vars.start.startsWith(r.from), `${seen[0].vars.start} vs ${r.from}`);
  const one = await platformReport(CONFIG, 0);
  check('a nonsense window becomes one day, not zero', one.days === 1 && one.from === one.to, JSON.stringify([one.days, one.from, one.to]));
}

// --- the network is not there ------------------------------------------------
{
  globalThis.fetch = (async () => {
    throw new Error('connection reset');
  }) as typeof fetch;
  const r = await platformReport(CONFIG, 7);
  check('an unreachable Cloudflare is said plainly', /could not reach Cloudflare/.test(r.worker.error ?? ''), String(r.worker.error));
  check('and does not throw', r.configured === true, '');
}

console.log(fails ? `\n${fails} check(s) failed` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
