import { calendarMonth, calendarQuarter, money, statementCycle, today, EFFECTIVE_DATE } from './spend';
import type { Card, Env } from './types';

export interface Program {
  key: string;
  name: string;
  kind: 'bank' | 'airline';
  unit: string;
  expiry_months: number | null;
}

export interface Conversion {
  id: number;
  from_program: string;
  to_program: string;
  from_units: number;
  to_units: number;
  fee_cents: number;
  min_block: number;
  block_increment: number;
  route: string | null;
  bonus_pct: number;
  bonus_until: string | null;
}

export interface TransferPlan {
  conversion: Conversion;
  /** Points actually moved, after rounding down to whole blocks. */
  transferable: number;
  /** Points left behind because they don't fill a block. */
  stranded: number;
  miles: number;
  bonus_miles: number;
  fee_cents: number;
  /** Fee ÷ miles, in cents. The number that decides between routes. */
  cents_per_mile: number;
  possible: boolean;
  reason: string | null;
}

/**
 * Points do not convert as a ratio. Transfers move in whole blocks, anything
 * below a block is stranded, and the fee is charged once per transfer rather
 * than per point — so the route with the better headline ratio can still be
 * the worse deal.
 */
export function planTransfer(points: number, conv: Conversion, when: string): TransferPlan {
  const base = {
    conversion: conv,
    transferable: 0,
    stranded: points,
    miles: 0,
    bonus_miles: 0,
    fee_cents: 0,
    cents_per_mile: 0,
  };

  if (points < conv.min_block) {
    return {
      ...base,
      possible: false,
      reason: `Needs at least ${conv.min_block.toLocaleString()} — ${(conv.min_block - points).toLocaleString()} short.`,
    };
  }

  const over = points - conv.min_block;
  const transferable = conv.min_block + Math.floor(over / conv.block_increment) * conv.block_increment;
  const plain = Math.floor((transferable / conv.from_units) * conv.to_units);

  const bonusLive = conv.bonus_pct > 0 && (!conv.bonus_until || conv.bonus_until >= when);
  const bonus = bonusLive ? Math.floor(plain * (conv.bonus_pct / 100)) : 0;
  const miles = plain + bonus;

  return {
    conversion: conv,
    transferable,
    stranded: points - transferable,
    miles,
    bonus_miles: bonus,
    fee_cents: conv.fee_cents,
    cents_per_mile: miles > 0 ? conv.fee_cents / miles : 0,
    possible: true,
    reason: null,
  };
}

/** Every route from one programme to another, best first. */
export async function planRoutes(env: Env, points: number, from: string, to: string): Promise<TransferPlan[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM conversions WHERE from_program = ? AND to_program = ? AND active = 1`
  )
    .bind(from, to)
    .all<Conversion>();

  const when = today(env);
  return (results ?? [])
    .map((c) => planTransfer(points, c, when))
    .sort((a, b) => {
      if (a.possible !== b.possible) return a.possible ? -1 : 1;
      if (b.miles !== a.miles) return b.miles - a.miles;
      return a.fee_cents - b.fee_cents;
    });
}

export interface BalanceRow {
  program_key: string;
  name: string;
  unit: string;
  total: number;
  expiring_soon: number;
  next_expiry: string | null;
}

export async function balances(env: Env, withinDays = 90): Promise<BalanceRow[]> {
  const cutoff = new Date(Date.parse(today(env) + 'T00:00:00Z') + withinDays * 86400_000)
    .toISOString()
    .slice(0, 10);

  const { results } = await env.DB.prepare(
    `SELECT p.key AS program_key, p.name, p.unit,
            COALESCE(SUM(t.points), 0) AS total,
            COALESCE(SUM(CASE WHEN t.expires_at IS NOT NULL AND t.expires_at <= ? THEN t.points ELSE 0 END), 0) AS expiring_soon,
            MIN(t.expires_at) AS next_expiry
     FROM programs p LEFT JOIN balance_tranches t ON t.program_key = p.key
     GROUP BY p.key ORDER BY p.kind, p.name`
  )
    .bind(cutoff)
    .all<BalanceRow>();
  return results ?? [];
}

// ---------------------------------------------------------------------------
// Which card to use
// ---------------------------------------------------------------------------

export interface EarnRule {
  id: number;
  card_id: number;
  category: string;
  mpd: number;
  program_key: string | null;
  cap_cents: number | null;
  cap_group: string | null;
  cap_window: string | null;
  note: string | null;
}

export interface CardPick {
  card: Card;
  rule: EarnRule | null;
  /** Rate that applies to the next dollar, after any exhausted cap. */
  effective_mpd: number;
  base_mpd: number;
  /** Spend still available at the bonus rate, null when uncapped. */
  headroom_cents: number | null;
  cap_spent_cents: number;
  /** Miles this specific purchase would earn, blended across the cap. */
  miles: number | null;
  reasons: string[];
  score: number;
}

function windowFor(w: string | null, card: Card, env: Env) {
  if (w === 'calendar_month') return calendarMonth(env);
  if (w === 'calendar_quarter') return calendarQuarter(env);
  return statementCycle(card.statement_day, env);
}

/**
 * Spend already counted against a rule's cap. Rules sharing a cap_group share
 * one cap, so the categories of every rule in that group count toward it.
 */
async function capSpend(env: Env, card: Card, rule: EarnRule, rules: EarnRule[]): Promise<number> {
  const win = windowFor(rule.cap_window, card, env);
  const cats = rule.cap_group
    ? rules.filter((r) => r.cap_group === rule.cap_group).map((r) => r.category)
    : [rule.category];

  const placeholders = cats.map(() => '?').join(',');
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM transactions
     WHERE card_id = ? AND ${EFFECTIVE_DATE} >= ? AND ${EFFECTIVE_DATE} <= ?
       AND amount_cents > 0 AND COALESCE(category, '*') IN (${placeholders})`
  )
    .bind(card.id, win.start, win.end, ...cats)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/**
 * Ranks open cards for a purchase. The headline rate is only part of it: a cap
 * already spent drops a card to its base rate, and an unmet minimum with a
 * deadline close enough to matter can outweigh a better rate elsewhere.
 */
