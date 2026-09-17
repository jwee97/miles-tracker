import { today } from '../spend';
import type { Env } from '../types';
import { optimiseTransfer } from './optimiser';

/**
 * What the points are for.
 *
 * A goal changes the answer rather than decorating it: the cheapest way to move
 * points is not the cheapest way to reach 85,000 of them, and points promised
 * to one goal are not available to another.
 */

export interface RewardGoal {
  id: number;
  program_key: string;
  target_units: number;
  target_date: string | null;
  description: string | null;
  status: string;
}

export interface GoalProgress {
  goal: RewardGoal;
  program_name: string;
  unit: string;
  /** Already sitting in the destination programme. */
  held_units: number;
  /** What could be transferred in today, on the best plan. */
  convertible_units: number;
  total_units: number;
  shortfall_units: number;
  percent: number;
  days_left: number | null;
  /** True when the transfer alone cannot get there in time. */
  at_risk: boolean;
}

export async function listGoals(env: Env, includeMet = false): Promise<RewardGoal[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM reward_goals ${includeMet ? '' : `WHERE status = 'active'`} ORDER BY target_date IS NULL, target_date, id`
  ).all<RewardGoal>();
  return results ?? [];
}

export async function saveGoal(
  env: Env,
  g: { id?: number; program_key: string; target_units: number; target_date?: string | null; description?: string | null }
): Promise<RewardGoal> {
  if (g.id) {
    await env.DB.prepare(
      `UPDATE reward_goals SET program_key = ?, target_units = ?, target_date = ?, description = ? WHERE id = ?`
    )
      .bind(g.program_key, g.target_units, g.target_date ?? null, g.description ?? null, g.id)
      .run();
    return (await env.DB.prepare(`SELECT * FROM reward_goals WHERE id = ?`).bind(g.id).first<RewardGoal>())!;
  }

  const ins = await env.DB.prepare(
    `INSERT INTO reward_goals (program_key, target_units, target_date, description) VALUES (?, ?, ?, ?)`
  )
    .bind(g.program_key, g.target_units, g.target_date ?? null, g.description ?? null)
    .run();
  return (await env.DB.prepare(`SELECT * FROM reward_goals WHERE id = ?`).bind(ins.meta.last_row_id).first<RewardGoal>())!;
}

export async function setGoalStatus(env: Env, id: number, status: 'active' | 'met' | 'abandoned'): Promise<void> {
  await env.DB.prepare(`UPDATE reward_goals SET status = ? WHERE id = ?`).bind(status, id).run();
}

/**
 * How close a goal is.
 *
 * Counts what is already in the destination programme plus what the best plan
 * could bring in — the second is a plan, not a promise, which is why the two
 * are reported separately rather than as one encouraging total.
 */
export async function goalProgress(env: Env, goal: RewardGoal): Promise<GoalProgress> {
  const program = await env.DB.prepare(`SELECT name, unit FROM programs WHERE key = ?`)
    .bind(goal.program_key)
    .first<{ name: string; unit: string }>();

  const held = await env.DB.prepare(
    `SELECT COALESCE(SUM(points), 0) AS total FROM balance_tranches WHERE program_key = ? AND points > 0`
  )
    .bind(goal.program_key)
    .first<{ total: number }>();
  const have = held?.total ?? 0;

  const still = Math.max(0, goal.target_units - have);
  const plan = still > 0
    ? await optimiseTransfer(env, {
        destination: goal.program_key,
        target_units: still,
        target_date: goal.target_date,
        objective: 'reach_target',
      })
    : null;

  const convertible = plan?.resulting_units ?? 0;
  const total = have + convertible;
  const days = goal.target_date
    ? Math.round((Date.parse(goal.target_date) - Date.parse(today(env))) / 86_400_000)
    : null;

  return {
    goal,
    program_name: program?.name ?? goal.program_key,
    unit: program?.unit ?? 'points',
    held_units: have,
    convertible_units: convertible,
    total_units: total,
    shortfall_units: Math.max(0, goal.target_units - total),
    percent: goal.target_units > 0 ? Math.min(100, (total / goal.target_units) * 100) : 100,
    days_left: days,
    at_risk: total < goal.target_units,
  };
}

/**
 * Points already promised elsewhere.
 *
 * A source counted twice across two goals produces two plans that each look
 * achievable and cannot both happen.
 */
export async function reservedFor(env: Env, exceptGoalId?: number): Promise<Record<string, number>> {
  const goals = await listGoals(env);
  const out: Record<string, number> = {};
  for (const g of goals) {
    if (exceptGoalId && g.id === exceptGoalId) continue;
    const held = await env.DB.prepare(
      `SELECT COALESCE(SUM(points), 0) AS total FROM balance_tranches WHERE program_key = ? AND points > 0`
    )
      .bind(g.program_key)
      .first<{ total: number }>();
    const still = Math.max(0, g.target_units - (held?.total ?? 0));
    if (still <= 0) continue;

    const plan = await optimiseTransfer(env, {
      destination: g.program_key,
      target_units: still,
      objective: 'reach_target',
    });
    for (const r of plan.routes) out[r.from_program] = (out[r.from_program] ?? 0) + r.source_units;
  }
  return out;
}
