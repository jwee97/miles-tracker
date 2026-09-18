import { aliasKey, searchProducts } from '../../onboarding/search';
import type { Env } from '../../types';

/**
 * Which card an article is talking about.
 *
 * Publications write "Citi Rewards", "Citibank Rewards Card", "CRMC" and
 * "Citi Rewards Visa Signature" for one product. The alias table built during
 * onboarding already knows those, so entity resolution reuses it rather than
 * inventing a second matcher that would drift from the first.
 *
 * Both names are kept. The raw one is what the article said; the resolved id is
 * what the app believes it meant, and keeping only the second makes a wrong
 * match impossible to spot afterwards.
 */

export interface Resolution {
  raw_product_name: string;
  resolved_product_id: number | null;
  resolved_name: string | null;
  confidence: 'high' | 'medium' | 'low';
  /** Set when the app could not tell, which is a review reason, not a guess. */
  needs_review: boolean;
  alternatives: { id: number; name: string }[];
}

/**
 * Resolve one name.
 *
 * An exact alias is trusted outright. A search match is trusted only when it is
 * clearly ahead of the runner-up: two cards from one issuer with similar names
 * is exactly the case where guessing sends a promotion to the wrong card, and a
 * wrong card is worse than an unresolved one.
 */
export async function resolveProduct(env: Env, raw: string, issuer?: string | null): Promise<Resolution> {
  const name = raw.trim();
  const empty: Resolution = {
    raw_product_name: name,
    resolved_product_id: null,
    resolved_name: null,
    confidence: 'low',
    needs_review: true,
    alternatives: [],
  };
  if (!name) return empty;

  const alias = await env.DB.prepare(
    `SELECT a.product_id, p.issuer, p.product_name
       FROM card_product_aliases a JOIN card_products p ON p.id = a.product_id
      WHERE a.alias_key = ?`
  )
    .bind(aliasKey(name))
    .first<{ product_id: number; issuer: string; product_name: string }>();

  if (alias && (!issuer || alias.issuer.toLowerCase() === issuer.toLowerCase())) {
    return {
      raw_product_name: name,
      resolved_product_id: alias.product_id,
      resolved_name: `${alias.issuer} ${alias.product_name}`,
      confidence: 'high',
      needs_review: false,
      alternatives: [],
    };
  }

  const matches = (await searchProducts(env, name, 5)).filter(
    (m) => !issuer || m.product.issuer.toLowerCase() === issuer.toLowerCase()
  );
  if (!matches.length) return empty;

  const [best, second] = matches;
  const clear = !second || best.score >= second.score * 1.5;

  return {
    raw_product_name: name,
    resolved_product_id: clear ? best.product.id : null,
    resolved_name: clear ? `${best.product.issuer} ${best.product.product_name}` : null,
    confidence: clear ? (best.matched_on === 'alias' ? 'high' : 'medium') : 'low',
    needs_review: !clear,
    alternatives: matches.slice(0, 3).map((m) => ({
      id: m.product.id,
      name: `${m.product.issuer} ${m.product.product_name}`,
    })),
  };
}

/** The best resolution among the names an article used for one offer. */
export async function resolveBest(env: Env, names: string[], issuer?: string | null): Promise<Resolution> {
  let best: Resolution | null = null;
  for (const raw of names) {
    const r = await resolveProduct(env, raw, issuer);
    if (r.resolved_product_id && (!best || !best.resolved_product_id || r.confidence === 'high')) best = r;
    else if (!best) best = r;
    if (best?.confidence === 'high') break;
  }
  return (
    best ?? {
      raw_product_name: names[0] ?? '',
      resolved_product_id: null,
      resolved_name: null,
      confidence: 'low',
      needs_review: true,
      alternatives: [],
    }
  );
}
