import { recommend } from './rules';
import { calendarMonth, money, today } from './spend';
import type { Env } from './types';

/**
 * Spending that never touched a credit card.
 *
 * Recording it is not bookkeeping for its own sake. This app exists to earn
 * miles, and money that goes out by PayLah, PayNow or cash earns none — so the
 * question worth answering is how much of a month is missing out, and how much
 * of that could have gone on a card instead. A total that ignores the part you
 * could never have put on a card would be a fantasy, so each row says whether a
 * card was an option.
 */

export const METHODS = [
  { key: 'paylah', label: 'DBS PayLah!', card_possible: 1 },
  { key: 'paynow', label: 'PayNow', card_possible: 0 },
  { key: 'cash', label: 'Cash', card_possible: 0 },
  { key: 'nets', label: 'NETS', card_possible: 1 },
  { key: 'bank_transfer', label: 'Bank transfer', card_possible: 0 },
  { key: 'grabpay', label: 'GrabPay', card_possible: 1 },
  { key: 'shopeepay', label: 'ShopeePay', card_possible: 1 },
  { key: 'ez_link', label: 'EZ-Link / SimplyGo', card_possible: 1 },
  { key: 'giro', label: 'GIRO', card_possible: 0 },
  { key: 'other', label: 'Something else', card_possible: 1 },
] as const;

export function defaultCardPossible(method: string): number {
  return METHODS.find((m) => m.key === method)?.card_possible ?? 1;
}

export interface OtherRow {
  id: number;
  occurred_at: string;
  amount_cents: number;
  method: string;
  merchant: string | null;
  category: string | null;
  card_possible: number;
  note: string | null;
}

export interface MissedReward {
  category: string;
  spend_cents: number;
  /** The card that would have earned most on it, and what it would have paid. */
  card: string | null;
  miles: number;
  cashback_cents: number;
  value_cents: number;
}

export interface OtherSummary {
  month: string;
  rows: OtherRow[];
  total_cents: number;
  /** The part a card could have taken. */
  avoidable_cents: number;
  by_method: { method: string; label: string; spend_cents: number; count: number; card_possible: number }[];
  by_category: { category: string; spend_cents: number; count: number }[];
  /** Card spend in the same month, so the share is a real share. */
  card_spend_cents: number;
  share_percent: number;
  missed: MissedReward[];
  missed_value_cents: number;
  missed_miles: number;
  /** Rows with no category cannot be costed, and are named rather than ignored. */
  uncategorised_cents: number;
}

const labelFor = (key: string) => METHODS.find((m) => m.key === key)?.label ?? key;

export async function monthOfOther(env: Env, month?: string): Promise<OtherSummary> {
  const window = month
    ? { start: `${month}-01`, end: lastDay(month) }
    : (() => {
        const m = calendarMonth(env);
        return { start: m.start, end: m.end };
      })();
  const label = window.start.slice(0, 7);

  const { results } = await env.DB.prepare(
    `SELECT id, occurred_at, amount_cents, method, merchant, category, card_possible, note
       FROM other_spend WHERE occurred_at >= ? AND occurred_at <= ?
      ORDER BY occurred_at DESC, id DESC`
  )
    .bind(window.start, window.end)
    .all<OtherRow>();
  const rows = results ?? [];

  const byMethod = new Map<string, { spend_cents: number; count: number; card_possible: number }>();
  const byCategory = new Map<string, { spend_cents: number; count: number }>();
  for (const r of rows) {
    const m = byMethod.get(r.method) ?? { spend_cents: 0, count: 0, card_possible: 0 };
    m.spend_cents += r.amount_cents;
    m.count++;
    m.card_possible += r.card_possible ? r.amount_cents : 0;
    byMethod.set(r.method, m);

    const key = r.category ?? '(uncategorised)';
    const c = byCategory.get(key) ?? { spend_cents: 0, count: 0 };
    c.spend_cents += r.amount_cents;
    c.count++;
    byCategory.set(key, c);
  }

  // What the same month cost on cards, so the share means something.
  const card = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM transactions
      WHERE amount_cents > 0 AND COALESCE(posted_at, occurred_at) >= ? AND COALESCE(posted_at, occurred_at) <= ?`
  )
    .bind(window.start, window.end)
    .first<{ cents: number }>();
  const cardSpend = card?.cents ?? 0;
  const total = rows.reduce((s, r) => s + r.amount_cents, 0);
  const avoidable = rows.filter((r) => r.card_possible).reduce((s, r) => s + r.amount_cents, 0);

  // Only spend that could have gone on a card, and that has a category, can be
  // costed — anything else would be a made-up number.
  const missed: MissedReward[] = [];
  const costable = new Map<string, number>();
  for (const r of rows) {
    if (!r.card_possible || !r.category) continue;
    costable.set(r.category, (costable.get(r.category) ?? 0) + r.amount_cents);
  }
  for (const [category, cents] of costable) {
    const rec = await recommend(env, { amount_cents: cents, mcc: null, category, channel: null });
    const best = rec.picks?.[0];
    missed.push({
      category,
      spend_cents: cents,
      card: best?.card.nickname ?? null,
      miles: best?.miles ?? 0,
      cashback_cents: best?.cashback_cents ?? 0,
      value_cents: best?.value_cents ?? 0,
    });
  }
  missed.sort((a, b) => b.value_cents - a.value_cents);

  return {
    month: label,
    rows,
    total_cents: total,
    avoidable_cents: avoidable,
    by_method: [...byMethod.entries()]
      .map(([method, v]) => ({ method, label: labelFor(method), ...v }))
      .sort((a, b) => b.spend_cents - a.spend_cents),
    by_category: [...byCategory.entries()]
      .map(([category, v]) => ({ category, ...v }))
      .sort((a, b) => b.spend_cents - a.spend_cents),
    card_spend_cents: cardSpend,
    share_percent: total + cardSpend > 0 ? (total / (total + cardSpend)) * 100 : 0,
    missed,
    missed_value_cents: missed.reduce((s, m) => s + m.value_cents, 0),
    missed_miles: missed.reduce((s, m) => s + m.miles, 0),
    uncategorised_cents: rows
      .filter((r) => r.card_possible && !r.category)
      .reduce((s, r) => s + r.amount_cents, 0),
  };
}

function lastDay(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** Months that actually have rows, for the picker. */
export async function otherMonths(env: Env): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT substr(occurred_at, 1, 7) AS month FROM other_spend ORDER BY month DESC LIMIT 24`
  ).all<{ month: string }>();
  const months = (results ?? []).map((r) => r.month);
  const now = today(env).slice(0, 7);
  return months.includes(now) ? months : [now, ...months];
}

export const describeMissed = (m: MissedReward) =>
  `${m.category}: $${money(m.spend_cents)}` +
  (m.card ? ` → ${m.card} would have paid ${m.miles ? `${m.miles.toLocaleString()} miles` : `$${money(m.cashback_cents)}`}` : '');
