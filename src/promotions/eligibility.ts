import { evaluateRule } from '../eligibility';
import type { Card, Env, Predicate } from '../types';
import { requiresOwnership, type PromotionAudience } from './audience';
import type { PromotionRelationship } from './relationship';
import type { LinkedProduct } from './relationship';

/**
 * Whether this person can qualify — computed, never guessed.
 *
 * The whole point of separating this from relevance is that they fail
 * differently. Relevance being wrong shows you an offer you did not want;
 * eligibility being wrong sends you to apply for a card you cannot have, which
 * costs a hard credit pull and, on most Singapore issuers, a twelve-month
 * cooldown before you can try again.
 *
 * So this reuses the predicate evaluator the app already had for offers. That
 * evaluator reads the person's own card history and returns pass, fail or
 * unknown, and it returns `unknown` freely — a clause about income cannot be
 * settled from card history, and saying so is the correct answer. Extraction
 * may turn prose into predicates; only this code decides what the predicates
 * mean.
 *
 * Nothing here consults a model. AI can propose that a sentence means
 * "new-to-bank"; whether *you* are new to that bank is arithmetic over rows
 * you entered.
 */

export type PromotionEligibility = 'eligible' | 'potentially_eligible' | 'ineligible' | 'unknown' | 'needs_review';

export const ELIGIBILITY_LABEL: Record<PromotionEligibility, string> = {
  eligible: 'Eligible',
  potentially_eligible: 'Potentially eligible',
  ineligible: 'Not eligible',
  unknown: 'Eligibility unclear',
  needs_review: 'Needs review',
};

export interface EligibilityAssessment {
  status: PromotionEligibility;
  /** Conditions the person's own history settles in their favour. */
  confirmed: string[];
  /** Conditions nothing on record can settle. */
  unresolved: string[];
  /** Conditions the person's history rules out. */
  failed: string[];
  reasons: string[];
}

const blank = (): EligibilityAssessment => ({ status: 'unknown', confirmed: [], unresolved: [], failed: [], reasons: [] });

/**
 * The predicates an audience implies.
 *
 * Only what the wording actually supports. "New-to-bank" with no stated window
 * means never having held a card from that issuer; with a window it means not
 * within it. Nothing invents a window that was not written down, because a
 * twelve-month rule applied to a bank that has no such rule would report
 * someone ineligible for an offer they could take.
 */
export function predicatesFor(
  audience: PromotionAudience,
  opts: { issuer: string | null; productKeys: string[] }
): Predicate[] {
  const out: Predicate[] = [];
  const issuer = audience.issuer ?? opts.issuer;
  const months = audience.exclusion_months ?? null;

  if (audience.type === 'new_to_bank' && issuer) {
    out.push(months ? { type: 'no_issuer_card_within_months', issuer, months } : { type: 'new_to_bank', issuer });
  }

  if (audience.type === 'new_to_card' || audience.type === 'new_applicant') {
    for (const key of opts.productKeys) {
      out.push(months ? { type: 'no_product_within_months', product_key: key, months } : { type: 'never_held_product', product_key: key });
    }
  }

  return out;
}

export interface EligibilityInput {
  env: Env;
  audience: PromotionAudience;
  relationship: PromotionRelationship;
  linkedProducts: LinkedProduct[];
  productKeys: string[];
  issuer: string | null;
  cards: Card[];
  /** True when the person said they were personally sent this offer. */
  invited?: boolean;
  /** Blockers the relationship already established, which are eligibility facts too. */
  relationshipBlockers?: string[];
}

export function evaluatePromotionEligibility(input: EligibilityInput): EligibilityAssessment {
  const { env, audience, relationship, cards, issuer, productKeys } = input;
  const result = blank();

  // A relationship of not_relevant is already a settled eligibility failure:
  // the offer requires something the person demonstrably does not have.
  if (relationship === 'not_relevant') {
    result.status = 'ineligible';
    result.failed.push(...(input.relationshipBlockers ?? ['This promotion requires a card you do not hold.']));
    result.reasons.push('The offer requires an existing card that is not in your wallet.');
    return result;
  }

  // An invitation cannot be computed. Either the person says they got one or
  // nobody knows, and assuming it is how an app promises what a bank did not.
  if (relationship === 'targeted_offer') {
    if (input.invited) {
      result.status = 'potentially_eligible';
      result.confirmed.push('You told us you were sent this offer.');
    } else {
      result.status = 'needs_review';
      result.unresolved.push('Whether you were sent this offer cannot be checked from here.');
      result.reasons.push('Targeted offers are private to the person invited.');
    }
    return result;
  }

  // A programme offer turns on having points, and having none today is not a
  // disqualification — it is a balance, and balances change.
  if (relationship === 'programme_offer') {
    result.status = 'potentially_eligible';
    result.confirmed.push('No card ownership is required for a points promotion.');
    return result;
  }

  const predicates = predicatesFor(audience, { issuer, productKeys });

  if (!predicates.length) {
    if (relationship === 'unknown' || audience.type === 'unknown') {
      result.status = 'needs_review';
      result.unresolved.push('The audience for this promotion could not be established from its terms.');
      result.reasons.push('Read the bank’s terms before applying.');
      return result;
    }
    if (relationship === 'held_card' || relationship === 'issuer_offer') {
      result.status = 'potentially_eligible';
      result.confirmed.push('You hold a card this promotion applies to.');
      return result;
    }
    if (relationship === 'acquisition_opportunity') {
      // Nothing to check beyond not holding it, which the relationship settled.
      result.status = 'potentially_eligible';
      result.confirmed.push('You do not currently hold this card.');
      result.unresolved.push('Income and any other bank conditions are not recorded here.');
      return result;
    }
    result.status = 'potentially_eligible';
    result.confirmed.push('No ownership condition was identified.');
    return result;
  }

  for (const pred of predicates) {
    const { verdict, reason } = evaluateRule(pred, cards, env);
    if (verdict === 'pass') result.confirmed.push(reason);
    else if (verdict === 'fail') result.failed.push(reason);
    else result.unresolved.push(reason);
  }

  // A single failed condition settles it. The others do not soften it: a bank
  // rule that excludes you excludes you, however many you pass.
  if (result.failed.length) {
    result.status = 'ineligible';
    result.reasons.push('Your card history does not meet a condition this promotion requires.');
    return result;
  }

  if (result.unresolved.length) {
    result.status = 'potentially_eligible';
    result.reasons.push('Everything checkable passes; the rest is not knowable from your card history.');
    return result;
  }

  result.status = 'eligible';
  result.reasons.push('Every condition that could be checked passes.');
  return result;
}
