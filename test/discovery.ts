/**
 * Automated promotion discovery.
 *
 * Three properties run through everything here, and each is a rule about what
 * the system must NOT do.
 *
 * It must not read a site that has said no. A 403, a robots rule or a bot check
 * is a recorded outcome, never something to work around — and losing a source
 * must degrade confidence rather than stop discovery.
 *
 * It must not turn an article into a fact. Everything an extractor produces is
 * a claim with a URL and a sentence attached; what a promotion says is decided
 * by weighing claims, so two sources disagreeing is visible rather than a coin
 * toss.
 *
 * And it must not publish financial terms nobody checked. Only an official
 * confirmation, or an already-published offer whose end date moved with two
 * sources agreeing, goes live unattended.
 */
import { DatabaseSync } from 'node:sqlite';
import { runMigrations, runSeed } from '../src/migrate';
import { classify, shouldExtract } from '../src/promotions/discovery/classify';
import { canAutoPublish, corroborate, weighField, type StoredClaim } from '../src/promotions/discovery/corroborate';
import { diffRoundups, expireFinished, type RoundupEntry } from '../src/promotions/discovery/diff';
import { extractDocument, extractOne, findDate, segments } from '../src/promotions/discovery/extract';
import { contentHash, disallowedPaths, excerptAround, fetchArticle, looksLikeChallenge, robotsAllows } from '../src/promotions/discovery/fetch';
import { canonicalForm, fingerprint, looksExtended, similarity } from '../src/promotions/discovery/fingerprint';
import { resolveProduct } from '../src/promotions/discovery/resolve';
import { corroboratePending, extractPending, discover, discoveryStatus } from '../src/promotions/discovery/run';
import { approveCandidate, diffTerms, reviewQueue } from '../src/promotions/discovery/review';
import { broadQueries, budgetFor, domainFor, officialQueries, plannedQueries, seriesQueries } from '../src/promotions/discovery/search';
import { isDue, recordScan, seedSources, TIER, upsertSource } from '../src/promotions/discovery/sources';
import { shouldEscalate, verifyOfficial } from '../src/promotions/discovery/verify';
import { promotionEvidence, changeSentence } from '../src/promotions/evidence';
import { rate } from '../src/promotions/relevance';
import { variantAudienceOf, contributeTargeted, saveVariant, spread, variantsFor, viewVariants } from '../src/promotions/variants';
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
const env = {
  DB: { prepare: (s: string) => wrap(s) },
  TZ_OFFSET_MINUTES: '480',
  MILE_VALUE_CENTS: '1.5',
  POSTING_LAG_DAYS: '0',
} as unknown as Env;

