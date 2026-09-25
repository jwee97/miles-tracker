import { today } from '../../spend';
import type { Env } from '../../types';
import { backtest, forecastWith, selectModel, type ModelKey, type Selection } from './baselines';
import { recurringDue } from './recurring';

/**
 * Forecasts, with the honesty about their own limits built in.
 *
 * Two things this refuses to do.
 *
 * It will not forecast from history it does not have. A month of data cannot
 * support a category forecast, and producing one anyway — with an interval
 * that looks as authoritative as any other — is worse than saying so. The
 * cold-start ladder below is the explicit version of that refusal.
 *
 * And it will not present a point estimate alone. "$432" reads as a fact;
 * "$340–$530, expected $430" reads as what it is. Intervals come from the
 * method's own residuals and are scored for coverage afterwards, so the claim
 * is checkable.
 */

export type Confidence = 'none' | 'low' | 'medium' | 'high';

export interface ColdStart {
  months_of_history: number;
  confidence: Confidence;
  /** Null when there is not enough history to forecast at all. */
  method: 'none' | 'recent_spend' | 'category_baseline' | 'full';
  note: string;
}

/**
 * How much history buys how much forecast.
 *
 * The thresholds are stated rather than emergent so they can be argued with.
 * Under a month there is nothing to say; a sophisticated method on six weeks
 * of data is still a guess wearing a suit.
 */
export function coldStart(monthsOfHistory: number): ColdStart {
  if (monthsOfHistory < 1) {
    return {
      months_of_history: monthsOfHistory,
      confidence: 'none',
      method: 'none',
      note: 'Less than a month of history. Nothing here is worth forecasting from yet.',
    };
  }
  if (monthsOfHistory < 3) {
    return {
      months_of_history: monthsOfHistory,
      confidence: 'low',
      method: 'recent_spend',
      note: 'Only a few weeks of history, so this is recent spending projected forward rather than a forecast.',
    };
  }
  if (monthsOfHistory < 6) {
    return {
      months_of_history: monthsOfHistory,
      confidence: 'medium',
      method: 'category_baseline',
      note: 'A few months of history. Enough for a category pattern, not enough for seasonality.',
    };
  }
  return {
    months_of_history: monthsOfHistory,
    confidence: 'high',
    method: 'full',
    note: 'Six months or more of history, compared across methods by rolling backtest.',
  };
}

export interface ForecastResult {
  dimension_type: 'category' | 'card' | 'total';
  dimension_key: string;
  period_start: string;
  period_end: string;
  expected_cents: number;
  lower_cents: number;
  upper_cents: number;
  /** Of the expected figure, the part that is already-known recurring spend. */
  recurring_cents: number;
  model: ModelKey;
  model_reason: string;
  confidence: Confidence;
  observations: number;
  /** In the person's own terms, why this number. */
  explanation: string;
  backtest: Selection['results'];
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: string, n: number) => iso(new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000));

/** Weekly buckets of spend in one category, oldest first, gaps filled with zero. */
async function weeklySeries(
  env: Env,
  opts: { category?: string; cardId?: number; weeks: number; until: string }
): Promise<number[]> {
  const start = addDays(opts.until, -opts.weeks * 7);
  const wheres = [`amount_cents > 0`, `COALESCE(posted_at, occurred_at) >= ?`, `COALESCE(posted_at, occurred_at) < ?`];
  const args: unknown[] = [start, opts.until];
  if (opts.category) {
    wheres.push(`category = ?`);
    args.push(opts.category);
  }
  if (opts.cardId) {
    wheres.push(`card_id = ?`);
    args.push(opts.cardId);
  }

  const { results } = await env.DB.prepare(
    `SELECT COALESCE(posted_at, occurred_at) AS d, SUM(amount_cents) AS total
       FROM transactions WHERE ${wheres.join(' AND ')} GROUP BY d`
  )
    .bind(...args)
    .all<{ d: string; total: number }>();

  const buckets = new Array(opts.weeks).fill(0);
  for (const row of results ?? []) {
    const offset = Math.floor((Date.parse(row.d) - Date.parse(start)) / (7 * 86_400_000));
    if (offset >= 0 && offset < opts.weeks) buckets[offset] += row.total;
  }
  return buckets;
}

