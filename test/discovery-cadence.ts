/**
 * Cadence, seeding, and the vocabulary the two halves of the app share.
 *
 * These three things caused the same failure in different ways: the pipeline
 * looked fine while doing nothing. A feed that carried four offers was recorded
 * as zero-yield and demoted toward monthly; the screen counted a status string
 * the backend never writes and displayed an empty queue; and a deployment that
 * skipped the seed reported a healthy system with nothing to read.
 *
 * So each is asserted directly, and the most important assertions are the
 * negative ones — what must NOT happen after one quiet scan.
 */
import { DatabaseSync } from 'node:sqlite';
import { runMigrations, runSeed } from '../src/migrate';
import { discover, recordDiscoveryItem, runDiscoveryPipeline, scanFeed } from '../src/promotions/discovery/run';
import {
  FREQUENCY_ORDER,
  MIN_SCANS_FOR_ADAPTATION,
  healthOf,
  moveOneStep,
  recordScan,
  seedSources,
  sourceHealth,
  sourcesConfigured,
  targetFrequency,
  type DiscoverySource,
} from '../src/promotions/discovery/sources';
import { CANDIDATE_STATUSES, DISCOVERY_ITEM_STATUSES } from '../shared/discovery';
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

// --------------------------------------------------------------- the seeding
check('seeding produces sources', await sourcesConfigured(env));
const seeded = all(`SELECT * FROM discovery_sources ORDER BY source_key`);
check('and there is exactly one definition of them', seeded.length >= 5, String(seeded.length));

const lion = () => one(`SELECT * FROM discovery_sources WHERE source_key = 'milelion'`);
check('the most productive source runs daily', lion().scan_frequency === 'daily', lion().scan_frequency);
check('and its configured cadence is recorded separately', lion().base_scan_frequency === 'daily');
check('so it can be told apart from where adaptation moved it', lion().adaptive_frequency === 0);
check('search cadence is not left to yield either', one(`SELECT adaptive_frequency FROM discovery_sources WHERE source_key='search'`).adaptive_frequency === 0);
check('a comparison site may adapt', one(`SELECT adaptive_frequency FROM discovery_sources WHERE source_key='moneysmart'`).adaptive_frequency === 1);

// Seeding again is the repair for a source adaptation demoted. This is the
// production fix, so it is asserted rather than assumed.
sql(`UPDATE discovery_sources SET scan_frequency = 'monthly' WHERE source_key = 'milelion'`);
await seedSources(env);
check('re-seeding repairs a pinned source that drifted', lion().scan_frequency === 'daily', lion().scan_frequency);

sql(`UPDATE discovery_sources SET scan_frequency = 'weekly' WHERE source_key = 'moneysmart'`);
await seedSources(env);
check(
  'but leaves an adapting source where adaptation put it',
  one(`SELECT scan_frequency FROM discovery_sources WHERE source_key='moneysmart'`).scan_frequency === 'weekly'
);

// --------------------------------------------------------------- the cadence
check('frequencies run fastest to slowest', FREQUENCY_ORDER[0] === 'daily' && FREQUENCY_ORDER[3] === 'monthly');
check('a step away from daily is every 3 days', moveOneStep('daily', 'monthly') === 'every3days');
check('never straight to monthly', moveOneStep('daily', 'monthly') !== 'monthly');
check('and a step back is one step too', moveOneStep('monthly', 'daily') === 'weekly');
check('a source already where it should be does not move', moveOneStep('weekly', 'weekly') === 'weekly');

check('a productive score asks for daily', targetFrequency(0.9) === 'daily');
check('a quiet one asks for monthly', targetFrequency(0) === 'monthly');

const source = (over: Partial<DiscoverySource> = {}): DiscoverySource =>
  ({
    id: 0,
    source_key: 'x',
    name: 'X',
    source_type: 'rss',
    base_url: null,
    feed_url: 'https://x.test/feed',
    trust_tier: 2,
    scan_frequency: 'daily',
    issuer: null,
    content_scope: null,
    last_scanned_at: null,
    last_success_at: null,
    failure_count: 0,
    change_frequency_score: 0,
    promotions_found: 0,
    scans: 0,
    successes: 0,
    base_scan_frequency: 'daily',
    adaptive_frequency: 1,
    last_items_seen: null,
    last_items_new: null,
    last_relevant_new: null,
    last_error: null,
    active: 1,
    ...over,
  }) as DiscoverySource;

