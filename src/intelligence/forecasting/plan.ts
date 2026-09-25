import { activeCards, calendarMonth, calendarQuarter, money, statementCycle, today } from '../../spend';
import { requirementProgress, requirementsFor, type Progress } from '../../spend';
import type { Card, Env } from '../../types';
import { INTERVAL_Z } from './baselines';
import { forecastDimension, type Confidence } from './forecast';

/**
 * What the forecast means for the things that actually pay.
 *
 * The forecast on its own is trivia. "You will probably spend $430 on dining"
 * is worth nothing; "your 4 mpd dining cap runs out around the 22nd, and
 * everything after that earns 0.4" is worth something, and the difference is
 * entirely the deterministic engine — caps, statement cycles, requirement
 * ladders — which is where every number below comes from.
 *
 * The division of labour is strict. The statistics estimate ONE uncertain
 * thing: how much more will be spent before the window closes. Every other
 * figure here — what the cap is, what has been spent against it, what the
 * minimum is, what tier it pays — is read from the ledger and the rules.
 *
 * And it does not tell anyone to spend. A cap outlook says where the next
 * dollar stops earning extra so it can be put somewhere better; a minimum
 * outlook states the requirement, the progress and the shortfall. Neither
 * suggests buying anything.
 */

/** Φ(z) — Abramowitz & Stegun 26.2.17, good to ~7 decimal places. */
function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

/**
 * How likely a total is to reach a threshold, given a forecast interval.
 *
 * The interval is treated as ±z·σ around the expectation, which is the same
 * assumption that produced it — so this is not adding a claim, it is reading
 * the one already made. Returns null when the forecast carries no spread,
 * because a probability computed from zero variance is always 0 or 1 and means
 * nothing.
 */
export function probabilityOfReaching(
  already: number,
  forecast: { expected_cents: number; lower_cents: number; upper_cents: number },
  threshold: number
): number | null {
  const sigma = (forecast.upper_cents - forecast.lower_cents) / (2 * INTERVAL_Z);
  if (!(sigma > 0)) return null;
  const shortfall = threshold - already - forecast.expected_cents;
  return Math.round((1 - normalCdf(shortfall / sigma)) * 100) / 100;
}

const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// --- caps -----------------------------------------------------------------

export interface CapOutlook {
  card: { id: number; nickname: string; product: string };
  /** The cap group, or the single category when a rule has none. */
  group: string;
  categories: string[];
  rate: number;
  reward_type: 'miles' | 'cashback';
  window: { start: string; end: string };
  cap_cents: number;
  spent_cents: number;
  headroom_cents: number;
  /** Forecast spend in these categories over the rest of the window. */
  expected_further_cents: number | null;
  /** 0–1, or null when there is no forecast to compute it from. */
  probability_of_filling: number | null;
  /** Rough date the cap fills at the forecast rate. Null if it will not. */
  fills_on: string | null;
  confidence: Confidence | null;
  state: 'filled' | 'likely_to_fill' | 'unlikely_to_fill' | 'unknown';
  /** What to do about it, in one sentence, or null when there is nothing to do. */
  advice: string | null;
}

interface CapRule {
  id: number;
  card_id: number;
  category: string;
  mpd: number;
  reward_type: 'miles' | 'cashback';
  cap_cents: number | null;
  cap_group: string | null;
  cap_window: string | null;
}

function windowFor(w: string | null, card: Card, env: Env) {
  if (w === 'calendar_month') return calendarMonth(env);
  if (w === 'calendar_quarter') return calendarQuarter(env);
  return statementCycle(card.statement_day, env);
}

