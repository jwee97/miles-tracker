import {
  evaluate,
  lookupMerchant,
  rulesForCard,
  type Evaluation,
  type MerchantGuess,
  type Objective,
  type Purchase,
} from '../rules';
import { money, today } from '../spend';
import type { Card } from '../types';
import { isStale, type CardProduct } from '../catalog/products';

import { assessConfidence, type ConfidenceReport, type RecommendationConfidence } from './confidence';
import { scoreOf, totalScore, type ScoreComponents } from './score';
import type { Env } from '../types';

/**
 * Which card to use, and why.
 *
 * Two things separate this from ranking by reward. First, a card can be
 * *disqualified* rather than merely worse: an excluded code or a channel that
 * does not match is not a small disadvantage to be outweighed by a good rate,
 * it means the card cannot be used for this purchase at all. Second, a
 * recommendation made on a guess has to say so — the answer may be right and
 * the reasoning still unsound.
 */

/** Why a card cannot be used here at all. Never outranked by a better rate. */
export interface Disqualification {
  reason: string;
  detail: string;
}

export interface RecommendationReason {
  /** true met, false failed, null a note. */
  pass: boolean | null;
  text: string;
}

export interface RecommendationPick {
  card: { id: number; nickname: string; issuer: string; product: string; product_id: number | null };
  reward: {
    type: 'miles' | 'cashback';
    amount: number;
    effective_rate: number;
    value_cents: number;
  };
  cap: {
    applies: boolean;
    cap_cents: number | null;
    used_cents: number;
    remaining_cents: number | null;
  };
  minimum_spend: { remaining_cents: number; days_left: number | null; urgent: boolean } | null;
  rule_set_id: number | null;
  reasons: RecommendationReason[];
  score_components: ScoreComponents;
  score: number;
  /** Set when the card cannot be used; such a card can never rank first. */
  disqualified: Disqualification | null;
}

export interface SplitAdvice {
  bonus_cents: number;
  remainder_cents: number;
  use: string;
  earns: string;
  /** What splitting is worth over not splitting, in cents of value. */
  gain_cents: number;
}

export interface RecommendationV2 {
  purchase: Purchase & { resolved_from: string | null };
  merchant: MerchantGuess | null;
  objective: Objective;
  confidence: { level: RecommendationConfidence; reasons: string[] };
  recommendation: RecommendationPick | null;
  alternatives: RecommendationPick[];
  /** Cards that cannot be used here, kept so the omission is explicable. */
  ineligible: RecommendationPick[];
  split_advice: SplitAdvice | null;
  assumptions: ConfidenceReport['assumptions'];
  evaluated_at: string;
  /** When the rules behind this answer were last confirmed. */
  data_version: string;
}

/** Below this, splitting a payment is not worth the trouble of two taps. */
export const DEFAULT_SPLIT_MIN_GAIN_CENTS = 150;

const pickOf = (e: Evaluation, components: ScoreComponents, reasons: RecommendationReason[], dq: Disqualification | null): RecommendationPick => ({
  card: {
    id: e.card.id,
    nickname: e.card.nickname,
    issuer: e.card.issuer,
    product: e.card.product,
    product_id: (e.card as unknown as { product_id?: number | null }).product_id ?? null,
  },
  reward: {
    type: e.reward_type,
    amount: e.reward_type === 'cashback' ? e.cashback_cents : e.miles,
    effective_rate: e.effective_rate,
    value_cents: e.value_cents,
  },
  cap: {
    applies: e.cap_cents !== null,
    cap_cents: e.cap_cents,
    used_cents: e.cap_used_cents,
    remaining_cents: e.headroom_cents,
  },
  minimum_spend:
    e.min_spend_short_cents > 0
      ? {
          remaining_cents: e.min_spend_short_cents,
          days_left: e.min_spend_days_left,
          urgent: e.min_spend_days_left !== null && e.min_spend_days_left <= 7,
        }
      : null,
  rule_set_id: e.rule_set_id,
  reasons,
  score_components: components,
  score: totalScore(components),
  disqualified: dq,
});

