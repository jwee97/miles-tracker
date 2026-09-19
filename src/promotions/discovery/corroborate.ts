import { today } from '../../spend';
import type { Env } from '../../types';
import { TIER, TIER_SCORE } from './sources';

/**
 * What several sources, taken together, say a promotion is.
 *
 * The rule that makes this worth having: the promotion record is DERIVED from
 * claims, never written straight from one article. So when MileLion says 30,000
 * and an old bank page says 25,000, the system has a conflict it can show
 * rather than a number it picked.
 *
 * Nothing here decides that a source is lying. It reports how much evidence
 * there is, how good it is, and what disagrees — and a disagreement about money
 * is a reason for a person to look, not a tie to break automatically.
 */

export type Confidence = 'high' | 'medium' | 'low';

export interface StoredClaim {
  id: number;
  field_name: string;
  value_json: string;
  source_url: string;
  source_type: string;
  source_tier: number;
  extracted_at: string;
  confidence: string;
  supporting_excerpt: string | null;
}

export interface FieldEvidence<T = unknown> {
  field: string;
  value: T;
  /** Independent sources agreeing, counted by host rather than by article. */
  sources: number;
  highest_trust_tier: number;
  official_confirmation: boolean;
  conflicting_values: T[];
  confidence: Confidence;
  /** The best excerpt behind the chosen value. */
  excerpt: string | null;
  /** In words, for the review screen. */
  note: string;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
};

const parse = (json: string): unknown => {
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
};

/** Two claims are the same claim when their values match once normalised. */
const key = (v: unknown) => (typeof v === 'object' ? JSON.stringify(v) : String(v));

/**
 * Weigh the claims for one field.
 *
 * An official source wins outright — not because secondary publications are
 * unreliable, but because several of them are frequently quoting one press
 * release, so counting them is counting the same evidence twice.
 */
export function weighField<T = unknown>(field: string, claims: StoredClaim[]): FieldEvidence<T> | null {
  const mine = claims.filter((c) => c.field_name === field);
  if (!mine.length) return null;

  const groups = new Map<string, { value: unknown; claims: StoredClaim[]; hosts: Set<string> }>();
  for (const c of mine) {
    const value = parse(c.value_json);
    const k = key(value);
    const g = groups.get(k) ?? { value, claims: [], hosts: new Set<string>() };
    g.claims.push(c);
    g.hosts.add(hostOf(c.source_url));
    groups.set(k, g);
  }

  const scored = [...groups.values()]
    .map((g) => {
      const bestTier = Math.min(...g.claims.map((c) => c.source_tier));
      // Independent hosts, plus the strength of the best source. Volume alone
      // must not outweigh an official confirmation.
      const weight = (TIER_SCORE[bestTier] ?? 20) + (g.hosts.size - 1) * 15;
      return { ...g, bestTier, weight, official: bestTier <= TIER.official };
    })
    .sort((a, b) => b.weight - a.weight);

  const [winner, ...rest] = scored;
  const conflicting = rest.map((r) => r.value as T);

  // A rival with real backing is a conflict, not a runner-up. The threshold is
  // deliberately low: money disagreeing is worth a person's attention.
  const material = rest.some((r) => r.weight >= winner.weight * 0.6);

  let confidence: Confidence;
  if (winner.official) confidence = material ? 'medium' : 'high';
  else if (winner.hosts.size >= 2 && winner.bestTier <= TIER.comparison) confidence = material ? 'medium' : 'high';
  else if (winner.bestTier <= TIER.comparison) confidence = 'medium';
  else confidence = 'low';
  if (material) confidence = confidence === 'high' ? 'medium' : 'low';

  const note = winner.official
    ? 'The issuer’s own source says so.'
    : winner.hosts.size >= 2
      ? `${winner.hosts.size} independent sources agree.`
      : 'Only one source so far.';

  return {
    field,
    value: winner.value as T,
    sources: winner.hosts.size,
    highest_trust_tier: winner.bestTier,
    official_confirmation: winner.official,
    conflicting_values: conflicting,
    confidence,
    excerpt: winner.claims.find((c) => c.supporting_excerpt)?.supporting_excerpt ?? null,
    note: material ? `${note} Another source disagrees.` : note,
  };
}

export type VerificationState =
  | 'official_verified'
  | 'secondary_verified'
  | 'single_source'
  | 'conflicting'
  | 'needs_review'
  | 'expired';

export interface Corroboration {
  fields: FieldEvidence[];
  /** The terms as the evidence has them, ready to become a promotion. */
  terms: Record<string, unknown>;
  verification_state: VerificationState;
  confidence: Confidence;
  independent_sources: number;
  official_source: boolean;
  conflicts: string[];
  /** Why a person is being asked, when they are. */
  review_reasons: string[];
}

/** The fields worth corroborating; everything else is decoration. */
export const MATERIAL_FIELDS = [
  'reward_miles',
  'reward_points',
  'reward_cashback_cents',
  'bonus_pct',
  'minimum_spend_cents',
  'application_end',
  'spend_window',
  'registration_required',
  // Who the offer is for is a money-deciding term like any other: one source
  // saying "new applicants" against another saying "existing cardholders" is
  // the difference between an offer worth applying for and one that is not
  // yours, and picking between them silently is exactly what must not happen.
  'audience_type',
];

