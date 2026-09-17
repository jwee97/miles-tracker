import { money, today } from '../spend';
import { rulesForCard } from '../rules';
import type { Env } from '../types';

/**
 * Where the current wallet is weak.
 *
 * Gaps come first, and card candidates second. Starting from cards produces a
 * list of products someone might sell you; starting from your own spending
 * produces the question worth answering — which capability is missing — and
 * that question sometimes has the answer "none", which a card-first approach
 * can never reach.
 */

export interface SpendSlice {
  category: string;
  mcc: string | null;
  monthly_cents: number;
  transactions: number;
  /** What it actually earned, in cents of value. */
  earned_value_cents: number;
  /** Value per dollar spent, which is what makes slices comparable. */
  return_pct: number;
}

export interface PortfolioGap {
  category: string;
  monthly_cents: number;
  return_pct: number;
  /** The reason it is a gap, in words. */
  detail: string;
  severity: 'high' | 'medium' | 'low';
}

/** How many months of history to read by default. */
export const DEFAULT_HISTORY_MONTHS = 6;

/**
 * Whether any card you hold pays a BONUS on a category, as opposed to its
 * ordinary rate on everything.
 *
 * An absolute return threshold does not work here: a flat 1.2 mpd card returns
 * the same percentage on dining as on stamps, so by that measure nothing is
 * ever uncovered — even though a dining card paying four times as much exists.
 * The question that matters is whether anything you hold treats this category
 * as special.
 */
export async function bonusCoverage(
  env: Env,
  category: string
): Promise<{ covered: boolean; cards: string[]; capped_at_cents: number | null }> {
  const { results: cards } = await env.DB.prepare(`SELECT * FROM cards WHERE closed_at IS NULL`).all<any>();
  const covering: string[] = [];
  let cap: number | null = null;

  for (const card of cards ?? []) {
    const { rules } = await rulesForCard(env, card, today(env));
    const base = rules.find((r) => r.category === '*');
    const match = rules.find((r) => r.category === category);
    if (!match) continue;
    // A rule for the category that pays no more than the catch-all is not
    // bonus coverage; it is the base rate written out twice.
    if (base && match.mpd <= base.mpd) continue;
    covering.push(card.product);
    if (match.cap_cents !== null) cap = cap === null ? match.cap_cents : Math.max(cap, match.cap_cents);
    else cap = null;
  }

  return { covered: covering.length > 0, cards: covering, capped_at_cents: cap };
}

const monthsAgo = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
};

export interface SpendingProfile {
  from: string;
  to: string;
  months: number;
  /** Months that actually contain transactions, which is what confidence rests on. */
  months_with_data: number;
  total_monthly_cents: number;
  slices: SpendSlice[];
}

/**
 * What this person actually spends on, and what it earns.
 *
 * Grouped by category rather than by merchant: a card is chosen for a category,
 * and forty merchants in one category is one gap, not forty.
 */
export async function spendingProfile(env: Env, months = DEFAULT_HISTORY_MONTHS): Promise<SpendingProfile> {
  const to = today(env);
  const from = monthsAgo(to, months);
  const mileValue = parseFloat(env.MILE_VALUE_CENTS || '1.5');

  const { results } = await env.DB.prepare(
    `SELECT COALESCE(NULLIF(TRIM(category), ''), 'uncategorised') AS category,
            SUM(amount_cents) AS spent,
            COUNT(*) AS n,
            SUM(COALESCE(expected_miles, 0)) AS miles,
            SUM(COALESCE(expected_cashback_cents, 0)) AS cash
       FROM transactions
      WHERE amount_cents > 0 AND COALESCE(posted_at, occurred_at) BETWEEN ? AND ?
      GROUP BY category
      ORDER BY spent DESC`
  )
    .bind(from, to)
    .all<{ category: string; spent: number; n: number; miles: number; cash: number }>();

  const withData = await env.DB.prepare(
    `SELECT COUNT(DISTINCT substr(COALESCE(posted_at, occurred_at), 1, 7)) AS n
       FROM transactions WHERE amount_cents > 0 AND COALESCE(posted_at, occurred_at) BETWEEN ? AND ?`
  )
    .bind(from, to)
    .first<{ n: number }>();

  const slices: SpendSlice[] = (results ?? []).map((r) => {
    const value = r.miles * mileValue + r.cash;
    return {
      category: r.category,
      mcc: null,
      monthly_cents: Math.round(r.spent / months),
      transactions: r.n,
      earned_value_cents: Math.round(value),
      return_pct: r.spent > 0 ? (value / r.spent) * 100 : 0,
    };
  });

  return {
    from,
    to,
    months,
    months_with_data: withData?.n ?? 0,
    total_monthly_cents: slices.reduce((t, s) => t + s.monthly_cents, 0),
    slices,
  };
}

