/**
 * Is this article worth reading properly?
 *
 * Extraction is the expensive step, and most of what a feed produces is not
 * about promotions at all. This is the cheap filter in front of it: keywords
 * and shape, no fetching, no cleverness.
 *
 * It is deliberately generous. Discarding a real promotion costs a discovery
 * that may not come again, while letting a travel review through costs one
 * wasted extraction — so when the signals are weak the answer is "look at it".
 */

export type ItemType =
  | 'promotion_related'
  | 'roundup'
  | 'card_rules_change'
  | 'transfer_related'
  | 'general_news'
  | 'irrelevant';

export interface Classification {
  type: ItemType;
  score: number;
  /** The words that decided it, so a surprising verdict is checkable. */
  signals: string[];
  /** True when one article is likely to contain many offers. */
  roundup: boolean;
}

const PROMOTION_SIGNALS = [
  'bonus miles',
  'sign-up',
  'signup',
  'sign up bonus',
  'welcome bonus',
  'welcome offer',
  'welcome gift',
  'cashback',
  'cash back',
  'min spend',
  'minimum spend',
  'promotion',
  'promo',
  'limited time',
  'new cardholder',
  'new cardmember',
  'existing cardholder',
  'register',
  'apply by',
  'expires',
  'ends on',
];

const TRANSFER_SIGNALS = ['transfer bonus', 'conversion bonus', 'points transfer', 'krisflyer', 'asia miles'];

const RULES_SIGNALS = [
  'devaluation',
  'earn rate',
  'excluded mcc',
  'no longer earns',
  'changes to',
  'revamp',
  'earn rates',
];

/** Titles that promise many offers in one article. */
const ROUNDUP_SIGNALS = [
  'roundup',
  'round-up',
  'best credit card',
  'sign-up bonuses',
  'signup bonuses',
  'welcome offers',
  'this month',
  'deals of the week',
  'weekly deals',
  'what are the best',
  'complete guide',
];

/** Things that read as promotions and are not. */
const NEGATIVE_SIGNALS = ['hotel review', 'flight review', 'trip report', 'lounge review', 'seat review'];

const hits = (haystack: string, needles: string[]) => needles.filter((n) => haystack.includes(n));

export function classify(title: string, summary = ''): Classification {
  const text = `${title} ${summary}`.toLowerCase();

  const negatives = hits(text, NEGATIVE_SIGNALS);
  const promo = hits(text, PROMOTION_SIGNALS);
  const transfer = hits(text, TRANSFER_SIGNALS);
  const rules = hits(text, RULES_SIGNALS);
  const roundup = hits(text, ROUNDUP_SIGNALS);

  const signals = [...promo, ...transfer, ...rules, ...roundup];
  const score = promo.length * 2 + transfer.length * 2 + rules.length + roundup.length;

  if (negatives.length && !promo.length && !transfer.length) {
    return { type: 'irrelevant', score: 0, signals: negatives, roundup: false };
  }

  // A roundup is checked first: it is a promotion article AND the shape that
  // yields many candidates, and losing that distinction loses the cheapest
  // discovery the system has.
  const isRoundup = roundup.length > 0 && (promo.length > 0 || /\b20\d\d\b/.test(text));
  if (isRoundup) return { type: 'roundup', score: score + 3, signals, roundup: true };

  if (transfer.length && transfer.length >= promo.length) {
    return { type: 'transfer_related', score, signals, roundup: false };
  }
  if (promo.length >= 2 || (promo.length === 1 && /\$\s?\d|\d[,\d]*\s*(miles|points)/i.test(text))) {
    return { type: 'promotion_related', score, signals, roundup: false };
  }
  if (rules.length) return { type: 'card_rules_change', score, signals, roundup: false };
  if (promo.length) return { type: 'general_news', score, signals, roundup: false };

  return { type: 'irrelevant', score, signals, roundup: false };
}

/** The types worth the cost of fetching and extracting. */
export const WORTH_EXTRACTING: ItemType[] = [
  'promotion_related',
  'roundup',
  'transfer_related',
  'card_rules_change',
];

export const shouldExtract = (c: Classification) => WORTH_EXTRACTING.includes(c.type);
