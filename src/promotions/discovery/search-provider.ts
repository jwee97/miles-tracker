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
    url.searchParams.set('q', trimQuery(query));
    url.searchParams.set('count', String(limit));
    // Singapore promotions, recent. Neither is a hard filter — the provider
    // treats them as preferences — but both cut the noise this pipeline would
    // otherwise pay to fetch and classify.
    //
    // The country code is UPPERCASE. Brave validates it strictly and rejects
    // the whole request with 422 otherwise, which is not obvious from a status
    // line alone — hence the error body being read below rather than dropped.
    url.searchParams.set('country', 'SG');
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
          'Accept-Encoding': 'gzip',
          // Brave validates this one too, and rejects the request without it.
          'Cache-Control': 'no-cache',
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
      // The provider says why. Dropping it and reporting the bare status is
      // the same silent failure this whole layer exists to prevent: "the
      // search provider returned 422" is unactionable, while the body names
      // the parameter it rejected.
      const said = await explainFailure(res);
      throw new SearchProviderError(
        'SEARCH_PROVIDER_ERROR',
        `the search provider returned ${res.status}${said ? `: ${said}` : ''}`,
        res.status
      );
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

/**
 * What the provider said about the failure, in as few words as carry meaning.
 *
 * A 422 from Brave names the parameter it rejected, and that one sentence is
 * the difference between "search is broken" and "the country code has to be
 * uppercase". Reading the body is best-effort: it must never turn one failure
 * into two.
 */
export async function explainFailure(res: Response): Promise<string | null> {
  let raw: string;
  try {
    raw = (await res.text()).slice(0, 2000);
  } catch {
    return null;
  }
  if (!raw.trim()) return null;

  try {
    const body = JSON.parse(raw);
    const err = body?.error ?? body;
    const detail: string | null = typeof err?.detail === 'string' ? err.detail : null;
    const code: string | null = typeof err?.code === 'string' ? err.code : null;

    // Brave puts the specific parameter complaints in meta.errors.
    const metaErrors = Array.isArray(err?.meta?.errors) ? err.meta.errors : [];
    const fields = metaErrors
      .map((e: any) => {
        const where = Array.isArray(e?.loc) ? e.loc.filter((x: unknown) => typeof x === 'string').join('.') : null;
        const msg = typeof e?.msg === 'string' ? e.msg : typeof e?.message === 'string' ? e.message : null;
        return where && msg ? `${where} — ${msg}` : (msg ?? where);
      })
      .filter(Boolean)
      .slice(0, 4);

    const parts = [code, detail, ...fields].filter(Boolean) as string[];
    if (parts.length) return parts.join('; ').slice(0, 400);
  } catch {
    /* not JSON; the raw text is still better than nothing */
  }
  return raw.replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * Keep a query inside what the provider will accept.
 *
 * Brave caps `q` at 600 characters and 75 words and rejects the request
 * outright past either. The generated series queries quote a whole article
 * title, so this is a real ceiling rather than a theoretical one — and a
 * rejected request costs the same as a successful one.
 */
export const MAX_QUERY_CHARS = 400;
export const MAX_QUERY_WORDS = 50;

export function trimQuery(q: string): string {
  const words = q.trim().split(/\s+/);
  const clipped = words.length > MAX_QUERY_WORDS ? words.slice(0, MAX_QUERY_WORDS).join(' ') : q.trim();
  return clipped.length > MAX_QUERY_CHARS ? clipped.slice(0, MAX_QUERY_CHARS).trim() : clipped;
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
