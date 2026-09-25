import { today } from '../../spend';
import type { Env } from '../../types';

/**
 * The list of models this app has, and which one is in charge.
 *
 * There are none today — `docs/intelligence-model-decision.md` says why, and
 * the readiness gate says what would change it. The registry exists anyway,
 * because the alternative is that the first model to be trained also has to
 * invent the mechanism for deploying and un-deploying itself, at the exact
 * moment when the pressure to skip that is highest.
 *
 * Three properties are worth stating, because they are the reason this is a
 * table and not a constant in the code:
 *
 *  - **Promotion retires, it does not delete.** A bad model is rolled back by
 *    flipping two rows. The one that was wrong is still there to be examined.
 *  - **One active per key**, enforced here rather than hoped for.
 *  - **Metrics travel with the model.** A model cannot be promoted without a
 *    record of how it was validated, so "is this any good?" is answerable
 *    months later, when nobody remembers the training run.
 */

export type ModelStatus = 'candidate' | 'active' | 'retired' | 'rejected';

export interface ModelRecord {
  id: number;
  model_key: string;
  version: number;
  architecture: string;
  trained_at: string | null;
  training_examples: number;
  validation_metrics: Record<string, unknown> | null;
  artifact_hash: string | null;
  status: ModelStatus;
  deployed_at: string | null;
  note: string | null;
  created_at: string;
}

const hydrate = (r: any): ModelRecord => ({
  ...r,
  validation_metrics: r.validation_metrics_json ? safeParse(r.validation_metrics_json) : null,
});

