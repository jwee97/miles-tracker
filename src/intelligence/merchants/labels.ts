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

export async function recordTrainingLabel(
  env: Env,
  label: TrainingLabel,
  opts: { source?: (typeof TRUSTED_SOURCES)[number]; confirmed_at?: string } = {}
): Promise<void> {
  const parsed = parseDescriptor(label.raw_descriptor);
  if (!parsed.normalized) return;

  // A label with nothing confirmed teaches nothing.
  if (!label.confirmed_mcc && !label.category && !label.merchant_id) return;

  await env.DB.prepare(
    `INSERT OR IGNORE INTO merchant_training_labels
       (raw_descriptor, normalized_descriptor, processor, country, merchant_id, canonical_merchant,
        confirmed_mcc, category, channel, issuer, network, source, transaction_id, confirmed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      opts.source ?? 'user_confirmed',
      label.transaction_id,
      opts.confirmed_at ?? today(env)
    )
    .run();
}

/**
 * The sources a label may come from, and the reason the list is short.
 *
 * `user_confirmed` is someone answering a review. `statement_verified` is the
 * code the issuer itself put on the transaction when it was imported — not a
 * guess this app made, but the bank's own answer, which is the thing a
 * confirmation is trying to recover in the first place.
 *
 * What is NOT here is anything the app inferred. Training on your own
 * predictions teaches you your own mistakes with growing confidence, and the
 * distinction is the whole reason the evidence table records a source at all.
 */
export const TRUSTED_SOURCES = ['user_confirmed', 'statement_verified'] as const;

export interface HarvestResult {
  scanned: number;
  added: number;
  already_had: number;
  by_source: Record<string, number>;
  as_of: string;
}

/**
 * Turn the evidence already in the ledger into training labels.
 *
 * Every imported statement that carried an MCC is a descriptor paired with the
 * acquirer's own code. That pairing has been sitting in `merchant_mcc_evidence`
 * since the first import; it was simply never read as training data.
 *
 * `seed` rows are excluded — those are someone's note about what a merchant
 * usually does, not an observation. So are any rows without the raw descriptor
 * the bank printed, because the descriptor IS the feature.
 */
export async function harvestLabels(env: Env): Promise<HarvestResult> {
  const now = today(env);

  const { results } = await env.DB.prepare(
    `SELECT e.mcc, e.source, e.channel, e.observed_at, e.transaction_id,
            t.merchant_raw, t.merchant, t.merchant_id,
            m.canonical_name,
            c.category
       FROM merchant_mcc_evidence e
       JOIN transactions t ON t.id = e.transaction_id
       LEFT JOIN merchants m ON m.id = e.merchant_id
       LEFT JOIN mcc_codes c ON c.code = e.mcc
      WHERE e.source IN ('user', 'statement', 'sms')
        AND COALESCE(t.merchant_raw, t.merchant) IS NOT NULL
      ORDER BY e.id`
  ).all<{
    mcc: string;
    source: string;
    channel: string | null;
    observed_at: string | null;
    transaction_id: number | null;
    merchant_raw: string | null;
    merchant: string | null;
    merchant_id: number | null;
    canonical_name: string | null;
    category: string | null;
  }>();

  const before = await countLabels(env);
  const bySource: Record<string, number> = {};
  let scanned = 0;

  for (const r of results ?? []) {
    scanned++;
    const raw = r.merchant_raw ?? r.merchant ?? '';
    const source = r.source === 'user' ? 'user_confirmed' : 'statement_verified';
    bySource[source] = (bySource[source] ?? 0) + 1;

    await recordTrainingLabel(
      env,
      {
        raw_descriptor: raw,
        normalized_descriptor: '',
        processor: null,
        country: null,
        merchant_id: r.merchant_id,
        canonical_merchant: r.canonical_name ?? r.merchant,
        confirmed_mcc: r.mcc,
        category: r.category,
        channel: r.channel,
        issuer: null,
        network: null,
        transaction_id: r.transaction_id,
      },
      { source, confirmed_at: r.observed_at ?? now }
    );
  }

  const after = await countLabels(env);
  return { scanned, added: after - before, already_had: before, by_source: bySource, as_of: now };
}

async function countLabels(env: Env): Promise<number> {
  const placeholders = TRUSTED_SOURCES.map(() => '?').join(',');
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM merchant_training_labels WHERE source IN (${placeholders})`
  )
    .bind(...TRUSTED_SOURCES)
    .first<{ n: number }>();
  return r?.n ?? 0;
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
  /**
   * Total trusted labels.
   *
   * Lower than the 1,500 the architecture study named, because the model this
   * gate now guards is a different and much narrower one: it predicts only the
   * codes THIS person's spending has actually presented, at least 25 times
   * each, and it abstains everywhere else. A general 18-category classifier
   * trained from nothing needed 1,500; a personal model over a dozen codes
   * needs enough to measure its precision on, which is this.
   */
  min_labels: 300,
  /** Per-code minimum. Below this a class is dropped from the model entirely. */
  min_per_category: 25,
  /** How many codes must clear that bar before there is anything to tell apart. */
  min_categories: 4,
  /** Distinct descriptors, so the corpus is not one merchant repeated. */
  min_merchants: 40,
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

  const sources = `'${TRUSTED_SOURCES.join("','")}'`;

  const labels = await count(
    `SELECT COUNT(*) AS n FROM merchant_training_labels WHERE source IN (${sources})`
  );
  const merchants = await count(
    `SELECT COUNT(DISTINCT normalized_descriptor) AS n FROM merchant_training_labels WHERE source IN (${sources})`
  );

  // Counted per CODE, not per category: the code is what the model predicts
  // and what the rules engine needs, and a category that is well represented
  // by one code says nothing about whether the others can be told apart.
  const { results } = await env.DB.prepare(
    `SELECT confirmed_mcc AS category, COUNT(*) AS n FROM merchant_training_labels
      WHERE source IN (${sources}) AND confirmed_mcc IS NOT NULL
      GROUP BY confirmed_mcc ORDER BY n DESC`
  ).all<{ category: string; n: number }>();

  const perCategory = (results ?? []).map((r) => ({ category: r.category, labels: r.n }));
  const meeting = perCategory.filter((c) => c.labels >= READINESS.min_per_category).length;

  const blocking: string[] = [];
  if (labels < READINESS.min_labels) blocking.push(`${READINESS.min_labels - labels} more confirmed labels`);
  if (merchants < READINESS.min_merchants) {
    blocking.push(`${READINESS.min_merchants - merchants} more distinct merchants`);
  }
  if (meeting < READINESS.min_categories) {
    blocking.push(`${READINESS.min_categories - meeting} more codes with at least ${READINESS.min_per_category} labels`);
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
      ? 'There is enough here to train and measure a classifier. It still has to clear the promotion bar before it is allowed to answer anything — see docs/intelligence-model-decision.md.'
      : 'Not enough confirmed data to train anything meaningful yet. Deterministic evidence remains the answer, and every review you answer — and every statement you import that carries codes — moves this number.',
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
  const sources = `'${TRUSTED_SOURCES.join("','")}'`;
  const { results } = await env.DB.prepare(
    `SELECT normalized_descriptor, processor, country, confirmed_mcc, category, channel
       FROM merchant_training_labels
      WHERE source IN (${sources}) AND confirmed_mcc IS NOT NULL
      ORDER BY id`
  ).all<Record<string, unknown>>();

  return { examples: results ?? [], count: (results ?? []).length, exported_at: today(env) };
}
