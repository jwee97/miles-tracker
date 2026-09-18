import { today } from '../../spend';
import type { Env } from '../../types';
import { type ScanFrequency, type SourceState } from '../../../shared/discovery';

export type { ScanFrequency };

/**
 * Where promotions are found, and how much each place is worth.
 *
 * The architecture this exists to support: banks are one source among several
 * rather than the system's dependency. A specialist article, a comparison site
 * and an indexed official PDF are three sensors reporting the same event, and
 * losing any one of them degrades confidence instead of stopping discovery.
 */

export type SourceType = 'rss' | 'search' | 'website' | 'official_page' | 'official_pdf' | 'manual';

/**
 * Trust tiers. Lower is stronger, and the gaps matter: no number of secondary
 * sources adds up to an official one, because they are frequently all quoting
 * the same press release.
 */
export const TIER = {
  official: 1,
  specialist: 2,
  comparison: 3,
  search: 4,
  unknown: 5,
} as const;

/** The internal score a tier is worth. Never shown to a person. */
export const TIER_SCORE: Record<number, number> = {
  1: 100,
  2: 80,
  3: 75,
  4: 30,
  5: 20,
};

export interface DiscoverySource {
  id: number;
  source_key: string;
  name: string;
  source_type: SourceType;
  base_url: string | null;
  feed_url: string | null;
  trust_tier: number;
  scan_frequency: ScanFrequency;
  issuer: string | null;
  content_scope: string | null;
  last_scanned_at: string | null;
  last_success_at: string | null;
  failure_count: number;
  change_frequency_score: number;
  promotions_found: number;
  scans: number;
  successes: number;
  /** What this source should normally run at, before adaptation moved it. */
  base_scan_frequency: ScanFrequency | null;
  /** 0 pins the cadence — the sources worth most are not left to a quiet week. */
  adaptive_frequency: number;
  last_items_seen: number | null;
  last_items_new: number | null;
  last_relevant_new: number | null;
  /** Why the last scan failed, kept verbatim so the reason survives to a screen. */
  last_error: string | null;
  active: number;
}

/** How many days between scans at each frequency. */
export const CADENCE: Record<ScanFrequency, number> = {
  daily: 1,
  every3days: 3,
  weekly: 7,
  monthly: 30,
};

export interface SourceInput {
  source_key: string;
  name: string;
  source_type: SourceType;
  base_url?: string | null;
  feed_url?: string | null;
  trust_tier: number;
  scan_frequency?: ScanFrequency;
  issuer?: string | null;
  content_scope?: string | null;
  /** False pins the cadence: adaptation never moves this source. */
  adaptive?: boolean;
}

/**
 * Write a source, or bring an existing one back in line with its definition.
 *
 * The update deliberately resets `base_scan_frequency` and `adaptive_frequency`
 * but leaves `scan_frequency` alone — except for pinned sources, where the
 * configured cadence *is* the answer and a drifted one is damage to repair.
 * That is what makes re-seeding a fix for a source adaptation demoted rather
 * than a no-op.
 */
export async function upsertSource(env: Env, s: SourceInput): Promise<DiscoverySource> {
  const base = s.scan_frequency ?? 'weekly';
  const adaptive = s.adaptive === false ? 0 : 1;

  await env.DB.prepare(
    `INSERT INTO discovery_sources
       (source_key, name, source_type, base_url, feed_url, trust_tier, scan_frequency,
        base_scan_frequency, adaptive_frequency, issuer, content_scope)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_key) DO UPDATE SET
       name = excluded.name, source_type = excluded.source_type, base_url = excluded.base_url,
       feed_url = excluded.feed_url, trust_tier = excluded.trust_tier, issuer = excluded.issuer,
       content_scope = excluded.content_scope,
       base_scan_frequency = excluded.base_scan_frequency,
       adaptive_frequency = excluded.adaptive_frequency,
       scan_frequency = CASE WHEN excluded.adaptive_frequency = 0
                             THEN excluded.base_scan_frequency
                             ELSE discovery_sources.scan_frequency END`
  )
    .bind(
      s.source_key,
      s.name,
      s.source_type,
      s.base_url ?? null,
      s.feed_url ?? null,
      s.trust_tier,
      base,
      base,
      adaptive,
      s.issuer ?? null,
      s.content_scope ?? null
    )
    .run();

  return (await env.DB.prepare(`SELECT * FROM discovery_sources WHERE source_key = ?`)
    .bind(s.source_key)
    .first<DiscoverySource>())!;
}