async function monthsOfHistory(env: Env, now: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT MIN(COALESCE(posted_at, occurred_at)) AS first FROM transactions WHERE amount_cents > 0`
  ).first<{ first: string | null }>();
  if (!row?.first) return 0;
  return Math.max(0, (Date.parse(now) - Date.parse(row.first)) / (30.4 * 86_400_000));
}

/**
 * Forecast one dimension over a window.
 *
 * Recurring spend is added back at the end rather than being averaged in:
 * the variable part gets an interval because it is uncertain, and the
 * subscription due on the 14th does not.
 */
export async function forecastDimension(
  env: Env,
  opts: {
    dimension_type: 'category' | 'card' | 'total';
    dimension_key: string;
    period_start: string;
    period_end: string;
    weeks?: number;
  }
): Promise<ForecastResult | null> {
  const now = today(env);
  const history = await monthsOfHistory(env, now);
  const cold = coldStart(history);
  if (cold.method === 'none') return null;

  const weeks = opts.weeks ?? (cold.method === 'recent_spend' ? 4 : cold.method === 'category_baseline' ? 12 : 26);
  const series = await weeklySeries(env, {
    category: opts.dimension_type === 'category' ? opts.dimension_key : undefined,
    cardId: opts.dimension_type === 'card' ? Number(opts.dimension_key) : undefined,
    weeks,
    until: opts.period_start,
  });

  const nonZero = series.filter((v) => v > 0).length;
  if (nonZero === 0) return null;

  // With little history there is nothing to select between, so the simplest
  // method is used rather than pretending a comparison happened.
  const selection: Selection =
    cold.method === 'recent_spend'
      ? { chosen: 'moving_average', reason: 'too little history to compare methods', results: [] }
      : selectModel({ values: series });

  const periodDays = Math.max(1, Math.round((Date.parse(opts.period_end) - Date.parse(opts.period_start)) / 86_400_000));
  const weeksInPeriod = periodDays / 7;

  const weekly = forecastWith(selection.chosen, { values: series });
  const recurring = await recurringDue(env, opts.period_start, opts.period_end);
  const recurringForDimension =
    opts.dimension_type === 'category' ? (recurring.by_category[opts.dimension_key] ?? 0) : recurring.total_cents;

  const expected = Math.round(weekly.expected * weeksInPeriod);
  const lower = Math.round(weekly.lower * weeksInPeriod);
  const upper = Math.round(weekly.upper * weeksInPeriod);

  const perWeek = Math.round(weekly.expected / 100);
  const explanation =
    `Over the last ${nonZero} week${nonZero === 1 ? '' : 's'} with spending you averaged about $${perWeek} a week ` +
    `${opts.dimension_type === 'category' ? `on ${opts.dimension_key}` : 'here'}, and there ` +
    `${periodDays === 1 ? 'is 1 day' : `are ${periodDays} days`} in this window.` +
    (recurringForDimension > 0
      ? ` $${Math.round(recurringForDimension / 100)} of that is spending already known to repeat.`
      : '');

  return {
    dimension_type: opts.dimension_type,
    dimension_key: opts.dimension_key,
    period_start: opts.period_start,
    period_end: opts.period_end,
    expected_cents: expected,
    lower_cents: lower,
    upper_cents: upper,
    recurring_cents: recurringForDimension,
    model: selection.chosen,
    model_reason: selection.reason,
    confidence: cold.confidence,
    observations: nonZero,
    explanation,
    backtest: selection.results,
  };
}

/** Write a forecast down so it can be scored when the period closes. */
export async function storeForecast(env: Env, f: ForecastResult): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO spend_forecasts
       (generated_at, period_start, period_end, dimension_type, dimension_key, expected_cents, lower_cents,
        upper_cents, recurring_cents, model_key, model_version, training_window_start, training_window_end,
        observations, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
     ON CONFLICT(period_start, period_end, dimension_type, dimension_key, model_key) DO UPDATE SET
       generated_at = excluded.generated_at,
       expected_cents = excluded.expected_cents,
       lower_cents = excluded.lower_cents,
       upper_cents = excluded.upper_cents,
       recurring_cents = excluded.recurring_cents,
       observations = excluded.observations,
       confidence = excluded.confidence`
  )
    .bind(
      today(env),
      f.period_start,
      f.period_end,
      f.dimension_type,
      f.dimension_key,
      f.expected_cents,
      f.lower_cents,
      f.upper_cents,
      f.recurring_cents,
      f.model,
      f.period_start,
      f.period_end,
      f.observations,
      f.confidence
    )
    .run();
}

export interface EvaluationSummary {
  evaluated: number;
  mae_cents: number;
  bias_cents: number;
  coverage: number;
  by_model: { model: string; mae_cents: number; coverage: number; n: number }[];
  as_of: string;
}

/**
 * Score every finished forecast against what actually happened.
 *
 * This is what makes "is the model any good" a question with an answer. It
 * runs after periods close, never before — a forecast for a window still open
 * has nothing to be compared against.
 */
