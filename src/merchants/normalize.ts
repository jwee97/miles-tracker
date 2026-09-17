/**
 * Turning what a bank printed into something that can be compared.
 *
 * Statement text is not a merchant name. It carries the acquirer's routing
 * marks, the outlet, the city, a reference number and whatever the terminal
 * felt like adding: `GRAB*RIDE 8829 SINGAPORE SG`. Two arrivals of the same
 * purchase rarely print identically, so matching on the raw string means
 * matching almost nothing.
 *
 * What this does NOT do is decide that two merchants are the same because they
 * look alike. It removes noise whose meaning is known — a payment-processor
 * prefix, a trailing reference, a country suffix — and leaves everything else
 * alone. Aggressive normalisation merges merchants that are genuinely
 * different, and a wrongly merged merchant is much harder to notice than an
 * unmatched one.
 */

/** Processor and aggregator prefixes that say who routed the payment, not who was paid. */
const PREFIXES = [
  'sq *',
  'sq*',
  'stripe *',
  'paypal *',
  'pay*',
  'wl *',
  'tfr ',
  'nets ',
  'visa ',
  'mc ',
];

/** Trailing noise: country and city marks a statement adds to every line. */
const SUFFIXES = [
  ' singapore sg',
  ' singapore',
  ' sgp',
  ' sg',
  ' pte ltd',
  ' pte. ltd.',
  ' pte',
  ' ltd',
  ' llp',
  ' inc',
  ' co',
];

/** `GRAB*RIDE` → `grab`: the star separates the aggregator from what it sold. */
const STAR = /^([a-z0-9]+)\s*\*\s*(.+)$/;

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * The comparison key for a piece of statement text.
 *
 * Lowercased, stripped of punctuation, processor marks, reference numbers and
 * country suffixes. Empty when nothing survives — which is itself a useful
 * answer, and better than returning noise that would match other noise.
 */
export function normalizeKey(raw: string | null | undefined): string {
  if (!raw) return '';
  let s = collapse(String(raw).toLowerCase());

  for (const p of PREFIXES) if (s.startsWith(p)) s = s.slice(p.length);

  // An aggregator's star: keep the aggregator. `GRAB*RIDE` and `GRAB*FOOD` are
  // both Grab, and the app cares which company was paid.
  const star = s.match(STAR);
  if (star && star[1].length >= 3) s = star[1];

  // Reference numbers, dates and terminal ids. A run of four or more digits is
  // never part of a name; shorter runs can be (7-Eleven, Coffee Bean 21).
  s = s.replace(/\b\d{4,}\b/g, ' ');
  s = s.replace(/\b\d{1,2}[-/]\d{1,2}([-/]\d{2,4})?\b/g, ' ');

  s = s.replace(/[^a-z0-9&' ]+/g, ' ');
  s = collapse(s);

  for (const suf of SUFFIXES) if (s.endsWith(suf)) s = s.slice(0, -suf.length);

  return collapse(s);
}

/**
 * A readable name for a merchant.
 *
 * A name that already has lower-case letters in it was written by a person and
 * is left exactly as they wrote it — `FairPrice` is not improved by becoming
 * `Fairprice`, and a ledger that quietly re-spells what you typed is one you
 * stop trusting. Only machine output is re-cased: a statement line is SHOUTED,
 * carries a reference number, and is unreadable at length.
 */
export function canonicalName(raw: string): string {
  const trimmed = collapse(raw);
  if (/[a-z]/.test(trimmed)) return trimmed;

  const key = normalizeKey(raw);
  if (!key) return trimmed;
  return key
    .split(' ')
    .map((w) => (w.length <= 2 && w !== 'up' ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

/**
 * How alike two merchant strings are, 0 to 1.
 *
 * Used only to propose a possible duplicate for review, never to merge one.
 * It compares the sets of words in the two keys, which handles the common case
 * — the same words in a different order, or one line carrying an extra word —
 * without pretending to understand either name.
 */
export function similarity(a: string, b: string): number {
  const ka = normalizeKey(a);
  const kb = normalizeKey(b);
  if (!ka || !kb) return 0;
  if (ka === kb) return 1;

  const wa = new Set(ka.split(' '));
  const wb = new Set(kb.split(' '));
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  const union = new Set([...wa, ...wb]).size;
  const jaccard = union === 0 ? 0 : shared / union;

  // One name being a prefix of the other is strong evidence: statements
  // truncate, they rarely invent.
  if (ka.startsWith(kb) || kb.startsWith(ka)) return Math.max(jaccard, 0.8);
  return jaccard;
}
