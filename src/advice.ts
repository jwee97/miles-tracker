import { money, today, EFFECTIVE_DATE } from './spend';
import type { EarnRule } from './rules';
import type { Card, Env } from './types';

/** Cents of reward value per dollar spent — the one scale everything compares on. */
function valuePerDollar(rule: EarnRule | null, mileValue: number): number {
  if (!rule) return 0;
  return rule.reward_type === 'cashback' ? rule.mpd : rule.mpd * mileValue;
}

/** A cap expressed as a monthly allowance, whatever window it really resets on. */
function monthlyCap(rule: EarnRule): number {
  if (!rule.cap_cents) return Infinity;
  if (rule.cap_window === 'calendar_quarter') return rule.cap_cents / 3;
  return rule.cap_cents; // statement_cycle and calendar_month are both monthly
}

function ruleFor(rules: EarnRule[], cardId: number, category: string): EarnRule | null {
  const mine = rules.filter((r) => r.card_id === cardId);
  return mine.find((r) => r.category === category) ?? mine.find((r) => r.category === '*') ?? null;
}

export interface Reallocation {
  category: string;
  monthly_cents: number;
  from_card: string;
  from_rate: string;
  to_card: string;
  to_rate: string;
  movable_cents: number;
  gain_cents_year: number;
  gain_miles_year: number;
  capped_by: string | null;
}

export interface UnderusedCap {
  card: string;
  category: string;
  cap_cents: number;
  typical_used_cents: number;
  utilisation_pct: number;
  unused_value_cents_year: number;
  better_category: { category: string; monthly_cents: number; gain_cents_year: number } | null;
}

export interface Optimisation {
  months_analysed: number;
  reallocations: Reallocation[];
  underused: UnderusedCap[];
  total_gain_cents_year: number;
  notes: string[];
}

/**
 * Replays your own spending through the rules engine to find where the same
 * money would earn more. Only meaningful with a few months of history, so the
 * window is stated and short histories say so rather than extrapolating from
 * one unusual month.
 */