sql(`INSERT INTO discovery_sources (source_key, name, source_type, feed_url, trust_tier, scan_frequency, base_scan_frequency)
     VALUES ('t_adapt','Adapting','rss','https://a.test/feed',2,'daily','daily')`);
const adapting = () => one(`SELECT * FROM discovery_sources WHERE source_key = 't_adapt'`);

// The bug this whole file exists for: one quiet scan of a brand-new source
// must not decide its schedule.
let freq = await recordScan(env, adapting(), { ok: true, items_seen: 20, items_found: 0, relevant_items_found: 0 });
check('one quiet scan does not demote a daily source', freq === 'daily', freq);
check('and nothing was written to the contrary', adapting().scan_frequency === 'daily');

for (let i = 0; i < 3; i++) {
  await recordScan(env, adapting(), { ok: true, items_seen: 20, items_found: 0, relevant_items_found: 0 });
}
check('nor do four', adapting().scan_frequency === 'daily', `${adapting().scans} scans`);
check('because adaptation waits for evidence', adapting().scans < MIN_SCANS_FOR_ADAPTATION + 1);

freq = await recordScan(env, adapting(), { ok: true, items_seen: 20, items_found: 0, relevant_items_found: 0 });
check('after the warm-up a persistently quiet source slows down', freq === 'every3days', freq);
check('by exactly one step', adapting().scan_frequency === 'every3days');

// And the opposite: a source that carries offers keeps its cadence.
sql(`INSERT INTO discovery_sources (source_key, name, source_type, feed_url, trust_tier, scan_frequency, base_scan_frequency, scans, successes, change_frequency_score)
     VALUES ('t_busy','Busy','rss','https://b.test/feed',2,'daily','daily',10,10,0.9)`);
const busy = () => one(`SELECT * FROM discovery_sources WHERE source_key = 't_busy'`);
await recordScan(env, busy(), { ok: true, items_seen: 20, items_found: 4, relevant_items_found: 3 });
check('a productive source stays daily', busy().scan_frequency === 'daily', busy().scan_frequency);
check('and the yield it earned is recorded', busy().promotions_found === 3, String(busy().promotions_found));
check('with what the last scan actually saw', busy().last_items_seen === 20 && busy().last_relevant_new === 3);

sql(`INSERT INTO discovery_sources (source_key, name, source_type, feed_url, trust_tier, scan_frequency, base_scan_frequency, adaptive_frequency, scans)
     VALUES ('t_pinned','Pinned','rss','https://c.test/feed',2,'daily','daily',0,20)`);
const pinned = () => one(`SELECT * FROM discovery_sources WHERE source_key = 't_pinned'`);
for (let i = 0; i < 6; i++) {
  await recordScan(env, pinned(), { ok: true, items_seen: 20, items_found: 0, relevant_items_found: 0 });
}
check('a pinned source never moves, however quiet', pinned().scan_frequency === 'daily', pinned().scan_frequency);

// A failure is not a quiet scan, and the reason survives.
sql(`INSERT INTO discovery_sources (source_key, name, source_type, feed_url, trust_tier, scan_frequency, base_scan_frequency)
     VALUES ('t_fail','Failing','rss','https://d.test/feed',3,'weekly','weekly')`);
const failing = () => one(`SELECT * FROM discovery_sources WHERE source_key = 't_fail'`);
await recordScan(env, failing(), { ok: false, note: 'the feed returned 403' });
check('a failed scan counts as a failure', failing().failure_count === 1);
check('and the reason is kept verbatim', failing().last_error === 'the feed returned 403', String(failing().last_error));
await recordScan(env, failing(), { ok: false, note: 'the feed returned 403' });
await recordScan(env, failing(), { ok: false, note: 'the feed returned 403' });

// ---------------------------------------------------------------- the health
const health = await sourceHealth(env, { searchConfigured: false });
const byKey = (k: string) => health.find((h) => h.source.source_key === k)!;

check('a never-scanned source says exactly that', byKey('singsaver').state === 'never_scanned', byKey('singsaver').state);
check('with no euphemism', byKey('singsaver').note === 'Never scanned.', byKey('singsaver').note);

