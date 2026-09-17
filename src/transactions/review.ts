import { candidates, recordEvidence } from '../merchants/evidence';
import { linkAlias } from '../merchants/lookup';
import { rememberMerchant } from '../points';
import { today } from '../spend';
import type { Env } from '../types';
import type { ReviewReason } from './ingest';

/**
 * The questions the pipeline could not answer.
 *
 * Ingestion never guesses at something that changes an answer. When it cannot
 * decide, it saves the transaction and records the question, so the ledger is
 * complete and the uncertainty is visible instead of being baked into a number.
 *
 * Answering one is meant to take a tap, so each item carries what the app would
 * choose if forced, and answering teaches the merchant — the next transaction
 * from the same place does not ask again.
 */

export interface ReviewItem {
  id: number;
  transaction_id: number;
  reason: ReviewReason;
  detail: string | null;
  suggestion: string | null;
  other_id: number | null;
  status: string;
  created_at: string;
  // joined, so the queue can be read without a second round trip per row
  merchant: string | null;
  merchant_raw: string | null;
  merchant_id: number | null;
  amount_cents: number;
  occurred_at: string;
  mcc: string | null;
  channel: string | null;
  category: string | null;
  nickname: string;
  product: string;
  /** For an unknown code: the codes this merchant has presented before. */
  options: { mcc: string; description: string | null; observations: number }[];
}

/** Worst first: a question whose answer changes the reward outranks a tidying job. */
export const REASON_ORDER: ReviewReason[] = [
  'possible_duplicate',
  'unknown_card',
  'ambiguous_mcc',
  'unknown_mcc',
  'reward_rule_uncertain',
  'statement_match_ambiguous',
  'unknown_merchant',
  'unknown_category',
];

