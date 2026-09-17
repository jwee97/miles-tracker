import { deriveMcc, recordEvidence } from '../merchants/evidence';
import { resolveMerchant, similarMerchants } from '../merchants/lookup';
import { categoryForMerchant } from '../points';
import { evaluate, type Channel, type RuleStep } from '../rules';
import { today } from '../spend';
import { expectFromTransaction } from '../rewards/expected';
import { programForCard } from '../wallet';
import type { Env } from '../types';
import { findDuplicate, rawHash, type DuplicateMatch } from './dedupe';

/**
 * One way in.
 *
 * Every channel — typing it, the bot, an SMS, a statement, a CSV, the advisor's
 * "I used this card" — used to have its own insert, its own idea of when to
 * evaluate a reward, and its own opinion about duplicates. Four importers meant
 * four subtly different transactions, and a bug fixed in one of them stayed
 * broken in the other three.
 *
 * The pipeline is fixed and every arrival goes through all of it:
 *
 *   parse → normalise → deduplicate → match card → resolve merchant
 *         → resolve code and category → save → price → queue what is unsure
 */

export type TransactionSource = 'manual' | 'telegram' | 'sms' | 'statement' | 'csv' | 'advisor' | 'shortcut';

export interface TransactionCandidate {
  source: TransactionSource;
  external_id?: string | null;
  card_hint?: string | null;
  card_id?: number | null;
  amount_cents: number;
  occurred_at: string;
  posted_at?: string | null;
  merchant?: string | null;
  mcc?: string | null;
  category?: string | null;
  channel?: Channel | null;
  raw_description?: string | null;
  /** 'pending' unless the source knows the bank has posted it. */
  status?: 'pending' | 'posted' | 'reversed' | 'refunded';
  metadata?: Record<string, unknown>;
}

export type ReviewReason =
  | 'unknown_card'
  | 'unknown_merchant'
  | 'unknown_mcc'
  | 'ambiguous_mcc'
  | 'possible_duplicate'
  | 'unknown_category'
  | 'reward_rule_uncertain'
  | 'statement_match_ambiguous';

export interface IngestWarning {
  reason: ReviewReason;
  detail: string;
}

export interface RewardEstimate {
  miles: number;
  cashback_cents: number;
  rule_set_id: number | null;
  program: string | null;
  /** The engine's own working, so a caller can show why without re-evaluating. */
  trace: RuleStep[];
}

export interface IngestResult {
  status: 'created' | 'duplicate' | 'updated' | 'needs_review' | 'rejected';
  transaction_id?: number;
  duplicate_of?: number;
  warnings: IngestWarning[];
  resolved: {
    card_id: number | null;
    merchant: string | null;
    merchant_id: number | null;
    mcc: string | null;
    category: string | null;
    channel: Channel | null;
  };
  reward?: RewardEstimate;
  /** Set when an existing pending transaction was confirmed by this arrival. */
  reconciled?: boolean;
}

const reject = (reason: ReviewReason, detail: string): IngestResult => ({
  status: 'rejected',
  warnings: [{ reason, detail }],
  resolved: { card_id: null, merchant: null, merchant_id: null, mcc: null, category: null, channel: null },
});

/** The card a candidate means, by id or by nickname. */
async function matchCard(env: Env, c: TransactionCandidate) {
  if (c.card_id) return await env.DB.prepare(`SELECT * FROM cards WHERE id = ?`).bind(c.card_id).first<any>();
  const hint = (c.card_hint ?? '').trim();
  if (!hint) return null;
  return await env.DB.prepare(`SELECT * FROM cards WHERE nickname = ? COLLATE NOCASE`).bind(hint).first<any>();
}

/**
 * Take one transaction from anywhere.
 *
 * Returns rather than throws for every outcome the caller might want to show:
 * a duplicate is a normal result, not an error, and so is a row that had to be
 * queued because the app could not decide something about it.
 */