export async function rankCards(
  env: Env,
  category: string,
  amountCents: number | null,
  opts: { cards: Card[]; minSpendNudge?: { cardId: number; remaining: number; daysLeft: number }[] }
): Promise<CardPick[]> {
  const picks: CardPick[] = [];

  for (const card of opts.cards) {
    const { results } = await env.DB.prepare(`SELECT * FROM earn_rules WHERE card_id = ? AND active = 1`)
      .bind(card.id)
      .all<EarnRule>();
    const rules = results ?? [];

    const exact = rules.find((r) => r.category === category);
    const fallback = rules.find((r) => r.category === '*');
    const rule = exact ?? fallback ?? null;
    const baseMpd = fallback?.mpd ?? card.base_mpd ?? 0;
    if (!rule && baseMpd === 0) continue; // nothing known about this card's earning

    const reasons: string[] = [];
    let headroom: number | null = null;
    let capSpent = 0;
    let effective = rule?.mpd ?? baseMpd;

    if (rule?.cap_cents) {
      capSpent = await capSpend(env, card, rule, rules);
      headroom = Math.max(0, rule.cap_cents - capSpent);
      if (headroom === 0) {
        effective = baseMpd;
        reasons.push(`bonus cap of $${money(rule.cap_cents)} used up — earning base rate`);
      } else {
        reasons.push(`$${money(headroom)} left at ${rule.mpd} mpd`);
      }
    }

    let miles: number | null = null;
    if (amountCents !== null) {
      const atBonus = headroom === null ? amountCents : Math.min(amountCents, headroom);
      const atBase = amountCents - atBonus;
      miles = Math.round(((atBonus * (rule?.mpd ?? baseMpd)) / 100) + (atBase * baseMpd) / 100);
      if (atBase > 0 && atBonus > 0) reasons.push(`$${money(atBase)} of this spills past the cap`);
    }

    // Rate normally decides the ranking. A minimum that is genuinely about to
    // lapse is a different kind of consideration — missing it forfeits a whole
    // bonus, which dwarfs the per-dollar difference — so it ranks as its own
    // tier rather than as points added to a rate. A minimum with weeks left
    // gets only a tie-breaking nudge, never enough to beat a better rate.
    const warnDays = parseInt(env.MIN_SPEND_WARN_DAYS || '7', 10);
    let score = effective * 1000;
    const nudge = opts.minSpendNudge?.find((n) => n.cardId === card.id);
    if (nudge && nudge.remaining > 0) {
      const urgent = nudge.daysLeft <= warnDays;
      if (urgent) score += 1_000_000;
      else score += nudge.daysLeft <= 21 ? 100 : 30;
      reasons.push(
        (urgent ? '⚠️ ' : '') + `$${money(nudge.remaining)} short of its minimum, ${nudge.daysLeft}d left`
      );
    }

    picks.push({
      card,
      rule,
      effective_mpd: effective,
      base_mpd: baseMpd,
      headroom_cents: headroom,
      cap_spent_cents: capSpent,
      miles,
      reasons,
      score,
    });
  }

  return picks.sort((a, b) => b.score - a.score);
}
