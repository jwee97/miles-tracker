import { classifyAudience, type PromotionAudience } from '../audience';
import type { PromotionType } from '../model';
import { excerptAround } from './fetch';

/**
 * Turning an article into claims.
 *
 * Two things make this different from reading one page into one promotion.
 *
 * A roundup is one document and fifteen offers, so the extractor segments the
 * text and reads each segment separately — assuming one article equals one
 * promotion throws away the cheapest discovery the system has.
 *
 * And nothing here produces a promotion. It produces CLAIMS: "this URL said
 * 30,000 miles, in this sentence". What the promotion actually says is decided
 * later, by comparing claims from several sources. A number read out of the
 * wrong paragraph is then a visible disagreement rather than a silent fact.
 */

export type ApplicationChannel = 'issuer_direct' | 'moneysmart' | 'singsaver' | 'third_party' | 'unknown';

export interface SpendWindow {
  type: 'absolute' | 'days_from_approval' | 'months_from_approval' | 'end_of_following_month';
  value?: number;
  end_date?: string;
}

export interface PromotionClaim {
  field_name: string;
  value: unknown;
  confidence: 'high' | 'medium' | 'low';
  supporting_excerpt: string;
}

export interface PromotionCandidate {
  promotion_type: PromotionType | null;
  issuer: string | null;
  product_names: string[];
  reward: {
    miles?: number;
    points?: number;
    cashback_cents?: number;
    bonus_pct?: number;
    gift?: string;
  };
  minimum_spend_cents?: number;
  spend_window?: SpendWindow;
  application_start?: string;
  application_end?: string;
  eligibility_text?: string;
  /**
   * Who the offer is for, as structured data.
   *
   * Extraction proposes; nothing here decides eligibility. The raw wording
   * travels with it so a reviewer can disagree with the classification
   * without re-reading the article.
   */
  audience?: PromotionAudience;
  registration_required?: boolean;
  application_channel: ApplicationChannel;
  expected_crediting_date?: string;
  source_claims: PromotionClaim[];
  extraction_confidence: 'high' | 'medium' | 'low';
  /** The slice of the article this came from, for a roundup. */
  segment_title?: string;
}

export interface PromotionDocument {
  title: string;
  url: string;
  source_id: number;
  published_at?: string;
  text: string;
}

const NUM = String.raw`([0-9][0-9,]*(?:\.[0-9]+)?)`;
const n = (s: string) => Number(s.replace(/,/g, ''));

/**
 * A number with an optional thousands suffix, for rewards.
 *
 * Articles write "16,000 miles" and "16K miles" interchangeably, and "16.8k"
 * for the ones that are not round. Reading the second as sixteen miles is not
 * a small error — it is an offer that looks worthless and gets skipped.
 *
 * Deliberately not used for money. "$16k cashback" is not a sentence anyone
 * writes about a credit card, and treating a dollar figure this way would turn
 * a $16 threshold into $16,000.
 */
const COMPACT = String.raw`([0-9][0-9,]*(?:\.[0-9]+)?)(\s*[kK])?`;

export function parseCompactNumber(raw: string): number | null {
  const m = raw.trim().match(/^([0-9][0-9,]*(?:\.[0-9]+)?)\s*([kK])?$/);
  if (!m) return null;
  const base = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(base)) return null;
  return m[2] ? Math.round(base * 1000) : base;
}

/** Apply a captured suffix to a captured number. */
const amount = (value: string, suffix?: string): number => {
  const base = Number(value.replace(/,/g, ''));
  return suffix?.trim().toLowerCase() === 'k' ? Math.round(base * 1000) : base;
};

/**
 * How Singapore writes money.
 *
 * "S$800", "SGD 800", "$800" and "S $800" all appear, often in the same
 * article. Matching only the bare dollar sign meant every threshold written the
 * local way was silently unread, and an offer whose threshold is unknown is
 * refused publication — so these articles produced nothing and said nothing
 * about why.
 */
const MONEY = String.raw`(?:S\s?\$|SGD\s*|\$)\s?`;

const ISSUERS = [
  'DBS', 'POSB', 'UOB', 'Citi', 'Citibank', 'OCBC', 'HSBC', 'Standard Chartered', 'StanChart',
  'Maybank', 'American Express', 'Amex', 'BOC', 'Bank of China', 'CIMB', 'Trust Bank',
];

const ISSUER_CANON: Record<string, string> = {
  citibank: 'Citi',
  stanchart: 'Standard Chartered',
  amex: 'American Express',
  'bank of china': 'BOC',
};

