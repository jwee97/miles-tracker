import { FEATURE_VERSION, ngrams, softmax, tf } from '../../../shared/ml/text';
import type { Env } from '../../types';
import { activeModel, type ModelRecord } from './registry';

/**
 * Running a trained model inside a Worker request.
 *
 * The obvious design — load the model into memory, keep it there — does not
 * fit. A Worker request has 10 ms of CPU, and deserialising a model plus
 * building its vocabulary costs tens of milliseconds (measured, `ml/bench/`).
 * Module init has a separate one-second budget, but a model that lives in the
 * database rather than the bundle cannot be loaded there, and a model in the
 * bundle needs a redeploy every time it is retrained.
 *
 * So nothing is loaded. A descriptor contains a few hundred distinct n-grams;
 * only those are fetched, in one indexed query, and only those contribute to
 * the score. Cost is proportional to the descriptor, not to the model, and a
 * retrained model is live the moment its rows are written.
 *
 * The arithmetic is the same arithmetic the trainer used, from the same shared
 * module, because a vectoriser that disagrees with its trainer produces a
 * model that silently scores nonsense.
 */

export interface Prediction {
  label: string;
  probability: number;
  /** Every class the model considered, best first. Used to show the spread. */
  distribution: { label: string; probability: number }[];
  model_key: string;
  model_version: number;
  /** How many of this descriptor's n-grams the model had ever seen. */
  matched_features: number;
  total_features: number;
  cost: InferenceCost;
}

/**
 * What one inference actually cost, measured rather than estimated.
 *
 * The benchmarks behind the architecture decision timed arithmetic and model
 * loading in Node. Neither is what a deployed Worker does: the real cost here
 * is a round trip to D1 for the descriptor's n-grams, and the only honest
 * place to measure that is in the request that made it. Recorded on every
 * prediction so the numbers come from production traffic, not from a harness.
 */
export interface InferenceCost {
  /** Distinct n-grams the descriptor produced. */
  ngrams: number;
  /** Feature rows D1 returned. */
  rows: number;
  /** Statements sent — bounded by D1's hundred-parameter ceiling. */
  statements: number;
  /** Round trips. One, unless something is badly wrong. */
  batches: number;
  /** Wall time around the D1 call. */
  db_ms: number;
  /** Wall time for the whole inference, including the arithmetic. */
  total_ms: number;
  /** True when the model declined to answer, and why. */
  abstained: boolean;
  abstain_reason: string | null;
}

/** How much of a descriptor a model must recognise before it may answer. */
export const MIN_FEATURE_OVERLAP = 0.15;

/**
 * D1 accepts at most 100 bound parameters in one statement.
 *
 * Not a SQLite limit — SQLite itself allows 999 by default, which is why this
 * passed every test: `node:sqlite` in the test harness happily takes 400 and
 * only the real database refuses. Exceeded, D1 returns
 * `too many SQL variables at offset N`, where N is a character offset into the
 * SQL and therefore says nothing useful about which limit was hit.
 *
 * Everything here that builds a variable-length statement counts against this,
 * including the one parameter that is not part of the batch.
 */
export const MAX_BOUND_PARAMS = 100;

/** n-grams per lookup: one parameter each, plus the model id. */
const LOOKUP_CHUNK = MAX_BOUND_PARAMS - 1;

/** Feature rows per insert: four columns each. */
const INSERT_CHUNK = Math.floor(MAX_BOUND_PARAMS / 4);

function unpack(b64: string, expected: number): Float32Array {
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const out = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  return out.length === expected ? out : new Float32Array(expected);
}

