import { today } from '../spend';
import type { Env } from '../types';

/**
 * A promotion as a thing the app can reason about.
 *
 * The feed scanner already finds pages. What it could not do is answer "does
 * this apply to me, can I meet it, and what will it pay" — because those are
 * questions about structured terms, and a page is prose.
 */

export type PromotionType =
  | 'welcome_offer'
  | 'spend_bonus'
  | 'merchant_offer'
  | 'transfer_bonus'
  | 'annual_fee_offer'
  | 'points_conversion_offer'
  | 'category_bonus'
  | 'cardholder_offer'
  | 'bank_campaign';

export const PROMOTION_TYPES: PromotionType[] = [
  'welcome_offer',
  'spend_bonus',
  'merchant_offer',
  'transfer_bonus',
  'annual_fee_offer',
  'points_conversion_offer',
  'category_bonus',
  'cardholder_offer',
  'bank_campaign',
];

/** The machine-readable half. Everything optional: most promotions say little. */
export interface PromotionTerms {
  minimum_spend_cents?: number;
  window_days?: number;
  min_txns?: number;
  reward_miles?: number;
  reward_points?: number;
  reward_cashback_cents?: number;
  reward_pct?: number;
  cap_cents?: number;
  bonus_pct?: number;
  required_card_products?: string[];
  mccs?: string[];
  merchants?: string[];
  source_programmes?: string[];
  destination_programmes?: string[];
  [k: string]: unknown;
}

export interface Promotion {
  id: number;
  promotion_key: string | null;
  promotion_type: PromotionType;
  issuer: string | null;
  title: string;
  description: string | null;
  start_at: string | null;
  end_at: string | null;
  registration_required: number;
  source_url: string | null;
  source_type: string | null;
  retrieved_at: string | null;
  verified_at: string | null;
  status: string;
  terms_json: string | null;
  source_quote: string | null;
  confidence: string;
  duplicate_of: number | null;
  dismissed_at: string | null;
}

export const termsOf = (p: Promotion): PromotionTerms => {
  if (!p.terms_json) return {};
  try {
    return JSON.parse(p.terms_json) as PromotionTerms;
  } catch {
    return {};
  }
};

/**
 * The economic terms a promotion must have before it can be published.
 *
 * A spend bonus with no threshold, or a welcome offer with no reward, is not a
 * promotion the app can do anything with — and showing it anyway invites
 * someone to spend against a number nobody knows.
 */
export function economicTermsMissing(type: PromotionType, t: PromotionTerms): string[] {
  const missing: string[] = [];
  const paysSomething =
    t.reward_miles || t.reward_points || t.reward_cashback_cents || t.reward_pct || t.bonus_pct;

  if (type === 'welcome_offer' || type === 'spend_bonus') {
    if (!t.minimum_spend_cents) missing.push('how much has to be spent');
    if (!paysSomething) missing.push('what it pays');
  }
  if (type === 'transfer_bonus' && !t.bonus_pct) missing.push('the size of the bonus');
  if (type === 'merchant_offer' || type === 'category_bonus') {
    if (!paysSomething) missing.push('what it pays');
    if (!t.mccs?.length && !t.merchants?.length) missing.push('where it applies');
  }
  return missing;
}

export interface SaveResult {
  ok: boolean;
  id?: number;
  error?: string;
  /** Terms that stopped it being published. */
  missing?: string[];
}

/**
 * Write a promotion.
 *
 * Extraction may create drafts freely. Publishing is refused while the terms
 * that decide money are unknown — automated extraction must not turn a guess
 * into something a person plans their spending around.
 */
