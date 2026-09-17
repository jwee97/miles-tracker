import { tranchesByExpiry } from './points';
import { staleProducts } from './catalog/publish';
import { reconcileAll } from './rewards/reconcile';
import { openReviewCount, REASON_ORDER } from './transactions/review';
import { money, standings, today, type Progress, type Standing } from './spend';
import type { Env } from './types';

/**
 * The things worth doing something about, in the order they are worth doing.
 *
 * This deliberately is not a dashboard. A dashboard reports numbers and leaves
 * the reader to work out which of them is a problem; every item here is a
 * situation with an action attached, and anything that cannot be acted on —
 * utilisation, totals, balances — is left to the screens that exist for it.
 *
 * The ordering is by what it costs to ignore the item. A minimum that lapses
 * tonight loses a whole window's bonus; an unreviewed import loses nothing
 * today and a little accuracy over time, so it sits at the bottom however many
 * of them there are.
 */

export type ActionKind =
  | 'minimum_spend'
  | 'signup_deadline'
  | 'transaction_count'
  | 'cap_nearly_gone'
  | 'points_expiring'
  | 'unreviewed_import'
  | 'unknown_code'
  | 'reward_shortfall'
  | 'stale_rules';

/** Lower runs first. Gaps left so a new kind can slot in without a renumber. */
export const PRIORITY: Record<ActionKind, number> = {
  minimum_spend: 10,
  signup_deadline: 20,
  transaction_count: 30,
  cap_nearly_gone: 40,
  points_expiring: 50,
  unreviewed_import: 60,
  unknown_code: 70,
  // Below the deadlines, above the housekeeping: the money is already earned,
  // so nothing is lost by looking tomorrow — but it is real money.
  reward_shortfall: 55,
  // Last, and deliberately. A stale rate is still the best answer the app has,
  // and it already costs the recommendation its confidence — which means the
  // consequence of ignoring this line is visible where it matters, rather than
  // here.
  stale_rules: 80,
};

export interface ActionItem {
  kind: ActionKind;
  /** What it is about: a card nickname, a programme, or the app itself. */
  subject: string;
  /** The action, in the words a person would use. */
  title: string;
  detail: string;
  amount_cents: number | null;
  deadline: string | null;
  days_left: number | null;
  /** 'now' is losable today or tomorrow, 'soon' inside the warning window. */
  urgency: 'now' | 'soon' | 'watch';
  /** Where the app should take you. */
  target: string;
  priority: number;
  count: number;
}

/** A cap is "nearly gone" once this little of it is left. */
export const CAP_NEARLY_GONE_PCT = 15;
/** Points inside this many days of expiring are worth a line on the home screen. */
export const EXPIRY_WARN_DAYS = 60;

const urgencyOf = (daysLeft: number | null, warnDays: number): ActionItem['urgency'] => {
  if (daysLeft === null) return 'watch';
  if (daysLeft <= 1) return 'now';
  return daysLeft <= warnDays ? 'soon' : 'watch';
};

const warnDays = (env: Env) => Number(env.MIN_SPEND_WARN_DAYS ?? 7) || 7;

/**
 * A minimum worth chasing.
 *
 * Met minimums, and windows whose reward is already lost, are both excluded —
 * for opposite reasons and with the same consequence. Spending on either
 * cannot change what the window pays, so neither is an action.
 */
function minimumItem(env: Env, s: Standing, p: Progress): ActionItem | null {
  if (p.met || s.lost) return null;
  if (p.remaining_cents <= 0 && p.txns_remaining <= 0) return null;

  const signup = p.requirement.kind === 'signup_min';
  const kind: ActionKind = signup ? 'signup_deadline' : 'minimum_spend';

  // A card that has met the money but not the transaction count is a different
  // problem with a different fix: small purchases, not big ones.
  if (p.remaining_cents <= 0 && p.txns_remaining > 0) {
    return {
      kind: 'transaction_count',
      subject: s.card.nickname,
      title: `${p.txns_remaining} more transaction${p.txns_remaining > 1 ? 's' : ''} on ${s.card.nickname}`,
      detail: `The spend is there — ${p.txn_count} of ${p.txns_required} transactions counted. Any amount will do.`,
      amount_cents: null,
      deadline: p.window.end,
      days_left: p.days_left,
      urgency: urgencyOf(p.days_left, warnDays(env)),
      target: 'cards',
      priority: PRIORITY.transaction_count,
      count: 1,
    };
  }

  const extra = p.txns_remaining > 0 ? ` and ${p.txns_remaining} more transactions` : '';
  return {
    kind,
    subject: s.card.nickname,
    title: `Spend another $${money(p.remaining_cents)} on ${s.card.nickname}`,
    detail: signup
      ? `Sign-up bonus${p.requirement.reward_note ? ` — ${p.requirement.reward_note}` : ''}. By ${p.window.end}${extra}.`
      : `By ${p.window.end}${extra}. ${p.per_day_cents > 0 ? `$${money(p.per_day_cents)} a day from here.` : ''}`.trim(),
    amount_cents: p.remaining_cents,
    deadline: p.window.end,
    days_left: p.days_left,
    urgency: urgencyOf(p.days_left, warnDays(env)),
    target: 'cards',
    priority: signup ? PRIORITY.signup_deadline : PRIORITY.minimum_spend,
    count: 1,
  };
}

