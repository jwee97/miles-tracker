import type { Card } from '../types';
import {
  isAcquisitionPromotion,
  requiresOwnership,
  type PromotionAudience,
} from './audience';
import type { Promotion, PromotionTerms } from './model';

/**
 * How a promotion relates to this person — and nothing else.
 *
 * This is the concept the old model was missing, and its absence is what made
 * "I do not own this card" and "I cannot use this promotion" the same fact.
 * They are not. A welcome offer on a card you do not hold relates to you as an
 * opportunity; an existing-cardholder offer on that same card does not relate
 * to you at all. Both are "linked product you do not own".
 *
 * Three rules keep this honest:
 *
 * It answers only the relationship. Whether the person can actually qualify is
 * eligibility's job, and whether it is worth showing is relevance's. Folding
 * those together is how the original bug happened.
 *
 * It never treats a product link as an ownership requirement. The link means
 * the promotion concerns that product; the audience says what holding it has
 * to do with anything.
 *
 * And an unknown audience stays unknown. A promotion linked to a card the
 * person does not hold, with no audience established, is `unknown` — not
 * `not_relevant`. Refusing to guess is the point.
 */

export type PromotionRelationship =
  | 'held_card'
  | 'acquisition_opportunity'
  | 'programme_offer'
  | 'issuer_offer'
  | 'general_offer'
  | 'targeted_offer'
  | 'unknown'
  | 'not_relevant';

export const RELATIONSHIPS: PromotionRelationship[] = [
  'held_card',
  'acquisition_opportunity',
  'programme_offer',
  'issuer_offer',
  'general_offer',
  'targeted_offer',
  'unknown',
  'not_relevant',
];

/** How each relationship reads to a person. Never the enum name. */
export const RELATIONSHIP_LABEL: Record<PromotionRelationship, string> = {
  held_card: 'For a card you hold',
  acquisition_opportunity: 'New-card offer',
  programme_offer: 'For your points',
  issuer_offer: 'For this bank’s cardholders',
  general_offer: 'Open offer',
  targeted_offer: 'Invitation required',
  unknown: 'Eligibility unclear',
  not_relevant: 'Not applicable',
};

export interface LinkedProduct {
  product_id: number;
  product_name: string;
  issuer: string | null;
}

export interface PromotionRelationshipResult {
  relationship: PromotionRelationship;
  /** For a programme offer: whether the person holds points it could move. */
  has_programme_balance?: boolean;
  reasons: string[];
  blockers: string[];
  acquisition_product_ids: number[];
  held_product_ids: number[];
  confidence: 'high' | 'medium' | 'low';
}

export interface RelationshipInput {
  promotion: Pick<Promotion, 'promotion_type' | 'issuer'>;
  terms: PromotionTerms;
  audience: PromotionAudience;
  linkedProducts: LinkedProduct[];
  linkedProgrammes: string[];
  userCards: Card[];
  /** Programmes the person holds a positive balance in. */
  userProgrammes: string[];
  /** Variant keys the person said they were personally sent. */
  invitedKeys?: string[];
}

const nameList = (products: LinkedProduct[]): string => {
  const names = products.map((p) => p.product_name).filter(Boolean);
  if (!names.length) return 'this card';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} or ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
};

/**
 * The single place this question is answered.
 *
 * Deliberately one function with one return type: the previous logic was
 * inline in the rating loop and partly restated in the UI, which is how the
 * screen ended up able to say something the engine had not decided.
 */
