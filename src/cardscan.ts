import { cardRulesPrompt } from './extraction';
import { htmlToText, pageMeta } from './rss';
import type { Env } from './types';

/**
 * Reading a card's rewards page.
 *
 * A bank states its terms in prose, and prose is not a rule. What can be found
 * mechanically is the *numbers* — a rate, a cap, a list of merchant codes, a
 * sentence that says something is excluded — and the sentence each came from.
 * That is what this returns: candidates with their evidence, for you to confirm
 * or throw away. It never writes a rule, because a rate read out of the wrong
 * paragraph is worse than no rate at all: it would quietly misdirect every
 * recommendation the app makes.
 *
 * The second half of the answer is the prompt: the page text, already wrapped
 * in the instructions that turn it into rules, for the Claude subscription you
 * already pay for.
 */

const UA = 'miles-tracker/0.4 (personal use)';

export interface Candidate {
  /** 'rate' | 'cap' | 'mcc' | 'exclusion' | 'minspend' */
  kind: string;
  /** How many times the page said the same thing. Marketing pages repeat. */
  occurrences?: number;
  /** The sentence it was found in — the evidence for the number. */
  quote: string;
  rate?: number;
  reward_type?: 'miles' | 'cashback';
  cap_cents?: number;
  cap_window?: string;
  min_spend_cents?: number;
  mccs?: string[];
  category?: string | null;
}

export interface CardPageScan {
  url: string;
  title: string;
  /** Characters of readable text found, so an empty page is obvious. */
  text_length: number;
  candidates: Candidate[];
  /** Every merchant code on the page, with what this app calls it. */
  codes: { mcc: string; description: string | null; category: string | null; excluded_here: boolean }[];
  prompt: string;
  error: string | null;
}

/** Words a bank uses for the categories this app tracks. */
const CATEGORY_WORDS: [RegExp, string][] = [
  [/\b(dining|restaurant|food ?and ?beverage|f&b|eating)\b/i, 'dining'],
  [/\b(grocer|supermarket|market)\b/i, 'groceries'],
  [/\b(online|e-?commerce|internet|digital|web)\b/i, 'online'],
  [/\b(transport|taxi|ride[- ]hail|bus|mrt|public transit|commut)\b/i, 'transport'],
  [/\b(travel|airline|hotel|flight|accommodation)\b/i, 'travel'],
  [/\b(petrol|fuel|service station|gas station)\b/i, 'fuel'],
  [/\b(entertainment|cinema|movie|attraction)\b/i, 'entertainment'],
  [/\b(utilit|telco|telecom|bill payment)\b/i, 'utilities'],
  [/\b(contactless|tap|paywave|paypass)\b/i, 'contactless'],
  [/\b(overseas|foreign currency|fcy|abroad)\b/i, 'foreign'],
  [/\b(shopping|retail|department store|fashion|apparel)\b/i, 'shopping'],
  [/\b(health|pharmac|medical|beauty)\b/i, 'health'],
];

function categoryOf(sentence: string): string | null {
  for (const [re, cat] of CATEGORY_WORDS) if (re.test(sentence)) return cat;
  return null;
}

const cents = (raw: string) => Math.round(parseFloat(raw.replace(/[^\d.]/g, '')) * 100);

/**
 * Split into sentences.
 *
 * Deliberately not on `:` or `;`, which is how a bank introduces the thing
 * worth reading — "Excluded MCCs: 4900, 9311" is one claim, and splitting it
 * leaves a list of digits with nothing saying what they are.
 */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 12);
}

/** Legalese runs long; the evidence still has to be readable. */
const QUOTE_MAX = 400;
const asQuote = (s: string) => (s.length > QUOTE_MAX ? `${s.slice(0, QUOTE_MAX).trimEnd()}…` : s);

