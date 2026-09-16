import type { Evaluation, MerchantGuess, Purchase } from '../rules';

/**
 * How much of this recommendation rests on something that could be wrong.
 *
 * The rule the whole module exists to enforce: do not convert uncertainty into
 * false certainty. A guessed merchant code that happens to be right still
 * produced a guessed recommendation, and if the answer would have been
 * different under the other plausible code, that has to be said out loud.
 */
export type RecommendationConfidence = 'high' | 'medium' | 'low';

export interface RecommendationAssumption {
  /** What was assumed, in the words a person would use. */
  what: string;
  /** Why it was assumed. */
  because: string;
  /** 'material' when the answer could change if it is wrong. */
  weight: 'material' | 'minor';
}

export interface ConfidenceReport {
  level: RecommendationConfidence;
  reasons: string[];
  assumptions: RecommendationAssumption[];
  /** How many material unknowns there are, for the score to charge for. */
  material_unknowns: number;
}

/**
 * What the cards in play are sensitive to.
 *
 * This has to be judged on every rule a card COULD have matched, not on the one
 * it did. An MCC-restricted rule cannot match when the code is unknown — it is
 * rejected and the card falls to its base rate — so looking at the matched rule
 * finds no code-gated rule precisely when the unknown code mattered most.
 */
export interface RuleSensitivity {
  /** Some card pays a different rate depending on the merchant code. */
  mcc: boolean;
  /** Some card pays a different rate online than in store. */
  channel: boolean;
}

export function assessConfidence(
  purchase: Purchase,
  merchant: MerchantGuess | null,
  picks: Evaluation[],
  opts: { stale_products?: string[]; sensitivity?: RuleSensitivity } = {}
): ConfidenceReport {
  const sensitive = opts.sensitivity ?? { mcc: false, channel: false };
  const reasons: string[] = [];
  const assumptions: RecommendationAssumption[] = [];
  let material = 0;

  const note = (what: string, because: string, weight: 'material' | 'minor') => {
    assumptions.push({ what, because, weight });
    if (weight === 'material') material++;
  };

  // --- the merchant code ---------------------------------------------------
  const codeMatters = sensitive.mcc;
  if (!purchase.mcc) {
    if (codeMatters) {
      reasons.push('the merchant code is unknown, and a card here only pays its bonus on particular codes');
      note('No merchant code', 'nothing on record for this merchant', 'material');
    } else {
      note('No merchant code', 'no card in play changes its rate by code', 'minor');
    }
  } else if (merchant?.confidence === 'guess') {
    reasons.push(`${purchase.mcc} is a guess from a similar merchant name, not a code you have confirmed`);
    note(`Merchant code ${purchase.mcc}`, 'matched on part of the name', codeMatters ? 'material' : 'minor');
  } else if (merchant && merchant.alternatives && merchant.alternatives.length > 0) {
    // A merchant that has posted under several codes is the case most likely to
    // be wrong in a way that matters, and the one most easily missed.
    reasons.push(
      `this merchant has appeared under more than one code (${[purchase.mcc, ...merchant.alternatives.map((a) => a.mcc)]
        .slice(0, 3)
        .join(', ')}), and codes can differ by acquiring route`
    );
    note(`Merchant code ${purchase.mcc}`, 'it has posted under others before', codeMatters ? 'material' : 'minor');
  }

  // --- the channel ---------------------------------------------------------
  if (!purchase.channel && sensitive.channel) {
    reasons.push('online or in store is unknown, and a card here only pays its bonus one way');
    note('Channel unknown', 'not given, and not implied by the merchant', 'material');
  }

  // --- the amount ----------------------------------------------------------
  if (purchase.amount_cents === null || purchase.amount_cents === undefined) {
      const caps = picks.some((p) => p.cap_cents !== null);
    reasons.push(
      caps
        ? 'no amount given, so how much of it would fall inside a bonus cap is unknown'
        : 'no amount given, so rewards are shown as rates rather than totals'
    );
    note('No amount', 'not given', caps ? 'material' : 'minor');
  }

  // --- the rules themselves ------------------------------------------------
  for (const p of opts.stale_products ?? []) {
    reasons.push(`${p}'s reward rules have not been checked against the bank recently`);
    note(`${p} rules unverified`, 'no confirmed source on record', 'minor');
  }

  const level: RecommendationConfidence = material >= 1 ? 'low' : assumptions.length > 0 ? 'medium' : 'high';
  return { level, reasons, assumptions, material_unknowns: material };
}
