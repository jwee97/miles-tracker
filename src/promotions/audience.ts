import type { PromotionType } from './model';

/**
 * Who a promotion is for — which is not the same question as which card it
 * mentions.
 *
 * The model this replaces had one fact where there are three. It knew that a
 * promotion was linked to a card product, that the person did not hold that
 * card, and it concluded the promotion did not apply to them. That inference
 * is right for "existing OCBC Rewards cardholders get $20 back" and exactly
 * backwards for "apply for the OCBC Rewards Card and get 20,000 miles" — the
 * second is the card being *offered*, and not holding it is the precondition
 * rather than the disqualification.
 *
 * So a link between a promotion and a product now means only "this promotion
 * concerns this product". Whether holding it is required, forbidden, or
 * irrelevant is what the audience says.
 *
 * The other half of the design is what happens when nobody knows. "No
 * restriction was extracted" is not evidence that a promotion is open to
 * everyone — most articles simply do not spell out eligibility — so absence
 * of evidence resolves to `unknown`, never to `public`. `public` requires
 * something positive to have said so.
 */

export type PromotionAudienceType =
  | 'public'
  | 'new_to_bank'
  | 'new_to_card'
  | 'new_applicant'
  | 'existing_cardholder'
  | 'specific_product_holder'
  | 'issuer_cardholder'
  | 'targeted'
  | 'unknown';

export const AUDIENCE_TYPES: PromotionAudienceType[] = [
  'public',
  'new_to_bank',
  'new_to_card',
  'new_applicant',
  'existing_cardholder',
  'specific_product_holder',
  'issuer_cardholder',
  'targeted',
  'unknown',
];

export interface PromotionAudience {
  type: PromotionAudienceType;
  /** The issuer the restriction is about, when it names one. */
  issuer?: string | null;
  /** Products the restriction is about, when it names them. */
  product_ids?: number[];
  /**
   * The words the classification came from, kept always.
   *
   * Without it an audience is an assertion nobody can check. With it a
   * reviewer can see that "new-to-bank" came from "Applicants must not have
   * held any OCBC Credit Card in the previous 12 months" and disagree.
   */
  raw_text?: string | null;
  /** Months of exclusion, when the wording gives a number. */
  exclusion_months?: number | null;
  confidence?: 'high' | 'medium' | 'low';
}

export const UNKNOWN_AUDIENCE: PromotionAudience = { type: 'unknown', confidence: 'low', raw_text: null };

/** How each audience reads to a person. Never the enum name. */
export const AUDIENCE_LABEL: Record<PromotionAudienceType, string> = {
  public: 'Open to anyone',
  new_to_bank: 'New customers of this bank',
  new_to_card: 'People who have not held this card',
  new_applicant: 'New applicants',
  existing_cardholder: 'Existing cardholders',
  specific_product_holder: 'Holders of a particular card',
  issuer_cardholder: "Any of this bank's cardholders",
  targeted: 'By invitation only',
  unknown: 'Not established',
};

/**
 * Audiences that qualify by *getting* the card rather than by already having
 * it. Holding the card is not required and is often disqualifying.
 */
export const ACQUISITION_AUDIENCES: PromotionAudienceType[] = ['new_to_bank', 'new_to_card', 'new_applicant'];

/** Audiences that require the person to already hold something. */
export const OWNERSHIP_AUDIENCES: PromotionAudienceType[] = [
  'existing_cardholder',
  'specific_product_holder',
  'issuer_cardholder',
];

export const requiresOwnership = (a: PromotionAudienceType): boolean => OWNERSHIP_AUDIENCES.includes(a);

/**
 * Whether qualifying means acquiring the product.
 *
 * Both signals are consulted, and neither alone is trusted. `promotion_type`
 * is not enough because a spend bonus can perfectly well be restricted to new
 * applicants; the audience is not enough because plenty of welcome offers
 * never spell their audience out, and a welcome offer is an acquisition offer
 * by definition of what it is.
 */
export function isAcquisitionPromotion(
  promotion: { promotion_type: PromotionType | string },
  audience: PromotionAudience | null | undefined
): boolean {
  const type = audience?.type ?? 'unknown';
  if (ACQUISITION_AUDIENCES.includes(type)) return true;
  // An audience that positively requires ownership overrides the type: a
  // "welcome offer" restricted to existing cardholders is miscategorised, and
  // the explicit restriction is the better evidence.
  if (requiresOwnership(type) || type === 'targeted') return false;
  return promotion.promotion_type === 'welcome_offer';
}

/** Read the audience back off stored terms, without ever inventing one. */
export function audienceOf(terms: Record<string, unknown> | null | undefined): PromotionAudience {
  const raw = terms?.audience;
  if (!raw || typeof raw !== 'object') return UNKNOWN_AUDIENCE;
  const a = raw as PromotionAudience;
  if (!AUDIENCE_TYPES.includes(a.type)) return UNKNOWN_AUDIENCE;
  return {
    type: a.type,
    issuer: a.issuer ?? null,
    product_ids: Array.isArray(a.product_ids) ? a.product_ids.filter((n) => typeof n === 'number') : undefined,
    raw_text: a.raw_text ?? null,
    exclusion_months: typeof a.exclusion_months === 'number' ? a.exclusion_months : null,
    confidence: a.confidence ?? 'low',
  };
}

