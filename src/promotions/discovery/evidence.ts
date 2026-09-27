import type { PromotionType } from '../model';

/**
 * Is there actually an offer here?
 *
 * Mentioning miles is not an offer. Mentioning cashback is not an offer. A
 * credit card article says both on every page, and treating either as evidence
 * is what turned a review into a promotion.
 *
 * An offer is a **condition paired with an incremental reward**, and it is
 * temporary. "Spend $500 within 60 days and receive $288 cashback" is an
 * offer. "Earn 1.3 mpd on your spending" is a card doing its job. The
 * difference is not the vocabulary, it is whether something has to happen by a
 * date that will pass.
 */

export interface EvidenceSignal {
  kind:
    | 'deadline'
    | 'limited_time'
    | 'welcome'
    | 'promo_code'
    | 'registration'
    | 'spend_and_receive'
    | 'temporary_bonus'
    | 'transfer';
  quote: string;
}

export interface PromotionEvidence {
  signals: EvidenceSignal[];
  /** A date something closes on, or explicit temporariness. */
  temporary: boolean;
  /** Something must be done to earn it — a spend, a registration, an application. */
  conditional: boolean;
  /** A reward paid on top of what the card already pays. */
  incremental: boolean;
  /** The bar for a document that announces itself as a promotion. */
  sufficient: boolean;
  /** The higher bar for a review or product page, where every number is a rate. */
  sufficient_for_review: boolean;
  reasons: string[];
}

const PATTERNS: { kind: EvidenceSignal['kind']; re: RegExp; temporary?: boolean; conditional?: boolean; incremental?: boolean }[] = [
  {
    // A date the thing stops being available on. Written broadly because there
    // are many ways to say it and only one thing they all mean — but it still
    // requires an actual date, so an article merely mentioning October does
    // not qualify.
    kind: 'deadline',
    re: /\b(?:apply|register|sign\s?up|redeem|transfer|convert)\s+(?:by|before|on or before)\s+\d{1,2}\s*[a-z]{3,9}|\b(?:ends?|expires?|closes?)\s+(?:on\s+)?\d{1,2}\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b(?:until|till|through|by)\s+\d{1,2}\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\bvalid\s+(?:till|until|through)\s+\d/i,
    temporary: true,
  },
  {
    // A threshold you have to reach is a condition, however the sentence is
    // arranged. "16,000 bonus miles with $800 spend" states one without ever
    // using the word "if".
    kind: 'spend_and_receive',
    re: /\bmin(?:imum)?\.?\s*spend\b|\bspend\s+(?:of\s+)?(?:s\$|\$)\s?[\d,]+|\bwith\s+(?:a\s+)?(?:s\$|\$)\s?[\d,]+\s+(?:in\s+)?spend|\bwhen\s+you\s+spend\b|\bfor\s+(?:s\$|\$)\s?[\d,]+\s+spend\b/i,
    conditional: true,
  },
  { kind: 'limited_time', re: /\blimited[- ]time\b|\bfor a limited period\b|\bwhile stocks last\b/i, temporary: true },
  {
    kind: 'welcome',
    re: /\bwelcome (?:offer|bonus|gift)\b|\bsign[- ]?up bonus\b|\bnew[- ]to[- ]bank\b|\bnew cardmember(?:s)? (?:offer|bonus)\b/i,
    temporary: true,
    conditional: true,
    incremental: true,
  },
  { kind: 'promo_code', re: /\bpromo(?:tion)? code\b|\bcoupon code\b|\buse code\s+[A-Z0-9]{3,}/i, temporary: true, conditional: true },
  { kind: 'registration', re: /\bregistration (?:is )?required\b|\bmust register\b|\bopt[- ]?in (?:is )?required\b/i, conditional: true },
  {
    // The shape of an offer, stated outright: do this, get that.
    kind: 'spend_and_receive',
    re: /\bspend\s+(?:s\$|\$)\s?[\d,]+[^.]{0,80}?\b(?:and|to)\b[^.]{0,40}?\b(?:receive|get|earn|enjoy|redeem)\b/i,
    conditional: true,
    incremental: true,
  },
  {
    kind: 'temporary_bonus',
    re: /\bbonus\s+(?:miles|points)\b|\b\d{1,3}\s?%\s*(?:transfer\s+)?bonus\b|\badditional\s+(?:miles|points|cash\s?back)\b|\bextra\s+(?:miles|points)\b/i,
    incremental: true,
  },
  {
    kind: 'transfer',
    re: /\btransfer(?:ring)?\s+(?:your\s+)?(?:points|miles)\b|\bconvert(?:ing)?\s+(?:your\s+)?points\b|\bpoints?\s+transfer\b|\bconversion bonus\b/i,
  },
];

