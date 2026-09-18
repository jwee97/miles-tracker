import { today } from '../../spend';
import type { Env } from '../../types';
import { claimsFor, corroborate, type Corroboration } from './corroborate';
import { applyCandidate, matchExisting, type CandidateRow, type PublishResult } from './publish';
import type { FingerprintInput } from './fingerprint';
import { sourceNameForUrl, trustTierForUrl } from './domains';
import { TIER } from './sources';
import type { DiscoveryChannel } from '../../../shared/discovery';

/**
 * How one candidate was found, assembled from the article it came from.
 *
 * `manual` is the honest answer for a candidate with no discovery item behind
 * it — somebody typed it — and saying so beats implying an article existed.
 */
export async function provenanceFor(
  env: Env,
  candidate: { discovery_id: number | null },
  claimUrls: string[]
): Promise<CandidateProvenance> {
  const channels = new Set<DiscoveryChannel>();
  let query: string | null = null;

  if (candidate.discovery_id) {
    const { results } = await env.DB.prepare(
      `SELECT s.source_type, dis.search_query
         FROM discovery_item_sources dis JOIN discovery_sources s ON s.id = dis.source_id
        WHERE dis.discovery_item_id = ?`
    )
      .bind(candidate.discovery_id)
      .all<{ source_type: string; search_query: string | null }>();

    for (const r of results ?? []) {
      channels.add(r.source_type === 'search' ? 'search' : 'rss');
      if (r.search_query && !query) query = r.search_query;
    }
  }
  if (!channels.size) channels.add('manual');

  const seen = new Map<string, { name: string; url: string; trust_tier: number }>();
  for (const url of claimUrls) {
    const tier = trustTierForUrl(url);
    const name = sourceNameForUrl(url);
    if (!seen.has(name)) seen.set(name, { name, url, trust_tier: tier });
  }

  return {
    discovery_channels: [...channels],
    article_sources: [...seen.values()].sort((a, b) => a.trust_tier - b.trust_tier),
    official_verified: [...seen.values()].some((a) => a.trust_tier === TIER.official),
    search_query: query,
  };
}

/**
 * The work that is left for a person.
 *
 * The aim of the whole system is that this list is short and each item is
 * answerable in seconds — the evidence is already gathered, the change is
 * already a diff, and the question is only "is this right?". Nobody should have
 * to go and read the articles.
 */

export interface ReviewItem {
  candidate_id: number;
  status: string;
  review_reason: string | null;
  issuer: string | null;
  product: string | null;
  resolved_product_id: number | null;
  promotion_type: string | null;
  application_channel: string;
  terms: Record<string, unknown>;
  /** What each source said, with the sentence it said it in. */
  evidence: Corroboration['fields'];
  verification_state: string;
  confidence: string;
  conflicts: string[];
  sources: { url: string; tier: number; type: string }[];
  /** Set when this changes a promotion that already exists. */
  existing: { id: number; title: string; terms: Record<string, unknown>; end_at: string | null } | null;
  /** The change, already worked out, so nobody rereads a whole campaign. */
  diff: { field: string; before: unknown; after: unknown }[];
  article: { url: string | null; title: string | null } | null;
  /** How this was found, and by whom — which is not the same as what it says. */
  provenance: CandidateProvenance;
}

/**
 * Where a candidate came from.
 *
 * Separate from the evidence, and deliberately so. The evidence answers "what
 * do the sources say"; this answers "how did we come to be looking at this at
 * all", which is the question a search-originated offer raises and a feed one
 * does not. A promotion that arrived through a search engine is not less
 * trustworthy for it — the article is still the source — but a person
 * reviewing it should be able to see the difference.
 */
export interface CandidateProvenance {
  discovery_channels: DiscoveryChannel[];
  article_sources: { name: string; url: string; trust_tier: number }[];
  official_verified: boolean;
  /** The query that surfaced it, when a search did. */
  search_query: string | null;
}

const parseTerms = (json: string | null): Record<string, unknown> => {
  if (!json) return {};
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
};

/** Only the fields that decide money, and only where they actually differ. */
export function diffTerms(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): { field: string; before: unknown; after: unknown }[] {
  const fields = [
    'reward_miles',
    'reward_points',
    'reward_cashback_cents',
    'bonus_pct',
    'minimum_spend_cents',
    'window_days',
    'registration_required',
  ];
  const out: { field: string; before: unknown; after: unknown }[] = [];
  for (const f of fields) {
    if (after[f] === undefined && before[f] === undefined) continue;
    if (JSON.stringify(before[f]) === JSON.stringify(after[f])) continue;
    out.push({ field: f, before: before[f] ?? null, after: after[f] ?? null });
  }
  return out;
}

