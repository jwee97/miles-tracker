import { withReadCache } from '../../cache';
import { modeOn, modesOf, rulesUnder } from '../../cards/modes';
import { evaluate, rulesForCard } from '../../rules';
import { EFFECTIVE_DATE, membershipQuarter, money, resolveRange, today } from '../../spend';
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



export async function modeComparison(
  env: Env,
  nickname: string,
  opts: { range?: string | null; from?: string | null; to?: string | null; limit?: number } = {}
): Promise<ModeComparison> {
  // Nothing here writes, and each purchase is priced once per mode and per
  // pickable category — so the reference data it reads (rules, exclusions,
  // the card's modes) is read once for the run rather than once per pricing.
  env = withReadCache(env);
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
    `SELECT t.id, t.amount_cents, t.occurred_at, t.posted_at, t.mcc, t.category, t.channel, t.is_foreign
       FROM transactions t
      WHERE ${wheres.join(' AND ')}
      ORDER BY ${EFFECTIVE_DATE}, t.id
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

  const { rules: all } = await rulesForCard(env, card, to ?? today(env));
  const actualMid = await modeOn(env, card.id, to ?? today(env), productId);

  // For a mode whose bonus depends on the quarter's lowest month — Trust's
  // S$500 or S$2,000 in EVERY month of the quarter — the rung each purchase's
  // quarter held, worked out from the same spending. The rungs are read off
  // the rules themselves, so nothing has to be configured twice.
  const tierFor = quarterTiers(card, txns ?? [], excluded);

  const spend = (txns ?? []).reduce((t: number, x: any) => t + x.amount_cents, 0);
  const outcomes: ModeOutcome[] = [];

  for (const mode of modes) {
    // A mode that also picks a category is priced once per category it offers,
    // and the best is kept: comparing "5% on a category" against a category
    // nobody would have picked answers a question nobody asked. Priced rather
    // than guessed from spend-by-category, because Trust defines its categories
    // by merchant code and the app's own category word is not the same thing.
    const picks = mode.picks_category
      ? (mode.category_choices ?? '').split(',').map((c) => c.trim().toLowerCase()).filter(Boolean)
      : [null];
    const rungs = [
      ...new Set(
        rulesUnder(all, { mode_key: mode.mode_key, category: picks[0] } as any)
          .map((r) => r.min_tier_cents)
          .filter((n): n is number => !!n)
      ),
    ].sort((a, b) => a - b);

    let best: Omit<ModeOutcome, 'mode_key' | 'label' | 'payout' | 'selected' | 'summary'> | null = null;
    for (const pick of picks) {
      // Priced through the engine itself, so a comparison can never disagree
      // with what the engine would say about the same purchase — the earlier
      // version copied the matching and had already drifted from it twice.
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
        const held = tierFor(t.occurred_at);
        const tier = rungs.filter((r) => held >= r).pop() ?? 0;
        const e = await evaluate(
          env,
          card,
          {
            amount_cents: t.amount_cents,
            mcc: t.mcc,
            category: t.category,
            channel: t.channel,
            foreign: t.is_foreign == null ? null : !!t.is_foreign,
          },
          {
            on,
            authorised_on: t.occurred_at,
            mode: { mode_key: mode.mode_key, category: pick },
            capUsed,
            tier_cents: rungs.length ? tier : undefined,
            exclusions: [],
            value_only: true,
          }
        );
        if (!e.rule) {
          uncovered += t.amount_cents;
          continue;
        }
        miles += e.miles;
        cashback += e.cashback_cents;
        bonusSpend += e.bonus_portion_cents && e.rule?.category !== '*' ? e.bonus_portion_cents : 0;
        roundedAway += t.amount_cents - (e.bonus_portion_cents + e.base_portion_cents);
      }

      const candidate = {
        category: pick,
        value_cents: Math.round(cashback + miles * parseFloat(env.MILE_VALUE_CENTS || '1.5')),
        miles,
        cashback_cents: cashback,
        bonus_spend_cents: bonusSpend,
        uncovered_cents: uncovered,
        rounded_away_cents: roundedAway,
      };
      if (!best || candidate.value_cents > best.value_cents) best = candidate;
    }

    const { category, value_cents: value, miles, cashback_cents: cashback, bonus_spend_cents: bonusSpend, uncovered_cents: uncovered, rounded_away_cents: roundedAway } = best!;
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
 * The spend rung each quarter held: the LOWEST calendar month's eligible spend
 * in that quarter, which is what "hit the minimum in all three months" means.
 *
 * Quarters are the card's own — three calendar months from the month it was
 * approved — and fall back to calendar quarters only when no opening date is
 * known. A month with no purchases in the data counts as nothing spent, which
 * understates a quarter still in progress; the caveats say so.
 */
function quarterTiers(
  card: Card,
  txns: { amount_cents: number; occurred_at: string; mcc: string | null }[],
  excluded: Set<string>
): (date: string) => number {
  const byMonth = new Map<string, number>();
  for (const t of txns) {
    if (t.mcc && excluded.has(t.mcc)) continue;
    const m = t.occurred_at.slice(0, 7);
    byMonth.set(m, (byMonth.get(m) ?? 0) + t.amount_cents);
  }
  const anchor = card.opened_at ?? null;
  return (date: string) => {
    const q = anchor
      ? membershipQuarter(anchor, date)
      : membershipQuarter(`${date.slice(0, 4)}-01-01`, date);
    return Math.min(...q.months.map((m) => byMonth.get(m.start.slice(0, 7)) ?? 0));
  };
}
