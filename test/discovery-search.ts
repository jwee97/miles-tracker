/**
 * Search discovery, which used not to search.
 *
 * The implementation this replaces generated queries, counted them, recorded a
 * successful scan and returned. "Search discovery is healthy" therefore meant
 * "queries were generated", and no number anywhere could tell that apart from
 * "the web was searched and found nothing". The assertions below are mostly
 * about keeping those states distinguishable — configured, refused, and empty
 * are three different answers, and the most important ones are negative: with
 * no API key, no request is made at all.
 */
import { DatabaseSync } from 'node:sqlite';
import { runMigrations, runSeed } from '../src/migrate';
import { hostOf, isOfficialUrl, issuerForUrl, sourceNameForUrl, trustTierForUrl } from '../src/promotions/discovery/domains';
import { extractPending } from '../src/promotions/discovery/run';
import { discover } from '../src/promotions/discovery/run';
import {
  bindFetch,
  BRAVE_COUNTRIES,
  BraveSearchProvider,
  countryParam,
  MAX_QUERY_CHARS,
  MAX_QUERY_WORDS,
  normaliseDate,
  trimQuery,
  searchConfigured,
  searchProvider,
  SearchProviderError,
  type SearchProvider,
} from '../src/promotions/discovery/search-provider';
import {
  COOLDOWN_HOURS,
  dailyBudget,
  isCool,
  queryKindFor,
  scanSearchSource,
  spentToday,
} from '../src/promotions/discovery/search-runner';
import { TIER, type DiscoverySource } from '../src/promotions/discovery/sources';
import type { Env } from '../src/types';

const db = new DatabaseSync(':memory:');
const wrap = (sql: string, args: unknown[] = []): any => ({
  bind: (...a: unknown[]) => wrap(sql, a),
  first: async () => db.prepare(sql).get(...(args as any)) ?? null,
  all: async () => ({ results: db.prepare(sql).all(...(args as any)) }),
  run: async () => {
    const r = db.prepare(sql).run(...(args as any));
    return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  },
});
const baseEnv = {
  DB: { prepare: (s: string) => wrap(s) },
  TZ_OFFSET_MINUTES: '480',
  MILE_VALUE_CENTS: '1.5',
} as unknown as Env;
const withSearch = (over: Record<string, string> = {}): Env =>
  ({ ...baseEnv, SEARCH_PROVIDER: 'brave', SEARCH_API_KEY: 'test-key', ...over }) as Env;