/**
 * Whether this card is out of the running, as opposed to merely behind.
 *
 * Only conditions that make the card unusable count. "Its bonus is nearly
 * spent" and "another card has an urgent minimum" are disadvantages and belong
 * in the score; an excluded code means no reward will be paid whatever else is
 * true, and no rate can outweigh that.
 */
function disqualify(e: Evaluation, purchase: Purchase): Disqualification | null {
  if (e.card.closed_at) return { reason: 'closed', detail: 'this card is closed' };
  if (e.excluded)
    return {
      reason: 'excluded_mcc',
      detail: e.exclusion_reason ?? `${purchase.mcc ?? 'this code'} earns nothing on this card`,
    };
  if (!e.rule && !e.rule_set_id)
    return { reason: 'no_rules', detail: 'no reward rules are recorded for this card' };
  return null;
}

/** The explanation, taken from the trace the engine already produces. */
function reasonsFrom(e: Evaluation): RecommendationReason[] {
  return e.trace
    .filter((t) => t.check !== 'Score')
    .map((t) => ({ pass: t.pass, text: t.detail }))
    .slice(0, 8);
}

export async function recommendV2(
  env: Env,
  p: Purchase,
  opts: { merchantQuery?: string; objective?: Objective; on?: string; split_min_gain_cents?: number } = {}
): Promise<RecommendationV2> {
  const objective: Objective = opts.objective ?? ((env.OBJECTIVE as Objective) || 'balanced');
  const on = opts.on ?? today(env);
  const warnDays = parseInt(env.MIN_SPEND_WARN_DAYS || '7', 10);
  const mileValue = parseFloat(env.MILE_VALUE_CENTS || '1.5');

  // --- resolve what we actually know about the purchase --------------------
  let merchant: MerchantGuess | null = null;
  const purchase: Purchase = { ...p };
  let resolvedFrom: string | null = null;
  if (opts.merchantQuery) {
    merchant = await lookupMerchant(env, opts.merchantQuery);
    if (!purchase.mcc && merchant.mcc) {
      purchase.mcc = merchant.mcc;
      resolvedFrom = merchant.confidence === 'confirmed' ? 'your own history' : 'a similar merchant name';
    }
    if (!purchase.category && merchant.category) purchase.category = merchant.category;
    if (!purchase.channel && merchant.channel) purchase.channel = merchant.channel;
  }
  if (purchase.mcc && !purchase.category) {
    const row = await env.DB.prepare(`SELECT category FROM mcc_codes WHERE code = ?`)
      .bind(purchase.mcc)
      .first<{ category: string }>();
    if (row) purchase.category = row.category;
  }

  const { results: cards } = await env.DB.prepare(
    `SELECT * FROM cards WHERE closed_at IS NULL ORDER BY id`
  ).all<Card>();
  const { results: exclusions } = await env.DB.prepare(
    `SELECT card_id, mcc, reason FROM exclusions WHERE active = 1`
  ).all<any>();

  // --- evaluate every card -------------------------------------------------
  //
  // The rules each card COULD have used are gathered as well as the one it did.
  // An MCC-restricted rule cannot match when the code is unknown, so judging
  // "would a code have mattered here" on the matched rule finds nothing exactly
  // when the answer is yes.
  const evaluations: Evaluation[] = [];
  const sensitivity = { mcc: false, channel: false };
  for (const card of cards ?? []) {
    const { rules } = await rulesForCard(env, card, on);
    if (rules.some((r) => r.mcc_include || r.mcc_exclude)) sensitivity.mcc = true;
    if (rules.some((r) => r.channel)) sensitivity.channel = true;
    evaluations.push(await evaluate(env, card, purchase, { exclusions: exclusions ?? [], on }));
  }

  // Products whose numbers have not been confirmed against a bank document.
  // Not a reason to withhold advice, only to say how sure it is.
  const staleNames: string[] = [];
  let newestVerified: string | null = null;
  for (const card of cards ?? []) {
    const pid = (card as unknown as { product_id?: number | null }).product_id;
    if (!pid) continue;
    const product = await env.DB.prepare(`SELECT * FROM card_products WHERE id = ?`).bind(pid).first<CardProduct>();
    if (!product) continue;
    if (isStale(product, on)) staleNames.push(product.product_name);
    if (product.last_verified_at && (!newestVerified || product.last_verified_at > newestVerified)) {
      newestVerified = product.last_verified_at;
    }
  }

  const confidence = assessConfidence(purchase, merchant, evaluations, {
    stale_products: staleNames,
    sensitivity,
  });

  // --- rank ----------------------------------------------------------------
  const usable: RecommendationPick[] = [];
  const ineligible: RecommendationPick[] = [];
  for (const e of evaluations) {
    const dq = disqualify(e, purchase);
    const components = dq ? scoreOf(e, { objective, warn_days: warnDays, unknowns: 0 }) : scoreOf(e, { objective, warn_days: warnDays, unknowns: confidence.material_unknowns });
    const pick = pickOf(e, components, reasonsFrom(e), dq);
    (dq ? ineligible : usable).push(pick);
  }
  usable.sort((a, b) => b.score - a.score);

  const best = usable[0] ?? null;
  const alternatives = usable.slice(1);

  // --- split ---------------------------------------------------------------
  const minGain =
    opts.split_min_gain_cents ??
    (parseInt(env.SPLIT_MIN_GAIN_CENTS || '', 10) || DEFAULT_SPLIT_MIN_GAIN_CENTS);
  let split: SplitAdvice | null = null;
  const topEval = best ? evaluations.find((e) => e.card.id === best.card.id) ?? null : null;

  if (
    topEval &&
    purchase.amount_cents !== null &&
    purchase.amount_cents !== undefined &&
    topEval.base_portion_cents > 0 &&
    topEval.bonus_portion_cents > 0
  ) {
    const rest: Purchase = { ...purchase, amount_cents: topEval.base_portion_cents };
    const others: Evaluation[] = [];
    for (const card of (cards ?? []).filter((c) => c.id !== topEval.card.id)) {
      others.push(await evaluate(env, card, rest, { exclusions: exclusions ?? [], on }));
    }
    others.sort((a, b) => b.value_cents - a.value_cents);
    const alt = others.find((o) => !o.excluded) ?? null;

    // The top card earns its BASE rate on the remainder — the bonus is spent by
    // then. Re-evaluating it fresh would see an unused cap and wrongly conclude
    // nothing beats it, which is the exact case this advice exists for.
    const topRemainder =
      topEval.reward_type === 'cashback'
        ? Math.round(topEval.base_portion_cents * (topEval.base_rate / 100))
        : Math.round((topEval.base_portion_cents / 100) * topEval.base_rate * mileValue);

    if (alt) {
      const gain = alt.value_cents - topRemainder;
      // Two taps at the till for a few cents is not advice, it is noise.
      if (gain >= minGain) {
        split = {
          bonus_cents: topEval.bonus_portion_cents,
          remainder_cents: topEval.base_portion_cents,
          use: alt.card.product,
          earns:
            alt.reward_type === 'cashback'
              ? `$${money(alt.cashback_cents)} back`
              : `${alt.miles.toLocaleString()} miles`,
          gain_cents: gain,
        };
      }
    }
  }

  return {
    purchase: { ...purchase, resolved_from: resolvedFrom },
    merchant,
    objective,
    confidence: { level: confidence.level, reasons: confidence.reasons },
    recommendation: best,
    alternatives,
    ineligible,
    split_advice: split,
    assumptions: confidence.assumptions,
    evaluated_at: new Date().toISOString(),
    data_version: newestVerified ?? 'unverified',
  };
}
