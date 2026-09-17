import type { Env } from '../types';
import { termsOf, type Promotion } from './model';

/**
 * Letting a transfer bonus reach the optimiser.
 *
 * The optimiser must not learn about promotions; it already understands one
 * thing — a dated bonus attached to a route — and teaching it a second source
 * of truth would mean two places to fix when a bonus is wrong. So a published
 * transfer_bonus promotion is projected onto the routes it applies to, and the
 * projection carries the promotion's id so it can be traced back.
 */

export interface BridgeReport {
  created: number;
  updated: number;
  removed: number;
}

export async function syncTransferBonuses(env: Env): Promise<BridgeReport> {
  const report: BridgeReport = { created: 0, updated: 0, removed: 0 };

  // A promotion that stopped being published takes its projections with it —
  // otherwise a withdrawn bonus keeps inflating plans from the other side.
  const { results: gone } = await env.DB.prepare(
    `SELECT tp.id FROM transfer_promotions tp
       LEFT JOIN promotions p ON p.id = tp.promotion_id
      WHERE tp.promotion_id IS NOT NULL AND (p.id IS NULL OR p.status <> 'published')`
  ).all<{ id: number }>();
  for (const g of gone ?? []) {
    await env.DB.prepare(`DELETE FROM transfer_promotions WHERE id = ?`).bind(g.id).run();
    report.removed++;
  }

  const { results: promos } = await env.DB.prepare(
    `SELECT * FROM promotions WHERE promotion_type = 'transfer_bonus' AND status = 'published' AND duplicate_of IS NULL`
  ).all<Promotion>();

  for (const p of promos ?? []) {
    const t = termsOf(p);
    if (!t.bonus_pct && !t.reward_points) continue;
    if (!p.start_at || !p.end_at) continue;

    const { results: sources } = await env.DB.prepare(
      `SELECT program_key FROM promotion_programmes WHERE promotion_id = ? AND role = 'source'`
    )
      .bind(p.id)
      .all<{ program_key: string }>();
    const { results: destinations } = await env.DB.prepare(
      `SELECT program_key FROM promotion_programmes WHERE promotion_id = ? AND role = 'destination'`
    )
      .bind(p.id)
      .all<{ program_key: string }>();

    // A bonus with no destination named would otherwise be applied to every
    // route out of the source, including ones it has nothing to do with.
    if (!destinations?.length) continue;

    const froms = sources?.length ? sources.map((s) => s.program_key) : null;
    for (const dest of destinations) {
      const { results: routes } = froms
        ? await env.DB.prepare(
            `SELECT id FROM conversions WHERE to_program = ? AND from_program IN (${froms.map(() => '?').join(',')})`
          )
            .bind(dest.program_key, ...froms)
            .all<{ id: number }>()
        : await env.DB.prepare(`SELECT id FROM conversions WHERE to_program = ?`)
            .bind(dest.program_key)
            .all<{ id: number }>();

      for (const r of routes ?? []) {
        const existing = await env.DB.prepare(
          `SELECT id FROM transfer_promotions WHERE promotion_id = ? AND conversion_id = ?`
        )
          .bind(p.id, r.id)
          .first<{ id: number }>();

        if (existing) {
          await env.DB.prepare(
            `UPDATE transfer_promotions SET bonus_pct = ?, start_at = ?, end_at = ?,
               registration_required = ?, title = ?, source_url = ? WHERE id = ?`
          )
            .bind(
              t.bonus_pct ?? null,
              p.start_at,
              p.end_at,
              p.registration_required,
              p.title,
              p.source_url,
              existing.id
            )
            .run();
          report.updated++;
          continue;
        }

        await env.DB.prepare(
          `INSERT INTO transfer_promotions
             (conversion_id, bonus_pct, bonus_flat_units, min_transfer_units, start_at, end_at,
              registration_required, registered, title, source_url, promotion_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
        )
          .bind(
            r.id,
            t.bonus_pct ?? null,
            t.reward_points ?? null,
            t.minimum_spend_cents ?? null,
            p.start_at,
            p.end_at,
            p.registration_required,
            p.title,
            p.source_url,
            p.id
          )
          .run();
        report.created++;
      }
    }
  }

  return report;
}