let fails = 0;
const check = (l: string, c: boolean, d = '') => {
  if (!c) fails++;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : `  -- ${d}`}`);
};
const sql = (s: string, ...a: unknown[]) => db.prepare(s).run(...(a as any));
const one = (s: string, ...a: unknown[]) => db.prepare(s).get(...(a as any)) as any;
const all = (s: string, ...a: unknown[]) => db.prepare(s).all(...(a as any)) as any[];
Date.now = () => Date.parse('2026-09-18T04:00:00Z');

await runMigrations(baseEnv);
await runSeed(baseEnv);

const searchSource = (): DiscoverySource => one(`SELECT * FROM discovery_sources WHERE source_key = 'search'`);

// ------------------------------------------------------------- trust by domain
// The subtlety the whole feature turns on: a search engine is not the source
// of a financial claim, it is how the source was found.
check('a bank speaking for itself is official', trustTierForUrl('https://www.dbs.com.sg/personal/promo/x') === TIER.official);
check('and so is a subdomain of it', trustTierForUrl('https://promotions.uob.com.sg/x') === TIER.official);
check('a lookalike domain is not', trustTierForUrl('https://dbs.com.sg.evil.test/x') !== TIER.official, String(trustTierForUrl('https://dbs.com.sg.evil.test/x')));
check('a specialist publication stays specialist', trustTierForUrl('https://milelion.com/citi-rewards') === TIER.specialist);
check('even when a search engine was how it was found', trustTierForUrl('https://milelion.com/x') !== TIER.search);
check('a comparison site is a comparison site', trustTierForUrl('https://blog.moneysmart.sg/cards/x') === TIER.comparison);
check('and a domain nobody knows is unknown, not a search result', trustTierForUrl('https://random.test/x') === TIER.unknown);
check('the issuer behind a domain is named', issuerForUrl('https://www.citibank.com.sg/x') === 'Citi');
check('an official URL can be checked against an issuer', isOfficialUrl('https://www.dbs.com.sg/x', 'DBS') === true);
check('and rejected for the wrong one', isOfficialUrl('https://www.dbs.com.sg/x', 'UOB') === false);
check('a host is read without its www', hostOf('https://www.milelion.com/a') === 'milelion.com');
check('and a publication gets its name back', sourceNameForUrl('https://milelion.com/a') === 'The MileLion');

// -------------------------------------------------------------- configuration
check('no provider name means no search', searchProvider(baseEnv) === null);
check('no API key means no search either', searchProvider({ ...baseEnv, SEARCH_PROVIDER: 'brave' } as Env) === null);
check('an unknown provider is not guessed at', searchProvider(withSearch({ SEARCH_PROVIDER: 'altavista' })) === null);
check('a configured provider is built', searchProvider(withSearch())?.name === 'brave');
check('and configuration is reportable on its own', searchConfigured(withSearch()) === true && searchConfigured(baseEnv) === false);

// With nothing configured, nothing must reach the network. This is the
// assertion that the old stub would have passed and the old behaviour failed.
let calls = 0;
const countingFetch = (async () => {
  calls++;
  return { ok: true, status: 200, json: async () => ({}) } as any;
}) as unknown as typeof fetch;

let scan = await scanSearchSource(baseEnv, searchSource(), { fetchImpl: countingFetch });
check('with no key configured, nothing is requested', calls === 0, String(calls));
check('and it does not claim to be ok', scan.ok === false);
check('because it was never configured', scan.configured === false);
check('which is said in words', scan.note.includes('SEARCH_API_KEY'), scan.note);
check('with a code a screen can act on', scan.error_code === 'SEARCH_NOT_CONFIGURED');
check('queries were still planned, so the budget is visible', scan.queries_planned > 0, String(scan.queries_planned));
check('but none were executed', scan.queries_executed === 0);
check('and nothing was recorded as having been searched', all(`SELECT * FROM discovery_search_runs`).length === 0);

// ------------------------------------------------------------- a real search
const fake = (results: { title: string; url: string; snippet?: string }[]): SearchProvider => ({
  name: 'fake',
  search: async (query) => ({
    provider: 'fake',
    query,
    results: results.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.snippet ?? null,
      published_at: null,
      source_domain: null,
    })),
  }),
});

const found = fake([
  { title: 'Citi Rewards: 16,000 bonus miles with $800 spend', url: 'https://milelion.com/citi-rewards-promo', snippet: 'Spend $800 within 30 days.' },
  { title: 'Best credit card sign-up bonuses — October 2026', url: 'https://blog.moneysmart.sg/roundup-oct', snippet: 'Every welcome offer running now.' },
  { title: 'Review: the new Hilton in Orchard', url: 'https://milelion.com/hilton-review', snippet: 'A hotel review.' },
]);

scan = await scanSearchSource(withSearch(), searchSource(), { provider: found });
check('a configured search actually runs queries', scan.queries_executed > 0, JSON.stringify(scan));
check('and says which provider ran them', scan.provider === 'fake');
check('results are counted', scan.results_seen > 0, String(scan.results_seen));
check('new URLs are counted apart from results', scan.urls_new === 3, String(scan.urls_new));
check('and the relevant ones apart from those', scan.relevant_new === 2, String(scan.relevant_new));
check('the hotel review is filed away rather than read', one(`SELECT status FROM discovery_items WHERE canonical_url LIKE '%hilton-review%'`).status === 'irrelevant');

check('search results become ordinary discovery items', all(`SELECT * FROM discovery_items WHERE canonical_url LIKE '%milelion.com%'`).length >= 1);
check('attributed to the search source', one(`SELECT source_id FROM discovery_items WHERE canonical_url LIKE '%citi-rewards-promo%'`).source_id === searchSource().id);
check('with the query that found them', !!one(`SELECT search_query FROM discovery_item_sources WHERE search_query IS NOT NULL`));

const runs = all(`SELECT * FROM discovery_search_runs`);
check('every query executed is written down', runs.length === scan.queries_executed, `${runs.length} vs ${scan.queries_executed}`);
check('with what it returned', runs[0].result_count === 3, String(runs[0].result_count));
check('and what was new about it', typeof runs[0].new_url_count === 'number');
check('so "did search run?" is a table lookup, not a guess', runs.every((r) => !!r.searched_at && !!r.provider));

// Running the same search again finds the same URLs and creates nothing.
sql(`DELETE FROM discovery_search_runs`);
scan = await scanSearchSource(withSearch(), searchSource(), { provider: found });
check('a repeated search finds the same pages', scan.results_seen > 0);
check('and creates no duplicates', scan.urls_new === 0, String(scan.urls_new));
check('which is not reported as a failure', scan.ok === true);

// An empty result set is a successful search.
sql(`DELETE FROM discovery_search_runs`);
scan = await scanSearchSource(withSearch(), searchSource(), { provider: fake([]) });
check('a search that finds nothing still ran', scan.queries_executed > 0, String(scan.queries_executed));
check('and reports itself ok', scan.ok === true);
check('with zero results, which is a finding', scan.results_seen === 0);
check('and it is not confused with being unconfigured', scan.configured === true);

// ------------------------------------------------------------- refusals
const refusing = (code: 'SEARCH_RATE_LIMITED' | 'SEARCH_PROVIDER_ERROR', status: number): SearchProvider => ({
  name: 'fake',
  search: async () => {
    throw new SearchProviderError(code, `the search provider returned ${status}`, status);
  },
});

sql(`DELETE FROM discovery_search_runs`);
scan = await scanSearchSource(withSearch(), searchSource(), { provider: refusing('SEARCH_RATE_LIMITED', 429) });
check('a rate limit is a failed scan', scan.ok === false, JSON.stringify(scan));
check('but not an unconfigured one', scan.configured === true);
check('and it stops rather than slowing down', scan.queries_executed === 0);
check('saying it will not be retried', scan.note.includes('Not retried'), scan.note);
check('with the failure recorded', all(`SELECT * FROM discovery_search_runs WHERE error IS NOT NULL`).length >= 1);

sql(`DELETE FROM discovery_search_runs`);
scan = await scanSearchSource(withSearch(), searchSource(), { provider: refusing('SEARCH_PROVIDER_ERROR', 500) });
check('a provider error is a failed scan too', scan.ok === false);
check('and it is a different code from a rate limit', scan.error_code === 'SEARCH_PROVIDER_ERROR');
check('each attempt is recorded', all(`SELECT * FROM discovery_search_runs`).length > 1, String(all(`SELECT * FROM discovery_search_runs`).length));

// ------------------------------------------------------------- budget
check('the daily budget has a default', dailyBudget(baseEnv) === 15);
check('and is configurable', dailyBudget({ ...baseEnv, MAX_SEARCH_QUERIES_PER_DAY: '3' } as Env) === 3);
check('nonsense falls back to the default', dailyBudget({ ...baseEnv, MAX_SEARCH_QUERIES_PER_DAY: 'lots' } as Env) === 15);

sql(`DELETE FROM discovery_search_runs`);
for (let i = 0; i < 3; i++) {
  sql(`INSERT INTO discovery_search_runs (provider, query, query_kind, searched_at) VALUES ('fake', ?, 'broad', '2026-09-18T01:00:00Z')`, `q${i}`);
}
check('what has been spent today is counted', (await spentToday(withSearch())) === 3);
scan = await scanSearchSource(withSearch({ MAX_SEARCH_QUERIES_PER_DAY: '3' }), searchSource(), { provider: found });
check('a spent budget stops further searching', scan.queries_executed === 0, String(scan.queries_executed));
check('without calling it a failure', scan.ok === true);
check('and says why', scan.note.includes('budget'), scan.note);

// ------------------------------------------------------------- cooldown
check('a question never asked is worth asking', isCool('broad', null, Date.now()));
check('one asked an hour ago is not', isCool('broad', new Date(Date.now() - 3_600_000).toISOString(), Date.now()) === false);
check('one asked two days ago is', isCool('broad', new Date(Date.now() - 48 * 3_600_000).toISOString(), Date.now()));
check('a card query waits longer than a broad one', COOLDOWN_HOURS.product > COOLDOWN_HOURS.broad);
check('because a welcome offer does not change within a week', COOLDOWN_HOURS.product >= 24 * 7);

sql(`DELETE FROM discovery_search_runs`);
await scanSearchSource(withSearch(), searchSource(), { provider: found });
const asked = all(`SELECT query FROM discovery_search_runs`).map((r) => r.query);
scan = await scanSearchSource(withSearch(), searchSource(), { provider: found });
check('the same queries are not re-asked immediately', scan.queries_executed < asked.length || scan.queries_executed === 0, `${scan.queries_executed} of ${asked.length}`);

// ------------------------------------------------------ depth follows cadence
check('a daily source runs the broad sweep', queryKindFor('daily') === 'daily');
check('a three-day one goes wider', queryKindFor('every3days') === 'every3days');
check('a weekly one goes widest', queryKindFor('weekly') === 'weekly');
check('and a monthly one sweeps fully when it does run', queryKindFor('monthly') === 'weekly');

// ------------------------------------------------- search through the pipeline
// The end-to-end claim: a search result becomes a candidate whose evidence is
// attributed to the publication, not to the search engine.
sql(`DELETE FROM discovery_items`);
sql(`DELETE FROM discovery_search_runs`);
sql(`DELETE FROM promotion_candidates`);
sql(`DELETE FROM promotion_claims`);

await scanSearchSource(withSearch(), searchSource(), {
  provider: fake([
    { title: 'Citi Rewards: 16,000 bonus miles', url: 'https://milelion.com/citi-x', snippet: 'Spend $800 within 30 days for 16,000 bonus miles.' },
  ]),
});

const article = `<html><head><title>Citi Rewards: 16,000 bonus miles</title></head><body>
  <p>Citi Rewards Card: get 16,000 bonus miles when you spend $800 within 30 days. Ends 30 Sep 2026.</p></body></html>`;
const articleFetch = (async (url: any) => {
  const u = String(url);
  if (u.endsWith('/robots.txt')) return { ok: false, status: 404, url: u, headers: { get: () => null }, text: async () => '' } as any;
  return { ok: true, status: 200, url: u, headers: { get: () => 'text/html' }, text: async () => article } as any;
}) as unknown as typeof fetch;

const extracted = await extractPending(withSearch(), { limit: 3, fetchImpl: articleFetch });
check('a search result is read like any other article', extracted.articles_fetched >= 1, JSON.stringify(extracted));
check('and yields a candidate', extracted.candidates_created >= 1, String(extracted.candidates_created));

const claim = one(`SELECT * FROM promotion_claims ORDER BY id LIMIT 1`);
check('its evidence is attributed to the publication', claim.source_tier === TIER.specialist, String(claim.source_tier));
check('not to the search engine that surfaced it', claim.source_tier !== TIER.search);
check('and the URL kept is the article, not the search page', claim.source_url.includes('milelion.com'), claim.source_url);

// ------------------------------------------------- calling fetch correctly
// The failure this reproduces: Workers' fetch refuses to run with a `this`
// that is not the global scope, and storing it on an object is enough to break
// that — `this.fetchImpl(url)` calls it with the instance as `this` and throws
// "Illegal invocation". Every search failed with a TypeError that mentioned
// nothing about searching.
//
// This double behaves the way the real runtime does, so an unbound call fails
// here rather than only in production.
let sawThis: unknown = 'never called';
const strictFetch = function (this: unknown, _url: any, _init?: any) {
  sawThis = this;
  if (this !== undefined && this !== globalThis) {
    throw new TypeError('Illegal invocation: function called with incorrect `this` reference.');
  }
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ web: { results: [{ title: 'A', url: 'https://milelion.com/a', description: 'x' }] } }),
  } as any);
} as unknown as typeof fetch;

const strict = new BraveSearchProvider('k', strictFetch);
let bound: unknown = null;
try {
  const r = await strict.search('citi rewards');
  check('a stored fetch is called with the right this', r.results.length === 1, JSON.stringify(r.results));
} catch (e) {
  bound = e;
  check('a stored fetch is called with the right this', false, (e as Error).message);
}
check('and never with the provider as this', !(sawThis instanceof BraveSearchProvider), String(sawThis?.constructor?.name));
check('so no illegal invocation escapes', bound === null, String(bound));

check('binding a plain function leaves it working', (await bindFetch(strictFetch)('https://x.test')).ok === true);

// The same failure, seen from the runner: a client-side throw must not be
// mistaken for the provider refusing.
const throwing: SearchProvider = {
  name: 'fake',
  search: async () => {
    throw new TypeError('Illegal invocation: function called with incorrect `this` reference.');
  },
};
sql(`DELETE FROM discovery_search_runs`);
scan = await scanSearchSource(withSearch(), searchSource(), { provider: throwing });
check('a client-side throw is still a failed scan', scan.ok === false, JSON.stringify(scan));
check('but it is recorded as ours, not the source’s', scan.fault === 'client', String(scan.fault));
check('and the reason is written down', all(`SELECT * FROM discovery_search_runs WHERE error LIKE '%Illegal invocation%'`).length >= 1);

const provider429: SearchProvider = {
  name: 'fake',
  search: async () => {
    throw new SearchProviderError('SEARCH_RATE_LIMITED', 'the search provider returned 429', 429);
  },
};
// Cleared first: the throwing scan above recorded those queries, and the
// cooldown would otherwise return early without attempting anything.
sql(`DELETE FROM discovery_search_runs`);
scan = await scanSearchSource(withSearch(), searchSource(), { provider: provider429 });
check('a refusal with a status is the source’s', scan.fault === 'source', JSON.stringify(scan));

// ------------------------------------------------------------ the Brave client
// Driven through an injected fetch, because a provider that can only be tested
// against the live service is a provider nobody tests.
let lastRequest: { url: string; headers: Record<string, string> } | null = null;
const braveFetch = (async (url: any, init: any) => {
  lastRequest = { url: String(url), headers: init?.headers ?? {} };
  return {
    ok: true,
    status: 200,
    json: async () => ({
      web: {
        results: [
          { title: 'A', url: 'https://milelion.com/a', description: 'first', page_age: '2026-09-10T00:00:00Z' },
          { title: 'B', url: 'not-a-url', description: 'dropped' },
        ],
      },
    }),
  } as any;
}) as unknown as typeof fetch;

const brave = new BraveSearchProvider('k', braveFetch);
const response = await brave.search('citi rewards promotion', { limit: 5 });
check('the query reaches the provider', lastRequest!.url.includes('citi+rewards') || lastRequest!.url.includes('citi%20rewards'), lastRequest!.url);
check('the key travels in a header, never in the URL', !lastRequest!.url.includes('k') || !lastRequest!.url.includes('key='), lastRequest!.url);
check('and is sent as a subscription token', (lastRequest!.headers as any)['X-Subscription-Token'] === 'k');
check('results come back mapped', response.results.length === 1, String(response.results.length));
check('with a result that is not a URL dropped', response.results.every((r) => r.url.startsWith('http')));
check('and the date normalised', response.results[0].published_at === '2026-09-10', String(response.results[0].published_at));
check('an unparseable date is simply unknown', normaliseDate('sometime') === null);

// The request has to satisfy the provider's own validation, and a 422 is the
// provider telling us which part it rejected. Reporting the bare status —
// "the search provider returned 422" — is unactionable, and is the same silent
// failure this whole layer exists to prevent.
const sent = new URL(lastRequest!.url);
// Asserted against the provider's accepted set rather than a literal. Pinning
// one value made this test fail the moment the value was corrected, which is
// backwards: the contract is "a code Brave accepts", and Singapore is not one
// of them.
check(
  'the country is one the provider accepts',
  BRAVE_COUNTRIES.has(sent.searchParams.get('country') ?? ''),
  String(sent.searchParams.get('country'))
);
check('and Singapore is not among them, so it is not sent', !BRAVE_COUNTRIES.has('SG'));
check('an unsupported code degrades rather than failing the request', countryParam('SG') === 'ALL');
check('a lowercase one is upper-cased, since that was the first 422', countryParam('gb') === 'GB');
check('and a supported one is passed through', countryParam('US') === 'US');
check('as is nothing at all', countryParam(null) === 'ALL');
check('freshness is one of the accepted values', ['pd', 'pw', 'pm', 'py'].includes(sent.searchParams.get('freshness') ?? ''), String(sent.searchParams.get('freshness')));
check('the count is within the documented maximum', Number(sent.searchParams.get('count')) <= 20);
check('caching is declined, which the API validates', (lastRequest!.headers as any)['Cache-Control'] === 'no-cache');

check('a long query is trimmed to what the API accepts', trimQuery('word '.repeat(200)).split(/\s+/).length <= MAX_QUERY_WORDS);
check('and to the character ceiling', trimQuery('x'.repeat(2000)).length <= MAX_QUERY_CHARS);
check('while a short one is left exactly as written', trimQuery('citi rewards promotion') === 'citi rewards promotion');

const rejecting = new BraveSearchProvider('k', (async () => ({
  ok: false,
  status: 422,
  text: async () =>
    JSON.stringify({
      type: 'ErrorResponse',
      error: {
        id: 'abc',
        status: 422,
        code: 'VALIDATION',
        detail: 'Unable to validate request parameter(s)',
        meta: { errors: [{ loc: ['query', 'country'], msg: 'string does not match regex' }] },
      },
    }),
}) as any) as unknown as typeof fetch);

let rejected: SearchProviderError | null = null;
try {
  await rejecting.search('x');
} catch (e) {
  rejected = e as SearchProviderError;
}
check('a 422 still throws', rejected instanceof SearchProviderError);
check('and carries the status', rejected!.status === 422);
check('but the message says what the provider objected to', rejected!.message.includes('country'), rejected!.message);
check('naming the reason, not just the number', rejected!.message.includes('Unable to validate'), rejected!.message);
check('with its own error code', rejected!.message.includes('VALIDATION'), rejected!.message);

const opaque = new BraveSearchProvider('k', (async () => ({ ok: false, status: 500, text: async () => 'upstream exploded' }) as any) as unknown as typeof fetch);
rejected = null;
try {
  await opaque.search('x');
} catch (e) {
  rejected = e as SearchProviderError;
}
check('a non-JSON body is still repeated back', rejected!.message.includes('upstream exploded'), rejected!.message);

const silent = new BraveSearchProvider('k', (async () => ({ ok: false, status: 503, text: async () => '' }) as any) as unknown as typeof fetch);
rejected = null;
try {
  await silent.search('x');
} catch (e) {
  rejected = e as SearchProviderError;
}
check('and a provider that says nothing still gives the status', rejected!.message.includes('503'), rejected!.message);
check('without inventing an explanation', !rejected!.message.includes('undefined'), rejected!.message);

const rateLimited = new BraveSearchProvider('k', (async () => ({ ok: false, status: 429, json: async () => ({}) }) as any) as unknown as typeof fetch);
let thrown: unknown = null;
try {
  await rateLimited.search('x');
} catch (e) {
  thrown = e;
}
check('a 429 throws rather than returning nothing', thrown instanceof SearchProviderError);
check('with the code that means slow down', (thrown as SearchProviderError).code === 'SEARCH_RATE_LIMITED');

// ------------------------------------------------- discovery reports search
sql(`UPDATE discovery_sources SET active = 0`);
sql(`UPDATE discovery_sources SET active = 1, last_scanned_at = NULL WHERE source_key = 'search'`);
const report = await discover(baseEnv, { limit: 2 });
check('an unconfigured search is reported in the run', report.notes.some((n) => n.includes('SEARCH_API_KEY')), JSON.stringify(report.notes));
check('with queries planned but none executed', report.search_queries_planned > 0 && report.search_queries_executed === 0);
check(
  'and the source is not punished for missing a key it was never given',
  one(`SELECT failure_count FROM discovery_sources WHERE source_key = 'search'`).failure_count === 0
);

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