function safeParse(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * The model currently answering for a key, or null.
 *
 * Every caller must handle null, and today every caller gets it. That is the
 * point: the deterministic path is not a fallback bolted on for emergencies,
 * it is what runs, and a model is the exception.
 */
export async function activeModel(env: Env, key: string): Promise<ModelRecord | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM ml_models WHERE model_key = ? AND status = 'active' ORDER BY version DESC LIMIT 1`
  )
    .bind(key)
    .first<any>();
  return row ? hydrate(row) : null;
}

export async function listModels(env: Env, key?: string): Promise<ModelRecord[]> {
  const { results } = key
    ? await env.DB.prepare(`SELECT * FROM ml_models WHERE model_key = ? ORDER BY version DESC`).bind(key).all<any>()
    : await env.DB.prepare(`SELECT * FROM ml_models ORDER BY model_key, version DESC`).all<any>();
  return (results ?? []).map(hydrate);
}

export interface RegisterInput {
  model_key: string;
  architecture: string;
  training_examples: number;
  validation_metrics?: Record<string, unknown> | null;
  artifact_hash?: string | null;
  trained_at?: string | null;
  note?: string | null;
}

/** Record a newly trained model. Always as a candidate — registering is not deploying. */
export async function registerModel(env: Env, input: RegisterInput): Promise<{ ok: boolean; error?: string; version?: number }> {
  if (!input.model_key.trim()) return { ok: false, error: 'a model key is required' };
  if (!input.architecture.trim()) return { ok: false, error: 'an architecture is required' };

  const last = await env.DB.prepare(`SELECT MAX(version) AS v FROM ml_models WHERE model_key = ?`)
    .bind(input.model_key)
    .first<{ v: number | null }>();
  const version = (last?.v ?? 0) + 1;

  await env.DB.prepare(
    `INSERT INTO ml_models
       (model_key, version, architecture, trained_at, training_examples, validation_metrics_json,
        artifact_hash, status, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'candidate', ?)`
  )
    .bind(
      input.model_key,
      version,
      input.architecture,
      input.trained_at ?? today(env),
      input.training_examples,
      input.validation_metrics ? JSON.stringify(input.validation_metrics) : null,
      input.artifact_hash ?? null,
      input.note ?? null
    )
    .run();

  return { ok: true, version };
}

/**
 * What a candidate must clear before it may answer for real.
 *
 * Precision is the one that matters, and it is stated as a floor on
 * *high-confidence* predictions specifically. A model that is 70% accurate but
 * only speaks up when it is right is useful here; a model that is 85% accurate
 * and confidently wrong the rest of the time is worse than asking, because a
 * wrong MCC produces a wrong card recommendation and nothing looks unusual
 * afterwards.
 */
export const PROMOTION_BAR = {
  min_training_examples: 1500,
  min_macro_f1: 0.75,
  /** Of predictions the model calls high-confidence, this share must be right. */
  min_high_confidence_precision: 0.85,
} as const;

export function meetsBar(m: ModelRecord): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  const mv = m.validation_metrics ?? {};
  const num = (k: string): number | null => (typeof mv[k] === 'number' ? (mv[k] as number) : null);

  if (m.training_examples < PROMOTION_BAR.min_training_examples) {
    missing.push(`trained on ${m.training_examples} examples, needs ${PROMOTION_BAR.min_training_examples}`);
  }
  const f1 = num('macro_f1');
  if (f1 === null) missing.push('no macro_f1 recorded');
  else if (f1 < PROMOTION_BAR.min_macro_f1) missing.push(`macro_f1 ${f1} below ${PROMOTION_BAR.min_macro_f1}`);

  const p = num('high_confidence_precision');
  if (p === null) missing.push('no high_confidence_precision recorded');
  else if (p < PROMOTION_BAR.min_high_confidence_precision) {
    missing.push(`high-confidence precision ${p} below ${PROMOTION_BAR.min_high_confidence_precision}`);
  }

  return { ok: missing.length === 0, missing };
}

/**
 * Make a candidate the active model, retiring whoever held the slot.
 *
 * `force` exists for the case where a person decides the bar is wrong, and it
 * is recorded in the note rather than being silent — an override nobody can
 * see later is indistinguishable from a bug.
 */
export async function promoteModel(
  env: Env,
  key: string,
  version: number,
  opts: { force?: boolean; note?: string | null } = {}
): Promise<{ ok: boolean; error?: string; retired?: number | null; missing?: string[] }> {
  const cand = await env.DB.prepare(`SELECT * FROM ml_models WHERE model_key = ? AND version = ?`)
    .bind(key, version)
    .first<any>();
  if (!cand) return { ok: false, error: 'no such model version' };
  if (cand.status === 'active') return { ok: false, error: 'already active' };

  const bar = meetsBar(hydrate(cand));
  if (!bar.ok && !opts.force) {
    return { ok: false, error: 'does not meet the promotion bar', missing: bar.missing };
  }

  const incumbent = await activeModel(env, key);
  if (incumbent) {
    await env.DB.prepare(`UPDATE ml_models SET status = 'retired' WHERE id = ?`).bind(incumbent.id).run();
  }
  await env.DB.prepare(`UPDATE ml_models SET status = 'active', deployed_at = ?, note = ? WHERE id = ?`)
    .bind(
      today(env),
      opts.note ?? (bar.ok ? cand.note : `promoted despite: ${bar.missing.join('; ')}`),
      cand.id
    )
    .run();

  return { ok: true, retired: incumbent?.version ?? null };
}

/** Take a model out of service. The deterministic path resumes immediately. */
export async function retireModel(env: Env, key: string, version: number, note?: string | null) {
  const r = await env.DB.prepare(
    `UPDATE ml_models SET status = 'retired', note = COALESCE(?, note) WHERE model_key = ? AND version = ?`
  )
    .bind(note ?? null, key, version)
    .run();
  return { ok: true, changed: r.meta?.changes ?? 0 };
}

/**
 * Predictions still attributed to a model that is no longer active.
 *
 * Asked by the audit: if a model was retired because it was wrong, which
 * decisions did it make while it was in charge? Without this the rollback is
 * only half done.
 */
export async function predictionsFromRetiredModels(env: Env, limit = 100) {
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.raw_descriptor, p.predicted_mcc, p.confidence, p.model_key, p.model_version, p.predicted_at
       FROM merchant_predictions p
       JOIN ml_models m ON m.model_key = p.model_key AND m.version = p.model_version
      WHERE p.model_key IS NOT NULL AND m.status <> 'active'
      ORDER BY p.id DESC LIMIT ?`
  )
    .bind(limit)
    .all<any>();
  return results ?? [];
}
