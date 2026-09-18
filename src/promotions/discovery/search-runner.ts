import { canonicalUrl } from '../../rss';
import { today } from '../../spend';
import type { Env } from '../../types';
import { classify, shouldExtract } from './classify';
import { trustTierForUrl } from './domains';
import { recordDiscoveryItem } from './run';
import { plannedQueries, type QueryKind, type SearchQuery } from './search';
import { searchProvider, SearchProviderError, type SearchProvider } from './search-provider';
import type { DiscoverySource, ScanFrequency } from './sources';

/**
 * Searching the web, for real.
 *
 * What was here before generated queries, counted them, recorded a successful
 * scan and returned. "Search discovery is healthy" therefore meant "queries
 * were generated" — never "the web was searched" — and nothing in the system
 * could tell the difference. Every number this module returns exists to make
 * that confusion impossible: queries planned and queries executed are separate
 * counts, and `configured` is separate from `ok`.
 *
 * Three states that used to be one:
 *
 *   configured: false        no API key. Nothing was searched.
 *   ok: false                the provider refused. Nothing was learned.
 *   ok: true, results: 0     the web was searched and had nothing new.
 */

export interface SearchScanResult {
  ok: boolean;
  configured: boolean;
  provider: string | null;
  queries_planned: number;
  queries_executed: number;
  results_seen: number;
  urls_new: number;
  relevant_new: number;
  note: string;
  error_code?: string;
}

/** How many searches a day may cost, before anything is run. */
export const DEFAULT_DAILY_QUERY_BUDGET = 15;

export function dailyBudget(env: Env): number {
  const raw = Number(env.MAX_SEARCH_QUERIES_PER_DAY);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_DAILY_QUERY_BUDGET;
}

/**
 * How long before the same question is worth asking again.
 *
 * A broad monthly roundup query is worth repeating daily near a month
 * boundary; "DBS Altitude welcome offer" is not going to answer differently
 * within a week. Without this the budget is spent re-asking yesterday's
 * questions and the interesting ones never run.
 */
export const COOLDOWN_HOURS: Record<QueryKind, number> = {
  broad: 24,
  series: 24,
  issuer: 72,
  product: 24 * 7,
  programme: 24 * 7,
  official: 24 * 3,
};

/** Queries already run today, against the daily budget. */
export async function spentToday(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM discovery_search_runs WHERE substr(searched_at, 1, 10) = ?`
  )
    .bind(today(env))
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** When this exact query was last asked, if ever. */
async function lastAsked(env: Env, query: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT searched_at FROM discovery_search_runs WHERE query = ? ORDER BY id DESC LIMIT 1`
  )
    .bind(query)
    .first<{ searched_at: string }>();
  return row?.searched_at ?? null;
}

export function isCool(kind: QueryKind, lastAt: string | null, now: number): boolean {
  if (!lastAt) return true;
  const then = Date.parse(lastAt);
  if (!Number.isFinite(then)) return true;
  return now - then >= (COOLDOWN_HOURS[kind] ?? 24) * 3_600_000;
}

/**
 * Which queries this cadence is allowed to ask.
 *
 * The previous implementation always asked for the daily set, so the card and
 * programme queries the generator can produce were never reached. Depth now
 * follows the source's own cadence, and `monthly` gets the weekly scope
 * because it runs rarely enough to be worth a full sweep when it does.
 */
export function queryKindFor(frequency: ScanFrequency): 'daily' | 'every3days' | 'weekly' {
  if (frequency === 'daily') return 'daily';
  if (frequency === 'every3days') return 'every3days';
  return 'weekly';
}

/**
 * Run the search source.
 *
 * Every query executed is written to `discovery_search_runs` before its results
 * are ingested, so "did search actually run?" is a table lookup rather than an
 * inference. A stub cannot fake this table.
 */
