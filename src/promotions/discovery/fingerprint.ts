import type { PromotionCandidate } from './extract';

/**
 * The identity of a campaign, independent of who wrote about it.
 *
 * Three publications describing one offer produce three articles, three
 * wordings and three sets of dates written differently. The fingerprint is what
 * makes them one promotion: the economics, canonicalised.
 *
 * The application channel is part of it deliberately. A comparison site's
 * exclusive and the issuer's own offer are genuinely different campaigns, and
 * merging them would advertise terms nobody can actually get.
 */

export interface FingerprintInput {
  issuer: string | null;
  product_id: number | null;
  product_name: string | null;
  promotion_type: string | null;
  application_channel: string;
  application_start?: string | null;
  application_end?: string | null;
  minimum_spend_cents?: number | null;
  reward: { miles?: number; points?: number; cashback_cents?: number; bonus_pct?: number; gift?: string };
}

const slug = (s: string | null | undefined) =>
  (s ?? 'unknown')
    .toString()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '') || 'UNKNOWN';

/** A month, not a day: articles disagree by a day over the same campaign. */
const monthOf = (iso: string | null | undefined) => (iso ? iso.slice(0, 7) : 'OPEN');

export function rewardSlug(r: FingerprintInput['reward']): string {
  if (r.miles) return `${r.miles}_MILES`;
  if (r.points) return `${r.points}_POINTS`;
  if (r.cashback_cents) return `${r.cashback_cents}_CENTS`;
  if (r.bonus_pct) return `${r.bonus_pct}_PCT`;
  if (r.gift) return `GIFT_${slug(r.gift).slice(0, 20)}`;
  return 'NO_REWARD';
}

export function canonicalForm(f: FingerprintInput): string {
  return [
    slug(f.issuer),
    f.product_id ? `P${f.product_id}` : slug(f.product_name),
    slug(f.promotion_type),
    slug(f.application_channel),
    monthOf(f.application_start),
    monthOf(f.application_end),
    f.minimum_spend_cents ?? 0,
    rewardSlug(f.reward),
  ].join('|');
}

export function fingerprint(f: FingerprintInput): string {
  const s = canonicalForm(f);
  let h1 = 2166136261;
  let h2 = 5381;
  for (let i = 0; i < s.length; i++) {
    h1 ^= s.charCodeAt(i);
    h1 = Math.imul(h1, 16777619);
    h2 = (h2 * 33) ^ s.charCodeAt(i);
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
}

export const fingerprintOf = (c: PromotionCandidate, productId: number | null): string =>
  fingerprint({
    issuer: c.issuer,
    product_id: productId,
    product_name: c.product_names[0] ?? null,
    promotion_type: c.promotion_type,
    application_channel: c.application_channel,
    application_start: c.application_start,
    application_end: c.application_end,
    minimum_spend_cents: c.minimum_spend_cents,
    reward: c.reward,
  });

export interface Similarity {
  score: number;
  /** Why they look alike, or why they do not. */
  reasons: string[];
  /** True when they are the same campaign beyond reasonable doubt. */
  same: boolean;
}

/** Dates this far apart still describe one campaign, written differently. */
export const DATE_TOLERANCE_DAYS = 3;
/** Rewards within this fraction are the same offer rounded differently. */
export const REWARD_TOLERANCE = 0.02;

const near = (a: number | undefined | null, b: number | undefined | null, tolerance: number) => {
  if (a === undefined || a === null || b === undefined || b === null) return null;
  if (a === b) return true;
  const bigger = Math.max(Math.abs(a), Math.abs(b));
  return bigger === 0 ? true : Math.abs(a - b) / bigger <= tolerance;
};

const daysApart = (a?: string | null, b?: string | null) =>
  a && b ? Math.abs(Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000)) : null;

/**
 * How alike two candidates are, when the fingerprints differ.
 *
 * Exact fingerprints miss the ordinary case: one article says "ends 30 Sep" and
 * another "valid until 30 September 2026", one rounds a reward and the other
 * does not. This catches those without merging two genuinely different offers —
 * a different issuer or a different card is disqualifying, never outweighed.
 */
export function similarity(a: FingerprintInput, b: FingerprintInput): Similarity {
  const reasons: string[] = [];

  if (slug(a.issuer) !== slug(b.issuer)) {
    return { score: 0, reasons: ['different issuers'], same: false };
  }
  if (a.product_id && b.product_id && a.product_id !== b.product_id) {
    return { score: 0, reasons: ['different cards'], same: false };
  }
  if (slug(a.promotion_type) !== slug(b.promotion_type)) {
    return { score: 0, reasons: ['different kinds of promotion'], same: false };
  }
  // A channel-exclusive offer is its own campaign, whatever else matches.
  if (
    a.application_channel !== 'unknown' &&
    b.application_channel !== 'unknown' &&
    a.application_channel !== b.application_channel
  ) {
    return { score: 0, reasons: ['different application channels'], same: false };
  }

  let score = 0.4;
  reasons.push('same issuer and kind');

  const rewardSame = rewardSlug(a.reward) === rewardSlug(b.reward);
  const rewardNear =
    rewardSame ||
    near(a.reward.miles, b.reward.miles, REWARD_TOLERANCE) ||
    near(a.reward.points, b.reward.points, REWARD_TOLERANCE) ||
    near(a.reward.cashback_cents, b.reward.cashback_cents, REWARD_TOLERANCE) ||
    near(a.reward.bonus_pct, b.reward.bonus_pct, REWARD_TOLERANCE);
  if (rewardNear === true) {
    score += 0.3;
    reasons.push('the same reward');
  } else if (rewardNear === false) {
    reasons.push('different rewards');
    score -= 0.2;
  }

  const spendNear = near(a.minimum_spend_cents, b.minimum_spend_cents, REWARD_TOLERANCE);
  if (spendNear === true) {
    score += 0.2;
    reasons.push('the same minimum spend');
  } else if (spendNear === false) {
    reasons.push('different minimum spend');
    score -= 0.2;
  }

  const endGap = daysApart(a.application_end, b.application_end);
  if (endGap !== null && endGap <= DATE_TOLERANCE_DAYS) {
    score += 0.2;
    reasons.push(endGap === 0 ? 'the same end date' : `end dates ${endGap} day(s) apart`);
  } else if (endGap !== null) {
    reasons.push(`end dates ${endGap} days apart`);
  }

  const bounded = Math.max(0, Math.min(1, score));
  return { score: Math.round(bounded * 100) / 100, reasons, same: bounded >= 0.8 };
}

/**
 * The same campaign, with a later end date.
 *
 * Worth detecting separately from a duplicate: an extension is version two of
 * one promotion, and treating it as a new offer loses the history that tracked
 * requirements and reconciled rewards point back at.
 */
export function looksExtended(existing: FingerprintInput, candidate: FingerprintInput): boolean {
  const sim = similarity(existing, candidate);
  if (sim.score < 0.6) return false;
  if (!existing.application_end || !candidate.application_end) return false;
  if (candidate.application_end <= existing.application_end) return false;
  // The economics have to be unchanged; a new reward with a new date is a new
  // campaign, not the old one running longer.
  return rewardSlug(existing.reward) === rewardSlug(candidate.reward) &&
    (existing.minimum_spend_cents ?? 0) === (candidate.minimum_spend_cents ?? 0);
}
