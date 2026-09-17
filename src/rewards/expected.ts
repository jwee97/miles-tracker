import { parseRounding, qualifyingSpend, roundReward, type RewardRounding } from './rounding';
import { cycleContaining, today } from '../spend';
import { evaluate } from '../rules';
import type { Env } from '../types';

/**
 * What the app believes is owed, in the parts a bank actually pays.
 *
 * A single "expected: 400 miles" cannot answer the question people have. Banks
 * credit the base rate with the statement and the category bonus a fortnight
 * later; a campaign lands two months after that. When 6,900 arrives against
 * 8,400 expected, the useful sentence is "the base matches, the bonus is short
 * by 1,500" — and one opaque number can never produce it.
 */

export type Component =
  | 'base'
  | 'category_bonus'
  | 'campaign_bonus'
  | 'minimum_spend_bonus'
  | 'quarterly_reward'
  | 'manual_adjustment';

export interface ExpectedEntry {
  id: number;
  card_id: number;
  transaction_id: number | null;
  reward_period_key: string | null;
  rule_set_id: number | null;
  component: Component;
  expected_amount: number;
  unit: string;
  program_key: string | null;
  available_from: string | null;
  expected_by: string | null;
  source_note: string | null;
}

/** The window a non-transaction reward belongs to, as a stable key. */
export const statementPeriodKey = (start: string) => `statement:${start}`;
export const campaignPeriodKey = (id: number | string) => `campaign:${id}`;

export interface RecordExpected {
  card_id: number;
  transaction_id?: number | null;
  reward_period_key?: string | null;
  rule_set_id?: number | null;
  component: Component;
  expected_amount: number;
  unit: string;
  program_key?: string | null;
  available_from?: string | null;
  expected_by?: string | null;
  source_note?: string | null;
}

/**
 * Write an expectation, replacing any earlier one for the same thing.
 *
 * Re-pricing a transaction must not leave the old expectation lying beside the
 * new one — two rows for one component would be read as the bank owing twice.
 */