export function resolvePromotionRelationship(input: RelationshipInput): PromotionRelationshipResult {
  const { promotion, audience, linkedProducts, linkedProgrammes, userCards, userProgrammes } = input;
  const reasons: string[] = [];
  const blockers: string[] = [];

  const open = userCards.filter((c) => !c.closed_at);
  const heldProductIds = new Set(
    open.map((c) => (c as unknown as { product_id?: number }).product_id).filter((n): n is number => typeof n === 'number')
  );
  const linkedIds = linkedProducts.map((p) => p.product_id);
  const held = linkedIds.filter((id) => heldProductIds.has(id));
  const issuer = promotion.issuer ?? audience.issuer ?? linkedProducts.find((p) => p.issuer)?.issuer ?? null;
  const holdsIssuerCard = issuer ? open.some((c) => c.issuer.toLowerCase() === issuer.toLowerCase()) : false;

  // Targeted first. An invitation-only offer is that before it is anything
  // else, and treating it as a public one is how an app promises something
  // the bank never offered this person.
  if (audience.type === 'targeted') {
    const invited = (input.invitedKeys ?? []).length > 0;
    if (invited) reasons.push('You told us you were sent this one.');
    else blockers.push('This appears to be a targeted offer. Confirm you received it before relying on it.');
    return {
      relationship: 'targeted_offer',
      reasons,
      blockers,
      acquisition_product_ids: [],
      held_product_ids: held,
      confidence: audience.confidence ?? 'low',
    };
  }

  // A transfer or conversion promotion is about points, not card ownership.
  // Treating an empty balance as ineligibility would be wrong — the balance
  // can be earned tomorrow, and the offer is still the offer.
  if (promotion.promotion_type === 'transfer_bonus' || promotion.promotion_type === 'points_conversion_offer' || linkedProgrammes.length) {
    const matching = linkedProgrammes.filter((p) => userProgrammes.includes(p));
    if (matching.length) reasons.push(`You have points in ${matching.join(', ')}.`);
    else reasons.push('It applies to a points programme, and you have no balance there at the moment.');
    return {
      relationship: 'programme_offer',
      reasons,
      blockers,
      acquisition_product_ids: [],
      held_product_ids: held,
      has_programme_balance: matching.length > 0,
      confidence: matching.length ? 'high' : 'medium',
    };
  }

  // Holding one of the named cards settles it, whatever the audience says:
  // if the offer concerns a card you hold, it relates to you.
  if (held.length) {
    reasons.push(`You hold ${nameList(linkedProducts.filter((p) => held.includes(p.product_id)))}.`);
    return {
      relationship: 'held_card',
      reasons,
      blockers,
      acquisition_product_ids: [],
      held_product_ids: held,
      confidence: 'high',
    };
  }

  // Not held. What that means is entirely the audience's answer.
  if (isAcquisitionPromotion(promotion, audience)) {
    reasons.push(
      audience.type === 'new_to_bank'
        ? 'It is for customers new to this bank.'
        : audience.type === 'new_to_card'
          ? 'It is for people who have not held this card.'
          : 'This offer is for new applicants.'
    );
    if (linkedProducts.length) reasons.push(`You do not currently hold ${nameList(linkedProducts)}, which this offer is for.`);
    return {
      relationship: 'acquisition_opportunity',
      reasons,
      blockers,
      acquisition_product_ids: linkedIds,
      held_product_ids: [],
      confidence: audience.type === 'unknown' ? 'medium' : (audience.confidence ?? 'medium'),
    };
  }

  if (audience.type === 'issuer_cardholder' || audience.type === 'existing_cardholder') {
    if (holdsIssuerCard) {
      reasons.push(`You hold a ${issuer} card, and this is for ${issuer} cardholders.`);
      return {
        relationship: 'issuer_offer',
        reasons,
        blockers,
        acquisition_product_ids: [],
        held_product_ids: held,
        confidence: audience.confidence ?? 'medium',
      };
    }
    blockers.push(
      issuer
        ? `This promotion is only for existing ${issuer} cardholders, and you do not currently hold one.`
        : 'This promotion is only for existing cardholders of this bank, and you do not hold one.'
    );
    return {
      relationship: 'not_relevant',
      reasons,
      blockers,
      acquisition_product_ids: [],
      held_product_ids: [],
      confidence: audience.confidence ?? 'medium',
    };
  }

  if (audience.type === 'specific_product_holder') {
    blockers.push(
      `This promotion is only for existing ${nameList(linkedProducts)} holders, and you do not currently hold the card.`
    );
    return {
      relationship: 'not_relevant',
      reasons,
      blockers,
      acquisition_product_ids: [],
      held_product_ids: [],
      confidence: audience.confidence ?? 'medium',
    };
  }

  if (audience.type === 'public' && !linkedProducts.length) {
    reasons.push('No card-specific ownership requirement was identified.');
    return {
      relationship: 'general_offer',
      reasons,
      blockers,
      acquisition_product_ids: [],
      held_product_ids: [],
      confidence: audience.confidence ?? 'medium',
    };
  }

  if (!linkedProducts.length && !linkedProgrammes.length) {
    // Nothing ties it to a card or a programme. That is an open offer as far
    // as ownership goes — said in terms of what was checked, not as a promise
    // that anyone may have it.
    reasons.push('No card-specific ownership requirement was identified.');
    return {
      relationship: 'general_offer',
      reasons,
      blockers,
      acquisition_product_ids: [],
      held_product_ids: [],
      confidence: 'low',
    };
  }

  // Linked to a card, not held, audience not established. This is the case the
  // old model got wrong in the most damaging direction: it concluded "not for
  // you" from evidence that established nothing at all.
  blockers.push(
    `This offer is linked to ${nameList(linkedProducts)}, but we could not determine whether it is for existing cardholders or new applicants.`
  );
  return {
    relationship: 'unknown',
    reasons,
    blockers,
    acquisition_product_ids: linkedIds,
    held_product_ids: [],
    confidence: 'low',
  };
}

/** Whether a relationship means the person could act on the offer today. */
export const isActionable = (r: PromotionRelationship): boolean =>
  r === 'held_card' || r === 'acquisition_opportunity' || r === 'programme_offer' || r === 'issuer_offer' || r === 'general_offer';

export { requiresOwnership };
