import { money, today } from '../spend';
import type { Env } from '../types';
import { termsOf, type Promotion, type PromotionTerms } from './model';

/**
 * Which promotions are worth showing this person.
 *
 * A feed of every offer every bank is running is not a feature — it is a list
 * nobody reads, and the two offers that actually mattered are buried in it. So
 * relevance is a judgement about THIS wallet and THIS spending, and the answer
 * always comes with the reason, because "why am I seeing this" must have one.
 */

export type Relevance = 'high' | 'medium' | 'low' | 'not_applicable';

export interface RelevantPromotion {
  promotion: Promotion;
  terms: PromotionTerms;
  relevance: Relevance;
  /** In the person's own terms: what makes it apply to them. */
  why: string[];
  /** What stops it applying, when it does not. */
  blockers: string[];
  days_left: number | null;
  /** The card it would apply to, when exactly one does. */
  card: { id: number; nickname: string; product: string } | null;
  /** True when the threshold looks reachable from how they normally spend. */
  reachable: boolean | null;
  monthly_spend_cents: number | null;
  tracked: boolean;
}

/** Below this many days an offer is usually not worth starting. */
export const TOO_LATE_DAYS = 3;

/** Average monthly spend in a category or code, over the last few months. */
async function monthlySpend(env: Env, opts: { mccs?: string[]; merchants?: string[] }): Promise<number | null> {
  const since = new Date(Date.parse(`${today(env)}T00:00:00Z`) - 90 * 86_400_000).toISOString().slice(0, 10);
  const wheres: string[] = [`amount_cents > 0`, `COALESCE(posted_at, occurred_at) >= ?`];
  const args: unknown[] = [since];

  if (opts.mccs?.length) {
    wheres.push(`mcc IN (${opts.mccs.map(() => '?').join(',')})`);
    args.push(...opts.mccs);
  } else if (opts.merchants?.length) {
    wheres.push(`(${opts.merchants.map(() => `LOWER(merchant) LIKE ?`).join(' OR ')})`);
    args.push(...opts.merchants.map((m) => `%${m.toLowerCase()}%`));
  } else {
    return null;
  }

  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS total, COUNT(*) AS n FROM transactions WHERE ${wheres.join(' AND ')}`
  )
    .bind(...args)
    .first<{ total: number; n: number }>();
  if (!row?.n) return 0;
  return Math.round(row.total / 3);
}

/**
 * Rate one promotion against this wallet.
 *
 * Owning the card is the strongest signal there is; without it most offers are
 * simply not applicable, and saying so is more useful than ranking them low.
 */
export async function rate(env: Env, p: Promotion): Promise<RelevantPromotion> {
  const t = termsOf(p);
  const now = today(env);
  const why: string[] = [];
  const blockers: string[] = [];

  const days = p.end_at ? Math.round((Date.parse(p.end_at) - Date.parse(now)) / 86_400_000) : null;

  const { results: cards } = await env.DB.prepare(
    `SELECT c.id, c.nickname, c.product FROM cards c
       JOIN promotion_card_products pc ON pc.product_id = c.product_id
      WHERE pc.promotion_id = ? AND c.closed_at IS NULL`
  )
    .bind(p.id)
    .all<{ id: number; nickname: string; product: string }>();

  const { results: linkedCards } = await env.DB.prepare(
    `SELECT product_id FROM promotion_card_products WHERE promotion_id = ?`
  )
    .bind(p.id)
    .all<{ product_id: number }>();

  const { results: progs } = await env.DB.prepare(
    `SELECT pp.program_key FROM promotion_programmes pp
      WHERE pp.promotion_id = ?
        AND EXISTS (SELECT 1 FROM balance_tranches b WHERE b.program_key = pp.program_key AND b.points > 0)`
  )
    .bind(p.id)
    .all<{ program_key: string }>();

  const { results: mccs } = await env.DB.prepare(`SELECT mcc FROM promotion_mccs WHERE promotion_id = ?`)
    .bind(p.id)
    .all<{ mcc: string }>();
  const { results: merchants } = await env.DB.prepare(
    `SELECT merchant_key FROM promotion_merchants WHERE promotion_id = ?`
  )
    .bind(p.id)
    .all<{ merchant_key: string }>();

  const tracked = !!(await env.DB.prepare(
    `SELECT id FROM promotion_tracking WHERE promotion_id = ? AND status <> 'dismissed'`
  )
    .bind(p.id)
    .first());

  if (cards?.length) why.push(`You hold ${cards.map((c) => c.product).join(' and ')}.`);
  if (progs?.length) why.push(`You have points in ${progs.map((x) => x.program_key).join(', ')}.`);

  const spend = await monthlySpend(env, {
    mccs: (mccs ?? []).map((m) => m.mcc),
    merchants: (merchants ?? []).map((m) => m.merchant_key),
  });

  let reachable: boolean | null = null;
  if (t.minimum_spend_cents && spend !== null) {
    const window = t.window_days ?? (days ?? 30);
    const likely = Math.round((spend / 30) * Math.max(1, window));
    reachable = likely >= t.minimum_spend_cents;
    if (spend > 0) {
      why.push(`You normally spend about $${money(spend)} a month where this applies.`);
    }
    if (!reachable) {
      blockers.push(
        `It needs $${money(t.minimum_spend_cents)}; at your usual rate that window would reach about $${money(likely)}.`
      );
    }
  } else if (spend !== null && spend > 0) {
    why.push(`You normally spend about $${money(spend)} a month where this applies.`);
  }

  if (p.status !== 'published') blockers.push('Not published yet.');
  if (p.dismissed_at) blockers.push('You set this aside.');
  if (days !== null && days < 0) blockers.push('It has ended.');
  else if (days !== null && days <= TOO_LATE_DAYS) blockers.push(`Only ${days} day${days === 1 ? '' : 's'} left.`);
  if (p.registration_required) why.push('Registration required.');

  // A card-specific offer for a card nobody holds is not a low-relevance offer;
  // it is not an offer for this person at all, and saying so is more useful
  // than ranking it.
  const needsCard = (linkedCards ?? []).length > 0;
  let relevance: Relevance;
  if (p.dismissed_at || p.status !== 'published' || (days !== null && days < 0)) relevance = 'not_applicable';
  else if (needsCard && !cards?.length) relevance = 'not_applicable';
  else if (tracked) relevance = 'high';
  else if ((cards?.length && reachable !== false) || (progs?.length && p.promotion_type === 'transfer_bonus')) {
    relevance = reachable === true || spend === null ? 'high' : 'medium';
  } else if (cards?.length || progs?.length) relevance = 'medium';
  else if (spend && spend > 0) relevance = 'medium';
  else relevance = 'low';

  if (relevance !== 'not_applicable' && !why.length) {
    why.push('It applies to any cardholder.');
  }

  return {
    promotion: p,
    terms: t,
    relevance,
    why,
    blockers,
    days_left: days,
    card: cards?.length === 1 ? cards[0] : null,
    reachable,
    monthly_spend_cents: spend,
    tracked,
  };
}

export interface Inbox {
  worth_checking: RelevantPromotion[];
  ending_soon: RelevantPromotion[];
  your_cards: RelevantPromotion[];
  transfers: RelevantPromotion[];
  everything: RelevantPromotion[];
  as_of: string;
}

/** Inside this many days an offer counts as ending soon. */
export const ENDING_SOON_DAYS = 14;

/**
 * The inbox, in sections.
 *
 * Sectioned rather than sorted into one list, because "ending soon" and "worth
 * checking" are different reasons to look and mixing them means neither reads
 * as urgent.
 */
export async function inbox(env: Env): Promise<Inbox> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM promotions WHERE duplicate_of IS NULL AND status IN ('published', 'expired')
      ORDER BY end_at IS NULL, end_at`
  ).all<Promotion>();

  const rated: RelevantPromotion[] = [];
  for (const p of results ?? []) rated.push(await rate(env, p));

  const live = rated.filter((r) => r.relevance !== 'not_applicable');
  return {
    worth_checking: live.filter((r) => r.relevance === 'high'),
    ending_soon: live.filter((r) => r.days_left !== null && r.days_left >= 0 && r.days_left <= ENDING_SOON_DAYS),
    your_cards: live.filter((r) => r.card !== null),
    transfers: live.filter((r) => r.promotion.promotion_type === 'transfer_bonus'),
    everything: rated,
    as_of: today(env),
  };
}

