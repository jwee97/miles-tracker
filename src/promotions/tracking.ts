import { campaignPeriodKey, recordExpected } from '../rewards/expected';
import { money, requirementProgress, requirementsFor, today } from '../spend';
import type { Env } from '../types';
import { termsOf, type Promotion } from './model';

/**
 * Following an offer through to the reward.
 *
 * Tracking a promotion does not create a new progress system. It creates an
 * ordinary requirement, because the minimum-spend engine already counts spend
 * in a window against a threshold, excludes the codes that do not qualify, and
 * knows how many days are left. A parallel implementation would drift from it
 * and then disagree with the card screen.
 *
 * When the requirement completes, an expected reward entry is written — which
 * is what connects an offer to the reconciliation that checks whether the bank
 * actually paid it.
 */

export interface TrackResult {
  ok: boolean;
  error?: string;
  requirement_id?: number;
  /** What the app will now watch, in a sentence. */
  summary?: string;
}

const addDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export async function trackPromotion(env: Env, promotionId: number, cardId?: number): Promise<TrackResult> {
  const p = await env.DB.prepare(`SELECT * FROM promotions WHERE id = ?`).bind(promotionId).first<Promotion>();
  if (!p) return { ok: false, error: 'no such promotion' };
  if (p.status !== 'published') return { ok: false, error: 'this offer has not been published yet' };

  const t = termsOf(p);

  // A card is needed for anything that counts spend. Where exactly one card of
  // yours is eligible, it is chosen; where several are, the choice is yours,
  // because the answer changes which card you should be using.
  let card = cardId
    ? await env.DB.prepare(`SELECT * FROM cards WHERE id = ?`).bind(cardId).first<any>()
    : null;
  if (!card) {
    const { results } = await env.DB.prepare(
      `SELECT c.* FROM cards c JOIN promotion_card_products pc ON pc.product_id = c.product_id
        WHERE pc.promotion_id = ? AND c.closed_at IS NULL`
    )
      .bind(promotionId)
      .all<any>();
    if ((results ?? []).length === 1) card = results![0];
    else if ((results ?? []).length > 1) {
      return { ok: false, error: 'more than one of your cards qualifies — choose which one to track it on' };
    }
  }

  const existing = await env.DB.prepare(
    `SELECT id FROM promotion_tracking WHERE promotion_id = ? AND COALESCE(card_id, 0) = COALESCE(?, 0) AND status <> 'dismissed'`
  )
    .bind(promotionId, card?.id ?? null)
    .first();
  if (existing) return { ok: false, error: 'this offer is already being tracked' };

  // An offer whose card you do not hold yet cannot have its spend measured —
  // there is no card for the purchases to land on. Recording it as tracked
  // anyway would show a progress bar that can never move, and silently
  // attaching the threshold to some other card of yours would be worse: it
  // would count spend toward a bonus that spend cannot earn.
  //
  // So it is watched. The offer is kept, the deadline is kept, and the
  // requirement is created later — by activateWatchedPromotions — if and when
  // the card actually arrives in the wallet.
  if (t.minimum_spend_cents && !card) {
    await env.DB.prepare(
      `INSERT INTO promotion_tracking (promotion_id, card_id, status) VALUES (?, NULL, 'watching')`
    )
      .bind(promotionId)
      .run();
    return {
      ok: true,
      summary: p.end_at
        ? `Saved until ${p.end_at}. Spend will only be counted once you add the card.`
        : 'Saved. Spend will only be counted once you add the card.',
    };
  }

  // Without a spend threshold there is nothing to count, so it is followed
  // rather than measured: a reminder, not a progress bar that cannot move.
  if (!t.minimum_spend_cents || !card) {
    await env.DB.prepare(
      `INSERT INTO promotion_tracking (promotion_id, card_id, status) VALUES (?, ?, 'tracked')`
    )
      .bind(promotionId, card?.id ?? null)
      .run();
    return {
      ok: true,
      summary: p.end_at ? `Followed until ${p.end_at}. There is no spend threshold to track.` : 'Followed.',
    };
  }

  const start = p.start_at ?? today(env);
  const deadline = p.end_at ?? (t.window_days ? addDays(start, t.window_days) : null);
  if (!deadline) return { ok: false, error: 'this offer has no end date, so there is no window to track' };

  const ins = await env.DB.prepare(
    `INSERT INTO requirements (card_id, kind, amount_cents, window, deadline, starts_at, min_txns, reward_note,
       source_note, promotion_id)
     VALUES (?, 'signup_min', ?, 'fixed_window', ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      card.id,
      t.minimum_spend_cents,
      deadline,
      start,
      t.min_txns ?? null,
      p.title,
      `promotion #${p.id}`,
      p.id
    )
    .run();

  await env.DB.prepare(
    `INSERT INTO promotion_tracking (promotion_id, card_id, requirement_id, status) VALUES (?, ?, ?, 'tracked')`
  )
    .bind(promotionId, card.id, ins.meta.last_row_id)
    .run();

  const left = Math.round((Date.parse(deadline) - Date.parse(today(env))) / 86_400_000);
  return {
    ok: true,
    requirement_id: ins.meta.last_row_id,
    summary: `$${money(t.minimum_spend_cents)} on ${card.nickname} by ${deadline} — ${left} day${left === 1 ? '' : 's'} left.`,
  };
}