export async function scanSearchSource(
  env: Env,
  source: DiscoverySource,
  opts: { fetchImpl?: typeof fetch; queryKind?: 'daily' | 'every3days' | 'weekly'; provider?: SearchProvider | null } = {}
): Promise<SearchScanResult> {
  const kind = opts.queryKind ?? queryKindFor(source.scan_frequency);
  const plan = await plannedQueries(env, kind);

  const provider = opts.provider !== undefined ? opts.provider : searchProvider(env, opts.fetchImpl ?? fetch);
  if (!provider) {
    return {
      ok: false,
      configured: false,
      provider: null,
      queries_planned: plan.queries.length,
      queries_executed: 0,
      results_seen: 0,
      urls_new: 0,
      relevant_new: 0,
      note: 'Search provider not configured. SEARCH_PROVIDER and SEARCH_API_KEY are required.',
      error_code: 'SEARCH_NOT_CONFIGURED',
    };
  }

  const spent = await spentToday(env);
  const remaining = Math.max(0, dailyBudget(env) - spent);
  if (remaining === 0) {
    return {
      ok: true,
      configured: true,
      provider: provider.name,
      queries_planned: plan.queries.length,
      queries_executed: 0,
      results_seen: 0,
      urls_new: 0,
      relevant_new: 0,
      note: `The daily budget of ${dailyBudget(env)} searches is already spent.`,
    };
  }

  const now = Date.now();
  const runnable: SearchQuery[] = [];
  for (const q of plan.queries) {
    if (runnable.length >= Math.min(plan.budget.limit, remaining)) break;
    if (!isCool(q.kind, await lastAsked(env, q.query), now)) continue;
    runnable.push(q);
  }

  if (!runnable.length) {
    return {
      ok: true,
      configured: true,
      provider: provider.name,
      queries_planned: plan.queries.length,
      queries_executed: 0,
      results_seen: 0,
      urls_new: 0,
      relevant_new: 0,
      note: 'Every planned query was asked recently enough that re-asking it would buy nothing.',
    };
  }

  let executed = 0;
  let seen = 0;
  let urlsNew = 0;
  let relevantNew = 0;
  let failure: SearchProviderError | null = null;

  for (const q of runnable) {
    let response;
    try {
      response = await provider.search(q.query, { limit: 10 });
      executed++;
    } catch (e) {
      failure = e instanceof SearchProviderError ? e : new SearchProviderError('SEARCH_PROVIDER_ERROR', (e as Error).message);
      await recordSearchRun(env, source, provider.name, q, 0, 0, failure.message);
      // Rate limiting means stop, not slow down. Anything else might be one
      // bad query, so the rest of the plan still runs.
      if (failure.code === 'SEARCH_RATE_LIMITED') break;
      continue;
    }

    const ingested = await ingestResults(env, source, response.results, q.query);
    seen += response.results.length;
    urlsNew += ingested.urls_new;
    relevantNew += ingested.relevant_new;
    await recordSearchRun(env, source, provider.name, q, response.results.length, ingested.urls_new, null);
  }

  const rateLimited = failure?.code === 'SEARCH_RATE_LIMITED';
  const ok = executed > 0 && !rateLimited;

  return {
    ok,
    configured: true,
    provider: provider.name,
    queries_planned: plan.queries.length,
    queries_executed: executed,
    results_seen: seen,
    urls_new: urlsNew,
    relevant_new: relevantNew,
    error_code: failure?.code,
    note: rateLimited
      ? `The search provider asked for fewer requests after ${executed} ${executed === 1 ? 'query' : 'queries'}. Not retried.`
      : failure && executed === 0
        ? `Every search failed: ${failure.message}`
        : executed === 0
          ? 'No query was run.'
          : `${executed} ${executed === 1 ? 'query' : 'queries'}, ${seen} results, ${urlsNew} new URLs, ${relevantNew} about offers`,
  };
}

/**
 * Turn search results into the same discovery items a feed produces.
 *
 * Identical downstream: one table, one classifier, one extraction stage. The
 * only thing that differs is where trust comes from — the destination domain,
 * never the search engine that surfaced it.
 */
export async function ingestResults(
  env: Env,
  source: DiscoverySource,
  results: { title: string; url: string; snippet: string | null; published_at: string | null }[],
  query: string
): Promise<{ urls_new: number; relevant_new: number }> {
  let urlsNew = 0;
  let relevantNew = 0;

  for (const r of results) {
    const url = canonicalUrl(r.url);
    if (!url) continue;

    const verdict = classify(r.title ?? '', r.snippet ?? '');
    const worth = shouldExtract(verdict);
    const inserted = await recordDiscoveryItem(env, {
      source_id: source.id,
      url: r.url,
      canonical_url: url,
      title: r.title || null,
      published_at: r.published_at,
      item_type: verdict.type,
      status: worth ? 'new' : 'irrelevant',
      classification_score: verdict.score,
      classification_signals: verdict.signals,
      search_query: query,
    });

    if (inserted.created) {
      urlsNew++;
      if (worth) relevantNew++;
    }
  }

  return { urls_new: urlsNew, relevant_new: relevantNew };
}

/** Trust follows the destination, not the route that found it. */
export const tierForResult = (url: string): number => trustTierForUrl(url);

async function recordSearchRun(
  env: Env,
  source: DiscoverySource,
  provider: string,
  q: SearchQuery,
  results: number,
  newUrls: number,
  error: string | null
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO discovery_search_runs
         (source_id, provider, query, query_kind, searched_at, result_count, new_url_count, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(source.id, provider, q.query, q.kind, new Date().toISOString(), results, newUrls, error)
      .run();
  } catch {
    /* the record is diagnostics; losing it must not stop the search */
  }
}

export interface SearchRunRow {
  id: number;
  provider: string;
  query: string;
  query_kind: string;
  searched_at: string;
  result_count: number;
  new_url_count: number;
  error: string | null;
}

export async function recentSearches(env: Env, limit = 20): Promise<SearchRunRow[]> {
  const { results } = await env.DB.prepare(`SELECT * FROM discovery_search_runs ORDER BY id DESC LIMIT ?`)
    .bind(limit)
    .all<SearchRunRow>();
  return results ?? [];
}
