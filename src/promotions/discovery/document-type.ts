/**
 * What kind of document is this, before asking what offer is in it.
 *
 * The bug this exists to stop: a card review is full of the words a promotion
 * is made of. "DBS Chromo Card Review: Up to 5% Cashback or 1.3 Miles per
 * Dollar" mentions miles, cashback and a percentage, and the extractor duly
 * produced a transfer bonus paying 1.3 miles — reading a card's permanent earn
 * rate as a temporary offer.
 *
 * The mistake was never in the regexes. It was asking "what offer is in this?"
 * of a document that does not contain one. So the question is asked in the
 * other order now: decide what the document IS, and let that decide how much
 * evidence an offer has to produce before anyone is shown it.
 *
 * A card review is not discarded. Reviews routinely carry a genuine welcome
 * offer alongside the permanent rates, and losing those would trade one kind
 * of error for another. What changes is the burden of proof.
 */

export type DocumentType =
  | 'promotion'
  | 'promotion_roundup'
  | 'card_review'
  | 'card_product_page'
  | 'card_rule_change'
  | 'transfer_article'
  | 'general_article'
  | 'irrelevant';

export interface DocumentClassification {
  document_type: DocumentType;
  confidence: 'high' | 'medium' | 'low';
  /** The phrases that decided it, so a surprising verdict is checkable. */
  signals: string[];
}