/**
 * The mirror of a minimum: when to STOP using a card.
 *
 * Reported only while some of the allowance is left. A cap that is entirely
 * gone is not an action — there is nothing to protect — and the recommendation
 * engine already declines to send spend there.
 */
function capItem(s: Standing, p: Progress): ActionItem | null {
  const cap = p.requirement.bonus_cap_cents;
  if (!cap || cap <= 0) return null;
  const left = cap - p.spent_cents;
  if (left <= 0 || left > (cap * CAP_NEARLY_GONE_PCT) / 100) return null;

  return {
    kind: 'cap_nearly_gone',
    subject: s.card.nickname,
    title: `Only $${money(left)} of ${s.card.nickname}'s bonus allowance remains`,
    detail: p.requirement.reward_note
      ? `${p.requirement.reward_note}. Spend past it earns the base rate.`
      : 'Spend past it earns the base rate.',
    amount_cents: left,
    deadline: p.window.end,
    days_left: p.days_left,
    urgency: 'watch',
    target: 'cards',
    priority: PRIORITY.cap_nearly_gone,
    count: 1,
  };
}

export async function actionCentre(env: Env): Promise<ActionItem[]> {
  const items: ActionItem[] = [];
  const warn = warnDays(env);

  for (const s of await standings(env)) {
    for (const p of s.requirements) {
      const min = minimumItem(env, s, p);
      if (min) items.push(min);
      const cap = capItem(s, p);
      if (cap) items.push(cap);
    }
  }

  // Points that expire are a deadline like any other, and the only one whose
  // fix is a transfer rather than a purchase.
  for (const t of await tranchesByExpiry(env)) {
    if (t.days_left === null || t.days_left > EXPIRY_WARN_DAYS) continue;
    items.push({
      kind: 'points_expiring',
      subject: t.name,
      title: `${t.points.toLocaleString()} ${t.unit} expire on ${t.expires_at}`,
      detail:
        t.days_left <= 0
          ? 'Already past — transfer or write them off.'
          : `${t.days_left} days left. Transferring out resets the clock.`,
      amount_cents: null,
      deadline: t.expires_at,
      days_left: t.days_left,
      urgency: urgencyOf(t.days_left, warn),
      target: 'expiry',
      priority: PRIORITY.points_expiring,
      count: 1,
    });
  }

  // The housekeeping queues. Grouped rather than listed: forty unanswered
  // questions are one job, not forty actions, and listing them individually
  // would bury every deadline above.
  const open = await openReviewCount(env);
  if (open.total) {
    // Named by what is actually being asked, because "5 things need review"
    // tells you nothing about whether it is worth opening.
    const worst = REASON_ORDER.find((r) => open.by_reason[r]);
    items.push({
      kind: 'unreviewed_import',
      subject: 'Review',
      title: `${open.total} transaction${open.total > 1 ? 's' : ''} need an answer`,
      detail: worst ? `${open.by_reason[worst]} of them: ${REASON_WORDS[worst]}.` : 'Imported with something undecided.',
      amount_cents: null,
      deadline: null,
      days_left: null,
      urgency: open.by_reason.possible_duplicate ? 'soon' : 'watch',
      target: 'review',
      priority: PRIORITY.unreviewed_import,
      count: open.total,
    });
  }

  // Rows that predate the review queue, and anything categorised by hand
  // outside it, still show up as uncategorised spend.
  const uncategorised = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM transactions t
      WHERE t.needs_review = 1
        AND NOT EXISTS (SELECT 1 FROM review_items r WHERE r.transaction_id = t.id AND r.status = 'open')`
  ).first<{ n: number }>();
  if (uncategorised?.n) {
    items.push({
      kind: 'unreviewed_import',
      subject: 'Ledger',
      title: `${uncategorised.n} transaction${uncategorised.n > 1 ? 's' : ''} have no category`,
      detail: 'Until they have one they are grouped as other in every total.',
      amount_cents: null,
      deadline: null,
      days_left: null,
      urgency: 'watch',
      target: 'ledger',
      priority: PRIORITY.unreviewed_import,
      count: uncategorised.n,
    });
  }

  const unknown = await env.DB.prepare(
    `SELECT COUNT(DISTINCT merchant) AS n FROM transactions
      WHERE merchant IS NOT NULL AND TRIM(merchant) <> '' AND (mcc IS NULL OR mcc = '')
        AND merchant NOT IN (SELECT merchant FROM merchant_mcc)
        AND merchant NOT IN (SELECT merchant FROM merchant_ignored)`
  ).first<{ n: number }>();
  if (unknown?.n) {
    items.push({
      kind: 'unknown_code',
      subject: 'Codes',
      title: `${unknown.n} merchant${unknown.n > 1 ? 's' : ''} have no code yet`,
      detail: 'A card whose bonus turns on the code cannot be judged without it.',
      amount_cents: null,
      deadline: null,
      days_left: null,
      urgency: 'watch',
      target: 'codes',
      priority: PRIORITY.unknown_code,
      count: unknown.n,
    });
  }

  // Rewards the bank appears not to have paid. Worth a line because the money
  // is already earned and quietly missing, which is the one problem nobody
  // notices without being told.
  try {
    for (const r of await reconcileAll(env, 1)) {
      if (r.status !== 'undercredited') continue;
      const short = r.differences.filter((d) => d.difference < 0 && !d.within_tolerance);
      if (!short.length) continue;
      const gap = Math.abs(short.reduce((t, d) => t + d.difference, 0));
      items.push({
        kind: 'reward_shortfall',
        subject: r.card.nickname,
        title: `${Math.round(gap).toLocaleString()} ${short[0].unit} short on ${r.card.product}`,
        detail:
          r.explanations[0]?.text ??
          `Expected and credited rewards differ for ${r.scope.start} to ${r.scope.end}.`,
        amount_cents: null,
        deadline: null,
        days_left: null,
        urgency: 'watch',
        target: 'rewardcheck',
        priority: PRIORITY.reward_shortfall,
        count: 1,
      });
    }
  } catch {
    // A card with no reward data yet is not an error, and a home screen that
    // fails to draw because one check threw is worse than one missing line.
  }

  // Cards whose rates nobody has checked lately. Not urgent, and reported
  // anyway: the whole recommendation layer rests on these numbers, and a wrong
  // one is silent everywhere.
  for (const s of await staleProducts(env, today(env))) {
    if (!s.held_by.length) continue;
    items.push({
      kind: 'stale_rules',
      subject: s.held_by[0],
      title: `Check what ${s.product.product_name} pays`,
      detail: `${s.reason[0].toUpperCase()}${s.reason.slice(1)}. Every recommendation on ${s.held_by.join(', ')} is made from it.`,
      amount_cents: null,
      deadline: null,
      days_left: null,
      urgency: 'watch',
      target: 'catalog',
      priority: PRIORITY.stale_rules,
      count: 1,
    });
  }

  // Priority band first, and inside a band the nearest deadline. An item with
  // no deadline sorts last within its band rather than first.
  return items.sort(
    (a, b) =>
      a.priority - b.priority ||
      (a.days_left ?? Number.MAX_SAFE_INTEGER) - (b.days_left ?? Number.MAX_SAFE_INTEGER) ||
      (b.amount_cents ?? 0) - (a.amount_cents ?? 0)
  );
}

/** Today's date, so the caller can say what the list was true of. */
export const asOf = (env: Env) => today(env);

/** What each review reason is about, for a one-line summary. */
const REASON_WORDS: Record<string, string> = {
  possible_duplicate: 'the same purchase may have been counted twice',
  unknown_card: 'no card could be matched',
  ambiguous_mcc: 'the merchant presents more than one code',
  unknown_mcc: 'no merchant code, so a bonus cannot be judged',
  reward_rule_uncertain: 'the rules do not clearly say what it earns',
  statement_match_ambiguous: 'a statement row matched more than one thing',
  unknown_merchant: 'nothing to identify the merchant by',
  unknown_category: 'no category',
};