export async function ingestTransaction(env: Env, c: TransactionCandidate): Promise<IngestResult> {
  const warnings: IngestWarning[] = [];

  if (!Number.isFinite(c.amount_cents) || c.amount_cents === 0) {
    return reject('unknown_card', 'an amount is required');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.occurred_at)) {
    return reject('unknown_card', 'a date is required, as YYYY-MM-DD');
  }

  const card = await matchCard(env, c);
  if (!card) {
    return reject('unknown_card', c.card_hint ? `no card called "${c.card_hint}"` : 'no card given');
  }

  const raw = (c.raw_description ?? c.merchant ?? '').trim() || null;
  const hash = rawHash([c.source, card.id, c.amount_cents, c.occurred_at, raw]);

  // --- already known? ----------------------------------------------------
  const dup = await findDuplicate(env, {
    card_id: card.id,
    amount_cents: c.amount_cents,
    occurred_at: c.occurred_at,
    posted_at: c.posted_at ?? null,
    merchant: c.merchant ?? raw,
    source: c.source,
    external_id: c.external_id ?? null,
    raw_hash: hash,
  });

  if (dup?.automatic) return await mergeInto(env, dup, c, card, hash, raw);

  // --- merchant, code, category -----------------------------------------
  const merchant = await resolveMerchant(env, c.merchant ?? raw, { source: c.source });
  const resolvedName = merchant?.canonical_name ?? (c.merchant ?? '').trim() ?? null;

  let mcc = c.mcc ?? null;
  // What the app would choose if made to, so a review is one tap rather than a
  // search through the code list.
  let suggestion: string | null = null;
  if (!mcc && merchant) {
    const derived = await deriveMcc(env, merchant.id, c.channel ?? null);
    if (derived.mcc && !derived.ambiguous) mcc = derived.mcc;
    if (derived.ambiguous) {
      warnings.push({
        reason: 'ambiguous_mcc',
        detail: `${resolvedName} has presented ${derived.candidates
          .slice(0, 3)
          .map((x) => x.mcc)
          .join(' and ')} — which one decides the rate`,
      });
      mcc = derived.mcc;
    }
  }
  if (!mcc && merchant) {
    // A merchant with no evidence at all is often a new spelling of one the app
    // already knows — a different outlet, a longer line. The resemblance is
    // offered rather than acted on: merging two merchants that are genuinely
    // different is invisible afterwards, and it changes which card is advised.
    const like = (await similarMerchants(env, c.merchant ?? raw, { exclude: merchant.id, limit: 1 }))[0];
    warnings.push({
      reason: 'unknown_mcc',
      detail: like
        ? `no code on file for ${resolvedName} — it may be ${like.merchant.canonical_name}`
        : `no code on file for ${resolvedName}`,
    });
    if (like) {
      const theirs = await deriveMcc(env, like.merchant.id, c.channel ?? null);
      if (theirs.mcc) suggestion = theirs.mcc;
    }
  }
  if (!merchant) {
    warnings.push({ reason: 'unknown_merchant', detail: 'nothing to identify the merchant by' });
  }

  let category = (c.category ?? '').trim().toLowerCase() || null;
  let categorySource: string | null = category ? 'manual' : null;
  if (!category) {
    category = await categoryForMerchant(env, resolvedName ?? null);
    if (category) categorySource = 'learned';
  }
  if (!category) warnings.push({ reason: 'unknown_category', detail: 'no category, so totals will group it as other' });

  // --- what it should earn ----------------------------------------------
  // A refund earns nothing, and pricing one would predict miles on a negative
  // amount. Everything else is priced against the rules in force on its date.
  const expected =
    c.amount_cents > 0
      ? await evaluate(env, card, { amount_cents: c.amount_cents, mcc, category, channel: c.channel ?? null }, { on: c.occurred_at })
      : null;
  // Which wallet the points land in, resolved now rather than when they are
  // accepted: changing a card's programme later must not retroactively move
  // points that were already earned.
  const program = expected && expected.miles > 0 ? await programForCard(env, card.id, expected.rule?.id) : null;

  const status = c.status ?? (c.posted_at ? 'posted' : 'pending');

  const ins = await env.DB.prepare(
    `INSERT INTO transactions (card_id, amount_cents, occurred_at, posted_at, merchant, merchant_raw, merchant_id,
       category, category_source, needs_review, mcc, channel, expected_miles, expected_cashback_cents,
       expected_program, evaluated_rule_set_id, evaluated_at, status, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      card.id,
      c.amount_cents,
      c.occurred_at,
      c.posted_at ?? null,
      resolvedName,
      raw,
      merchant?.id ?? null,
      category,
      categorySource,
      category ? 0 : 1,
      mcc,
      c.channel ?? null,
      expected?.miles ?? 0,
      expected?.cashback_cents ?? 0,
      program,
      expected?.rule_set_id ?? null,
      today(env),
      status,
      c.source
    )
    .run();

  const id = ins.meta.last_row_id;

  await env.DB.prepare(
    `INSERT OR IGNORE INTO transaction_sources
       (transaction_id, source, external_id, raw_hash, raw_description, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      c.source,
      c.external_id ?? null,
      hash,
      raw,
      c.metadata ? JSON.stringify(c.metadata) : null
    )
    .run();

  // Break the prediction into the parts a bank credits separately. One opaque
  // total cannot later say whether it was the base or the bonus that went
  // missing, which is the only useful thing to say about a shortfall.
  if (expected) {
    await expectFromTransaction(
      env,
      {
        id,
        card_id: card.id,
        amount_cents: c.amount_cents,
        occurred_at: c.occurred_at,
        posted_at: c.posted_at ?? null,
        mcc,
        category,
        channel: c.channel ?? null,
        expected_program: program,
      },
      card
    );
  }

  // A code that came with the transaction is an observation of what the
  // acquirer actually charged, which is the best evidence there is short of a
  // person saying so.
  if (merchant && c.mcc) {
    await recordEvidence(env, {
      merchant_id: merchant.id,
      mcc: c.mcc,
      channel: c.channel ?? null,
      observed_at: c.occurred_at,
      source: c.source === 'statement' ? 'statement' : c.source === 'sms' ? 'sms' : 'user',
      transaction_id: id,
    });
  }

  // A resemblance is a question. It is recorded against the new row rather than
  // resolved, because merging two transactions that were not the same deletes a
  // purchase, and nothing in the data can tell the difference.
  if (dup && !dup.automatic) {
    warnings.push({ reason: 'possible_duplicate', detail: dup.detail });
    await queueReview(env, id, 'possible_duplicate', dup.detail, { other_id: dup.transaction_id });
  }

  for (const w of warnings) {
    if (w.reason === 'possible_duplicate') continue;
    await queueReview(env, id, w.reason, w.detail, {
      suggestion: w.reason === 'unknown_mcc' || w.reason === 'ambiguous_mcc' ? (suggestion ?? mcc) : null,
    });
  }

  return {
    status: warnings.length ? 'needs_review' : 'created',
    transaction_id: id,
    warnings,
    resolved: {
      card_id: card.id,
      merchant: resolvedName,
      merchant_id: merchant?.id ?? null,
      mcc,
      category,
      channel: c.channel ?? null,
    },
    reward: expected
      ? {
          miles: expected.miles,
          cashback_cents: expected.cashback_cents,
          rule_set_id: expected.rule_set_id,
          program,
          trace: expected.trace,
        }
      : undefined,
  };
}

