import { candidates as mccCandidates } from '../../merchants/evidence';
import { similarMerchants } from '../../merchants/lookup';
import { normalizeKey } from '../../merchants/normalize';
import type { Env } from '../../types';

/**
 * Two ways to have an opinion about a merchant nobody has ever confirmed.
 *
 * A trained model can only name codes it has seen enough of, which for a
 * personal ledger is a dozen at most. Everything else reaches the end of the
 * chain and becomes a question. Some of those questions are answerable without
 * any learning at all, and answering them is worth more than the model is.
 *
 * Both of these produce **guesses**, and that word is load-bearing. They run
 * after evidence and after the model, they carry lower confidence than either,
 * they say in the trail that they are guessing, and the reward-impact check
 * still decides whether the guess is worth acting on. A guess that quietly
 * became a fact would undo the whole arrangement.
 */

// --- 1. the same chain, a different outlet -----------------------------------

export interface SiblingGuess {
  mcc: string;
  confidence: number;
  /** The merchant it was borrowed from, so the reasoning is checkable. */
  from: string;
  similarity: number;
  /** True when the only difference was an outlet number. */
  same_chain: boolean;
  observations: number;
}

/**
 * How alike two names must be before one may lend the other its code.
 *
 * High, and higher than the bar for suggesting a merchant match, because the
 * consequences differ. Proposing "did you mean Kopitiam 88?" costs a glance;
 * borrowing its MCC changes which card gets recommended. `similarity` returns
 * 0.8 for a plain prefix relation, so this deliberately sits above that: two
 * outlets of one chain share far more than a prefix.
 */
export const SIBLING_SIMILARITY = 0.86;

/**
 * What distinguishes one outlet of a chain from another.
 *
 * Outlet numbers, unit numbers, branch names — the parts that differ between
 * two rows of the same business. Stripping them gives a **chain key**, and two
 * descriptors sharing one are the same chain by construction rather than by
 * resemblance.
 *
 * This matters because plain similarity is bad at exactly this case:
 * `kopitiam 88 outlet 3` and `kopitiam 88 outlet 7` share three words of four
 * and score 0.6 — indistinguishable from two merchants that merely sound
 * alike. Raising the threshold would not help; the signal is not in how alike
 * the strings are, it is in what the difference between them consists of.
 */