/** A title that announces a review of a product rather than an offer on one. */
const REVIEW_TITLE =
  /\b(review|reviewed|hands[- ]on|worth it\?|should you (?:get|apply)|is the [a-z0-9' ]+ card worth|deep dive|explained|guide to the)\b/i;

/** Phrases that describe what a card always does. */
const FEATURE_SIGNALS = [
  'miles per dollar',
  'mile per dollar',
  'per s$1',
  'per $1',
  'mpd',
  'earn rate',
  'base rate',
  'annual fee',
  'income requirement',
  'monthly cap',
  'cashback cap',
  'minimum monthly spend',
  'fee waiver',
];

/** Phrases that only make sense about something temporary. */
const OFFER_SIGNALS = [
  'welcome offer',
  'welcome bonus',
  'welcome gift',
  'sign-up bonus',
  'signup bonus',
  'sign up bonus',
  'limited time',
  'limited-time',
  'promo code',
  'promotion code',
  'apply by',
  'applications close',
  'register by',
  'valid till',
  'valid until',
  'ends on',
  'while stocks last',
  'for a limited period',
  // A reward paid on top of the rate, and the thresholds that earn one. These
  // are what an ordinary promotion article is made of, and leaving them out
  // sent perfectly good offers down the general-article path.
  'bonus miles',
  'bonus points',
  'minimum spend',
  'min spend',
  'when you spend',
  'new cardholder',
  'new cardmember',
];

/**
 * Moving points between programmes.
 *
 * Patterns rather than fixed phrases, because the currency sits in the middle
 * of the sentence: "transfer DBS Points to KrisFlyer" contains neither
 * "transfer points" nor "points transfer", and a substring list quietly missed
 * the commonest way anyone writes this.
 */
const TRANSFER_PATTERNS: RegExp[] = [
  /\btransfer(?:ring|s)?\s+(?:your\s+)?(?:[a-z$]+\s+){0,2}(?:points|miles)\b/i,
  /\bconvert(?:ing|s)?\s+(?:your\s+)?(?:[a-z$]+\s+){0,2}(?:points|miles)\b/i,
  /\b(?:points|miles)\s+transfer\b/i,
  /\b(?:transfer|conversion)\s+bonus\b/i,
  /\btransfer\s+(?:to|into)\s+[a-z ]{3,20}\b/i,
];

const RULE_CHANGE_SIGNALS = [
  'devaluation',
  'no longer earns',
  'changes to',
  'will be excluded',
  'revised earn',
  'earn rates will',
  'with effect from',
  'reduces earn',
];

const ROUNDUP_SIGNALS = [
  'best credit cards',
  'best credit card',
  'roundup',
  'round-up',
  'welcome offers',
  'sign-up bonuses',
  'signup bonuses',
  'deals of the week',
  'this month',
  'top picks',
];

/** An issuer's own page about a product, rather than an article about it. */
const PRODUCT_PAGE_SIGNALS = [
  'apply now',
  'key features',
  'product highlights',
  'terms and conditions apply',
  'eligibility criteria',
];

const IRRELEVANT_SIGNALS = ['hotel review', 'flight review', 'trip report', 'lounge review', 'seat review'];

const found = (text: string, needles: string[]) => needles.filter((n) => text.includes(n));

/**
 * Classify a document.
 *
 * Deliberately ordered rather than scored. A document that changes a card's
 * rules and a document reviewing that card share almost all their vocabulary,
 * and a score would let a long review outvote an explicit announcement. The
 * order encodes what each kind of evidence is worth: an explicit offer beats a
 * title, a title beats a pile of feature words, and feature words beat nothing.
 */
export function classifyDocument(title: string, body = ''): DocumentClassification {
  const heading = title.toLowerCase();
  const text = `${title}\n${body}`.toLowerCase();

  const irrelevant = found(text, IRRELEVANT_SIGNALS);
  const offers = found(text, OFFER_SIGNALS);
  const transfers = TRANSFER_PATTERNS.map((re) => text.match(re)?.[0]).filter((m): m is string => !!m);
  const features = found(text, FEATURE_SIGNALS);
  const ruleChanges = found(text, RULE_CHANGE_SIGNALS);
  const roundups = found(heading, ROUNDUP_SIGNALS);
  const productPage = found(text, PRODUCT_PAGE_SIGNALS);
  const reviewTitle = REVIEW_TITLE.test(title);

  const say = (
    document_type: DocumentType,
    confidence: DocumentClassification['confidence'],
    signals: string[]
  ): DocumentClassification => ({ document_type, confidence, signals: [...new Set(signals)].slice(0, 12) });

  if (irrelevant.length && !offers.length && !transfers.length) return say('irrelevant', 'high', irrelevant);

  // A roundup first: it is a promotion article AND the shape that yields many
  // candidates, and collapsing it into 'promotion' loses the cheapest
  // discovery there is.
  if (roundups.length && (offers.length || /\b20\d\d\b/.test(heading))) {
    return say('promotion_roundup', offers.length ? 'high' : 'medium', [...roundups, ...offers]);
  }

  // A review that also carries an offer stays a review. The offer is not lost —
  // the extractor still reads it — but the document is what it is, and calling
  // it a promotion is how permanent rates end up on a promotion screen.
  if (reviewTitle) {
    return say('card_review', features.length || offers.length ? 'high' : 'medium', [
      title.match(REVIEW_TITLE)?.[0] ?? 'review',
      ...features,
      ...offers,
    ]);
  }

  if (ruleChanges.length && !offers.length) return say('card_rule_change', 'medium', ruleChanges);

  if (transfers.length && (offers.length || /\bbonus\b/.test(text))) {
    return say('transfer_article', 'high', [...transfers, ...offers]);
  }

  if (offers.length >= 2) return say('promotion', 'high', offers);
  if (offers.length === 1) return say('promotion', 'medium', offers);

  if (productPage.length >= 2 && features.length) return say('card_product_page', 'medium', [...productPage, ...features]);

  // Features and nothing temporary: this describes a card, not an offer on one.
  if (features.length >= 2) return say('card_product_page', 'low', features);
  if (transfers.length) return say('transfer_article', 'low', transfers);

  return say('general_article', 'low', [...features, ...ruleChanges]);
}

/**
 * How much proof an offer needs, given what the document is.
 *
 * A page that announces a promotion may be taken more or less at its word. A
 * card review has to point at something explicitly temporary before any of its
 * numbers are treated as an offer, because every number in it is a permanent
 * rate until shown otherwise.
 */
/**
 * Documents where every number is a permanent rate until proven otherwise.
 *
 * Only the kinds that are ABOUT a card's standing terms. A general article is
 * not on this list, and deliberately: it is not full of earn rates the way a
 * review is, and holding it to the review bar threw away real offers whose
 * article simply never used the word "promotion".
 */
export const NEEDS_EXPLICIT_OFFER: DocumentType[] = ['card_review', 'card_product_page', 'card_rule_change'];

/** Types not worth the cost of reading in full. */
export const SKIP_EXTRACTION: DocumentType[] = ['irrelevant'];