/**
 * Offers relevant to a purchase being considered right now.
 *
 * Shown beside the recommendation, never folded into it: a campaign does not
 * change what the card's rules pay, and quietly adding it to the rate would
 * make the recommendation unreproducible.
 */
export async function forPurchase(
  env: Env,
  purchase: { mcc?: string | null; merchant?: string | null }
): Promise<RelevantPromotion[]> {
  const conditions: string[] = [];
  const args: unknown[] = [];
  if (purchase.mcc) {
    conditions.push(`EXISTS (SELECT 1 FROM promotion_mccs m WHERE m.promotion_id = p.id AND m.mcc = ?)`);
    args.push(purchase.mcc);
  }
  if (purchase.merchant) {
    conditions.push(
      `EXISTS (SELECT 1 FROM promotion_merchants pm WHERE pm.promotion_id = p.id AND LOWER(?) LIKE '%' || pm.merchant_key || '%')`
    );
    args.push(purchase.merchant);
  }
  if (!conditions.length) return [];

  const now = today(env);
  const { results } = await env.DB.prepare(
    `SELECT p.* FROM promotions p
      WHERE p.status = 'published' AND p.duplicate_of IS NULL
        AND (p.end_at IS NULL OR p.end_at >= ?)
        AND (${conditions.join(' OR ')})
      ORDER BY p.end_at IS NULL, p.end_at`
  )
    .bind(now, ...args)
    .all<Promotion>();

  const out: RelevantPromotion[] = [];
  for (const p of results ?? []) {
    const r = await rate(env, p);
    if (r.relevance !== 'not_applicable') out.push(r);
  }
  return out;
}