/**
 * Read an audience out of eligibility prose.
 *
 * Ordered most specific first, because the phrasings overlap: "existing OCBC
 * Rewards cardmembers" contains "existing … cardmembers", and resolving it to
 * the general case would lose the fact that one particular card is required.
 *
 * Everything unmatched stays `unknown`. That is the rule the whole redesign
 * turns on — an extractor that finds no restriction has learned nothing about
 * who may apply, and saying "open to anyone" on that basis is a guess dressed
 * as a fact.
 */
export function classifyAudience(text: string | null | undefined): PromotionAudience {
  const t = (text ?? '').trim();
  if (!t) return UNKNOWN_AUDIENCE;
  const l = t.toLowerCase();

  const found = (
    type: PromotionAudienceType,
    confidence: 'high' | 'medium' | 'low',
    extra: Partial<PromotionAudience> = {}
  ): PromotionAudience => ({ type, confidence, raw_text: t.slice(0, 400), ...extra });

  // Invitation first: a targeted offer may describe any other audience inside
  // its wording, and being targeted is the fact that decides what to do.
  if (/\b(selected|targeted|by invitation|invitation only|invited (?:customers|cardmembers)|if you (?:were|are) invited|emailed to selected)\b/.test(l)) {
    return found('targeted', 'high');
  }

  const months = l.match(/\b(?:previous|last|past|preceding)\s+(\d{1,2})\s+months?\b/);
  const exclusion = months ? Number(months[1]) : null;

  // New-to-bank: no card from this issuer, ever or within a window.
  if (
    /\bnew[-\s]?to[-\s]?bank\b/.test(l) ||
    /\b(?:must )?not (?:have )?(?:held|had|possessed)[^.]{0,60}\b(?:any|a)\b[^.]{0,40}\bcredit card\b/.test(l) ||
    /\bno (?:existing|prior|previous)[^.]{0,30}\bcard(?:holder)?s?\b[^.]{0,40}\b(?:with|from|of) (?:the )?bank\b/.test(l)
  ) {
    return found('new_to_bank', 'high', { exclusion_months: exclusion });
  }

  if (/\bnew[-\s]to[-\s]this[-\s]card\b|\bhave not (?:previously )?held this card\b|\bfirst[-\s]time holders? of this card\b/.test(l)) {
    return found('new_to_card', 'high', { exclusion_months: exclusion });
  }

  // A named card required, which is a stricter fact than "existing cardholder".
  // No extra `\bcard\b` guard: "cardmembers" has no word boundary after
  // "card", so requiring one rejected the very phrasing this branch is for.
  if (/\bexisting\b[^.]{0,60}\b(?:card ?members?|card ?holders?)\b/.test(l)) {
    const named = l.match(/\bexisting\s+([a-z0-9][a-z0-9'’\-\s]{2,40}?)\s+card\s?(?:members?|holders?)\b/);
    if (named && !/^(?:bank|credit|principal|primary)$/.test(named[1].trim())) {
      return found('specific_product_holder', 'medium', { raw_text: t.slice(0, 400) });
    }
  }

  if (/\ball\b[^.]{0,30}\bcard ?(?:members?|holders?)\b|\bany\b[^.]{0,30}\bcard ?(?:members?|holders?)\b/.test(l)) {
    return found('issuer_cardholder', 'medium');
  }

  if (/\bexisting\s+(?:customers?|card ?members?|card ?holders?)\b/.test(l)) {
    return found('existing_cardholder', 'medium');
  }

  if (
    /\bnew\s+(?:card ?members?|card ?holders?|applicants?|customers?)\b/.test(l) ||
    /\bapply\s+(?:now\s+)?for\b/.test(l) ||
    /\bsign[-\s]?up\b/.test(l) ||
    /\bprincipal card ?(?:members?|holders?) who (?:have|has) not\b/.test(l)
  ) {
    return found('new_applicant', 'high', { exclusion_months: exclusion });
  }

  // Positive evidence of openness, and only that, earns `public`.
  if (/\bopen to all\b|\ball customers\b|\bno (?:minimum |)eligibility (?:criteria|requirements?)\b|\banyone (?:can|may) apply\b/.test(l)) {
    return found('public', 'medium');
  }

  return { ...UNKNOWN_AUDIENCE, raw_text: t.slice(0, 400) };
}

/**
 * What an existing promotion's audience should be taken to be, given only what
 * the old model recorded.
 *
 * Deliberately conservative. A welcome offer is an acquisition offer by
 * definition, so that inference is safe; a transfer bonus concerns a
 * programme rather than card ownership, so it is public in the only sense
 * that matters here. Everything else becomes `unknown`, because the previous
 * model never asked the question and inventing an answer for a whole table of
 * existing rows is precisely the guess this redesign exists to stop.
 */
export function backfillAudience(promotionType: string): PromotionAudience {
  if (promotionType === 'welcome_offer') {
    return { type: 'new_applicant', confidence: 'medium', raw_text: null };
  }
  if (promotionType === 'transfer_bonus' || promotionType === 'points_conversion_offer') {
    return { type: 'public', confidence: 'low', raw_text: null };
  }
  return { ...UNKNOWN_AUDIENCE };
}
