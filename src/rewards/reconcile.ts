import { recordEvidence } from '../merchants/evidence';
import { cycleContaining, money, today } from '../spend';
import { recalculateTransaction } from '../transactions/recalculate';
import type { Env } from '../types';
import { delayState, expectedIn, expectedTotals, type ExpectedTotal } from './expected';
import { actualTotals, entriesIn, type RewardTotal } from './ledger';
import { roundingFor } from './expected';
import { toleranceFor, type RewardTolerance } from './rounding';

/**
 * Did the bank credit what it owed?
 *
 * The rule this engine follows, and the reason it is worth having: it never
 * makes the two ledgers agree. It compares them, says how far apart they are,
 * and offers the most likely reasons — every one of which is a claim about
 * evidence in the data, not about the bank having made a mistake.
 *
 * Statement level is the primary comparison because that is how banks credit.
 * Per-transaction reconciliation is only meaningful when a statement itemises
 * rewards per row, which most do not.
 */

export type ReconciliationStatus =
  | 'matched'
  | 'within_tolerance'
  | 'undercredited'
  | 'overcredited'
  | 'incomplete'
  | 'needs_review';

export type Cause =
  | 'bonus_cap_reached'
  | 'excluded_mcc'
  | 'different_mcc'
  | 'posting_date_shift'
  | 'late_posting'
  | 'refund'
  | 'reversal'
  | 'reward_rounding'
  | 'campaign_reward_delayed'
  | 'manual_adjustment'
  | 'rule_data_stale'
  | 'statement_extraction_uncertain'
  | 'unknown';

export interface RewardDifference {
  component: string;
  unit: string;
  expected: number;
  actual: number;
  difference: number;
  within_tolerance: boolean;
}

export interface ReconciliationExplanation {
  cause: Cause;
  /** A sentence, evidence-first. Never "the bank made a mistake". */
  text: string;
  /** Transactions that would account for it, when any can be named. */
  transaction_ids: number[];
  amount: number | null;
}

export interface ReconciliationResult {
  scope: { type: 'statement' | 'reward_period' | 'transaction'; start: string; end: string; card_id: number };
  card: { id: number; nickname: string; product: string };
  expected: ExpectedTotal[];
  actual: RewardTotal[];
  differences: RewardDifference[];
  status: ReconciliationStatus;
  explanations: ReconciliationExplanation[];
  confidence: 'high' | 'medium' | 'low';
  /** Rewards that are not late, merely not due. */
  pending: { component: string; amount: number; unit: string; expected_by: string | null }[];
  as_of: string;
}

/** Which actual entry kinds answer which expected components. */
const ANSWERS: Record<string, string[]> = {
  base: ['base_reward', 'cashback', 'manual'],
  category_bonus: ['bonus_reward', 'campaign_reward', 'manual'],
  campaign_bonus: ['campaign_reward', 'bonus_reward', 'manual'],
  minimum_spend_bonus: ['campaign_reward', 'bonus_reward', 'manual'],
  quarterly_reward: ['cashback', 'campaign_reward', 'manual'],
  manual_adjustment: ['adjustment', 'manual'],
};

export interface ReconciliationInput {
  card_id: number;
  start: string;
  end: string;
  type?: 'statement' | 'reward_period' | 'transaction';
  tolerance?: RewardTolerance;
}

/**
 * Compare one period.
 *
 * The comparison is per component, not on one total, so "the base matches and
 * the bonus is short" is expressible. When a bank credits everything as one
 * lump — a single manual or base entry against several expected components —
 * the totals are compared instead, and confidence drops to say so.
 */
