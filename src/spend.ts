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

/**
 * Reads a date written the way someone actually types one into a chat:
 * `2026-09-05`, `5/9` (day/month), `yesterday`, or `-3` for three days ago.
 * Returns null for anything that isn't a date, so callers can treat the token
 * as part of the note instead.
 */
export function parseDateToken(token: string, env: Env): string | null {
  const t = token.trim().toLowerCase();
  const now = localNow(env);

  if (t === 'today') return isoDate(now);
  if (t === 'yesterday') return isoDate(new Date(now.getTime() - 86400_000));

  const rel = t.match(/^-(\d{1,3})$/);
  if (rel) return isoDate(new Date(now.getTime() - parseInt(rel[1], 10) * 86400_000));

  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    const d = new Date(t + 'T00:00:00Z');
    return Number.isNaN(d.getTime()) || isoDate(d) !== t ? null : t;
  }

  const dm = t.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (dm) {
    const day = parseInt(dm[1], 10);
    const mon = parseInt(dm[2], 10);
    if (day < 1 || day > 31 || mon < 1 || mon > 12) return null;
    const build = (y: number) => new Date(Date.UTC(y, mon - 1, day));
    let d = build(now.getUTCFullYear());
    if (d.getUTCDate() !== day) return null; // 31/2 and friends
    // A day/month more than a week ahead means last year — logging December
    // spend in January is far likelier than logging spend that hasn't happened.
    if (isoDate(d) > isoDate(new Date(now.getTime() + 7 * 86400_000))) d = build(now.getUTCFullYear() - 1);
    return isoDate(d);
  }

  return null;
}

/**
 * The date a window is judged on. Banks assess statement cycles, minimum spend
 * and bonus caps on when a transaction POSTED, so posted_at wins whenever it is
 * known; until then occurred_at is the best estimate available.
 */
export const EFFECTIVE_DATE = `COALESCE(posted_at, occurred_at)`;

export interface Spend {
  /** Everything whose effective date falls in the window. */
  total_cents: number;
  /**
   * The part of `total_cents` that could still move out of this window: made
   * close enough to the end that it may post after it, with no confirmed
   * posting date yet.
   */
  at_risk_cents: number;
  at_risk_count: number;
}

export async function spendIn(
  env: Env,
  cardId: number,
  start: string,
  end: string
): Promise<Spend> {
  const lag = parseInt(env.POSTING_LAG_DAYS || '0', 10);
  // Spend on or after this date, not yet confirmed posted, may slip.
  const riskFrom = isoDate(new Date(Date.parse(end + 'T00:00:00Z') - lag * 86400_000));

  const row = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(amount_cents), 0) AS total,
       COALESCE(SUM(CASE WHEN posted_at IS NULL AND occurred_at >= ? THEN amount_cents ELSE 0 END), 0) AS at_risk,
       COALESCE(SUM(CASE WHEN posted_at IS NULL AND occurred_at >= ? THEN 1 ELSE 0 END), 0) AS at_risk_n
     FROM transactions
     WHERE card_id = ? AND ${EFFECTIVE_DATE} >= ? AND ${EFFECTIVE_DATE} <= ?`
  )
    .bind(riskFrom, riskFrom, cardId, start, end)
    .first<{ total: number; at_risk: number; at_risk_n: number }>();

  return {
    total_cents: row?.total ?? 0,
    at_risk_cents: lag > 0 ? (row?.at_risk ?? 0) : 0,
    at_risk_count: lag > 0 ? (row?.at_risk_n ?? 0) : 0,
  };
}

export async function spentBetween(env: Env, cardId: number, start: string, end: string): Promise<number> {
  return (await spendIn(env, cardId, start, end)).total_cents;
}

export async function countBetween(env: Env, cardId: number, start: string, end: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM transactions
     WHERE card_id = ? AND ${EFFECTIVE_DATE} >= ? AND ${EFFECTIVE_DATE} <= ? AND amount_cents > 0`
  )
    .bind(cardId, start, end)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export interface Utilization {
  card: Card;
  cycle: { start: string; end: string };
  balance_cents: number;
  at_risk_cents: number;
  limit_cents: number;
  percent: number;
  days_left: number;
}

export async function utilization(env: Env, card: Card): Promise<Utilization> {
  const cycle = statementCycle(card.statement_day, env);
  const spend = await spendIn(env, card.id, cycle.start, cycle.end);
  const balance = spend.total_cents;
  return {
    card,
    cycle,
    balance_cents: balance,
    at_risk_cents: spend.at_risk_cents,
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
  /** spent_cents minus anything that may still post into the next window. */
  confirmed_cents: number;
  at_risk_cents: number;
  at_risk_count: number;
  /** True when the minimum is only met by counting spend that may yet slip. */
  met_only_with_at_risk: boolean;
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

  const spend = await spendIn(env, card.id, window.start, window.end);
  const spent = spend.total_cents;
  const confirmed = spent - spend.at_risk_cents;
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
    confirmed_cents: confirmed,
    at_risk_cents: spend.at_risk_cents,
    at_risk_count: spend.at_risk_count,
    met_only_with_at_risk: remaining === 0 && confirmed < req.amount_cents,
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

/** The named ranges the ledger and the scanner inbox both offer. */
export const RANGES = ['today', 'yesterday', '7d', '30d', 'month', 'lastmonth', 'ytd', 'all'] as const;
export type RangeName = (typeof RANGES)[number];

export const RANGE_LABEL: Record<RangeName, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  month: 'This month',
  lastmonth: 'Last month',
  ytd: 'Year to date',
  all: 'All time',
};

/**
 * Resolve a named range to dates. Done here rather than in the browser so it
 * follows the app's configured timezone, not the device's — the two disagree
 * about what "today" is for eight hours of every day.
 */
export function resolveRange(
  env: Env,
  range: string | null,
  from: string | null = null,
  to: string | null = null
): { from: string | null; to: string | null; label: string } {
  const now = today(env);
  const day = (offset: number) => isoDate(new Date(Date.parse(now + 'T00:00:00Z') + offset * 86400_000));

  switch (range) {
    case 'today':
      return { from: now, to: now, label: RANGE_LABEL.today };
    case 'yesterday':
      return { from: day(-1), to: day(-1), label: RANGE_LABEL.yesterday };
    case '7d':
      return { from: day(-6), to: now, label: RANGE_LABEL['7d'] };
    case '30d':
      return { from: day(-29), to: now, label: RANGE_LABEL['30d'] };
    case 'month':
      return { from: now.slice(0, 8) + '01', to: now, label: RANGE_LABEL.month };
    case 'lastmonth': {
      const [y, m] = now.split('-').map(Number);
      return {
        from: isoDate(new Date(Date.UTC(y, m - 2, 1))),
        to: isoDate(new Date(Date.UTC(y, m - 1, 0))),
        label: RANGE_LABEL.lastmonth,
      };
    }
    case 'ytd':
      return { from: `${now.slice(0, 4)}-01-01`, to: now, label: RANGE_LABEL.ytd };
    case 'all':
      return { from: null, to: null, label: RANGE_LABEL.all };
    default:
      return { from, to, label: from || to ? `${from ?? '…'} to ${to ?? '…'}` : RANGE_LABEL.all };
  }
}
