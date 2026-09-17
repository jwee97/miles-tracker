import type { Env } from '../types';

/**
 * Reading the rewards half of a statement.
 *
 * Statements print a points summary — opening balance, earned, bonus, redeemed,
 * expired, closing — in prose that differs by bank and changes without notice.
 * Nothing read here is written to the ledger directly: extraction produces
 * candidates, and a candidate becomes an observation only when it is accepted.
 * A misread line that silently became "what the bank paid" would corrupt the
 * one record a reconciliation is checked against.
 */

export type CandidateType = 'base_reward' | 'bonus_reward' | 'cashback' | 'adjustment' | 'unknown';

export interface StatementRewardCandidate {
  program_key: string | null;
  amount: number;
  unit: string;
  entry_type: CandidateType;
  description: string;
  credited_at?: string | null;
  confidence: 'high' | 'medium' | 'low';
  raw_line: string;
}

const NUM = String.raw`([0-9][0-9,]*(?:\.[0-9]+)?)`;
const num = (s: string) => Number(s.replace(/,/g, ''));

/**
 * The lines worth reading, and what each means.
 *
 * Ordered most specific first: "bonus points earned" must not be read as the
 * generic "points earned", or every bonus would be counted as base and the
 * split that makes reconciliation useful would be lost.
 */
const PATTERNS: {
  re: RegExp;
  type: CandidateType;
  unit: string;
  confidence: 'high' | 'medium' | 'low';
  sign?: -1 | 1;
}[] = [
  { re: new RegExp(String.raw`bonus\s+(?:points?|miles?)\s+(?:earned|awarded)\D*${NUM}`, 'i'), type: 'bonus_reward', unit: 'points', confidence: 'high' },
  { re: new RegExp(String.raw`(?:promotional|campaign)\s+(?:points?|miles?)\D*${NUM}`, 'i'), type: 'bonus_reward', unit: 'points', confidence: 'high' },
  { re: new RegExp(String.raw`(?:points?|miles?)\s+(?:earned|accrued|awarded)(?!\s+to\s+date)\D*${NUM}`, 'i'), type: 'base_reward', unit: 'points', confidence: 'high' },
  { re: new RegExp(String.raw`total\s+(?:points?|miles?)\s+(?:earned|accrued)\D*${NUM}`, 'i'), type: 'base_reward', unit: 'points', confidence: 'medium' },
  { re: new RegExp(String.raw`cash\s*back\s+(?:earned|credited|awarded)\D*\$?\s*${NUM}`, 'i'), type: 'cashback', unit: 'cents', confidence: 'high' },
  { re: new RegExp(String.raw`(?:points?|miles?)\s+(?:redeemed|used)\D*${NUM}`, 'i'), type: 'adjustment', unit: 'points', confidence: 'high', sign: -1 },
  { re: new RegExp(String.raw`(?:points?|miles?)\s+expired\D*${NUM}`, 'i'), type: 'adjustment', unit: 'points', confidence: 'high', sign: -1 },
  { re: new RegExp(String.raw`(?:points?|miles?)\s+(?:adjustment|reversal)\D*-?\s*${NUM}`, 'i'), type: 'adjustment', unit: 'points', confidence: 'medium', sign: -1 },
];

/** Lines that say what the balance IS, not what moved. They are not credits. */
const BALANCE = /\b(opening|closing|balance|as at|brought forward|carried forward|to date)\b/i;

/**
 * Pull reward candidates out of statement text.
 *
 * Deliberately conservative. A line that could be a balance is skipped rather
 * than guessed at: reading a closing balance as points earned would add a
 * year's accumulation to one month and make every reconciliation nonsense.
 */
export function extractRewards(text: string, opts: { program_key?: string | null } = {}): StatementRewardCandidate[] {
  const out: StatementRewardCandidate[] = [];
  const seen = new Set<string>();

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.length > 200) continue;
    if (BALANCE.test(line)) continue;

    for (const p of PATTERNS) {
      const m = line.match(p.re);
      if (!m) continue;
      const value = num(m[1]);
      if (!Number.isFinite(value) || value === 0) break;

      const amount = (p.sign ?? 1) * (p.unit === 'cents' ? Math.round(value * 100) : value);
      const key = `${p.type}|${amount}|${p.unit}`;
      if (seen.has(key)) break;
      seen.add(key);

      out.push({
        program_key: opts.program_key ?? null,
        amount,
        unit: p.unit,
        entry_type: p.type,
        description: line.replace(/\s+/g, ' ').slice(0, 120),
        confidence: p.confidence,
        raw_line: raw,
      });
      break;
    }
  }

  return out;
}

export async function saveCandidates(
  env: Env,
  cardId: number,
  candidates: StatementRewardCandidate[],
  period: { start: string; end: string }
): Promise<{ saved: number }> {
  let saved = 0;
  for (const c of candidates) {
    const dup = await env.DB.prepare(
      `SELECT id FROM statement_reward_candidates
        WHERE card_id = ? AND entry_type = ? AND amount = ? AND unit = ? AND period_start = ?`
    )
      .bind(cardId, c.entry_type, c.amount, c.unit, period.start)
      .first();
    if (dup) continue;

    await env.DB.prepare(
      `INSERT INTO statement_reward_candidates
         (card_id, program_key, entry_type, amount, unit, description, period_start, period_end, confidence, raw_line)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        cardId,
        c.program_key,
        c.entry_type,
        c.amount,
        c.unit,
        c.description,
        period.start,
        period.end,
        c.confidence,
        c.raw_line
      )
      .run();
    saved++;
  }
  return { saved };
}

export async function pendingCandidates(env: Env, cardId?: number) {
  const { results } = cardId
    ? await env.DB.prepare(
        `SELECT * FROM statement_reward_candidates WHERE status = 'pending' AND card_id = ? ORDER BY id`
      )
        .bind(cardId)
        .all<any>()
    : await env.DB.prepare(`SELECT * FROM statement_reward_candidates WHERE status = 'pending' ORDER BY id`).all<any>();
  return results ?? [];
}
