import { EFFECTIVE_DATE, today } from './spend';
import type { Env } from './types';

const money = (c: number) => (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export interface Recurring {
  merchant: string;
  category: string | null;
  occurrences: number;
  typical_cents: number;
  cadence_days: number;
  last_seen: string;
  next_expected: string;
  annualised_cents: number;
  /** True when it has not appeared in well over its usual gap. */
  lapsed: boolean;
}

/**
 * Subscriptions you forgot about are the classic spending leak, and they show
 * up as the same merchant at a steady interval for a similar amount. Detected
 * rather than declared, because nobody maintains a list of their own
 * subscriptions honestly.
 */
export async function findRecurring(env: Env, months = 6): Promise<Recurring[]> {
  const now = today(env);
  const since = new Date(Date.parse(now + 'T00:00:00Z') - months * 30 * 86400_000).toISOString().slice(0, 10);

  const { results } = await env.DB.prepare(
    // No aggregate here: a bare MAX() without GROUP BY collapses the whole
    // result to a single row in SQLite, and the scan below needs every one.
    `SELECT LOWER(TRIM(merchant)) AS m, category, ${EFFECTIVE_DATE} AS d, amount_cents
     FROM transactions
     WHERE amount_cents > 0 AND merchant IS NOT NULL AND TRIM(merchant) <> ''
       AND ${EFFECTIVE_DATE} >= ?
     ORDER BY m, d`
  )
    .bind(since)
    .all<{ m: string; category: string | null; d: string; amount_cents: number }>();

  const byMerchant = new Map<string, { category: string | null; dates: string[]; amounts: number[] }>();
  for (const r of results ?? []) {
    const e = byMerchant.get(r.m) ?? { category: r.category, dates: [], amounts: [] };
    e.dates.push(r.d);
    e.amounts.push(r.amount_cents);
    byMerchant.set(r.m, e);
  }

  const out: Recurring[] = [];
  for (const [merchant, e] of byMerchant) {
    if (e.dates.length < 3) continue; // two points are a coincidence

    const gaps: number[] = [];
    for (let i = 1; i < e.dates.length; i++) {
      gaps.push(Math.round((Date.parse(e.dates[i]) - Date.parse(e.dates[i - 1])) / 86400_000));
    }
    const meanGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    if (meanGap < 5 || meanGap > 400) continue; // too frequent to be a subscription, or too sparse

    // Regular means the gaps agree with each other, not just that they exist.
    const gapSpread = Math.sqrt(gaps.reduce((s, g) => s + (g - meanGap) ** 2, 0) / gaps.length);
    if (gapSpread > Math.max(4, meanGap * 0.35)) continue;

    // And the amount barely moves — a price rise is still a subscription, a
    // wildly varying amount at the same shop is just a shop you like.
    const meanAmt = e.amounts.reduce((a, b) => a + b, 0) / e.amounts.length;
    const amtSpread = Math.sqrt(e.amounts.reduce((s, a) => s + (a - meanAmt) ** 2, 0) / e.amounts.length);
    if (meanAmt > 0 && amtSpread / meanAmt > 0.2) continue;

    const last = e.dates[e.dates.length - 1];
    const sinceLast = Math.round((Date.parse(now) - Date.parse(last)) / 86400_000);
    const next = new Date(Date.parse(last) + Math.round(meanGap) * 86400_000).toISOString().slice(0, 10);

    out.push({
      merchant,
      category: e.category,
      occurrences: e.dates.length,
      typical_cents: Math.round(meanAmt),
      cadence_days: Math.round(meanGap),
      last_seen: last,
      next_expected: next,
      annualised_cents: Math.round((meanAmt * 365) / meanGap),
      lapsed: sinceLast > meanGap * 1.8,
    });
  }

  return out.sort((a, b) => b.annualised_cents - a.annualised_cents);
}

export interface CategoryTrend {
  category: string;
  this_month_cents: number;
  baseline_cents: number;
  delta_cents: number;
  delta_pct: number | null;
  /** Deviation from the baseline in standard deviations. */
  z: number | null;
  verdict: 'spike' | 'dip' | 'steady' | 'new';
  months_of_history: number;
}

/**
 * Compares this month against each category's own recent baseline, rather than
 * against last month alone — one unusual previous month otherwise reads as a
 * trend. A category is only called a spike when it clears both a meaningful
 * absolute change and its own historical variability.
 */
export async function categoryTrends(env: Env, month: string, lookback = 5): Promise<CategoryTrend[]> {
  const [y, m] = month.split('-').map(Number);
  const monthsBack: string[] = [];
  for (let i = 1; i <= lookback; i++) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    monthsBack.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }

  const { results } = await env.DB.prepare(
    `SELECT COALESCE(category, 'uncategorised') AS category,
            substr(${EFFECTIVE_DATE}, 1, 7) AS month,
            SUM(amount_cents) AS cents
     FROM transactions
     WHERE amount_cents > 0
     GROUP BY category, month`
  ).all<{ category: string; month: string; cents: number }>();

  const byCat = new Map<string, Map<string, number>>();
  for (const r of results ?? []) {
    const e = byCat.get(r.category) ?? new Map<string, number>();
    e.set(r.month, r.cents);
    byCat.set(r.category, e);
  }

  const out: CategoryTrend[] = [];
  for (const [category, months] of byCat) {
    const current = months.get(month) ?? 0;
    const history = monthsBack.map((mm) => months.get(mm)).filter((v): v is number => v !== undefined);
    if (current === 0 && !history.length) continue;

    if (!history.length) {
      out.push({
        category,
        this_month_cents: current,
        baseline_cents: 0,
        delta_cents: current,
        delta_pct: null,
        z: null,
        verdict: 'new',
        months_of_history: 0,
      });
      continue;
    }

    const mean = history.reduce((a, b) => a + b, 0) / history.length;
    const sd = Math.sqrt(history.reduce((s, v) => s + (v - mean) ** 2, 0) / history.length);
    const delta = current - mean;
    const z = sd > 0 ? delta / sd : null;

    // Both tests must agree: a 200% rise on $3 is noise, and a big number that
    // is normal for that category is not news either.
    const material = Math.abs(delta) >= 5000 && Math.abs(delta) / Math.max(mean, 1) >= 0.25;
    const unusual = z === null ? Math.abs(delta) / Math.max(mean, 1) >= 0.5 : Math.abs(z) >= 1.2;

    out.push({
      category,
      this_month_cents: current,
      baseline_cents: Math.round(mean),
      delta_cents: Math.round(delta),
      delta_pct: mean > 0 ? Math.round((delta / mean) * 100) : null,
      z: z === null ? null : Math.round(z * 10) / 10,
      verdict: material && unusual ? (delta > 0 ? 'spike' : 'dip') : 'steady',
      months_of_history: history.length,
    });
  }

  return out.sort((a, b) => Math.abs(b.delta_cents) - Math.abs(a.delta_cents));
}

