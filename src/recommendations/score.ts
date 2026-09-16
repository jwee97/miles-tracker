import type { Evaluation, Objective } from '../rules';

/**
 * Why one card ranks above another, as numbers you can read.
 *
 * The old engine added 1,000,000 to a score when a minimum spend was urgent.
 * It behaved correctly and was impossible to reason about: nobody could say
 * what a million meant, or what would have to change for a better rate to win
 * anyway. The same behaviour is kept, but every term is named, bounded and
 * tested, so the ranking can be explained and tuned rather than divined.
 *
 * The user never sees these. A developer can.
 */
export interface ScoreComponents {
  /** What the purchase is worth on this card, in cents. Always the base term. */
  reward_value: number;
  /** Ranking under the chosen objective: miles-first, cashback-first, or value. */
  objective_bonus: number;
  /** An unmet minimum this spend would go toward. */
  minimum_spend_bonus: number;
  /** That minimum closing soon. Separate from the bonus: near is not the same as due. */
  urgency_bonus: number;
  /** Assumptions that could be wrong in a way that changes the answer. */
  uncertainty_penalty: number;
  /** The bonus rate is spent; what is left is the base rate. */
  exhausted_cap_penalty: number;
}

/**
 * The bands. Each is an order of magnitude clear of the one below, so a term
 * can never be outvoted by an accumulation of smaller ones — which is what
 * "an urgent minimum wins" has to mean to be worth saying.
 */
export const WEIGHTS = {
  /** A minimum that closes inside the warning window outranks any rate. */
  urgent_minimum: 1_000_000,
  /** Under the minspend objective, clearing a minimum outranks even urgency. */
  objective_minspend: 10_000_000,
  /** An unmet minimum with time left is a tiebreaker, not a trump. */
  standing_minimum: 100,
  /** Preferring the objective's own currency, without ignoring value. */
  objective_currency: 1_000,
  /** Each material unknown, deducted from the reward value. */
  uncertainty_each: 250,
  /** The bonus rate no longer applies to any of this purchase. */
  cap_exhausted: 500,
} as const;

export const emptyComponents = (): ScoreComponents => ({
  reward_value: 0,
  objective_bonus: 0,
  minimum_spend_bonus: 0,
  urgency_bonus: 0,
  uncertainty_penalty: 0,
  exhausted_cap_penalty: 0,
});

export const totalScore = (c: ScoreComponents): number =>
  c.reward_value +
  c.objective_bonus +
  c.minimum_spend_bonus +
  c.urgency_bonus +
  c.uncertainty_penalty +
  c.exhausted_cap_penalty;

/**
 * Score one evaluated card.
 *
 * An excluded card is not scored low — it is disqualified, which is a
 * different thing and handled by the caller. Scoring only ever orders the
 * cards that could legitimately be used.
 */
export function scoreOf(
  e: Evaluation,
  opts: { objective: Objective; warn_days: number; unknowns: number }
): ScoreComponents {
  const c = emptyComponents();
  const { objective, warn_days, unknowns } = opts;

  c.reward_value = e.value_cents;

  // The objective decides which currency wins a tie, not how big a number is.
  if (objective === 'miles' && e.reward_type === 'miles') c.objective_bonus = WEIGHTS.objective_currency;
  else if (objective === 'cashback' && e.reward_type === 'cashback') c.objective_bonus = WEIGHTS.objective_currency;

  if (e.min_spend_short_cents > 0) {
    const urgent = e.min_spend_days_left !== null && e.min_spend_days_left <= warn_days;
    if (objective === 'minspend') {
      c.minimum_spend_bonus = WEIGHTS.objective_minspend;
    } else {
      c.minimum_spend_bonus = WEIGHTS.standing_minimum;
      if (urgent) c.urgency_bonus = WEIGHTS.urgent_minimum;
    }
  }

  // Each unknown that could change the answer costs a fixed amount, so two
  // uncertain cards still order by reward rather than collapsing together.
  c.uncertainty_penalty = -unknowns * WEIGHTS.uncertainty_each;

  // Nothing of this purchase earns the bonus rate: a real disadvantage against
  // a card whose bonus is still available, and invisible in value alone when
  // the base rates happen to match.
  if (e.cap_cents !== null && e.headroom_cents !== null && e.headroom_cents <= 0) {
    c.exhausted_cap_penalty = -WEIGHTS.cap_exhausted;
  }

  return c;
}