check('a source with no search key is not healthy', byKey('search').state === 'not_configured', byKey('search').state);
check('and says what is missing', byKey('search').note.includes('SEARCH_API_KEY'), byKey('search').note);

check('a repeatedly failing source says how many times', byKey('t_fail').state === 'failing', byKey('t_fail').state);
check('and when it will try again', byKey('t_fail').note.includes('Next attempt in'), byKey('t_fail').note);
check('and why it failed', byKey('t_fail').note.includes('403'), byKey('t_fail').note);

check('a source that works but carries nothing is quiet, not broken', byKey('t_adapt').state === 'quiet', byKey('t_adapt').state);
check(
  'and the difference is said out loud',
  byKey('t_adapt').note === 'Scanned successfully; no relevant articles found yet.',
  byKey('t_adapt').note
);
check(
  'a productive one reports what it found',
  byKey('t_busy').state === 'healthy' && byKey('t_busy').note.includes('3 relevant'),
  `${byKey('t_busy').state}: ${byKey('t_busy').note}`
);
check('with the last scan attached', byKey('t_busy').last_result?.items_seen === 20);

const configured = healthOf(source({ source_type: 'search', last_scanned_at: '2026-09-18', scans: 1, successes: 1 }), '2026-09-18', {
  searchConfigured: true,
});
check('a configured search source is judged like any other', configured.state !== 'not_configured', configured.state);

// ------------------------------------------------------------------ the feed
// The original bug end to end: a feed carrying offers must be recorded as
// productive, not as zero-yield.
const feed = `<?xml version="1.0"?><rss><channel>
  <item><title>Citi Rewards: 16,000 bonus miles with $800 spend</title><link>https://f.test/a</link><pubDate>Wed, 16 Sep 2026 00:00:00 GMT</pubDate></item>
  <item><title>DBS Altitude: 38,000 bonus miles</title><link>https://f.test/b</link><pubDate>Wed, 16 Sep 2026 00:00:00 GMT</pubDate></item>
  <item><title>Best credit card sign-up bonuses — October 2026</title><link>https://f.test/c</link><pubDate>Wed, 16 Sep 2026 00:00:00 GMT</pubDate></item>
  <item><title>Review: the new Hilton in Orchard</title><link>https://f.test/d</link><pubDate>Tue, 15 Sep 2026 00:00:00 GMT</pubDate></item>
</channel></rss>`;
const fakeFetch = (async (url: any) => ({
  ok: String(url).includes('f.test'),
  status: String(url).includes('f.test') ? 200 : 404,
  url: String(url),
  headers: { get: () => 'application/rss+xml' },
  text: async () => (String(url).includes('f.test') ? feed : ''),
})) as unknown as typeof fetch;

sql(`INSERT INTO discovery_sources (source_key, name, source_type, feed_url, trust_tier, scan_frequency, base_scan_frequency)
     VALUES ('t_feed','Feed','rss','https://f.test/feed',2,'daily','daily')`);
const feedSource = one(`SELECT * FROM discovery_sources WHERE source_key = 't_feed'`);
const scanned = await scanFeed(env, feedSource, fakeFetch);

check('every entry the feed offered is counted', scanned.items_seen === 4, String(scanned.items_seen));
check('the new URLs are counted apart from them', scanned.items_new === 4, String(scanned.items_new));
// Two, not three: the classifier will not treat "DBS Altitude: 38,000 bonus
// miles" as a promotion on a reward figure alone, and being wrong in that
// direction costs a fetch rather than a false offer.
check('and the relevant ones apart from those', scanned.relevant_new === 2, String(scanned.relevant_new));
check('the hotel review is not one of them', scanned.relevant_new < scanned.items_new);
check('the note says all three numbers', scanned.note.includes('4 entries') && scanned.note.includes('2 about offers'), scanned.note);

await recordScan(env, feedSource, {
  ok: scanned.ok,
  items_seen: scanned.items_seen,
  items_found: scanned.items_new,
  relevant_items_found: scanned.relevant_new,
});
const after = one(`SELECT * FROM discovery_sources WHERE source_key = 't_feed'`);
check('a feed carrying offers is recorded as productive', after.promotions_found === 2, String(after.promotions_found));
check('not as zero-yield', after.change_frequency_score > 0, String(after.change_frequency_score));
check('and it is still read daily', after.scan_frequency === 'daily', after.scan_frequency);