const RATE = /(\d+(?:\.\d+)?)\s*(?:x\s*)?(mpd\b|miles? per (?:dollar|s?\$ ?1)|air ?miles? per|%\s*(?:cash ?back|rebate|back)\b)/i;
const CAP = /(?:cap(?:ped)?(?:\s*(?:at|of|to))?|up to|first|maximum of)\s*s?\$\s*([\d,]+(?:\.\d{2})?)/i;
const WINDOW = /\bper\s+(calendar\s+month|statement\s+(?:month|cycle|period)|month|quarter|year)\b/i;
const MIN_SPEND = /(?:minimum spend(?:ing)?|min(?:imum)?\.? spend|spend at least)\s*(?:of\s*)?s?\$\s*([\d,]+)/i;
const MCC_LIST = /\bmcc?s?\b[^.]{0,40}?((?:\d{4}\b[\s,/and]*){1,30})/i;
const EXCLUDE = /\b(exclud|not eligible|do(?:es)? not (?:earn|qualify|apply)|no (?:miles|points|cash ?back|rewards?) (?:will be |are )?(?:award|earn|given)|ineligible)/i;

function windowFrom(sentence: string): string | undefined {
  const m = sentence.match(WINDOW);
  if (!m) return undefined;
  const w = m[1].toLowerCase();
  if (w.includes('statement')) return 'statement_cycle';
  if (w.includes('quarter')) return 'calendar_quarter';
  if (w.includes('month')) return 'calendar_month';
  return undefined;
}

/**
 * Which category one rate in a sentence is talking about.
 *
 * English puts the category after the rate — "4 mpd on dining and 0.4 mpd on
 * everything else" — so the words ahead of a rate are read first, and only as
 * far as the next rate. Words behind are the fallback, for pages that write
 * "online spend earns 4 mpd", but only for the first rate in a sentence:
 * anything behind a later rate is the previous rate's own text, and letting a
 * base rate read it is how "0.4 mpd on everything else" becomes a dining rule.
 */
function categoryForRate(sentence: string, rates: RegExpMatchArray[], i: number): string | null {
  const REACH = 80;
  const at = rates[i].index ?? 0;
  const end = at + rates[i][0].length;
  const prevEnd = i > 0 ? (rates[i - 1].index ?? 0) + rates[i - 1][0].length : 0;
  const nextAt = i + 1 < rates.length ? (rates[i + 1].index ?? sentence.length) : sentence.length;
  const ahead = sentence.slice(end, Math.min(nextAt, end + REACH));
  const behind = i === 0 ? sentence.slice(Math.max(prevEnd, at - REACH), at) : '';
  return categoryOf(ahead) ?? categoryOf(behind);
}

function codesIn(sentence: string): string[] {
  const m = sentence.match(MCC_LIST);
  if (!m) return [];
  return [...new Set((m[1].match(/\d{4}/g) ?? []))];
}

/** Everything a plain reader can honestly say about a rewards page. */
export function readCardPage(html: string, url: string): Omit<CardPageScan, 'codes' | 'prompt' | 'error'> {
  const text = htmlToText(html, 60_000, { whole: true });
  const title = pageMeta(html).title;
  const candidates: Candidate[] = [];
  const seen = new Map<string, Candidate>();

  for (const full of sentences(text)) {
    const quote = asQuote(full);
    const add = (c: Candidate) => {
      // Identical claims collapse into one candidate with a count: a marketing
      // page states its headline rate five times, and five rows to tick is not
      // five pieces of information.
      const id = `${c.kind}:${c.rate ?? ''}:${c.reward_type ?? ''}:${c.category ?? ''}:${c.cap_cents ?? ''}:${(c.mccs ?? []).join()}`;
      const prior = seen.get(id);
      if (prior) {
        prior.occurrences = (prior.occurrences ?? 1) + 1;
        // Keep the sentence that says the most.
        if (c.quote.length > prior.quote.length) prior.quote = c.quote;
        return;
      }
      const row = { ...c, occurrences: 1 };
      seen.set(id, row);
      candidates.push(row);
    };

    // One sentence can state several rates — "4 MPD on online spend and 1 MPD
    // on everything else" is two rules, and taking only the first loses the
    // base rate.
    const rates = [...full.matchAll(new RegExp(RATE.source, 'gi'))];
    if (rates.length) {
      const cap = full.match(CAP);
      let found = false;
      for (const [i, rate] of rates.entries()) {
        const value = parseFloat(rate[1]);
        const isCashback = /%/.test(rate[2]);
        // Anything absurd is more likely a price than a rate.
        if (!Number.isFinite(value) || value <= 0 || value > 100) continue;
        found = true;
        add({
          kind: 'rate',
          quote,
          rate: value,
          reward_type: isCashback ? 'cashback' : 'miles',
          // The category is read from the words around this rate, and never
          // past a neighbouring one: in "4 mpd on dining and 0.4 mpd on
          // everything else" the base rate must not inherit "dining".
          category: categoryForRate(full, rates, i),
          cap_cents: cap ? cents(cap[1]) : undefined,
          cap_window: windowFrom(full),
          mccs: codesIn(full),
        });
      }
      if (found) continue;
    }

    const codes = codesIn(full);
    const excluded = EXCLUDE.test(full);
    if (codes.length) {
      add({ kind: excluded ? 'exclusion' : 'mcc', quote, mccs: codes, category: categoryOf(full) });
      continue;
    }
    if (excluded) {
      add({ kind: 'exclusion', quote, category: categoryOf(full) });
      continue;
    }

    const min = full.match(MIN_SPEND);
    if (min) {
      add({ kind: 'minspend', quote, min_spend_cents: cents(min[1]), cap_window: windowFrom(full) });
      continue;
    }

    const cap = full.match(CAP);
    if (cap && /\b(cap|maximum|up to)\b/i.test(full)) {
      add({ kind: 'cap', quote, cap_cents: cents(cap[1]), cap_window: windowFrom(full), category: categoryOf(full) });
    }
  }

  return { url, title, text_length: text.length, candidates };
}

