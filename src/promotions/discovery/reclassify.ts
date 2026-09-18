import { today } from '../../spend';
import type { Env } from '../../types';
import { classify, shouldExtract } from './classify';

/**
 * Judging an old article again, after the classifier got better.
 *
 * Every improvement to classification or extraction leaves behind a pile of
 * articles that were filed as irrelevant, or read and found to name no offer,
 * under the old rules. Rediscovering those URLs is wasteful and often
 * impossible — a feed only carries a month.
 *
 * So the articles are kept, and this re-runs the judgement over them. Two
 * constraints keep it from becoming a way to re-fetch the internet: it works
 * from the stored title and nothing else, so no request leaves the app, and
 * the backfill is bounded to a recent window rather than all history.
 */

export interface ReclassifyResult {
  id: number;
  before: { item_type: string | null; status: string };
  after: { item_type: string; status: string };
  changed: boolean;
  signals: string[];
  note: string;
}

export async function reclassifyItem(env: Env, id: number): Promise<ReclassifyResult | null> {
  const item = await env.DB.prepare(`SELECT * FROM discovery_items WHERE id = ?`).bind(id).first<{
    id: number;
    title: string | null;
    item_type: string | null;
    status: string;
  }>();
  if (!item) return null;

  const verdict = classify(item.title ?? '', '');
  const worth = shouldExtract(verdict);

  // Promoting back to `new` re-reads the article; demoting an already-read one
  // would throw away work and any candidates it produced, so `processed` is
  // left alone.
  const after =
    worth && item.status === 'irrelevant' ? 'new' : !worth && item.status === 'new' ? 'irrelevant' : item.status;

  await env.DB.prepare(
    `UPDATE discovery_items
        SET item_type = ?, status = ?, classification_score = ?, classification_signals_json = ?
      WHERE id = ?`
  )
    .bind(verdict.type, after, verdict.score, JSON.stringify(verdict.signals), id)
    .run();

  const changed = after !== item.status || verdict.type !== item.item_type;
  return {
    id,
    before: { item_type: item.item_type, status: item.status },
    after: { item_type: verdict.type, status: after },
    changed,
    signals: verdict.signals,
    note: changed
      ? after === 'new'
        ? 'Now looks like it is about an offer; queued to be read.'
        : `Re-read as ${verdict.type.replace(/_/g, ' ')}.`
      : 'The classifier reached the same conclusion.',
  };
}

export interface BackfillReport {
  considered: number;
  changed: number;
  requeued: number;
  window_days: number;
  as_of: string;
}

/** How far back a backfill will look. Not all history: an old article is old news. */
export const BACKFILL_DAYS = 90;

/**
 * Re-judge the recent articles filed as irrelevant.
 *
 * Bounded twice — by age and by count — because "reprocess everything" is how
 * a maintenance job becomes an outage. Only `irrelevant` items are considered:
 * those cost nothing to reconsider, whereas re-reading a processed article is
 * a fetch, and that is the separate, explicit re-extraction path.
 */
export async function backfillClassification(env: Env, opts: { limit?: number } = {}): Promise<BackfillReport> {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 200));
  const since = new Date(Date.parse(`${today(env)}T00:00:00Z`) - BACKFILL_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const { results } = await env.DB.prepare(
    `SELECT id FROM discovery_items
      WHERE status = 'irrelevant' AND substr(discovered_at, 1, 10) >= ?
      ORDER BY discovered_at DESC LIMIT ?`
  )
    .bind(since, limit)
    .all<{ id: number }>();

  let changed = 0;
  let requeued = 0;
  for (const row of results ?? []) {
    const r = await reclassifyItem(env, row.id);
    if (!r) continue;
    if (r.changed) changed++;
    if (r.after.status === 'new') requeued++;
  }

  return { considered: (results ?? []).length, changed, requeued, window_days: BACKFILL_DAYS, as_of: today(env) };
}

/**
 * Articles that were read successfully and named no offer.
 *
 * Listed rather than re-read automatically: each one is a fetch, and the
 * decision to spend those belongs to a person looking at why the extractor
 * missed. The stored note says what it was missing.
 */
export async function extractionMisses(
  env: Env,
  limit = 50
): Promise<{ id: number; title: string | null; url: string; item_type: string | null; extraction_note: string | null }[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, title, COALESCE(canonical_url, url) AS url, item_type, extraction_note
       FROM discovery_items
      WHERE status = 'processed' AND extraction_note IS NOT NULL
        AND item_type IN ('promotion_related', 'roundup', 'transfer_related')
      ORDER BY discovered_at DESC LIMIT ?`
  )
    .bind(limit)
    .all<{ id: number; title: string | null; url: string; item_type: string | null; extraction_note: string | null }>();
  return results ?? [];
}

/** Queue a read article to be read again, after an extractor improvement. */
export async function requeueForExtraction(env: Env, id: number): Promise<{ ok: boolean; error?: string }> {
  const item = await env.DB.prepare(`SELECT id, status FROM discovery_items WHERE id = ?`).bind(id).first<{
    id: number;
    status: string;
  }>();
  if (!item) return { ok: false, error: 'no such article' };

  // The content hash is cleared too: without that, the next pass sees an
  // unchanged article and skips it, which is exactly the behaviour being
  // overridden here.
  await env.DB.prepare(
    `UPDATE discovery_items SET status = 'new', content_hash = NULL, extraction_note = NULL WHERE id = ?`
  )
    .bind(id)
    .run();
  return { ok: true };
}
