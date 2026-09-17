import { today } from '../spend';
import type { Conversion } from '../points';
import type { Env } from '../types';

/**
 * Routes, and the bonuses that sit on top of them without becoming them.
 *
 * A route's ratio is what the bank permanently offers. A 25% bonus running for
 * three weeks in September is not that, and a previous version of this app
 * wrote such bonuses straight into the ratio — which left it believing 40,000
 * points became 50,000 miles for ever, long after the promotion ended.
 */

export interface TransferPromotion {
  id: number;
  conversion_id: number;
  bonus_pct: number | null;
  bonus_flat_units: number | null;
  min_transfer_units: number | null;
  start_at: string;
  end_at: string;
  registration_required: number;
  registered: number;
  title: string | null;
  source_url: string | null;
}

export interface LiveRoute {
  conversion: Conversion;
  /** Promotions in force on the date asked about. */
  promotions: TransferPromotion[];
  /** The one the optimiser may actually count on. */
  usable_promotion: TransferPromotion | null;
  /** Set when a bonus exists but cannot be assumed. */
  registration_note: string | null;
  processing_days: { min: number | null; max: number | null };
}

/**
 * A promotion the app may plan around.
 *
 * One that needs registering and has not been registered for is shown but not
 * counted: planning a transfer on a bonus you never signed up for produces a
 * number the bank will not honour, which is worse than no advice.
 */
export function usable(promos: TransferPromotion[], units: number): TransferPromotion | null {
  const eligible = promos.filter((p) => {
    if (p.registration_required && !p.registered) return false;
    if (p.min_transfer_units && units < p.min_transfer_units) return false;
    return true;
  });
  if (!eligible.length) return null;
  // The one worth the most on this transfer, not the biggest headline.
  return eligible
    .slice()
    .sort((a, b) => bonusUnits(b, units) - bonusUnits(a, units))[0];
}

export function bonusUnits(p: TransferPromotion, destinationUnits: number): number {
  const pct = p.bonus_pct ? Math.floor(destinationUnits * (p.bonus_pct / 100)) : 0;
  return pct + (p.bonus_flat_units ?? 0);
}

export async function promotionsFor(env: Env, conversionId: number, on: string): Promise<TransferPromotion[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM transfer_promotions
      WHERE conversion_id = ? AND start_at <= ? AND end_at >= ?
      ORDER BY end_at`
  )
    .bind(conversionId, on, on)
    .all<TransferPromotion>();
  return results ?? [];
}

/**
 * Every route out of a programme that is in force on a date.
 *
 * `effective_from`/`effective_until` are treated as open when null, so routes
 * recorded before versioning existed keep working rather than silently
 * vanishing from every plan.
 */
export async function routesFrom(env: Env, fromProgram: string, on: string): Promise<Conversion[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM conversions
      WHERE from_program = ? AND active = 1
        AND (effective_from IS NULL OR effective_from <= ?)
        AND (effective_until IS NULL OR effective_until >= ?)
      ORDER BY id`
  )
    .bind(fromProgram, on, on)
    .all<Conversion>();
  return results ?? [];
}

export async function routesTo(env: Env, toProgram: string, on: string): Promise<Conversion[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM conversions
      WHERE to_program = ? AND active = 1
        AND (effective_from IS NULL OR effective_from <= ?)
        AND (effective_until IS NULL OR effective_until >= ?)
      ORDER BY id`
  )
    .bind(toProgram, on, on)
    .all<Conversion>();
  return results ?? [];
}

export async function liveRoute(env: Env, conv: Conversion, on: string, units = 0): Promise<LiveRoute> {
  const promotions = await promotionsFor(env, conv.id, on);
  const use = usable(promotions, units);
  const blocked = promotions.filter((p) => p.registration_required && !p.registered);

  return {
    conversion: conv,
    promotions,
    usable_promotion: use,
    registration_note: blocked.length
      ? `A ${blocked[0].bonus_pct ? `${blocked[0].bonus_pct}% ` : ''}bonus is running until ${blocked[0].end_at}, but it needs registering first — so it is not counted here.`
      : null,
    processing_days: { min: conv.processing_days_min ?? null, max: conv.processing_days_max ?? null },
  };
}

/**
 * Move a legacy bonus off the route it was written into.
 *
 * Idempotent, and it leaves the old columns alone: they are what older code
 * still reads, and rewriting history to tidy a schema is how a migration
 * becomes the thing you have to debug.
 */
export async function migrateLegacyBonuses(env: Env): Promise<{ moved: number }> {
  const { results } = await env.DB.prepare(
    `SELECT id, bonus_pct, bonus_until, source_url FROM conversions WHERE bonus_pct > 0`
  ).all<{ id: number; bonus_pct: number; bonus_until: string | null; source_url: string | null }>();

  let moved = 0;
  for (const c of results ?? []) {
    const exists = await env.DB.prepare(
      `SELECT id FROM transfer_promotions WHERE conversion_id = ? AND bonus_pct = ?`
    )
      .bind(c.id, c.bonus_pct)
      .first();
    if (exists) continue;

    await env.DB.prepare(
      `INSERT INTO transfer_promotions
         (conversion_id, bonus_pct, start_at, end_at, registration_required, registered, title, source_url)
       VALUES (?, ?, ?, ?, 0, 1, ?, ?)`
    )
      .bind(
        c.id,
        c.bonus_pct,
        '2000-01-01',
        // A bonus with no end date recorded is treated as ending today rather
        // than never: an uncapped promotion is the one assumption that would
        // keep inflating every plan for years.
        c.bonus_until ?? today(env),
        `${c.bonus_pct}% transfer bonus`,
        c.source_url
      )
      .run();
    moved++;
  }
  return { moved };
}
