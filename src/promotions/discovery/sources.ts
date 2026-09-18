import { today } from '../../spend';
import type { Env } from '../../types';

/**
 * Where promotions are found, and how much each place is worth.
 *
 * The architecture this exists to support: banks are one source among several
 * rather than the system's dependency. A specialist article, a comparison site
 * and an indexed official PDF are three sensors reporting the same event, and
 * losing any one of them degrades confidence instead of stopping discovery.
 */

export type SourceType = 'rss' | 'search' | 'website' | 'official_page' | 'official_pdf' | 'manual';
export type ScanFrequency = 'daily' | 'every3days' | 'weekly' | 'monthly';

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
  active: number;
}

/** How many days between scans at each frequency. */
export const CADENCE: Record<ScanFrequency, number> = {
  daily: 1,
  every3days: 3,
  weekly: 7,
  monthly: 30,
};

export async function upsertSource(
  env: Env,
  s: {
    source_key: string;
    name: string;
    source_type: SourceType;
    base_url?: string | null;
    feed_url?: string | null;
    trust_tier: number;
    scan_frequency?: ScanFrequency;
    issuer?: string | null;
    content_scope?: string | null;
  }
): Promise<DiscoverySource> {
  await env.DB.prepare(
    `INSERT INTO discovery_sources
       (source_key, name, source_type, base_url, feed_url, trust_tier, scan_frequency, issuer, content_scope)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_key) DO UPDATE SET
       name = excluded.name, source_type = excluded.source_type, base_url = excluded.base_url,
       feed_url = excluded.feed_url, trust_tier = excluded.trust_tier, issuer = excluded.issuer,
       content_scope = excluded.content_scope`
  )
    .bind(
      s.source_key,
      s.name,
      s.source_type,
      s.base_url ?? null,
      s.feed_url ?? null,
      s.trust_tier,
      s.scan_frequency ?? 'weekly',
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
  items_found?: number;
  promotions_found?: number;
  note?: string;
}

/**
 * Record what a scan did, and let the source's cadence follow from it.
 *
 * A publication that produces promotions every week earns a daily check; a
 * static card guide does not. The alternative is a fixed schedule that either
 * misses things or makes requests nobody needed.
 */
export async function recordScan(env: Env, source: DiscoverySource, outcome: ScanOutcome): Promise<ScanFrequency> {
  const now = today(env);
  const scans = source.scans + 1;
  const successes = source.successes + (outcome.ok ? 1 : 0);
  const found = source.promotions_found + (outcome.promotions_found ?? 0);

  // A rolling average of how often a scan yields something, weighted toward
  // recent behaviour so a source that goes quiet is noticed within weeks.
  const yieldNow = outcome.promotions_found ? 1 : 0;
  const score = source.change_frequency_score * 0.7 + yieldNow * 0.3;

  let frequency: ScanFrequency = source.scan_frequency;
  if (source.source_type !== 'search') {
    if (score >= 0.5) frequency = 'daily';
    else if (score >= 0.2) frequency = 'every3days';
    else if (score > 0.05) frequency = 'weekly';
    else frequency = 'monthly';
  }

  await env.DB.prepare(
    `UPDATE discovery_sources
        SET last_scanned_at = ?, scans = ?, successes = ?, promotions_found = ?,
            change_frequency_score = ?, scan_frequency = ?,
            failure_count = ?, last_success_at = ?
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
      source.id
    )
    .run();

  return frequency;
}

export interface SourceHealth {
  source: DiscoverySource;
  success_rate: number;
  days_since_success: number | null;
  /** True when the source has been failing long enough to be worth a look. */
  ailing: boolean;
  note: string;
}

export async function sourceHealth(env: Env): Promise<SourceHealth[]> {
  const now = today(env);
  return (await listSources(env, false)).map((s) => {
    const rate = s.scans > 0 ? s.successes / s.scans : 1;
    const since = s.last_success_at ? daysBetween(now, s.last_success_at) : null;
    const ailing = s.failure_count >= 3 || (s.scans >= 3 && rate < 0.5);
    return {
      source: s,
      success_rate: Math.round(rate * 100) / 100,
      days_since_success: since,
      ailing,
      note: ailing
        ? `${s.failure_count} failures in a row; scanned less often until it recovers.`
        : s.promotions_found > 0
          ? `${s.promotions_found} promotions found so far.`
          : 'Nothing found yet.',
    };
  });
}

/**
 * The sources the MVP ships with.
 *
 * Deliberately a handful of publications and the search layer, not a crawler
 * over every bank. One monthly roundup covering fifteen offers is worth more
 * than fifteen attempts to read fifteen bank sites, and it does not require
 * anyone's permission to read a public feed.
 */
export const DEFAULT_SOURCES: Parameters<typeof upsertSource>[1][] = [
  {
    source_key: 'milelion',
    name: 'The MileLion',
    source_type: 'rss',
    base_url: 'https://milelion.com',
    feed_url: 'https://milelion.com/feed/',
    trust_tier: TIER.specialist,
    scan_frequency: 'daily',
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
    content_scope: 'general_deals',
  },
];

export async function seedSources(env: Env): Promise<{ added: number }> {
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

  return { added };
}
