import { normalizeKey, similarity } from '../merchants/normalize';
import type { Env } from '../types';

/**
 * Recognising a transaction the app already has.
 *
 * This is the stage that makes several capture channels safe. The same
 * purchase arrives as an SMS on Tuesday and as a statement line on Friday, with
 * different dates, different merchant text and the same amount. Getting this
 * wrong in one direction doubles a month's spend and sends the minimum-spend
 * advice badly astray; getting it wrong in the other silently deletes a
 * purchase. Neither error is acceptable, so certainty is graded rather than
 * assumed, and only the certain end merges by itself.
 */

export type MatchLevel = 'source_id' | 'deterministic' | 'probable';

export interface DuplicateMatch {
  transaction_id: number;
  level: MatchLevel;
  /** Why, in words, so a review can be answered without opening the database. */
  detail: string;
  /** True only for the levels that may merge without being asked. */
  automatic: boolean;
}

/** A deterministic match tolerates this many days between the two dates. */
export const DETERMINISTIC_DAYS = 3;
/** A probable match looks this far either side. */
export const PROBABLE_DAYS = 3;
/** Merchant strings at least this alike count as "similar" for a probable match. */
export const PROBABLE_SIMILARITY = 0.6;

const dayGap = (a: string, b: string) => Math.abs(Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000));

export interface Candidate {
  card_id: number | null;
  amount_cents: number;
  occurred_at: string;
  posted_at?: string | null;
  merchant?: string | null;
  source: string;
  external_id?: string | null;
  raw_hash?: string | null;
}

/**
 * The strongest reason to think this transaction is already known.
 *
 * Staged, and it stops at the first level that answers. Level 1 is the source
 * saying so, which cannot be argued with. Level 2 is the same card, amount and
 * merchant within a few days, which is as close to certain as inference gets.
 * Level 3 is a resemblance, and a resemblance is a question, not an answer.
 */
export async function findDuplicate(env: Env, c: Candidate): Promise<DuplicateMatch | null> {
  // --- level 1: the source's own identifier ------------------------------
  if (c.external_id) {
    const hit = await env.DB.prepare(
      `SELECT transaction_id FROM transaction_sources WHERE source = ? AND external_id = ?`
    )
      .bind(c.source, c.external_id)
      .first<{ transaction_id: number }>();
    if (hit) {
      return {
        transaction_id: hit.transaction_id,
        level: 'source_id',
        detail: `already imported from ${c.source} (${c.external_id})`,
        automatic: true,
      };
    }
  }

  if (c.raw_hash) {
    const hit = await env.DB.prepare(
      `SELECT transaction_id FROM transaction_sources WHERE source = ? AND raw_hash = ?`
    )
      .bind(c.source, c.raw_hash)
      .first<{ transaction_id: number }>();
    if (hit) {
      return {
        transaction_id: hit.transaction_id,
        level: 'source_id',
        detail: 'the identical line has been imported before',
        automatic: true,
      };
    }
  }

  if (c.card_id === null) return null;

  // --- level 2: same card, amount, merchant, near enough in time ---------
  const key = normalizeKey(c.merchant);
  const { results } = await env.DB.prepare(
    `SELECT id, occurred_at, posted_at, merchant, merchant_raw, status
       FROM transactions
      WHERE card_id = ? AND amount_cents = ?
        AND ABS(julianday(COALESCE(posted_at, occurred_at)) - julianday(?)) <= ?
      ORDER BY id`
  )
    .bind(c.card_id, c.amount_cents, c.posted_at ?? c.occurred_at, Math.max(DETERMINISTIC_DAYS, PROBABLE_DAYS))
    .all<{
      id: number;
      occurred_at: string;
      posted_at: string | null;
      merchant: string | null;
      merchant_raw: string | null;
      status: string;
    }>();

  for (const r of results ?? []) {
    const theirs = normalizeKey(r.merchant ?? r.merchant_raw);
    const gap = dayGap(r.posted_at ?? r.occurred_at, c.posted_at ?? c.occurred_at);
    if (key && theirs && key === theirs && gap <= DETERMINISTIC_DAYS) {
      return {
        transaction_id: r.id,
        level: 'deterministic',
        detail: `same card, amount and merchant, ${gap} day${gap === 1 ? '' : 's'} apart`,
        automatic: true,
      };
    }
  }

  // --- level 3: a resemblance, which is a question ------------------------
  for (const r of results ?? []) {
    const gap = dayGap(r.posted_at ?? r.occurred_at, c.posted_at ?? c.occurred_at);
    if (gap > PROBABLE_DAYS) continue;
    const alike = similarity(c.merchant ?? '', r.merchant ?? r.merchant_raw ?? '');
    // An amount and a card matching within three days is itself suggestive,
    // even when neither side has a merchant to compare.
    const noNames = !normalizeKey(c.merchant) || !normalizeKey(r.merchant ?? r.merchant_raw);
    if (alike >= PROBABLE_SIMILARITY || noNames) {
      return {
        transaction_id: r.id,
        level: 'probable',
        detail: noNames
          ? `same card and amount, ${gap} day${gap === 1 ? '' : 's'} apart, with no merchant to compare`
          : `same card and amount, ${gap} day${gap === 1 ? '' : 's'} apart, and a similar merchant`,
        automatic: false,
      };
    }
  }

  return null;
}

/**
 * A stable fingerprint for a raw line, so the same text is recognised however
 * often it is offered. Not cryptographic — it only has to be stable and cheap.
 */
export function rawHash(parts: (string | number | null | undefined)[]): string {
  const s = parts.map((p) => String(p ?? '')).join('|');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