export async function dismissPromotion(env: Env, promotionId: number): Promise<{ ok: boolean }> {
  await env.DB.prepare(`UPDATE promotions SET dismissed_at = ? WHERE id = ?`).bind(today(env), promotionId).run();
  await env.DB.prepare(
    `UPDATE promotion_tracking SET status = 'dismissed' WHERE promotion_id = ? AND status = 'tracked'`
  )
    .bind(promotionId)
    .run();
  // The requirement goes with it: a minimum nobody is chasing any more would
  // otherwise keep pulling spend toward a card for no reason.
  await env.DB.prepare(`UPDATE requirements SET active = 0 WHERE promotion_id = ?`).bind(promotionId).run();
  return { ok: true };
}

export interface TrackedOffer {
  tracking_id: number;
  promotion: Promotion;
  card: { id: number; nickname: string; product: string } | null;
  progress: {
    spent_cents: number;
    required_cents: number;
    remaining_cents: number;
    days_left: number;
    met: boolean;
  } | null;
  status: string;
}

export async function trackedOffers(env: Env): Promise<TrackedOffer[]> {
  const { results } = await env.DB.prepare(
    // Aliased, because `p.*` carries a `status` of its own and the later column
    // wins: without this the tracking status silently becomes the promotion's,
    // and nothing is ever seen as completed.
    `SELECT pt.id AS tracking_id, pt.status AS tracking_status, pt.requirement_id, pt.card_id, p.*
       FROM promotion_tracking pt JOIN promotions p ON p.id = pt.promotion_id
      WHERE pt.status <> 'dismissed' ORDER BY p.end_at IS NULL, p.end_at`
  ).all<any>();

  const out: TrackedOffer[] = [];
  for (const row of results ?? []) {
    const card = row.card_id
      ? await env.DB.prepare(`SELECT id, nickname, product FROM cards WHERE id = ?`).bind(row.card_id).first<any>()
      : null;

    let progress: TrackedOffer['progress'] = null;
    if (card && row.requirement_id) {
      const reqs = await requirementsFor(env, card.id);
      const req = reqs.find((r) => r.id === row.requirement_id);
      if (req) {
        const p = await requirementProgress(env, card, req);
        progress = {
          spent_cents: p.spent_cents,
          required_cents: req.amount_cents,
          remaining_cents: p.remaining_cents,
          days_left: p.days_left,
          met: p.met,
        };
      }
    }

    out.push({
      tracking_id: row.tracking_id,
      promotion: row as Promotion,
      card,
      progress,
      status: row.tracking_status,
    });
  }
  return out;
}

export interface CompletionReport {
  completed: { promotion_id: number; title: string; expected: string }[];
}

/**
 * Offers whose spend is done.
 *
 * Completing one writes an expected reward entry rather than crediting
 * anything: the bank has not paid yet, and it is the reconciliation's job to
 * notice if it never does. `expected_by` is what makes that possible — before
 * it the reward is pending, after it, overdue.
 */
