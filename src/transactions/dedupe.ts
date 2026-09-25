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
/**
 * The working set a batch of candidates could possibly match against,
 * fetched once.
 *
 * Checking rows one at a time costs three queries each, and a Worker
 * invocation may make only fifty subrequests on the free plan — so a statement
 * of twenty lines fails, with an error about API requests that says nothing
 * about statements. Every one of those queries reads from the same three
 * bounded sets, so they are fetched once and matched in memory.
 *
 * The matching logic below is unchanged and does not know the difference: an
 * index is an optimisation, and a dedupe rule that behaved differently in
 * batch than alone would be a much worse bug than the one it fixed.
 */
export interface DedupeIndex {
  byExternal: Map<string, number>;
  byHash: Map<string, number>;
  /** Keyed `cardId|amountCents` — the pair every level-2 lookup starts from. */
  byCardAmount: Map<string, NearRow[]>;
}

interface NearRow {
  id: number;
  occurred_at: string;
  posted_at: string | null;
  merchant: string | null;
  merchant_raw: string | null;
  status: string;
}

/** D1 refuses a statement with more than 100 bound parameters. */
const PARAM_LIMIT = 99;

const chunk = <T,>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

export async function buildDedupeIndex(
  env: Env,
  c: {
    card_id: number | null;
    source: string;
    external_ids: string[];
    raw_hashes: string[];
    amounts: number[];
  }
): Promise<DedupeIndex> {
  const index: DedupeIndex = { byExternal: new Map(), byHash: new Map(), byCardAmount: new Map() };

  // `batch` sends many statements as ONE subrequest, which is the whole point:
  // the chunking here is about D1's parameter ceiling, not about round trips.
  const statements: D1PreparedStatement[] = [];
  const kinds: ('external' | 'hash')[] = [];

  for (const ids of chunk([...new Set(c.external_ids.filter(Boolean))], PARAM_LIMIT)) {
    statements.push(
      env.DB.prepare(
        `SELECT transaction_id, external_id FROM transaction_sources
          WHERE source = ? AND external_id IN (${ids.map(() => '?').join(',')})`
      ).bind(c.source, ...ids)
    );
    kinds.push('external');
  }
  for (const hs of chunk([...new Set(c.raw_hashes.filter(Boolean))], PARAM_LIMIT)) {
    statements.push(
      env.DB.prepare(
        `SELECT transaction_id, raw_hash FROM transaction_sources
          WHERE source = ? AND raw_hash IN (${hs.map(() => '?').join(',')})`
      ).bind(c.source, ...hs)
    );
    kinds.push('hash');
  }

  if (statements.length) {
    const results = await env.DB.batch<any>(statements);
    results.forEach((r, i) => {
      for (const row of r.results ?? []) {
        if (kinds[i] === 'external') index.byExternal.set(String(row.external_id), row.transaction_id);
        else index.byHash.set(String(row.raw_hash), row.transaction_id);
      }
    });
  }

  if (c.card_id !== null) {
    const amounts = [...new Set(c.amounts)];
    const amountStatements = chunk(amounts, PARAM_LIMIT).map((as) =>
      env.DB.prepare(
        `SELECT id, occurred_at, posted_at, merchant, merchant_raw, status, amount_cents
           FROM transactions
          WHERE card_id = ? AND amount_cents IN (${as.map(() => '?').join(',')})
          ORDER BY id`
      ).bind(c.card_id, ...as)
    );
    if (amountStatements.length) {
      const rows = await env.DB.batch<any>(amountStatements);
      for (const r of rows) {
        for (const row of r.results ?? []) {
          const key = `${c.card_id}|${row.amount_cents}`;
          index.byCardAmount.set(key, [...(index.byCardAmount.get(key) ?? []), row]);
        }
      }
    }
  }

  return index;
}

export async function findDuplicate(
  env: Env,
  c: Candidate,
  index?: DedupeIndex
): Promise<DuplicateMatch | null> {
  // --- level 1: the source's own identifier ------------------------------
  if (c.external_id) {
    const hit = index
      ? (() => {
          const id = index.byExternal.get(c.external_id!);
          return id === undefined ? null : { transaction_id: id };
        })()
      : await env.DB.prepare(
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
    const hit = index
      ? (() => {
          const id = index.byHash.get(c.raw_hash!);
          return id === undefined ? null : { transaction_id: id };
        })()
      : await env.DB.prepare(
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
  const window = Math.max(DETERMINISTIC_DAYS, PROBABLE_DAYS);

  // The index holds every row for this card at this amount; the date window is
  // applied here so the filtering is identical either way.
  const results = index
    ? (index.byCardAmount.get(`${c.card_id}|${c.amount_cents}`) ?? []).filter(
        (r) => dayGap(r.posted_at ?? r.occurred_at, c.posted_at ?? c.occurred_at) <= window
      )
    : (
        await env.DB.prepare(
          `SELECT id, occurred_at, posted_at, merchant, merchant_raw, status
             FROM transactions
            WHERE card_id = ? AND amount_cents = ?
              AND ABS(julianday(COALESCE(posted_at, occurred_at)) - julianday(?)) <= ?
            ORDER BY id`
        )
          .bind(c.card_id, c.amount_cents, c.posted_at ?? c.occurred_at, window)
          .all<NearRow>()
      ).results;

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
