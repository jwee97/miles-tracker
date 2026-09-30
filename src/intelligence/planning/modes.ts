import { modesOf, rulesUnder, chosenOn, choicesOf, SELECTED, type CardMode } from '../../cards/modes';
import { ruleMatches, rulesForCard, type EarnRule, type Purchase } from '../../rules';
import { EFFECTIVE_DATE, money, resolveRange, today } from '../../spend';
import type { Card, Env } from '../../types';

/**
 * Which reward mode would have paid best.
 *
 * A card like the Trust Freedom makes you choose once a quarter and then live
 * with it, which is a decision nobody can make from the headline rates: 1.3 mpd
 * against 3% in stock against 5% on one category depends entirely on what you
 * actually buy and how much of it fits under each cap. The only honest way to
 * answer is to replay your own spending through each mode.
 *
 * Priced in memory rather than through the ledger's cap accounting, and that is
 * deliberate on both counts. It is cheaper — no query per transaction per mode,
 * which is what a Worker's fifty subrequests cannot afford. And it is more
 * correct: the caps the database holds were filled by the mode you were really
 * on, so asking it what a different mode's cap had left would answer about the
 * wrong world.
 *
 * What it will not do is tell anyone to spend. It reports on purchases already
 * made, and says so.
 */

export interface ModeOutcome {
  mode_key: string;
  label: string;
  payout: string;
  /** The category this was priced with, for modes that pick one. */
  category: string | null;
  /** What it would have been worth, in cents, at the configured mile value. */
  value_cents: number;
  miles: number;
  cashback_cents: number;
  /** Spend that earned at the bonus rate before a cap stopped it. */
  bonus_spend_cents: number;
  /** Spend that earned nothing, because the mode's rules do not cover it. */
  uncovered_cents: number;
  /** Cents lost to rounding a transaction down before earning on it. */
  rounded_away_cents: number;
  /** Whether this is the mode the card was actually on for the period. */
  selected: boolean;
  summary: string;
}

export interface ModeComparison {
  card: string;
  product: string;
  from: string | null;
  to: string | null;
  label: string;
  transactions: number;
  spend_cents: number;
  /** Best first. */
  modes: ModeOutcome[];
  /** What the best one is worth over the one actually selected. */
  better_by_cents: number;
  headline: string;
  caveats: string[];
  as_of: string;
}

export class NoModesError extends Error {}

const windowKey = (window: string | null, date: string) => {
  if (window === 'calendar_quarter') {
    const m = Number(date.slice(5, 7));
    return `${date.slice(0, 4)}Q${Math.floor((m - 1) / 3) + 1}`;
  }
  if (window === 'calendar_month' || !window) return date.slice(0, 7);
  // A statement cycle needs a statement day to be exact. Approximated by the
  // month here, and the caveats say so rather than the number implying more
  // precision than it has.
  return date.slice(0, 7);
};

/** The best rule for one purchase, by what it pays rather than by order. */
function pick(rules: EarnRule[], p: Purchase, mileValue: number): { matched: EarnRule | null; fallback: EarnRule | null } {
  const worth = (r: EarnRule) => (r.reward_type === 'cashback' ? r.mpd * 100 : r.mpd * mileValue);
  let matched: EarnRule | null = null;
  let fallback: EarnRule | null = null;
  for (const r of rules) {
    if (r.category === '*') {
      if (!fallback || worth(r) > worth(fallback)) fallback = r;
      continue;
    }
    if (r.category !== (p.category ?? '')) continue;
    if (!ruleMatches(r, p, [], null)) continue;
    if (!matched || worth(r) > worth(matched)) matched = r;
  }
  return { matched, fallback };
}