export async function listSources(env: Env, onlyActive = true): Promise<DiscoverySource[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM discovery_sources ${onlyActive ? 'WHERE active = 1' : ''} ORDER BY trust_tier, name`
  ).all<DiscoverySource>();
  return results ?? [];
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);

/**
 * Whether a source is due.
 *
 * A source that keeps failing is backed off rather than retried on schedule:
 * hammering a site that has said no is both rude and useless, and the whole
 * design assumes some sources will be unavailable.
 */
export function isDue(s: DiscoverySource, now: string): boolean {
  if (!s.active) return false;
  if (!s.last_scanned_at) return true;

  let wait = CADENCE[s.scan_frequency] ?? 7;
  if (s.failure_count >= 3) wait = Math.min(30, wait * Math.min(8, s.failure_count));

  return daysBetween(now, s.last_scanned_at) >= wait;
}

export async function dueSources(env: Env, limit = 10): Promise<DiscoverySource[]> {
  const now = today(env);
  return (await listSources(env)).filter((s) => isDue(s, now)).slice(0, limit);
}

export interface ScanOutcome {
  ok: boolean;
  /** How many entries the source offered, new or not. */
  items_seen?: number;
  /** How many of those were URLs nobody had seen before. */
  items_found?: number;
  /**
   * How many of the new ones looked like they were about an offer.
   *
   * Named for what it is. The database column behind it is still
   * `promotions_found`, which was always a lie: discovery has not extracted a
   * promotion at this point and cannot know whether one exists.
   */
  relevant_items_found?: number;
  note?: string;
}

/** Slowest to fastest, so a cadence change can be one step rather than a cliff. */
export const FREQUENCY_ORDER: ScanFrequency[] = ['daily', 'every3days', 'weekly', 'monthly'];

/**
 * Before this many scans, cadence is left alone.
 *
 * One quiet Tuesday is not evidence about a publication. Without a warm-up the
 * very first scan of a brand-new daily source decides its schedule, and the
 * most valuable feed in the system can be demoted to monthly before it has
 * been read twice — which is exactly what happened.
 */
export const MIN_SCANS_FOR_ADAPTATION = 5;

/**
 * Move one step toward the target, never further.
 *
 * daily → monthly in a single update is not a cadence adjustment, it is
 * switching a source off. Adjacent movement means four quiet scans to get
 * there and four productive ones to come back, which is slow enough to be
 * evidence.
 */
export function moveOneStep(current: ScanFrequency, target: ScanFrequency): ScanFrequency {
  const from = FREQUENCY_ORDER.indexOf(current);
  const to = FREQUENCY_ORDER.indexOf(target);
  if (from < 0 || to < 0 || from === to) return current;
  return FREQUENCY_ORDER[from + (to > from ? 1 : -1)];
}

/** What the rolling yield score asks for, before the one-step rule applies. */
export function targetFrequency(score: number): ScanFrequency {
  if (score >= 0.4) return 'daily';
  if (score >= 0.2) return 'every3days';
  if (score >= 0.05) return 'weekly';
  return 'monthly';
}

/**
 * Record what a scan did, and let the source's cadence follow from it.
 *
 * A publication that keeps carrying offers earns a closer look; a static card
 * guide does not. Three rules keep that from turning into vandalism: a warm-up
 * period, one step at a time, and sources that opt out of adaptation entirely.
 */
export async function recordScan(env: Env, source: DiscoverySource, outcome: ScanOutcome): Promise<ScanFrequency> {
  const now = today(env);
  const scans = source.scans + 1;
  const successes = source.successes + (outcome.ok ? 1 : 0);
  const relevant = outcome.relevant_items_found ?? 0;
  const found = source.promotions_found + relevant;

  // A rolling average of how often a scan carries something worth reading.
  // Weighted toward history rather than toward now: the point is to notice a
  // source that has gone quiet for a month, not one that had a slow day.
  const yieldNow = relevant > 0 ? 1 : 0;
  const score = source.change_frequency_score * 0.8 + yieldNow * 0.2;

  let frequency: ScanFrequency = source.scan_frequency;
  const adaptive = source.adaptive_frequency !== 0 && source.source_type !== 'search';
  if (adaptive && scans >= MIN_SCANS_FOR_ADAPTATION) {
    frequency = moveOneStep(source.scan_frequency, targetFrequency(score));
  }

  await env.DB.prepare(
    `UPDATE discovery_sources
        SET last_scanned_at = ?, scans = ?, successes = ?, promotions_found = ?,
            change_frequency_score = ?, scan_frequency = ?,
            failure_count = ?, last_success_at = ?,
            last_items_seen = ?, last_items_new = ?, last_relevant_new = ?,
            last_error = ?
      WHERE id = ?`
  )
    .bind(
      now,
      scans,
      successes,
      found,
      Math.round(score * 1000) / 1000,
      frequency,
      outcome.ok ? 0 : source.failure_count + 1,
      outcome.ok ? now : source.last_success_at,
      outcome.items_seen ?? null,
      outcome.items_found ?? null,
      outcome.relevant_items_found ?? null,
      outcome.ok ? null : (outcome.note ?? 'the scan failed'),
      source.id
    )
    .run();

  return frequency;
}

export interface SourceHealth {
  source: DiscoverySource;
  state: SourceState;
  success_rate: number;
  days_since_success: number | null;
  /** What the most recent scan actually saw. */
  last_result: { items_seen: number | null; items_found: number | null; relevant_items_found: number | null } | null;
  /** True when the source has been failing long enough to be worth a look. */
  ailing: boolean;
  note: string;
}

/**
 * How one source is doing, said precisely.
 *
 * The old version answered everything with "Nothing found yet", which covered
 * a feed that had never been read, a feed that read fine and carried nothing,
 * and a search source with no API key. Those are three different problems with
 * three different fixes, and flattening them is how a pipeline fails silently.
 */
export function healthOf(s: DiscoverySource, now: string, opts: { searchConfigured?: boolean } = {}): SourceHealth {
  const rate = s.scans > 0 ? s.successes / s.scans : 1;
  const since = s.last_success_at ? daysBetween(now, s.last_success_at) : null;
  const ailing = s.failure_count >= 3 || (s.scans >= 3 && rate < 0.5);

  let state: SourceState;
  let note: string;

  if (s.source_type === 'search' && opts.searchConfigured === false) {
    state = 'not_configured';
    note = 'Search provider not configured. SEARCH_PROVIDER and SEARCH_API_KEY are required.';
  } else if (!s.active) {
    state = 'not_configured';
    note = 'Switched off.';
  } else if (!s.last_scanned_at) {
    state = 'never_scanned';
    note = 'Never scanned.';
  } else if (s.failure_count >= 3) {
    state = 'failing';
    const wait = Math.min(30, (CADENCE[s.scan_frequency] ?? 7) * Math.min(8, s.failure_count));
    note = `Failed ${s.failure_count} consecutive times. Next attempt in ${wait} days.${
      s.last_error ? ` Last reason: ${s.last_error}` : ''
    }`;
  } else if (ailing) {
    state = 'degraded';
    note = `Only ${Math.round(rate * 100)}% of scans succeed. Still used; its absence lowers confidence rather than stopping discovery.`;
  } else if (s.promotions_found > 0) {
    state = 'healthy';
    note = `${s.promotions_found} relevant article${s.promotions_found === 1 ? '' : 's'} discovered so far.`;
  } else {
    // The important distinction: this one works. It has simply not carried
    // anything about an offer, which is a fact about the source, not a fault.
    state = 'quiet';
    note = 'Scanned successfully; no relevant articles found yet.';
  }

  return {
    source: s,
    state,
    success_rate: Math.round(rate * 100) / 100,
    days_since_success: since,
    last_result:
      s.last_items_seen === null && s.last_items_new === null && s.last_relevant_new === null
        ? null
        : { items_seen: s.last_items_seen, items_found: s.last_items_new, relevant_items_found: s.last_relevant_new },
    ailing,
    note,
  };
}

export async function sourceHealth(env: Env, opts: { searchConfigured?: boolean } = {}): Promise<SourceHealth[]> {
  const now = today(env);
  return (await listSources(env, false)).map((s) => healthOf(s, now, opts));
}

/**
 * The sources the MVP ships with.
 *
 * Deliberately a handful of publications and the search layer, not a crawler
 * over every bank. One monthly roundup covering fifteen offers is worth more
 * than fifteen attempts to read fifteen bank sites, and it does not require
 * anyone's permission to read a public feed.
 */
export const DEFAULT_SOURCES: SourceInput[] = [
  {
    source_key: 'milelion',
    name: 'The MileLion',
    source_type: 'rss',
    base_url: 'https://milelion.com',
    feed_url: 'https://milelion.com/feed/',
    trust_tier: TIER.specialist,
    scan_frequency: 'daily',
    // Pinned. This is the single most productive source in the system, and a
    // quiet fortnight is not a reason to read it monthly.
    adaptive: false,
    content_scope: 'credit_card_promotions',
  },
  {
    source_key: 'mainlymiles',
    name: 'Mainly Miles',
    source_type: 'rss',
    base_url: 'https://mainlymiles.com',
    feed_url: 'https://mainlymiles.com/feed/',
    trust_tier: TIER.specialist,
    scan_frequency: 'daily',
    adaptive: false,
    content_scope: 'credit_card_promotions',
  },
  {
    source_key: 'moneysmart',
    name: 'MoneySmart Singapore',
    source_type: 'rss',
    base_url: 'https://blog.moneysmart.sg',
    feed_url: 'https://blog.moneysmart.sg/feed/',
    trust_tier: TIER.comparison,
    scan_frequency: 'every3days',
    content_scope: 'welcome_offers',
  },
  {
    source_key: 'singsaver',
    name: 'SingSaver',
    source_type: 'rss',
    base_url: 'https://www.singsaver.com.sg',
    feed_url: 'https://www.singsaver.com.sg/blog/feed',
    trust_tier: TIER.comparison,
    scan_frequency: 'every3days',
    content_scope: 'welcome_offers',
  },
  {
    source_key: 'search',
    name: 'Search discovery',
    source_type: 'search',
    trust_tier: TIER.search,
    scan_frequency: 'every3days',
    // Search cadence is governed by the query budget, not by yield.
    adaptive: false,
    content_scope: 'general_deals',
  },
];

/**
 * The canonical set of discovery sources, applied.
 *
 * This is the only definition of them. `seed.sql` deliberately does not carry
 * a copy: two lists of the same thing drift, and the one that drifted is
 * always the one production ran.
 *
 * Re-running it is also the repair. A source adaptation demoted before the
 * warm-up rule existed comes back to its configured cadence, so the fix for a
 * downranked feed is to seed again rather than to edit the database by hand.
 */
export async function seedSources(env: Env): Promise<{ added: number; repaired: number }> {
  let added = 0;
  for (const s of DEFAULT_SOURCES) {
    const before = await env.DB.prepare(`SELECT id FROM discovery_sources WHERE source_key = ?`)
      .bind(s.source_key)
      .first();
    await upsertSource(env, s);
    if (!before) added++;
  }

  // Feeds configured before the registry existed keep working, as sources of
  // unknown trust rather than being silently dropped or silently promoted.
  const { results: legacy } = await env.DB.prepare(`SELECT url, label FROM feeds WHERE active = 1`).all<{
    url: string;
    label: string | null;
  }>();
  for (const f of legacy ?? []) {
    const key = `legacy_${f.url.replace(/[^a-z0-9]+/gi, '_').slice(0, 40).toLowerCase()}`;
    const exists = await env.DB.prepare(`SELECT id FROM discovery_sources WHERE source_key = ? OR feed_url = ?`)
      .bind(key, f.url)
      .first();
    if (exists) continue;
    await upsertSource(env, {
      source_key: key,
      name: f.label ?? f.url,
      source_type: 'rss',
      feed_url: f.url,
      trust_tier: TIER.unknown,
      scan_frequency: 'weekly',
    });
    added++;
  }

  // Sources that predate the base/effective split have no configured cadence
  // recorded, so whatever adaptation last left them reads as deliberate.
  const repair = await env.DB.prepare(
    `UPDATE discovery_sources SET base_scan_frequency = scan_frequency WHERE base_scan_frequency IS NULL`
  ).run();

  return { added, repaired: repair.meta?.changes ?? 0 };
}

/**
 * Whether discovery has anything to read at all.
 *
 * An empty registry is not a healthy system with nothing to report — it is a
 * deployment that never ran the seed, and reporting it as healthy is how that
 * goes unnoticed for a month.
 */
export async function sourcesConfigured(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM discovery_sources WHERE active = 1`).first<{ n: number }>();
  return (row?.n ?? 0) > 0;
}
