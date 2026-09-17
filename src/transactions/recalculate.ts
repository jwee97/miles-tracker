import { deriveMcc } from '../merchants/evidence';
import { evaluate } from '../rules';
import { today } from '../spend';
import { programForCard } from '../wallet';
import { expectFromTransaction } from '../rewards/expected';
import type { Env } from '../types';

/**
 * Re-pricing what the app believed, after the rules it believed it from changed.
 *
 * A transaction records what the engine predicted and which rule version
 * produced it. That prediction can turn out to be wrong for reasons that have
 * nothing to do with the purchase: a rate corrected after a bank page was read
 * properly, a merchant code confirmed in the review queue, a category fixed. A
 * recalculation replaces the prediction with what the rules — as they now read
 * for THAT DAY — actually say.
 *
 * Two rules hold the whole thing up:
 *
 *  - **Never touch what the bank actually paid.** `actual_miles` and
 *    `actual_cashback_cents` are observations, entered by a person or read off a
 *    statement. Overwriting an observation with a prediction destroys the only
 *    thing the reward audit can check a prediction against, and it does it
 *    silently.
 *  - **Re-price the day it happened, not today.** The rules in force, the cap
 *    window, and the cap position are all as of that transaction, so running
 *    this twice gives the same answer and running it a year later gives the
 *    same answer again.
 */

export interface RecalcChange {
  id: number;
  occurred_at: string;
  merchant: string | null;
  card: string;
  before: { miles: number; cashback_cents: number; rule_set_id: number | null };
  after: { miles: number; cashback_cents: number; rule_set_id: number | null };
  /** In words, so a batch report can be read rather than diffed. */
  summary: string;
  changed: boolean;
}

export interface RecalcResult {
  ok: boolean;
  error?: string;
  change?: RecalcChange;
}

const describe = (miles: number, cash: number) =>
  miles > 0 ? `${miles.toLocaleString()} miles` : cash > 0 ? `$${(cash / 100).toFixed(2)}` : 'nothing';

/**
 * Re-price one transaction.
 *
 * The merchant code is re-resolved from evidence when the transaction has none
 * of its own — that is usually the point of running this after answering the
 * review queue — but a code already ON the transaction is left alone, because
 * it came from the statement or from a person and outranks anything derived.
 */
export async function recalculateTransaction(env: Env, id: number): Promise<RecalcResult> {
  const t = await env.DB.prepare(
    `SELECT t.*, c.nickname FROM transactions t JOIN cards c ON c.id = t.card_id WHERE t.id = ?`
  )
    .bind(id)
    .first<any>();
  if (!t) return { ok: false, error: 'no such transaction' };

  // A refund earns nothing, and pricing one would predict miles on a negative
  // amount. It is not an error, it simply has nothing to recalculate.
  if (t.amount_cents <= 0) {
    return {
      ok: true,
      change: {
        id,
        occurred_at: t.occurred_at,
        merchant: t.merchant,
        card: t.nickname,
        before: { miles: t.expected_miles ?? 0, cashback_cents: t.expected_cashback_cents ?? 0, rule_set_id: t.evaluated_rule_set_id },
        after: { miles: 0, cashback_cents: 0, rule_set_id: t.evaluated_rule_set_id },
        summary: 'a refund earns nothing',
        changed: false,
      },
    };
  }

  const card = await env.DB.prepare(`SELECT * FROM cards WHERE id = ?`).bind(t.card_id).first<any>();
  if (!card) return { ok: false, error: 'the card this belongs to is gone' };

  let mcc: string | null = t.mcc ?? null;
  if (!mcc && t.merchant_id) {
    const derived = await deriveMcc(env, t.merchant_id, t.channel);
    if (derived.mcc && !derived.ambiguous) mcc = derived.mcc;
  }

  // The date the purchase counted on is the one every window is judged by.
  const on = t.posted_at ?? t.occurred_at;

  const e = await evaluate(
    env,
    card,
    { amount_cents: t.amount_cents, mcc, category: t.category, channel: t.channel },
    { on, before: { id: t.id, date: on } }
  );

  const program = e.miles > 0 ? await programForCard(env, card.id, e.rule?.id) : null;

  const before = {
    miles: t.expected_miles ?? 0,
    cashback_cents: t.expected_cashback_cents ?? 0,
    rule_set_id: t.evaluated_rule_set_id ?? null,
  };
  const after = { miles: e.miles, cashback_cents: e.cashback_cents, rule_set_id: e.rule_set_id };
  const changed =
    before.miles !== after.miles ||
    before.cashback_cents !== after.cashback_cents ||
    before.rule_set_id !== after.rule_set_id;

  // The expected fields, the rule-set reference, the code it was priced with,
  // and when. Never actual_miles or actual_cashback_cents.
  await env.DB.prepare(
    `UPDATE transactions
        SET expected_miles = ?, expected_cashback_cents = ?, expected_program = ?,
            mcc = ?, evaluated_rule_set_id = ?, evaluated_at = ?
      WHERE id = ?`
  )
    .bind(e.miles, e.cashback_cents, program, mcc, e.rule_set_id, today(env), id)
    .run();

  // The component split is re-derived too, so a corrected rate does not leave
  // the old base/bonus expectation standing beside the new total.
  await expectFromTransaction(
    env,
    {
      id,
      card_id: t.card_id,
      amount_cents: t.amount_cents,
      occurred_at: t.occurred_at,
      posted_at: t.posted_at,
      mcc,
      category: t.category,
      channel: t.channel,
      expected_program: program,
    },
    card
  );

  const summary = !changed
    ? 'unchanged'
    : before.miles === after.miles && before.cashback_cents === after.cashback_cents
      ? `same reward, now priced by rule version ${after.rule_set_id ?? 'none'}`
      : `${describe(before.miles, before.cashback_cents)} → ${describe(after.miles, after.cashback_cents)}`;

  return {
    ok: true,
    change: { id, occurred_at: t.occurred_at, merchant: t.merchant, card: t.nickname, before, after, summary, changed },
  };
}

