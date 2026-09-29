import { rankCards } from '../../points';
import { activeCards, money, today } from '../../spend';
import type { Env } from '../../types';
import { capOutlook, minimumSpendOutlook, type CapOutlook, type MinSpendOutlook } from '../forecasting/plan';
import { forecastDimension } from '../forecasting/forecast';

/**
 * Not "which card for this purchase", but "how should I use my cards for the
 * rest of this month".
 *
 * The difference is caps. Asked about one purchase, the engine names the best
 * card and is right. Asked about a month, the same answer is wrong the moment
 * the bonus cap fills — and the person only discovers that after the fact,
 * when a transaction they expected to earn 4 mpd earned 0.4.
 *
 * So this allocates rather than ranks. For each kind of spending it takes what
 * the forecast expects, pours it into the best-paying card until that card's
 * cap is full, and spills the rest into the next one. What comes out is a
 * sequence — "the next $380 of online here, then move to that" — which is a
 * plan somebody can follow, rather than a recommendation they have to re-ask
 * for every time.
 *
 * Three things it refuses to do:
 *
 *  - **Forecast without history.** No forecast for a category means no plan
 *    for it, and the category is listed as unplanned with the reason.
 *  - **Invent a cap.** Only caps the rules engine knows about are filled. A
 *    card with no cap recorded is treated as uncapped, which is what the rules
 *    say, and the plan says so rather than guessing a limit.
 *  - **Tell anyone to spend.** Every figure is about money already expected to
 *    be spent. A minimum-spend shortfall is stated, never urged.
 */

export interface Allocation {
  card: string;
  product: string;
  /** How much of this category's expected spend to put here. */
  amount_cents: number;
  /** What it earns per dollar, in cents of value, at this position. */
  value_per_dollar: number;
  rate_text: string;
  /** Null when this card has no cap on this category. */
  cap_remaining_cents: number | null;
  /** Why this card and not another, in one line. */
  why: string;
}

export interface CategoryPlan {
  category: string;
  expected_cents: number;
  lower_cents: number;
  upper_cents: number;
  confidence: string;
  allocations: Allocation[];
  /** Spend with nowhere better to go than the base rate. */
  unallocated_cents: number;
  note: string | null;
}

export interface SpendPlan {
  period: { start: string; end: string; days_left: number };
  categories: CategoryPlan[];
  /** Categories with no forecast, and why. */
  unplanned: { category: string; reason: string }[];
  /** Minimums that will not be met on current spending, stated not urged. */
  minimums: MinSpendOutlook[];
  /** Caps already full, so the plan does not send spend at them. */
  exhausted: CapOutlook[];
  /** The plan in a few sentences, in the order worth reading. */
  headlines: string[];
  caveats: string[];
  as_of: string;
}

const MIN_WORTH_MOVING_CENTS = 2000;

/**
 * Plan one category: fill the best card, then the next.
 *
 * The ranking comes from the same engine that answers a single purchase, asked
 * with a nominal amount — so the plan and the per-purchase advice cannot
 * disagree about which card is better. What this adds is the cap arithmetic
 * the single-purchase question never has to do.
 */
