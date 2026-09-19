import { today } from '../spend';
import type { Env } from '../types';
import { simulateProduct, type AcquisitionEvaluation } from '../acquisition/simulate';
import type { CardProduct } from '../catalog/products';
import { audienceOf, AUDIENCE_LABEL } from './audience';
import { rate } from './relevance';
import type { EligibilityAssessment } from './eligibility';
import type { Promotion } from './model';
import { termsOf } from './model';

/**
 * Analysing a card you are being offered.
 *
 * Two numbers that must never be added together. What a card earns every year
 * from how you actually spend is recurring; a welcome bonus happens once, and
 * a card whose whole case rests on it is a card worth having for one year.
 * Folding them into a single figure is how a comparison flatters the wrong
 * card, so the simulator keeps them apart and this keeps that separation all
 * the way to the screen — first-year and steady-state are shown as different
 * numbers with the offer's expiry beside them.
 *
 * The eligibility shown here is the promotion's own assessment, reused rather
 * than recomputed. Two engines answering "can I get this card" is two chances
 * to disagree in front of someone about to take a hard credit pull.
 */

export interface AcquisitionOpportunity {
  product: { product_id: number; product_name: string; issuer: string | null };
  evaluation: AcquisitionEvaluation | null;

  /** The offer that prompted the analysis, when one did. */
  promotion: {
    id: number;
    title: string;
    end_at: string | null;
    days_left: number | null;
    audience: string;
    reward: string | null;
    minimum_spend_cents: number | null;
  } | null;

  /** Reused from the promotion, never recomputed. */
  eligibility: {
    status: EligibilityAssessment['status'];
    confirmed: string[];
    unresolved: string[];
    failed: string[];
  } | null;

  value: {
    /** What the card earns each year from how you already spend. */
    ongoing_annual_cents: number;
    /** What the offer pays once, kept out of the annual figure. */
    welcome_once_cents: number;
    /** The two added, stated as a first year rather than as a rate. */
    first_year_cents: number;
    /** What remains after the offer ends, which is the number that persists. */
    after_offer_annual_cents: number;
  };

  notes: string[];
  as_of: string;
}

const rewardText = (t: Record<string, unknown>): string | null => {
  const n = (v: unknown) => (typeof v === 'number' && v > 0 ? v : null);
  if (n(t.reward_miles)) return `${(t.reward_miles as number).toLocaleString()} miles`;
  if (n(t.reward_points)) return `${(t.reward_points as number).toLocaleString()} points`;
  if (n(t.reward_cashback_cents)) return `$${((t.reward_cashback_cents as number) / 100).toFixed(2)} cashback`;
  if (n(t.bonus_pct)) return `${t.bonus_pct}% bonus`;
  return null;
};

/** What a one-off reward is worth in cents, for showing beside the annual figure. */
function welcomeValueCents(t: Record<string, unknown>, mileValueCents: number): number {
  const miles = typeof t.reward_miles === 'number' ? t.reward_miles : 0;
  const points = typeof t.reward_points === 'number' ? t.reward_points : 0;
  const cash = typeof t.reward_cashback_cents === 'number' ? t.reward_cashback_cents : 0;
  return Math.round((miles + points) * mileValueCents) + cash;
}

export async function analyseAcquisition(
  env: Env,
  opts: { product_id: number; promotion_id?: number | null; history_months?: number }
): Promise<AcquisitionOpportunity | { error: string }> {
  const product = await env.DB.prepare(`SELECT * FROM card_products WHERE id = ?`)
    .bind(opts.product_id)
    .first<CardProduct>();
  if (!product) return { error: 'no such card' };

  const mileValue = parseFloat(env.MILE_VALUE_CENTS || '1.5');
  const notes: string[] = [];

  let evaluation: AcquisitionEvaluation | null = null;
  try {
    evaluation = await simulateProduct(env, product, Math.min(12, Math.max(1, opts.history_months ?? 6)));
  } catch (e) {
    notes.push(`The spending simulation could not be run: ${(e as Error).message}`);
  }

  let promotion: AcquisitionOpportunity['promotion'] = null;
  let eligibility: AcquisitionOpportunity['eligibility'] = null;
  let welcomeOnce = 0;

  if (opts.promotion_id) {
    const p = await env.DB.prepare(`SELECT * FROM promotions WHERE id = ?`).bind(opts.promotion_id).first<Promotion>();
    if (p) {
      const rated = await rate(env, p);
      const t = termsOf(p) as unknown as Record<string, unknown>;
      welcomeOnce = welcomeValueCents(t, mileValue);
      promotion = {
        id: p.id,
        title: p.title,
        end_at: p.end_at,
        days_left: rated.days_left,
        audience: AUDIENCE_LABEL[audienceOf(t).type],
        reward: rewardText(t),
        minimum_spend_cents: typeof t.minimum_spend_cents === 'number' ? t.minimum_spend_cents : null,
      };
      eligibility = rated.eligibility;

      if (rated.days_left !== null && rated.days_left < 0) {
        notes.push('This offer has ended. The ongoing value below still stands; the one-off does not.');
        welcomeOnce = 0;
      } else if (rated.days_left !== null) {
        notes.push(`The offer ends in ${rated.days_left} day${rated.days_left === 1 ? '' : 's'}.`);
      }
    }
  }

  // Net of the annual fee: a card that earns $200 and costs $190 has earned $10.
  const ongoing = evaluation?.net_value_cents ?? 0;

  // Said out loud because it is the single most common way a card comparison
  // misleads: a large one-off makes a mediocre card look excellent for exactly
  // one year.
  if (welcomeOnce > 0) {
    notes.push('The welcome offer is counted once and kept out of the annual figure — it does not repeat.');
  }

  return {
    product: { product_id: product.id, product_name: product.product_name, issuer: product.issuer },
    evaluation,
    promotion,
    eligibility,
    value: {
      ongoing_annual_cents: ongoing,
      welcome_once_cents: welcomeOnce,
      first_year_cents: ongoing + welcomeOnce,
      after_offer_annual_cents: ongoing,
    },
    notes,
    as_of: today(env),
  };
}