export async function modeComparison(
  env: Env,
  nickname: string,
  opts: { range?: string | null; from?: string | null; to?: string | null; limit?: number } = {}
): Promise<ModeComparison> {
  const card = await env.DB.prepare(`SELECT * FROM cards WHERE nickname = ? COLLATE NOCASE`)
    .bind(nickname.trim())
    .first<Card>();
  if (!card) throw new NoModesError(`no card with nickname "${nickname}"`);

  const productId = (card as unknown as { product_id?: number | null }).product_id ?? null;
  const modes = await modesOf(env, productId);
  if (!modes.length) throw new NoModesError(`${card.product} does not have selectable rewards`);

  const named = opts.from || opts.to ? (opts.range ?? null) : (opts.range ?? 'lastquarter');
  const { from, to, label } = resolveRange(env, named, opts.from ?? null, opts.to ?? null);
  const limit = Math.min(500, opts.limit ?? 400);

  const wheres = [`t.card_id = ?`, `t.amount_cents > 0`, `t.status <> 'refund'`];
  const args: unknown[] = [card.id];
  if (from) {
    wheres.push(`${EFFECTIVE_DATE} >= ?`);
    args.push(from);
  }
  if (to) {
    wheres.push(`${EFFECTIVE_DATE} <= ?`);
    args.push(to);
  }

  const { results: txns } = await env.DB.prepare(
    `SELECT t.id, t.amount_cents, t.occurred_at, t.posted_at, t.mcc, t.category, t.channel
       FROM transactions t
      WHERE ${wheres.join(' AND ')}
      ORDER BY ${EFFECTIVE_DATE}
      LIMIT ?`
  )
    .bind(...args, limit)
    .all<any>();

  const { results: excl } = await env.DB.prepare(
    `SELECT mcc FROM exclusions WHERE active = 1 AND (card_id IS NULL OR card_id = ?)`
  )
    .bind(card.id)
    .all<{ mcc: string }>();
  const excluded = new Set((excl ?? []).map((e) => e.mcc));

  // One read of the rules, on the last day of the window, so a versioned set
  // resolves the way it would for a purchase at the end of the period.
  const { rules: all } = await rulesForCard(env, card, to ?? today(env));
  const mileValue = parseFloat(env.MILE_VALUE_CENTS || '1.5');
  const history = await choicesOf(env, card.id);
  const actualMid = chosenOn(history, to ?? today(env));

  const spend = (txns ?? []).reduce((t: number, x: any) => t + x.amount_cents, 0);
  const outcomes: ModeOutcome[] = [];

  for (const mode of modes) {
    // A mode that also picks a category is priced with the category it is
    // actually set to when that is this mode, and otherwise with the one the
    // period's spending would have made best — anything else would compare a
    // mode against a category nobody would have chosen.
    const category = mode.picks_category ? bestCategoryFor(mode, txns ?? [], excluded) : null;
    const rules = rulesUnder(all, { mode_key: mode.mode_key, category } as any);

    const capUsed = new Map<string, number>();
    let miles = 0;
    let cashback = 0;
    let bonusSpend = 0;
    let uncovered = 0;
    let roundedAway = 0;

    for (const t of txns ?? []) {
      if (t.mcc && excluded.has(t.mcc)) {
        uncovered += t.amount_cents;
        continue;
      }
      const on = t.posted_at ?? t.occurred_at;
      const p: Purchase = { amount_cents: t.amount_cents, mcc: t.mcc, category: t.category, channel: t.channel };
      const { matched, fallback } = pick(rules, p, mileValue);
      const rule = matched ?? fallback;
      if (!rule) {
        uncovered += t.amount_cents;
        continue;
      }

      const step = rule.earn_step_cents ?? 0;
      const earnable = step > 1 ? Math.floor(t.amount_cents / step) * step : t.amount_cents;
      roundedAway += t.amount_cents - earnable;

      // The cap belongs to whichever rule is paying, base rate included: a
      // card that pays 3% on everything up to $500 a quarter is capped, and
      // treating the cap as something only a category rule can have priced it
      // as though it were not.
      let bonusPortion = earnable;
      let basePortion = 0;
      if (rule.cap_cents) {
        const key = `${rule.cap_group ?? rule.id}|${windowKey(rule.cap_window, on)}`;
        const used = capUsed.get(key) ?? 0;
        const headroom = Math.max(0, rule.cap_cents - used);
        bonusPortion = Math.min(earnable, headroom);
        basePortion = earnable - bonusPortion;
        capUsed.set(key, used + bonusPortion);
      }
      if (matched) bonusSpend += bonusPortion;

      // And what applies past the cap is never the capped rule again.
      const uncapped = rules.find((r) => r.category === '*' && !r.cap_cents) ?? null;
      const baseRate = uncapped?.mpd ?? 0;
      const baseType = uncapped?.reward_type ?? rule.reward_type;
      if (rule.reward_type === 'cashback') cashback += Math.round(bonusPortion * (rule.mpd / 100));
      else miles += Math.round((bonusPortion / 100) * rule.mpd);
      if (basePortion > 0 && baseRate > 0) {
        if (baseType === 'cashback') cashback += Math.round(basePortion * (baseRate / 100));
        else miles += Math.round((basePortion / 100) * baseRate);
      }
    }

    const value = Math.round(cashback + miles * mileValue);
    outcomes.push({
      mode_key: mode.mode_key,
      label: mode.label,
      payout: mode.payout,
      category,
      value_cents: value,
      miles,
      cashback_cents: cashback,
      bonus_spend_cents: bonusSpend,
      uncovered_cents: uncovered,
      rounded_away_cents: roundedAway,
      selected: actualMid?.mode_key === mode.mode_key,
      summary:
        `${mode.label} would have been worth $${money(value)}` +
        (miles ? ` (${miles.toLocaleString()} miles)` : '') +
        (cashback ? ` (${mode.payout === 'stock' ? `$${money(cashback)} of stock` : `$${money(cashback)} back`})` : '') +
        (category ? `, on ${category}` : ''),
    });
  }

  outcomes.sort((a, b) => b.value_cents - a.value_cents);
  const best = outcomes[0];
  const mine = outcomes.find((o) => o.selected) ?? null;
  const betterBy = mine ? best.value_cents - mine.value_cents : 0;

  const caveats = [
    'Measured on spending you have already done, not on what you might do. It is not a suggestion to spend more.',
    'Each mode is priced as if it had been the one in force for the whole period, including its caps.',
  ];
  if (outcomes.some((o) => o.rounded_away_cents > 0)) {
    caveats.push('Where a mode rounds a purchase down before paying on it, the rounding is applied — it is why small purchases earn less than the rate suggests.');
  }
  if (outcomes.some((o) => o.uncovered_cents > 0)) {
    caveats.push('Excluded merchant codes earn nothing under every mode, so they are left out of all of them equally.');
  }
  if (!mine) caveats.push('No mode is recorded as selected for this period, so there is nothing to compare the best one against.');

  return {
    card: card.nickname,
    product: card.product,
    from,
    to,
    label,
    transactions: (txns ?? []).length,
    spend_cents: spend,
    modes: outcomes,
    better_by_cents: betterBy,
    headline: !txns?.length
      ? `Nothing was spent on ${card.product} in ${label}, so there is nothing to compare.`
      : mine && betterBy > 0
        ? `${best.label} would have paid $${money(betterBy)} more than ${mine.label} on ${label}'s spending.`
        : mine
          ? `${mine.label} was the best of the ${outcomes.length} on ${label}'s spending.`
          : `${best.label} would have been worth most on ${label}'s spending.`,
    caveats,
    as_of: today(env),
  };
}

/**
 * For a mode that makes you pick a category, the one this period's spending
 * would have made best. Comparing "5% on a category" against a category picked
 * at random would answer a question nobody asked.
 */
function bestCategoryFor(mode: CardMode, txns: any[], excluded: Set<string>): string | null {
  const allowed = (mode.category_choices ?? '')
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
  if (!allowed.length) return null;

  const spendBy = new Map<string, number>();
  for (const t of txns) {
    if (t.mcc && excluded.has(t.mcc)) continue;
    const c = (t.category ?? '').toLowerCase();
    if (!allowed.includes(c)) continue;
    spendBy.set(c, (spendBy.get(c) ?? 0) + t.amount_cents);
  }
  let best: string | null = null;
  for (const [c, amount] of spendBy) if (!best || amount > (spendBy.get(best) ?? 0)) best = c;
  return best ?? allowed[0];
}

void SELECTED;
