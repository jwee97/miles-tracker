import { ngrams, softmax, tf } from '../../../shared/ml/text';
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
}

/** How much of a descriptor a model must recognise before it may answer. */
export const MIN_FEATURE_OVERLAP = 0.15;

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
  opts: { model?: ModelRecord | null; modelKey?: string } = {}
): Promise<Prediction | null> {
  const model = opts.model !== undefined ? opts.model : await activeModel(env, opts.modelKey ?? 'merchant_mcc');
  if (!model) return null;

  const classes: string[] = safeJson(model.classes_json) ?? [];
  const intercept: number[] = safeJson(model.intercept_json) ?? [];
  if (classes.length < 2 || intercept.length !== classes.length) return null;

  const counts = ngrams(descriptor);
  if (!counts.size) return null;

  const grams = [...counts.keys()];
  // One query, however long the descriptor. Chunked only because SQLite has a
  // ceiling on bound parameters, not because the model is large.
  const rows: { ngram: string; idf: number; weights_b64: string }[] = [];
  for (let i = 0; i < grams.length; i += 200) {
    const slice = grams.slice(i, i + 200);
    const placeholders = slice.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT ngram, idf, weights_b64 FROM ml_model_features
        WHERE model_id = ? AND ngram IN (${placeholders})`
    )
      .bind(model.id, ...slice)
      .all<{ ngram: string; idf: number; weights_b64: string }>();
    for (const r of results ?? []) rows.push(r);
  }

  if (!rows.length) return null;
  if (rows.length / grams.length < MIN_FEATURE_OVERLAP) return null;

  // tf-idf, then L2 normalise over the features that matched — exactly what
  // the trainer did, including dropping unknown n-grams.
  const values = rows.map((r) => tf(counts.get(r.ngram) ?? 1) * r.idf);
  let norm = 0;
  for (const v of values) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return null;

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

  return {
    label: distribution[0].label,
    probability: distribution[0].probability,
    distribution: distribution.slice(0, 5),
    model_key: model.model_key,
    model_version: model.version,
    matched_features: rows.length,
    total_features: grams.length,
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
  // D1 takes a bound-parameter ceiling, so rows go in batches rather than one
  // statement per feature — the difference between one round trip and 12,000.
  const BATCH = 100;
  for (let i = 0; i < chunk.features.length; i += BATCH) {
    const slice = chunk.features.slice(i, i + BATCH);
    const values = slice.map(() => '(?, ?, ?, ?)').join(',');
    const args: unknown[] = [];
    for (const f of slice) {
      args.push(model.id, f.ngram, f.idf, packWeights(f.weights));
    }
    await env.DB.prepare(
      `INSERT OR REPLACE INTO ml_model_features (model_id, ngram, idf, weights_b64) VALUES ${values}`
    )
      .bind(...args)
      .run();
    written += slice.length;
  }

  return { ok: true, written };
}

/** How many features are actually stored, so a truncated upload is visible. */
export async function featureCount(env: Env, modelId: number): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ml_model_features WHERE model_id = ?`)
    .bind(modelId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
