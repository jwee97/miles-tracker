import { recommendV2 } from '../../recommendations/recommend';
import { money } from '../../spend';
import type { Env } from '../../types';

/**
 * Whether an uncertain MCC is worth interrupting someone about.
 *
 * The naive rule — ask whenever confidence is below some threshold — asks
 * constantly and is wrong in both directions. Two codes the person's cards
 * treat identically are not worth a question however uncertain they are; two
 * codes that differ by 4 mpd are worth asking about even at 80% confidence,
 * because being wrong one time in five costs real miles on every future
 * purchase at that merchant.
 *
 * So the question is not uncertainty. It is uncertainty × consequence, and the
 * consequence is computed by running the existing recommendation engine once
 * per candidate code and comparing what it says. Nothing is estimated here:
 * the engine is the same one that decides the real recommendation, so the
 * spread is exactly the money at stake.
 */

export interface RewardSpread {
  /** Cents between the best and worst outcome across the candidate codes. */
  spread_cents: number;
  /** The candidate that pays most, and what it pays. */
  best: { mcc: string; card: string | null; value_cents: number } | null;
  /** The candidate that pays least. */
  worst: { mcc: string; card: string | null; value_cents: number } | null;
  /** True when every candidate leads to the same card at the same rate. */
  outcome_insensitive: boolean;
  /** Per-candidate detail, for showing the person why they are being asked. */
  per_mcc: { mcc: string; card: string | null; value_cents: number; reward: string | null }[];
}

/**
 * Below this, a difference is not worth a person's attention.
 *
 * Configurable rather than hard-coded, because what counts as material depends
 * on how much someone spends — and an unexplained constant in a decision like
 * this is exactly the kind of thing nobody revisits.
 */
export const DEFAULT_MATERIAL_CENTS = 50;

export const materialThreshold = (env: Env): number => {
  const raw = Number(env.MCC_REVIEW_MIN_GAIN_CENTS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MATERIAL_CENTS;
};

/**
 * What the candidate codes are worth, on this purchase, on these cards.
 *
 * At most a handful of candidates are priced: the engine is not free, and a
 * long tail of 2%-probability codes cannot change a decision.
 */
export async function rewardImpactOfUncertainty(
  env: Env,
  purchase: { amount_cents: number; channel?: string | null; merchant?: string | null; on?: string },
  candidates: { mcc: string; probability: number }[],
  opts: { max?: number } = {}
): Promise<RewardSpread> {
  const top = [...candidates].sort((a, b) => b.probability - a.probability).slice(0, opts.max ?? 3);

  const per: RewardSpread['per_mcc'] = [];
  for (const c of top) {
    try {
      const rec = await recommendV2(
        env,
        {
          amount_cents: purchase.amount_cents,
          mcc: c.mcc,
          channel: (purchase.channel ?? undefined) as never,
        },
        { on: purchase.on }
      );
      const pick = rec.recommendation;
      per.push({
        mcc: c.mcc,
        card: pick?.card?.product ?? null,
        value_cents: pick?.reward?.value_cents ?? 0,
        reward: pick?.reward ? `${pick.reward.amount} ${pick.reward.type}` : null,
      });
    } catch {
      // A code the engine cannot price contributes nothing rather than
      // breaking the comparison. Silence here is safe: an unpriceable
      // candidate cannot be shown to matter.
      per.push({ mcc: c.mcc, card: null, value_cents: 0, reward: null });
    }
  }

  if (!per.length) {
    return { spread_cents: 0, best: null, worst: null, outcome_insensitive: true, per_mcc: [] };
  }

  const sorted = [...per].sort((a, b) => b.value_cents - a.value_cents);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  const spread = best.value_cents - worst.value_cents;

  // Insensitive means the same card AND the same value: a different card at an
  // identical rate still changes which card should be tapped.
  const sameCard = per.every((p) => p.card === per[0].card);
  const sameValue = spread === 0;

  return {
    spread_cents: spread,
    best: { mcc: best.mcc, card: best.card, value_cents: best.value_cents },
    worst: { mcc: worst.mcc, card: worst.card, value_cents: worst.value_cents },
    outcome_insensitive: sameCard && sameValue,
    per_mcc: per,
  };
}

export type ReviewVerdict = 'auto_resolve' | 'resolve_with_uncertainty' | 'needs_answer';

export interface ReviewDecision {
  verdict: ReviewVerdict;
  reason: string;
  /** What the person would be told, when they are asked at all. */
  explanation: string | null;
  spread: RewardSpread;
}

export interface ReviewPolicy {
  /** At or above this, the top candidate is taken without asking. */
  high_confidence: number;
  /** Below this, nothing is auto-resolved however small the stakes. */
  low_confidence: number;
  /** Cents of spread below which a difference is not worth asking about. */
  material_cents: number;
}

export function policyFrom(env: Env): ReviewPolicy {
  const num = (v: unknown, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    high_confidence: num(env.MCC_HIGH_CONFIDENCE, 0.85),
    low_confidence: num(env.MCC_LOW_CONFIDENCE, 0.5),
    material_cents: materialThreshold(env),
  };
}

/**
 * The decision itself.
 *
 * Three outcomes rather than two, because "resolve but remember it was a
 * guess" is a real state: the app takes the likely code, the recommendation
 * says it is uncertain, and nothing pretends a question was answered.
 */
export function decideReview(
  top: { mcc: string; probability: number } | null,
  spread: RewardSpread,
  policy: ReviewPolicy
): ReviewDecision {
  if (!top) {
    return {
      verdict: 'needs_answer',
      reason: 'no candidate code could be derived',
      explanation: 'We have nothing on record for this merchant yet.',
      spread,
    };
  }

  const material = spread.spread_cents >= policy.material_cents && !spread.outcome_insensitive;

  // The important branch, and the one a confidence-only rule gets wrong: the
  // stakes decide, not the certainty.
  if (material) {
    const b = spread.best;
    const w = spread.worst;
    return {
      verdict: 'needs_answer',
      reason: `the code changes the reward by $${money(spread.spread_cents)}`,
      explanation:
        b && w
          ? `The code changes what this earns. ${b.mcc} → ${b.card ?? 'no card'} ($${money(b.value_cents)}); ` +
            `${w.mcc} → ${w.card ?? 'no card'} ($${money(w.value_cents)}).`
          : 'The code changes what this earns.',
      spread,
    };
  }

  if (top.probability >= policy.high_confidence) {
    return {
      verdict: 'auto_resolve',
      reason: `confident (${Math.round(top.probability * 100)}%) and the code does not change the reward`,
      explanation: null,
      spread,
    };
  }

  if (top.probability >= policy.low_confidence) {
    return {
      verdict: 'resolve_with_uncertainty',
      reason: `uncertain (${Math.round(top.probability * 100)}%) but every candidate earns the same`,
      explanation: null,
      spread,
    };
  }

  return {
    verdict: 'needs_answer',
    reason: `too uncertain (${Math.round(top.probability * 100)}%) to act on`,
    explanation: 'We are not confident enough about this merchant to guess.',
    spread,
  };
}
