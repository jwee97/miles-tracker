import type { Env } from '../types';

/**
 * Where a product's numbers came from.
 *
 * A reward rate is a claim about a bank's terms, and a claim with no source is
 * indistinguishable from a guess six months later. So every version can name
 * the document it was read out of, when it was read, and a hash of what it said
 * at the time — which is what makes "has this page changed since?" a question
 * the app can answer instead of one a person has to remember to ask.
 */

export type SourceType = 'bank_product_page' | 'bank_terms' | 'bank_rewards_terms' | 'bank_faq' | 'manual_verified';

export const SOURCE_TYPES: SourceType[] = [
  'bank_product_page',
  'bank_terms',
  'bank_rewards_terms',
  'bank_faq',
  'manual_verified',
];

/** Official bank documents outrank everything else. */
export const SOURCE_RANK: Record<string, number> = {
  bank_terms: 5,
  bank_rewards_terms: 4,
  bank_product_page: 3,
  bank_faq: 2,
  manual_verified: 1,
};

export interface ProductSource {
  id: number;
  product_id: number;
  source_type: string;
  source_url: string;
  title: string | null;
  retrieved_at: string;
  effective_from: string | null;
  effective_until: string | null;
  content_hash: string | null;
  active: number;
}

/** A stable fingerprint of a page's text, so a change is detectable. */
export function contentHash(text: string): string {
  // Whitespace and case are not content: a page reflowed by its CMS has not
  // changed its terms, and reporting that it has would train people to ignore
  // the warning.
  const s = text.replace(/\s+/g, ' ').trim().toLowerCase();
  let h1 = 2166136261;
  let h2 = 5381;
  for (let i = 0; i < s.length; i++) {
    h1 ^= s.charCodeAt(i);
    h1 = Math.imul(h1, 16777619);
    h2 = (h2 * 33) ^ s.charCodeAt(i);
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
}

export async function addSource(
  env: Env,
  productId: number,
  s: {
    source_type: SourceType | string;
    source_url: string;
    title?: string | null;
    retrieved_at: string;
    effective_from?: string | null;
    content_hash?: string | null;
  }
): Promise<ProductSource> {
  const ins = await env.DB.prepare(
    `INSERT INTO product_sources
       (product_id, source_type, source_url, title, retrieved_at, effective_from, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      productId,
      s.source_type,
      s.source_url,
      s.title ?? null,
      s.retrieved_at,
      s.effective_from ?? null,
      s.content_hash ?? null
    )
    .run();

  const made = await env.DB.prepare(`SELECT * FROM product_sources WHERE id = ?`)
    .bind(ins.meta.last_row_id)
    .first<ProductSource>();
  if (!made) throw new Error('could not record the source');
  return made;
}

export async function sourcesFor(env: Env, productId: number): Promise<ProductSource[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM product_sources WHERE product_id = ? AND active = 1 ORDER BY retrieved_at DESC, id DESC`
  )
    .bind(productId)
    .all<ProductSource>();
  return (results ?? []).sort(
    (a, b) =>
      (SOURCE_RANK[b.source_type] ?? 0) - (SOURCE_RANK[a.source_type] ?? 0) ||
      b.retrieved_at.localeCompare(a.retrieved_at)
  );
}

export interface SourceChange {
  source: ProductSource;
  changed: boolean;
  /** Null when the source was recorded without a hash to compare against. */
  previous_hash: string | null;
  new_hash: string;
}

/**
 * Has the page changed since it was read?
 *
 * Answering yes does not change any rule. It marks the product as needing
 * review and leaves the published version exactly as it is, because automated
 * extraction that silently overwrites production rules is the one failure mode
 * this whole layer exists to prevent.
 */
export async function checkSource(env: Env, sourceId: number, text: string, today: string): Promise<SourceChange | null> {
  const source = await env.DB.prepare(`SELECT * FROM product_sources WHERE id = ?`)
    .bind(sourceId)
    .first<ProductSource>();
  if (!source) return null;

  const hash = contentHash(text);
  const changed = !!source.content_hash && source.content_hash !== hash;

  await env.DB.prepare(`UPDATE product_sources SET content_hash = ?, retrieved_at = ? WHERE id = ?`)
    .bind(hash, today, sourceId)
    .run();

  if (changed) {
    await env.DB.prepare(
      `UPDATE card_products SET verification_status = 'needs_review' WHERE id = ? AND verification_status <> 'draft'`
    )
      .bind(source.product_id)
      .run();
  }

  return { source, changed, previous_hash: source.content_hash, new_hash: hash };
}
