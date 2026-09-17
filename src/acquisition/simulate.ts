import { isStale, listProducts, type CardProduct } from '../catalog/products';
import { ruleSetOn, rulesIn } from '../catalog/rulesets';
import { evaluate, type EarnRule } from '../rules';
import { money, today } from '../spend';
import type { Env } from '../types';
import { spendingProfile, DEFAULT_HISTORY_MONTHS } from './gaps';

/**
 * What a card would actually have added.
 *
 * The naive version of this assigns the candidate to every transaction and
 * reports the difference, which is how every comparison site arrives at numbers
 * nobody ever sees. A card only earns on a purchase if it beats what you would
 * otherwise have used — so each historical transaction is re-evaluated against
 * the wallet *including* the candidate, and only the purchases where it wins
 * count toward its value.
 *
 * That is what makes caps, channel restrictions, excluded codes and overlap
 * with cards you already hold fall out of the arithmetic rather than needing to
 * be argued about.
 */

export interface CategoryImpact {
  category: string;
  spend_cents: number;
  extra_value_cents: number;
  transactions: number;
}

export interface AcquisitionEvaluation {
  product: { id: number; product_key: string; issuer: string; product_name: string; annual_fee_cents: number | null };
  eligibility: 'eligible' | 'ineligible' | 'unknown';
  eligibility_note: string | null;
  projected_annual_incremental_value_cents: number;
  projected_extra_miles: number;
  annual_fee_cents: number;
  net_value_cents: number;
  affected_spend_cents: number;
  categories_improved: CategoryImpact[];
  /** 0 to 1: how much of its value duplicates a card already held. */
  overlap_score: number;
  /** Where it would not help, which is the half that prevents a bad purchase. */
  no_improvement: string[];
  /** A one-time bonus, always kept apart from the ongoing value. */
  welcome_offer: { title: string; reward: string; requires: string | null } | null;
  assumptions: string[];
  reasons: string[];
  confidence: 'high' | 'medium' | 'low';
}

/** Below three months of history the numbers are indicative at best. */
export const MIN_MONTHS_FOR_CONFIDENCE = 3;

interface Txn {
  id: number;
  card_id: number;
  amount_cents: number;
  occurred_at: string;
  posted_at: string | null;
  mcc: string | null;
  category: string | null;
  channel: string | null;
  expected_miles: number;
  expected_cashback_cents: number;
}

/** A card that does not exist yet, shaped like one the engine can evaluate. */
function candidateCard(p: CardProduct) {
  return {
    id: -p.id,
    issuer: p.issuer,
    product: p.product_name,
    product_key: p.product_key,
    nickname: `candidate_${p.id}`,
    credit_limit_cents: 0,
    statement_day: 1,
    opened_at: null,
    closed_at: null,
    base_mpd: p.base_mpd ?? 0,
    program_key: p.program_key,
    product_id: p.id,
  } as any;
}

/**
 * Simulate one product against real history.
 *
 * Each transaction is priced on the candidate and compared with what it
 * actually earned. Only the difference where the candidate wins is counted —
 * a card that ties with one you hold has added nothing, however good its
 * headline rate.
 */
