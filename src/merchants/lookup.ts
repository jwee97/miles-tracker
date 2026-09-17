import type { Env } from '../types';
import { canonicalName, normalizeKey, similarity } from './normalize';

/**
 * Merchants as entities, and the many spellings that point at one.
 *
 * The app used to key everything off the merchant string, which meant
 * `GRAB*RIDE` and `GRAB SINGAPORE` were two merchants with two codes and two
 * categories, and confirming one taught the app nothing about the other.
 */

export interface Merchant {
  id: number;
  canonical_name: string;
  normalized_key: string;
}

export async function merchantByKey(env: Env, key: string): Promise<Merchant | null> {
  if (!key) return null;
  return await env.DB.prepare(`SELECT id, canonical_name, normalized_key FROM merchants WHERE normalized_key = ?`)
    .bind(key)
    .first<Merchant>();
}

export async function merchantById(env: Env, id: number): Promise<Merchant | null> {
  return await env.DB.prepare(`SELECT id, canonical_name, normalized_key FROM merchants WHERE id = ?`)
    .bind(id)
    .first<Merchant>();
}

/**
 * The merchant a piece of statement text refers to, creating it if new.
 *
 * Resolution goes alias first, then key. An alias is a decision someone made —
 * "this spelling is that merchant" — and a decision outranks a derivation,
 * because the normaliser is a guess and a person is not.
 */
export async function resolveMerchant(
  env: Env,
  raw: string | null | undefined,
  opts: { source?: string; create?: boolean } = {}
): Promise<Merchant | null> {
  const key = normalizeKey(raw);
  if (!key) return null;

  const alias = await env.DB.prepare(`SELECT merchant_id FROM merchant_aliases WHERE alias_key = ?`)
    .bind(key)
    .first<{ merchant_id: number }>();
  if (alias) return await merchantById(env, alias.merchant_id);

  const existing = await merchantByKey(env, key);
  if (existing) return existing;
  if (opts.create === false) return null;

  await env.DB.prepare(`INSERT INTO merchants (canonical_name, normalized_key) VALUES (?, ?)`)
    .bind(canonicalName(String(raw)), key)
    .run();
  const made = await merchantByKey(env, key);
  if (made) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO merchant_aliases (alias_key, merchant_id, raw_example, source, confidence)
       VALUES (?, ?, ?, ?, 'guess')`
    )
      .bind(key, made.id, String(raw), opts.source ?? null)
      .run();
  }
  return made;
}

/**
 * Teach the app that a spelling belongs to a merchant.
 *
 * Confirmed aliases are never overwritten by a guess: a person having said
 * these are the same is the strongest evidence the app will ever get, and a
 * later import must not quietly undo it.
 */
export async function linkAlias(
  env: Env,
  raw: string,
  merchantId: number,
  opts: { source?: string; confidence?: 'guess' | 'confirmed' } = {}
): Promise<void> {
  const key = normalizeKey(raw);
  if (!key) return;
  const existing = await env.DB.prepare(`SELECT confidence FROM merchant_aliases WHERE alias_key = ?`)
    .bind(key)
    .first<{ confidence: string }>();
  if (existing?.confidence === 'confirmed' && opts.confidence !== 'confirmed') return;

  await env.DB.prepare(
    `INSERT INTO merchant_aliases (alias_key, merchant_id, raw_example, source, confidence)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(alias_key) DO UPDATE SET
       merchant_id = excluded.merchant_id,
       raw_example = excluded.raw_example,
       source = excluded.source,
       confidence = excluded.confidence`
  )
    .bind(key, merchantId, raw, opts.source ?? null, opts.confidence ?? 'guess')
    .run();
}

/** Every spelling the app has seen for one merchant. */
export async function aliasesOf(env: Env, merchantId: number) {
  const { results } = await env.DB.prepare(
    `SELECT alias_key, raw_example, source, confidence FROM merchant_aliases
      WHERE merchant_id = ? ORDER BY confidence DESC, alias_key`
  )
    .bind(merchantId)
    .all<{ alias_key: string; raw_example: string | null; source: string | null; confidence: string }>();
  return results ?? [];
}

/**
 * Merchants whose names resemble this one.
 *
 * Used to offer a suggestion when a new spelling appears — never to merge one.
 * `KOPITIAM 88` and `KOPITIAM 88 OUTLET` are probably the same place and
 * `SHELL` and `SHELL PLUS` are probably not, and nothing in the strings says
 * which is which. So the app proposes and a person decides.
 */
export async function similarMerchants(
  env: Env,
  raw: string | null | undefined,
  opts: { limit?: number; minimum?: number; exclude?: number } = {}
): Promise<{ merchant: Merchant; score: number }[]> {
  const key = normalizeKey(raw);
  if (!key) return [];
  const { results } = await env.DB.prepare(
    `SELECT id, canonical_name, normalized_key FROM merchants WHERE id <> ?`
  )
    .bind(opts.exclude ?? -1)
    .all<Merchant>();

  return (results ?? [])
    .map((m) => ({ merchant: m, score: similarity(key, m.normalized_key) }))
    .filter((x) => x.score >= (opts.minimum ?? 0.6))
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 3);
}
