import { planTransfer, type Conversion, type TransferPlan } from '../points';
import { money, today } from '../spend';
import type { Env } from '../types';
import { bonusUnits, liveRoute, routesTo, type LiveRoute, type TransferPromotion } from './routes';

/**
 * Turning the points you have into the miles you need.
 *
 * This is a discrete problem, not a ratio. Transfers move in whole blocks,
 * anything below a block is stranded, the fee is charged once per transfer
 * rather than per point, and a promotion may or may not apply — so the route
 * with the better headline ratio is routinely the worse deal, and "how many
 * miles can I make" cannot be answered by multiplying.
 *
 * What the optimiser will not do is transfer anything. It produces a plan.
 */

export type Objective =
  | 'maximize_destination_units'
  | 'minimize_fees'
  | 'minimize_expiry_loss'
  | 'reach_target'
  | 'balanced';

export interface OptimisationInput {
  destination: string;
  target_units?: number | null;
  target_date?: string | null;
  objective?: Objective;
  include_promotions?: boolean;
  /** Points already promised to another goal, and therefore not available. */
  reserved?: Record<string, number>;
}

export interface PlanRoute {
  from_program: string;
  from_name: string;
  route: string | null;
  source_units: number;
  destination_units: number;
  bonus_units: number;
  fee_cents: number;
  stranded_units: number;
  /** Points in this transfer that would otherwise have expired. */
  expiring_units_saved: number;
  promotion: { title: string | null; bonus_pct: number | null; ends: string; registration_required: boolean } | null;
  processing_days: { min: number | null; max: number | null };
  /** Why this source was used, in words. */
  reason: string;
}

export interface TransferPlanResult {
  destination: { key: string; name: string; unit: string };
  objective: Objective;
  target_units: number | null;
  resulting_units: number;
  shortfall_units: number;
  total_fees_cents: number;
  routes: PlanRoute[];
  expiring_points_saved: number;
  assumptions: string[];
  warnings: string[];
  as_of: string;
}

interface Source {
  program_key: string;
  name: string;
  available: number;
  /** Points expiring inside the horizon, which is what makes a source urgent. */
  expiring_soon: number;
  soonest_expiry: string | null;
}

/** Points expiring inside this many days count as urgent. */
export const EXPIRY_HORIZON_DAYS = 90;