let fails = 0;
const check = (l: string, c: boolean, d = '') => {
  if (!c) fails++;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : `  -- ${d}`}`);
};
const sql = (s: string, ...a: unknown[]) => db.prepare(s).run(...(a as any));
const one = (s: string, ...a: unknown[]) => db.prepare(s).get(...(a as any)) as any;
const all = (s: string, ...a: unknown[]) => db.prepare(s).all(...(a as any)) as any[];
Date.now = () => Date.parse('2026-09-18T04:00:00Z');

await runMigrations(env);
await runSeed(env);

// ---------------------------------------------------------------- the fetcher
check('a robots disallow is read', disallowedPaths('User-agent: *\nDisallow: /private').length === 1);
check('and only the wildcard group', disallowedPaths('User-agent: Googlebot\nDisallow: /x').length === 0);
check('an empty disallow is not a ban', disallowedPaths('User-agent: *\nDisallow:').length === 0);
check('a disallowed path is refused', robotsAllows('User-agent: *\nDisallow: /promo', 'https://x.test/promo/a') === false);
check('an allowed one is not', robotsAllows('User-agent: *\nDisallow: /promo', 'https://x.test/cards') === true);

check('a bot check is recognised', looksLikeChallenge('<html><title>Just a moment...</title>'));
check('so is an access denied page', looksLikeChallenge('<html><head><title>Access Denied</title>'));
check('an ordinary page is not', !looksLikeChallenge('<html><head><title>Citi Rewards promotion</title>'));

const responses = new Map<string, { status: number; body: string; type?: string }>();
const fakeFetch = (async (url: any) => {
  const key = String(url);
  const r = responses.get(key) ?? { status: 404, body: '' };
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    url: key,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? (r.type ?? 'text/html') : null) },
    text: async () => r.body,
  } as any;
}) as unknown as typeof fetch;

responses.set('https://blocked.test/robots.txt', { status: 404, body: '' });
responses.set('https://blocked.test/promo', { status: 403, body: '' });
let res = await fetchArticle('https://blocked.test/promo', { fetchImpl: fakeFetch });
check('a 403 is recorded, not worked around', res.status === 'fetch_blocked', res.status);
check('and says it will not be retried', res.note.includes('Not retried'), res.note);
check('with nothing read from it', res.text === null);

responses.set('https://busy.test/robots.txt', { status: 404, body: '' });
responses.set('https://busy.test/x', { status: 429, body: '' });
res = await fetchArticle('https://busy.test/x', { fetchImpl: fakeFetch });
check('a 429 is treated as a request for fewer requests', res.status === 'fetch_blocked', res.status);

responses.set('https://polite.test/robots.txt', { status: 200, body: 'User-agent: *\nDisallow: /secret' });
responses.set('https://polite.test/secret/a', { status: 200, body: '<html>should never be read</html>' });
res = await fetchArticle('https://polite.test/secret/a', { fetchImpl: fakeFetch });
check('robots is honoured before the page is requested', res.status === 'robots_disallowed', res.status);
check('and the page is never read', res.text === null);

responses.set('https://polite.test/ok', {
  status: 200,
  body: '<html><head><title>Citi Rewards 16,000 miles</title></head><body><p>Spend $800 within 30 days.</p></body></html>',
});
res = await fetchArticle('https://polite.test/ok', { fetchImpl: fakeFetch });
check('a page that permits reading is read', res.status === 'ok', res.status);
check('with its title', res.title === 'Citi Rewards 16,000 miles', String(res.title));

responses.set('https://challenge.test/robots.txt', { status: 404, body: '' });
responses.set('https://challenge.test/p', { status: 200, body: '<html><title>Just a moment...</title>checking your browser' });
res = await fetchArticle('https://challenge.test/p', { fetchImpl: fakeFetch });
check('a bot check returning 200 is still a refusal', res.status === 'fetch_blocked', res.status);

check('the excerpt kept is short', excerptAround('a'.repeat(1000), 'aaa').length <= 240);
check('and an unchanged page hashes the same', contentHash('Spend $800') === contentHash(' spend  $800 '));

// ------------------------------------------------------------- classification
check('a roundup is recognised', classify('Best credit card sign-up bonuses — September 2026').roundup === true);
check('and is worth extracting', shouldExtract(classify('Best credit card sign-up bonuses — September 2026')));
check('a single promotion article too', classify('Citi Rewards: 16,000 bonus miles with $800 spend').type === 'promotion_related');
check('a transfer bonus is its own kind', classify('25% KrisFlyer transfer bonus is back').type === 'transfer_related');
check('a hotel review is not a promotion', classify('Review: the new Hilton in Orchard').type === 'irrelevant');
check('and is not extracted', !shouldExtract(classify('Review: the new Hilton in Orchard')));

// ------------------------------------------------------------------ extraction
const article = `
Citi Rewards Card
Get 16,000 bonus miles when you spend $800 within 30 days of card approval.
Offer ends 30 Sep 2026. Register for this promotion first.
`;
const got = extractOne(article, 'https://milelion.test/citi');
check('the reward is read', got.reward.miles === 16000, String(got.reward.miles));
check('the minimum spend too', got.minimum_spend_cents === 80000, String(got.minimum_spend_cents));
check('the window', got.spend_window?.value === 30, JSON.stringify(got.spend_window));
check('and the end date', got.application_end === '2026-09-30', String(got.application_end));
check('registration is noticed', got.registration_required === true);
check('the issuer is identified', got.issuer === 'Citi', String(got.issuer));
check('every number carries the sentence it came from', got.source_claims.every((c) => c.supporting_excerpt.length > 0));
check('and the reading is high confidence', got.extraction_confidence === 'high', got.extraction_confidence);

check('a date with no year is not guessed at', findDate('ends 30 Sep', /ends\s+/i) === null);
check('one written long-hand is read', findDate('ends 30 September 2026', /ends\s+/i)?.iso === '2026-09-30');
check('and one written American-style', findDate('until September 30, 2026', /until\s+/i)?.iso === '2026-09-30');

const roundup = `
Here are this month's best sign-up offers.

Citi Rewards Card
16,000 bonus miles with $800 spend. Ends 30 Sep 2026.

DBS Altitude Visa
38,000 miles when you spend $1,500 within 60 days. Ends 30 Sep 2026.

