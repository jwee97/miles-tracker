import { termsOf, type Promotion } from '../promotions/model';
import { money, today } from '../spend';
import type { Env } from '../types';
import { portfolioGaps, spendingProfile, DEFAULT_HISTORY_MONTHS, type PortfolioGap } from './gaps';
import { candidates, simulateProduct, type AcquisitionEvaluation } from './simulate';

/**
 * Whether a card is worth acquiring, which is not the same as what it pays.
 *
 * Three things this refuses to do. It does not add a welcome bonus to the
 * ongoing value, because one is recurring and the other happens once and the
 * sum is a number that means nothing. It does not rank on gross rewards, since
 * a fee is real money. And it does not treat another card as free: another cap
 * to watch, another minimum, another statement date and another programme are a
 * cost even when nobody bills you for them.
 */

export type Objective = 'maximise_miles' | 'minimise_fees' | 'simpler_wallet' | 'balanced';

/** What one more card costs in attention, expressed as cents a year. */
export const COMPLEXITY_COST_CENTS = 2000;
/** An overlap above this is a card doing what one you hold already does. */
export const HEAVY_OVERLAP = 0.5;

export interface AcquisitionSuggestion extends AcquisitionEvaluation {
  /** Net of the fee, the complexity cost and the overlap discount. */
  score_cents: number;
  complexity_cost_cents: number;
  /** The gaps this candidate would actually close. */
  closes_gaps: string[];
}

export interface AcquisitionReport {
  gaps: PortfolioGap[];
  suggestions: AcquisitionSuggestion[];
  /** Candidates that were simulated and found not to be worth it. */
  not_worth_it: { product_name: string; why: string }[];
  history: { months: number; months_with_data: number; from: string; to: string };
  objective: Objective;
  confidence: 'high' | 'medium' | 'low';
  as_of: string;
}

async function welcomeOffer(env: Env, productId: number): Promise<AcquisitionEvaluation['welcome_offer']> {
  const p = await env.DB.prepare(
    `SELECT p.* FROM promotions p
       JOIN promotion_card_products pc ON pc.promotion_id = p.id
      WHERE pc.product_id = ? AND p.promotion_type = 'welcome_offer' AND p.status = 'published'
      ORDER BY p.end_at IS NULL, p.end_at DESC LIMIT 1`
  )
    .bind(productId)
    .first<Promotion>();
  if (!p) return null;

  const t = termsOf(p);
  const reward = t.reward_miles
    ? `${t.reward_miles.toLocaleString()} miles`
    : t.reward_points
      ? `${t.reward_points.toLocaleString()} points`
      : t.reward_cashback_cents
        ? `$${money(t.reward_cashback_cents)}`
        : 'an unspecified bonus';

  return {
    title: p.title,
    reward,
    requires: t.minimum_spend_cents ? `$${money(t.minimum_spend_cents)} of spend` : null,
  };
}

/**
 * Whether a card can actually be had.
 *
 * Deterministic only. "Likely eligible" is claimed just where the conditions
 * the app can check support it; everything else is `unknown` with the reason,
 * because a confident wrong answer about eligibility costs someone a hard
 * credit search.
 */
async function eligibility(
  env: Env,
  productId: number
): Promise<{ verdict: 'eligible' | 'ineligible' | 'unknown'; note: string | null }> {
  const closed = await env.DB.prepare(
    `SELECT closed_at FROM cards WHERE product_id = ? AND closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 1`
  )
    .bind(productId)
    .first<{ closed_at: string }>();

  // Most Singapore issuers exclude anyone who held the card recently, and the
  // closing date is one of the few eligibility facts the app actually knows.
  if (closed) {
    const months = Math.round((Date.parse(today(env)) - Date.parse(closed.closed_at)) / (30 * 86_400_000));
    if (months < 12) {
      return {
        verdict: 'ineligible',
        note: `You closed this card ${months} month(s) ago; most issuers exclude a recent holder from the sign-up offer.`,
      };
    }
  }

  return { verdict: 'unknown', note: 'Income and existing-relationship requirements are not known to the app.' };
}

/**
 * What to consider acquiring, and what not to.
 *
 * Gaps are computed first and reported whether or not any card closes them: the
 * useful answer is sometimes "your dining spend is uncovered and no card in the
 * catalogue fixes it cheaply", and a card-first pipeline can never say that.
 */
export async function acquisitionReport(
  env: Env,
  opts: { months?: number; objective?: Objective; limit?: number } = {}
): Promise<AcquisitionReport> {
  const months = opts.months ?? DEFAULT_HISTORY_MONTHS;
  const objective = opts.objective ?? 'balanced';
  const profile = await spendingProfile(env, months);
  const gaps = await portfolioGaps(env, months);

  const suggestions: AcquisitionSuggestion[] = [];
  const rejected: { product_name: string; why: string }[] = [];

  for (const product of await candidates(env)) {
    const evaluation = await simulateProduct(env, product, months);
    if (!evaluation.projected_annual_incremental_value_cents && !evaluation.assumptions.length) continue;

    evaluation.welcome_offer = await welcomeOffer(env, product.id);
    const elig = await eligibility(env, product.id);
    evaluation.eligibility = elig.verdict;
    evaluation.eligibility_note = elig.note;

    const complexity = objective === 'simpler_wallet' ? COMPLEXITY_COST_CENTS * 3 : COMPLEXITY_COST_CENTS;
    let score = evaluation.net_value_cents - complexity;

    // A card that mostly repeats one you hold is discounted rather than
    // excluded: it may still be the right answer if a cap is the problem.
    if (evaluation.overlap_score > HEAVY_OVERLAP) {
      score -= Math.round(evaluation.projected_annual_incremental_value_cents * evaluation.overlap_score * 0.5);
    }
    if (objective === 'maximise_miles') score = evaluation.projected_annual_incremental_value_cents - complexity;
    if (objective === 'minimise_fees') score = evaluation.net_value_cents - evaluation.annual_fee_cents - complexity;

    const suggestion: AcquisitionSuggestion = {
      ...evaluation,
      score_cents: score,
      complexity_cost_cents: complexity,
      closes_gaps: gaps
        .filter((g) => evaluation.categories_improved.some((c) => c.category === g.category))
        .map((g) => g.category),
    };

    if (evaluation.eligibility === 'ineligible') {
      rejected.push({ product_name: product.product_name, why: elig.note ?? 'not eligible' });
      continue;
    }
    if (score <= 0) {
      rejected.push({
        product_name: product.product_name,
        why:
          evaluation.annual_fee_cents > evaluation.projected_annual_incremental_value_cents
            ? `its $${money(evaluation.annual_fee_cents)} fee is more than the $${money(evaluation.projected_annual_incremental_value_cents)} a year it would add`
            : evaluation.overlap_score > HEAVY_OVERLAP
              ? 'it mostly repeats a card you already hold'
              : 'it would not add enough to be worth another card to manage',
      });
      continue;
    }
    suggestions.push(suggestion);
  }

  suggestions.sort((a, b) => b.score_cents - a.score_cents);

  const confidence: 'high' | 'medium' | 'low' =
    profile.months_with_data < 3 ? 'low' : profile.months_with_data < months ? 'medium' : 'high';

  return {
    gaps,
    suggestions: suggestions.slice(0, opts.limit ?? 5),
    not_worth_it: rejected,
    history: { months, months_with_data: profile.months_with_data, from: profile.from, to: profile.to },
    objective,
    confidence,
    as_of: today(env),
  };
}
