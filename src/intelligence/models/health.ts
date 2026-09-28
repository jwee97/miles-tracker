import { today } from '../../spend';
import type { Env } from '../../types';
import { activeModel, listModels, retireModel, type ModelRecord } from './registry';

/**
 * How the live model is actually doing, as opposed to how it tested.
 *
 * Validation says what a model did on data it was trained beside. This says
 * what it has done since, on descriptors nobody had seen, with the thresholds
 * as deployed. The two routinely disagree, and only the second one costs
 * anybody anything.
 *
 * The number to watch is the **correction rate**: how often a person went back
 * and changed something the model resolved on its own. Coverage can always be
 * bought by abstaining less; corrections are what that costs. A model with 96%
 * validation precision and a 12% live correction rate is not a good model, it
 * is a model that was validated on the wrong distribution.
 */

export interface LatencyProfile {
  samples: number;
  p50_ms: number;
  p95_ms: number;
  max_ms: number;
  /** Of the total, the part spent waiting on D1 rather than computing. */
  p50_db_ms: number;
  p95_db_ms: number;
  /** Feature rows fetched, which is what the D1 cost is proportional to. */
  p50_rows: number;
  p95_rows: number;
  max_rows: number;
  max_ngrams: number;
}

export interface ModelHealth {
  model: { key: string; version: number; architecture: string; deployed_at: string | null } | null;
  training: {
    examples: number;
    classes: number;
    /** The rarest class the model is willing to name. */
    min_class_support: number | null;
    macro_f1: number | null;
    accuracy: number | null;
    high_confidence_precision: number | null;
    ece: number | null;
    brier: number | null;
  };
  live: {
    /** Times the model was consulted. */
    consulted: number;
    /** Times it declined to answer — the safety valve working. */
    abstained: number;
    abstention_rate: number;
    /** Resolved without asking anybody. */
    auto_resolved: number;
    /** Sent to review instead. */
    asked: number;
    /** Auto-resolutions a person later changed. */
    corrected: number;
    correction_rate: number;
    /** Of everything it resolved, how much had no other source. */
    useful_coverage: number;
    why_it_declined: { reason: string; n: number }[];
  };
  latency: LatencyProfile;
  status: 'healthy' | 'watch' | 'degraded' | 'unproven' | 'none';
  notes: string[];
  as_of: string;
}

/**
 * Above this live correction rate a model is doing harm.
 *
 * Deliberately far below the validation bar it had to clear. Validation
 * measured a model against data drawn from the same weeks it trained on; live
 * corrections measure it against whatever the world sends next, which is the
 * only measurement that decides whether a card recommendation was right.
 */
export const MAX_CORRECTION_RATE = 0.1;
/** Corrections are noisy at small numbers; below this, nothing is concluded. */
export const MIN_SAMPLES_TO_JUDGE = 40;

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 1000 : 0);

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