UOB Lady's Card
18,000 miles for $1,000 spend. Ends 31 Oct 2026.
`;
check('a roundup splits into its offers', segments(roundup).length === 3, String(segments(roundup).length));
const many = extractDocument({ title: 'Best sign-up bonuses', url: 'https://x.test/r', source_id: 1, text: roundup }, { roundup: true });
check('one document yields several candidates', many.candidates.length === 3, String(many.candidates.length));
check('and is marked as a roundup', many.roundup === true);
check('each with its own reward', many.candidates.map((c) => c.reward.miles).join(',') === '16000,38000,18000', many.candidates.map((c) => c.reward.miles).join(','));
const single = extractDocument({ title: 'Citi Rewards', url: 'https://x.test/1', source_id: 1, text: article });
check('an ordinary article yields one', single.candidates.length === 1);

// ----------------------------------------------------------------- fingerprint
const base = {
  issuer: 'Citi',
  product_id: 7,
  product_name: 'Citi Rewards',
  promotion_type: 'welcome_offer',
  application_channel: 'issuer_direct',
  application_start: '2026-09-01',
  application_end: '2026-09-30',
  minimum_spend_cents: 80000,
  reward: { miles: 16000 },
};
check('the canonical form is readable', canonicalForm(base).includes('CITI|P7|WELCOME_OFFER'), canonicalForm(base));
check('and the same campaign fingerprints the same', fingerprint(base) === fingerprint({ ...base, application_end: '2026-09-28' }), 'month-level dates');
check('a different reward does not', fingerprint(base) !== fingerprint({ ...base, reward: { miles: 20000 } }));

check('two articles about one offer match', similarity(base, { ...base, application_end: '2026-09-29' }).same === true);
check('a different issuer never does', similarity(base, { ...base, issuer: 'DBS' }).score === 0);
check('nor a different card', similarity(base, { ...base, product_id: 9 }).score === 0);
check(
  'and a channel-exclusive offer is its own campaign',
  similarity(base, { ...base, application_channel: 'moneysmart' }).score === 0,
  JSON.stringify(similarity(base, { ...base, application_channel: 'moneysmart' }))
);

check('a later end date on the same economics is an extension', looksExtended(base, { ...base, application_end: '2026-10-31' }) === true);
check('but a new reward with a new date is a new campaign', looksExtended(base, { ...base, application_end: '2026-10-31', reward: { miles: 20000 } }) === false);

// ---------------------------------------------------------------- corroboration
const claim = (field: string, value: unknown, url: string, tier: number): StoredClaim => ({
  id: 0,
  field_name: field,
  value_json: JSON.stringify(value),
  source_url: url,
  source_type: 'article',
  source_tier: tier,
  extracted_at: '2026-09-18',
  confidence: 'high',
  supporting_excerpt: `${field} said here`,
});

let evidence = weighField('reward_miles', [
  claim('reward_miles', 30000, 'https://milelion.test/a', TIER.specialist),
  claim('reward_miles', 30000, 'https://moneysmart.test/b', TIER.comparison),
]);
check('two independent sources agreeing is high confidence', evidence!.confidence === 'high', evidence?.confidence);
check('and it counts hosts, not articles', evidence!.sources === 2, String(evidence?.sources));

evidence = weighField('reward_miles', [
  claim('reward_miles', 30000, 'https://milelion.test/a', TIER.specialist),
  claim('reward_miles', 30000, 'https://milelion.test/b', TIER.specialist),
]);
check('two articles from one site are one source', evidence!.sources === 1, String(evidence?.sources));

evidence = weighField('reward_miles', [
  claim('reward_miles', 25000, 'https://milelion.test/a', TIER.specialist),
  claim('reward_miles', 30000, 'https://citibank.test/x', TIER.official),
]);
check('the issuer outranks a publication', evidence!.value === 30000, String(evidence?.value));
check('and the disagreement is kept', evidence!.conflicting_values[0] === 25000, JSON.stringify(evidence?.conflicting_values));
check('rather than being silently resolved', evidence!.confidence !== 'high', evidence?.confidence);

const conflicted = corroborate([
  claim('reward_miles', 30000, 'https://milelion.test/a', TIER.specialist),
  claim('reward_miles', 25000, 'https://moneysmart.test/b', TIER.comparison),
  claim('minimum_spend_cents', 80000, 'https://milelion.test/a', TIER.specialist),
]);
check('a conflict is a state, not a choice', conflicted.verification_state === 'conflicting', conflicted.verification_state);
check('and it is named', conflicted.conflicts.length === 1, JSON.stringify(conflicted.conflicts));
check('with a reason a person can read', conflicted.review_reasons.some((r) => r.includes('disagree')), JSON.stringify(conflicted.review_reasons));

const agreed = corroborate([
  claim('reward_miles', 16000, 'https://milelion.test/a', TIER.specialist),
  claim('reward_miles', 16000, 'https://moneysmart.test/b', TIER.comparison),
  claim('minimum_spend_cents', 80000, 'https://milelion.test/a', TIER.specialist),
  claim('minimum_spend_cents', 80000, 'https://moneysmart.test/b', TIER.comparison),
  claim('application_end', '2026-09-30', 'https://milelion.test/a', TIER.specialist),
  claim('application_end', '2026-09-30', 'https://moneysmart.test/b', TIER.comparison),
]);
check('two publications agreeing is secondary verification', agreed.verification_state === 'secondary_verified', agreed.verification_state);
check('which is not the same as the issuer confirming it', agreed.verification_state !== 'official_verified');

const fromBank = corroborate([
  claim('reward_miles', 16000, 'https://citibank.test/x', TIER.official),
  claim('minimum_spend_cents', 80000, 'https://citibank.test/x', TIER.official),
  claim('application_end', '2026-09-30', 'https://citibank.test/x', TIER.official),
]);
check('the issuer’s own page is official verification', fromBank.verification_state === 'official_verified', fromBank.verification_state);

// ------------------------------------------------------------ publication rules
check('a conflict is never published automatically', canAutoPublish(conflicted, { known_promotion: false, only_extension: false }).auto === false);
check('nor is a new campaign on secondary evidence', canAutoPublish(agreed, { known_promotion: false, only_extension: false }).auto === false);
check('and the reason says a person should glance at it', canAutoPublish(agreed, { known_promotion: false, only_extension: false }).reason.includes('deserves a glance'));
check('an official confirmation may publish itself', canAutoPublish(fromBank, { known_promotion: false, only_extension: false }).auto === true);
check(
  'so may a known offer whose only change is a later date',
  canAutoPublish(agreed, { known_promotion: true, only_extension: true }).auto === true
);
check(
  'but not a known offer whose reward changed',
  canAutoPublish(agreed, { known_promotion: true, only_extension: false }).auto === false
);

// ----------------------------------------------------------------- the sources
await seedSources(env);
check('the default sources are seeded', all(`SELECT * FROM discovery_sources`).length >= 5, String(all(`SELECT * FROM discovery_sources`).length));
check('seeding twice adds nothing', (await seedSources(env)).added === 0);
check('publications outrank comparison sites', one(`SELECT trust_tier FROM discovery_sources WHERE source_key = 'milelion'`).trust_tier < one(`SELECT trust_tier FROM discovery_sources WHERE source_key = 'moneysmart'`).trust_tier);

const src = one(`SELECT * FROM discovery_sources WHERE source_key = 'milelion'`);
check('a never-scanned source is due', isDue({ ...src, last_scanned_at: null }, '2026-09-18') === true);
check('one scanned today is not', isDue({ ...src, last_scanned_at: '2026-09-18', scan_frequency: 'daily' }, '2026-09-18') === false);
check(
  'and a failing one is backed off rather than hammered',
  isDue({ ...src, last_scanned_at: '2026-09-17', scan_frequency: 'daily', failure_count: 5 }, '2026-09-18') === false
);

let freq = await recordScan(env, src, { ok: true, promotions_found: 2 });
check('a productive source earns a closer look', freq === 'daily' || freq === 'every3days', freq);
let quiet = one(`SELECT * FROM discovery_sources WHERE source_key = 'singsaver'`);
for (let i = 0; i < 6; i++) {
  quiet = one(`SELECT * FROM discovery_sources WHERE source_key = 'singsaver'`);
  freq = await recordScan(env, quiet, { ok: true, promotions_found: 0 });
}
check('a quiet one is checked less often', freq === 'monthly', freq);

// ------------------------------------------------------------------- the search
const broad = broadQueries(env);
check('broad queries cover this month and next', broad.some((q) => q.query.includes('September 2026')) && broad.some((q) => q.query.includes('October 2026')), broad.map((q) => q.query).join(' | '));
check('and each says why it exists', broad.every((q) => q.rationale.length > 0));
check('an issuer domain is known', domainFor('Citi') === 'citibank.com.sg', String(domainFor('Citi')));
check('and an unknown issuer has none', domainFor('Nowhere Bank') === null);
const official = officialQueries('citibank.com.sg', { product: 'Citi Rewards', reward: '16,000' });
check('official search is scoped to the issuer', official[0].query.startsWith('site:citibank.com.sg'), official[0]?.query);
check('and one looks for a PDF', official.some((q) => q.query.includes('filetype:pdf')));
check('the next issue of a series is guessable', seriesQueries(env, ['Credit Card Sign-up Bonuses — September 2026'])[0].query.includes('October 2026'));
check('the search budget is small by default', budgetFor(env, 'daily').limit <= 15);
const planned = await plannedQueries(env, 'daily');
check('and a plan never exceeds it', planned.queries.length <= planned.budget.limit, `${planned.queries.length}/${planned.budget.limit}`);

// -------------------------------------------------------------- the escalation
check('one source is worth looking further for', shouldEscalate({ independent_sources: 1, official_source: false }).escalate === true);
check('two agreeing is not', shouldEscalate({ independent_sources: 2, official_source: false }).escalate === false);
check('and an official confirmation certainly is not', shouldEscalate({ independent_sources: 1, official_source: true }).escalate === false);

// ------------------------------------------------------------------ resolution
// the catalogue seed already generates the alias 'citi rewards' for this product,
// so resolution is tested against the real seeded data rather than a planted row.
const pid = one(`SELECT id FROM card_products WHERE product_key = 'citi_rewards'`).id;
check('the seed generated the alias we resolve by',
  one(`SELECT COUNT(*) AS n FROM card_product_aliases WHERE alias_key = 'citi rewards' AND product_id = ?`, pid).n === 1);

let resolved = await resolveProduct(env, 'Citi Rewards', 'Citi');
check('an alias resolves the card', resolved.resolved_product_id === pid, String(resolved.resolved_product_id));
check('with high confidence', resolved.confidence === 'high');
check('and the raw name is kept', resolved.raw_product_name === 'Citi Rewards');

resolved = await resolveProduct(env, 'Some Card Nobody Has', 'Nowhere');
check('an unknown card is not guessed at', resolved.resolved_product_id === null);
check('it is marked for review', resolved.needs_review === true);

// ---------------------------------------------------------------- roundup diff
const september: RoundupEntry[] = [
  { key: '1', title: 'Citi Rewards', issuer: 'Citi', product_id: null, reward: '16000 miles', minimum_spend_cents: 80000, end_at: '2026-09-30' },
  { key: '2', title: 'DBS Altitude', issuer: 'DBS', product_id: null, reward: '38000 miles', minimum_spend_cents: 150000, end_at: '2026-09-30' },
  { key: '3', title: 'HSBC Revolution', issuer: 'HSBC', product_id: null, reward: '16800 miles', minimum_spend_cents: 80000, end_at: '2026-09-30' },
];
const october: RoundupEntry[] = [
  { key: '1', title: 'Citi Rewards', issuer: 'Citi', product_id: null, reward: '20000 miles', minimum_spend_cents: 80000, end_at: '2026-10-31' },
  { key: '2', title: 'DBS Altitude', issuer: 'DBS', product_id: null, reward: '38000 miles', minimum_spend_cents: 150000, end_at: '2026-09-30' },
  { key: '4', title: "UOB Lady's", issuer: 'UOB', product_id: null, reward: '18000 miles', minimum_spend_cents: 100000, end_at: '2026-10-31' },
];
const diffs = diffRoundups(september, october);
check('a changed offer is reported as changed', diffs.find((d) => d.entry.title === 'Citi Rewards')!.change === 'changed');
check('with the change in words', diffs.find((d) => d.entry.title === 'Citi Rewards')!.detail.includes('16000 miles → 20000 miles'));
check('an unchanged one is unchanged', diffs.find((d) => d.entry.title === 'DBS Altitude')!.change === 'unchanged');
check('a new one is new', diffs.find((d) => d.entry.title === "UOB Lady's")!.change === 'new');
check('and a missing one is only POSSIBLY expired', diffs.find((d) => d.entry.title === 'HSBC Revolution')!.change === 'possibly_expired');
check(
  'because a roundup is one publication’s view',
  diffs.find((d) => d.entry.title === 'HSBC Revolution')!.detail.includes('may have ended'),
  diffs.find((d) => d.entry.title === 'HSBC Revolution')?.detail
);
check('the interesting changes come first', diffs[0].change !== 'unchanged', diffs.map((d) => d.change).join(','));

// --------------------------------------------------------------- the pipeline
const feed = `<?xml version="1.0"?><rss><channel>
  <item><title>Citi Rewards: 16,000 bonus miles with $800 spend</title><link>https://milelion.test/citi-rewards</link><pubDate>Wed, 16 Sep 2026 00:00:00 GMT</pubDate></item>
  <item><title>Review: the new Hilton in Orchard</title><link>https://milelion.test/hilton</link><pubDate>Tue, 15 Sep 2026 00:00:00 GMT</pubDate></item>
