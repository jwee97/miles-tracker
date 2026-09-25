import { today } from '../../spend';
import type { Env } from '../../types';

/**
 * How well the resolver is actually doing.
 *
 * Written now, while the answer is "deterministic rules only", precisely so
 * that the number a future model has to beat was recorded before anyone had a
 * model they wanted to like. A baseline measured after the fact is not a
 * baseline, it is a justification.
 *
 * The metric that matters most is not accuracy. It is **correction rate**: how
 * often a person had to go back and change something the app decided on its
 * own. Coverage can always be bought by guessing more; corrections are what
 * guessing costs.
 */

export interface MerchantMetrics {
  window_days: number;
  resolutions: number;
  /** Resolved without asking. */
  auto_resolved: number;
  coverage: number;
  /** Sent to review. */
  abstained: number;
  abstention_rate: number;
  /** Auto-resolved, then corrected by a person afterwards. The expensive kind. */
  corrections: number;
  correction_rate: number;
  /** Of the high-confidence auto-resolutions, how many survived. */
  high_confidence: number;
  high_confidence_precision: number | null;
  /** Questions not asked because every candidate paid the same. */
  spared_by_reward_impact: number;
  by_source: { source: string; n: number; corrections: number }[];
  as_of: string;
  note: string;
}

export async function merchantMetrics(env: Env, windowDays = 90): Promise<MerchantMetrics> {
  const since = new Date(Date.now() - windowDays * 86400000).toISOString().slice(0, 10);

  const rows = await env.DB.prepare(
    `SELECT p.id, p.transaction_id, p.predicted_mcc, p.confidence, p.prediction_source,
            p.needs_review, p.reward_spread_cents, t.mcc AS actual_mcc
       FROM merchant_predictions p
       LEFT JOIN transactions t ON t.id = p.transaction_id
      WHERE p.predicted_at >= ?`
  )
    .bind(since)
    .all<any>();

  const list = rows.results ?? [];
  const high = Number(env.MCC_HIGH_CONFIDENCE ?? 0.85);

  let auto = 0;
  let abstained = 0;
  let corrections = 0;
  let highN = 0;
  let highRight = 0;
  let spared = 0;
  const bySource = new Map<string, { source: string; n: number; corrections: number }>();

  for (const r of list) {
    const asked = !!r.needs_review;
    if (asked) abstained++;
    else auto++;

    // A correction is only meaningful where the app committed to an answer and
    // the ledger now disagrees with it. A transaction with no MCC yet is not a
    // correction, it is an unanswered question.
    const corrected = !asked && !!r.predicted_mcc && !!r.actual_mcc && r.actual_mcc !== r.predicted_mcc;
    if (corrected) corrections++;

    if (!asked && Number(r.confidence ?? 0) >= high && r.actual_mcc) {
      highN++;
      if (r.actual_mcc === r.predicted_mcc) highRight++;
    }

    // Uncertainty that changed nothing. The spread being zero is why no
    // question was asked, and counting it is the only way to show the feature
    // is earning its place.
    if (!asked && r.reward_spread_cents === 0) spared++;

    const key = String(r.prediction_source ?? 'none');
    const cur = bySource.get(key) ?? { source: key, n: 0, corrections: 0 };
    cur.n++;
    if (corrected) cur.corrections++;
    bySource.set(key, cur);
  }

  const total = list.length;
  const ratio = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 1000 : 0);

  return {
    window_days: windowDays,
    resolutions: total,
    auto_resolved: auto,
    coverage: ratio(auto, total),
    abstained,
    abstention_rate: ratio(abstained, total),
    corrections,
    correction_rate: ratio(corrections, auto),
    high_confidence: highN,
    high_confidence_precision: highN ? Math.round((highRight / highN) * 1000) / 1000 : null,
    spared_by_reward_impact: spared,
    by_source: [...bySource.values()].sort((a, b) => b.n - a.n),
    as_of: today(env),
    note: total
      ? 'Correction rate is the number that matters: coverage can always be raised by guessing more.'
      : 'No resolutions recorded in this window yet, so there is nothing to measure. This is the baseline any future model has to beat.',
  };
}
