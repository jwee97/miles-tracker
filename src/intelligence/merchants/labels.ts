import { today } from '../../spend';
import type { Env } from '../../types';
import { parseDescriptor } from './normalize';

/**
 * The corpus a classifier would one day be trained on.
 *
 * Two rules, and the second is the one that matters.
 *
 * A label is written only when a person confirms something. Not when the app
 * guesses well, not when confidence is high, not when two sources agree —
 * those are the app's own opinions, and training on your own predictions
 * teaches you your own mistakes with increasing confidence. The brief names
 * this explicitly and it is worth naming again.
 *
 * And a label records what was confirmed, not what was inferred afterwards. If
 * the person said "this is 5814", the label is 5814 on that descriptor; the
 * merchant it was attached to may be re-canonicalised later without the label
 * quietly changing underneath.
 */

export interface TrainingLabel {
  raw_descriptor: string;
  normalized_descriptor: string;
  processor: string | null;
  country: string | null;
  merchant_id: number | null;
  canonical_merchant: string | null;
  confirmed_mcc: string | null;
  category: string | null;
  channel: string | null;
  issuer: string | null;
  network: string | null;
  transaction_id: number | null;
}

export async function recordTrainingLabel(env: Env, label: TrainingLabel): Promise<void> {
  const parsed = parseDescriptor(label.raw_descriptor);
  if (!parsed.normalized) return;

  // A label with nothing confirmed teaches nothing.
  if (!label.confirmed_mcc && !label.category && !label.merchant_id) return;

  await env.DB.prepare(
    `INSERT OR IGNORE INTO merchant_training_labels
       (raw_descriptor, normalized_descriptor, processor, country, merchant_id, canonical_merchant,
        confirmed_mcc, category, channel, issuer, network, source, transaction_id, confirmed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'user_confirmed', ?, ?)`
  )
    .bind(
      label.raw_descriptor,
      parsed.normalized,
      label.processor ?? parsed.processor,
      label.country ?? parsed.country_hint,
      label.merchant_id,
      label.canonical_merchant,
      label.confirmed_mcc,
      label.category,
      label.channel,
      label.issuer,
      label.network,
      label.transaction_id,
      today(env)
    )
    .run();
}

/**
 * Whether there is enough confirmed data to bother training anything.
 *
 * These thresholds are the gate the architecture study promised: the decision
 * to stay deterministic is re-evaluated against this measurement rather than
 * against anyone's opinion, and the endpoint that serves it says exactly how
 * far off it is.
 *
 * The numbers come from what a character n-gram classifier over 18 categories
 * needs before its *confidence* means anything — roughly 100 examples per
 * class, across enough classes that the model is not really a two-class
 * problem wearing a hat.
 */
export const READINESS = {
  /** Total confirmed descriptor labels. */
  min_labels: 1500,
  /** Per-category minimum, so no class is represented by a handful. */
  min_per_category: 50,
  /** How many categories must clear that bar. */
  min_categories: 8,
  /** Distinct merchants, so the corpus is not one merchant repeated. */
  min_merchants: 200,
} as const;

export interface Readiness {
  labels: number;
  distinct_merchants: number;
  categories_meeting_bar: number;
  per_category: { category: string; labels: number }[];
  thresholds: typeof READINESS;
  ready: boolean;
  /** What is missing, in the order it blocks. */
  blocking: string[];
  /** The decision this measurement currently supports. */
  verdict: string;
  as_of: string;
}

export async function trainingReadiness(env: Env): Promise<Readiness> {
  const count = async (sql: string): Promise<number> => {
    const r = await env.DB.prepare(sql).first<{ n: number }>();
    return r?.n ?? 0;
  };

  const labels = await count(
    `SELECT COUNT(*) AS n FROM merchant_training_labels WHERE source = 'user_confirmed'`
  );
  const merchants = await count(
    `SELECT COUNT(DISTINCT normalized_descriptor) AS n FROM merchant_training_labels WHERE source = 'user_confirmed'`
  );

  const { results } = await env.DB.prepare(
    `SELECT category, COUNT(*) AS n FROM merchant_training_labels
      WHERE source = 'user_confirmed' AND category IS NOT NULL
      GROUP BY category ORDER BY n DESC`
  ).all<{ category: string; n: number }>();

  const perCategory = (results ?? []).map((r) => ({ category: r.category, labels: r.n }));
  const meeting = perCategory.filter((c) => c.labels >= READINESS.min_per_category).length;

  const blocking: string[] = [];
  if (labels < READINESS.min_labels) blocking.push(`${READINESS.min_labels - labels} more confirmed labels`);
  if (merchants < READINESS.min_merchants) {
    blocking.push(`${READINESS.min_merchants - merchants} more distinct merchants`);
  }
  if (meeting < READINESS.min_categories) {
    blocking.push(`${READINESS.min_categories - meeting} more categories with at least ${READINESS.min_per_category} labels`);
  }

  const ready = blocking.length === 0;

  return {
    labels,
    distinct_merchants: merchants,
    categories_meeting_bar: meeting,
    per_category: perCategory,
    thresholds: READINESS,
    ready,
    blocking,
    verdict: ready
      ? 'There is now enough confirmed data to train and evaluate a classifier. See docs/intelligence-model-decision.md for the promotion criteria it would have to meet.'
      : 'Not enough confirmed data to train anything meaningful. Deterministic evidence remains the right architecture, and every review you answer moves this number.',
    as_of: today(env),
  };
}

/**
 * The corpus, for training outside the Worker.
 *
 * Deliberately narrow: the descriptor and what it was confirmed to be, and
 * nothing else. No amounts, no dates, no card identifiers, no notes. A
 * training set does not need to know what anything cost, and the smallest
 * export that can do the job is the one least able to leak.
 */
export async function exportTrainingData(
  env: Env
): Promise<{ examples: Record<string, unknown>[]; count: number; exported_at: string }> {
  const { results } = await env.DB.prepare(
    `SELECT normalized_descriptor, processor, country, confirmed_mcc, category, channel
       FROM merchant_training_labels
      WHERE source = 'user_confirmed'
      ORDER BY id`
  ).all<Record<string, unknown>>();

  return { examples: results ?? [], count: (results ?? []).length, exported_at: today(env) };
}