async function sourcesFor(
  env: Env,
  destination: string,
  on: string,
  reserved: Record<string, number>
): Promise<{ source: Source; route: LiveRoute }[]> {
  const routes = await routesTo(env, destination, on);
  const out: { source: Source; route: LiveRoute }[] = [];

  for (const conv of routes) {
    const bal = await env.DB.prepare(
      `SELECT COALESCE(SUM(points), 0) AS total FROM balance_tranches WHERE program_key = ? AND points > 0`
    )
      .bind(conv.from_program)
      .first<{ total: number }>();

    const horizon = new Date(Date.parse(`${on}T00:00:00Z`) + EXPIRY_HORIZON_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const soon = await env.DB.prepare(
      `SELECT COALESCE(SUM(points), 0) AS total, MIN(expires_at) AS soonest
         FROM balance_tranches
        WHERE program_key = ? AND points > 0 AND expires_at IS NOT NULL AND expires_at <= ?`
    )
      .bind(conv.from_program, horizon)
      .first<{ total: number; soonest: string | null }>();

    const program = await env.DB.prepare(`SELECT name FROM programs WHERE key = ?`)
      .bind(conv.from_program)
      .first<{ name: string }>();

    const available = Math.max(0, (bal?.total ?? 0) - (reserved[conv.from_program] ?? 0));
    out.push({
      source: {
        program_key: conv.from_program,
        name: program?.name ?? conv.from_program,
        available,
        expiring_soon: Math.min(available, soon?.total ?? 0),
        soonest_expiry: soon?.soonest ?? null,
      },
      route: await liveRoute(env, conv, on, available),
    });
  }
  return out;
}

/** What a transfer of exactly this many source units yields, promotion included. */
function yieldOf(
  units: number,
  conv: Conversion,
  promo: TransferPromotion | null,
  on: string
): { plan: TransferPlan; destination: number; bonus: number } {
  // planTransfer already knows about blocks, stranding and the once-per-transfer
  // fee — the three things that make this discrete. The legacy bonus fields on
  // the route are zeroed here so a promotion is counted once, from its own row.
  const plain = planTransfer(units, { ...conv, bonus_pct: 0, bonus_until: null }, on);
  if (!plain.possible) return { plan: plain, destination: 0, bonus: 0 };

  const bonus = promo && (!promo.min_transfer_units || plain.transferable >= promo.min_transfer_units)
    ? bonusUnits(promo, plain.miles)
    : 0;
  return { plan: plain, destination: plain.miles + bonus, bonus };
}

/**
 * How good a source is per point, so sources can be ordered.
 *
 * Fees are amortised over the miles they buy, which is what makes a $27 fee on
 * 40,000 miles cheap and the same fee on 3,000 miles ruinous.
 */
function valuePerUnit(destination: number, feeCents: number, mileValueCents: number): number {
  if (destination <= 0) return -Infinity;
  return (destination * mileValueCents - feeCents) / destination;
}

/**
 * Build the plan.
 *
 * Sources are ordered by the objective, then taken greedily to the target. This
 * is not a proof of optimality — block sizes make that a knapsack — but it is
 * explicable, and an explicable plan a person can check beats an optimal one
 * they cannot.
 */
export async function optimiseTransfer(env: Env, input: OptimisationInput): Promise<TransferPlanResult> {
  const on = today(env);
  const objective: Objective = input.objective ?? (input.target_units ? 'reach_target' : 'maximize_destination_units');
  const mileValue = parseFloat(env.MILE_VALUE_CENTS || '1.5');
  const reserved = input.reserved ?? {};

  const dest = await env.DB.prepare(`SELECT key, name, unit FROM programs WHERE key = ?`)
    .bind(input.destination)
    .first<{ key: string; name: string; unit: string }>();
  if (!dest) throw new Error('no such programme');

  // Stated on every plan, including the empty ones. An assurance that appears
  // only when there is something to do is an assurance nobody has read by the
  // time it matters.
  const assumptions: string[] = ['Nothing is transferred by this app — the plan is for you to carry out.'];
  const warnings: string[] = [];
  const candidates = await sourcesFor(env, input.destination, on, reserved);

  if (!candidates.length) {
    return {
      destination: dest,
      objective,
      target_units: input.target_units ?? null,
      resulting_units: 0,
      shortfall_units: input.target_units ?? 0,
      total_fees_cents: 0,
      routes: [],
      expiring_points_saved: 0,
      assumptions,
      warnings: [`No transfer route to ${dest.name} is recorded.`],
      as_of: on,
    };
  }

  // Evaluate each source at its full available balance first, which is what
  // decides the order; the amounts are trimmed afterwards if a target is met.
  const evaluated = candidates
    .map(({ source, route }) => {
      const promo = input.include_promotions === false ? null : route.usable_promotion;
      const full = yieldOf(source.available, route.conversion, promo, on);
      return { source, route, promo, full };
    })
    .filter((c) => c.full.plan.possible && c.full.destination > 0);

  for (const c of candidates) {
    if (c.route.registration_note) warnings.push(`${c.source.name}: ${c.route.registration_note}`);
    if (input.target_date && c.route.processing_days.max) {
      const arrives = new Date(Date.parse(`${on}T00:00:00Z`) + c.route.processing_days.max * 86_400_000)
        .toISOString()
        .slice(0, 10);
      if (arrives > input.target_date) {
        warnings.push(
          `${c.source.name} takes up to ${c.route.processing_days.max} days, so a transfer started today may not land by ${input.target_date}.`
        );
      }
    }
  }

  if (!evaluated.length) {
    const short = candidates
      .map((c) => `${c.source.name} needs ${c.route.conversion.min_block.toLocaleString()} to transfer at all`)
      .slice(0, 3);
    return {
      destination: dest,
      objective,
      target_units: input.target_units ?? null,
      resulting_units: 0,
      shortfall_units: input.target_units ?? 0,
      total_fees_cents: 0,
      routes: [],
      expiring_points_saved: 0,
      assumptions,
      warnings: [...warnings, ...short],
      as_of: on,
    };
  }

  const ordered = evaluated.slice().sort((a, b) => {
    if (objective === 'minimize_fees') return a.full.plan.cents_per_mile - b.full.plan.cents_per_mile;
    if (objective === 'minimize_expiry_loss') {
      // Points about to lapse are worth moving even at a worse rate, because
      // the alternative is that they are worth nothing at all.
      if (a.source.expiring_soon !== b.source.expiring_soon) return b.source.expiring_soon - a.source.expiring_soon;
      return a.full.plan.cents_per_mile - b.full.plan.cents_per_mile;
    }
    if (objective === 'balanced') {
      const av = valuePerUnit(a.full.destination, a.full.plan.fee_cents, mileValue);
      const bv = valuePerUnit(b.full.destination, b.full.plan.fee_cents, mileValue);
      if (a.source.expiring_soon > 0 !== b.source.expiring_soon > 0) return a.source.expiring_soon > 0 ? -1 : 1;
      return bv - av;
    }
    // Most miles, then cheapest.
    if (b.full.destination !== a.full.destination) return b.full.destination - a.full.destination;
    return a.full.plan.cents_per_mile - b.full.plan.cents_per_mile;
  });

  const routes: PlanRoute[] = [];
  let produced = 0;
  let fees = 0;
  let saved = 0;
  const target = input.target_units ?? null;

  for (const c of ordered) {
    if (target !== null && produced >= target) break;

    // With a target, take the smallest whole number of blocks that gets there
    // — moving more than needed strands points in a programme that may be
    // worth more where it is.
    let units = c.source.available;
    if (target !== null) {
      const still = target - produced;
      const conv = c.route.conversion;
      const perBlock = Math.floor((conv.block_increment / conv.from_units) * conv.to_units);
      if (perBlock > 0) {
        const minYield = yieldOf(conv.min_block, conv, c.promo, on).destination;
        if (minYield > 0) {
          const extraBlocks = minYield >= still ? 0 : Math.ceil((still - minYield) / perBlock);
          units = Math.min(c.source.available, conv.min_block + extraBlocks * conv.block_increment);
        }
      }
    }

    const got = yieldOf(units, c.route.conversion, c.promo, on);
    if (!got.plan.possible || got.destination <= 0) continue;

    const expiringMoved = Math.min(got.plan.transferable, c.source.expiring_soon);
    produced += got.destination;
    fees += got.plan.fee_cents;
    saved += expiringMoved;

    const reasons: string[] = [];
    if (expiringMoved > 0) {
      reasons.push(
        `${expiringMoved.toLocaleString()} of these expire${c.source.soonest_expiry ? ` from ${c.source.soonest_expiry}` : ''}`
      );
    }
    if (got.bonus > 0) reasons.push(`a bonus adds ${got.bonus.toLocaleString()} ${dest.unit}`);
    if (got.plan.fee_cents === 0) reasons.push('no fee');
    else reasons.push(`$${money(got.plan.fee_cents)} fee over ${got.destination.toLocaleString()} ${dest.unit}`);
    if (got.plan.stranded > 0) {
      reasons.push(`${got.plan.stranded.toLocaleString()} left behind — they do not fill a block`);
    }

    routes.push({
      from_program: c.source.program_key,
      from_name: c.source.name,
      route: c.route.conversion.route,
      source_units: got.plan.transferable,
      destination_units: got.destination,
      bonus_units: got.bonus,
      fee_cents: got.plan.fee_cents,
      stranded_units: got.plan.stranded,
      expiring_units_saved: expiringMoved,
      promotion: c.promo
        ? {
            title: c.promo.title,
            bonus_pct: c.promo.bonus_pct,
            ends: c.promo.end_at,
            registration_required: !!c.promo.registration_required,
          }
        : null,
      processing_days: c.route.processing_days,
      reason: reasons.join('; '),
    });
  }

  if (input.include_promotions === false) assumptions.push('Transfer bonuses were left out of this plan.');
  else if (routes.some((r) => r.promotion)) {
    assumptions.push('A transfer bonus is counted; it has to be used before the date shown.');
  }
  if (Object.keys(reserved).length) {
    assumptions.push('Points promised to another goal were left where they are.');
  }

  const shortfall = target !== null ? Math.max(0, target - produced) : 0;
  if (shortfall > 0) {
    warnings.push(`${shortfall.toLocaleString()} ${dest.unit} short of the target with everything available.`);
  }

  return {
    destination: dest,
    objective,
    target_units: target,
    resulting_units: produced,
    shortfall_units: shortfall,
    total_fees_cents: fees,
    routes,
    expiring_points_saved: saved,
    assumptions,
    warnings,
    as_of: on,
  };
}

/** The ceiling: everything convertible into one programme today. */
export async function maximumInto(env: Env, destination: string): Promise<number> {
  const plan = await optimiseTransfer(env, { destination, objective: 'maximize_destination_units' });
  return plan.resulting_units;
}