export async function savePromotion(
  env: Env,
  p: {
    id?: number;
    promotion_key?: string | null;
    promotion_type: PromotionType;
    issuer?: string | null;
    title: string;
    description?: string | null;
    start_at?: string | null;
    end_at?: string | null;
    registration_required?: boolean;
    source_url?: string | null;
    source_type?: string | null;
    source_quote?: string | null;
    confidence?: string;
    terms?: PromotionTerms;
    status?: string;
  }
): Promise<SaveResult> {
  if (!p.title?.trim()) return { ok: false, error: 'a title is required' };
  if (!PROMOTION_TYPES.includes(p.promotion_type)) return { ok: false, error: 'unknown promotion type' };

  const terms = p.terms ?? {};
  const status = p.status ?? 'draft';
  if (status === 'published') {
    const missing = economicTermsMissing(p.promotion_type, terms);
    if (missing.length) {
      return { ok: false, error: 'the terms that decide money are not known yet', missing };
    }
  }

  if (p.id) {
    await env.DB.prepare(
      `UPDATE promotions SET promotion_type = ?, issuer = ?, title = ?, description = ?, start_at = ?, end_at = ?,
         registration_required = ?, source_url = ?, source_type = ?, source_quote = ?, confidence = ?,
         terms_json = ?, status = ? WHERE id = ?`
    )
      .bind(
        p.promotion_type,
        p.issuer ?? null,
        p.title.trim(),
        p.description ?? null,
        p.start_at ?? null,
        p.end_at ?? null,
        p.registration_required ? 1 : 0,
        p.source_url ?? null,
        p.source_type ?? null,
        p.source_quote ?? null,
        p.confidence ?? 'medium',
        JSON.stringify(terms),
        status,
        p.id
      )
      .run();
    return { ok: true, id: p.id };
  }

  const ins = await env.DB.prepare(
    `INSERT INTO promotions
       (promotion_key, promotion_type, issuer, title, description, start_at, end_at, registration_required,
        source_url, source_type, retrieved_at, source_quote, confidence, terms_json, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      p.promotion_key ?? null,
      p.promotion_type,
      p.issuer ?? null,
      p.title.trim(),
      p.description ?? null,
      p.start_at ?? null,
      p.end_at ?? null,
      p.registration_required ? 1 : 0,
      p.source_url ?? null,
      p.source_type ?? null,
      today(env),
      p.source_quote ?? null,
      p.confidence ?? 'medium',
      JSON.stringify(terms),
      status
    )
    .run();
  return { ok: true, id: ins.meta.last_row_id };
}

export async function publishPromotion(env: Env, id: number): Promise<SaveResult> {
  const p = await env.DB.prepare(`SELECT * FROM promotions WHERE id = ?`).bind(id).first<Promotion>();
  if (!p) return { ok: false, error: 'no such promotion' };

  const missing = economicTermsMissing(p.promotion_type, termsOf(p));
  if (missing.length) return { ok: false, error: 'the terms that decide money are not known yet', missing };

  await env.DB.prepare(`UPDATE promotions SET status = 'published', verified_at = ? WHERE id = ?`)
    .bind(today(env), id)
    .run();
  return { ok: true, id };
}

/** Link a promotion to the cards, programmes, merchants or codes it applies to. */
export async function linkApplicability(
  env: Env,
  id: number,
  links: {
    product_keys?: string[];
    programmes?: { key: string; role?: 'source' | 'destination' }[];
    merchants?: string[];
    mccs?: string[];
  }
): Promise<void> {
  for (const key of links.product_keys ?? []) {
    const product = await env.DB.prepare(`SELECT id FROM card_products WHERE product_key = ?`)
      .bind(key)
      .first<{ id: number }>();
    if (!product) continue;
    await env.DB.prepare(`INSERT OR IGNORE INTO promotion_card_products (promotion_id, product_id) VALUES (?, ?)`)
      .bind(id, product.id)
      .run();
  }
  for (const p of links.programmes ?? []) {
    await env.DB.prepare(`INSERT OR IGNORE INTO promotion_programmes (promotion_id, program_key, role) VALUES (?, ?, ?)`)
      .bind(id, p.key, p.role ?? 'source')
      .run();
  }
  for (const m of links.merchants ?? []) {
    await env.DB.prepare(`INSERT OR IGNORE INTO promotion_merchants (promotion_id, merchant_key) VALUES (?, ?)`)
      .bind(id, m.toLowerCase().trim())
      .run();
  }
  for (const c of links.mccs ?? []) {
    if (!/^\d{4}$/.test(c)) continue;
    await env.DB.prepare(`INSERT OR IGNORE INTO promotion_mccs (promotion_id, mcc) VALUES (?, ?)`).bind(id, c).run();
  }
}

/**
 * Promotions that have run out.
 *
 * Marked expired rather than deleted: a tracked requirement and a reconciled
 * reward both point back at the promotion that caused them, and deleting it
 * would leave those unexplainable.
 */
export async function expirePromotions(env: Env): Promise<{ expired: number }> {
  const r = await env.DB.prepare(
    `UPDATE promotions SET status = 'expired'
      WHERE status = 'published' AND end_at IS NOT NULL AND end_at < ?`
  )
    .bind(today(env))
    .run();
  return { expired: r.meta.changes };
}
