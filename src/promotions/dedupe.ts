import { canonicalUrl } from '../rss';
import { similarity } from '../merchants/normalize';
import type { Env } from '../types';
import { termsOf, type Promotion } from './model';

/**
 * The same promotion, found twice.
 *
 * Several feeds cover the same bank, so one offer arrives as three articles
 * with three headlines. Left alone the inbox fills with the same thing said
 * differently, which is how a useful list becomes one nobody reads.
 *
 * Merging is only automatic where it is certain. Two offers from one issuer
 * with overlapping dates and similar titles are *probably* the same, and
 * probably is not good enough when the wrong merge hides a second, better offer.
 */

export interface DuplicateMatch {
  promotion_id: number;
  reason: string;
  automatic: boolean;
}

const overlaps = (a: Promotion, b: Promotion) => {
  const aStart = a.start_at ?? '0000-01-01';
  const aEnd = a.end_at ?? '9999-12-31';
  const bStart = b.start_at ?? '0000-01-01';
  const bEnd = b.end_at ?? '9999-12-31';
  return aStart <= bEnd && bStart <= aEnd;
};

/** Do these two describe the same money? */
const sameTerms = (a: Promotion, b: Promotion) => {
  const ta = termsOf(a);
  const tb = termsOf(b);
  const keys = ['minimum_spend_cents', 'reward_miles', 'reward_points', 'reward_cashback_cents', 'bonus_pct'] as const;
  let compared = 0;
  for (const k of keys) {
    if (ta[k] === undefined || tb[k] === undefined) continue;
    compared++;
    if (ta[k] !== tb[k]) return false;
  }
  return compared > 0;
};

/** Titles this alike, from one issuer, with overlapping dates, count as similar. */
export const TITLE_SIMILARITY = 0.6;

export async function findDuplicate(env: Env, candidate: Promotion): Promise<DuplicateMatch | null> {
  // The same page is the same promotion, whoever linked to it.
  if (candidate.source_url) {
    const url = canonicalUrl(candidate.source_url);
    const { results } = await env.DB.prepare(
      `SELECT * FROM promotions WHERE id <> ? AND source_url IS NOT NULL AND duplicate_of IS NULL`
    )
      .bind(candidate.id)
      .all<Promotion>();
    for (const p of results ?? []) {
      if (canonicalUrl(p.source_url!) === url) {
        return { promotion_id: p.id, reason: 'the same page', automatic: true };
      }
    }
  }

  const { results } = await env.DB.prepare(
    `SELECT * FROM promotions
      WHERE id <> ? AND duplicate_of IS NULL AND promotion_type = ?
        AND COALESCE(issuer, '') = COALESCE(?, '')`
  )
    .bind(candidate.id, candidate.promotion_type, candidate.issuer)
    .all<Promotion>();

  for (const p of results ?? []) {
    if (!overlaps(candidate, p)) continue;
    const alike = similarity(candidate.title, p.title);

    if (sameTerms(candidate, p) && alike >= TITLE_SIMILARITY) {
      return {
        promotion_id: p.id,
        reason: 'same issuer, same terms, overlapping dates',
        automatic: true,
      };
    }
    if (alike >= TITLE_SIMILARITY) {
      return {
        promotion_id: p.id,
        reason: `a similar offer from ${p.issuer ?? 'the same issuer'} runs over the same dates`,
        automatic: false,
      };
    }
  }
  return null;
}

/**
 * Fold one promotion into another.
 *
 * The survivor keeps whatever it already knows and gains whatever it did not:
 * two partial extractions of one offer often know different halves of it. What
 * is never done is overwrite a verified value with an unverified one.
 */
export async function merge(env: Env, keepId: number, dropId: number): Promise<{ ok: boolean; error?: string }> {
  if (keepId === dropId) return { ok: false, error: 'a promotion cannot be merged into itself' };
  const keep = await env.DB.prepare(`SELECT * FROM promotions WHERE id = ?`).bind(keepId).first<Promotion>();
  const drop = await env.DB.prepare(`SELECT * FROM promotions WHERE id = ?`).bind(dropId).first<Promotion>();
  if (!keep || !drop) return { ok: false, error: 'no such promotion' };

  const merged = { ...termsOf(drop), ...termsOf(keep) };
  const fill: [string, unknown][] = [];
  if (!keep.description && drop.description) fill.push(['description', drop.description]);
  if (!keep.end_at && drop.end_at) fill.push(['end_at', drop.end_at]);
  if (!keep.start_at && drop.start_at) fill.push(['start_at', drop.start_at]);
  if (!keep.source_quote && drop.source_quote) fill.push(['source_quote', drop.source_quote]);
  if (!keep.source_url && drop.source_url) fill.push(['source_url', drop.source_url]);

  if (fill.length) {
    await env.DB.prepare(`UPDATE promotions SET ${fill.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .bind(...fill.map(([, v]) => v), keepId)
      .run();
  }
  await env.DB.prepare(`UPDATE promotions SET terms_json = ? WHERE id = ?`)
    .bind(JSON.stringify(merged), keepId)
    .run();

  // Applicability is a union: one feed may have noticed a card the other did not.
  for (const table of ['promotion_card_products', 'promotion_programmes', 'promotion_merchants', 'promotion_mccs']) {
    await env.DB.prepare(`UPDATE OR IGNORE ${table} SET promotion_id = ? WHERE promotion_id = ?`)
      .bind(keepId, dropId)
      .run();
  }

  await env.DB.prepare(`UPDATE promotions SET status = 'rejected', duplicate_of = ? WHERE id = ?`)
    .bind(keepId, dropId)
    .run();
  return { ok: true };
}