export async function scanCardPage(
  env: Env,
  nickname: string,
  rawUrl: string,
  pasted?: string
): Promise<CardPageScan> {
  const card = await env.DB.prepare(`SELECT product FROM cards WHERE nickname = ? COLLATE NOCASE`)
    .bind(nickname)
    .first<{ product: string }>();
  const promptFor = (source: string, text: string) =>
    cardRulesPrompt(nickname, card?.product ?? nickname, { source, text });
  const blank: CardPageScan = {
    url: rawUrl,
    title: '',
    text_length: 0,
    candidates: [],
    codes: [],
    prompt: '',
    error: null,
  };

  // Most bank sites refuse anything that is not a browser, so pasted text is
  // not a fallback here — it is the path that works.
  if (pasted && pasted.trim()) {
    const read = readCardPage(`<body>${escapeHtml(pasted)}</body>`, rawUrl || 'pasted text');
    const codes = await describeCodes(env, read);
    return {
      ...read,
      url: rawUrl || 'pasted text',
      codes,
      prompt: promptFor(rawUrl || 'pasted text', pasted),
      error: null,
    };
  }

  if (!rawUrl) return { ...blank, error: 'give a URL or paste the page text' };

  let html: string;
  try {
    const res = await fetch(rawUrl, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ...blank, error: `the page answered ${res.status}` };
    html = (await res.text()).slice(0, 900_000);
  } catch (e) {
    return { ...blank, error: `could not fetch it (${(e as Error).message})` };
  }

  const read = readCardPage(html, rawUrl);
  const text = htmlToText(html, 60_000, { whole: true });
  if (!read.text_length)
    return { ...blank, url: rawUrl, error: 'no readable text — a scanned image, or a page that needs JavaScript. Copy the page and paste it instead.' };

  return { ...read, codes: await describeCodes(env, read), prompt: promptFor(rawUrl, text), error: null };
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Say what this app calls every code a page mentions, so a list of numbers
 *  becomes something that can be checked. */
async function describeCodes(
  env: Env,
  read: Omit<CardPageScan, 'codes' | 'prompt' | 'error'>
): Promise<CardPageScan['codes']> {
  const all = [...new Set(read.candidates.flatMap((c) => c.mccs ?? []))];
  const codes: CardPageScan['codes'] = [];
  for (const mcc of all) {
    const row = await env.DB.prepare(`SELECT description, category FROM mcc_codes WHERE code = ?`)
      .bind(mcc)
      .first<{ description: string; category: string }>();
    codes.push({
      mcc,
      description: row?.description ?? null,
      category: row?.category ?? null,
      excluded_here: read.candidates.some((c) => c.kind === 'exclusion' && (c.mccs ?? []).includes(mcc)),
    });
  }
  return codes;
}