async function planCategory(
  env: Env,
  category: string,
  expected: { expected_cents: number; lower_cents: number; upper_cents: number; confidence: string },
  caps: CapOutlook[]
): Promise<CategoryPlan> {
  const cards = await activeCards(env);
  const picks = await rankCards(env, category, 10000, { cards });

  const allocations: Allocation[] = [];
  let remaining = expected.expected_cents;

  for (const pick of picks) {
    if (remaining <= 0) break;
    if (!pick.card) continue;

    // Headroom from the pick itself where the rule has a cap, and from the
    // cap outlook where a shared cap group spans several categories.
    const group = caps.find(
      (c) => c.card.nickname === pick.card.nickname && c.categories.includes(category)
    );
    const headroom = group ? group.headroom_cents : pick.headroom_cents;

    // A card already at base rate adds nothing over the next one; stop rather
    // than listing every card in the wallet.
    if (allocations.length && pick.effective_mpd <= (picks[0]?.base_mpd ?? 0)) break;

    const take = headroom === null ? remaining : Math.min(remaining, headroom);
    if (take < MIN_WORTH_MOVING_CENTS && allocations.length) continue;
    if (take <= 0) continue;

    allocations.push({
      card: pick.card.nickname,
      product: pick.card.product,
      amount_cents: take,
      value_per_dollar: Math.round(pick.value_per_dollar * 1000) / 1000,
      rate_text: pick.reward_type === 'cashback' ? `${pick.effective_mpd}%` : `${pick.effective_mpd} mpd`,
      cap_remaining_cents: headroom,
      why:
        headroom === null
          ? `${pick.card.product} pays the most here and has no cap on it`
          : allocations.length === 0
            ? `${pick.card.product} pays the most here, with $${money(headroom)} of its cap left`
            : `then ${pick.card.product}, once the card above has filled`,
    });

    remaining -= take;
  }

  return {
    category,
    expected_cents: expected.expected_cents,
    lower_cents: expected.lower_cents,
    upper_cents: expected.upper_cents,
    confidence: expected.confidence,
    allocations,
    unallocated_cents: Math.max(0, remaining),
    note:
      remaining > 0 && allocations.length
        ? `About $${money(remaining)} has no card left paying a bonus on it — it earns the base rate wherever it goes.`
        : allocations.length === 0
          ? 'No card in your wallet pays a bonus on this.'
          : null,
  };
}

export async function monthlyPlan(
  env: Env,
  period: { start: string; end: string }
): Promise<SpendPlan> {
  const now = today(env);
  const daysLeft = Math.max(0, Math.round((Date.parse(period.end) - Date.parse(now)) / 86_400_000));

  const caps = await capOutlook(env);
  const minimums = await minimumSpendOutlook(env);

  // The categories worth planning are the ones actually spent in — plus any a
  // card pays a bonus on, since those are the ones where the choice matters.
  const { results } = await env.DB.prepare(
    `SELECT category, COUNT(*) AS n FROM transactions
      WHERE category IS NOT NULL AND amount_cents > 0
      GROUP BY category ORDER BY SUM(amount_cents) DESC LIMIT 8`
  ).all<{ category: string; n: number }>();

  const categories: CategoryPlan[] = [];
  const unplanned: { category: string; reason: string }[] = [];

  for (const row of results ?? []) {
    const f = await forecastDimension(env, {
      dimension_type: 'category',
      dimension_key: row.category,
      period_start: now,
      period_end: period.end,
    });
    if (!f) {
      unplanned.push({ category: row.category, reason: 'not enough history to say what you will spend' });
      continue;
    }
    categories.push(
      await planCategory(
        env,
        row.category,
        {
          expected_cents: f.expected_cents,
          lower_cents: f.lower_cents,
          upper_cents: f.upper_cents,
          confidence: f.confidence,
        },
        caps
      )
    );
  }

  categories.sort((a, b) => b.expected_cents - a.expected_cents);

  // --- what to read first ----------------------------------------------------
  const headlines: string[] = [];
  for (const c of categories) {
    const first = c.allocations[0];
    if (!first) continue;
    if (first.cap_remaining_cents !== null && first.cap_remaining_cents < c.expected_cents) {
      const next = c.allocations[1];
      headlines.push(
        `${c.category}: the next $${money(first.cap_remaining_cents)} on ${first.card}` +
          (next ? `, then move to ${next.card}` : ', after which nothing pays a bonus on it')
      );
    } else {
      headlines.push(`${c.category}: ${first.card} throughout — its cap covers what you are likely to spend`);
    }
  }
  for (const m of minimums) {
    if (m.state === 'at_risk' || m.state === 'unlikely') headlines.push(`${m.card.nickname}: ${m.outlook}`);
  }

  return {
    period: { ...period, days_left: daysLeft },
    categories,
    unplanned,
    minimums: minimums.filter((m) => m.state !== 'met'),
    exhausted: caps.filter((c) => c.state === 'filled'),
    headlines: headlines.slice(0, 6),
    caveats: [
      'Amounts are what you are forecast to spend, not what you should spend.',
      'Caps are read from your rules; a card with no cap recorded is treated as uncapped.',
      'A forecast is a range. Treat the split as an order to use cards in, not as a budget.',
    ],
    as_of: now,
  };
}