export async function optimise(env: Env, months = 3): Promise<Optimisation> {
  const mileValue = parseFloat(env.MILE_VALUE_CENTS || '1.5');
  const now = today(env);
  const since = new Date(Date.parse(now + 'T00:00:00Z') - months * 31 * 86400_000).toISOString().slice(0, 10);

  const { results: cards } = await env.DB.prepare(
    `SELECT * FROM cards WHERE closed_at IS NULL ORDER BY id`
  ).all<Card>();
  const { results: rules } = await env.DB.prepare(`SELECT * FROM earn_rules WHERE active = 1`).all<EarnRule>();
  const { results: exclusions } = await env.DB.prepare(
    `SELECT card_id, mcc FROM exclusions WHERE active = 1`
  ).all<{ card_id: number | null; mcc: string }>();

  // How many distinct months the history actually covers, so the monthly
  // average is divided by real months rather than the window asked for.
  const span = await env.DB.prepare(
    `SELECT COUNT(DISTINCT substr(${EFFECTIVE_DATE}, 1, 7)) AS n FROM transactions
     WHERE amount_cents > 0 AND ${EFFECTIVE_DATE} >= ?`
  )
    .bind(since)
    .first<{ n: number }>();
  const realMonths = Math.max(1, span?.n ?? 1);

  const { results: spend } = await env.DB.prepare(
    `SELECT card_id, COALESCE(category, 'uncategorised') AS category, SUM(amount_cents) AS cents
     FROM transactions
     WHERE amount_cents > 0 AND ${EFFECTIVE_DATE} >= ?
     GROUP BY card_id, category`
  )
    .bind(since)
    .all<{ card_id: number; category: string; cents: number }>();

  const notes: string[] = [];
  if (realMonths < 2) {
    notes.push('Only one month of history — these figures will firm up as more accumulates.');
  }

  // --- where the same money would earn more --------------------------------
  const byCategory = new Map<string, Map<number, number>>();
  for (const s of spend ?? []) {
    if (s.category === 'uncategorised') continue; // no reliable rate without a category
    const m = byCategory.get(s.category) ?? new Map<number, number>();
    m.set(s.card_id, (m.get(s.card_id) ?? 0) + s.cents);
    byCategory.set(s.category, m);
  }

  // What each card already carries per month, per cap group, so a suggestion
  // does not propose spend the target card has no room for.
  const usedInGroup = new Map<string, number>();
  for (const s of spend ?? []) {
    const r = ruleFor(rules ?? [], s.card_id, s.category);
    if (!r?.cap_cents) continue;
    const key = `${s.card_id}:${r.cap_group ?? r.category}`;
    usedInGroup.set(key, (usedInGroup.get(key) ?? 0) + s.cents / realMonths);
  }

  const reallocations: Reallocation[] = [];
  for (const [category, perCard] of byCategory) {
    const monthly = [...perCard.values()].reduce((a, b) => a + b, 0) / realMonths;
    if (monthly < 2000) continue; // under $20 a month is not worth moving

    // The card most of it currently goes on.
    const [currentCardId] = [...perCard.entries()].sort((a, b) => b[1] - a[1])[0];
    const currentCard = (cards ?? []).find((c) => c.id === currentCardId);
    if (!currentCard) continue;
    const currentRule = ruleFor(rules ?? [], currentCardId, category);
    const currentVpd = valuePerDollar(currentRule, mileValue);

    let best: { card: Card; rule: EarnRule; vpd: number; room: number } | null = null;
    for (const c of cards ?? []) {
      if (c.id === currentCardId) continue;
      const r = ruleFor(rules ?? [], c.id, category);
      if (!r) continue;
      const vpd = valuePerDollar(r, mileValue);
      if (vpd <= currentVpd) continue;

      const cap = monthlyCap(r);
      const key = `${c.id}:${r.cap_group ?? r.category}`;
      const room = cap === Infinity ? Infinity : Math.max(0, cap - (usedInGroup.get(key) ?? 0));
      if (room <= 0) continue;
      if (!best || vpd > best.vpd) best = { card: c, rule: r, vpd, room };
    }
    if (!best) continue;

    const movable = Math.min(monthly, best.room);
    if (movable < 1000) continue;

    const gainPerMonth = (movable / 100) * (best.vpd - currentVpd);
    const gainYear = Math.round(gainPerMonth * 12);
    if (gainYear < 500) continue; // under $5 a year is noise

    const describe = (r: EarnRule | null) =>
      !r ? 'no rule' : r.reward_type === 'cashback' ? `${r.mpd}% back` : `${r.mpd} mpd`;

    reallocations.push({
      category,
      monthly_cents: Math.round(monthly),
      from_card: currentCard.product,
      from_rate: describe(currentRule),
      to_card: best.card.product,
      to_rate: describe(best.rule),
      movable_cents: Math.round(movable),
      gain_cents_year: gainYear,
      // The GAIN, not the target card's total. Reporting the total would
      // overstate the benefit by whatever the current card already earns.
      gain_miles_year:
        best.rule.reward_type === 'miles' && currentRule?.reward_type === 'miles'
          ? Math.round((movable / 100) * (best.rule.mpd - currentRule.mpd) * 12)
          : 0,
      capped_by:
        best.room < monthly
          ? `${best.card.product}'s $${money(best.rule.cap_cents ?? 0)} cap — only $${money(movable)} a month fits`
          : null,
    });
  }
  reallocations.sort((a, b) => b.gain_cents_year - a.gain_cents_year);

  // --- bonus allowances going to waste --------------------------------------
  const underused: UnderusedCap[] = [];
  for (const r of (rules ?? []).filter((x) => x.cap_cents && x.category !== '*')) {
    const card = (cards ?? []).find((c) => c.id === r.card_id);
    if (!card) continue;

    const group = (rules ?? []).filter((x) => x.card_id === r.card_id && (r.cap_group ? x.cap_group === r.cap_group : x.id === r.id));
    const cats = new Set(group.map((g) => g.category));
    const used =
      (spend ?? [])
        .filter((s) => s.card_id === r.card_id && cats.has(s.category))
        .reduce((a, b) => a + b.cents, 0) / realMonths;

    const cap = monthlyCap(r);
    if (cap === Infinity) continue;
    const pct = (used / cap) * 100;
    if (pct >= 50) continue; // most of it is being used; nothing to say

    const spare = cap - used;
    const vpd = valuePerDollar(r, mileValue);
    const baseRule = ruleFor(rules ?? [], r.card_id, '*');
    const baseVpd = valuePerDollar(baseRule, mileValue);

    // Is there a category you spend on that this card does not currently boost?
    // That is the case for a card whose bonus category you choose.
    let better: UnderusedCap['better_category'] = null;
    for (const [category, perCard] of byCategory) {
      if (cats.has(category)) continue;
      const monthly = [...perCard.values()].reduce((a, b) => a + b, 0) / realMonths;
      if (monthly < spare * 0.5) continue;
      const currentBest = Math.max(
        ...(cards ?? []).map((c) => valuePerDollar(ruleFor(rules ?? [], c.id, category), mileValue))
      );
      if (vpd <= currentBest) continue;
      const movable = Math.min(monthly, cap);
      const gain = Math.round((movable / 100) * (vpd - currentBest) * 12);
      if (gain < 500) continue;
      if (!better || gain > better.gain_cents_year) {
        better = { category, monthly_cents: Math.round(monthly), gain_cents_year: gain };
      }
    }

    underused.push({
      card: card.product,
      category: [...cats].join(', '),
      cap_cents: r.cap_cents!,
      typical_used_cents: Math.round(used),
      utilisation_pct: Math.round(pct),
      unused_value_cents_year: Math.round((spare / 100) * (vpd - baseVpd) * 12),
      better_category: better,
    });
  }
  underused.sort((a, b) => b.unused_value_cents_year - a.unused_value_cents_year);

  if (!reallocations.length && !underused.length && (spend ?? []).length > 0) {
    notes.push('Nothing worth moving — your spend is already on the best card for each category.');
  }
  if ((spend ?? []).some((s) => s.category === 'uncategorised')) {
    notes.push('Uncategorised spend is excluded here: without a category there is no rate to compare.');
  }
  if ((exclusions ?? []).length) {
    notes.push('Excluded MCCs are not considered — moving spend that earns nothing anywhere gains nothing.');
  }

  return {
    months_analysed: realMonths,
    reallocations,
    underused,
    total_gain_cents_year: reallocations.reduce((s, r) => s + r.gain_cents_year, 0),
    notes,
  };
}