export async function reconcileRewardPeriod(env: Env, input: ReconciliationInput): Promise<ReconciliationResult> {
  const asOf = today(env);
  const card = await env.DB.prepare(`SELECT id, nickname, product, statement_day FROM cards WHERE id = ?`)
    .bind(input.card_id)
    .first<{ id: number; nickname: string; product: string; statement_day: number }>();
  if (!card) throw new Error('no such card');

  const expected = await expectedTotals(env, card.id, input.start, input.end, asOf);
  const actual = await actualTotals(env, card.id, input.start, input.end);
  const entries = await expectedIn(env, card.id, input.start, input.end);

  // Anything not yet creditable is set aside rather than counted as missing: a
  // welcome bonus with two months to run is not a shortfall, and calling it one
  // would make the check useless for the rewards people most want checked.
  const pending = entries
    .filter((e) => delayState(e, asOf) === 'pending')
    .map((e) => ({ component: e.component, amount: e.expected_amount, unit: e.unit, expected_by: e.expected_by }));
  const pendingByComponent = new Map<string, number>();
  for (const p of pending) pendingByComponent.set(p.component, (pendingByComponent.get(p.component) ?? 0) + p.amount);

  const txCount = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM transactions
      WHERE card_id = ? AND amount_cents > 0 AND COALESCE(posted_at, occurred_at) BETWEEN ? AND ?`
  )
    .bind(card.id, input.start, input.end)
    .first<{ n: number }>();
  const rows = txCount?.n ?? 0;

  // A bank that credits one lump cannot be compared component by component.
  const lumpSum = actual.length === 1 && expected.length > 1;

  const differences: RewardDifference[] = [];
  if (lumpSum) {
    const unit = actual[0].unit;
    const due = expected.reduce((t, e) => t + e.amount - (pendingByComponent.get(e.component) ?? 0), 0);
    const got = actual[0].amount;
    differences.push({
      component: 'total',
      unit,
      expected: due,
      actual: got,
      difference: got - due,
      within_tolerance: Math.abs(got - due) <= toleranceFor(due, input.tolerance, rows),
    });
  } else {
    // Expected components drive the comparison, and each claims the entry
    // types that answer it. Iterating over both sides would count every credit
    // twice — once against the component it answers, and again as an
    // unexpected extra of its own entry type.
    const claimed = new Set<string>();
    for (const component of new Set(expected.map((e) => e.component))) {
      const exp = expected.filter((e) => e.component === component);
      const expDue = exp.reduce((t, e) => t + e.amount, 0) - (pendingByComponent.get(component) ?? 0);
      const answers = ANSWERS[component] ?? [component];
      const act = actual.filter((a) => answers.includes(a.component) && !claimed.has(a.component));
      for (const a of act) claimed.add(a.component);

      const actSum = act.reduce((t, a) => t + a.amount, 0);
      differences.push({
        component,
        unit: exp[0]?.unit ?? act[0]?.unit ?? 'points',
        expected: expDue,
        actual: actSum,
        difference: actSum - expDue,
        within_tolerance: Math.abs(actSum - expDue) <= toleranceFor(expDue, input.tolerance, rows),
      });
    }

    // Credits that answer nothing the app expected. Reported rather than
    // dropped: an unexplained credit is usually a campaign the app does not
    // know about, and occasionally a reversal waiting to happen.
    for (const a of actual) {
      if (claimed.has(a.component)) continue;
      differences.push({
        component: a.component,
        unit: a.unit,
        expected: 0,
        actual: a.amount,
        difference: a.amount,
        within_tolerance: Math.abs(a.amount) <= toleranceFor(0, input.tolerance, rows),
      });
    }
  }

  const material = differences.filter((d) => !d.within_tolerance && d.difference !== 0);
  const short = material.filter((d) => d.difference < 0);
  const over = material.filter((d) => d.difference > 0);

  let status: ReconciliationStatus;
  if (!actual.length && expected.length) status = 'incomplete';
  else if (!material.length) status = differences.some((d) => d.difference !== 0) ? 'within_tolerance' : 'matched';
  else if (short.length && over.length) status = 'needs_review';
  else if (short.length) status = 'undercredited';
  else status = 'overcredited';

  const explanations = material.length
    ? await explain(env, card, input, material, { lumpSum, rows })
    : [];

  // Confidence is about the comparison, not about the bank. A lump sum, an
  // uncertain extraction or stale card rules all mean the difference might be
  // the app's fault rather than the bank's.
  let confidence: 'high' | 'medium' | 'low' = 'high';
  if (lumpSum) confidence = 'medium';
  if (explanations.some((e) => e.cause === 'statement_extraction_uncertain' || e.cause === 'rule_data_stale')) {
    confidence = 'low';
  }
  if (status === 'incomplete') confidence = 'low';

  return {
    scope: { type: input.type ?? 'statement', start: input.start, end: input.end, card_id: card.id },
    card: { id: card.id, nickname: card.nickname, product: card.product },
    expected,
    actual,
    differences,
    status,
    explanations,
    confidence,
    pending,
    as_of: asOf,
  };
}

/**
 * Why the two might differ.
 *
 * Every explanation is a claim about something in the data. The app does not
 * say the bank got it wrong — it says which transaction would account for the
 * gap, and what about that transaction makes it a candidate. "Potential
 * discrepancy" is the strongest available phrasing.
 */
async function explain(
  env: Env,
  card: { id: number; nickname: string },
  input: ReconciliationInput,
  material: RewardDifference[],
  ctx: { lumpSum: boolean; rows: number }
): Promise<ReconciliationExplanation[]> {
  const out: ReconciliationExplanation[] = [];
  const shortfall = material.filter((d) => d.difference < 0);

  if (ctx.lumpSum) {
    out.push({
      cause: 'statement_extraction_uncertain',
      text: 'The bank credited one lump rather than itemising, so the parts cannot be checked separately.',
      transaction_ids: [],
      amount: null,
    });
  }

  // A rate nobody has checked lately is the app's most likely error, so it is
  // named before anything is blamed on the bank.
  const stale = await env.DB.prepare(
    `SELECT p.product_name, p.verification_status, p.last_verified_at
       FROM cards c JOIN card_products p ON p.id = c.product_id
      WHERE c.id = ? AND (p.verification_status IN ('draft', 'needs_review', 'migrated_unverified')
                          OR p.last_verified_at IS NULL)`
  )
    .bind(card.id)
    .first<{ product_name: string }>();
  if (stale && shortfall.length) {
    out.push({
      cause: 'rule_data_stale',
      text: `This card's rates have not been checked against a bank document, so the expectation may be wrong rather than the credit.`,
      transaction_ids: [],
      amount: null,
    });
  }

  if (!shortfall.length) {
    const overs = material.filter((d) => d.difference > 0);
    if (overs.length) {
      out.push({
        cause: 'manual_adjustment',
        text: `More was credited than expected. A campaign or an adjustment the app does not know about would account for it.`,
        transaction_ids: [],
        amount: overs.reduce((t, d) => t + d.difference, 0),
      });
    }
    return out;
  }

  const gap = Math.abs(shortfall.reduce((t, d) => t + d.difference, 0));

  // Transactions in the period whose bonus the app counted but the bank may
  // not have. Largest first: the single biggest is usually the whole story.
  const { results: suspects } = await env.DB.prepare(
    `SELECT t.id, t.merchant, t.amount_cents, t.mcc, t.category, t.posted_at, t.occurred_at,
            (SELECT SUM(e.expected_amount) FROM expected_reward_entries e
              WHERE e.transaction_id = t.id AND e.component <> 'base') AS bonus
       FROM transactions t
      WHERE t.card_id = ? AND t.amount_cents > 0
        AND COALESCE(t.posted_at, t.occurred_at) BETWEEN ? AND ?
      ORDER BY bonus DESC NULLS LAST, t.amount_cents DESC
      LIMIT 20`
  )
    .bind(card.id, input.start, input.end)
    .all<any>();

  const named: number[] = [];
  let explained = 0;
  for (const t of suspects ?? []) {
    if (explained >= gap) break;
    const bonus = t.bonus ?? 0;
    if (bonus <= 0) continue;
    // Only a transaction whose bonus could plausibly account for the gap is
    // worth naming; a $4 coffee cannot explain 1,500 missing points.
    if (bonus > gap * 1.5) continue;

    if (!t.mcc) {
      out.push({
        cause: 'different_mcc',
        text: `${t.merchant ?? 'A purchase'} of $${money(t.amount_cents)} has no confirmed merchant code, so its bonus was expected on a guess.`,
        transaction_ids: [t.id],
        amount: bonus,
      });
      named.push(t.id);
      explained += bonus;
      continue;
    }

    const excluded = await env.DB.prepare(
      `SELECT reason FROM exclusions WHERE mcc = ? AND active = 1 AND (card_id IS NULL OR card_id = ?)`
    )
      .bind(t.mcc, card.id)
      .first<{ reason: string | null }>();
    if (excluded) {
      out.push({
        cause: 'excluded_mcc',
        text: `${t.merchant ?? 'A purchase'} of $${money(t.amount_cents)} is code ${t.mcc}, which this card excludes.`,
        transaction_ids: [t.id],
        amount: bonus,
      });
      named.push(t.id);
      explained += bonus;
      continue;
    }

    // A purchase near the end of a cycle may have posted into the next one,
    // which moves its reward to a statement this comparison does not cover.
    const effective = t.posted_at ?? t.occurred_at;
    if (effective >= input.end) {
      out.push({
        cause: 'posting_date_shift',
        text: `${t.merchant ?? 'A purchase'} of $${money(t.amount_cents)} sits at the edge of the period and may have been credited to the next statement.`,
        transaction_ids: [t.id],
        amount: bonus,
      });
      named.push(t.id);
      explained += bonus;
    }
  }

  // Money back in the period reduces what the bank owes, and the app does not
  // always see the clawback as a separate entry.
  const refunds = await env.DB.prepare(
    `SELECT COUNT(*) AS n, SUM(-amount_cents) AS total FROM transactions
      WHERE card_id = ? AND amount_cents < 0 AND COALESCE(posted_at, occurred_at) BETWEEN ? AND ?`
  )
    .bind(card.id, input.start, input.end)
    .first<{ n: number; total: number }>();
  if (refunds?.n) {
    out.push({
      cause: 'refund',
      text: `$${money(refunds.total)} was refunded in this period; banks usually claw back the reward on a refund.`,
      transaction_ids: [],
      amount: null,
    });
  }

  const cap = await env.DB.prepare(
    `SELECT reward_note, bonus_cap_cents FROM requirements
      WHERE card_id = ? AND active = 1 AND bonus_cap_cents IS NOT NULL LIMIT 1`
  )
    .bind(card.id)
    .first<{ reward_note: string | null; bonus_cap_cents: number }>();
  if (cap && explained < gap) {
    out.push({
      cause: 'bonus_cap_reached',
      text: `This card caps its bonus at $${money(cap.bonus_cap_cents)} a window${cap.reward_note ? ` (${cap.reward_note})` : ''}; spend past it earns the base rate.`,
      transaction_ids: [],
      amount: null,
    });
  }

  if (!out.length || explained === 0) {
    out.push({
      cause: 'unknown',
      text: 'Nothing in the recorded transactions accounts for the difference.',
      transaction_ids: named,
      amount: gap,
    });
  }

  return out;
}

