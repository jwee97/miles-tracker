import type { Env } from '../types';

/**
 * What code a merchant presents, treated as evidence rather than as fact.
 *
 * A merchant legitimately has more than one code: a supermarket with a petrol
 * kiosk, a chain whose outlets were onboarded by different acquirers, an online
 * arm routed separately from the shop. Storing one code per merchant forces a
 * choice the data does not support, and the wrong choice is invisible — it just
 * quietly recommends the wrong card.
 *
 * So observations accumulate, and the current best answer is derived from them.
 */

export interface Evidence {
  id: number;
  merchant_id: number;
  mcc: string;
  channel: string | null;
  card_product_id: number | null;
  observed_at: string | null;
  source: string;
  confidence: string;
  transaction_id: number | null;
  note: string | null;
}

/**
 * How much one observation counts for.
 *
 * A code read off a posted transaction is what the bank actually charged; a
 * seed row is someone's note about what a merchant usually does. They should
 * not weigh the same, and the gaps are wide enough that no pile of guesses
 * outvotes a single confirmation.
 */
export const WEIGHT: Record<string, number> = {
  user: 100,
  statement: 40,
  sms: 20,
  seed: 5,
};

export const CONFIRMED_BONUS = 200;

export async function recordEvidence(
  env: Env,
  e: {
    merchant_id: number;
    mcc: string;
    channel?: string | null;
    card_product_id?: number | null;
    observed_at?: string | null;
    source: string;
    confidence?: 'guess' | 'confirmed';
    transaction_id?: number | null;
    note?: string | null;
  }
): Promise<void> {
  if (!/^\d{4}$/.test(e.mcc)) return;
  await env.DB.prepare(
    `INSERT INTO merchant_mcc_evidence
       (merchant_id, mcc, channel, card_product_id, observed_at, source, confidence, transaction_id, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      e.merchant_id,
      e.mcc,
      e.channel ?? null,
      e.card_product_id ?? null,
      e.observed_at ?? null,
      e.source,
      e.confidence ?? 'guess',
      e.transaction_id ?? null,
      e.note ?? null
    )
    .run();
}

export interface MccCandidate {
  mcc: string;
  weight: number;
  observations: number;
  confirmed: boolean;
  last_seen: string | null;
}

/**
 * The codes a merchant has presented, best first.
 *
 * Channel narrows rather than filters: an online purchase prefers evidence
 * gathered online, but evidence with no channel recorded still counts, because
 * most of it has none and discarding it would leave nothing to go on.
 */
export async function candidates(
  env: Env,
  merchantId: number,
  channel?: string | null
): Promise<MccCandidate[]> {
  const { results } = await env.DB.prepare(
    `SELECT mcc, channel, source, confidence, observed_at FROM merchant_mcc_evidence WHERE merchant_id = ?`
  )
    .bind(merchantId)
    .all<{ mcc: string; channel: string | null; source: string; confidence: string; observed_at: string | null }>();

  const byMcc = new Map<string, MccCandidate>();
  for (const r of results ?? []) {
    const cur = byMcc.get(r.mcc) ?? { mcc: r.mcc, weight: 0, observations: 0, confirmed: false, last_seen: null };
    let w = WEIGHT[r.source] ?? 1;
    if (r.confidence === 'confirmed') w += CONFIRMED_BONUS;
    // Evidence from the same channel is worth more; from a different one, less.
    if (channel && r.channel) w = r.channel === channel ? w * 1.5 : w * 0.5;
    cur.weight += w;
    cur.observations++;
    cur.confirmed = cur.confirmed || r.confidence === 'confirmed';
    if (r.observed_at && (!cur.last_seen || r.observed_at > cur.last_seen)) cur.last_seen = r.observed_at;
    byMcc.set(r.mcc, cur);
  }

  return [...byMcc.values()].sort((a, b) => b.weight - a.weight || (b.last_seen ?? '').localeCompare(a.last_seen ?? ''));
}

export interface DerivedMcc {
  mcc: string | null;
  confidence: 'confirmed' | 'guess' | 'unknown';
  /** True when a second code is close enough that the choice is not obvious. */
  ambiguous: boolean;
  candidates: MccCandidate[];
}

/** A rival within this fraction of the leader makes the answer ambiguous. */
export const AMBIGUOUS_WITHIN = 0.6;

/**
 * The code to use, and whether the app should admit it is choosing.
 *
 * Ambiguity is reported rather than resolved. Two codes with comparable
 * evidence is a real state of the world — a merchant that genuinely presents
 * both — and picking the heavier one silently would hide a case where the
 * answer changes which card to use.
 */
export async function deriveMcc(env: Env, merchantId: number, channel?: string | null): Promise<DerivedMcc> {
  const list = await candidates(env, merchantId, channel);
  if (!list.length) return { mcc: null, confidence: 'unknown', ambiguous: false, candidates: [] };

  const [best, second] = list;
  const ambiguous = !!second && !best.confirmed && second.weight >= best.weight * AMBIGUOUS_WITHIN;
  return {
    mcc: best.mcc,
    confidence: best.confirmed ? 'confirmed' : 'guess',
    ambiguous,
    candidates: list,
  };
}
