import type { Env } from '../../types';
import { USER_AGENT } from './fetch';

/**
 * The search layer, behind one interface.
 *
 * Nothing in the discovery pipeline knows which search engine is in use, and
 * nothing outside this file calls a provider's API. That boundary earns its
 * keep twice: swapping Brave for Bing or Serper is one class here and no
 * change anywhere else, and every test can drive a fake provider instead of
 * mocking HTTP at the wrong level.
 *
 * A provider returns URLs and nothing more. It does not decide whether a
 * result is trustworthy — that follows from the destination domain, which is
 * the point of domains.ts. A specialist article does not become a search
 * result because a search engine was how it was found.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string | null;
  published_at: string | null;
  source_domain: string | null;
}

export interface SearchResponse {
  results: SearchResult[];
  provider: string;
  query: string;
}

export interface SearchProvider {
  name: string;
  search(query: string, options?: { limit?: number }): Promise<SearchResponse>;
}

/**
 * A provider refusing is not the same as a provider returning nothing.
 *
 * Thrown with a code so the runner can record "the provider asked for fewer
 * requests" separately from "the search ran and found nothing" — which are the
 * two states most often collapsed into one, and the collapse is what makes a
 * broken search look like a quiet one.
 */
export class SearchProviderError extends Error {
  constructor(
    public readonly code: 'SEARCH_RATE_LIMITED' | 'SEARCH_PROVIDER_ERROR',
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'SearchProviderError';
  }
}

const DEFAULT_LIMIT = 10;
const TIMEOUT_MS = 10_000;

/**
 * Bind a fetch implementation so it can be stored and called safely.
 *
 * Workers' `fetch` refuses to run with a `this` that is not the global scope,
 * and storing it on an object is enough to break that: `this.fetchImpl(url)`
 * calls it with the instance as `this` and throws "Illegal invocation". The
 * symptom is miserable to read — every search failing with a TypeError that
 * mentions nothing about search — so the binding happens once, here, at the
 * only boundary where a fetch becomes a field.
 *
 * A test double is bound too. Binding a plain function changes nothing about
 * it, and an unbound path that only shows up in production is exactly what
 * went wrong.
 */
export const bindFetch = (f: typeof fetch = fetch): typeof fetch => f.bind(globalThis) as typeof fetch;

/**
 * Brave's Web Search API.
 *
 * `fetchImpl` is a constructor argument rather than a bare `fetch` call so the
 * tests can drive it without a network or an API key. A provider that can only
 * be tested against the real service is a provider nobody tests.
 */
export class BraveSearchProvider implements SearchProvider {
  readonly name = 'brave';
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly key: string,
    fetchImpl: typeof fetch = fetch
  ) {
    this.fetchImpl = bindFetch(fetchImpl);
  }

  async search(query: string, options: { limit?: number } = {}): Promise<SearchResponse> {
    const limit = Math.min(20, Math.max(1, options.limit ?? DEFAULT_LIMIT));
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(limit));
    // Singapore promotions, recent. Neither is a hard filter — the provider
    // treats them as preferences — but both cut the noise this pipeline would
    // otherwise pay to fetch and classify.
    url.searchParams.set('country', 'sg');
    url.searchParams.set('freshness', 'pm');

    // Through a local, not `this.fetchImpl(...)`: the property call is what
    // sets `this` to the instance, and the bind above is the other half of the
    // same guard.
    const send = this.fetchImpl;
    let res: Response;
    try {
      res = await send(url.toString(), {
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': this.key,
          'User-Agent': USER_AGENT,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new SearchProviderError('SEARCH_PROVIDER_ERROR', `the search provider could not be reached: ${(e as Error).message}`);
    }

    // 429 is the provider asking for fewer requests, and the answer is fewer
    // requests. There is no retry here and there should not be one.
    if (res.status === 429) {
      throw new SearchProviderError('SEARCH_RATE_LIMITED', 'the search provider asked for fewer requests', 429);
    }
    if (!res.ok) {
      throw new SearchProviderError('SEARCH_PROVIDER_ERROR', `the search provider returned ${res.status}`, res.status);
    }

    let body: any;
    try {
      body = await res.json();
    } catch {
      throw new SearchProviderError('SEARCH_PROVIDER_ERROR', 'the search provider returned something that was not JSON');
    }

    const rows: any[] = body?.web?.results ?? [];
    return {
      provider: this.name,
      query,
      results: rows.slice(0, limit).map((r) => ({
        title: String(r?.title ?? '').slice(0, 300),
        url: String(r?.url ?? ''),
        // A snippet is a sentence from someone else's page. It is kept short
        // for the same reason excerpts are: this is not an archive.
        snippet: r?.description ? String(r.description).slice(0, 400) : null,
        published_at: normaliseDate(r?.page_age ?? r?.age ?? null),
        source_domain: hostOrNull(String(r?.url ?? '')),
      })).filter((r) => r.url.startsWith('http')),
    };
  }
}

const hostOrNull = (url: string): string | null => {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return null;
  }
};

/** Providers report dates inconsistently; anything unparseable is simply unknown. */
export function normaliseDate(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * The configured provider, or null.
 *
 * Null is a first-class answer meaning "search discovery is switched off", and
 * every caller has to handle it. That is deliberate: the previous
 * implementation had no provider at all and reported itself healthy, which is
 * the exact failure this returns null to prevent.
 */
export function searchProvider(env: Env, fetchImpl: typeof fetch = fetch): SearchProvider | null {
  if (!env.SEARCH_PROVIDER || !env.SEARCH_API_KEY) return null;
  switch (env.SEARCH_PROVIDER.trim().toLowerCase()) {
    case 'brave':
      return new BraveSearchProvider(env.SEARCH_API_KEY, fetchImpl);
    default:
      return null;
  }
}

export function searchConfigured(env: Env): boolean {
  return searchProvider(env) !== null;
}