/**
 * The bank told us a code we had guessed wrong.
 *
 * This is the most valuable thing a statement can give back. The confirmed code
 * is written to the transaction, kept as merchant evidence for next time, and
 * the transaction is re-priced — which usually makes the discrepancy disappear,
 * because it was the app's expectation that was wrong.
 */
export interface MccCorrection {
  transaction_id: number;
  previous_mcc: string | null;
  actual_mcc: string;
  reward_before: number;
  reward_after: number;
}

export async function applyActualMcc(
  env: Env,
  transactionId: number,
  actualMcc: string
): Promise<{ ok: boolean; error?: string; correction?: MccCorrection }> {
  if (!/^\d{4}$/.test(actualMcc)) return { ok: false, error: 'a four-digit code is required' };

  const t = await env.DB.prepare(`SELECT * FROM transactions WHERE id = ?`).bind(transactionId).first<any>();
  if (!t) return { ok: false, error: 'no such transaction' };

  const before = t.expected_miles ?? 0;
  const previous = t.mcc ?? null;

  await env.DB.prepare(`UPDATE transactions SET mcc = ? WHERE id = ?`).bind(actualMcc, transactionId).run();

  if (t.merchant_id) {
    // The bank's own answer, so it outranks anything derived — and the next
    // purchase from that merchant is priced on it rather than on a guess.
    await recordEvidence(env, {
      merchant_id: t.merchant_id,
      mcc: actualMcc,
      channel: t.channel,
      observed_at: t.posted_at ?? t.occurred_at,
      source: 'statement',
      confidence: 'confirmed',
      transaction_id: transactionId,
      note: previous ? `the statement says ${actualMcc}, not ${previous}` : 'read off the statement',
    });
  }

  await recalculateTransaction(env, transactionId);
  const after = await env.DB.prepare(`SELECT expected_miles FROM transactions WHERE id = ?`)
    .bind(transactionId)
    .first<{ expected_miles: number }>();

  return {
    ok: true,
    correction: {
      transaction_id: transactionId,
      previous_mcc: previous,
      actual_mcc: actualMcc,
      reward_before: before,
      reward_after: after?.expected_miles ?? 0,
    },
  };
}

/** Every open card's latest complete statement period, for the rewards check. */
export async function reconcileAll(env: Env, periods = 1): Promise<ReconciliationResult[]> {
  const { results: cards } = await env.DB.prepare(
    `SELECT id, statement_day FROM cards WHERE closed_at IS NULL ORDER BY nickname`
  ).all<{ id: number; statement_day: number }>();

  const out: ReconciliationResult[] = [];
  for (const c of cards ?? []) {
    let cursor = today(env);
    for (let i = 0; i < periods; i++) {
      const cycle = cycleContaining(cursor, c.statement_day);
      out.push(await reconcileRewardPeriod(env, { card_id: c.id, start: cycle.start, end: cycle.end }));
      cursor = new Date(Date.parse(`${cycle.start}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    }
  }
  return out;
}

/** The rounding a card declares, exposed so a caller can show the tolerance. */
export const roundingOf = roundingFor;
/** Entries behind a period, for the detail screen. */
export const ledgerEntries = entriesIn;
