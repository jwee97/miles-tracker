import { parseFeed, canonicalUrl } from '../../rss';
import { today } from '../../spend';
import type { Env } from '../../types';
import { classify, shouldExtract } from './classify';
import { trustTierForUrl } from './domains';
import { USER_AGENT } from './fetch';
import { plannedQueries } from './search';
import { searchProvider } from './search-provider';
import { queryKindFor } from './search-runner';
import { healthOf, type DiscoverySource } from './sources';
import { discoveryError, type DiscoveryErrorCode } from '../../../shared/discovery';

/**
 * Testing one source, without changing anything.
 *
 * The distinction that makes this useful is that it is *diagnostic only*. It
 * does not touch `last_scanned_at`, `scans`, `scan_frequency` or the failure
 * count, so pressing Test ten times while debugging cannot demote a source or
 * mark it failing. A diagnostic that alters the thing it measures is worse
 * than no diagnostic.
 *
 * It also answers the question people actually have, which is not "does this
 * URL respond" but "why is nothing coming out of this source" — so it reports
 * what the feed listed, how the classifier judged a few of them, and why the
 * ones it skipped were skipped.
 */

export interface SourceTestExample {
  title: string;
  url: string;
  classification: string;
  relevant: boolean;
  signals: string[];
  trust_tier: number;
}

export interface SourceTestResult {
  ok: boolean;
  type: string;
  source_key: string;
  name: string;
  /** Only meaningful for a search source. */
  configured?: boolean;
  provider?: string | null;
  http_status?: number;
  items_seen?: number;
  relevant_items?: number;
  queries_planned?: number;
  examples: SourceTestExample[];
  error?: string;
  error_code?: DiscoveryErrorCode;
  note: string;
  as_of: string;
}

/** At most this many examples come back: this is a diagnostic, not a feed reader. */
const MAX_EXAMPLES = 5;

export async function testSource(
  env: Env,
  source: DiscoverySource,
  opts: { fetchImpl?: typeof fetch } = {}
): Promise<SourceTestResult> {
  const base = {
    type: source.source_type,
    source_key: source.source_key,
    name: source.name,
    examples: [] as SourceTestExample[],
    as_of: today(env),
  };

  if (source.source_type === 'search') return await testSearch(env, source, base, opts);
  if (!source.feed_url) {
    return { ...base, ok: false, note: 'This source has no feed URL, so there is nothing to read.' };
  }
  return await testFeed(env, source, base, opts);
}

async function testFeed(
  env: Env,
  source: DiscoverySource,
  base: Omit<SourceTestResult, 'ok' | 'note'>,
  opts: { fetchImpl?: typeof fetch }
): Promise<SourceTestResult> {
  const f = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(source.feed_url!, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/xml, text/xml' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    return {
      ...base,
      ok: false,
      error: (e as Error).message,
      error_code: 'SOURCE_FETCH_TIMEOUT',
      note: 'The feed could not be reached at all.',
    };
  }

  if (!res.ok) {
    // A refusal is reported, not worked around. 403 here means the site has
    // said no, and the fix is a different source rather than a different
    // header.
    const blocked = res.status === 401 || res.status === 403 || res.status === 429;
    return {
      ...base,
      ok: false,
      http_status: res.status,
      error: `HTTP ${res.status}`,
      error_code: blocked ? 'SOURCE_FETCH_BLOCKED' : 'SOURCE_INVALID_FEED',
      note: blocked
        ? `The feed returned HTTP ${res.status}. The site has said no; it is recorded and not retried.`
        : `The feed returned HTTP ${res.status}.`,
    };
  }

  const body = (await res.text()).slice(0, 600_000);
  const items = parseFeed(body);
  if (!items.length) {
    return {
      ...base,
      ok: false,
      http_status: res.status,
      items_seen: 0,
      error_code: 'SOURCE_INVALID_FEED',
      note: 'The feed responded but listed no entries, which usually means it is not the feed it used to be.',
    };
  }

  let relevant = 0;
  const examples: SourceTestExample[] = [];
  for (const item of items.slice(0, 40)) {
    const verdict = classify(item.title ?? '', item.summary ?? '');
    const worth = shouldExtract(verdict);
    if (worth) relevant++;
    if (examples.length < MAX_EXAMPLES) {
      const url = canonicalUrl(item.link ?? '') ?? item.link ?? '';
      examples.push({
        // The title only. This is a diagnostic, and an article's text is not
        // the app's to keep.
        title: (item.title ?? '(untitled)').slice(0, 160),
        url,
        classification: verdict.type,
        relevant: worth,
        signals: verdict.signals.slice(0, 6),
        trust_tier: trustTierForUrl(url),
      });
    }
  }

  return {
    ...base,
    ok: true,
    http_status: res.status,
    items_seen: items.length,
    relevant_items: relevant,
    examples,
    note: relevant
      ? `${items.length} entries, ${relevant} of them about offers.`
      : `${items.length} entries, none of which look like they are about an offer. The feed works; its subject matter is elsewhere.`,
  };
}

async function testSearch(
  env: Env,
  source: DiscoverySource,
  base: Omit<SourceTestResult, 'ok' | 'note'>,
  opts: { fetchImpl?: typeof fetch }
): Promise<SourceTestResult> {
  const plan = await plannedQueries(env, queryKindFor(source.scan_frequency));
  const provider = searchProvider(env, opts.fetchImpl ?? fetch);

  if (!provider) {
    return {
      ...base,
      ok: false,
      configured: false,
      provider: null,
      queries_planned: plan.queries.length,
      ...discoveryError('SEARCH_NOT_CONFIGURED').error,
      error_code: 'SEARCH_NOT_CONFIGURED',
      error: 'SEARCH_API_KEY is not configured',
      note: 'Search discovery is not configured. RSS discovery continues working, but offers outside the tracked publications will be missed.',
    };
  }

  // One query, not the whole plan: this is a check that the provider answers,
  // and a diagnostic that spends the day's budget is a diagnostic nobody can
  // afford to run twice.
  const probe = plan.queries[0];
  if (!probe) {
    return { ...base, ok: false, configured: true, provider: provider.name, queries_planned: 0, note: 'No query could be generated.' };
  }

  try {
    const response = await provider.search(probe.query, { limit: MAX_EXAMPLES });
    return {
      ...base,
      ok: true,
      configured: true,
      provider: provider.name,
      queries_planned: plan.queries.length,
      items_seen: response.results.length,
      relevant_items: response.results.filter((r) => shouldExtract(classify(r.title, r.snippet ?? ''))).length,
      examples: response.results.slice(0, MAX_EXAMPLES).map((r) => {
        const verdict = classify(r.title, r.snippet ?? '');
        return {
          title: r.title.slice(0, 160),
          url: r.url,
          classification: verdict.type,
          relevant: shouldExtract(verdict),
          signals: verdict.signals.slice(0, 6),
          trust_tier: trustTierForUrl(r.url),
        };
      }),
      note: `${provider.name} answered "${probe.query}" with ${response.results.length} results.`,
    };
  } catch (e) {
    const code = (e as { code?: DiscoveryErrorCode }).code ?? 'SEARCH_PROVIDER_ERROR';
    return {
      ...base,
      ok: false,
      configured: true,
      provider: provider.name,
      queries_planned: plan.queries.length,
      error: (e as Error).message,
      error_code: code,
      note: `The provider is configured but refused: ${(e as Error).message}`,
    };
  }
}

/** Health for one source, without re-reading the whole registry. */
export const healthFor = (env: Env, s: DiscoverySource, searchOk: boolean) =>
  healthOf(s, today(env), { searchConfigured: searchOk });