export async function evaluateFinishedForecasts(env: Env): Promise<EvaluationSummary> {
  const now = today(env);

  const { results } = await env.DB.prepare(
    `SELECT f.* FROM spend_forecasts f
      LEFT JOIN forecast_evaluations e ON e.forecast_id = f.id
     WHERE f.period_end < ? AND e.id IS NULL`
  )
    .bind(now)
    .all<{
      id: number;
      period_start: string;
      period_end: string;
      dimension_type: string;
      dimension_key: string;
      expected_cents: number;
      lower_cents: number;
      upper_cents: number;
      model_key: string;
    }>();

  for (const f of results ?? []) {
    const wheres = [`amount_cents > 0`, `COALESCE(posted_at, occurred_at) >= ?`, `COALESCE(posted_at, occurred_at) <= ?`];
    const args: unknown[] = [f.period_start, f.period_end];
    if (f.dimension_type === 'category') {
      wheres.push(`category = ?`);
      args.push(f.dimension_key);
    } else if (f.dimension_type === 'card') {
      wheres.push(`card_id = ?`);
      args.push(Number(f.dimension_key));
    }

    const row = await env.DB.prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS actual FROM transactions WHERE ${wheres.join(' AND ')}`
    )
      .bind(...args)
      .first<{ actual: number }>();

    const actual = row?.actual ?? 0;
    const error = f.expected_cents - actual;

    await env.DB.prepare(
      `INSERT OR IGNORE INTO forecast_evaluations
         (forecast_id, evaluated_at, actual_cents, error_cents, abs_error_cents, pct_error, within_interval)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        f.id,
        now,
        actual,
        error,
        Math.abs(error),
        actual > 0 ? Math.round((Math.abs(error) / actual) * 1000) / 1000 : null,
        actual >= f.lower_cents && actual <= f.upper_cents ? 1 : 0
      )
      .run();
  }

  const summary = await env.DB.prepare(
    `SELECT COUNT(*) AS n, AVG(abs_error_cents) AS mae, AVG(error_cents) AS bias, AVG(within_interval) AS coverage
       FROM forecast_evaluations`
  ).first<{ n: number; mae: number | null; bias: number | null; coverage: number | null }>();

  const { results: byModel } = await env.DB.prepare(
    `SELECT f.model_key AS model, AVG(e.abs_error_cents) AS mae, AVG(e.within_interval) AS coverage, COUNT(*) AS n
       FROM forecast_evaluations e JOIN spend_forecasts f ON f.id = e.forecast_id
      GROUP BY f.model_key ORDER BY mae`
  ).all<{ model: string; mae: number; coverage: number; n: number }>();

  return {
    evaluated: summary?.n ?? 0,
    mae_cents: Math.round(summary?.mae ?? 0),
    bias_cents: Math.round(summary?.bias ?? 0),
    coverage: Math.round((summary?.coverage ?? 0) * 100) / 100,
    by_model: (byModel ?? []).map((m) => ({
      model: m.model,
      mae_cents: Math.round(m.mae),
      coverage: Math.round(m.coverage * 100) / 100,
      n: m.n,
    })),
    as_of: now,
  };
}

export interface PeriodOutlook {
  period_start: string;
  period_end: string;
  cold_start: ColdStart;
  total: ForecastResult | null;
  categories: ForecastResult[];
  recurring_cents: number;
  as_of: string;
}

/**
 * The whole window at once: the total, and the categories worth naming.
 *
 * Categories with no history are left out rather than shown as $0 — an empty
 * row reads as "you spend nothing here", which is a claim, where absence is
 * only an absence.
 */
export async function periodOutlook(
  env: Env,
  period: { start: string; end: string }
): Promise<PeriodOutlook> {
  const now = today(env);
  const cold = coldStart(await monthsOfHistory(env, now));

  const base: PeriodOutlook = {
    period_start: period.start,
    period_end: period.end,
    cold_start: cold,
    total: null,
    categories: [],
    recurring_cents: 0,
    as_of: now,
  };
  if (cold.method === 'none') return base;

  base.total = await forecastDimension(env, {
    dimension_type: 'total',
    dimension_key: 'all',
    period_start: period.start,
    period_end: period.end,
  });

  const { results } = await env.DB.prepare(
    `SELECT category, COUNT(*) AS n FROM transactions
      WHERE category IS NOT NULL AND amount_cents > 0
      GROUP BY category ORDER BY SUM(amount_cents) DESC LIMIT 8`
  ).all<{ category: string; n: number }>();

  for (const row of results ?? []) {
    const f = await forecastDimension(env, {
      dimension_type: 'category',
      dimension_key: row.category,
      period_start: period.start,
      period_end: period.end,
    });
    if (f) base.categories.push(f);
  }

  const recurring = await recurringDue(env, period.start, period.end);
  base.recurring_cents = recurring.total_cents;
  return base;
}
