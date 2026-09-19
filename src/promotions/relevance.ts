import { money, today } from '../spend';
import type { Card, Env } from '../types';
import { audienceOf, type PromotionAudience } from './audience';
import { evaluatePromotionEligibility, type PromotionEligibility } from './eligibility';
import { termsOf, type Promotion, type PromotionTerms } from './model';
import { resolvePromotionRelationship, type PromotionRelationship } from './relationship';
import { invitedKeys, spread, variantsFor, viewVariants, type VariantView } from './variants';

export type { PromotionAudience, PromotionEligibility, PromotionRelationship };

/**
 * Which promotions are worth showing this person.
 *
 * A feed of every offer every bank is running is not a feature — it is a list
 * nobody reads, and the two offers that actually mattered are buried in it. So
 * relevance is a judgement about THIS wallet and THIS spending, and the answer
 * always comes with the reason, because "why am I seeing this" must have one.
 */

/**
 * How useful it is to surface this offer — a ranking, and only that.
 *
 * `not_applicable` is gone. It was doing two jobs: "this cannot be used" and
 * "this is not worth showing", and conflating them is what made a welcome
 * offer on a card you do not hold look like a rejection. Whether an offer can
 * be used is now eligibility's answer.
 */
export type PromotionRelevance = 'high' | 'medium' | 'low' | 'not_relevant';

/** The old name, still exported so nothing importing it breaks. */
export type Relevance = PromotionRelevance | 'not_applicable';

export interface RelevantPromotion {
  promotion: Promotion;
  terms: PromotionTerms;

  /** Who the offer is for, as far as anyone has established. */
  audience: PromotionAudience;

  /** How it relates to this person. Not whether they qualify. */
  relationship: PromotionRelationship;

  /** Whether they can qualify. Computed from their own card history. */
  eligibility: {
    status: PromotionEligibility;
    confirmed: string[];
    unresolved: string[];
    failed: string[];
  };

  /** Whether it is worth showing. Ranking only — it encodes no ownership. */
  relevance: PromotionRelevance;

  /**
   * The pre-redesign value, derived rather than decided.
   *
   * Kept so a client deployed against the old contract keeps working across a
   * deploy. It is not the source of truth and nothing in this app reads it.
   */
  legacy_relevance: Relevance;

  /** In the person's own terms: what makes it apply to them. */
  why: string[];
  /** What stops it applying, when it does not. */
  blockers: string[];

  /** Every product the offer concerns — which is not "products you must own". */
  linked_products: { product_id: number; product_name: string; issuer: string }[];
  /** The card being offered, when this is an acquisition opportunity. */
  acquisition_product: { product_id: number; product_name: string } | null;

  days_left: number | null;
  /** The card it would apply to, when exactly one is held. */
  card: { id: number; nickname: string; product: string } | null;
  /** True when the threshold looks reachable from how they normally spend. */
  reachable: boolean | null;
  monthly_spend_cents: number | null;
  tracked: boolean;
  /** The shapes this offer comes in, when it comes in more than one. */
  variants: VariantView[];
  /** What it pays across those shapes — a range when they disagree. */
  pays: string | null;
  /** True when the variants do not agree, so the headline is a range. */
  pays_varies: boolean;
  /** How sure the relationship is, given what the audience established. */
  confidence: 'high' | 'medium' | 'low';
  /** How sure the app is that this is still true, and why. */
  currency: PromotionCurrency;
}

/**
 * How current the app believes this offer to be.
 *
 * Shown rather than hidden: discovery reads publications, publications are
 * sometimes wrong or late, and an offer nobody has checked in two months is
 * worth a different sentence from one the bank's own page confirmed today.
 */
export interface PromotionCurrency {
  state: string;
  /** A sentence a person can act on. */
  text: string;
  /** How many independent sites said this. */
  independent_sources: number;
  last_verified_at: string | null;
  days_since_verified: number | null;
  /** True when it is old enough to be worth re-reading the bank's page. */
  stale: boolean;
}

/** Past this many days without a check, an offer is called stale. */
export const RECHECK_DAYS = 30;

