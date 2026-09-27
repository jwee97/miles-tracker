import { today } from '../../spend';
import type { Env } from '../../types';
import { claimsFor, corroborate, type Corroboration } from './corroborate';
import { applyCandidate, matchExisting, type CandidateRow, type PublishResult } from './publish';
import type { FingerprintInput } from './fingerprint';
import { sourceNameForUrl, trustTierForUrl } from './domains';
import { AUDIENCE_TYPES, audienceOf as promotionAudienceOf, type PromotionAudienceType } from '../audience';
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
  /** Who the offer is for, and the wording that said so. */
  audience: { type: string; raw_text: string | null; confidence: string };
  /** Set when this changes a promotion that already exists. */
  existing: { id: number; title: string; terms: Record<string, unknown>; end_at: string | null } | null;
  /** The change, already worked out, so nobody rereads a whole campaign. */
  diff: { field: string; before: unknown; after: unknown }[];
  article: { url: string | null; title: string | null } | null;
  /** How this was found, and by whom — which is not the same as what it says. */
  provenance: CandidateProvenance;
  /**
   * What the article was read as.
   *
   * On the screen because the commonest wrong candidate is a card review, and
   * a reviewer who can see "this was read as a card review" corrects it in one
   * tap instead of puzzling over why a promotion pays 1.3 miles.
   */
  document_type: string | null;
  classification_confidence: string | null;
  classification_signals: string[];
  /**
   * False when nothing about this reads as an actual offer.
   *
   * The screen hides the reward fields entirely in that case: asking somebody
   * to confirm a minimum spend that was never in the article invites them to
   * invent one.
   */
  has_promotion: boolean;
  /** Set when the article names a card the catalogue does not have. */
  unmatched_product: { name: string; issuer: string | null } | null;
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
    `SELECT c.*, d.url AS article_url, d.title AS article_title,
            d.document_type, d.classification_confidence, d.classification_signals_json
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
      document_type: row.document_type ?? null,
      classification_confidence: row.classification_confidence ?? null,
      classification_signals: (() => {
        try {
          const parsed = JSON.parse(row.classification_signals_json ?? '[]');
          return Array.isArray(parsed) ? parsed.map(String).slice(0, 10) : [];
        } catch {
          return [];
        }
      })(),
      // An offer has to pay something. Without that there is nothing to
      // confirm, and every field on the form would be a prompt to make one up.
      has_promotion: (() => {
        const t = { ...terms, ...evidence.terms } as Record<string, unknown>;
        return !!(t.reward_miles || t.reward_points || t.reward_cashback_cents || t.bonus_pct || t.reward_gift);
      })(),
      // Named in the article, absent from the catalogue. Surfaced rather than
      // invented: a product created without review is a product the rules
      // engine will price purchases against.
      unmatched_product:
        row.raw_product_name && !row.resolved_product_id
          ? { name: row.raw_product_name, issuer: row.issuer ?? null }
          : null,
      audience: (() => {
        // Shown to the reviewer explicitly, with the sentence it came from:
        // an audience read wrongly is the most consequential extraction error
        // there is, and it is invisible unless it is on the screen.
        const a = promotionAudienceOf({ ...terms, ...evidence.terms } as Record<string, unknown>);
        return { type: a.type, raw_text: a.raw_text ?? null, confidence: a.confidence ?? 'low' };
      })(),
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
  edited?: Record<string, unknown>,
  audienceType?: string
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

  // A reviewer re-classifying the audience is the strongest evidence the
  // system can hold about who an offer is for: they have read the wording and
  // disagreed with the reading. Recorded at the tier an issuer would get, so a
  // later article cannot quietly overturn it.
  if (audienceType && AUDIENCE_TYPES.includes(audienceType as PromotionAudienceType)) {
    await env.DB.prepare(
      `INSERT INTO promotion_claims
         (candidate_id, field_name, value_json, source_url, source_type, source_tier, extracted_at, confidence, supporting_excerpt)
       VALUES (?, 'audience_type', ?, 'app://review', 'manual_verified', 1, ?, 'high', 'classified during review')`
    )
      .bind(candidateId, JSON.stringify(audienceType), today(env))
      .run();
  }

  const claims = await claimsFor(env, candidateId);
  const evidence = corroborate(claims);
  const terms: Record<string, unknown> = { ...parseTerms(c.terms_json), ...evidence.terms, ...(edited ?? {}) };

  // The reviewer's classification becomes the stored audience, keeping the
  // wording it was read from so the next person can see what they judged.
  if (audienceType) {
    const current = promotionAudienceOf(terms);
    terms.audience = { ...current, type: audienceType, confidence: 'high' };
  }

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

/** What a reviewer can say a candidate really is, when discovery got it wrong. */
export const CORRECTABLE_TYPES = [
  'welcome_offer',
  'spend_bonus',
  'merchant_offer',
  'transfer_bonus',
  'category_bonus',
  'cardholder_offer',
  'bank_campaign',
  'not_a_promotion',
] as const;
export type CorrectableType = (typeof CORRECTABLE_TYPES)[number];

/** The reason kept when a reviewer says an article was never an offer. */
export const NOT_A_PROMOTION_REASON = 'card_review_not_promotion';

export interface RejectResult {
  ok: boolean;
  error?: string;
  /** What the article is now recorded as, so the note can say it back. */
  document_type?: string | null;
  applied?: string;
}

/**
 * "This is not a promotion."
 *
 * The reviewer has read the article and the system has not. Their verdict is
 * the strongest evidence available about what a document is, so it does three
 * things rather than one: the candidate is rejected, the article is marked as
 * what it actually was, and the reason is kept.
 *
 * The third part is what stops it coming back. Rejecting the candidate alone
 * leaves the article looking unprocessed to anything that re-reads it, and the
 * same wrong candidate is manufactured again next week — which teaches people
 * that the review queue does not listen.
 */
export async function rejectCandidate(
  env: Env,
  candidateId: number,
  opts: { document_type?: string; note?: string } = {}
): Promise<RejectResult> {
  const c = await env.DB.prepare(`SELECT id, discovery_id, raw_product_name FROM promotion_candidates WHERE id = ?`)
    .bind(candidateId)
    .first<{ id: number; discovery_id: number | null; raw_product_name: string | null }>();
  if (!c) return { ok: false, error: 'no such candidate' };

  const documentType = opts.document_type ?? 'card_review';

  await env.DB.prepare(
    `UPDATE promotion_candidates SET status = 'rejected', review_reason = ? WHERE id = ?`
  )
    .bind(opts.note ?? NOT_A_PROMOTION_REASON, candidateId)
    .run();

  if (c.discovery_id) {
    // `irrelevant` rather than `processed`: the article was read correctly and
    // is genuinely not about an offer, and the next pass should not spend a
    // fetch on it. The document type and note say which of those it was.
    await env.DB.prepare(
      `UPDATE discovery_items
          SET status = 'irrelevant', document_type = ?, classification_confidence = 'high',
              extraction_note = ?
        WHERE id = ?`
    )
      .bind(
        documentType,
        opts.note ?? 'A reviewer read this and said it is not a promotion.',
        c.discovery_id
      )
      .run();
  }

  return { ok: true, document_type: documentType, applied: 'recorded as not a promotion' };
}

/**
 * Change what kind of offer this is.
 *
 * `not_a_promotion` is one of the choices rather than a separate control,
 * because from the reviewer's side it is the same act: they are saying what
 * the thing is. It routes to the rejection above.
 */
export async function retypeCandidate(
  env: Env,
  candidateId: number,
  type: CorrectableType
): Promise<RejectResult> {
  if (!CORRECTABLE_TYPES.includes(type)) return { ok: false, error: 'unknown promotion type' };
  if (type === 'not_a_promotion') {
    return rejectCandidate(env, candidateId, {
      document_type: 'card_review',
      note: NOT_A_PROMOTION_REASON,
    });
  }

  const c = await env.DB.prepare(`SELECT id FROM promotion_candidates WHERE id = ?`).bind(candidateId).first<{ id: number }>();
  if (!c) return { ok: false, error: 'no such candidate' };

  await env.DB.prepare(`UPDATE promotion_candidates SET promotion_type = ? WHERE id = ?`)
    .bind(type, candidateId)
    .run();

  // Recorded as a claim at the tier a person's reading earns, so the next
  // corroboration pass cannot quietly change it back.
  await env.DB.prepare(
    `INSERT INTO promotion_claims
       (candidate_id, field_name, value_json, source_url, source_type, source_tier, extracted_at, confidence, supporting_excerpt)
     VALUES (?, 'promotion_type', ?, 'app://review', 'manual_verified', 1, ?, 'high', 'corrected during review')`
  )
    .bind(candidateId, JSON.stringify(type), today(env))
    .run();

  return { ok: true, applied: `recorded as ${type.replace(/_/g, ' ')}` };
}

export interface UnmatchedProduct {
  candidate_id: number;
  name: string;
  issuer: string | null;
  article_url: string | null;
  seen: number;
}

/**
 * Cards an article named that the catalogue does not have.
 *
 * Surfaced, never created. A card product is what the rules engine prices
 * purchases against, and one invented from an article's phrasing would earn
 * whatever nobody had checked — so this is a list of questions, and answering
 * them is a separate, deliberate act in the catalogue.
 */
export async function unmatchedProducts(env: Env, limit = 20): Promise<UnmatchedProduct[]> {
  const { results } = await env.DB.prepare(
    `SELECT MIN(c.id) AS candidate_id, c.raw_product_name AS name, c.issuer,
            MIN(d.url) AS article_url, COUNT(*) AS seen
       FROM promotion_candidates c
       LEFT JOIN discovery_items d ON d.id = c.discovery_id
      WHERE c.resolved_product_id IS NULL
        AND c.raw_product_name IS NOT NULL
        AND c.status NOT IN ('rejected')
      GROUP BY LOWER(c.raw_product_name), c.issuer
      ORDER BY seen DESC, candidate_id DESC
      LIMIT ?`
  )
    .bind(limit)
    .all<UnmatchedProduct>();
  return results ?? [];
}