export async function recordExpected(env: Env, e: RecordExpected): Promise<number> {
  if (e.transaction_id) {
    await env.DB.prepare(`DELETE FROM expected_reward_entries WHERE transaction_id = ? AND component = ?`)
      .bind(e.transaction_id, e.component)
      .run();
  } else if (e.reward_period_key) {
    await env.DB.prepare(
      `DELETE FROM expected_reward_entries WHERE card_id = ? AND reward_period_key = ? AND component = ?`
    )
      .bind(e.card_id, e.reward_period_key, e.component)
      .run();
  }

  const ins = await env.DB.prepare(
    `INSERT INTO expected_reward_entries
       (card_id, transaction_id, reward_period_key, rule_set_id, component, expected_amount, unit,
        program_key, available_from, expected_by, source_note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      e.card_id,
      e.transaction_id ?? null,
      e.reward_period_key ?? null,
      e.rule_set_id ?? null,
      e.component,
      e.expected_amount,
      e.unit,
      e.program_key ?? null,
      e.available_from ?? null,
      e.expected_by ?? null,
      e.source_note ?? null
    )
    .run();
  return ins.meta.last_row_id;
}

/**
 * Split what a transaction earns into base and bonus.
 *
 * The engine already works out which portion of a purchase got the elevated
 * rate and which fell back to base — that split is exactly the one banks credit
 * separately, so it is reused rather than recomputed.
 */
export async function expectFromTransaction(
  env: Env,
  tx: {
    id: number;
    card_id: number;
    amount_cents: number;
    occurred_at: string;
    posted_at: string | null;
    mcc: string | null;
    category: string | null;
    channel: string | null;
    expected_program: string | null;
  },
  card: any
): Promise<{ components: { component: Component; amount: number }[]; unit: string }> {
  const on = tx.posted_at ?? tx.occurred_at;

  if (tx.amount_cents <= 0) {
    // A refund earns nothing and reverses nothing on its own: what the bank
    // claws back is an observation, and belongs in the actual ledger.
    await env.DB.prepare(`DELETE FROM expected_reward_entries WHERE transaction_id = ?`).bind(tx.id).run();
    return { components: [], unit: 'miles' };
  }

  const e = await evaluate(
    env,
    card,
    { amount_cents: tx.amount_cents, mcc: tx.mcc, category: tx.category, channel: tx.channel as any },
    { on, before: { id: tx.id, date: on } }
  );

  const rounding = await roundingFor(env, e.rule_set_id);
  const unit = e.reward_type === 'cashback' ? 'cents' : 'miles';
  const rate = (cents: number, r: number) =>
    e.reward_type === 'cashback' ? (qualifyingSpend(cents, rounding) * r) / 100 : (qualifyingSpend(cents, rounding) / 100) * r;

  const base = roundReward(rate(e.base_portion_cents, e.base_rate), rounding);
  // The bonus is the difference between the elevated rate and the base rate on
  // the portion that qualified — not the whole elevated amount. Banks credit
  // the base on everything and the uplift separately, and expecting the full
  // elevated figure as "bonus" would double-count the base.
  const bonusPortion = e.bonus_portion_cents;
  const bonusFull = rate(bonusPortion, e.bonus_rate);
  const bonusBase = rate(bonusPortion, e.base_rate);
  const baseOnBonusPortion = roundReward(bonusBase, rounding);
  const uplift = roundReward(bonusFull - bonusBase, rounding);

  const components: { component: Component; amount: number }[] = [];
  const totalBase = base + baseOnBonusPortion;
  if (totalBase > 0) components.push({ component: 'base', amount: totalBase });
  if (uplift > 0) components.push({ component: 'category_bonus', amount: uplift });

  for (const c of components) {
    await recordExpected(env, {
      card_id: tx.card_id,
      transaction_id: tx.id,
      reward_period_key: statementPeriodKey(cycleContaining(on, card.statement_day).start),
      rule_set_id: e.rule_set_id,
      component: c.component,
      expected_amount: c.amount,
      unit,
      program_key: tx.expected_program,
      available_from: on,
      source_note: `priced on ${today(env)}`,
    });
  }
  if (!components.length) {
    await env.DB.prepare(`DELETE FROM expected_reward_entries WHERE transaction_id = ?`).bind(tx.id).run();
  }

  return { components, unit };
}

/** The rounding a rule set declares, or the default when it says nothing. */
export async function roundingFor(env: Env, ruleSetId: number | null): Promise<RewardRounding> {
  if (!ruleSetId) return parseRounding(null);
  const row = await env.DB.prepare(`SELECT reward_rounding_json FROM rule_sets WHERE id = ?`)
    .bind(ruleSetId)
    .first<{ reward_rounding_json: string | null }>();
  return parseRounding(row?.reward_rounding_json ?? null);
}

export interface ExpectedTotal {
  component: string;
  amount: number;
  unit: string;
  program_key: string | null;
  entries: number;
  /** True when none of it is due yet. */
  all_pending: boolean;
}

/**
 * What is owed for a period.
 *
 * `asOf` decides what counts as due: a welcome bonus with ninety days to run is
 * not missing, and reporting it as a shortfall would make the whole check
 * useless for exactly the rewards people most want checked.
 */
export async function expectedTotals(
  env: Env,
  cardId: number,
  start: string,
  end: string,
  asOf: string
): Promise<ExpectedTotal[]> {
  const { results } = await env.DB.prepare(
    `SELECT component, unit, program_key,
            SUM(expected_amount) AS amount,
            COUNT(*) AS n,
            SUM(CASE WHEN COALESCE(available_from, ?) <= ? THEN 1 ELSE 0 END) AS due
       FROM expected_reward_entries
      WHERE card_id = ?
        AND COALESCE(available_from, ?) >= ?
        AND COALESCE(available_from, ?) <= ?
      GROUP BY component, unit, program_key`
  )
    .bind(start, asOf, cardId, start, start, start, end)
    .all<{ component: string; unit: string; program_key: string | null; amount: number; n: number; due: number }>();

  return (results ?? []).map((r) => ({
    component: r.component,
    amount: r.amount,
    unit: r.unit,
    program_key: r.program_key,
    entries: r.n,
    all_pending: r.due === 0,
  }));
}

export async function expectedIn(env: Env, cardId: number, start: string, end: string): Promise<ExpectedEntry[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM expected_reward_entries
      WHERE card_id = ? AND COALESCE(available_from, ?) >= ? AND COALESCE(available_from, ?) <= ?
      ORDER BY COALESCE(available_from, ?), id`
  )
    .bind(cardId, start, start, start, end, start)
    .all<ExpectedEntry>();
  return results ?? [];
}

/**
 * Whether a delayed reward is merely pending or genuinely late.
 *
 * Three states rather than two, because "not here yet" and "should have been
 * here a month ago" call for completely different reactions.
 */
export type DelayState = 'pending' | 'due' | 'overdue';

export function delayState(e: { available_from: string | null; expected_by: string | null }, asOf: string): DelayState {
  if (e.available_from && e.available_from > asOf) return 'pending';
  if (e.expected_by && e.expected_by < asOf) return 'overdue';
  return 'due';
}