export function findIssuer(text: string): string | null {
  for (const name of ISSUERS) {
    if (new RegExp(`\\b${name.replace(/ /g, '\\s+')}\\b`, 'i').test(text)) {
      return ISSUER_CANON[name.toLowerCase()] ?? name;
    }
  }
  return null;
}

/** Where the offer is applied for, which is not always the bank. */
export function findChannel(text: string, url: string): ApplicationChannel {
  const all = `${url} ${text}`.toLowerCase();
  if (all.includes('moneysmart')) return 'moneysmart';
  if (all.includes('singsaver')) return 'singsaver';
  if (/\bapply (directly )?(with|through|via) the bank|issuer('s)? (own )?(site|website|page)/i.test(text)) {
    return 'issuer_direct';
  }
  return 'unknown';
}

/**
 * Split a roundup into the offers it lists.
 *
 * Headings are the reliable signal: a roundup is a list of cards with a heading
 * each. When there are none, the article is treated as a single offer, which is
 * the safe direction — one candidate that a person checks beats fifteen
 * invented ones.
 */
export function segments(text: string): { title: string; body: string }[] {
  const lines = text.split(/\r?\n/);
  const out: { title: string; body: string }[] = [];
  let current: { title: string; body: string } | null = null;

  const looksLikeHeading = (line: string) => {
    const l = line.trim();
    if (l.length < 6 || l.length > 90) return false;
    if (/[.!?]$/.test(l)) return false;
    // A card heading names an issuer, and headings are not sentences.
    return !!findIssuer(l) && l.split(/\s+/).length <= 12;
  };

  for (const line of lines) {
    if (looksLikeHeading(line)) {
      if (current) out.push(current);
      current = { title: line.trim(), body: '' };
      continue;
    }
    if (current) current.body += `${line}\n`;
  }
  if (current) out.push(current);

  // A handful of headings is a roundup; one or two is an article that happened
  // to name a bank twice.
  return out.filter((s) => s.body.trim().length > 40);
}

const claim = (
  field: string,
  value: unknown,
  confidence: 'high' | 'medium' | 'low',
  text: string,
  around: string
): PromotionClaim => ({
  field_name: field,
  value,
  confidence,
  supporting_excerpt: excerptAround(text, around),
});

/**
 * Read one offer out of a piece of text.
 *
 * Every number carries the sentence it came from. That is what makes a wrong
 * reading arguable later rather than a fact nobody can question.
 */
export function extractOne(text: string, url: string, title = ''): PromotionCandidate {
  const flat = text.replace(/[ \t]+/g, ' ');
  const claims: PromotionClaim[] = [];
  const reward: PromotionCandidate['reward'] = {};

  const miles = flat.match(new RegExp(String.raw`${COMPACT}\s*(?:bonus\s+)?(?:air\s*)?miles`, 'i'));
  if (miles) {
    reward.miles = amount(miles[1], miles[2]);
    claims.push(claim('reward_miles', reward.miles, 'high', flat, miles[0]));
  }

  const points = flat.match(new RegExp(String.raw`${COMPACT}\s*(?:bonus\s+)?points`, 'i'));
  if (points && !miles) {
    reward.points = amount(points[1], points[2]);
    claims.push(claim('reward_points', reward.points, 'high', flat, points[0]));
  }

  // No compact suffix on money: "$16k cashback" is not something anyone writes
  // about a card, and reading it that way would turn $16 into $16,000.
  const cash = flat.match(new RegExp(String.raw`${MONEY}${NUM}\s*(?:cash\s?back|cashback|cash)`, 'i'));
  if (cash) {
    reward.cashback_cents = Math.round(n(cash[1]) * 100);
    claims.push(claim('reward_cashback_cents', reward.cashback_cents, 'high', flat, cash[0]));
  }

  const bonusPct = flat.match(/([0-9]{1,3})\s?%\s*(?:transfer\s*)?bonus/i);
  if (bonusPct) {
    reward.bonus_pct = Number(bonusPct[1]);
    claims.push(claim('bonus_pct', reward.bonus_pct, 'high', flat, bonusPct[0]));
  }

  const gift = flat.match(/\b(Apple|Samsung|Dyson|Nintendo)\s+[A-Za-z0-9 ]{2,30}/);
  if (gift && !miles && !points && !cash) {
    reward.gift = gift[0].trim();
    claims.push(claim('reward_gift', reward.gift, 'medium', flat, gift[0]));
  }

  const spend = flat.match(
    new RegExp(String.raw`(?:min(?:imum)?\.?\s*spend(?:ing)?|spend)\s*(?:of\s*)?${MONEY}${NUM}`, 'i')
  );
  let minimum: number | undefined;
  if (spend) {
    minimum = Math.round(n(spend[1]) * 100);
    claims.push(claim('minimum_spend_cents', minimum, 'high', flat, spend[0]));
  }

  let window: SpendWindow | undefined;
  const days = flat.match(new RegExp(String.raw`within\s+${NUM}\s+days?(?:\s+of\s+(?:card\s+)?approval)?`, 'i'));
  const months = flat.match(new RegExp(String.raw`within\s+${NUM}\s+months?(?:\s+of\s+(?:card\s+)?approval)?`, 'i'));
  const following = /end of the following month|following month/i.test(flat);
  if (days) {
    window = { type: 'days_from_approval', value: n(days[1]) };
    claims.push(claim('spend_window', window, 'high', flat, days[0]));
  } else if (months) {
    window = { type: 'months_from_approval', value: n(months[1]) };
    claims.push(claim('spend_window', window, 'high', flat, months[0]));
  } else if (following) {
    window = { type: 'end_of_following_month' };
    claims.push(claim('spend_window', window, 'medium', flat, 'following month'));
  }

  // An open-ended offer has no end date, and inventing one is worse than
  // leaving it null: a guessed date either expires a live offer or keeps a dead
  // one on the screen for a year. The phrase is recorded as an assumption so
  // the absence is explained rather than merely empty.
  const openEnded = OPEN_ENDED.exec(flat);
  const end = openEnded ? null : findDate(flat, END_PHRASES);
  if (end) {
    claims.push(claim('application_end', end.iso, end.confidence, flat, end.raw));
  } else if (openEnded) {
    claims.push(claim('application_end_note', openEnded[0], 'high', flat, openEnded[0]));
  }
  const start = findDate(flat, /(?:from|starting|between|opens?(?: on)?)\s+/i);

  const registration = /\b(register|registration required|opt[- ]?in|sign up for this promotion)\b/i.test(flat);
  if (registration) claims.push(claim('registration_required', true, 'high', flat, 'register'));

  // Hyphens matter here: "new-to-bank" is how banks themselves write it, and
  // matching only the spaced form left the most common phrasing unread.
  const eligibility = flat.match(
    /\b(new[- ](?:to[- ]bank|cardholders?|cardmembers?|customers?)[^.]{0,120}|existing\s+(?:customers?|cardholders?)\s+only[^.]{0,80})\./i
  );
  if (eligibility) claims.push(claim('eligibility_text', eligibility[1], 'medium', flat, eligibility[1]));

  // The audience is read from the eligibility sentence when there is one, and
  // from the whole text only for the phrasings that are unambiguous. What is
  // not established stays unknown — "no restriction found" is not evidence
  // that an offer is open to everyone.
  const audience = classifyAudience(eligibility?.[1] ?? null);
  const fallbackAudience = audience.type === 'unknown' ? classifyAudience(flat.slice(0, 1200)) : audience;
  if (fallbackAudience.type !== 'unknown') {
    claims.push(claim('audience_type', fallbackAudience.type, fallbackAudience.confidence ?? 'low', flat, fallbackAudience.raw_text ?? ''));
  }

  const type: PromotionType | null = reward.bonus_pct
    ? 'transfer_bonus'
    : /welcome|sign[- ]?up|new cardholder|new cardmember/i.test(flat)
      ? 'welcome_offer'
      : minimum
        ? 'spend_bonus'
        : null;

  const paysSomething = reward.miles || reward.points || reward.cashback_cents || reward.bonus_pct || reward.gift;
  // Confidence is about how much had to be inferred. Never high while something
  // that decides money is unread — and this is a claim, not a promotion, so an
  // honest "low" costs nothing but a human glance later.
  const confidence: 'high' | 'medium' | 'low' =
    paysSomething && minimum && end ? 'high' : paysSomething && (minimum || end) ? 'medium' : 'low';

  return {
    promotion_type: type,
    issuer: findIssuer(`${title} ${flat.slice(0, 600)}`),
    product_names: productNames(`${title}\n${flat}`),
    reward,
    minimum_spend_cents: minimum,
    spend_window: window,
    application_start: start?.iso,
    application_end: end?.iso,
    eligibility_text: eligibility?.[1],
    audience: fallbackAudience,
    registration_required: registration || undefined,
    application_channel: findChannel(flat, url),
    source_claims: claims,
    extraction_confidence: confidence,
    segment_title: title || undefined,
  };
}

/**
 * The ways an article says when applications close.
 *
 * Written out rather than guessed at from any date in the text: an article
 * about a September offer mentions September in six places, and only one of
 * them is the deadline.
 */
export const END_PHRASES =
  /(?:ends?(?:\s+on)?|until|till|by|valid\s+(?:till|until|through)|expires?(?:\s+on)?|last\s+day(?:\s+to\s+apply)?(?:\s+is)?|apply\s+(?:by|before)|applications?\s+(?:close|submitted\s+(?:by|before))|closes?(?:\s+on)?|on\s+or\s+before)\s+/i;

/**
 * An offer with no end date, said in words.
 *
 * "Until further notice" is a real answer and must not become a date. The
 * phrase is kept so a person reading the candidate knows the field is empty
 * deliberately.
 */
export const OPEN_ENDED = /\b(?:until|till)\s+further\s+notice\b|\bno\s+(?:fixed\s+)?end\s+date\b|\bwhile\s+stocks\s+last\b|\bongoing\s+offer\b/i;

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * A date written the way an article writes one.
 *
 * "30 Sep 2026", "30 September 2026", "2026-09-30". A date with no year is
 * skipped rather than guessed: an offer given the wrong year either looks long
 * expired or stays live for twelve months too many.
 */
export function findDate(
  text: string,
  prefix: RegExp
): { iso: string; raw: string; confidence: 'high' | 'medium' } | null {
  // A date with no year is not matched at all. Guessing one either expires a
  // live offer or keeps a dead one on the screen for twelve months, and both
  // are worse than an empty field a person can fill.
  const re = new RegExp(
    `${prefix.source}(?:the\\s+)?(\\d{4}-\\d{2}-\\d{2}` +
      `|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?[A-Za-z]{3,9},?\\s+\\d{4}` +
      `|[A-Za-z]{3,9}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4})`,
    'i'
  );
  const m = text.match(re);
  if (!m) return null;
  const raw = m[1];

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { iso: raw, raw: m[0], confidence: 'high' };

  const dmy = raw.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([A-Za-z]{3,9}),?\s+(\d{4})$/i);
  if (dmy) {
    const month = MONTHS[dmy[2].slice(0, 3).toLowerCase()];
    if (!month) return null;
    return {
      iso: `${dmy[3]}-${String(month).padStart(2, '0')}-${dmy[1].padStart(2, '0')}`,
      raw: m[0],
      confidence: 'high',
    };
  }

  const mdy = raw.match(/^([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i);
  if (mdy) {
    const month = MONTHS[mdy[1].slice(0, 3).toLowerCase()];
    if (!month) return null;
    return {
      iso: `${mdy[3]}-${String(month).padStart(2, '0')}-${mdy[2].padStart(2, '0')}`,
      raw: m[0],
      confidence: 'high',
    };
  }
  return null;
}

/** Card names as an article writes them, for the resolver to match against. */
export function productNames(text: string): string[] {
  const out = new Set<string>();
  const re = new RegExp(
    `\\b(${ISSUERS.join('|').replace(/ /g, '\\s+')})\\s+([A-Z][A-Za-z0-9'’]*(?:\\s+[A-Z][A-Za-z0-9'’]*){0,4})`,
    'g'
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = `${m[1]} ${m[2]}`.replace(/\s+/g, ' ').trim();
    if (name.length < 6 || name.length > 60) continue;
    out.add(name);
    if (out.size >= 10) break;
  }
  return [...out];
}

export interface ExtractionResult {
  candidates: PromotionCandidate[];
  /** True when one document produced several offers. */
  roundup: boolean;
}

/**
 * Read a document into however many offers it contains.
 *
 * A roundup yields one candidate per card it lists; anything else yields one.
 * Segments with no reward in them are dropped — a roundup's introduction is not
 * an offer, and a candidate with nothing to check wastes the review it costs.
 */
export function extractDocument(doc: PromotionDocument, opts: { roundup?: boolean } = {}): ExtractionResult {
  if (opts.roundup) {
    const parts = segments(doc.text);
    if (parts.length >= 2) {
      const candidates = parts
        .map((p) => extractOne(p.body, doc.url, p.title))
        .filter((c) => c.reward.miles || c.reward.points || c.reward.cashback_cents || c.reward.bonus_pct);
      if (candidates.length) return { candidates, roundup: true };
    }
  }
  return { candidates: [extractOne(doc.text, doc.url, doc.title)], roundup: false };
}