export async function sweepCompleted(env: Env): Promise<CompletionReport> {
  const report: CompletionReport = { completed: [] };
  const now = today(env);

  for (const t of await trackedOffers(env)) {
    if (t.status !== 'tracked' || !t.progress?.met || !t.card) continue;
    const terms = termsOf(t.promotion);

    const amount = terms.reward_miles ?? terms.reward_points ?? terms.reward_cashback_cents ?? 0;
    if (amount > 0) {
      const unit = terms.reward_miles ? 'miles' : terms.reward_points ? 'points' : 'cents';
      // Banks pay campaign rewards weeks later, so "expected by" is generous:
      // calling a reward overdue on day two would make the check noise.
      const expectedBy = addDays(t.promotion.end_at ?? now, 45);
      await recordExpected(env, {
        card_id: t.card.id,
        reward_period_key: campaignPeriodKey(t.promotion.id),
        component: 'campaign_bonus',
        expected_amount: amount,
        unit,
        available_from: t.promotion.end_at ?? now,
        expected_by: expectedBy,
        source_note: `promotion #${t.promotion.id}: ${t.promotion.title}`,
      });
      report.completed.push({
        promotion_id: t.promotion.id,
        title: t.promotion.title,
        expected: `${amount.toLocaleString()} ${unit} by ${expectedBy}`,
      });
    }

    await env.DB.prepare(
      `UPDATE promotion_tracking SET status = 'completed', completed_at = ? WHERE id = ?`
    )
      .bind(now, t.tracking_id)
      .run();
  }

  return report;
}


/**
 * Turn watched offers into tracked ones, once the card exists.
 *
 * A saved acquisition offer has a threshold nobody could measure, because the
 * card it applies to was not in the wallet. Adding that card is the moment it
 * becomes measurable, and doing it here rather than asking the person to
 * remember means the offer they saved months ago starts counting by itself.
 *
 * Idempotent, and it never invents a deadline: an offer whose window has
 * already closed is left watched rather than being given a requirement that is
 * dead on arrival.
 */
export async function activateWatchedPromotions(env: Env, cardId: number): Promise<{ activated: number; notes: string[] }> {
  const card = await env.DB.prepare(`SELECT * FROM cards WHERE id = ?`).bind(cardId).first<any>();
  if (!card?.product_id) return { activated: 0, notes: [] };

  const { results } = await env.DB.prepare(
    `SELECT pt.id AS tracking_id, p.*
       FROM promotion_tracking pt
       JOIN promotions p ON p.id = pt.promotion_id
       JOIN promotion_card_products pc ON pc.promotion_id = p.id
      WHERE pt.status = 'watching' AND pc.product_id = ?`
  )
    .bind(card.product_id)
    .all<any>();

  const notes: string[] = [];
  let activated = 0;

  for (const row of results ?? []) {
    const t = termsOf(row as Promotion);
    if (!t.minimum_spend_cents) continue;

    const start = card.opened_at ?? row.start_at ?? today(env);
    const deadline = row.end_at ?? (t.window_days ? addDays(start, t.window_days) : null);
    if (!deadline || deadline < today(env)) {
      notes.push(`${row.title}: the window has closed, so nothing is being counted.`);
      continue;
    }

    const ins = await env.DB.prepare(
      `INSERT INTO requirements (card_id, kind, amount_cents, window, deadline, starts_at, min_txns, reward_note,
         source_note, promotion_id)
       VALUES (?, 'signup_min', ?, 'fixed_window', ?, ?, ?, ?, ?, ?)`
    )
      .bind(card.id, t.minimum_spend_cents, deadline, start, t.min_txns ?? null, row.title, `promotion #${row.id}`, row.id)
      .run();

    await env.DB.prepare(
      `UPDATE promotion_tracking SET status = 'tracked', card_id = ?, requirement_id = ? WHERE id = ?`
    )
      .bind(card.id, ins.meta.last_row_id, row.tracking_id)
      .run();

    activated++;
    notes.push(`${row.title}: now counting $${money(t.minimum_spend_cents)} on ${card.nickname} by ${deadline}.`);
  }

  return { activated, notes };
}