</channel></rss>`;
responses.set('https://milelion.com/feed/', { status: 200, body: feed });
responses.set('https://milelion.test/robots.txt', { status: 404, body: '' });
responses.set('https://milelion.test/citi-rewards', {
  status: 200,
  body: `<html><head><title>Citi Rewards: 16,000 bonus miles</title></head><body><p>Citi Rewards Card: get 16,000 bonus miles when you spend $800 within 30 days. Ends 30 Sep 2026.</p></body></html>`,
});

// Only one source is due, so the scan is deterministic about which feed it reads.
sql(`UPDATE discovery_sources SET last_scanned_at = '2026-09-18'`);
sql(`UPDATE discovery_sources SET last_scanned_at = NULL WHERE source_key = 'milelion'`);
const found = await discover(env, { limit: 1, fetchImpl: fakeFetch });
check('a feed scan finds articles', found.items_found >= 1, JSON.stringify(found));
check('and files the irrelevant one away', one(`SELECT status FROM discovery_items WHERE canonical_url LIKE '%hilton%'`).status === 'irrelevant');

const extracted = await extractPending(env, { limit: 2, fetchImpl: fakeFetch });
check('the relevant one is read', extracted.candidates_created >= 1, JSON.stringify(extracted));
const candidate = one(`SELECT * FROM promotion_candidates ORDER BY id DESC LIMIT 1`);
check('a candidate is created, not a promotion', candidate.status === 'extracted', candidate?.status);
check('with its claims', all(`SELECT * FROM promotion_claims WHERE candidate_id = ?`, candidate.id).length >= 3);
check('each keeping the URL it came from', all(`SELECT * FROM promotion_claims WHERE candidate_id = ?`, candidate.id).every((c) => c.source_url.startsWith('https://')));
check('and only an excerpt, never the article', all(`SELECT * FROM promotion_claims WHERE candidate_id = ?`, candidate.id).every((c) => (c.supporting_excerpt ?? '').length <= 240));
check('nothing was published yet', all(`SELECT * FROM promotions WHERE source_type = 'discovery'`).length === 0);

const corroborated = await corroboratePending(env, { limit: 5 });
check('one source is not enough to publish', corroborated.published === 0, JSON.stringify(corroborated));
check('so it waits for a person', corroborated.held_for_review >= 1, JSON.stringify(corroborated));
check('and the candidate says so', one(`SELECT status FROM promotion_candidates WHERE id = ?`, candidate.id).status === 'review');

// ---------------------------------------------------------------- the review
const queue = await reviewQueue(env);
check('the review queue has it', queue.length >= 1, String(queue.length));
check('with the evidence already gathered', queue[0].evidence.length > 0, JSON.stringify(queue[0]?.evidence?.length));
check('the sources listed', queue[0].sources.length >= 1);
check('and a reason it is being asked', typeof queue[0].review_reason === 'string' && queue[0].review_reason!.length > 0, String(queue[0]?.review_reason));

const approved = await approveCandidate(env, queue[0].candidate_id);
check('approving publishes it', approved.ok === true, approved.error);
check('as a promotion the rest of the app can read', all(`SELECT * FROM promotions WHERE source_type = 'discovery'`).length === 1);
check('with a version recorded', all(`SELECT * FROM promotion_versions`).length === 1);
check('and a change event', one(`SELECT change_type FROM promotion_change_events ORDER BY id DESC LIMIT 1`).change_type === 'created');
const promoted = one(`SELECT * FROM promotions WHERE source_type = 'discovery'`);
check('the terms came through', JSON.parse(promoted.terms_json).reward_miles === 16000, promoted.terms_json);
check('the claims now point at the promotion', all(`SELECT * FROM promotion_claims WHERE promotion_id = ?`, promoted.id).length >= 3);

// An edit during review is the strongest evidence there is.
sql(`INSERT INTO promotion_candidates (promotion_type, issuer, raw_product_name, terms_json, status, application_channel)
     VALUES ('welcome_offer','Citi','Rewards Card', ?, 'review', 'issuer_direct')`,
  JSON.stringify({ reward_miles: 1, minimum_spend_cents: 80000, application_end: '2026-12-31' }));
const edited = one(`SELECT id FROM promotion_candidates ORDER BY id DESC LIMIT 1`).id;
sql(`INSERT INTO promotion_claims (candidate_id, field_name, value_json, source_url, source_type, source_tier, extracted_at, confidence)
     VALUES (?, 'reward_miles', '1', 'https://milelion.test/x', 'article', 2, '2026-09-18', 'low')`, edited);
const fixed = await approveCandidate(env, edited, { reward_miles: 20000, minimum_spend_cents: 80000 });
check('a correction made during review is accepted', fixed.ok === true, fixed.error);
check(
  'and recorded as the strongest kind of evidence',
  one(`SELECT source_tier FROM promotion_claims WHERE candidate_id = ? AND source_url = 'app://review'`, edited).source_tier === 1
);

check('a term diff names only what moved', diffTerms({ reward_miles: 16000, minimum_spend_cents: 80000 }, { reward_miles: 20000, minimum_spend_cents: 80000 }).length === 1);

// ---------------------------------------------------------------------- expiry
sql(`UPDATE promotions SET end_at = '2026-08-01', status = 'published' WHERE id = ?`, promoted.id);
const swept = await expireFinished(env);
check('an offer that has ended expires', swept.expired.length >= 1, JSON.stringify(swept));
check('but is never deleted', one(`SELECT id FROM promotions WHERE id = ?`, promoted.id) !== undefined);
check('and the expiry is recorded', one(`SELECT change_type FROM promotion_change_events WHERE promotion_id = ? ORDER BY id DESC LIMIT 1`, promoted.id).change_type === 'expired');

sql(`UPDATE promotions SET status = 'published', end_at = '2026-08-01' WHERE id = ?`, promoted.id);
sql(`INSERT INTO promotion_candidates (promotion_id, promotion_type, issuer, status, application_channel)
     VALUES (?, 'welcome_offer', 'Citi', 'review', 'issuer_direct')`, promoted.id);
const held = await expireFinished(env);
check('an offer with an extension waiting is held back', held.kept.length >= 1, JSON.stringify(held));
check('rather than disappearing and coming back', one(`SELECT status FROM promotions WHERE id = ?`, promoted.id).status === 'published');

// ------------------------------------------------------------ official attempt
responses.set('https://citibank.test/robots.txt', { status: 200, body: 'User-agent: *\nDisallow: /' });
let attempt = await verifyOfficial(env, { issuer: 'Citi', product_name: 'Citi Rewards' }, ['https://citibank.test/promo'], { fetchImpl: fakeFetch });
check('an issuer that says no is not pushed', attempt.official_verified === false, JSON.stringify(attempt));
check('the reason is recorded', attempt.status === 'robots_disallowed', String(attempt.status));
check('and a search is suggested instead of a retry', attempt.suggested_queries.length > 0);

attempt = await verifyOfficial(env, { issuer: 'Citi' }, [], { fetchImpl: fakeFetch });
check('no official link means no attempt', attempt.attempted === false);
check('with searches offered', attempt.suggested_queries.some((q) => q.includes('site:citibank.com.sg')));

attempt = await verifyOfficial(env, { issuer: 'Nowhere Bank' }, ['https://x.test/a'], { fetchImpl: fakeFetch });
check('an issuer with no known domain is not verified', attempt.official_verified === false);
check('and says why', (attempt.reason ?? '').includes('no official domain'), String(attempt.reason));

// -------------------------------------------------------------------- variants
// One campaign is rarely one offer, and flattening it forces a choice between
// showing a number this person cannot get and hiding one they can.
check('a new-customer rule is read', variantAudienceOf('New-to-bank customers only.') === 'new_customer');
check('an existing-customer rule too', variantAudienceOf('For existing cardholders only') === 'existing');
check('and an invitation is not a public offer', variantAudienceOf('Targeted — emailed to selected customers') === 'targeted');
check('but a vague sentence is left alone', variantAudienceOf('Terms and conditions apply.') === 'everyone');

sql(`UPDATE promotions SET status = 'published', end_at = '2026-12-31' WHERE id = ?`, promoted.id);
await saveVariant(env, promoted.id, {
  audience: 'everyone',
  application_channel: 'issuer_direct',
  minimum_spend_cents: 80000,
  reward: { miles: 16000 },
});
await saveVariant(env, promoted.id, {
  audience: 'new_customer',
  application_channel: 'singsaver',
  minimum_spend_cents: 80000,
  reward: { miles: 25000 },
});
let vlist = await variantsFor(env, promoted.id);
check('each shape is its own row', vlist.length >= 2, String(vlist.length));

await saveVariant(env, promoted.id, {
  audience: 'new_customer',
  application_channel: 'singsaver',
  minimum_spend_cents: 80000,
  reward: { miles: 28000 },
});
const after = await variantsFor(env, promoted.id);
check('seeing the same shape again updates it', after.length === vlist.length, `${vlist.length} → ${after.length}`);
check('with the newer number', JSON.parse(after.find((v) => v.variant_key === 'new_customer@singsaver')!.reward_json!).miles === 28000);

const range = spread(after, 1.5);
check('what it pays is a range when the shapes disagree', range.varies === true, range.text ?? '');
check('and the range names both ends', (range.text ?? '').includes('16,000') && (range.text ?? '').includes('28,000'), range.text ?? '');

// The card is held, so the new-customer variant is not this person's, and the
// app says why rather than quietly showing the bigger number.
const heldViews = viewVariants(after, { holds_card: true, existing_customer: true, invited_keys: [] });
const nc = heldViews.find((v) => v.variant.audience === 'new_customer')!;
check('a new-customer offer is not offered to a holder', nc.available === false);
check('and the reason is the sentence, not silence', (nc.blocker ?? '').includes('already hold'), nc.blocker ?? '');
check('the open one is still open', heldViews.find((v) => v.variant.audience === 'everyone')!.available === true);

const fresh = viewVariants(after, { holds_card: false, existing_customer: false, invited_keys: [] });
check('and somebody without the card can take it', fresh.find((v) => v.variant.audience === 'new_customer')!.available === true);

// A targeted offer is the one thing the app cannot read anywhere.
let contributed = await contributeTargeted(env, promoted.id, { reward: {}, note: 'nothing' });
check('a targeted offer without a reward is refused', contributed.ok === false, JSON.stringify(contributed));

contributed = await contributeTargeted(env, promoted.id, {
  reward: { miles: 40000 },
  minimum_spend_cents: 100000,
  note: 'emailed 12 Sep',
});
check('one with a reward is kept', contributed.ok === true, JSON.stringify(contributed));
const mine = (await variantsFor(env, promoted.id)).find((v) => v.audience === 'targeted');
check('as its own variant', !!mine);
check('and it does not become the public offer', JSON.parse(one(`SELECT terms_json FROM promotions WHERE id = ?`, promoted.id).terms_json).reward_miles === 16000);
check(
  'the person is recorded as the source',
  one(`SELECT source_tier FROM promotion_claims WHERE promotion_id = ? AND source_url = 'app://contributed'`, promoted.id).source_tier === 1
);

const uninvited = viewVariants(await variantsFor(env, promoted.id), {
  holds_card: true,
  existing_customer: true,
  invited_keys: [],
});
check(
  'a targeted offer nobody was invited to is not presented as available',
  uninvited.find((v) => v.variant.audience === 'targeted')!.available === false
);

// --------------------------------------------------------------- why current
const rated = await rate(env, one(`SELECT * FROM promotions WHERE id = ?`, promoted.id));
check('the offer says how sure the app is', typeof rated.currency.text === 'string' && rated.currency.text.length > 0, rated.currency.text);
check('and how many sites said it', typeof rated.currency.independent_sources === 'number');
check('a range is shown rather than the best number', rated.pays_varies === true, String(rated.pays));
check('the variants come with it', rated.variants.length >= 3, String(rated.variants.length));

const ev = (await promotionEvidence(env, promoted.id))!;
check('the evidence screen has the promotion', ev.promotion.id === promoted.id);
check('with a sentence at the top', ev.headline.length > 0, ev.headline);
check('the sources it was read from', ev.sources.length >= 1, String(ev.sources.length));
check('each with the host shown plainly', ev.sources.every((s) => s.host.length > 0 && !s.host.startsWith('www.')));
check('one article claiming five fields is one source', ev.sources.length <= (ev.fields.reduce((n, f) => n + f.claims.length, 0)));
check('the fields it knows', ev.fields.length >= 1);
check('and what has changed since', ev.timeline.length >= 1, String(ev.timeline.length));
check('said as a sentence rather than two blobs', ev.timeline.every((t) => t.detail.length > 0 && !t.detail.includes('{')));
check('the variants are on it too', ev.variants.length >= 3);

// A disagreement survives all the way to the person.
sql(`INSERT INTO promotion_claims (promotion_id, field_name, value_json, source_url, source_type, source_tier, extracted_at, confidence, supporting_excerpt)
     VALUES (?, 'reward_miles', '19000', 'https://other.test/a', 'article', 3, '2026-09-18', 'medium', 'we saw 19,000')`, promoted.id);
const ev2 = (await promotionEvidence(env, promoted.id))!;
const rewardField = ev2.fields.find((f) => f.field === 'reward_miles')!;
check('two sources disagreeing is visible', rewardField.agreed === false);
check('with both readings kept', rewardField.claims.length >= 2, String(rewardField.claims.length));
check('and each attributed', rewardField.claims.every((c) => c.hosts.length > 0));

check('an extension reads as one', changeSentence({ change_type: 'extended', old_value_json: null, new_value_json: '{"application_end":"2026-12-31"}' }).includes('2026-12-31'));
check('and an unsourced offer says so', (await promotionEvidence(env, 999999)) === null);

// ---------------------------------------------------------------------- status
const status = await discoveryStatus(env);
check('the status reports the sources', status.sources.total >= 5, JSON.stringify(status.sources));
check('what each stage is holding', typeof status.items === 'object' && typeof status.candidates === 'object');
check('and what is left for a person', typeof status.today.awaiting_review === 'number', JSON.stringify(status.today));

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
