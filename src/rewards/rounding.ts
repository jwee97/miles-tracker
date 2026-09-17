/**
 * How a bank turns spend into points.
 *
 * Nobody pays 4 miles per dollar on $17.40 and credits 69.6 miles. They round,
 * and they round differently: per transaction, per S$5 block, on the statement
 * total. Get this wrong and every reconciliation reports a shortfall that is
 * really arithmetic — which trains people to ignore the ones that are real.
 */

export type RoundingMode =
  | 'floor_per_transaction'
  | 'nearest_per_transaction'
  | 'floor_per_statement'
  | 'nearest_per_statement'
  | 'exact';

export interface RewardRounding {
  /** Spend is counted in blocks of this many cents before the rate applies. */
  unit_cents?: number;
  mode: RoundingMode;
}

/** What the app assumes when a card's terms do not say. */
export const DEFAULT_ROUNDING: RewardRounding = { mode: 'exact' };

export function parseRounding(json: string | null | undefined): RewardRounding {
  if (!json) return DEFAULT_ROUNDING;
  try {
    const v = JSON.parse(json);
    if (!v || typeof v.mode !== 'string') return DEFAULT_ROUNDING;
    return { unit_cents: typeof v.unit_cents === 'number' ? v.unit_cents : undefined, mode: v.mode };
  } catch {
    return DEFAULT_ROUNDING;
  }
}

/** True when the rounding happens once over the whole statement, not per row. */
export const roundsPerStatement = (r: RewardRounding) =>
  r.mode === 'floor_per_statement' || r.mode === 'nearest_per_statement';

/**
 * The spend a rate is actually applied to.
 *
 * A card paying per S$5 block earns nothing on the last $3.40 of a $53.40
 * purchase — and that is not a discrepancy, it is the deal.
 */
export function qualifyingSpend(amountCents: number, r: RewardRounding): number {
  if (!r.unit_cents || r.unit_cents <= 1) return amountCents;
  return Math.floor(amountCents / r.unit_cents) * r.unit_cents;
}

/** Apply a bank's rounding to a reward amount. */
export function roundReward(amount: number, r: RewardRounding): number {
  switch (r.mode) {
    case 'floor_per_transaction':
    case 'floor_per_statement':
      return Math.floor(amount);
    case 'nearest_per_transaction':
    case 'nearest_per_statement':
      return Math.round(amount);
    default:
      return amount;
  }
}

/**
 * How far apart two totals may be before it is worth mentioning.
 *
 * Banks round, and a statement of forty transactions can drift by forty times
 * whatever the rounding unit is without anything being wrong. So the tolerance
 * grows with the number of rows it could have come from.
 */
export interface RewardTolerance {
  absolute?: number;
  percentage?: number;
  /** Rounding can cost up to one unit per transaction; this says how many. */
  per_transaction?: number;
}

export const DEFAULT_TOLERANCE: RewardTolerance = { absolute: 1, percentage: 0.5 };

export function toleranceFor(
  expected: number,
  t: RewardTolerance = DEFAULT_TOLERANCE,
  transactions = 0
): number {
  const abs = t.absolute ?? 0;
  const pct = ((t.percentage ?? 0) / 100) * Math.abs(expected);
  const perTx = (t.per_transaction ?? 0) * transactions;
  return Math.max(abs, pct, perTx);
}

export const withinTolerance = (
  expected: number,
  actual: number,
  t?: RewardTolerance,
  transactions = 0
): boolean => Math.abs(actual - expected) <= toleranceFor(expected, t, transactions);