export function currencyOf(p: Promotion, now: string): PromotionCurrency {
  const verified = (p as unknown as { last_verified_at?: string | null }).last_verified_at ?? p.verified_at ?? null;
  const state = (p as unknown as { verification_state?: string }).verification_state ?? 'single_source';
  const sources = (p as unknown as { independent_sources?: number }).independent_sources ?? 0;
  const days = verified ? Math.round((Date.parse(now) - Date.parse(verified)) / 86_400_000) : null;
  const stale = days === null || days > RECHECK_DAYS;

  const when = days === null ? 'never checked' : days <= 0 ? 'checked today' : `checked ${days} day${days === 1 ? '' : 's'} ago`;
  const text =
    state === 'official_verified'
      ? `The bank's own page said this — ${when}.`
      : state === 'secondary_verified'
        ? `${sources} independent sites agree on this — ${when}. Nobody has read it off the bank's page.`
        : state === 'conflicting'
          ? 'Sources disagree about the terms. Check the bank before relying on it.'
          : state === 'expired'
            ? 'This has ended.'
            : state === 'needs_review'
              ? 'Waiting to be checked by a person.'
              : `One source said this — ${when}. Treat the numbers as a lead, not a promise.`;

  return { state, text, independent_sources: sources, last_verified_at: verified, days_since_verified: days, stale };
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
/**
 * Rate one promotion against this wallet.
 *
 * Four questions, answered in order and kept apart, because the model this
 * replaces answered them as one and got the first one wrong:
 *
 *   audience      who is the offer for?
 *   relationship  how does it relate to this person?
 *   eligibility   can they qualify?
 *   relevance     is it worth showing?
 *
 * Owning the card is no longer an input to relevance at all. It feeds the
 * relationship, and the relationship plus the audience decide whether not
 * owning it is a disqualification (an existing-cardholder offer), the point
 * (a welcome offer), or beside the point (a transfer bonus).
 */
export async function rate(env: Env, p: Promotion): Promise<RelevantPromotion> {
  const t = termsOf(p);
  const now = today(env);
  const audience = audienceOf(t as Record<string, unknown>);

  const days = p.end_at ? Math.round((Date.parse(p.end_at) - Date.parse(now)) / 86_400_000) : null;

  const { results: linked } = await env.DB.prepare(
    `SELECT pc.product_id, cp.product_name, cp.issuer, cp.product_key
       FROM promotion_card_products pc JOIN card_products cp ON cp.id = pc.product_id
      WHERE pc.promotion_id = ?`
  )
    .bind(p.id)
    .all<{ product_id: number; product_name: string; issuer: string | null; product_key: string }>();
  const linkedProducts = linked ?? [];

  const { results: heldCards } = await env.DB.prepare(
    `SELECT c.id, c.nickname, c.product FROM cards c
       JOIN promotion_card_products pc ON pc.product_id = c.product_id
      WHERE pc.promotion_id = ? AND c.closed_at IS NULL`
  )
    .bind(p.id)
    .all<{ id: number; nickname: string; product: string }>();

  // The whole wallet, open and closed. Closed cards matter: a new-to-bank rule
  // is about what you have held, not only what you hold.
  const { results: allCards } = await env.DB.prepare(`SELECT * FROM cards`).all<Card>();

  const { results: linkedProgs } = await env.DB.prepare(
    `SELECT program_key FROM promotion_programmes WHERE promotion_id = ?`
  )
    .bind(p.id)
    .all<{ program_key: string }>();
  const { results: heldProgs } = await env.DB.prepare(
    `SELECT DISTINCT program_key FROM balance_tranches WHERE points > 0`
  ).all<{ program_key: string }>();

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

  const invited = await invitedKeys(env, p.id);

  // --- 1. how it relates ---------------------------------------------------
  const rel = resolvePromotionRelationship({
    promotion: p,
    terms: t,
    audience,
    linkedProducts: linkedProducts.map((l) => ({ product_id: l.product_id, product_name: l.product_name, issuer: l.issuer })),
    linkedProgrammes: (linkedProgs ?? []).map((r) => r.program_key),
    userCards: allCards ?? [],
    userProgrammes: (heldProgs ?? []).map((r) => r.program_key),
    invitedKeys: invited,
  });

  const why = [...rel.reasons];
  const blockers = [...rel.blockers];

  // --- 2. whether they can qualify ----------------------------------------
  const eligibility = evaluatePromotionEligibility({
    env,
    audience,
    relationship: rel.relationship,
    linkedProducts: linkedProducts.map((l) => ({ product_id: l.product_id, product_name: l.product_name, issuer: l.issuer })),
    productKeys: linkedProducts.map((l) => l.product_key).filter(Boolean),
    issuer: p.issuer ?? linkedProducts.find((l) => l.issuer)?.issuer ?? null,
    cards: allCards ?? [],
    invited: invited.length > 0,
    relationshipBlockers: rel.blockers,
  });

  // --- 3. spending, for thresholds ----------------------------------------
  const spend = await monthlySpend(env, {
    mccs: (mccs ?? []).map((m) => m.mcc),
    merchants: (merchants ?? []).map((m) => m.merchant_key),
  });

  let reachable: boolean | null = null;
  if (t.minimum_spend_cents && spend !== null) {
    const window = t.window_days ?? days ?? 30;
    const likely = Math.round((spend / 30) * Math.max(1, window));
    reachable = likely >= t.minimum_spend_cents;
    if (spend > 0) why.push(`You normally spend about $${money(spend)} a month where this applies.`);
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

  // The shapes this offer comes in.
  const vs = await variantsFor(env, p.id);
  const views = viewVariants(vs, {
    holds_card: !!heldCards?.length,
    existing_customer: await banksWith(env, p.issuer),
    invited_keys: invited,
  });
  const range = spread(vs, Number(env.MILE_VALUE_CENTS ?? 1.5));
  if (views.length > 1 && range.varies && views.some((v) => v.available)) {
    why.push('What it pays depends on how you apply.');
  }
  if (views.length && !views.some((v) => v.available)) {
    blockers.push(views[0].blocker ?? 'No version of this offer is open to you.');
  }
  if (views.some((v) => v.available && v.variant.audience === 'targeted')) {
    why.push('You told us you were sent this one.');
  }

  // --- 4. whether it is worth showing -------------------------------------
  const relevance = scoreRelevance({
    promotion: p,
    relationship: rel.relationship,
    eligibility: eligibility.status,
    tracked,
    reachable,
    spend,
    days,
    dismissed: !!p.dismissed_at,
    published: p.status === 'published',
    hasProgrammeBalance: rel.has_programme_balance ?? false,
  });

  if (!why.length && !blockers.length) {
    // Said in terms of what was checked. "It applies to any cardholder" was a
    // claim about the bank's rules made from the app's own silence.
    why.push('No card-specific ownership requirement was identified.');
  }

  const acquisitionProduct =
    rel.relationship === 'acquisition_opportunity' && rel.acquisition_product_ids.length
      ? linkedProducts.find((l) => l.product_id === rel.acquisition_product_ids[0]) ?? null
      : null;

  return {
    promotion: p,
    terms: t,
    audience,
    relationship: rel.relationship,
    eligibility: {
      status: eligibility.status,
      confirmed: eligibility.confirmed,
      unresolved: eligibility.unresolved,
      failed: eligibility.failed,
    },
    relevance,
    // The old field name, kept so nothing consuming it breaks mid-deploy. It
    // is derived from the new model rather than being its own opinion.
    legacy_relevance: relevance === 'not_relevant' ? 'not_applicable' : relevance,
    why,
    blockers,
    linked_products: linkedProducts.map((l) => ({
      product_id: l.product_id,
      product_name: l.product_name,
      issuer: l.issuer ?? '',
    })),
    acquisition_product: acquisitionProduct
      ? { product_id: acquisitionProduct.product_id, product_name: acquisitionProduct.product_name }
      : null,
    days_left: days,
    card: heldCards?.length === 1 ? heldCards[0] : null,
    reachable,
    monthly_spend_cents: spend,
    tracked,
    variants: views,
    pays: range.text,
    pays_varies: range.varies,
    confidence: rel.confidence,
    currency: currencyOf(p, now),
  };
}

/**
 * How useful it is to surface this, given everything already decided.
 *
 * Ranking only. It reads the relationship and the eligibility rather than
 * re-deriving them, so there is one place that knows what "not for you" means
 * and this is not it.
 */
export function scoreRelevance(x: {
  promotion: Pick<Promotion, 'promotion_type'>;
  relationship: PromotionRelationship;
  eligibility: PromotionEligibility;
  tracked: boolean;
  reachable: boolean | null;
  spend: number | null;
  days: number | null;
  dismissed: boolean;
  published: boolean;
  /** For a programme offer: whether there are points it could actually move. */
  hasProgrammeBalance?: boolean;
}): PromotionRelevance {
  if (!x.published || x.dismissed || (x.days !== null && x.days < 0)) return 'not_relevant';

  // Ineligible is the one verdict that removes an offer outright, and it is
  // computed rather than inferred from what the person owns.
  if (x.eligibility === 'ineligible') return 'not_relevant';
  if (x.relationship === 'not_relevant') return 'not_relevant';

  if (x.tracked) return 'high';

  switch (x.relationship) {
    case 'acquisition_opportunity':
      // Worth a look, but never automatically the top of the list: taking one
      // costs a hard pull, and the app has not checked the bank's conditions.
      return x.eligibility === 'eligible' || (x.eligibility === 'potentially_eligible' && x.reachable === true)
        ? 'high'
        : 'medium';

    case 'held_card':
      if (x.reachable === true) return 'high';
      if (x.reachable === false) return 'medium';
      return 'high';

    case 'issuer_offer':
      return x.reachable === false ? 'medium' : 'high';

    case 'programme_offer':
      // Ranked on the balance the offer could actually move, not on card
      // spending — a transfer bonus is about points that already exist. No
      // balance ranks it low and never calls it ineligible: a balance is a
      // number that changes, and the offer is still the offer.
      return x.hasProgrammeBalance ? 'high' : 'low';

    case 'targeted_offer':
      return 'medium';

    case 'general_offer':
      return x.spend !== null && x.spend > 0 ? 'medium' : 'low';

    case 'unknown':
      // Never high. The app does not know who it is for.
      return 'low';

    default:
      return 'low';
  }
}


/**
 * Whether this person already banks with an issuer.
 *
 * Read from the cards they hold rather than asked: a question whose answer is
 * already in the database is a question not worth asking.
 */
async function banksWith(env: Env, issuer: string | null): Promise<boolean> {
  if (!issuer) return false;
  const row = await env.DB.prepare(
    `SELECT c.id FROM cards c WHERE c.closed_at IS NULL AND LOWER(c.issuer) = LOWER(?) LIMIT 1`
  )
    .bind(issuer)
    .first();
  return !!row;
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
    if (r.relevance !== 'not_relevant') out.push(r);
  }
  return out;
}
