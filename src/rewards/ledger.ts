import { today } from '../spend';
import type { Env } from '../types';

/**
 * What actually arrived.
 *
 * Observations, not calculations. Every row here came from a statement, an
 * import or a person, and nothing in the app is allowed to write one because a
 * prediction said so — that is the whole point of keeping two ledgers.
 */

export type EntryType =
  | 'base_reward'
  | 'bonus_reward'
  | 'campaign_reward'
  | 'cashback'
  | 'adjustment'
  | 'reversal'
  | 'expiry'
  | 'transfer'
  | 'manual';

export interface LedgerEntry {
  id: number;
  card_id: number | null;
  program_key: string | null;
  entry_type: EntryType;
  amount: number;
  unit: string;
  period_start: string | null;
  period_end: string | null;
  credited_at: string | null;
  source: string;
  external_reference: string | null;
  transaction_id: number | null;
  description: string | null;
  raw_description: string | null;
}

export interface RecordResult {
  ok: boolean;
  id?: number;
  /** Set when this exact credit was already recorded. */
  duplicate_of?: number;
  error?: string;
}

/**
 * Record something the bank did.
 *
 * Two arrivals of one credit is the failure that matters here: a statement
 * imported twice would otherwise double the points the app thinks were paid and
 * turn a real shortfall into an apparent over-credit. The source's own
 * reference is trusted first; without one, the same card, amount, type and day
 * is treated as the same event.
 */
export async function recordActual(
  env: Env,
  e: {
    card_id: number | null;
    program_key?: string | null;
    entry_type: EntryType;
    amount: number;
    unit: string;
    period_start?: string | null;
    period_end?: string | null;
    credited_at?: string | null;
    source: string;
    external_reference?: string | null;
    transaction_id?: number | null;
    description?: string | null;
    raw_description?: string | null;
  }
): Promise<RecordResult> {
  if (!Number.isFinite(e.amount)) return { ok: false, error: 'an amount is required' };

  if (e.external_reference) {
    const hit = await env.DB.prepare(
      `SELECT id FROM reward_ledger_entries WHERE source = ? AND external_reference = ?`
    )
      .bind(e.source, e.external_reference)
      .first<{ id: number }>();
    if (hit) return { ok: true, id: hit.id, duplicate_of: hit.id };
  } else {
    const hit = await env.DB.prepare(
      `SELECT id FROM reward_ledger_entries
        WHERE card_id IS ? AND entry_type = ? AND amount = ? AND unit = ?
          AND COALESCE(credited_at, '') = COALESCE(?, '')
          AND COALESCE(description, '') = COALESCE(?, '')`
    )
      .bind(e.card_id, e.entry_type, e.amount, e.unit, e.credited_at ?? null, e.description ?? null)
      .first<{ id: number }>();
    if (hit) return { ok: true, id: hit.id, duplicate_of: hit.id };
  }

  const ins = await env.DB.prepare(
    `INSERT INTO reward_ledger_entries
       (card_id, program_key, entry_type, amount, unit, period_start, period_end, credited_at,
        source, external_reference, transaction_id, description, raw_description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      e.card_id,
      e.program_key ?? null,
      e.entry_type,
      e.amount,
      e.unit,
      e.period_start ?? null,
      e.period_end ?? null,
      e.credited_at ?? null,
      e.source,
      e.external_reference ?? null,
      e.transaction_id ?? null,
      e.description ?? null,
      e.raw_description ?? null
    )
    .run();
  return { ok: true, id: ins.meta.last_row_id };
}

export interface RewardTotal {
  component: string;
  amount: number;
  unit: string;
  program_key: string | null;
  entries: number;
}

/** Credits and reversals net off, because that is what the bank did. */
export async function actualTotals(
  env: Env,
  cardId: number,
  start: string,
  end: string
): Promise<RewardTotal[]> {
  const { results } = await env.DB.prepare(
    `SELECT entry_type, unit, program_key, SUM(amount) AS amount, COUNT(*) AS n
       FROM reward_ledger_entries
      WHERE card_id = ?
        AND COALESCE(credited_at, period_end, period_start) >= ?
        AND COALESCE(credited_at, period_start, period_end) <= ?
      GROUP BY entry_type, unit, program_key`
  )
    .bind(cardId, start, end)
    .all<{ entry_type: string; unit: string; program_key: string | null; amount: number; n: number }>();

  return (results ?? []).map((r) => ({
    component: r.entry_type,
    amount: r.amount,
    unit: r.unit,
    program_key: r.program_key,
    entries: r.n,
  }));
}

export async function entriesIn(env: Env, cardId: number, start: string, end: string): Promise<LedgerEntry[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM reward_ledger_entries
      WHERE card_id = ?
        AND COALESCE(credited_at, period_end, period_start) >= ?
        AND COALESCE(credited_at, period_start, period_end) <= ?
      ORDER BY COALESCE(credited_at, period_start), id`
  )
    .bind(cardId, start, end)
    .all<LedgerEntry>();
  return results ?? [];
}

/**
 * A figure typed in by hand.
 *
 * Marked as manual and never allowed to displace an imported one: a person's
 * recollection of a statement total is useful, and it is not the statement.
 */
export async function recordManualTotal(
  env: Env,
  cardId: number,
  amount: number,
  unit: string,
  period: { start: string; end: string },
  programKey: string | null = null
): Promise<RecordResult> {
  const imported = await env.DB.prepare(
    `SELECT id FROM reward_ledger_entries
      WHERE card_id = ? AND source <> 'manual' AND period_start = ? AND period_end = ?`
  )
    .bind(cardId, period.start, period.end)
    .first<{ id: number }>();
  if (imported) {
    return { ok: false, error: 'this period already has rewards read from a statement; remove those first' };
  }

  return await recordActual(env, {
    card_id: cardId,
    program_key: programKey,
    entry_type: 'manual',
    amount,
    unit,
    period_start: period.start,
    period_end: period.end,
    credited_at: period.end,
    source: 'manual',
    description: `entered by hand on ${today(env)}`,
  });
}
