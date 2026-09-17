import type { Env } from '../types';
import { economicTermsMissing, savePromotion, type PromotionTerms, type PromotionType } from './model';

/**
 * Turning a page into a promotion candidate.
 *
 * Everything this produces is a draft. Automated extraction may propose terms;
 * it may never publish them, because an offer with a wrong threshold is worse
 * than no offer at all — somebody will spend against it.
 *
 * The sentence each number came from is kept, so a wrong reading can be seen
 * to be wrong rather than argued about.
 */

export interface ExtractedPromotion {
  promotion_type: PromotionType;
  title: string;
  issuer: string | null;
  terms: PromotionTerms;
  source_quote: string | null;
  confidence: 'high' | 'medium' | 'low';
  end_at: string | null;
  registration_required: boolean;
  /** Terms that must be known before this could ever be published. */
  missing: string[];
}

const MONEY = String.raw`\$\s?([0-9][0-9,]*(?:\.[0-9]{2})?)`;
const NUM = String.raw`([0-9][0-9,]*)`;
const cents = (s: string) => Math.round(Number(s.replace(/,/g, '')) * 100);
const int = (s: string) => Number(s.replace(/,/g, ''));

const TYPE_HINTS: [RegExp, PromotionType][] = [
  [/\bwelcome (offer|bonus|gift)\b|\bsign[- ]?up bonus\b|\bnew cardmember\b/i, 'welcome_offer'],
  [/\btransfer bonus\b|\bbonus (miles|points) on transfer\b/i, 'transfer_bonus'],
  [/\bannual fee (waiv|reversal|rebate)/i, 'annual_fee_offer'],
  [/\bspend \$?[0-9]/i, 'spend_bonus'],
  [/\b(dining|shopping|grocer|travel) (promotion|campaign|offer)\b/i, 'category_bonus'],
];

/** Registration wording is common and consequential enough to detect directly. */
const REGISTRATION = /\b(register|registration|sign up for this|opt[- ]?in)\b/i;

/**
 * Read what can be read, and say what could not be.
 *
 * Conservative on purpose: a number matched out of the wrong sentence becomes a
 * threshold someone plans around, and the app cannot tell the difference
 * afterwards. Anything uncertain is left out and listed as missing instead.
 */
export function extractPromotion(text: string, opts: { issuer?: string | null; title?: string } = {}): ExtractedPromotion {
  const flat = text.replace(/\s+/g, ' ').trim();

  let type: PromotionType = 'bank_campaign';
  for (const [re, t] of TYPE_HINTS) {
    if (re.test(flat)) {
      type = t;
      break;
    }
  }

  const terms: PromotionTerms = {};
  const quotes: string[] = [];

  const spend = flat.match(new RegExp(String.raw`spend(?:\s+(?:at least|a minimum of))?\s+${MONEY}`, 'i'));
  if (spend) {
    terms.minimum_spend_cents = cents(spend[1]);
    quotes.push(spend[0]);
  }

  const within = flat.match(new RegExp(String.raw`within\s+${NUM}\s+days`, 'i'));
  if (within) {
    terms.window_days = int(within[1]);
    quotes.push(within[0]);
  }

  const miles = flat.match(new RegExp(String.raw`${NUM}\s+(?:bonus\s+)?(?:miles|air ?miles)`, 'i'));
  if (miles) {
    terms.reward_miles = int(miles[1]);
    quotes.push(miles[0]);
  }

  const points = flat.match(new RegExp(String.raw`${NUM}\s+(?:bonus\s+)?points`, 'i'));
  if (points && !miles) {
    terms.reward_points = int(points[1]);
    quotes.push(points[0]);
  }

  const cashback = flat.match(new RegExp(String.raw`${MONEY}\s+cash\s?back`, 'i'));
  if (cashback) {
    terms.reward_cashback_cents = cents(cashback[1]);
    quotes.push(cashback[0]);
  }

  const pct = flat.match(/([0-9]{1,3}(?:\.[0-9])?)\s?% (?:bonus|more|extra|cash\s?back)/i);
  if (pct) {
    if (type === 'transfer_bonus') terms.bonus_pct = Number(pct[1]);
    else terms.reward_pct = Number(pct[1]);
    quotes.push(pct[0]);
  }

  const until = flat.match(/\b(?:until|by|ends?(?: on)?|before)\s+(\d{1,2}\s+\w+\s+\d{4}|\d{4}-\d{2}-\d{2})/i);
  let endAt: string | null = null;
  if (until) {
    const raw = until[1];
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
    if (iso) endAt = iso;
    else {
      const parsed = Date.parse(raw);
      if (!Number.isNaN(parsed)) endAt = new Date(parsed).toISOString().slice(0, 10);
    }
    if (endAt) quotes.push(until[0]);
  }

  const missing = economicTermsMissing(type, terms);
  // Confidence is about how much had to be inferred, and it is never high while
  // something that decides money is unknown.
  // Low when something that decides money is unknown, and low when nothing at
  // all was read: a page the extractor understood none of is not a medium-
  // confidence promotion, it is a guess with a title.
  const confidence: 'high' | 'medium' | 'low' =
    missing.length || quotes.length === 0 ? 'low' : quotes.length >= 3 ? 'high' : 'medium';

  return {
    promotion_type: type,
    title: (opts.title ?? flat.slice(0, 90)).trim(),
    issuer: opts.issuer ?? null,
    terms,
    source_quote: quotes.length ? quotes.join(' · ') : null,
    confidence,
    end_at: endAt,
    registration_required: REGISTRATION.test(flat),
    missing,
  };
}

/**
 * Save what was read, as a draft.
 *
 * Never published here, whatever the confidence. The pipeline is: extracted →
 * reviewed → published, and the middle step is a person.
 */
export async function saveDraft(
  env: Env,
  e: ExtractedPromotion,
  source: { url?: string | null; type?: string | null }
): Promise<{ ok: boolean; id?: number; error?: string; missing: string[] }> {
  const r = await savePromotion(env, {
    promotion_type: e.promotion_type,
    issuer: e.issuer,
    title: e.title,
    end_at: e.end_at,
    registration_required: e.registration_required,
    source_url: source.url ?? null,
    source_type: source.type ?? 'page',
    source_quote: e.source_quote,
    confidence: e.confidence,
    terms: e.terms,
    status: 'draft',
  });
  return { ...r, missing: e.missing };
}