const rescan = await scanFeed(env, one(`SELECT * FROM discovery_sources WHERE source_key='t_feed'`), fakeFetch);
check('reading the same feed again finds the same entries', rescan.items_seen === 4);
check('and no new URLs', rescan.items_new === 0, String(rescan.items_new));
check('which is said differently from an empty feed', rescan.note.includes('all seen before'), rescan.note);

check('the classifier’s reasoning is kept', typeof one(`SELECT classification_score FROM discovery_items WHERE canonical_url LIKE '%f.test/a%'`).classification_score === 'number');
check(
  'with the words that triggered it',
  JSON.parse(one(`SELECT classification_signals_json FROM discovery_items WHERE canonical_url LIKE '%f.test/a%'`).classification_signals_json).length > 0
);
check('and how it was found', all(`SELECT * FROM discovery_item_sources`).length >= 4, String(all(`SELECT * FROM discovery_item_sources`).length));

// One article, however many ways it was found.
const first = await recordDiscoveryItem(env, {
  source_id: feedSource.id,
  url: 'https://f.test/shared',
  canonical_url: 'https://f.test/shared',
  title: 'Shared',
  published_at: null,
  item_type: 'promotion_related',
  status: 'new',
});
const searchId = one(`SELECT id FROM discovery_sources WHERE source_key = 'search'`).id;
const second = await recordDiscoveryItem(env, {
  source_id: searchId,
  url: 'https://f.test/shared',
  canonical_url: 'https://f.test/shared',
  title: 'Shared',
  published_at: null,
  item_type: 'promotion_related',
  status: 'new',
  search_query: 'citi rewards promotion',
});
check('an article found twice is one article', second.id === first.id, `${first.id} vs ${second.id}`);
check('and the second finding is not a new row', second.created === false);
check('but both ways in are kept', all(`SELECT * FROM discovery_item_sources WHERE discovery_item_id = ?`, first.id).length === 2);
check('including the query that found it', one(`SELECT search_query FROM discovery_item_sources WHERE discovery_item_id = ? AND source_id = ?`, first.id, searchId).search_query === 'citi rewards promotion');

// ------------------------------------------------------------ one action
sql(`UPDATE discovery_sources SET active = 0 WHERE source_key <> 't_feed'`);
sql(`UPDATE discovery_sources SET last_scanned_at = NULL WHERE source_key = 't_feed'`);
const pipeline = await runDiscoveryPipeline(env, { max_cycles: 2, fetchImpl: fakeFetch });
check('one action runs every stage', pipeline.summary.stage === 'run-all');
check('and says how many cycles it took', pipeline.cycles >= 1 && pipeline.cycles <= 2, String(pipeline.cycles));
check('stopping when there is nothing left rather than at a timer', ['no_work_left', 'cycle_limit'].includes(pipeline.stopped_because));
check('the summary carries the whole funnel', typeof pipeline.summary.articles_fetched === 'number');
check('each stage is also reported separately', pipeline.discover.stage === 'discover' && pipeline.extract.stage === 'extract');

const runs = all(`SELECT * FROM discovery_runs ORDER BY id DESC`);
check('the run is recorded in history', runs.length >= 1);
check('with when it started and finished', !!runs[0].started_at && !!runs[0].finished_at);
check('and whether it worked', runs[0].success === 1, JSON.stringify(runs[0].error));

// ----------------------------------------------------- the shared vocabulary
// The contract test. The backend wrote `new` while the screen counted
// `pending`, and nothing objected until a person noticed an empty queue.
const itemStates = new Set(all(`SELECT DISTINCT status AS s FROM discovery_items`).map((r) => r.s));
for (const s of itemStates) {
  check(`the database only writes states the app knows: ${s}`, (DISCOVERY_ITEM_STATUSES as readonly string[]).includes(s));
}
check('and "pending" is not one of them', !(DISCOVERY_ITEM_STATUSES as readonly string[]).includes('pending'));

const candStates = new Set(all(`SELECT DISTINCT status AS s FROM promotion_candidates`).map((r) => r.s));
for (const s of candStates) {
  check(`candidates too: ${s}`, (CANDIDATE_STATUSES as readonly string[]).includes(s));
}

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
