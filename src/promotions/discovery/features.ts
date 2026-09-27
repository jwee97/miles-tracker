/**
 * Telling a card's permanent rates apart from a temporary offer.
 *
 * This is the whole of the DBS Chromo bug. "1.3 miles per dollar" is a rate a
 * card pays for ever; "receive 1,300 bonus miles" is an offer that ends. The
 * reward regexes could not tell them apart, so a review's earn rate became a
 * promotion paying 1.3 miles, and a monthly cashback cap of $150 became a $150
 * reward.
 *
 * Rather than making every reward pattern defensive — which multiplies with
 * each new pattern and fails on the one nobody thought of — the permanent
 * parts are blanked out of the text first. What survives is what an offer
 * could be made of, and the existing patterns read it unchanged.
 *
 * Masking replaces with spaces rather than deleting, so every offset into the
 * text still lines up and a quote taken afterwards still points where it did.
 */

/**
 * Rates: a reward per unit of spend. Always permanent, whatever the number.
 *
 * The denominator is what makes it a rate — "per dollar", "per S$1", "/$1", or
 * the abbreviation "mpd". A figure without one is a total, and a total is what
 * an offer pays.
 */
const RATE_PATTERNS: RegExp[] = [
  /\b\d+(?:\.\d+)?\s*(?:miles?|mpd|points?|%)?\s*(?:miles?|points?)?\s*(?:per|\/|for every)\s*(?:s?\$?\s?1\b|dollar|\$1)/gi,
  /\b\d+(?:\.\d+)?\s*mpd\b/gi,
  /\b\d+(?:\.\d+)?\s*(?:miles?|points?)\s*(?:per|\/)\s*(?:s\$|\$)?\s?\d+(?:\.\d+)?\b/gi,
  // "up to 5% cashback", "earns 1.6% cash back" — a percentage of spend is a
  // rate. A percentage BONUS is not, and is left alone deliberately.
  /\b(?:up\s+to\s+)?\d+(?:\.\d+)?\s?%\s*(?:cash\s?back|cashback|rebate|back)\b/gi,
  /\b(?:base|normal|standard|regular|local|overseas|general)\s+(?:earn\s+)?rate[^.]{0,40}/gi,
  /\bearn(?:s|ing)?\s+rate\s+of[^.]{0,40}/gi,
];

/**
 * Caps: a ceiling on what a rate pays, which is not a reward.
 *
 * "$150 monthly cashback cap" reads to a money-and-the-word-cashback pattern
 * as a $150 cashback reward, which is how a review's limit became an offer's
 * payout.
 */
const CAP_PATTERNS: RegExp[] = [
  /\b(?:capped|cap|ceiling|limited)\s*(?:at|of|to)?\s*(?:s\$|\$)\s?[\d,]+(?:\.\d+)?[^.]{0,30}/gi,
  /\b(?:s\$|\$)\s?[\d,]+(?:\.\d+)?\s*(?:monthly|per\s+month|per\s+statement|quarterly|annual|yearly)?\s*(?:cash\s?back|cashback|rebate|miles?|points?)?\s*(?:cap|ceiling|limit)\b/gi,
  /\b(?:monthly|quarterly|annual|yearly)\s+(?:cash\s?back|cashback|rebate|reward|miles?|points?)\s+(?:cap|limit|ceiling)[^.]{0,40}/gi,
  /\bmaximum\s+of\s+(?:s\$|\$)\s?[\d,]+(?:\.\d+)?[^.]{0,30}/gi,
  /\bup\s+to\s+(?:s\$|\$)\s?[\d,]+(?:\.\d+)?\s*(?:cash\s?back|cashback|rebate)\s*(?:per|a)\s*(?:month|year|quarter|statement)/gi,
];

/** Fees and thresholds, which are costs and conditions of holding a card. */
const TERMS_PATTERNS: RegExp[] = [
  /\bannual\s+fee[^.]{0,60}/gi,
  /\bincome\s+requirement[^.]{0,60}/gi,
  /\bminimum\s+(?:annual\s+)?income[^.]{0,60}/gi,
];

const blank = (s: string) => ' '.repeat(s.length);

export interface MaskResult {
  /** The text with permanent card features blanked out. */
  text: string;
  /** What was removed, so the decision can be explained rather than trusted. */
  removed: string[];
}

/**
 * Blank out everything that describes what a card always does.
 *
 * Used before reading rewards, never before reading dates or eligibility: a
 * review's permanent rate and its welcome offer share a page, and the point is
 * to keep the second while ignoring the first.
 */
export function maskCardFeatures(text: string): MaskResult {
  const removed: string[] = [];
  let out = text;

  for (const pattern of [...RATE_PATTERNS, ...CAP_PATTERNS, ...TERMS_PATTERNS]) {
    out = out.replace(pattern, (m) => {
      removed.push(m.trim());
      return blank(m);
    });
  }

  return { text: out, removed: [...new Set(removed)].slice(0, 20) };
}

/** True when the phrase describes a permanent feature rather than an offer. */
export function isCardFeature(phrase: string): boolean {
  return maskCardFeatures(phrase).removed.length > 0;
}

/**
 * A reward figure too small to be a one-off payout.
 *
 * A belt to the masking's braces. Welcome offers are quoted in thousands of
 * miles; "1.3 miles" is a rate that escaped, not a bonus anybody would print.
 * Cheap, and it catches phrasings the patterns above have not met yet.
 */
export const IMPLAUSIBLE_MILES = 100;
export const IMPLAUSIBLE_POINTS = 100;

export function implausibleReward(kind: 'miles' | 'points', value: number): boolean {
  if (!Number.isFinite(value) || value <= 0) return true;
  return value < (kind === 'miles' ? IMPLAUSIBLE_MILES : IMPLAUSIBLE_POINTS);
}