export function promotionEvidence(text: string): PromotionEvidence {
  const signals: EvidenceSignal[] = [];
  let temporary = false;
  let conditional = false;
  let incremental = false;

  for (const p of PATTERNS) {
    const m = p.re.exec(text);
    if (!m) continue;
    signals.push({ kind: p.kind, quote: m[0].slice(0, 140).trim() });
    temporary ||= !!p.temporary;
    conditional ||= !!p.conditional;
    incremental ||= !!p.incremental;
  }

  const reasons: string[] = [];
  if (!signals.length) reasons.push('nothing in the text describes a temporary or conditional offer');
  if (!temporary) reasons.push('no deadline, and nothing saying the offer is limited in time');
  if (!conditional) reasons.push('nothing has to be done to earn it, so it reads as a standing rate');
  if (!incremental) reasons.push('no reward on top of what the card already pays');

  return {
    signals,
    temporary,
    conditional,
    incremental,
    // An article that announces a promotion needs one real signal plus either
    // a condition or a deadline. Lower than the review bar on purpose: the
    // document itself is evidence, and demanding everything would throw away
    // offers whose article simply does not spell out both halves.
    sufficient: signals.length > 0 && (conditional || temporary),
    // A review or product page has to point at something explicitly temporary
    // AND something that has to be done, because every number on the page is a
    // permanent rate until proven otherwise.
    sufficient_for_review: temporary && conditional && incremental,
    reasons,
  };
}

/**
 * A transfer bonus must be about transferring, not merely about miles.
 *
 * The rule the Chromo article broke: a percentage in the text set
 * `transfer_bonus`, so a card earning 1.3 miles per dollar became a transfer
 * promotion. Miles are the subject of nearly every article here; movement
 * between two programmes is not.
 */
export interface TransferCheck {
  ok: boolean;
  missing: string[];
  programmes: string[];
}

const PROGRAMMES = [
  'krisflyer',
  'asia miles',
  'avios',
  'enrich',
  'skywards',
  'flyingblue',
  'flying blue',
  'united mileageplus',
  'mileageplus',
  'aeroplan',
  'qantas',
  'dbs points',
  'uob points',
  'ocbc$',
  'citi thankyou',
  'thankyou points',
  'hsbc rewards',
  'membership rewards',
  'scb 360',
  'maybank treats',
];

export function validateTransferBonus(text: string): TransferCheck {
  const lower = text.toLowerCase();
  const missing: string[] = [];

  const movement = /\btransfer(?:ring|s|red)?\b|\bconvert(?:ing|s|ed)?\b|\bconversion\b/i.test(text);
  if (!movement) missing.push('no transfer or conversion wording');

  const programmes = PROGRAMMES.filter((p) => lower.includes(p));
  // One programme is enough to proceed — an issuer's own page says "transfer to
  // KrisFlyer" without naming its own currency — but none at all means the
  // article is not about moving points anywhere.
  if (!programmes.length) missing.push('no reward programme named');

  const bonus = /\b\d{1,3}\s?%\s*(?:transfer\s+)?bonus\b|\bbonus\s+(?:miles|points)\b|\bextra\s+(?:miles|points)\b/i.test(text);
  if (!bonus) missing.push('no bonus on the transfer');

  const temporary =
    /\b(?:until|till|by|ends?|expires?|valid\s+(?:till|until|through))\b[^.]{0,40}\d/i.test(text) ||
    /\blimited[- ]time\b/i.test(text);
  if (!temporary) missing.push('nothing making the bonus temporary');

  return { ok: missing.length === 0, missing, programmes: programmes.slice(0, 4) };
}

/** Types that only make sense when something temporary is on offer. */
export const TEMPORARY_TYPES: PromotionType[] = [
  'welcome_offer',
  'spend_bonus',
  'merchant_offer',
  'transfer_bonus',
  'category_bonus',
  'cardholder_offer',
  'bank_campaign',
  'annual_fee_offer',
  'points_conversion_offer',
];
