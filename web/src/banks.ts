/**
 * Turning one bank's statement layout into lines the importer understands.
 *
 * Every Singapore issuer prints the same four things — transaction date,
 * sometimes a posting date, a description and an amount — and each prints them
 * differently. A profile is small on purpose: recognise the bank, find the
 * statement date, drop the furniture, and emit
 * `DD MMM [DD MMM] DESCRIPTION AMOUNT`, which is the shape the parser already
 * reads. The parsing itself stays in one place.
 */

export interface BankProfile {
  key: string;
  label: string;
  /** How confident we are this is that bank's statement, 0 when it is not. */
  detect(text: string): number;
  /** The statement's own date, which dates rows that print no year. */
  statementDate(text: string): string | null;
  /** Lines that are not transactions, beyond the ones every statement has. */
  noise?: RegExp;
  /** Rebuild one line, or drop it by returning null. */
  line?(line: string): string | null;
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

const pad = (n: number) => String(n).padStart(2, '0');

/** "August 16, 2026", "16 AUG 2026", "16/08/2026" — whichever the bank prints. */
const MONTH_NAMES =
  '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

export function findStatementDate(text: string): string | null {
  // The gap before the date is lazy and the month is spelled out in the
  // pattern: a greedy gap happily eats "Aug" and captures "ust".
  let m = text.match(new RegExp(`statement\\s*date\\D{0,12}?\\b${MONTH_NAMES}\\s+(\\d{1,2}),?\\s+(\\d{4})`, 'i'));
  if (m) return `${m[3]}-${pad(MONTHS[m[1].toLowerCase()])}-${pad(Number(m[2]))}`;

  m = text.match(new RegExp(`statement\\s*date\\D{0,12}?\\b(\\d{1,2})\\s+${MONTH_NAMES}\\s+(\\d{4})`, 'i'));
  if (m) return `${m[3]}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(Number(m[1]))}`;

  m = text.match(/statement\s*date\D{0,12}?\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})/i);
  if (m) return `${m[3]}-${pad(Number(m[2]))}-${pad(Number(m[1]))}`;

  return null;
}

const score = (text: string, ...patterns: RegExp[]) =>
  patterns.reduce((n, p) => n + (p.test(text) ? 1 : 0), 0);

/** `(12.34)` is how several issuers print a credit; the importer reads `12.34 CR`. */
function bracketsToCredit(line: string): string {
  return line.replace(/\(\s*([\d,]+\.\d{2})\s*\)\s*$/, '$1 CR');
}

export const PROFILES: BankProfile[] = [
  {
    key: 'citi',
    label: 'Citibank',
    detect: (t) => score(t, /citibank/i, /citi\s+(rewards|premiermiles|cash\s*back|prestige)/i, /citi thankyou points/i),
    statementDate: findStatementDate,
    // Citi prints a running balance line and a sub-total per card section.
    noise: /^(balance previous statement|grand total|sub-?total|transactions for |all transactions billed|previous\s+balance|retail interest rate|your citi|points\b)/i,
    line: bracketsToCredit,
  },
  {
    key: 'dbs',
    label: 'DBS / POSB',
    detect: (t) => score(t, /\bdbs\b/i, /\bposb\b/i, /dbs cards p\.?o\.?/i),
    statementDate: findStatementDate,
    noise: /^(new transactions|previous balance|total (balance|amount)|minimum payment|payment - thank you|dbs points|sub-?total)/i,
    line: bracketsToCredit,
  },
  {
    key: 'uob',
    label: 'UOB',
    detect: (t) => score(t, /united overseas bank/i, /\buob\b/i, /uni\$/i),
    statementDate: findStatementDate,
    noise: /^(previous balance|payment - thank you|total (new balance|amount due)|uni\$|sub-?total|minimum payment)/i,
    line: bracketsToCredit,
  },
  {
    key: 'ocbc',
    label: 'OCBC',
    detect: (t) => score(t, /oversea-chinese banking/i, /\bocbc\b/i, /ocbc\$/i),
    statementDate: findStatementDate,
    // OCBC dates read DD/MM; give them the year from the statement later.
    noise: /^(previous balance|payment received|total|sub-?total|minimum payment|ocbc\$)/i,
    line: bracketsToCredit,
  },
  {
    key: 'hsbc',
    label: 'HSBC',
    detect: (t) => score(t, /hsbc/i, /hongkong and shanghai banking/i),
    statementDate: findStatementDate,
    noise: /^(previous balance|payment received|total|sub-?total|minimum payment|reward programme)/i,
    line: bracketsToCredit,
  },
];

export interface Detected {
  profile: BankProfile;
  confidence: number;
  statement_date: string | null;
}

export function detectBank(text: string, forced?: string): Detected {
  if (forced) {
    const p = PROFILES.find((x) => x.key === forced);
    if (p) return { profile: p, confidence: 1, statement_date: p.statementDate(text) };
  }
  const ranked = PROFILES.map((p) => ({ profile: p, confidence: p.detect(text) })).sort(
    (a, b) => b.confidence - a.confidence
  );
  const best = ranked[0];
  return { profile: best.profile, confidence: best.confidence, statement_date: best.profile.statementDate(text) };
}

/** What a line says once its dates and amount are taken off the ends. */
function describe(line: string): string {
  return line
    .replace(/^((\d{1,2}\s+[A-Z]{3,4}|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{4}-\d{2}-\d{2})[\s|,]*){1,2}/i, '')
    .replace(/\(?\$?\s*-?[\d,]+\.\d{2}\)?\s*(CR|DR)?\s*$/i, '')
    .trim();
}

/** A row whose day and month arrived as separate fragments, rejoined. */
function mergeSplitDates(line: string): string {
  return line.replace(
    /^(\d{1,2})\s+(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)\b/i,
    (_, d, mon) => `${pad(Number(d))} ${mon.toUpperCase()}`
  );
}

export interface Normalised {
  bank: string;
  label: string;
  confidence: number;
  statement_date: string | null;
  text: string;
  /** Every line the profile dropped, so nothing disappears unexplained. */
  dropped: number;
}

/**
 * Pages of raw lines in, one block of `DD MMM … AMOUNT` lines out. Only lines
 * that carry both a date and an amount survive, which is what separates a
 * transaction from the page of legal text around it.
 */
export function normalise(pages: { lines: string[] }[], forced?: string): Normalised {
  const all = pages.flatMap((p) => p.lines);
  const text = all.join('\n');
  const { profile, confidence, statement_date } = detectBank(text, forced);

  const kept: string[] = [];
  let dropped = 0;

  for (const raw of all) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    // Furniture is recognised by its wording, which on most statements sits
    // after the dates: "07 AUG PAYMENT - THANK YOU 500.00" is not a purchase.
    const wording = describe(line);
    if (profile.noise?.test(line) || profile.noise?.test(wording)) {
      dropped++;
      continue;
    }
    const shaped = profile.line ? profile.line(mergeSplitDates(line)) : mergeSplitDates(line);
    if (!shaped) {
      dropped++;
      continue;
    }
    // A transaction line starts with a date and ends with an amount.
    const dated = /^(\d{1,2}\s+[A-Z]{3,4}|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{4}-\d{2}-\d{2})\b/i.test(shaped);
    const priced = /[\d,]+\.\d{2}\s*(CR|DR)?$/i.test(shaped);
    if (dated && priced) kept.push(shaped);
    else dropped++;
  }

  return { bank: profile.key, label: profile.label, confidence, statement_date, text: kept.join('\n'), dropped };
}