export async function claimsFor(env: Env, candidateId: number): Promise<StoredClaim[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM promotion_claims WHERE candidate_id = ? ORDER BY source_tier, id`
  )
    .bind(candidateId)
    .all<StoredClaim>();
  return results ?? [];
}

/**
 * Put the claims together.
 *
 * `secondary_verified` is a real state and not a consolation prize: two
 * independent publications reporting materially identical terms is good
 * evidence, and the UI says exactly that rather than implying the bank
 * confirmed it.
 */
export function corroborate(claims: StoredClaim[]): Corroboration {
  const fields: FieldEvidence[] = [];
  const terms: Record<string, unknown> = {};
  const conflicts: string[] = [];
  const reasons: string[] = [];

  const present = [...new Set(claims.map((c) => c.field_name))];
  for (const field of present) {
    const e = weighField(field, claims);
    if (!e) continue;
    fields.push(e);
    terms[field] = e.value;
    if (e.conflicting_values.length && (e.confidence === 'low' || MATERIAL_FIELDS.includes(field))) {
      conflicts.push(`${field}: ${JSON.stringify(e.value)} against ${JSON.stringify(e.conflicting_values[0])}`);
    }
  }

  const hosts = new Set(claims.map((c) => hostOf(c.source_url)));
  const official = claims.some((c) => c.source_tier <= TIER.official);
  const material = fields.filter((f) => MATERIAL_FIELDS.includes(f.field));
  const allHigh = material.length > 0 && material.every((f) => f.confidence === 'high');

  let state: VerificationState;
  if (conflicts.length) state = 'conflicting';
  else if (official && allHigh) state = 'official_verified';
  else if (official) state = 'needs_review';
  else if (hosts.size >= 2 && allHigh) state = 'secondary_verified';
  else if (hosts.size >= 2) state = 'needs_review';
  else state = 'single_source';

  if (conflicts.length) reasons.push('two sources disagree about something that decides money');
  if (!material.length) reasons.push('nothing that decides money was read out of any source');
  if (state === 'single_source') reasons.push('only one source so far');
  for (const f of material) {
    if (f.confidence === 'low') reasons.push(`${f.field} rests on one unverified source`);
  }

  const confidence: Confidence =
    state === 'official_verified' ? 'high' : state === 'secondary_verified' ? 'high' : state === 'conflicting' ? 'low' : 'medium';

  return {
    fields,
    terms,
    verification_state: state,
    confidence,
    independent_sources: hosts.size,
    official_source: official,
    conflicts,
    review_reasons: reasons,
  };
}

export interface PromotionConfidence {
  level: 'official' | 'high' | 'medium' | 'low';
  official_source: boolean;
  independent_sources: number;
  last_verified_at: string;
  conflicts: string[];
}

/** What a normal person is shown: no scores, just where it came from. */
export function publicConfidence(env: Env, c: Corroboration): PromotionConfidence {
  return {
    level:
      c.verification_state === 'official_verified'
        ? 'official'
        : c.verification_state === 'secondary_verified'
          ? 'high'
          : c.verification_state === 'conflicting'
            ? 'low'
            : c.independent_sources >= 2
              ? 'medium'
              : 'low',
    official_source: c.official_source,
    independent_sources: c.independent_sources,
    last_verified_at: today(env),
    conflicts: c.conflicts,
  };
}

/**
 * Whether this can go live without anyone looking.
 *
 * The bar is deliberately high, and asymmetric: publishing a wrong reward or a
 * wrong threshold sends someone spending against terms that do not exist, while
 * holding a correct one back costs a day. Only two situations qualify — an
 * official source with everything read cleanly, or a known promotion whose only
 * change is a later end date with two trusted sources agreeing.
 */
export interface PublishDecision {
  auto: boolean;
  reason: string;
  review_reasons: string[];
}

export function canAutoPublish(
  c: Corroboration,
  context: { known_promotion: boolean; only_extension: boolean }
): PublishDecision {
  if (c.conflicts.length) {
    return { auto: false, reason: 'sources disagree about the terms', review_reasons: c.review_reasons };
  }

  if (context.known_promotion && context.only_extension && c.independent_sources >= 2) {
    return {
      auto: true,
      reason: 'a promotion already published, with only its end date extended, and two sources agreeing',
      review_reasons: [],
    };
  }

  if (c.verification_state === 'official_verified') {
    return {
      auto: true,
      reason: 'the issuer’s own source confirms it and every material term was read cleanly',
      review_reasons: [],
    };
  }

  return {
    auto: false,
    reason:
      c.verification_state === 'secondary_verified'
        ? 'independent sources agree, but a new campaign still deserves a glance'
        : 'not enough evidence to publish without a person',
    review_reasons: c.review_reasons.length ? c.review_reasons : ['a new campaign is always reviewed'],
  };
}
