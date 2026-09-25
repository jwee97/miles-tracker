import { today } from '../../spend';
import type { Env } from '../../types';

/**
 * Spending that repeats, found before anything is forecast.
 *
 * A subscription is not a prediction problem. It is a known amount on a known
 * date, and the reason to separate it out is that mixing it into an average
 * makes both halves worse: the average is inflated by a payment that was never
 * uncertain, and the genuinely variable spending is hidden underneath it.
 *
 * Separating them also fixes the interval. A forecast that says "$430, likely
 * $340–$530" when $200 of it is a rent standing order is understating what it
 * knows; the uncertainty belongs only to the part that is actually uncertain.
 */

export type Frequency = 'weekly' | 'fortnightly' | 'monthly' | 'quarterly' | 'annual';

/** Days between payments, and how far a real interval may drift and still match. */
export const CADENCE: Record<Frequency, { days: number; tolerance: number }> = {
  weekly: { days: 7, tolerance: 2 },
  fortnightly: { days: 14, tolerance: 3 },
  monthly: { days: 30.4, tolerance: 6 },
  quarterly: { days: 91.3, tolerance: 12 },
  annual: { days: 365, tolerance: 25 },
};

export interface Observation {
  occurred_at: string;
  amount_cents: number;
}

export interface DetectedPattern {
  frequency: Frequency;
  expected_amount_cents: number;
  amount_variance_cents: number;
  interval_days: number;
  next_expected_date: string;
  confidence: number;
  observations: number;
}

const days = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

/** How far apart a run of payments is, and how consistently. */
function intervals(obs: Observation[]): number[] {
  const sorted = [...obs].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  const out: number[] = [];
  for (let i = 1; i < sorted.length; i++) out.push(days(sorted[i].occurred_at, sorted[i - 1].occurred_at));
  return out.filter((d) => d > 0);
}

/**
 * Whether a run of payments to one merchant repeats.
 *
 * Three observations minimum: two payments define one interval, and one
 * interval is a coincidence. Amount is allowed to move — a utility bill is
 * recurring even though it differs monthly — but the variation is recorded so
 * the forecast can carry it rather than pretending the amount is fixed.
 */
export function detectPattern(obs: Observation[], now: string): DetectedPattern | null {
  if (obs.length < 3) return null;

  const gaps = intervals(obs);
  if (gaps.length < 2) return null;

  const typical = median(gaps);
  if (typical <= 0) return null;

  let best: { frequency: Frequency; error: number } | null = null;
  for (const [freq, c] of Object.entries(CADENCE) as [Frequency, { days: number; tolerance: number }][]) {
    const error = Math.abs(typical - c.days);
    if (error <= c.tolerance && (!best || error < best.error)) best = { frequency: freq, error };
  }
  if (!best) return null;

  // How regular the gaps are: a merchant visited "about monthly" by accident
  // has scattered intervals, a standing order does not.
  const cadence = CADENCE[best.frequency];
  const within = gaps.filter((g) => Math.abs(g - cadence.days) <= cadence.tolerance).length;
  const regularity = within / gaps.length;
  if (regularity < 0.6) return null;

  const amounts = obs.map((o) => o.amount_cents);
  const expected = median(amounts);
  const variance = Math.round(
    Math.sqrt(amounts.reduce((s, a) => s + (a - expected) ** 2, 0) / amounts.length)
  );

  const sorted = [...obs].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  const last = sorted[sorted.length - 1].occurred_at;
  const next = new Date(Date.parse(last) + Math.round(cadence.days) * 86_400_000).toISOString().slice(0, 10);

  // More observations and steadier gaps mean more confidence, capped below
  // certainty: a subscription can be cancelled without telling this app.
  const confidence = Math.min(0.95, regularity * (0.55 + Math.min(0.4, (obs.length - 3) * 0.08)));

  return {
    frequency: best.frequency,
    expected_amount_cents: expected,
    amount_variance_cents: variance,
    interval_days: typical,
    next_expected_date: next < now ? now : next,
    confidence: Math.round(confidence * 100) / 100,
  } as DetectedPattern & { observations: number };
}

export interface RecurringScan {
  detected: number;
  updated: number;
  retired: number;
  patterns: { merchant: string; frequency: Frequency; amount_cents: number; next: string; confidence: number }[];
  as_of: string;
}

/**
 * Re-derive every recurring pattern from the ledger.
 *
 * Idempotent and total rather than incremental: the whole point is that a
 * cancelled subscription should stop being predicted, and an incremental
 * updater tends to keep patterns alive long after they have stopped.
 */