/** Spend small enough that no card is worth acquiring for it. */
export const MATERIAL_MONTHLY_CENTS = 15000;

/**
 * The gaps worth naming.
 *
 * A category is a gap when real money goes through it at roughly the base rate.
 * Spend that is already well covered is not a gap however large it is — and
 * saying so is the more useful half of this feature, because it is what stops
 * someone acquiring a card they do not need.
 */
export async function portfolioGaps(env: Env, months = DEFAULT_HISTORY_MONTHS): Promise<PortfolioGap[]> {
  const profile = await spendingProfile(env, months);
  const gaps: PortfolioGap[] = [];

  for (const s of profile.slices) {
    if (s.monthly_cents < MATERIAL_MONTHLY_CENTS) continue;
    if (s.category === 'uncategorised') {
      gaps.push({
        category: s.category,
        monthly_cents: s.monthly_cents,
        return_pct: s.return_pct,
        detail: `$${money(s.monthly_cents)} a month has no category, so no card can be judged against it.`,
        severity: 'medium',
      });
      continue;
    }
    const cover = await bonusCoverage(env, s.category);
    if (cover.covered && cover.capped_at_cents === null) continue;
    // A covered category whose cap you exceed is handled below, as a cap gap.
    if (cover.covered) continue;

    gaps.push({
      category: s.category,
      monthly_cents: s.monthly_cents,
      return_pct: s.return_pct,
      detail: `$${money(s.monthly_cents)} a month on ${s.category} with no card of yours paying a bonus on it — it earns about ${s.return_pct.toFixed(2)}% in value.`,
      severity: s.monthly_cents >= 40000 ? 'high' : s.monthly_cents >= 20000 ? 'medium' : 'low',
    });
  }

  // Spend past a cap is a gap of a different shape: the category IS covered,
  // just not all of it, and a second card is the usual answer.
  const { results: cards } = await env.DB.prepare(
    `SELECT * FROM cards WHERE closed_at IS NULL`
  ).all<any>();
  for (const card of cards ?? []) {
    const { rules } = await rulesForCard(env, card, today(env));
    for (const rule of rules) {
      if (!rule.cap_cents) continue;
      const spent = await env.DB.prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM transactions
          WHERE card_id = ? AND amount_cents > 0 AND COALESCE(category, '*') = ?
            AND COALESCE(posted_at, occurred_at) BETWEEN ? AND ?`
      )
        .bind(card.id, rule.category, profile.from, profile.to)
        .first<{ total: number }>();

      const monthly = Math.round((spent?.total ?? 0) / months);
      const over = monthly - rule.cap_cents;
      if (over < MATERIAL_MONTHLY_CENTS) continue;

      gaps.push({
        category: rule.category,
        monthly_cents: over,
        return_pct: 0,
        detail: `$${money(over)} a month of ${rule.category} spend runs past ${card.product}'s $${money(rule.cap_cents)} cap and earns the base rate.`,
        severity: over >= 40000 ? 'high' : 'medium',
      });
    }
  }

  return gaps.sort((a, b) => b.monthly_cents - a.monthly_cents);
}
