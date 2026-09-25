/**
 * The forecasters, and the harness that decides which one to believe.
 *
 * All four are statistical and none has a trained parameter, which is the
 * point. `docs/intelligence-architecture.md` records why nothing here is a
 * learned model: Workers AI has no tabular or time-series model at all, and a
 * gradient-boosted model over 18 categories at weekly grain would have about
 * 52 rows per category after a year — fewer rows than it has hyperparameters
 * to overfit with.
 *
 * What makes this honest rather than lazy is the backtest. Every method is
 * scored on data it did not see, per dimension, and the one that wins is the
 * one used. If a learned model is ever added it has to win the same way, on
 * the same harness, against these.
 */

export type ModelKey = 'mean' | 'moving_average' | 'ewma' | 'seasonal_naive' | 'recurring_only';

export interface Series {
  /** Oldest first. One value per period, no gaps — callers fill zeros. */
  values: number[];
}

export interface Forecast {
  model: ModelKey;
  expected: number;
  lower: number;
  upper: number;
  /** Periods of history the forecast was made from. */
  observations: number;
}

/** Half-life in periods for the exponential weighting. Smaller reacts faster. */
export const EWMA_ALPHA = 0.35;
/** How many recent periods the moving average looks at. */
export const MA_WINDOW = 4;
/**
 * Interval width in residual standard deviations.
 *
 * 1.28 is the 80% two-sided normal quantile. Eighty rather than ninety-five
 * because a 95% interval on this much data is so wide it stops being
 * information — and the intervals are scored for coverage afterwards, so the
 * choice is checkable rather than decorative.
 */
export const INTERVAL_Z = 1.28;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Spread of the errors a method would have made on its own history. */
function residualSd(values: number[], predict: (history: number[]) => number): number {
  if (values.length < 3) return 0;
  const errors: number[] = [];
  for (let i = 2; i < values.length; i++) {
    errors.push(values[i] - predict(values.slice(0, i)));
  }
  if (!errors.length) return 0;
  const m = mean(errors);
  return Math.sqrt(mean(errors.map((e) => (e - m) ** 2)));
}

const POINT: Record<ModelKey, (h: number[]) => number> = {
  mean: (h) => mean(h),
  moving_average: (h) => mean(h.slice(-MA_WINDOW)),
  ewma: (h) => {
    if (!h.length) return 0;
    let acc = h[0];
    for (let i = 1; i < h.length; i++) acc = EWMA_ALPHA * h[i] + (1 - EWMA_ALPHA) * acc;
    return acc;
  },
  // Same period one cycle ago — four weeks back for weekly data. Only
  // meaningful with more than a cycle of history.
  seasonal_naive: (h) => (h.length >= 5 ? h[h.length - 4] : mean(h.slice(-MA_WINDOW))),
  recurring_only: () => 0,
};

export function forecastWith(model: ModelKey, series: Series): Forecast {
  const values = series.values;
  const expected = Math.max(0, POINT[model](values));
  const sd = residualSd(values, POINT[model]);
  const half = sd * INTERVAL_Z;

  return {
    model,
    expected: Math.round(expected),
    // Spending cannot be negative, so the lower bound is clamped rather than
    // allowed to imply money coming back.
    lower: Math.max(0, Math.round(expected - half)),
    upper: Math.round(expected + half),
    observations: values.length,
  };
}

export interface BacktestResult {
  model: ModelKey;
  mae: number;
  /** Mean absolute percentage error, only over periods with real spend. */
  mape: number | null;
  /** Positive means the method forecasts too high. */
  bias: number;
  /** Fraction of actuals that fell inside the interval. Nominal is 0.8. */
  coverage: number;
  folds: number;
}

/**
 * Rolling-origin backtest.
 *
 * Forward-chained on purpose: the model sees only history strictly earlier
 * than the period it predicts. Randomly splitting a time series lets a model
 * learn from its own future, which produces excellent scores and a useless
 * forecast — the brief is explicit about this and it is worth being explicit
 * about in the code too.
 */
export function backtest(series: Series, model: ModelKey, minHistory = 3): BacktestResult | null {
  const values = series.values;
  if (values.length < minHistory + 2) return null;

  const errors: number[] = [];
  const pctErrors: number[] = [];
  let covered = 0;
  let folds = 0;

  for (let cut = minHistory; cut < values.length; cut++) {
    const history = values.slice(0, cut);
    const actual = values[cut];
    const f = forecastWith(model, { values: history });

    errors.push(f.expected - actual);
    if (actual > 0) pctErrors.push(Math.abs(f.expected - actual) / actual);
    if (actual >= f.lower && actual <= f.upper) covered++;
    folds++;
  }

  if (!folds) return null;

  return {
    model,
    mae: Math.round(mean(errors.map(Math.abs))),
    mape: pctErrors.length ? Math.round(mean(pctErrors) * 1000) / 1000 : null,
    bias: Math.round(mean(errors)),
    coverage: Math.round((covered / folds) * 100) / 100,
    folds,
  };
}

export const CANDIDATES: ModelKey[] = ['mean', 'moving_average', 'ewma', 'seasonal_naive'];

export interface Selection {
  chosen: ModelKey;
  reason: string;
  results: BacktestResult[];
}

/**
 * Which method to believe for this particular series.
 *
 * Per dimension, not globally: subscriptions, groceries and travel behave
 * differently enough that one winner for all of them would be a compromise
 * nobody asked for.
 *
 * Ties break toward the simpler method. Two methods within a few percent are
 * not distinguishable on this much data, and the simpler one is easier to
 * explain and less likely to be fitting noise.
 */
export function selectModel(series: Series): Selection {
  const results: BacktestResult[] = [];
  for (const m of CANDIDATES) {
    const r = backtest(series, m);
    if (r) results.push(r);
  }

  if (!results.length) {
    return {
      chosen: 'mean',
      reason: 'not enough history to compare methods, so the simplest one is used',
      results: [],
    };
  }

  const sorted = [...results].sort((a, b) => a.mae - b.mae);
  const best = sorted[0];
  const simplestWithin = sorted.find(
    (r) => r.mae <= best.mae * 1.05 && CANDIDATES.indexOf(r.model) < CANDIDATES.indexOf(best.model)
  );
  const chosen = simplestWithin ?? best;

  return {
    chosen: chosen.model,
    reason:
      chosen === best
        ? `lowest error over ${best.folds} rolling folds (MAE ${best.mae})`
        : `within 5% of the best method's error and simpler (MAE ${chosen.mae} against ${best.mae})`,
    results: sorted,
  };
}
