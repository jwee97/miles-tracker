import type { Env } from '../types';

/**
 * Card products: what a card IS, separately from what you hold.
 *
 * "4 mpd on online spend" is a fact about the DBS Woman's World Card, true for
 * everyone who holds one. "The limit is $12,000 and it closes on the 12th" is a
 * fact about your card. Keeping them in one table meant the first could never
 * be shared between holders, corrected in one place, or given a date.
 */

export interface CardProduct {
  id: number;
  product_key: string;
  issuer: string;
  product_name: string;
  network: string | null;
  card_type: string;
  currency: string;
  reward_type: string;
  program_key: string | null;
  base_mpd: number | null;
  base_cashback_pct: number | null;
  annual_fee_cents: number | null;
  official_url: string | null;
  status: string;
  /** catalog | user | imported — a custom card is still a product. */
  source: string;
  /** verified | needs_review | stale | draft | migrated_unverified */
  verification_status: string;
  last_verified_at: string | null;
}

/** How long a product's numbers are trusted before they are called stale. */
export const STALE_AFTER_DAYS = 180;

export async function productByKey(env: Env, key: string): Promise<CardProduct | null> {
  return (
    (await env.DB.prepare(`SELECT * FROM card_products WHERE product_key = ?`).bind(key).first<CardProduct>()) ?? null
  );
}

export async function productById(env: Env, id: number): Promise<CardProduct | null> {
  return (await env.DB.prepare(`SELECT * FROM card_products WHERE id = ?`).bind(id).first<CardProduct>()) ?? null;
}

export async function listProducts(env: Env, q = ''): Promise<CardProduct[]> {
  const like = `%${q.trim().toLowerCase()}%`;
  const { results } = await env.DB.prepare(
    `SELECT * FROM card_products
      WHERE (? = '%%' OR LOWER(issuer || ' ' || product_name || ' ' || product_key) LIKE ?)
      ORDER BY status = 'discontinued', issuer, product_name`
  )
    .bind(like, like)
    .all<CardProduct>();
  return results ?? [];
}

export interface NewProduct {
  product_key: string;
  issuer: string;
  product_name: string;
  network?: string | null;
  card_type?: string;
  reward_type?: string;
  program_key?: string | null;
  base_mpd?: number | null;
  base_cashback_pct?: number | null;
  annual_fee_cents?: number | null;
  official_url?: string | null;
  source?: string;
  verification_status?: string;
}

/**
 * Create a product, or return the one already holding that key.
 *
 * Idempotent on purpose: the migration runs on every deploy, and a second run
 * must find the products the first made rather than fail or duplicate them.
 */
export async function ensureProduct(env: Env, p: NewProduct): Promise<CardProduct> {
  const existing = await productByKey(env, p.product_key);
  if (existing) return existing;

  await env.DB.prepare(
    `INSERT INTO card_products (product_key, issuer, product_name, network, card_type, reward_type,
       program_key, base_mpd, base_cashback_pct, annual_fee_cents, official_url, source, verification_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(product_key) DO NOTHING`
  )
    .bind(
      p.product_key,
      p.issuer,
      p.product_name,
      p.network ?? null,
      p.card_type ?? 'credit',
      p.reward_type ?? 'miles',
      p.program_key ?? null,
      p.base_mpd ?? null,
      p.base_cashback_pct ?? null,
      p.annual_fee_cents ?? null,
      p.official_url ?? null,
      p.source ?? 'catalog',
      p.verification_status ?? 'draft'
    )
    .run();

  const made = await productByKey(env, p.product_key);
  if (!made) throw new Error(`could not create product ${p.product_key}`);
  return made;
}

/**
 * Whether a product's numbers are old enough to be worth saying so about.
 *
 * Never a reason to refuse a recommendation — an unverified rate is usually
 * still the best information there is — only a reason to lower its confidence.
 */
export function isStale(p: CardProduct, today: string, days = STALE_AFTER_DAYS): boolean {
  if (p.verification_status === 'stale' || p.verification_status === 'needs_review') return true;
  if (!p.last_verified_at) return p.verification_status !== 'verified';
  const age = (Date.parse(today) - Date.parse(p.last_verified_at)) / 86_400_000;
  return age > days;
}

/** A key a product can be found by, from an issuer and product name. */
export const productKeyOf = (issuer: string, product: string) =>
  `${issuer}_${product}`.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
