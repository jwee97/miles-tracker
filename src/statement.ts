import { today } from './spend';
import type { Env } from './types';

/**
 * Turning a pasted statement into transactions.
 *
 * Typing a month of spend by hand is how a tracker stops being used. Banks
 * publish statements as PDFs, but the text copies out readably, and the shapes
 * are few enough to parse: a date, sometimes a posting date, a description, an
 * amount, occasionally a CR suffix for a refund.
 *
 * Nothing is imported without being shown first. A line this cannot read is
 * reported with the reason rather than dropped, because a silently missing
 * transaction is worse than one you have to type.
 */

export interface ParsedRow {
  occurred_at: string;
  posted_at: string | null;
  merchant: string;
  amount_cents: number;
  /** The line it came from, so a wrong row can be traced back. */
  raw: string;
  /** A refund or payment: negative, and never counted toward a minimum. */
  credit: boolean;
  duplicate?: boolean;
  mcc?: string | null;
  category?: string | null;
}

export interface SkippedLine {
  raw: string;
  reason: string;
}

export interface StatementParse {
  rows: ParsedRow[];
  skipped: SkippedLine[];
  /** Total of the rows that would be imported, for checking against the bill. */
  total_cents: number;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** Lines every statement carries that are not purchases. */
const NOISE =
  /^(sub\s*-?\s*total|grand total|balance previous statement|total|previous balance|balance (b\/f|c\/f|carried|brought)|payment (received|thank)|thank you|minimum payment|credit limit|available (credit|limit)|statement (date|period)|interest charge|late (payment )?(charge|fee)|annual fee|gst|finance charge|new balance|opening balance|closing balance|transaction date|posting date|description|amount|card number|page \d)/i;

function pad(n: number) {
  return String(n).padStart(2, '0');
}

/**
 * A day and month with no year: a statement rarely prints one.
 *
 * With the statement's own date the answer is exact — nothing on a statement
 * happened after it was issued, so a later-looking date belongs to the year
 * before. Without it, today is the reference and a month of slack is allowed,
 * since a pasted statement may well include this week's spend.
 */
function resolveYear(day: number, month: number, reference: string, exact: boolean): string {
  const [ry, rm] = reference.split('-').map(Number);
  const candidate = month * 100 + day;
  const ref = rm * 100 + Number(reference.slice(8, 10));
  let year = ry;
  if (exact ? candidate > ref : candidate > ref + 100) year -= 1;
  return `${year}-${pad(month)}-${pad(day)}`;
}

function parseDate(token: string, reference: string, exact: boolean): string | null {
  // 2026-09-14
  let m = token.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return token;

  // 14/09/2026 or 14/09/26 or 14-09-2026
  m = token.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (m) {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return `${year}-${pad(Number(m[2]))}-${pad(Number(m[1]))}`;
  }

  // 14/09 — OCBC prints the year only in the statement header.
  m = token.match(/^(\d{1,2})[/-](\d{1,2})$/);
  if (m) {
    const month = Number(m[2]);
    if (month >= 1 && month <= 12) return resolveYear(Number(m[1]), month, reference, exact);
  }

  // 14 SEP / 14SEP / SEP 14
  m = token.match(/^(\d{1,2})\s*([a-z]{3,4})$/i);
  if (m && MONTHS[m[2].toLowerCase()]) return resolveYear(Number(m[1]), MONTHS[m[2].toLowerCase()], reference, exact);
  m = token.match(/^([a-z]{3,4})\s*(\d{1,2})$/i);
  if (m && MONTHS[m[1].toLowerCase()]) return resolveYear(Number(m[2]), MONTHS[m[1].toLowerCase()], reference, exact);

  return null;
}

/** Leading dates on a line: one is the transaction date, two adds the posting date. */
function leadingDates(line: string, reference: string, exact: boolean): { dates: string[]; rest: string } {
  const dates: string[] = [];
  let rest = line.trim();
  for (let i = 0; i < 2; i++) {
    const m = rest.match(/^(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{1,2}\s*[a-z]{3,4}|[a-z]{3,4}\s*\d{1,2})\b[\s|,]*/i);
    if (!m) break;
    const iso = parseDate(m[1].trim(), reference, exact);
    if (!iso) break;
    dates.push(iso);
    rest = rest.slice(m[0].length);
  }
  return { dates, rest };
}

const AMOUNT = /(-?\(?\$?\s*\d[\d,]*\.\d{2}\)?)\s*(cr|dr)?\s*$/i;

export function parseStatement(text: string, todayIso: string, statementDate?: string | null): StatementParse {
  const reference = statementDate || todayIso;
  const exact = !!statementDate;
  const rows: ParsedRow[] = [];
  const skipped: SkippedLine[] = [];

  for (const original of text.split(/\r?\n/)) {
    const line = original.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (NOISE.test(line)) continue;

    const { dates, rest } = leadingDates(line, reference, exact);
    if (!dates.length) {
      // Only complain about lines that look like they were meant to be rows.
      if (AMOUNT.test(line)) skipped.push({ raw: original.trim(), reason: 'no date at the start of the line' });
      continue;
    }

    const amountMatch = rest.match(AMOUNT);
    if (!amountMatch) {
      skipped.push({ raw: original.trim(), reason: 'no amount at the end of the line' });
      continue;
    }

    const rawAmount = amountMatch[1];
    const negative = /^-/.test(rawAmount) || /^\(/.test(rawAmount) || /\)$/.test(rawAmount);
    const credit = negative || /^cr$/i.test(amountMatch[2] ?? '');
    const cents = Math.round(parseFloat(rawAmount.replace(/[^\d.]/g, '')) * 100);
    if (!Number.isFinite(cents) || cents === 0) {
      skipped.push({ raw: original.trim(), reason: 'could not read the amount' });
      continue;
    }

    const merchant = rest
      .slice(0, rest.length - amountMatch[0].length)
      .replace(/\s{2,}/g, ' ')
      .replace(/[|,]+$/, '')
      .trim();
    if (!merchant) {
      skipped.push({ raw: original.trim(), reason: 'no merchant between the date and the amount' });
      continue;
    }
    // Furniture is recognised by its wording, and most banks print it after
    // the dates: "07 AUG PAYMENT - THANK YOU 500.00" is not a purchase.
    if (NOISE.test(merchant)) continue;

    rows.push({
      // With two dates the bank prints transaction date first, posting second.
      occurred_at: dates[0],
      posted_at: dates[1] ?? null,
      merchant,
      amount_cents: credit ? -cents : cents,
      raw: original.trim(),
      credit,
    });
  }

  return { rows, skipped, total_cents: rows.reduce((s, r) => s + r.amount_cents, 0) };
}

/**
 * Mark rows that look like something already logged. Same card, same date,
 * same amount: importing a statement twice is the obvious way to double a
 * month's spend, and the second import should say so before it happens.
 */
export async function markDuplicates(env: Env, cardId: number, rows: ParsedRow[]): Promise<ParsedRow[]> {
  const out: ParsedRow[] = [];
  for (const r of rows) {
    const hit = await env.DB.prepare(
      `SELECT id FROM transactions
        WHERE card_id = ? AND amount_cents = ?
          AND (occurred_at = ? OR posted_at = ? OR occurred_at = ?)
        LIMIT 1`
    )
      .bind(cardId, r.amount_cents, r.occurred_at, r.occurred_at, r.posted_at ?? r.occurred_at)
      .first<{ id: number }>();
    out.push({ ...r, duplicate: !!hit });
  }
  return out;
}

export function statementToday(env: Env): string {
  return today(env);
}