const OUTLET_MARKERS =
  /\s*(?:outlet|branch|store|unit|shop|kiosk|counter|#)\s*[a-z]?\d{1,4}[a-z]?\s*$|\s+\d{1,4}\s*$|\s*#\d{2}-\d{2,4}\s*$/i;

export function chainKey(descriptor: string): string {
  let key = normalizeKey(descriptor);
  // Twice: "kopitiam 88 outlet 3" loses the outlet, then would keep "88",
  // which is part of the chain's name rather than the branch. One pass only,
  // so a trailing chain number survives.
  key = key.replace(OUTLET_MARKERS, '').trim();
  return key;
}

/**
 * Borrow a code from a near-identical merchant.
 *
 * `KOPITIAM 88 OUTLET 3` and `KOPITIAM 88 OUTLET 7` are the same business
 * doing the same thing, and the second inherits nothing from the first because
 * they are different rows. This is the cheapest real answer in the system: it
 * needs no model, no training data and no network, and the evidence it borrows
 * was confirmed by a person or printed by a bank.
 *
 * Deliberately refuses when the sibling's own code is ambiguous. Lending an
 * uncertainty is worse than lending nothing — the borrower cannot see that the
 * code was already contested.
 */
export async function siblingCode(
  env: Env,
  descriptor: string,
  opts: { excludeMerchantId?: number; channel?: string | null } = {}
): Promise<SiblingGuess | null> {
  const near = await similarMerchants(env, descriptor, {
    limit: 5,
    ...(opts.excludeMerchantId ? { exclude: opts.excludeMerchantId } : {}),
  });

  const mine = chainKey(descriptor);

  for (const candidate of near) {
    // Either the strings are very alike, or the only thing separating them is
    // an outlet number — the second is the stronger signal and the commoner
    // case, and similarity alone scores it no better than coincidence.
    const sameChain = !!mine && mine.length >= 4 && chainKey(candidate.merchant.canonical_name) === mine;
    if (!sameChain && candidate.score < SIBLING_SIMILARITY) continue;

    const codes = await mccCandidates(env, candidate.merchant.id, opts.channel ?? null);
    if (!codes.length) continue;

    const [best, second] = codes;
    // Only a settled answer travels. A merchant that itself presents two codes
    // has nothing to lend.
    if (second && second.weight >= best.weight * 0.6 && !best.confirmed) continue;

    return {
      mcc: best.mcc,
      // Capped well below what evidence earns: this is a resemblance, and a
      // resemblance between names is not a fact about acquirers.
      confidence: Math.min(0.72, Math.max(candidate.score, sameChain ? 0.85 : 0) * (best.confirmed ? 0.85 : 0.7)),
      from: candidate.merchant.canonical_name,
      similarity: Math.round(Math.max(candidate.score, sameChain ? 0.9 : 0) * 100) / 100,
      same_chain: sameChain,
      observations: best.observations,
    };
  }

  return null;
}

// --- 2. what the words mean --------------------------------------------------

export interface LexiconGuess {
  category: string;
  confidence: number;
  /** The word that triggered it, so a wrong guess is traceable to its cause. */
  matched: string;
}

/**
 * Words that say what a Singapore merchant sells.
 *
 * Knowledge, not learning — which is exactly why it is allowed. There is no
 * training data behind "kopitiam is a coffee shop"; it is simply true, and a
 * model would need dozens of examples to discover it. A short, boring list of
 * things that are true about this market is the cheapest intelligence
 * available, and it needs no corpus at all.
 *
 * Mapped to CATEGORIES, never to MCCs. A category is a claim about what kind
 * of place this is, which a word can support; an MCC is a claim about what the
 * acquirer registered it as, which a word cannot. Guessing a four-digit code
 * from the word "cafe" would be inventing a fact about a bank.
 *
 * Kept deliberately short. Every entry is a place this system can be
 * confidently wrong, so the bar for adding one is that it is unambiguous in
 * Singaporean usage.
 */
export const LEXICON: { words: string[]; category: string }[] = [
  { words: ['kopitiam', 'hawker', 'food court', 'foodcourt', 'coffee shop', 'kopi'], category: 'dining' },
  { words: ['restaurant', 'bistro', 'eatery', 'cafe', 'bakery', 'pizzeria', 'noodle', 'ramen', 'sushi'], category: 'dining' },
  { words: ['ntuc', 'fairprice', 'cold storage', 'sheng siong', 'giant', 'prime supermarket', 'supermarket', 'grocer'], category: 'groceries' },
  { words: ['mrt', 'smrt', 'sbs transit', 'transitlink', 'comfortdelgro', 'taxi', 'gojek', 'tada', 'bus'], category: 'transport' },
  { words: ['esso', 'caltex', 'spc', 'petrol', 'shell station'], category: 'transport' },
  { words: ['guardian', 'watsons', 'unity pharmacy', 'pharmacy', 'clinic', 'dental', 'polyclinic'], category: 'health' },
  { words: ['singtel', 'starhub', 'm1 ', 'circles life', 'sp services', 'town council'], category: 'utilities' },
  { words: ['shopee', 'lazada', 'amazon', 'qoo10', 'taobao', 'zalora', 'aliexpress'], category: 'online' },
  { words: ['cathay', 'golden village', 'shaw theatre', 'netflix', 'spotify', 'disney'], category: 'entertainment' },
  { words: ['airlines', 'airways', 'scoot', 'jetstar', 'agoda', 'booking.com', 'airbnb', 'klook', 'hotel'], category: 'travel' },
  { words: ['uniqlo', 'muji', 'decathlon', 'ikea', 'courts', 'challenger', 'harvey norman'], category: 'shopping' },
];

/**
 * What the words in a descriptor suggest, when nothing else has an opinion.
 *
 * The last thing tried before asking a person, and the confidence says so. A
 * single unambiguous word is worth something; two words agreeing on different
 * categories is worth nothing, and returns nothing rather than picking.
 */
export function lexiconCategory(descriptor: string): LexiconGuess | null {
  const text = ` ${descriptor.toLowerCase().replace(/[^a-z0-9. ]+/g, ' ').replace(/\s+/g, ' ').trim()} `;

  // Every matching word, not the first per category: "NTUC FAIRPRICE
  // SUPERMARKET" says the same thing three times, and three independent words
  // agreeing is meaningfully better evidence than one.
  const hits: LexiconGuess[] = [];
  for (const entry of LEXICON) {
    for (const w of entry.words) {
      if (text.includes(` ${w}`) || text.includes(`${w} `)) {
        hits.push({ category: entry.category, confidence: 0.55, matched: w });
      }
    }
  }

  if (!hits.length) return null;

  // Disagreement is an answer: a line reading "SHELL SELECT CAFE" is a petrol
  // station and a cafe at once, and choosing between them from a word list is
  // exactly the confident guess this design is arranged against.
  const categories = new Set(hits.map((h) => h.category));
  if (categories.size > 1) return null;

  // Two independent words agreeing is meaningfully better than one.
  const confidence = hits.length > 1 ? 0.65 : 0.55;
  return { ...hits[0], confidence };
}
