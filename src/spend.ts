import type { Card, Env, Requirement } from './types';

export const money = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const parseMoney = (s: string): number | null => {
  const m = s.replace(/[$,]/g, '').match(/^-?\d+(\.\d{1,2})?$/);
  return m ? Math.round(parseFloat(m[0]) * 100) : null;
};

const tz = (env: Env) => parseInt(env.TZ_OFFSET_MINUTES || '0', 10);

/** "Now" shifted into the user's timezone, so day boundaries match their calendar. */
export function localNow(env: Env): Date {
  return new Date(Date.now() + tz(env) * 60_000);
}

export const isoDate = (d: Date) => d.toISOString().slice(0, 10);
export const today = (env: Env) => isoDate(localNow(env));

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86400_000);
}

export function addMonths(date: string, months: number): string {
  const d = new Date(date + 'T00:00:00Z');
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const day = Math.min(d.getUTCDate(), daysInMonth(y + Math.floor(m / 12), ((m % 12) + 12) % 12));
  return isoDate(new Date(Date.UTC(y, m, day)));
}

/**
 * The statement cycle containing `ref`, as an inclusive [start, end] date range.
 * A statement closing on day N means the cycle runs from N+1 of one month
 * through N of the next. Months shorter than N clamp to the last day.
 */
export function statementCycle(statementDay: number, env: Env): { start: string; end: string } {
  const l = localNow(env);
  const y = l.getUTCFullYear();
  const m = l.getUTCMonth();
  const d = l.getUTCDate();
  const clamp = (yy: number, mm: number) => Math.min(statementDay, daysInMonth(yy, mm));

  let endY = y;
  let endM = m;
  if (d > clamp(y, m)) {
    endM = m + 1;
    if (endM > 11) {
      endM = 0;
      endY++;
    }
  }
  const end = new Date(Date.UTC(endY, endM, clamp(endY, endM)));
  let startY = endY;
  let startM = endM - 1;
  if (startM < 0) {
    startM = 11;
    startY--;
  }
  const prevClose = new Date(Date.UTC(startY, startM, clamp(startY, startM)));
  return { start: isoDate(new Date(prevClose.getTime() + 86400_000)), end: isoDate(end) };
}

export function calendarQuarter(env: Env): { start: string; end: string } {
  const l = localNow(env);
  const y = l.getUTCFullYear();
  const q = Math.floor(l.getUTCMonth() / 3);
  const startM = q * 3;
  const endM = startM + 2;
  return {
    start: isoDate(new Date(Date.UTC(y, startM, 1))),
    end: isoDate(new Date(Date.UTC(y, endM, daysInMonth(y, endM)))),
  };
}

export function calendarMonth(env: Env): { start: string; end: string } {
  const l = localNow(env);
  const y = l.getUTCFullYear();
  const m = l.getUTCMonth();
  return { start: isoDate(new Date(Date.UTC(y, m, 1))), end: isoDate(new Date(Date.UTC(y, m, daysInMonth(y, m)))) };
}

export async function spentBetween(env: Env, cardId: number, start: string, end: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM transactions
     WHERE card_id = ? AND occurred_at >= ? AND occurred_at <= ?`
  )
    .bind(cardId, start, end)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export async function countBetween(env: Env, cardId: number, start: string, end: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM transactions
     WHERE card_id = ? AND occurred_at >= ? AND occurred_at <= ? AND amount_cents > 0`
  )
    .bind(cardId, start, end)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export interface Utilization {
  card: Card;
  cycle: { start: string; end: string };
  balance_cents: number;
  limit_cents: number;
  percent: number;
  days_left: number;
}

export async function utilization(env: Env, card: Card): Promise<Utilization> {
  const cycle = statementCycle(card.statement_day, env);
  const balance = await spentBetween(env, card.id, cycle.start, cycle.end);
  return {
    card,
    cycle,
    balance_cents: balance,
    limit_cents: card.credit_limit_cents,
    percent: card.credit_limit_cents > 0 ? (balance / card.credit_limit_cents) * 100 : 0,
    days_left: daysBetween(today(env), cycle.end),
  };
}

export interface Progress {
  requirement: Requirement;
  card: Card;
  window: { start: string; end: string };
  spent_cents: number;
  remaining_cents: number;
  days_left: number;
  per_day_cents: number;
  /** True only when BOTH the amount and the transaction count are satisfied. */
  met: boolean;
  txn_count: number;
  txns_required: number;
  txns_remaining: number;
  /** Set when the elevated earn rate has been exhausted — stop using this card. */
  cap_reached: boolean;
  over_cap_cents: number;
}

export async function requirementProgress(env: Env, card: Card, req: Requirement): Promise<Progress> {
  let window: { start: string; end: string };
  if (req.window === 'calendar_month') window = calendarMonth(env);
  else if (req.window === 'calendar_quarter') window = calendarQuarter(env);
  else if (req.window === 'statement_cycle') window = statementCycle(card.statement_day, env);
  else window = { start: req.starts_at ?? card.opened_at ?? today(env), end: req.deadline ?? today(env) };

  const spent = await spentBetween(env, card.id, window.start, window.end);
  const remaining = Math.max(0, req.amount_cents - spent);
  const daysLeft = Math.max(0, daysBetween(today(env), window.end));
  const cap = req.bonus_cap_cents ?? 0;

  // Cards like UOB One gate the reward on a transaction count as well as a
  // dollar amount, so a requirement is only met when both are satisfied.
  const txnsRequired = req.min_txns ?? 0;
  const txnCount = txnsRequired > 0 ? await countBetween(env, card.id, window.start, window.end) : 0;
  const txnsRemaining = Math.max(0, txnsRequired - txnCount);

  return {
    requirement: req,
    card,
    window,
    spent_cents: spent,
    remaining_cents: remaining,
    days_left: daysLeft,
    per_day_cents: daysLeft > 0 ? Math.ceil(remaining / daysLeft) : remaining,
    met: remaining === 0 && txnsRemaining === 0,
    txn_count: txnCount,
    txns_required: txnsRequired,
    txns_remaining: txnsRemaining,
    cap_reached: cap > 0 && spent >= cap,
    over_cap_cents: cap > 0 ? Math.max(0, spent - cap) : 0,
  };
}

export async function activeCards(env: Env): Promise<Card[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM cards WHERE closed_at IS NULL ORDER BY issuer, product`
  ).all<Card>();
  return results ?? [];
}

export async function requirementsFor(env: Env, cardId: number): Promise<Requirement[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM requirements WHERE card_id = ? AND active = 1`
  )
    .bind(cardId)
    .all<Requirement>();
  return results ?? [];
}

/** Fires an alert at most once per key; returns false if already sent. */
export async function claimAlert(env: Env, key: string): Promise<boolean> {
  const r = await env.DB.prepare(`INSERT OR IGNORE INTO alerts_sent (key) VALUES (?)`).bind(key).run();
  return (r.meta.changes ?? 0) > 0;
}