export async function reviewQueue(env: Env, limit = 50): Promise<ReviewItem[]> {
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.transaction_id, r.reason, r.detail, r.suggestion, r.other_id, r.status, r.created_at,
            t.merchant, t.merchant_raw, t.merchant_id, t.amount_cents, t.occurred_at, t.mcc, t.channel, t.category,
            c.nickname, c.product
       FROM review_items r
       JOIN transactions t ON t.id = r.transaction_id
       JOIN cards c ON c.id = t.card_id
      WHERE r.status = 'open'
      ORDER BY t.occurred_at DESC, r.id DESC
      LIMIT ?`
  )
    .bind(limit)
    .all<any>();

  const out: ReviewItem[] = [];
  for (const r of results ?? []) {
    let options: ReviewItem['options'] = [];
    if ((r.reason === 'unknown_mcc' || r.reason === 'ambiguous_mcc') && r.merchant_id) {
      const seen = await candidates(env, r.merchant_id, r.channel);
      for (const c of seen.slice(0, 5)) {
        const desc = await env.DB.prepare(`SELECT description FROM mcc_codes WHERE code = ?`)
          .bind(c.mcc)
          .first<{ description: string }>();
        options.push({ mcc: c.mcc, description: desc?.description ?? null, observations: c.observations });
      }
    }
    out.push({ ...r, options });
  }

  // Reason order decides the queue, not arrival: a possible duplicate can
  // double a month's spend, an uncategorised coffee cannot.
  return out.sort(
    (a, b) => REASON_ORDER.indexOf(a.reason) - REASON_ORDER.indexOf(b.reason) || b.transaction_id - a.transaction_id
  );
}

export interface Resolution {
  /** 'confirm' answers the question; 'ignore' says it is not worth answering. */
  action: 'confirm' | 'ignore' | 'merge' | 'keep_both';
  mcc?: string | null;
  category?: string | null;
  merchant?: string | null;
}

export interface ResolveResult {
  ok: boolean;
  error?: string;
  /** What changed, so the caller can say so rather than just refreshing. */
  applied?: string;
  merged_into?: number;
}

/**
 * Answer one question.
 *
 * The answer is written to the transaction AND to the merchant, so it is worth
 * giving once. A confirmed code becomes the strongest evidence there is for
 * that merchant, and the next purchase there does not ask.
 */
export async function resolveReview(env: Env, id: number, r: Resolution): Promise<ResolveResult> {
  const item = await env.DB.prepare(
    `SELECT r.*, t.merchant, t.merchant_raw, t.merchant_id, t.channel, t.occurred_at, t.card_id, t.amount_cents
       FROM review_items r JOIN transactions t ON t.id = r.transaction_id
      WHERE r.id = ? AND r.status = 'open'`
  )
    .bind(id)
    .first<any>();
  if (!item) return { ok: false, error: 'no such open review item' };

  const close = async (resolution: string) => {
    await env.DB.prepare(`UPDATE review_items SET status = ?, resolved_at = ?, resolution = ? WHERE id = ?`)
      .bind(r.action === 'ignore' ? 'ignored' : 'resolved', today(env), resolution, id)
      .run();
  };

  if (r.action === 'ignore') {
    await close('ignored');
    return { ok: true, applied: 'left as it is' };
  }

  // --- a possible duplicate ---------------------------------------------
  if (item.reason === 'possible_duplicate') {
    if (r.action === 'keep_both') {
      await close('kept both');
      return { ok: true, applied: 'kept as two transactions' };
    }
    if (r.action === 'merge') {
      if (!item.other_id) return { ok: false, error: 'nothing recorded to merge with' };
      // The older row is the survivor: it is the one other records may already
      // point at. The newer row's sources move across so the merge cannot be
      // undone by re-importing the same line.
      const keep = Math.min(item.transaction_id, item.other_id);
      const drop = Math.max(item.transaction_id, item.other_id);
      await env.DB.prepare(`UPDATE OR IGNORE transaction_sources SET transaction_id = ? WHERE transaction_id = ?`)
        .bind(keep, drop)
        .run();
      await env.DB.prepare(`DELETE FROM transactions WHERE id = ?`).bind(drop).run();
      await env.DB.prepare(`UPDATE review_items SET status = 'resolved', resolved_at = ?, resolution = 'merged' WHERE id = ?`)
        .bind(today(env), id)
        .run();
      return { ok: true, applied: 'merged into one transaction', merged_into: keep };
    }
    return { ok: false, error: 'a possible duplicate is answered with merge or keep_both' };
  }

  // --- a code ------------------------------------------------------------
  if (item.reason === 'unknown_mcc' || item.reason === 'ambiguous_mcc') {
    const mcc = (r.mcc ?? '').trim();
    if (!/^\d{4}$/.test(mcc)) return { ok: false, error: 'a four-digit code is required' };

    await env.DB.prepare(`UPDATE transactions SET mcc = ? WHERE id = ?`).bind(mcc, item.transaction_id).run();

    if (item.merchant_id) {
      await recordEvidence(env, {
        merchant_id: item.merchant_id,
        mcc,
        channel: item.channel,
        observed_at: item.occurred_at,
        source: 'user',
        confidence: 'confirmed',
        transaction_id: item.transaction_id,
        note: 'answered in review',
      });
    }
    // The old per-merchant table stays the derived current answer, so every
    // existing lookup keeps working without knowing about evidence.
    if (item.merchant) {
      await env.DB.prepare(
        `INSERT INTO merchant_mcc (merchant, mcc, channel, source, confidence)
         VALUES (?, ?, ?, 'user', 'confirmed')
         ON CONFLICT(merchant) DO UPDATE SET mcc = excluded.mcc, channel = excluded.channel,
           source = 'user', confidence = 'confirmed', updated_at = datetime('now')`
      )
        .bind(String(item.merchant).toLowerCase(), mcc, item.channel)
        .run();
    }
    await close(`code ${mcc}`);
    return { ok: true, applied: `${item.merchant ?? 'the merchant'} is ${mcc} from now on` };
  }

  // --- a category --------------------------------------------------------
  if (item.reason === 'unknown_category') {
    const category = (r.category ?? '').trim().toLowerCase();
    if (!category) return { ok: false, error: 'a category is required' };
    await env.DB.prepare(`UPDATE transactions SET category = ?, category_source = 'manual', needs_review = 0 WHERE id = ?`)
      .bind(category, item.transaction_id)
      .run();
    await rememberMerchant(env, item.merchant, category);
    await close(`category ${category}`);
    return { ok: true, applied: `${item.merchant ?? 'it'} is ${category} from now on` };
  }

  // --- a merchant --------------------------------------------------------
  if (item.reason === 'unknown_merchant') {
    const name = (r.merchant ?? '').trim();
    if (!name) return { ok: false, error: 'a merchant name is required' };
    await env.DB.prepare(`UPDATE transactions SET merchant = ? WHERE id = ?`).bind(name, item.transaction_id).run();
    if (item.merchant_id && item.merchant_raw) {
      await linkAlias(env, item.merchant_raw, item.merchant_id, { source: 'user', confidence: 'confirmed' });
    }
    await close(`merchant ${name}`);
    return { ok: true, applied: `recorded as ${name}` };
  }

  await close('confirmed');
  return { ok: true, applied: 'noted' };
}

/** How many questions are open, by kind, for the Action Centre. */
export async function openReviewCount(env: Env): Promise<{ total: number; by_reason: Record<string, number> }> {
  const { results } = await env.DB.prepare(
    `SELECT reason, COUNT(*) AS n FROM review_items WHERE status = 'open' GROUP BY reason`
  ).all<{ reason: string; n: number }>();
  const by_reason: Record<string, number> = {};
  let total = 0;
  for (const r of results ?? []) {
    by_reason[r.reason] = r.n;
    total += r.n;
  }
  return { total, by_reason };
}