export interface Duplicate {
  merchant: string;
  cents: number;
  dates: string[];
  ids: number[];
}

/** Same merchant, same amount, within a couple of days — a double charge, or a double entry. */
export async function findDuplicates(env: Env, month: string): Promise<Duplicate[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, LOWER(TRIM(COALESCE(merchant,''))) AS m, amount_cents, ${EFFECTIVE_DATE} AS d
     FROM transactions
     WHERE amount_cents > 0 AND substr(${EFFECTIVE_DATE}, 1, 7) = ? AND TRIM(COALESCE(merchant,'')) <> ''
     ORDER BY m, amount_cents, d`
  )
    .bind(month)
    .all<{ id: number; m: string; amount_cents: number; d: string }>();

  const out: Duplicate[] = [];
  const rows = results ?? [];
  let i = 0;
  while (i < rows.length) {
    const group = [rows[i]];
    let j = i + 1;
    while (
      j < rows.length &&
      rows[j].m === rows[i].m &&
      rows[j].amount_cents === rows[i].amount_cents &&
      Math.abs(Date.parse(rows[j].d) - Date.parse(group[group.length - 1].d)) <= 2 * 86400_000
    ) {
      group.push(rows[j]);
      j++;
    }
    if (group.length > 1) {
      out.push({
        merchant: group[0].m,
        cents: group[0].amount_cents,
        dates: group.map((g) => g.d),
        ids: group.map((g) => g.id),
      });
    }
    i = j > i + 1 ? j : i + 1;
  }
  return out;
}

export function recurringInsight(rows: Recurring[]): string | null {
  const live = rows.filter((r) => !r.lapsed);
  if (!live.length) return null;
  const annual = live.reduce((s, r) => s + r.annualised_cents, 0);
  return `${live.length} recurring charge(s) detected, worth about $${money(annual)} a year.`;
}