export function packWeights(weights: number[]): string {
  const f = Float32Array.from(weights);
  const bytes = new Uint8Array(f.buffer);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/**
 * What the model makes of a descriptor, or null when it should not answer.
 *
 * Null is returned more often than a prediction, and that is deliberate. A
 * model that has seen almost none of a descriptor's n-grams is not being
 * uncertain, it is being asked about something outside what it knows — and the
 * softmax will still hand back a confident-looking number for it. Requiring a
 * real overlap first is what stops "never seen anything like this" from being
 * reported as "probably a restaurant".
 */
export async function classify(
  env: Env,
  descriptor: string,
  opts: { model?: ModelRecord | null; modelKey?: string; onCost?: (c: InferenceCost) => void } = {}
): Promise<Prediction | null> {
  const started = Date.now();
  const cost: InferenceCost = {
    ngrams: 0,
    rows: 0,
    statements: 0,
    batches: 0,
    db_ms: 0,
    total_ms: 0,
    abstained: true,
    abstain_reason: null,
  };
  const give = (reason: string | null): null => {
    cost.abstain_reason = reason;
    cost.total_ms = Date.now() - started;
    opts.onCost?.(cost);
    return null;
  };

  const model = opts.model !== undefined ? opts.model : await activeModel(env, opts.modelKey ?? 'merchant_mcc');
  if (!model) return give('no model deployed');

  // The check that matters more than any threshold: a model trained with a
  // different feature extractor has weights attached to features that no
  // longer mean the same thing. Scoring it produces confident nonsense and
  // nothing about the answer would look wrong.
  if ((model.feature_version ?? 1) !== FEATURE_VERSION) {
    return give(`trained with feature set v${model.feature_version ?? 1}, this build reads v${FEATURE_VERSION}`);
  }

  const classes: string[] = safeJson(model.classes_json) ?? [];
  const intercept: number[] = safeJson(model.intercept_json) ?? [];
  if (classes.length < 2 || intercept.length !== classes.length) return give('model has no usable classes');

  const counts = ngrams(descriptor);
  if (!counts.size) return give('descriptor produced no features');

  const grams = [...counts.keys()];
  cost.ngrams = grams.length;
  // One query, however long the descriptor. Chunked only because SQLite has a
  // ceiling on bound parameters, not because the model is large.
  // One subrequest whatever the descriptor's length: the chunking is D1's
  // parameter ceiling, and `batch` keeps it from also being a round-trip count.
  const lookups: D1PreparedStatement[] = [];
  for (let i = 0; i < grams.length; i += LOOKUP_CHUNK) {
    const slice = grams.slice(i, i + LOOKUP_CHUNK);
    lookups.push(
      env.DB.prepare(
        `SELECT ngram, idf, weights_b64 FROM ml_model_features
          WHERE model_id = ? AND ngram IN (${slice.map(() => '?').join(',')})`
      ).bind(model.id, ...slice)
    );
  }
  cost.statements = lookups.length;
  const dbStarted = Date.now();
  const rows: { ngram: string; idf: number; weights_b64: string }[] = [];
  for (const part of await env.DB.batch<{ ngram: string; idf: number; weights_b64: string }>(lookups)) {
    for (const r of part.results ?? []) rows.push(r);
  }
  cost.db_ms = Date.now() - dbStarted;
  cost.batches = lookups.length ? 1 : 0;
  cost.rows = rows.length;

  if (!rows.length) return give('none of this descriptor is known to the model');
  const overlap = rows.length / grams.length;
  if (overlap < MIN_FEATURE_OVERLAP) {
    return give(`only ${Math.round(overlap * 100)}% of the descriptor is known, below the ${Math.round(MIN_FEATURE_OVERLAP * 100)}% floor`);
  }

  // tf-idf, then L2 normalise over the features that matched — exactly what
  // the trainer did, including dropping unknown n-grams.
  const values = rows.map((r) => tf(counts.get(r.ngram) ?? 1) * r.idf);
  let norm = 0;
  for (const v of values) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return give('features carried no weight');

  const scores = intercept.slice();
  for (let i = 0; i < rows.length; i++) {
    const w = unpack(rows[i].weights_b64, classes.length);
    const v = values[i] / norm;
    for (let c = 0; c < classes.length; c++) scores[c] += w[c] * v;
  }

  const probabilities = softmax(scores);
  const distribution = classes
    .map((label, c) => ({ label, probability: Math.round(probabilities[c] * 1000) / 1000 }))
    .sort((a, b) => b.probability - a.probability);

  cost.abstained = false;
  cost.total_ms = Date.now() - started;
  opts.onCost?.(cost);

  return {
    label: distribution[0].label,
    probability: distribution[0].probability,
    distribution: distribution.slice(0, 5),
    model_key: model.model_key,
    model_version: model.version,
    matched_features: rows.length,
    total_features: grams.length,
    cost,
  };
}

function safeJson<T>(s: string | null | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

export interface UploadChunk {
  model_key: string;
  version: number;
  features: { ngram: string; idf: number; weights: number[] }[];
}

/**
 * Write a slice of a model's features.
 *
 * Uploaded in pieces because a whole model is larger than one request should
 * carry, and because a half-finished upload must not be promotable — the
 * feature count on the model row is what `completeUpload` checks against.
 */
export async function storeFeatures(env: Env, chunk: UploadChunk): Promise<{ ok: boolean; error?: string; written: number }> {
  const model = await env.DB.prepare(`SELECT id, status FROM ml_models WHERE model_key = ? AND version = ?`)
    .bind(chunk.model_key, chunk.version)
    .first<{ id: number; status: string }>();
  if (!model) return { ok: false, error: 'no such model version', written: 0 };
  if (model.status === 'active') {
    return { ok: false, error: 'that model is live; upload a new version rather than editing this one', written: 0 };
  }

  let written = 0;
  // Two ceilings apply at once and they pull in opposite directions. D1 takes
  // at most a hundred bound parameters per statement, which caps a batch at
  // twenty-five four-column rows; a Worker invocation makes at most fifty
  // subrequests, which caps the number of statements. `batch` resolves it:
  // many statements, one subrequest, and an implicit transaction so a chunk
  // either lands or does not.
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < chunk.features.length; i += INSERT_CHUNK) {
    const slice = chunk.features.slice(i, i + INSERT_CHUNK);
    const values = slice.map(() => '(?, ?, ?, ?)').join(',');
    const args: unknown[] = [];
    for (const f of slice) args.push(model.id, f.ngram, f.idf, packWeights(f.weights));
    statements.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO ml_model_features (model_id, ngram, idf, weights_b64) VALUES ${values}`
      ).bind(...args)
    );
    written += slice.length;
  }
  if (statements.length) await env.DB.batch(statements);

  return { ok: true, written };
}

/** How many features are actually stored, so a truncated upload is visible. */
export async function featureCount(env: Env, modelId: number): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ml_model_features WHERE model_id = ?`)
    .bind(modelId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
