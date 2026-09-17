import { normalizeKey } from '../merchants/normalize';
import type { CardProduct } from '../catalog/products';
import type { Env } from '../types';

/**
 * Finding a card by whatever people call it.
 *
 * Nobody types "DBS Woman's World Card". They type "wwmc", or "womans world",
 * or "dbs woman". A search that only matches the official product name fails
 * for everyone who knows the card by its nickname — which is everyone who has
 * one — and the first thing a new user does is search for their own cards.
 */

export interface CardMatch {
  product: CardProduct;
  /** Why it matched, so a surprising result is explicable. */
  matched_on: 'alias' | 'name' | 'issuer' | 'initials';
  score: number;
  /** Set when this card is already in the wallet, so it is not offered twice. */
  held_as: string | null;
}

/** Punctuation and spacing are noise here, as they are for merchants. */
export const aliasKey = (s: string) =>
  s
    .toLowerCase()
    // An apostrophe is dropped rather than turned into a space: people type
    // "womans world", and splitting the word in two means that search misses
    // the card it obviously meant.
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** "DBS Woman's World Card" → "dww", so wwmc-style shorthand has something to hit. */
export const initialsOf = (issuer: string, name: string) =>
  `${issuer} ${name}`
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w && !['card', 'the', 'and'].includes(w.toLowerCase()))
    .map((w) => w[0].toLowerCase())
    .join('');

export async function addAlias(env: Env, productId: number, alias: string, source = 'user'): Promise<void> {
  const key = aliasKey(alias);
  if (!key) return;
  await env.DB.prepare(
    `INSERT INTO card_product_aliases (alias_key, product_id, source) VALUES (?, ?, ?)
     ON CONFLICT(alias_key) DO UPDATE SET product_id = excluded.product_id, source = excluded.source`
  )
    .bind(key, productId, source)
    .run();
}

/**
 * Search the catalogue.
 *
 * An exact alias wins outright — someone typing "wwmc" means one card and
 * ranking it second would be absurd. Below that, name and issuer matches, then
 * initials, which are the loosest and are only allowed to match in full.
 */
export async function searchProducts(env: Env, query: string, limit = 12): Promise<CardMatch[]> {
  const q = aliasKey(query);
  const { results: products } = await env.DB.prepare(
    `SELECT p.*, (SELECT nickname FROM cards WHERE product_id = p.id AND closed_at IS NULL LIMIT 1) AS held_as
       FROM card_products p
      WHERE p.status = 'active' OR p.status IS NULL
      ORDER BY p.issuer, p.product_name`
  ).all<CardProduct & { held_as: string | null }>();

  const { results: aliases } = await env.DB.prepare(`SELECT alias_key, product_id FROM card_product_aliases`).all<{
    alias_key: string;
    product_id: number;
  }>();
  const aliasFor = new Map<number, string[]>();
  for (const a of aliases ?? []) {
    const list = aliasFor.get(a.product_id) ?? [];
    list.push(a.alias_key);
    aliasFor.set(a.product_id, list);
  }

  const out: CardMatch[] = [];
  for (const p of products ?? []) {
    const name = aliasKey(p.product_name);
    const issuer = aliasKey(p.issuer);
    const full = `${issuer} ${name}`;
    const list = aliasFor.get(p.id) ?? [];
    const held = (p as any).held_as ?? null;

    let matched: CardMatch['matched_on'] | null = null;
    let score = 0;

    if (!q) {
      matched = 'name';
      score = 1;
    } else if (list.includes(q)) {
      matched = 'alias';
      score = 100;
    } else if (list.some((a) => a.startsWith(q))) {
      matched = 'alias';
      score = 80;
    } else if (full.includes(q)) {
      matched = 'name';
      // An earlier match is a better one: "citi rewards" should beat a card
      // whose name merely contains those words somewhere in the middle.
      score = 60 - Math.min(20, full.indexOf(q));
    } else if (q.split(' ').every((w) => full.includes(w))) {
      matched = 'name';
      score = 30;
    } else if (issuer.includes(q)) {
      matched = 'issuer';
      score = 20;
    } else if (initialsOf(p.issuer, p.product_name) === q) {
      matched = 'initials';
      score = 15;
    }

    if (matched) out.push({ product: p, matched_on: matched, score, held_as: held });
  }

  return out
    .sort((a, b) => b.score - a.score || a.product.issuer.localeCompare(b.product.issuer))
    .slice(0, limit);
}

/**
 * Aliases worth having for every catalogue card, derived rather than typed.
 *
 * Generated from the product's own name, so a card added to the catalogue
 * tomorrow is findable the same day without anyone remembering to write its
 * nicknames down.
 */
export async function seedAliases(env: Env): Promise<{ added: number }> {
  const { results } = await env.DB.prepare(`SELECT id, issuer, product_name FROM card_products`).all<{
    id: number;
    issuer: string;
    product_name: string;
  }>();

  let added = 0;
  for (const p of results ?? []) {
    const name = aliasKey(p.product_name);
    const issuer = aliasKey(p.issuer);
    const candidates = new Set([
      name,
      `${issuer} ${name}`,
      name.replace(/ card$/, ''),
      `${issuer} ${name.replace(/ card$/, '')}`,
      initialsOf(p.issuer, p.product_name),
      // "womans world" → "wwmc": the initials of the name plus the issuer's,
      // which is the shape of nearly every Singapore card nickname.
      `${name
        .replace(/ card$/, '')
        .split(' ')
        .map((w) => w[0])
        .join('')}${issuer.split(' ').map((w) => w[0]).join('')}`,
    ]);

    for (const c of candidates) {
      if (!c || c.length < 2) continue;
      const exists = await env.DB.prepare(`SELECT product_id FROM card_product_aliases WHERE alias_key = ?`)
        .bind(c)
        .first<{ product_id: number }>();
      // An alias that two cards would both claim is no use to anyone: it would
      // send half the people who type it to the wrong card, silently.
      if (exists) {
        if (exists.product_id !== p.id) {
          await env.DB.prepare(`DELETE FROM card_product_aliases WHERE alias_key = ? AND source = 'seed'`)
            .bind(c)
            .run();
        }
        continue;
      }
      await env.DB.prepare(`INSERT INTO card_product_aliases (alias_key, product_id, source) VALUES (?, ?, 'seed')`)
        .bind(c, p.id)
        .run();
      added++;
    }
  }
  return { added };
}

/** Merchant-style normalisation, reused so both searches behave the same way. */
export const looseKey = normalizeKey;
