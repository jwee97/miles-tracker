import { today } from '../spend';
import type { Env } from '../types';
import type { Promotion } from './model';
import { rate, type RelevantPromotion } from './relevance';

/**
 * The offers, in sections.
 *
 * Sectioned rather than sorted, because "ending soon" and "worth checking" are
 * different reasons to look and mixing them means neither reads as urgent.
 *
 * The section this redesign adds is `acquisition`, and it exists because the
 * old model had nowhere to put a welcome offer for a card you do not hold. It
 * marked it not applicable and buried it under Everything — the one place
 * nobody looks — which is how the most actionable kind of offer in the app
 * became the least visible.
 */

export interface Inbox {
  worth_checking: RelevantPromotion[];
  ending_soon: RelevantPromotion[];
  your_cards: RelevantPromotion[];
  /** Cards you could apply for, which the old model could not express at all. */
  acquisition: RelevantPromotion[];
  transfers: RelevantPromotion[];
  /** Everything rated, including what does not apply, for transparency. */
  everything: RelevantPromotion[];
  as_of: string;
}

/** Inside this many days an offer counts as ending soon. */
export const ENDING_SOON_DAYS = 14;

/**
 * Which section each offer belongs in.
 *
 * Membership follows the relationship, not the relevance. An acquisition
 * opportunity belongs under acquisition whether it ranks high or medium; what
 * it is and how interesting it is are different questions, and the section is
 * about the first.
 */
export function sectionsFor(rated: RelevantPromotion[], as_of: string): Inbox {
  const live = rated.filter((r) => r.relevance !== 'not_relevant');

  return {
    worth_checking: live.filter((r) => r.relevance === 'high'),
    ending_soon: live.filter((r) => r.days_left !== null && r.days_left >= 0 && r.days_left <= ENDING_SOON_DAYS),
    your_cards: live.filter((r) => r.relationship === 'held_card' || r.relationship === 'issuer_offer'),
    acquisition: live.filter((r) => r.relationship === 'acquisition_opportunity'),
    transfers: live.filter((r) => r.relationship === 'programme_offer' && r.promotion.promotion_type === 'transfer_bonus'),
    everything: rated,
    as_of,
  };
}

export async function inbox(env: Env): Promise<Inbox> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM promotions WHERE duplicate_of IS NULL AND status IN ('published', 'expired')
      ORDER BY end_at IS NULL, end_at`
  ).all<Promotion>();

  const rated: RelevantPromotion[] = [];
  for (const p of results ?? []) rated.push(await rate(env, p));

  return sectionsFor(rated, today(env));
}