export async function scanRecurring(env: Env, opts: { months?: number } = {}): Promise<RecurringScan> {
  const now = today(env);
  const months = opts.months ?? 12;
  const since = new Date(Date.parse(`${now}T00:00:00Z`) - months * 30.4 * 86_400_000).toISOString().slice(0, 10);

  const { results } = await env.DB.prepare(
    `SELECT COALESCE(m.canonical_name, t.merchant) AS merchant_key,
            t.merchant_id, t.card_id, t.category,
            COALESCE(t.posted_at, t.occurred_at) AS occurred_at,
            t.amount_cents
       FROM transactions t
       LEFT JOIN merchants m ON m.id = t.merchant_id
      WHERE t.amount_cents > 0
        AND COALESCE(t.posted_at, t.occurred_at) >= ?
        AND COALESCE(m.canonical_name, t.merchant) IS NOT NULL
      ORDER BY merchant_key, occurred_at`
  )
    .bind(since)
    .all<{
      merchant_key: string;
      merchant_id: number | null;
      card_id: number | null;
      category: string | null;
      occurred_at: string;
      amount_cents: number;
    }>();

  const groups = new Map<string, typeof results>();
  for (const row of results ?? []) {
    const key = `${row.merchant_key}|${row.card_id ?? 0}`;
    if (!groups.has(key)) groups.set(key, [] as never);
    groups.get(key)!.push(row);
  }

  const seen = new Set<string>();
  const patterns: RecurringScan['patterns'] = [];
  let detected = 0;
  let updated = 0;

  for (const rows of groups.values()) {
    const first = rows[0];
    const pattern = detectPattern(
      rows.map((r) => ({ occurred_at: r.occurred_at, amount_cents: r.amount_cents })),
      now
    );
    if (!pattern) continue;

    const existing = await env.DB.prepare(
      `SELECT id FROM recurring_patterns WHERE merchant_key = ? AND COALESCE(card_id,0) = COALESCE(?,0) AND frequency = ?`
    )
      .bind(first.merchant_key, first.card_id, pattern.frequency)
      .first<{ id: number }>();

    await env.DB.prepare(
      `INSERT INTO recurring_patterns
         (merchant_id, merchant_key, card_id, category, frequency, expected_amount_cents, amount_variance_cents,
          interval_days, next_expected_date, confidence, observations, first_observed_at, last_observed_at,
          active, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(merchant_key, card_id, frequency) DO UPDATE SET
         expected_amount_cents = excluded.expected_amount_cents,
         amount_variance_cents = excluded.amount_variance_cents,
         interval_days = excluded.interval_days,
         next_expected_date = excluded.next_expected_date,
         confidence = excluded.confidence,
         observations = excluded.observations,
         last_observed_at = excluded.last_observed_at,
         active = 1,
         updated_at = excluded.updated_at`
    )
      .bind(
        first.merchant_id,
        first.merchant_key,
        first.card_id,
        first.category,
        pattern.frequency,
        pattern.expected_amount_cents,
        pattern.amount_variance_cents,
        pattern.interval_days,
        pattern.next_expected_date,
        pattern.confidence,
        rows.length,
        rows[0].occurred_at,
        rows[rows.length - 1].occurred_at,
        now
      )
      .run();

    seen.add(`${first.merchant_key}|${first.card_id ?? 0}|${pattern.frequency}`);
    if (existing) updated++;
    else detected++;
    patterns.push({
      merchant: first.merchant_key,
      frequency: pattern.frequency,
      amount_cents: pattern.expected_amount_cents,
      next: pattern.next_expected_date,
      confidence: pattern.confidence,
    });
  }

  // A pattern whose payments stopped is retired rather than deleted: it may
  // resume, and the observation history is worth keeping either way.
  const stale = new Date(Date.parse(`${now}T00:00:00Z`) - 95 * 86_400_000).toISOString().slice(0, 10);
  const retired = await env.DB.prepare(
    `UPDATE recurring_patterns SET active = 0, updated_at = ?
      WHERE active = 1 AND COALESCE(last_observed_at, '0000') < ?`
  )
    .bind(now, stale)
    .run();

  return { detected, updated, retired: retired.meta?.changes ?? 0, patterns, as_of: now };
}

/** Recurring spend expected to land inside a window, by category. */
export async function recurringDue(
  env: Env,
  from: string,
  to: string
): Promise<{ total_cents: number; by_category: Record<string, number>; items: { merchant: string; amount_cents: number; date: string }[] }> {
  const { results } = await env.DB.prepare(
    `SELECT merchant_key, category, expected_amount_cents, next_expected_date, frequency, interval_days
       FROM recurring_patterns WHERE active = 1`
  ).all<{
    merchant_key: string;
    category: string | null;
    expected_amount_cents: number;
    next_expected_date: string | null;
    frequency: Frequency;
    interval_days: number | null;
  }>();

  const byCategory: Record<string, number> = {};
  const items: { merchant: string; amount_cents: number; date: string }[] = [];
  let total = 0;

  for (const r of results ?? []) {
    if (!r.next_expected_date) continue;
    const step = r.interval_days ?? CADENCE[r.frequency].days;

    // A weekly pattern lands several times in a month, so the window is walked
    // rather than checked once.
    let d = r.next_expected_date;
    let guard = 0;
    while (d <= to && guard++ < 60) {
      if (d >= from) {
        total += r.expected_amount_cents;
        const cat = r.category ?? 'uncategorised';
        byCategory[cat] = (byCategory[cat] ?? 0) + r.expected_amount_cents;
        items.push({ merchant: r.merchant_key, amount_cents: r.expected_amount_cents, date: d });
      }
      d = new Date(Date.parse(d) + Math.round(step) * 86_400_000).toISOString().slice(0, 10);
    }
  }

  return { total_cents: total, by_category: byCategory, items };
}