export async function modelHealth(env: Env, key = 'merchant_mcc', windowDays = 90): Promise<ModelHealth> {
  const now = today(env);
  const since = new Date(Date.parse(`${now}T00:00:00Z`) - windowDays * 86_400_000).toISOString().slice(0, 10);
  const model = await activeModel(env, key);

  const { results } = await env.DB.prepare(
    `SELECT confidence, needs_review, abstained, abstain_reason, corrected,
            inference_total_ms, inference_db_ms, inference_rows, inference_ngrams, prediction_source
       FROM merchant_predictions
      WHERE predicted_at >= ? AND (model_key = ? OR abstained = 1)`
  )
    .bind(since, key)
    .all<{
      confidence: number | null;
      needs_review: number;
      abstained: number;
      abstain_reason: string | null;
      corrected: number;
      inference_total_ms: number | null;
      inference_db_ms: number | null;
      inference_rows: number | null;
      inference_ngrams: number | null;
      prediction_source: string;
    }>();

  const rows = results ?? [];
  const abstained = rows.filter((r) => r.abstained).length;
  const answered = rows.filter((r) => !r.abstained);
  const autoResolved = answered.filter((r) => !r.needs_review).length;
  const asked = answered.filter((r) => r.needs_review).length;
  const corrected = answered.filter((r) => r.corrected).length;

  const reasons = new Map<string, number>();
  for (const r of rows) {
    if (!r.abstained || !r.abstain_reason) continue;
    // Bucketed: the percentage in "only 8% of the descriptor is known" varies
    // per descriptor and would otherwise make every reason unique.
    const bucket = r.abstain_reason.replace(/\d+%/g, 'n%');
    reasons.set(bucket, (reasons.get(bucket) ?? 0) + 1);
  }

  const totals = answered.map((r) => r.inference_total_ms ?? 0).filter((n) => n > 0).sort((a, b) => a - b);
  const dbs = answered.map((r) => r.inference_db_ms ?? 0).filter((n) => n >= 0).sort((a, b) => a - b);
  const rowCounts = answered.map((r) => r.inference_rows ?? 0).sort((a, b) => a - b);

  const latency: LatencyProfile = {
    samples: totals.length,
    p50_ms: percentile(totals, 50),
    p95_ms: percentile(totals, 95),
    max_ms: totals[totals.length - 1] ?? 0,
    p50_db_ms: percentile(dbs, 50),
    p95_db_ms: percentile(dbs, 95),
    p50_rows: percentile(rowCounts, 50),
    p95_rows: percentile(rowCounts, 95),
    max_rows: rowCounts[rowCounts.length - 1] ?? 0,
    max_ngrams: Math.max(0, ...answered.map((r) => r.inference_ngrams ?? 0)),
  };

  const metrics = (model?.validation_metrics ?? {}) as Record<string, any>;
  const perClass: { support: number }[] = Array.isArray(metrics.per_class) ? metrics.per_class : [];

  const correctionRate = pct(corrected, autoResolved);
  const notes: string[] = [];

  let status: ModelHealth['status'] = 'none';
  if (!model) {
    notes.push('No model is live. Codes come from evidence alone, and unknown merchants go to Review.');
  } else if (autoResolved < MIN_SAMPLES_TO_JUDGE) {
    status = 'unproven';
    notes.push(
      `Only ${autoResolved} auto-resolution${autoResolved === 1 ? '' : 's'} so far — too few to judge. ` +
        `Nothing is concluded below ${MIN_SAMPLES_TO_JUDGE}.`
    );
  } else if (correctionRate > MAX_CORRECTION_RATE) {
    status = 'degraded';
    notes.push(
      `${Math.round(correctionRate * 100)}% of what it resolved on its own was later corrected, above the ` +
        `${Math.round(MAX_CORRECTION_RATE * 100)}% limit. It is doing more harm than asking would.`
    );
  } else if (correctionRate > MAX_CORRECTION_RATE / 2) {
    status = 'watch';
    notes.push(`Correction rate is ${Math.round(correctionRate * 100)}%, climbing toward the limit.`);
  } else {
    status = 'healthy';
  }

  if (latency.p95_ms > 60) {
    notes.push(`Slow tail: 95% of inferences finish inside ${latency.p95_ms} ms, mostly waiting on the database.`);
  }
  if (typeof metrics.calibration?.ece === 'number' && metrics.calibration.ece > 0.1) {
    notes.push(`Probabilities are only roughly meaningful (ECE ${metrics.calibration.ece}): treat them as a ranking.`);
  }

  return {
    model: model
      ? { key: model.model_key, version: model.version, architecture: model.architecture, deployed_at: model.deployed_at }
      : null,
    training: {
      examples: model?.training_examples ?? 0,
      classes: typeof metrics.classes === 'number' ? metrics.classes : perClass.length,
      min_class_support: perClass.length ? Math.min(...perClass.map((c) => c.support ?? 0)) : null,
      macro_f1: num(metrics.macro_f1),
      accuracy: num(metrics.accuracy),
      high_confidence_precision: num(metrics.high_confidence_precision),
      ece: num(metrics.calibration?.ece),
      brier: num(metrics.calibration?.brier),
    },
    live: {
      consulted: rows.length,
      abstained,
      abstention_rate: pct(abstained, rows.length),
      auto_resolved: autoResolved,
      asked,
      corrected,
      correction_rate: correctionRate,
      // What the model added: resolutions that came from it rather than from
      // evidence. Coverage bought by answering where something else already
      // knew the answer is not coverage.
      useful_coverage: pct(answered.filter((r) => r.prediction_source === 'self_trained_ml').length, rows.length),
      why_it_declined: [...reasons.entries()].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n).slice(0, 5),
    },
    latency,
    status,
    notes,
    as_of: now,
  };
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Take a model out of service when the ledger says it is wrong too often.
 *
 * Automatic because the alternative is noticing. A model that quietly degrades
 * produces wrong card recommendations, and nothing about a wrong
 * recommendation looks unusual afterwards — so the check runs on the same cron
 * that scores forecasts, and the deterministic path resumes the moment it
 * fires.
 *
 * It only ever retires. Promoting a replacement is a decision with a person in
 * it, and a system that trained and deployed its own successor unattended
 * would be exactly the thing this whole design is arranged against.
 */
export async function retireIfDegraded(
  env: Env,
  key = 'merchant_mcc'
): Promise<{ retired: boolean; reason: string | null; health: ModelHealth }> {
  const health = await modelHealth(env, key);
  if (!health.model || health.status !== 'degraded') {
    return { retired: false, reason: null, health };
  }

  const reason =
    `retired automatically: ${Math.round(health.live.correction_rate * 100)}% of ${health.live.auto_resolved} ` +
    `auto-resolutions were corrected (limit ${Math.round(MAX_CORRECTION_RATE * 100)}%)`;
  await retireModel(env, key, health.model.version, reason);

  return { retired: true, reason, health: await modelHealth(env, key) };
}

/** Every model this key has had, for the history behind a rollback. */
export async function modelHistory(env: Env, key = 'merchant_mcc'): Promise<ModelRecord[]> {
  return listModels(env, key);
}