export async function simulateProduct(
  env: Env,
  product: CardProduct,
  months = DEFAULT_HISTORY_MONTHS
): Promise<AcquisitionEvaluation> {
  const on = today(env);
  const mileValue = parseFloat(env.MILE_VALUE_CENTS || '1.5');
  const profile = await spendingProfile(env, months);

  const assumptions: string[] = [];
  const reasons: string[] = [];

  const set = await ruleSetOn(env, product.id, on);
  const rules: EarnRule[] = set ? await rulesIn(env, set.id) : [];

  if (!rules.length) {
    return {
      product: {
        id: product.id,
        product_key: product.product_key,
        issuer: product.issuer,
        product_name: product.product_name,
        annual_fee_cents: product.annual_fee_cents,
      },
      eligibility: 'unknown',
      eligibility_note: null,
      projected_annual_incremental_value_cents: 0,
      projected_extra_miles: 0,
      annual_fee_cents: product.annual_fee_cents ?? 0,
      net_value_cents: 0,
      affected_spend_cents: 0,
      categories_improved: [],
      overlap_score: 0,
      no_improvement: [],
      welcome_offer: null,
      assumptions: ['The app has no rates for this card, so nothing can be simulated.'],
      reasons: [],
      confidence: 'low',
    };
  }

  const card = candidateCard(product);
  const { results: txns } = await env.DB.prepare(
    `SELECT id, card_id, amount_cents, occurred_at, posted_at, mcc, category, channel,
            COALESCE(expected_miles, 0) AS expected_miles, COALESCE(expected_cashback_cents, 0) AS expected_cashback_cents
       FROM transactions
      WHERE amount_cents > 0 AND COALESCE(posted_at, occurred_at) BETWEEN ? AND ?
      ORDER BY COALESCE(posted_at, occurred_at), id`
  )
    .bind(profile.from, profile.to)
    .all<Txn>();

  const byCategory = new Map<string, CategoryImpact>();
  const noHelp = new Map<string, number>();
  let extraValue = 0;
  let extraMiles = 0;
  let affected = 0;
  let duplicatedValue = 0;
  let unknownCodes = 0;

  // Caps fill in ledger order, so the simulation walks the history forwards and
  // keeps its own tally: the candidate has no transactions of its own, so the
  // engine's cap lookup would find nothing and let it pay the bonus rate on
  // every purchase of the year.
  //
  // The tally is keyed by the WINDOW as well as the rule. A monthly cap that
  // never resets is exhausted by the first purchase and makes a capped card
  // look worthless, which is the same error in the opposite direction.
  const capUsed = new Map<string, number>();
  const windowKey = (window: string | null, date: string) => {
    if (window === 'calendar_quarter') {
      const m = Number(date.slice(5, 7));
      return `${date.slice(0, 4)}Q${Math.floor((m - 1) / 3) + 1}`;
    }
    // Month is the default: a statement cycle needs a statement day, and a
    // card nobody holds does not have one.
    return date.slice(0, 7);
  };

  for (const t of txns ?? []) {
    if (!t.mcc) unknownCodes++;
    const e = await evaluate(
      env,
      card,
      { amount_cents: t.amount_cents, mcc: t.mcc, category: t.category, channel: t.channel as any },
      { rules, on: t.posted_at ?? t.occurred_at }
    );

    // Apply the candidate's own caps against the simulated spend so far.
    let value = e.value_cents;
    let miles = e.miles;
    const rule = e.rule;
    if (rule?.cap_cents) {
      const key = `${rule.cap_group ?? rule.id}|${windowKey(rule.cap_window, t.posted_at ?? t.occurred_at)}`;
      const used = capUsed.get(key) ?? 0;
      const headroom = Math.max(0, rule.cap_cents - used);
      if (headroom < t.amount_cents) {
        const bonusPart = headroom;
        const basePart = t.amount_cents - headroom;
        const bonus = await evaluate(env, card, { amount_cents: bonusPart, mcc: t.mcc, category: t.category, channel: t.channel as any }, { rules, on: t.posted_at ?? t.occurred_at });
        const base = (basePart / 100) * (product.base_mpd ?? 0) * mileValue;
        value = bonusPart > 0 ? bonus.value_cents + base : base;
        miles = bonusPart > 0 ? bonus.miles + Math.round((basePart / 100) * (product.base_mpd ?? 0)) : Math.round((basePart / 100) * (product.base_mpd ?? 0));
      }
      capUsed.set(key, used + t.amount_cents);
    }

    const actual = t.expected_miles * mileValue + t.expected_cashback_cents;
    const gain = value - actual;
    const category = t.category ?? 'uncategorised';

    if (gain <= 0) {
      // It ties or loses here, which is exactly what overlap means.
      if (actual > 0 && value > 0) duplicatedValue += Math.min(actual, value);
      noHelp.set(category, (noHelp.get(category) ?? 0) + t.amount_cents);
      continue;
    }

    affected += t.amount_cents;
    extraValue += gain;
    extraMiles += Math.max(0, miles - t.expected_miles);

    const slice = byCategory.get(category) ?? { category, spend_cents: 0, extra_value_cents: 0, transactions: 0 };
    slice.spend_cents += t.amount_cents;
    slice.extra_value_cents += gain;
    slice.transactions++;
    byCategory.set(category, slice);
  }

  const scale = months > 0 ? 12 / months : 1;
  const annualValue = Math.round(extraValue * scale);
  const annualMiles = Math.round(extraMiles * scale);
  const fee = product.annual_fee_cents ?? 0;

  // Overlap is the share of this card's value that a card already held was
  // already producing. A card that adds a lot AND overlaps a lot is usually a
  // replacement rather than an addition, and worth saying so.
  const totalConsidered = extraValue + duplicatedValue;
  const overlap = totalConsidered > 0 ? duplicatedValue / totalConsidered : 0;

  if (profile.months_with_data < MIN_MONTHS_FOR_CONFIDENCE) {
    assumptions.push(`Based on ${profile.months_with_data} month(s) of transactions, which is not much to go on.`);
  }
  if (unknownCodes > 0) {
    assumptions.push(`${unknownCodes} purchases have no confirmed merchant code, so their bonus is a guess either way.`);
  }
  if (isStale(product, on)) {
    assumptions.push(`This card's rates have not been checked against a bank document.`);
  }
  assumptions.push('Assumes you would have used this card wherever it beat what you actually used.');

  const improved = [...byCategory.values()].sort((a, b) => b.extra_value_cents - a.extra_value_cents);
  for (const c of improved.slice(0, 3)) {
    reasons.push(`${c.category}: about $${money(Math.round(c.extra_value_cents * scale))} a year more`);
  }
  if (fee > 0 && annualValue < fee) {
    reasons.push(`The $${money(fee)} annual fee is more than the extra it would earn.`);
  }
  if (overlap > 0.5) {
    reasons.push(`It overlaps heavily with what you already hold.`);
  }

  let confidence: 'high' | 'medium' | 'low' = 'high';
  if (profile.months_with_data < MIN_MONTHS_FOR_CONFIDENCE) confidence = 'low';
  else if (profile.months_with_data < months || unknownCodes > (txns ?? []).length / 3 || isStale(product, on)) {
    confidence = 'medium';
  }

  return {
    product: {
      id: product.id,
      product_key: product.product_key,
      issuer: product.issuer,
      product_name: product.product_name,
      annual_fee_cents: product.annual_fee_cents,
    },
    eligibility: 'unknown',
    eligibility_note: null,
    projected_annual_incremental_value_cents: annualValue,
    projected_extra_miles: annualMiles,
    annual_fee_cents: fee,
    net_value_cents: annualValue - fee,
    affected_spend_cents: Math.round(affected * scale),
    categories_improved: improved,
    overlap_score: Math.round(overlap * 100) / 100,
    no_improvement: [...noHelp.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([c, cents]) => `${c}: $${money(Math.round(cents / months))} a month, already as well covered as this card would manage`),
    welcome_offer: null,
    assumptions,
    reasons,
    confidence,
  };
}

/** Products worth simulating: in the catalogue, with rules, and not already held. */
export async function candidates(env: Env): Promise<CardProduct[]> {
  const all = await listProducts(env, '');
  const out: CardProduct[] = [];
  for (const p of all) {
    const held = await env.DB.prepare(`SELECT id FROM cards WHERE product_id = ? AND closed_at IS NULL`)
      .bind(p.id)
      .first();
    if (held) continue;
    const set = await ruleSetOn(env, p.id, today(env));
    if (!set) continue;
    out.push(p);
  }
  return out;
}