async function spentAgainst(
  env: Env,
  card: Card,
  categories: string[],
  win: { start: string; end: string }
): Promise<number> {
  const placeholders = categories.map(() => '?').join(',');
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM transactions
      WHERE card_id = ? AND COALESCE(posted_at, occurred_at) >= ? AND COALESCE(posted_at, occurred_at) <= ?
        AND amount_cents > 0 AND COALESCE(category, '*') IN (${placeholders})`
  )
    .bind(card.id, win.start, win.end, ...categories)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/**
 * Every capped bonus rate, and whether this window's spending will exhaust it.
 *
 * Rules sharing a `cap_group` share one cap, so they are reported as one row —
 * treating them separately would report two half-full caps where there is one
 * full one, which is the sort of error that reads as plausible for months.
 */
export async function capOutlook(env: Env): Promise<CapOutlook[]> {
  const now = today(env);
  const out: CapOutlook[] = [];

  for (const card of await activeCards(env)) {
    const { results } = await env.DB.prepare(
      `SELECT id, card_id, category, mpd, reward_type, cap_cents, cap_group, cap_window
         FROM earn_rules WHERE card_id = ? AND active = 1 AND cap_cents IS NOT NULL AND cap_cents > 0`
    )
      .bind(card.id)
      .all<CapRule>();

    const groups = new Map<string, CapRule[]>();
    for (const r of results ?? []) {
      const key = r.cap_group ?? r.category;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }

    for (const [key, rules] of groups) {
      const lead = rules[0];
      const categories = [...new Set(rules.map((r) => r.category))];
      const win = windowFor(lead.cap_window, card, env);
      const cap = lead.cap_cents ?? 0;
      const spent = await spentAgainst(env, card, categories, win);
      const headroom = Math.max(0, cap - spent);
      const daysLeft = Math.max(0, Math.round((Date.parse(win.end) - Date.parse(now)) / 86_400_000));

      // The forecast covers the REST of the window only. Forecasting the whole
      // window and comparing it to a partial spend would double-count what has
      // already happened.
      let expected: number | null = null;
      let probability: number | null = null;
      let fillsOn: string | null = null;
      let confidence: Confidence | null = null;

      if (headroom > 0 && daysLeft > 0) {
        // One forecast per category in the group, added together: the cap is
        // shared, so the spend that fills it is too.
        let sumExpected = 0;
        let sumLower = 0;
        let sumUpper = 0;
        let any = false;
        for (const cat of categories) {
          if (cat === '*') continue;
          const f = await forecastDimension(env, {
            dimension_type: 'category',
            dimension_key: cat,
            period_start: now,
            period_end: win.end,
          });
          if (!f) continue;
          any = true;
          confidence = f.confidence;
          sumExpected += f.expected_cents;
          sumLower += f.lower_cents;
          sumUpper += f.upper_cents;
        }
        if (any) {
          expected = sumExpected;
          probability = probabilityOfReaching(spent, {
            expected_cents: sumExpected,
            lower_cents: sumLower,
            upper_cents: sumUpper,
          }, cap);
          const perDay = sumExpected / daysLeft;
          if (perDay > 0 && headroom / perDay <= daysLeft) {
            fillsOn = addDays(now, Math.ceil(headroom / perDay));
          }
        }
      }

      // A perfectly regular history produces a forecast with no spread, and
      // therefore no probability — the interval is a point. That is not a
      // reason to say "unknown": the point estimate is all there is, so it is
      // compared directly, and the probability stays null rather than being
      // reported as a confident 0 or 1.
      const state: CapOutlook['state'] =
        headroom === 0
          ? 'filled'
          : probability !== null
            ? probability >= 0.5
              ? 'likely_to_fill'
              : 'unlikely_to_fill'
            : expected === null
              ? 'unknown'
              : expected >= headroom
                ? 'likely_to_fill'
                : 'unlikely_to_fill';

      const rateText = lead.reward_type === 'cashback' ? `${lead.mpd}%` : `${lead.mpd} mpd`;
      const advice =
        state === 'filled'
          ? `The ${rateText} cap on ${card.nickname} is full for this window — further ${categories.join('/')} spending earns the base rate, so another card is likely to pay more.`
          : state === 'likely_to_fill' && fillsOn
            ? `At your usual pace the ${rateText} cap on ${card.nickname} fills around ${fillsOn}; ${categories.join('/')} spending after that earns the base rate.`
            : state === 'likely_to_fill'
              ? `The ${rateText} cap on ${card.nickname} looks likely to fill before ${win.end}.`
              : null;

      out.push({
        card: { id: card.id, nickname: card.nickname, product: card.product },
        group: key,
        categories,
        rate: lead.mpd,
        reward_type: lead.reward_type,
        window: win,
        cap_cents: cap,
        spent_cents: spent,
        headroom_cents: headroom,
        expected_further_cents: expected,
        probability_of_filling: probability,
        fills_on: fillsOn,
        confidence,
        state,
        advice,
      });
    }
  }

  // Full caps first, then the ones about to fill: both are actionable today,
  // and a cap with months of headroom is not.
  const rank = (c: CapOutlook) =>
    c.state === 'filled' ? 0 : c.state === 'likely_to_fill' ? 1 : c.state === 'unknown' ? 2 : 3;
  return out.sort((a, b) => rank(a) - rank(b) || (b.probability_of_filling ?? 0) - (a.probability_of_filling ?? 0));
}

// --- minimum spend --------------------------------------------------------

export type MinSpendState = 'met' | 'on_track' | 'at_risk' | 'unlikely' | 'lost' | 'unknown';

export interface MinSpendOutlook {
  card: { id: number; nickname: string; product: string };
  requirement_id: number;
  label: string;
  window: { start: string; end: string };
  days_left: number;
  required_cents: number;
  spent_cents: number;
  shortfall_cents: number;
  /** Forecast spend on this card over the rest of the window. */
  expected_further_cents: number | null;
  probability_of_meeting: number | null;
  confidence: Confidence | null;
  state: MinSpendState;
  /** Plain statement of where things stand. Never an instruction to spend. */
  outlook: string;
  /** Transactions still required, where the card gates on a count as well. */
  txns_remaining: number;
}

function stateFor(p: Progress, probability: number | null, expected: number | null): MinSpendState {
  if (p.met) return 'met';
  // A quarter with a closed month short cannot be recovered, and saying "at
  // risk" about it would suggest an action that cannot work.
  if (p.months.length > 0 && p.months_missed > 0 && !p.thirds) return 'lost';
  if (probability !== null) {
    if (probability >= 0.8) return 'on_track';
    if (probability >= 0.35) return 'at_risk';
    return 'unlikely';
  }
  // No spread to reason with: compare the point estimate and say so in the
  // wording rather than inventing a confidence.
  if (expected === null) return 'unknown';
  return p.spent_cents + expected >= p.floor_cents ? 'on_track' : 'unlikely';
}

/**
 * Where each minimum stands, and how likely it is to be met on current
 * spending.
 *
 * The probability is the forecast's own interval read against the shortfall —
 * no new assumption. It is reported so that "you are $400 short with 6 days
 * left" and "you are $400 short with 26 days left" stop looking like the same
 * sentence.
 */
export async function minimumSpendOutlook(env: Env): Promise<MinSpendOutlook[]> {
  const now = today(env);
  const out: MinSpendOutlook[] = [];

  for (const card of await activeCards(env)) {
    for (const req of await requirementsFor(env, card.id)) {
      const p = await requirementProgress(env, card, req);

      let expected: number | null = null;
      let probability: number | null = null;
      let confidence: Confidence | null = null;

      if (!p.met && p.days_left > 0 && p.remaining_cents > 0) {
        const f = await forecastDimension(env, {
          dimension_type: 'card',
          dimension_key: String(card.id),
          period_start: now,
          period_end: p.window.end,
        });
        if (f) {
          expected = f.expected_cents;
          confidence = f.confidence;
          probability = probabilityOfReaching(p.spent_cents, f, p.floor_cents);
        }
      }

      const state = stateFor(p, probability, expected);
      const pct = probability === null ? null : Math.round(probability * 100);

      const outlook =
        state === 'met'
          ? `Met: $${money(p.spent_cents)} of $${money(p.floor_cents)}.`
          : state === 'lost'
            ? `This window's bonus can no longer be reached — a statement month closed below the minimum.`
            : `$${money(p.remaining_cents)} short of $${money(p.floor_cents)}, ${p.days_left} day${p.days_left === 1 ? '' : 's'} left. ` +
              (state === 'unknown'
                ? 'Not enough history to say how that usually goes.'
                : pct === null
                  ? `Your usual spending on this card over the rest of the window comes to about $${money(expected ?? 0)}.`
                  : `On your usual spending on this card that is met about ${pct}% of the time.`);

      out.push({
        card: { id: card.id, nickname: card.nickname, product: card.product },
        requirement_id: req.id,
        label: req.kind === 'signup_min' ? 'sign-up minimum spend' : 'monthly minimum spend',
        window: p.window,
        days_left: p.days_left,
        required_cents: p.floor_cents,
        spent_cents: p.spent_cents,
        shortfall_cents: p.remaining_cents,
        expected_further_cents: expected,
        probability_of_meeting: probability,
        confidence,
        state,
        outlook,
        txns_remaining: p.txns_remaining ?? 0,
      });
    }
  }

  // At risk first: a minimum that is fine needs no attention, and one already
  // lost cannot use any.
  const rank = (m: MinSpendOutlook) =>
    ({ at_risk: 0, unlikely: 1, unknown: 2, on_track: 3, met: 4, lost: 5 })[m.state];
  return out.sort((a, b) => rank(a) - rank(b) || a.days_left - b.days_left);
}

export interface Plan {
  as_of: string;
  caps: CapOutlook[];
  minimums: MinSpendOutlook[];
  /** The handful of things worth reading first, already in priority order. */
  headlines: string[];
}

export async function spendPlan(env: Env): Promise<Plan> {
  const caps = await capOutlook(env);
  const minimums = await minimumSpendOutlook(env);

  const headlines: string[] = [];
  for (const m of minimums) {
    if (m.state === 'at_risk' || m.state === 'unlikely') headlines.push(`${m.card.nickname}: ${m.outlook}`);
  }
  for (const c of caps) {
    if (c.advice) headlines.push(c.advice);
  }

  return { as_of: today(env), caps, minimums, headlines: headlines.slice(0, 5) };
}
