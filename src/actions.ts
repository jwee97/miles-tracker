import { tranchesByExpiry } from './points';
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
  | 'unknown_code';

/** Lower runs first. Gaps left so a new kind can slot in without a renumber. */
export const PRIORITY: Record<ActionKind, number> = {
  minimum_spend: 10,
  signup_deadline: 20,
  transaction_count: 30,
  cap_nearly_gone: 40,
  points_expiring: 50,
  unreviewed_import: 60,
  unknown_code: 70,
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

  // The two housekeeping queues. Grouped rather than listed: forty unreviewed
  // rows are one job, not forty actions, and listing them individually would
  // bury every deadline above.
  const review = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM transactions WHERE needs_review = 1`
  ).first<{ n: number }>();
  if (review?.n) {
    items.push({
      kind: 'unreviewed_import',
      subject: 'Ledger',
      title: `${review.n} transaction${review.n > 1 ? 's' : ''} need a category`,
      detail: 'Imported without one. Until they have it they are guessed at in every total.',
      amount_cents: null,
      deadline: null,
      days_left: null,
      urgency: 'watch',
      target: 'ledger',
      priority: PRIORITY.unreviewed_import,
      count: review.n,
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