export async function reviewQueue(env: Env, limit = 50): Promise<ReviewItem[]> {
  const { results } = await env.DB.prepare(
    `SELECT c.*, d.url AS article_url, d.title AS article_title
       FROM promotion_candidates c LEFT JOIN discovery_items d ON d.id = c.discovery_id
      WHERE c.status = 'review' ORDER BY c.id DESC LIMIT ?`
  )
    .bind(limit)
    .all<any>();

  const out: ReviewItem[] = [];
  for (const row of results ?? []) {
    const claims = await claimsFor(env, row.id);
    const evidence = corroborate(claims);
    const terms = parseTerms(row.terms_json);

    let existing: ReviewItem['existing'] = null;
    if (row.promotion_id) {
      const p = await env.DB.prepare(`SELECT id, title, terms_json, end_at FROM promotions WHERE id = ?`)
        .bind(row.promotion_id)
        .first<{ id: number; title: string; terms_json: string | null; end_at: string | null }>();
      if (p) existing = { id: p.id, title: p.title, terms: parseTerms(p.terms_json), end_at: p.end_at };
    }

    out.push({
      candidate_id: row.id,
      status: row.status,
      review_reason: row.review_reason,
      issuer: row.issuer,
      product: row.raw_product_name,
      resolved_product_id: row.resolved_product_id,
      promotion_type: row.promotion_type,
      application_channel: row.application_channel,
      terms: { ...terms, ...evidence.terms },
      evidence: evidence.fields,
      verification_state: evidence.verification_state,
      confidence: evidence.confidence,
      conflicts: evidence.conflicts,
      sources: [...new Map(claims.map((c) => [c.source_url, c])).values()].map((c) => ({
        url: c.source_url,
        tier: c.source_tier,
        type: c.source_type,
      })),
      existing,
      diff: existing ? diffTerms(existing.terms, { ...terms, ...evidence.terms }) : [],
      article: row.article_url ? { url: row.article_url, title: row.article_title } : null,
      provenance: await provenanceFor(env, row, claims.map((c) => c.source_url)),
    });
  }
  return out;
}

/**
 * Approve one.
 *
 * Goes through the same path as an automatic publication, so a promotion
 * published by hand is byte-for-byte the same record — two code paths writing
 * the same table is how they drift apart.
 *
 * Edits are accepted and recorded as an official-tier claim: a person reading
 * the terms and correcting a number is the best evidence the system can have,
 * and losing that on the next corroboration pass would be perverse.
 */
export async function approveCandidate(
  env: Env,
  candidateId: number,
  edited?: Record<string, unknown>
): Promise<PublishResult> {
  const c = await env.DB.prepare(`SELECT * FROM promotion_candidates WHERE id = ?`)
    .bind(candidateId)
    .first<CandidateRow>();
  if (!c) {
    return { ok: false, error: 'no such candidate', change: null, auto: false, verification_state: 'needs_review', review_reasons: [] };
  }

  if (edited) {
    for (const [field, value] of Object.entries(edited)) {
      if (value === undefined) continue;
      await env.DB.prepare(
        `INSERT INTO promotion_claims
           (candidate_id, field_name, value_json, source_url, source_type, source_tier, extracted_at, confidence, supporting_excerpt)
         VALUES (?, ?, ?, 'app://review', 'manual_verified', 1, ?, 'high', 'corrected during review')`
      )
        .bind(candidateId, field, JSON.stringify(value), today(env))
        .run();
    }
  }

  const claims = await claimsFor(env, candidateId);
  const evidence = corroborate(claims);
  const terms: Record<string, unknown> = { ...parseTerms(c.terms_json), ...evidence.terms, ...(edited ?? {}) };

  const endAt = (terms.application_end as string) ?? null;
  const startAt = (terms.application_start as string) ?? null;

  const shape: FingerprintInput = {
    issuer: c.issuer,
    product_id: c.resolved_product_id,
    product_name: c.raw_product_name,
    promotion_type: c.promotion_type,
    application_channel: c.application_channel,
    application_start: startAt,
    application_end: endAt,
    minimum_spend_cents: (terms.minimum_spend_cents as number) ?? null,
    reward: {
      miles: terms.reward_miles as number,
      points: terms.reward_points as number,
      cashback_cents: terms.reward_cashback_cents as number,
      bonus_pct: terms.bonus_pct as number,
    },
  };
  const existing = c.promotion_id
    ? await env.DB.prepare(`SELECT id, terms_json, end_at FROM promotions WHERE id = ?`)
        .bind(c.promotion_id)
        .first<{ id: number; terms_json: string | null; end_at: string | null }>()
    : await matchExisting(env, c, shape).then((m) =>
        m ? { id: m.id, terms_json: JSON.stringify(m.terms), end_at: m.shape.application_end ?? null } : null
      );

  return await applyCandidate(env, c, evidence, {
    terms,
    startAt,
    endAt,
    sourceUrl: claims.find((x) => x.source_url.startsWith('http'))?.source_url ?? null,
    existingId: existing?.id ?? null,
    existingTerms: existing ? parseTerms(existing.terms_json) : null,
    existingEnd: existing?.end_at ?? null,
    auto: false,
  });
}