export interface RecalcFilter {
  /** Only this card. */
  nickname?: string | null;
  /** Only transactions on or after this date. */
  from?: string | null;
  /** Only transactions priced by this rule version — what a publish invalidates. */
  rule_set_id?: number | null;
  /** Only ones that have never been priced at all. */
  unpriced?: boolean;
  limit?: number;
}

export interface RecalcReport {
  considered: number;
  changed: number;
  unchanged: number;
  failed: { id: number; error: string }[];
  /** The changes themselves, biggest first — a batch nobody reads is a batch
   *  that hides the one row that went the wrong way. */
  changes: RecalcChange[];
  miles_before: number;
  miles_after: number;
  cashback_before_cents: number;
  cashback_after_cents: number;
}

/** How many rows one batch will touch unless told otherwise. */
export const RECALC_DEFAULT_LIMIT = 500;

/**
 * Re-price a set of transactions, oldest first.
 *
 * Order matters and is not incidental: a cap fills in ledger order, so a
 * transaction's headroom depends on what was re-priced before it. Running
 * newest-first would give a different and wrong answer.
 */
export async function recalculateMany(env: Env, f: RecalcFilter = {}): Promise<RecalcReport> {
  const where: string[] = ['t.amount_cents > 0'];
  const args: unknown[] = [];

  if (f.nickname) {
    where.push(`t.card_id = (SELECT id FROM cards WHERE nickname = ? COLLATE NOCASE)`);
    args.push(f.nickname);
  }
  if (f.from) {
    where.push(`COALESCE(t.posted_at, t.occurred_at) >= ?`);
    args.push(f.from);
  }
  if (typeof f.rule_set_id === 'number') {
    where.push(`t.evaluated_rule_set_id = ?`);
    args.push(f.rule_set_id);
  }
  if (f.unpriced) where.push(`t.evaluated_rule_set_id IS NULL`);

  const limit = Math.min(Math.max(1, f.limit ?? RECALC_DEFAULT_LIMIT), 2000);
  const { results } = await env.DB.prepare(
    `SELECT t.id FROM transactions t
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(t.posted_at, t.occurred_at), t.id
      LIMIT ?`
  )
    .bind(...args, limit)
    .all<{ id: number }>();

  const report: RecalcReport = {
    considered: 0,
    changed: 0,
    unchanged: 0,
    failed: [],
    changes: [],
    miles_before: 0,
    miles_after: 0,
    cashback_before_cents: 0,
    cashback_after_cents: 0,
  };

  for (const row of results ?? []) {
    report.considered++;
    const r = await recalculateTransaction(env, row.id);
    if (!r.ok || !r.change) {
      report.failed.push({ id: row.id, error: r.error ?? 'unknown' });
      continue;
    }
    const c = r.change;
    report.miles_before += c.before.miles;
    report.miles_after += c.after.miles;
    report.cashback_before_cents += c.before.cashback_cents;
    report.cashback_after_cents += c.after.cashback_cents;
    if (c.changed) {
      report.changed++;
      report.changes.push(c);
    } else {
      report.unchanged++;
    }
  }

  report.changes.sort(
    (a, b) =>
      Math.abs(b.after.miles - b.before.miles) - Math.abs(a.after.miles - a.before.miles) ||
      Math.abs(b.after.cashback_cents - b.before.cashback_cents) -
        Math.abs(a.after.cashback_cents - a.before.cashback_cents)
  );
  return report;
}
