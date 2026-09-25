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
  diagnostics: HarvestDiagnostics;
  as_of: string;
}

export interface HarvestDiagnostics {
  transactions: number;
  transactions_with_mcc: number;
  transactions_with_descriptor: number;
  evidence_rows: number;
  evidence_by_source: Record<string, number>;
  evidence_linked_to_a_transaction: number;
  /** Transactions carrying a code the app could not have derived. */
  bank_supplied_candidates: number;
  distinct_codes_available: number;
  distinct_descriptors_available: number;
  /** In plain words: what is here, and what is missing. */
  reading: string;
}

/**
 * Why the harvest found what it found.
 *
 * A harvest that reports `0` and nothing else is a bad tool: the four reasons
 * it can return zero need four different responses, and the difference is not
 * guessable from the outside. So it counts what it looked at as well as what
 * it took.
 */
export async function harvestDiagnostics(env: Env): Promise<HarvestDiagnostics> {
  const count = async (sql: string): Promise<number> => {
    const r = await env.DB.prepare(sql).first<{ n: number }>();
    return r?.n ?? 0;
  };

  const transactions = await count(`SELECT COUNT(*) AS n FROM transactions`);
  const withMcc = await count(`SELECT COUNT(*) AS n FROM transactions WHERE mcc IS NOT NULL`);
  const withDescriptor = await count(
    `SELECT COUNT(*) AS n FROM transactions WHERE COALESCE(merchant_raw, merchant) IS NOT NULL`
  );
  const evidence = await count(`SELECT COUNT(*) AS n FROM merchant_mcc_evidence`);
  const linked = await count(`SELECT COUNT(*) AS n FROM merchant_mcc_evidence WHERE transaction_id IS NOT NULL`);

  const { results } = await env.DB.prepare(
    `SELECT source, COUNT(*) AS n FROM merchant_mcc_evidence GROUP BY source`
  ).all<{ source: string; n: number }>();
  const bySource: Record<string, number> = {};
  for (const r of results ?? []) bySource[r.source] = r.n;

  const candidates = await env.DB.prepare(
    `SELECT COUNT(*) AS n,
            COUNT(DISTINCT t.mcc) AS codes,
            COUNT(DISTINCT COALESCE(t.merchant_raw, t.merchant)) AS descriptors
       FROM transactions t
      WHERE ${UNDERIVABLE}`
  ).first<{ n: number; codes: number; descriptors: number }>();

  const reading = (() => {
    if (transactions === 0) return 'There are no transactions yet, so there is nothing to learn from.';
    if (withMcc === 0) {
      return (
        `${transactions} transaction(s), none of which carries a merchant code. ` +
        `Codes arrive with statement and SMS imports — a ledger built by hand or from sources that omit the code ` +
        `has nothing for a model to learn from. Importing a statement that carries codes is what changes this.`
      );
    }
    if (withDescriptor === 0) {
      return `${withMcc} coded transaction(s), but none records what the bank printed. The descriptor is the feature, so there is nothing to train on.`;
    }
    if (evidence === 0 && (candidates?.n ?? 0) > 0) {
      return (
        `${withMcc} coded transaction(s) and no evidence rows at all — these were imported before the app ` +
        `recorded evidence. They are still usable: ${candidates?.n} of them carry a code the app could not have ` +
        `derived, so the code came from the bank or from you.`
      );
    }
    return `${withMcc} coded transaction(s); ${evidence} evidence row(s); ${candidates?.n ?? 0} code(s) the app could not have derived.`;
  })();

  return {
    transactions,
    transactions_with_mcc: withMcc,
    transactions_with_descriptor: withDescriptor,
    evidence_rows: evidence,
    evidence_by_source: bySource,
    evidence_linked_to_a_transaction: linked,
    bank_supplied_candidates: candidates?.n ?? 0,
    distinct_codes_available: candidates?.codes ?? 0,
    distinct_descriptors_available: candidates?.descriptors ?? 0,
    reading,
  };
}

/**
 * A transaction whose code the app cannot have invented.
 *
 * `transactions.mcc` has five possible writers. Four of them are trustworthy —
 * a code that arrived with an import, a code from reconciliation against a
 * statement, a review answer, a code assigned by hand. The fifth is ingestion
 * deriving one from accumulated evidence, and that one must never become a
 * training label, because it is the app's own opinion.
 *
 * The derivation has a precondition: it calls `deriveMcc`, which returns
 * nothing unless evidence already exists for that merchant. So a coded
 * transaction whose merchant has **no evidence rows at all** cannot have been
 * derived, and its code came from outside the app.
 *
 * Merchants that do have evidence are excluded entirely rather than
 * disentangled — conservative, and it costs nothing, since those merchants are
 * already harvested through the evidence path.
 */
const UNDERIVABLE = `
  t.mcc IS NOT NULL
  AND COALESCE(t.merchant_raw, t.merchant) IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM merchant_mcc_evidence e2
     WHERE e2.merchant_id IS NOT NULL AND e2.merchant_id = t.merchant_id
  )
`;

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

  // --- second pass: codes that never became evidence -----------------------
  //
  // The evidence table was added after this app already had a ledger, so an
  // early import left `transactions.mcc` set and no evidence row behind it.
  // Those are the bank's codes just the same, and skipping them was the reason
  // a perfectly good corpus read as empty.
  const { results: direct } = await env.DB.prepare(
    `SELECT t.id, t.mcc, t.merchant, t.merchant_raw, t.merchant_id, t.channel, t.occurred_at, t.posted_at,
            m.canonical_name, c.category
       FROM transactions t
       LEFT JOIN merchants m ON m.id = t.merchant_id
       LEFT JOIN mcc_codes c ON c.code = t.mcc
      WHERE ${UNDERIVABLE}
      ORDER BY t.id`
  ).all<{
    id: number;
    mcc: string;
    merchant: string | null;
    merchant_raw: string | null;
    merchant_id: number | null;
    channel: string | null;
    occurred_at: string;
    posted_at: string | null;
    canonical_name: string | null;
    category: string | null;
  }>();

  for (const r of direct ?? []) {
    scanned++;
    bySource['statement_verified'] = (bySource['statement_verified'] ?? 0) + 1;
    await recordTrainingLabel(
      env,
      {
        raw_descriptor: r.merchant_raw ?? r.merchant ?? '',
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
        transaction_id: r.id,
      },
      { source: 'statement_verified', confirmed_at: r.posted_at ?? r.occurred_at ?? now }
    );
  }

  const after = await countLabels(env);
  return {
    scanned,
    added: after - before,
    already_had: before,
    by_source: bySource,
    diagnostics: await harvestDiagnostics(env),
    as_of: now,
  };
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
