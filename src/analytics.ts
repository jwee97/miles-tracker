import { EFFECTIVE_DATE, today } from './spend';
import type { Card, Env } from './types';
import type { EarnRule } from './points';

/** A calendar month, as [start, end] inclusive ISO dates. */
function monthRange(month: string): { start: string; end: string } {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, '0')}` };
}

function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface Analytics {
  month: string;
  prev_month: string;
  days_in_month: number;
  day_of_month: number | null;
  totals: {
    spend_cents: number;
    prev_spend_cents: number;
    txn_count: number;
    avg_txn_cents: number;
    active_days: number;
    largest_cents: number;
  };
  daily: { date: string; cents: number }[];
  cumulative: { day: number; cents: number; prev_cents: number | null }[];
  by_category: { key: string; label: string; cents: number; count: number }[];
  by_card: { key: string; label: string; cents: number; count: number }[];
  by_weekday: { dow: number; label: string; cents: number; count: number }[];
  top_merchants: { merchant: string; category: string | null; cents: number; count: number }[];
  rewards: {
    /** Estimated: caps are applied to monthly aggregates, not per transaction. */
    miles: number;
    cashback_cents: number;
    value_cents: number;
    per_dollar_cents: number;
    by_card: { label: string; miles: number; cashback_cents: number; value_cents: number }[];
  };
  missed: {
    category: string;
    cents: number;
    used_label: string;
    used_rate: number;
    used_type: string;
    best_label: string;
    best_rate: number;
    best_type: string;
    lost_value_cents: number;
  }[];
  insights: string[];
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const money = (c: number) => (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function buildAnalytics(env: Env, monthArg?: string): Promise<Analytics> {
  const nowIso = today(env);
  const month = /^\d{4}-\d{2}$/.test(monthArg ?? '') ? monthArg! : nowIso.slice(0, 7);
  const prevMonth = shiftMonth(month, -1);
  const win = monthRange(month);
  const prevWin = monthRange(prevMonth);
  const daysInMonth = Number(win.end.slice(8));
  const dayOfMonth = nowIso.slice(0, 7) === month ? Number(nowIso.slice(8)) : null;

  const sum = async (start: string, end: string) =>
    (
      await env.DB.prepare(
        `SELECT COALESCE(SUM(amount_cents),0) AS cents, COUNT(*) AS n,
                COALESCE(MAX(amount_cents),0) AS largest,
                COUNT(DISTINCT ${EFFECTIVE_DATE}) AS days
         FROM transactions
         WHERE amount_cents > 0 AND ${EFFECTIVE_DATE} >= ? AND ${EFFECTIVE_DATE} <= ?`
      )
        .bind(start, end)
        .first<{ cents: number; n: number; largest: number; days: number }>()
    ) ?? { cents: 0, n: 0, largest: 0, days: 0 };

  const cur = await sum(win.start, win.end);
  const prev = await sum(prevWin.start, prevWin.end);

  // --- daily series, zero-filled so the axis is a real calendar -------------
  const { results: dailyRows } = await env.DB.prepare(
    `SELECT ${EFFECTIVE_DATE} AS d, SUM(amount_cents) AS cents FROM transactions
     WHERE amount_cents > 0 AND ${EFFECTIVE_DATE} >= ? AND ${EFFECTIVE_DATE} <= ?
     GROUP BY d ORDER BY d`
  )
    .bind(win.start, win.end)
    .all<{ d: string; cents: number }>();
  const dailyMap = new Map((dailyRows ?? []).map((r) => [r.d, r.cents]));

  const daily: { date: string; cents: number }[] = [];
  for (let i = 1; i <= daysInMonth; i++) {
    const date = `${month}-${String(i).padStart(2, '0')}`;
    daily.push({ date, cents: dailyMap.get(date) ?? 0 });
  }

  const { results: prevDaily } = await env.DB.prepare(
    `SELECT ${EFFECTIVE_DATE} AS d, SUM(amount_cents) AS cents FROM transactions
     WHERE amount_cents > 0 AND ${EFFECTIVE_DATE} >= ? AND ${EFFECTIVE_DATE} <= ?
     GROUP BY d ORDER BY d`
  )
    .bind(prevWin.start, prevWin.end)
    .all<{ d: string; cents: number }>();
  const prevMap = new Map((prevDaily ?? []).map((r) => [Number(r.d.slice(8)), r.cents]));

  // Cumulative, so "ahead or behind last month" is answerable at a glance.
  const cumulative: { day: number; cents: number; prev_cents: number | null }[] = [];
  let run = 0;
  let prevRun = 0;
  const prevDays = Number(prevWin.end.slice(8));
  for (let i = 1; i <= daysInMonth; i++) {
    run += daily[i - 1].cents;
    if (i <= prevDays) prevRun += prevMap.get(i) ?? 0;
    cumulative.push({
      day: i,
      cents: run,
      // Stop the current month's line at today rather than flat-lining forward.
      prev_cents: i <= prevDays ? prevRun : null,
    });
  }

  const grouped = async (expr: string, label: string) => {
    const { results } = await env.DB.prepare(
      `SELECT ${expr} AS k, SUM(amount_cents) AS cents, COUNT(*) AS n FROM transactions t
       LEFT JOIN cards c ON c.id = t.card_id
       WHERE t.amount_cents > 0 AND ${EFFECTIVE_DATE.replace(/posted_at/g, 't.posted_at').replace(/occurred_at/g, 't.occurred_at')} >= ?
         AND ${EFFECTIVE_DATE.replace(/posted_at/g, 't.posted_at').replace(/occurred_at/g, 't.occurred_at')} <= ?
       GROUP BY k ORDER BY cents DESC`
    )
      .bind(win.start, win.end)
      .all<{ k: string | null; cents: number; n: number }>();
    return (results ?? []).map((r) => ({
      key: r.k ?? 'uncategorised',
      label: r.k ?? label,
      cents: r.cents,
      count: r.n,
    }));
  };

  const by_category = await grouped(`COALESCE(t.category, 'uncategorised')`, 'uncategorised');
  const by_card = await grouped(`COALESCE(c.product, 'unknown card')`, 'unknown card');

  const { results: dowRows } = await env.DB.prepare(
    `SELECT CAST(strftime('%w', ${EFFECTIVE_DATE}) AS INTEGER) AS dow,
            SUM(amount_cents) AS cents, COUNT(*) AS n
     FROM transactions
     WHERE amount_cents > 0 AND ${EFFECTIVE_DATE} >= ? AND ${EFFECTIVE_DATE} <= ?
     GROUP BY dow`
  )
    .bind(win.start, win.end)
    .all<{ dow: number; cents: number; n: number }>();
  const dowMap = new Map((dowRows ?? []).map((r) => [r.dow, r]));
  const by_weekday = DOW.map((label, dow) => ({
    dow,
    label,
    cents: dowMap.get(dow)?.cents ?? 0,
    count: dowMap.get(dow)?.n ?? 0,
  }));

  const { results: merchants } = await env.DB.prepare(
    `SELECT merchant, category, SUM(amount_cents) AS cents, COUNT(*) AS n FROM transactions
     WHERE amount_cents > 0 AND merchant IS NOT NULL AND TRIM(merchant) <> ''
       AND ${EFFECTIVE_DATE} >= ? AND ${EFFECTIVE_DATE} <= ?
     GROUP BY LOWER(merchant) ORDER BY cents DESC LIMIT 10`
  )
    .bind(win.start, win.end)
    .all<{ merchant: string; category: string | null; cents: number; n: number }>();

  // --- rewards and what a better card would have earned ---------------------
  const { results: cards } = await env.DB.prepare(`SELECT * FROM cards`).all<Card>();
  const { results: rules } = await env.DB.prepare(`SELECT * FROM earn_rules WHERE active = 1`).all<EarnRule>();
  const mileValue = parseFloat(env.MILE_VALUE_CENTS || '1.5');
  const cardById = new Map((cards ?? []).map((c) => [c.id, c]));

  const ruleFor = (cardId: number, category: string | null) => {
    const mine = (rules ?? []).filter((r) => r.card_id === cardId);
    return mine.find((r) => r.category === category) ?? mine.find((r) => r.category === '*') ?? null;
  };
  const valueOf = (rule: EarnRule | null, cents: number) => {
    if (!rule) return { miles: 0, cash: 0, value: 0 };
    if (rule.reward_type === 'cashback') {
      const cash = Math.round(cents * (rule.mpd / 100));
      return { miles: 0, cash, value: cash };
    }
    const miles = Math.round((cents / 100) * rule.mpd);
    return { miles, cash: 0, value: miles * mileValue };
  };

  const { results: pairs } = await env.DB.prepare(
    `SELECT card_id, COALESCE(category, '*') AS category, SUM(amount_cents) AS cents FROM transactions
     WHERE amount_cents > 0 AND ${EFFECTIVE_DATE} >= ? AND ${EFFECTIVE_DATE} <= ?
     GROUP BY card_id, category`
  )
    .bind(win.start, win.end)
    .all<{ card_id: number; category: string; cents: number }>();

  let miles = 0;
  let cashback = 0;
  let value = 0;
  const perCard = new Map<string, { label: string; miles: number; cashback_cents: number; value_cents: number }>();
  const missed: Analytics['missed'] = [];

  for (const p of pairs ?? []) {
    const card = cardById.get(p.card_id);
    if (!card) continue;
    const used = ruleFor(p.card_id, p.category === '*' ? null : p.category);
    const got = valueOf(used, p.cents);
    miles += got.miles;
    cashback += got.cash;
    value += got.value;

    const row = perCard.get(card.product) ?? { label: card.product, miles: 0, cashback_cents: 0, value_cents: 0 };
    row.miles += got.miles;
    row.cashback_cents += got.cash;
    row.value_cents += got.value;
    perCard.set(card.product, row);

    // Would an open card have done better on this category? This is the whole
    // point of tracking: spend on the wrong card is silent, recoverable loss.
    let best: { card: Card; rule: EarnRule; value: number } | null = null;
    for (const c of (cards ?? []).filter((x) => !x.closed_at)) {
      const r = ruleFor(c.id, p.category === '*' ? null : p.category);
      if (!r) continue;
      const v = valueOf(r, p.cents).value;
      if (!best || v > best.value) best = { card: c, rule: r, value: v };
    }
    if (best && best.card.id !== p.card_id && best.value > got.value) {
      missed.push({
        category: p.category === '*' ? 'uncategorised' : p.category,
        cents: p.cents,
        used_label: card.product,
        used_rate: used?.mpd ?? 0,
        used_type: used?.reward_type ?? 'miles',
        best_label: best.card.product,
        best_rate: best.rule.mpd,
        best_type: best.rule.reward_type,
        lost_value_cents: Math.round(best.value - got.value),
      });
    }
  }
  missed.sort((a, b) => b.lost_value_cents - a.lost_value_cents);

  // --- plain-language read of the month ------------------------------------
  const insights: string[] = [];
  const delta = cur.cents - prev.cents;
  if (prev.cents > 0) {
    const pct = Math.round((Math.abs(delta) / prev.cents) * 100);
    insights.push(
      delta >= 0
        ? `Spending is $${money(delta)} (${pct}%) higher than ${prevMonth}.`
        : `Spending is $${money(-delta)} (${pct}%) lower than ${prevMonth}.`
    );
  }
  if (by_category.length) {
    const top = by_category[0];
    const share = cur.cents > 0 ? Math.round((top.cents / cur.cents) * 100) : 0;
    insights.push(`${top.label} is the largest category at $${money(top.cents)} — ${share}% of the month.`);
  }
  if (merchants?.length) {
    insights.push(`Most spent at ${merchants[0].merchant}: $${money(merchants[0].cents)} across ${merchants[0].n} visit(s).`);
  }
  const busiest = [...by_weekday].sort((a, b) => b.cents - a.cents)[0];
  if (busiest && busiest.cents > 0) insights.push(`${busiest.label} is the heaviest day of the week.`);
  if (dayOfMonth && cur.cents > 0) {
    const pace = Math.round((cur.cents / dayOfMonth) * daysInMonth);
    insights.push(`At this pace the month lands near $${money(pace)}.`);
  }
  const lost = missed.reduce((s, m) => s + m.lost_value_cents, 0);
  if (lost > 0) {
    insights.push(`About $${money(lost)} of value went to the wrong card this month.`);
  }
  const uncat = by_category.find((c) => c.key === 'uncategorised');
  if (uncat && cur.cents > 0 && uncat.cents / cur.cents > 0.3) {
    insights.push(`${Math.round((uncat.cents / cur.cents) * 100)}% of spend is uncategorised, so rewards here are understated.`);
  }

  return {
    month,
    prev_month: prevMonth,
    days_in_month: daysInMonth,
    day_of_month: dayOfMonth,
    totals: {
      spend_cents: cur.cents,
      prev_spend_cents: prev.cents,
      txn_count: cur.n,
      avg_txn_cents: cur.n ? Math.round(cur.cents / cur.n) : 0,
      active_days: cur.days,
      largest_cents: cur.largest,
    },
    daily,
    cumulative,
    by_category,
    by_card,
    by_weekday,
    top_merchants: (merchants ?? []).map((m) => ({
      merchant: m.merchant,
      category: m.category,
      cents: m.cents,
      count: m.n,
    })),
    rewards: {
      miles,
      cashback_cents: cashback,
      value_cents: Math.round(value),
      per_dollar_cents: cur.cents > 0 ? (value / cur.cents) * 100 : 0,
      by_card: [...perCard.values()].sort((a, b) => b.value_cents - a.value_cents),
    },
    missed,
    insights,
  };
}