/**
 * A second arrival of something already known.
 *
 * The later arrival is not thrown away: a statement knows the posting date and
 * often the code, and an SMS logged days earlier knows neither. So the existing
 * row is filled in where it was empty and confirmed where it was pending, and
 * the arrival is recorded as another source of the same transaction.
 *
 * What is never done is overwrite. A field someone typed is a decision, and the
 * whole point of keeping the raw text is that a later import cannot quietly
 * rewrite what you told it.
 */
async function mergeInto(
  env: Env,
  dup: DuplicateMatch,
  c: TransactionCandidate,
  card: any,
  hash: string,
  raw: string | null
): Promise<IngestResult> {
  const existing = await env.DB.prepare(`SELECT * FROM transactions WHERE id = ?`)
    .bind(dup.transaction_id)
    .first<any>();
  if (!existing) return reject('possible_duplicate', 'the matched transaction has since been deleted');

  const sets: string[] = [];
  const args: unknown[] = [];
  const fill = (col: string, value: unknown) => {
    sets.push(`${col} = ?`);
    args.push(value);
  };

  let reconciled = false;
  if (!existing.posted_at && c.posted_at) {
    fill('posted_at', c.posted_at);
    fill('status', 'posted');
    reconciled = true;
  } else if (existing.status === 'pending' && c.status === 'posted') {
    fill('status', 'posted');
    reconciled = true;
  }
  if (!existing.mcc && c.mcc) fill('mcc', c.mcc);
  if (!existing.merchant_raw && raw) fill('merchant_raw', raw);
  if (!existing.channel && c.channel) fill('channel', c.channel);

  if (sets.length) {
    args.push(dup.transaction_id);
    await env.DB.prepare(`UPDATE transactions SET ${sets.join(', ')} WHERE id = ?`).bind(...args).run();
  }

  // One row per arrival, but an arrival the app has already recorded is not a
  // new one. Without this, replaying the same SMS grows the source list
  // forever and makes "where did this come from" unreadable.
  const seen = await env.DB.prepare(
    `SELECT id FROM transaction_sources WHERE transaction_id = ? AND source = ? AND raw_hash = ?`
  )
    .bind(dup.transaction_id, c.source, hash)
    .first();
  if (!seen) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO transaction_sources
         (transaction_id, source, external_id, raw_hash, raw_description, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(dup.transaction_id, c.source, c.external_id ?? null, hash, raw, c.metadata ? JSON.stringify(c.metadata) : null)
      .run();
  }

  // A statement's code is the bank's own answer, so it is evidence whether or
  // not the transaction needed it.
  if (c.mcc && existing.merchant_id) {
    await recordEvidence(env, {
      merchant_id: existing.merchant_id,
      mcc: c.mcc,
      channel: c.channel ?? existing.channel ?? null,
      observed_at: c.occurred_at,
      source: c.source === 'statement' ? 'statement' : 'user',
      transaction_id: dup.transaction_id,
    });
  }

  return {
    status: reconciled ? 'updated' : 'duplicate',
    transaction_id: dup.transaction_id,
    duplicate_of: dup.transaction_id,
    reconciled,
    warnings: [],
    resolved: {
      card_id: card.id,
      merchant: existing.merchant ?? null,
      merchant_id: existing.merchant_id ?? null,
      mcc: existing.mcc ?? c.mcc ?? null,
      category: existing.category ?? null,
      channel: existing.channel ?? c.channel ?? null,
    },
  };
}

/** Queue a question, without asking the same one twice about one transaction. */
export async function queueReview(
  env: Env,
  transactionId: number,
  reason: ReviewReason,
  detail: string,
  opts: { suggestion?: string | null; other_id?: number | null } = {}
): Promise<void> {
  const open = await env.DB.prepare(
    `SELECT id FROM review_items WHERE transaction_id = ? AND reason = ? AND status = 'open'`
  )
    .bind(transactionId, reason)
    .first();
  if (open) return;

  await env.DB.prepare(
    `INSERT INTO review_items (transaction_id, reason, detail, suggestion, other_id) VALUES (?, ?, ?, ?, ?)`
  )
    .bind(transactionId, reason, detail, opts.suggestion ?? null, opts.other_id ?? null)
    .run();
}
