import { calendarMonth, calendarQuarter, currentTierCents, money, statementCycle, today, EFFECTIVE_DATE } from './spend';
import { ruleSetOn, rulesIn } from './catalog/rulesets';
import type { Card, Env } from './types';

export type Channel = 'online' | 'offline' | 'contactless';
export type Objective = 'miles' | 'cashback' | 'balanced' | 'minspend';

export interface EarnRule {
  id: number;
  card_id: number;
  category: string;
  mpd: number;
  reward_type: 'miles' | 'cashback';
  cap_cents: number | null;
  cap_group: string | null;
  cap_window: string | null;
  mcc_include: string | null;
  mcc_exclude: string | null;
  channel: Channel | null;
  min_txn_cents: number | null;
  /**
   * The monthly spend rung at or above which this rate applies, for cards whose
   * rate changes with the tier. Null means it always applies.
   */
  min_tier_cents: number | null;
  /** The versioned set this rule belongs to; null on rules not yet migrated. */
  rule_set_id: number | null;
  /** Higher wins among rules that are otherwise equal. */
  priority: number;
  note: string | null;
}

/** One line of the explanation behind a number. */
export interface RuleStep {
  check: string;
  /** true passed, false failed, null informational. */
  pass: boolean | null;
  detail: string;
}

export interface MerchantGuess {
  query: string;
  merchant: string | null;
  mcc: string | null;
  description: string | null;
  category: string | null;
  channel: Channel | null;
  confidence: 'confirmed' | 'guess' | 'unknown';
  source: string | null;
  /** Other merchants that matched, when the lookup was not exact. */
  alternatives: { merchant: string; mcc: string; description: string | null }[];
}

const csv = (s: string | null) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);

/**
 * What code a merchant is likely to present. Likely is the operative word: the
 * MCC is set by the acquirer, differs between outlets of one brand and changes
 * without notice, so the answer always carries how much to trust it.
 */
export async function lookupMerchant(env: Env, query: string): Promise<MerchantGuess> {
  const q = query.trim().toLowerCase();
  const empty: MerchantGuess = {
    query,
    merchant: null,
    mcc: null,
    description: null,
    category: null,
    channel: null,
    confidence: 'unknown',
    source: null,
    alternatives: [],
  };
  if (!q) return empty;

  const sel = `SELECT m.merchant, m.mcc, m.channel, m.source, m.confidence, c.description, c.category
               FROM merchant_mcc m LEFT JOIN mcc_codes c ON c.code = m.mcc`;

  let row = await env.DB.prepare(`${sel} WHERE m.merchant = ?`).bind(q).first<any>();
  if (!row) {
    // Fall back to a contains match, longest name first so "grab" does not beat
    // a more specific entry.
    const { results } = await env.DB.prepare(
      `${sel} WHERE ? LIKE '%' || m.merchant || '%' OR m.merchant LIKE '%' || ? || '%'
       ORDER BY LENGTH(m.merchant) DESC LIMIT 5`
    )
      .bind(q, q)
      .all<any>();
    row = (results ?? [])[0];
    if (row) {
      return {
        query,
        merchant: row.merchant,
        mcc: row.mcc,
        description: row.description ?? null,
        category: row.category ?? null,
        channel: row.channel ?? null,
        confidence: row.confidence === 'confirmed' ? 'confirmed' : 'guess',
        source: row.source,
        alternatives: (results ?? []).slice(1).map((r: any) => ({
          merchant: r.merchant,
          mcc: r.mcc,
          description: r.description ?? null,
        })),
      };
    }
    return empty;
  }

  return {
    query,
    merchant: row.merchant,
    mcc: row.mcc,
    description: row.description ?? null,
    category: row.category ?? null,
    channel: row.channel ?? null,
    confidence: row.confidence === 'confirmed' ? 'confirmed' : 'guess',
    source: row.source,
    alternatives: [],
  };
}

/**
 * The rules in force for a card on a given day.
 *
 * Reward rules belong to a versioned set on the card's product, so which rules
 * apply is a question about a DATE: a purchase from August has to find the
 * rules that were in force in August, not the ones the bank published in
 * October. Cards not yet on the product model fall back to their own rules,
 * which is what every card looks like until the migration has run.
 */
export async function rulesForCard(
  env: Env,
  card: Card,
  on: string
): Promise<{ rules: EarnRule[]; rule_set_id: number | null }> {
  const productId = (card as unknown as { product_id?: number | null }).product_id ?? null;
  if (productId) {
    const set = await ruleSetOn(env, productId, on);
    if (set) return { rules: await rulesIn(env, set.id), rule_set_id: set.id };
    // A product with no version covering that day earns nothing extra — the
    // honest answer, rather than quietly reaching for a version that had not
    // started or had already ended.
    return { rules: [], rule_set_id: null };
  }

  const { results } = await env.DB.prepare(`SELECT * FROM earn_rules WHERE card_id = ? AND active = 1`)
    .bind(card.id)
    .all<EarnRule>();
  return { rules: results ?? [], rule_set_id: null };
}

export interface Purchase {
  amount_cents: number | null;
  mcc?: string | null;
  category?: string | null;
  channel?: Channel | null;
}

export interface Evaluation {
  card: Card;
  rule: EarnRule | null;
  excluded: boolean;
  exclusion_reason: string | null;
  reward_type: 'miles' | 'cashback';
  bonus_rate: number;
  base_rate: number;
  cap_cents: number | null;
  cap_used_cents: number;
  headroom_cents: number | null;
  bonus_portion_cents: number;
  base_portion_cents: number;
  miles: number;
  cashback_cents: number;
  value_cents: number;
  /** Blended across the cap, so it reflects this purchase rather than the headline. */
  effective_rate: number;
  min_spend_short_cents: number;
  min_spend_days_left: number | null;
  trace: RuleStep[];
  score: number;
  /** The versioned rule set these numbers came from, when there is one. */
  rule_set_id: number | null;
  /** The date the rules were judged on. */
  evaluated_on: string;
}

function windowFor(w: string | null, card: Card, env: Env) {
  if (w === 'calendar_month') return calendarMonth(env);
  if (w === 'calendar_quarter') return calendarQuarter(env);
  return statementCycle(card.statement_day, env);
}

/** Spend already counted against a rule's cap, including every rule sharing it. */
async function capSpend(env: Env, card: Card, rule: EarnRule, rules: EarnRule[]): Promise<number> {
  const win = windowFor(rule.cap_window, card, env);
  const group = rule.cap_group ? rules.filter((r) => r.cap_group === rule.cap_group) : [rule];
  const cats = group.map((r) => r.category);
  const ph = cats.map(() => '?').join(',');

  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM transactions
     WHERE card_id = ? AND ${EFFECTIVE_DATE} >= ? AND ${EFFECTIVE_DATE} <= ?
       AND amount_cents > 0 AND COALESCE(category, '*') IN (${ph})`
  )
    .bind(card.id, win.start, win.end, ...cats)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/** Does this rule apply to this purchase, and why or why not. */
/** Whether a rule covers a purchase, with the reasoning appended to `trace`.
 *  Exported so the MCC table shows the same answer the engine would give. */
export function ruleMatches(
  rule: EarnRule,
  p: Purchase,
  trace: RuleStep[] = [],
  tierCents: number | null = null
): boolean {
  // A rate that only exists above a spend rung cannot be claimed below it. The
  // rung is the one the quarter is actually holding, not the one it might
  // reach — spending into a capped quarter does not buy the higher rate.
  if (rule.min_tier_cents) {
    if (tierCents === null) {
      trace.push({
        check: 'Spend tier',
        pass: null,
        detail: `Rate needs the $${money(rule.min_tier_cents)} tier, and this card has no tiers recorded`,
      });
      return false;
    }
    if (tierCents < rule.min_tier_cents) {
      trace.push({
        check: 'Spend tier',
        pass: false,
        detail: `Rate needs the $${money(rule.min_tier_cents)} tier; this card is holding $${money(tierCents)}`,
      });
      return false;
    }
    trace.push({
      check: 'Spend tier',
      pass: true,
      detail: `Holding the $${money(tierCents)} tier, so the $${money(rule.min_tier_cents)} rate applies`,
    });
  }

  const inc = csv(rule.mcc_include);
  const exc = csv(rule.mcc_exclude);

  if (exc.length && p.mcc && exc.includes(p.mcc)) {
    trace.push({ check: 'Rule MCC exclusion', pass: false, detail: `MCC ${p.mcc} is excluded from this rule` });
    return false;
  }
  if (inc.length) {
    if (!p.mcc) {
      trace.push({ check: 'Rule MCC list', pass: null, detail: `Rule covers ${inc.join(', ')} — the merchant's code is unknown` });
      return false;
    }
    if (!inc.includes(p.mcc)) {
      trace.push({ check: 'Rule MCC list', pass: false, detail: `MCC ${p.mcc} is not in ${inc.join(', ')}` });
      return false;
    }
    trace.push({ check: 'Rule MCC list', pass: true, detail: `MCC ${p.mcc} is covered` });
  }
  if (rule.channel && p.channel && rule.channel !== p.channel) {
    trace.push({ check: 'Channel', pass: false, detail: `Rule needs ${rule.channel}, this is ${p.channel}` });
    return false;
  }
  if (rule.channel && p.channel === rule.channel) {
    trace.push({ check: 'Channel', pass: true, detail: `${p.channel} matches the rule` });
  }
  if (rule.min_txn_cents && p.amount_cents !== null && p.amount_cents < rule.min_txn_cents) {
    trace.push({
      check: 'Minimum transaction',
      pass: false,
      detail: `Rule needs $${money(rule.min_txn_cents)}, this is $${money(p.amount_cents)}`,
    });
    return false;
  }
  return true;
}

/**
 * What one card would earn on one purchase, with the reasoning attached. The
 * trace is the point: a number you cannot interrogate is a number you cannot
 * trust, and these rules are intricate enough that the answer alone is not
 * enough to act on.
 */
export async function evaluate(
  env: Env,
  card: Card,
  p: Purchase,
  opts: {
    rules?: EarnRule[];
    exclusions?: { card_id: number | null; mcc: string; reason: string | null }[];
    /** The spend rung this card is holding; looked up when not supplied. */
    tier_cents?: number | null;
    /** The date to judge the rules on. Defaults to today. */
    on?: string;
  } = {}
): Promise<Evaluation> {
  const trace: RuleStep[] = [];
  const mileValue = parseFloat(env.MILE_VALUE_CENTS || '1.5');

  // Which rules applied is a question about a date. `on` is the purchase's own
  // date when it has one, so a recalculation of an August transaction finds
  // August's rules rather than today's.
  const on = opts.on ?? today(env);
  let ruleSetId: number | null = null;
  let rules: EarnRule[];
  if (opts.rules) {
    rules = opts.rules;
  } else {
    const resolved = await rulesForCard(env, card, on);
    rules = resolved.rules;
    ruleSetId = resolved.rule_set_id;
  }
  // Rules resolved through a product are already this card's; the legacy path
  // returns only this card's too. The filter keeps a caller-supplied list from
  // leaking another card's rules in.
  const mine = rules.filter((r) => r.rule_set_id != null || r.card_id === card.id);

  const exclusions =
    opts.exclusions ??
    ((await env.DB.prepare(`SELECT card_id, mcc, reason FROM exclusions WHERE active = 1`).all<any>()).results ?? []);

  const amount = p.amount_cents ?? 0;
  const blank: Omit<Evaluation, 'trace' | 'score'> = {
    card,
    rule_set_id: ruleSetId,
    evaluated_on: on,
    rule: null,
    excluded: false,
    exclusion_reason: null,
    reward_type: 'miles',
    bonus_rate: 0,
    base_rate: 0,
    cap_cents: null,
    cap_used_cents: 0,
    headroom_cents: null,
    bonus_portion_cents: 0,
    base_portion_cents: 0,
    miles: 0,
    cashback_cents: 0,
    value_cents: 0,
    effective_rate: 0,
    min_spend_short_cents: 0,
    min_spend_days_left: null,
  };

  // 1. Exclusions first: an excluded code earns nothing whatever the rules say.
  const hit = p.mcc
    ? exclusions.find((e) => e.mcc === p.mcc && (e.card_id === null || e.card_id === card.id))
    : undefined;
  if (hit) {
    trace.push({
      check: 'Exclusions',
      pass: false,
      detail: `MCC ${p.mcc} earns nothing on this card — ${hit.reason ?? 'excluded'}`,
    });
    return { ...blank, excluded: true, exclusion_reason: hit.reason ?? 'excluded', trace, score: -1 };
  }
  if (p.mcc) trace.push({ check: 'Exclusions', pass: true, detail: `MCC ${p.mcc} is not excluded` });

  // 2. Which rule applies. Specific category first, then the fallback.
  //
  // Where several rules cover the same category — an MCC-restricted 4 mpd and a
  // looser 2 mpd, say — the best-paying one wins, not whichever was entered
  // first. Comparing on value rather than on the raw number is what keeps a
  // 5% cashback rule from losing to a 4 mpd one.
  const category = p.category ?? null;
  const fallback = mine.find((r) => r.category === '*') ?? null;
  const worth = (r: EarnRule) => (r.reward_type === 'cashback' ? r.mpd * 100 : r.mpd * mileValue);
  let matched: EarnRule | null = null;
  // A card whose rate depends on its tier has to be asked which one it is
  // holding before any of its rates can be judged.
  const tierCents =
    opts.tier_cents !== undefined
      ? opts.tier_cents
      : mine.some((r) => r.min_tier_cents)
        ? await currentTierCents(env, card)
        : null;

  for (const r of mine
    .filter((r) => r.category === category && r.category !== '*')
    .sort((a, b) => worth(b) - worth(a))) {
    if (ruleMatches(r, p, trace, tierCents)) {
      matched = r;
      break;
    }
  }
  const rule = matched ?? fallback;
  if (!rule) {
    trace.push({ check: 'Earn rule', pass: null, detail: 'No rule on this card covers the purchase' });
    return { ...blank, trace, score: -1 };
  }
  trace.push({
    check: 'Earn rule',
    pass: true,
    detail: matched
      ? `${category} at ${matched.reward_type === 'cashback' ? `${matched.mpd}% back` : `${matched.mpd} mpd`}`
      : `Falls back to the base rate, ${fallback!.reward_type === 'cashback' ? `${fallback!.mpd}%` : `${fallback!.mpd} mpd`}`,
  });

  const rewardType = rule.reward_type ?? 'miles';
  const baseRate = fallback?.mpd ?? card.base_mpd ?? 0;
  const bonusRate = rule.mpd;

  // 3. Cap: how much of this purchase actually gets the bonus rate.
  let headroom: number | null = null;
  let used = 0;
  if (rule.cap_cents) {
    used = await capSpend(env, card, rule, mine);
    headroom = Math.max(0, rule.cap_cents - used);
    trace.push({
      check: 'Bonus cap',
      pass: headroom > 0,
      detail:
        headroom > 0
          ? `$${money(headroom)} of the $${money(rule.cap_cents)} ${rule.cap_window ?? 'cycle'} cap still available`
          : `$${money(rule.cap_cents)} cap already used — this earns the base rate`,
    });
  } else {
    trace.push({ check: 'Bonus cap', pass: true, detail: 'No cap on this rule' });
  }

  const bonusPortion = headroom === null ? amount : Math.min(amount, headroom);
  const basePortion = amount - bonusPortion;
  const rateForBonus = matched && headroom !== 0 ? bonusRate : baseRate;

  let miles = 0;
  let cashback = 0;
  if (rewardType === 'cashback') {
    cashback = Math.round(bonusPortion * (rateForBonus / 100) + basePortion * (baseRate / 100));
  } else {
    miles = Math.round((bonusPortion / 100) * rateForBonus + (basePortion / 100) * baseRate);
  }
  const value = rewardType === 'cashback' ? cashback : miles * mileValue;

  if (basePortion > 0 && bonusPortion > 0) {
    trace.push({
      check: 'Split at the cap',
      pass: null,
      detail: `$${money(bonusPortion)} at the bonus rate, $${money(basePortion)} at the base rate`,
    });
  }

  // 4. An unmet minimum on this card, which can outweigh a better rate.
  let shortBy = 0;
  let daysLeft: number | null = null;
  const { results: reqs } = await env.DB.prepare(
    `SELECT * FROM requirements WHERE card_id = ? AND active = 1`
  )
    .bind(card.id)
    .all<any>();
  for (const req of reqs ?? []) {
    const win = windowFor(req.window, card, env);
    const spent = await env.DB.prepare(
      `SELECT COALESCE(SUM(amount_cents),0) AS n FROM transactions
       WHERE card_id = ? AND ${EFFECTIVE_DATE} >= ? AND ${EFFECTIVE_DATE} <= ? AND amount_cents > 0`
    )
      .bind(card.id, win.start, win.end)
      .first<{ n: number }>();
    const remaining = Math.max(0, req.amount_cents - (spent?.n ?? 0));
    if (remaining > shortBy) {
      shortBy = remaining;
      daysLeft = Math.round((Date.parse(win.end) - Date.parse(today(env))) / 86400_000);
    }
  }
  if (shortBy > 0) {
    trace.push({
      check: 'Minimum spend',
      pass: null,
      detail: `$${money(shortBy)} short of this card's minimum, ${daysLeft}d left`,
    });
  }

  const effective = amount > 0 ? (rewardType === 'cashback' ? (cashback / amount) * 100 : (miles / amount) * 100) : rateForBonus;

  return {
    ...blank,
    rule,
    reward_type: rewardType,
    bonus_rate: bonusRate,
    base_rate: baseRate,
    cap_cents: rule.cap_cents,
    cap_used_cents: used,
    headroom_cents: headroom,
    bonus_portion_cents: bonusPortion,
    base_portion_cents: basePortion,
    miles,
    cashback_cents: cashback,
    value_cents: Math.round(value),
    effective_rate: Math.round(effective * 100) / 100,
    min_spend_short_cents: shortBy,
    min_spend_days_left: daysLeft,
    trace,
    score: 0,
  };
}

export interface Recommendation {
  purchase: Purchase;
  merchant: MerchantGuess | null;
  objective: Objective;
  picks: Evaluation[];
  /** When the bonus runs out part-way, what to do with the rest. */
  split_advice: { bonus_cents: number; remainder_cents: number; use: string; earns: string } | null;
}

/**
 * Ranks the cards for one purchase. The objective matters: when a cashback
 * card's minimum is nearly due, taking it can beat a card that earns more per
 * dollar, and a miles-first user should not be handed a cashback card merely
 * because the mile valuation makes it look bigger.
 */
export async function recommend(
  env: Env,
  p: Purchase,
  opts: { merchantQuery?: string; objective?: Objective } = {}
): Promise<Recommendation> {
  const objective: Objective = opts.objective ?? ((env.OBJECTIVE as Objective) || 'balanced');

  let merchant: MerchantGuess | null = null;
  const purchase: Purchase = { ...p };
  if (opts.merchantQuery) {
    merchant = await lookupMerchant(env, opts.merchantQuery);
    if (!purchase.mcc && merchant.mcc) purchase.mcc = merchant.mcc;
    if (!purchase.category && merchant.category) purchase.category = merchant.category;
    if (!purchase.channel && merchant.channel) purchase.channel = merchant.channel;
  }
  // An MCC given without a category still implies one.
  if (purchase.mcc && !purchase.category) {
    const row = await env.DB.prepare(`SELECT category FROM mcc_codes WHERE code = ?`)
      .bind(purchase.mcc)
      .first<{ category: string }>();
    if (row) purchase.category = row.category;
  }

  const { results: cards } = await env.DB.prepare(`SELECT * FROM cards WHERE closed_at IS NULL ORDER BY id`).all<Card>();
  const { results: rules } = await env.DB.prepare(`SELECT * FROM earn_rules WHERE active = 1`).all<EarnRule>();
  const { results: exclusions } = await env.DB.prepare(
    `SELECT card_id, mcc, reason FROM exclusions WHERE active = 1`
  ).all<any>();

  const warnDays = parseInt(env.MIN_SPEND_WARN_DAYS || '7', 10);
  const picks: Evaluation[] = [];
  for (const card of cards ?? []) {
    const e = await evaluate(env, card, purchase, { rules: rules ?? [], exclusions: exclusions ?? [] });

    // Objective decides the ranking metric, not the size of the number.
    let score: number;
    if (e.excluded) score = -1;
    else if (objective === 'miles') score = e.reward_type === 'miles' ? e.miles * 1000 + e.value_cents : e.value_cents;
    else if (objective === 'cashback') score = e.reward_type === 'cashback' ? e.cashback_cents * 1000 + e.value_cents : e.value_cents;
    else score = e.value_cents || e.effective_rate * 100;

    // An urgent minimum is its own tier under every objective, and the whole
    // point of the minspend objective.
    if (e.min_spend_short_cents > 0) {
      const urgent = e.min_spend_days_left !== null && e.min_spend_days_left <= warnDays;
      if (objective === 'minspend') score += 10_000_000;
      else if (urgent) score += 1_000_000;
      else score += 100;
    }
    picks.push({ ...e, score });
  }

  picks.sort((a, b) => b.score - a.score);

  // If the best card's bonus runs out part-way, say what to do with the rest.
  let split: Recommendation['split_advice'] = null;
  const top = picks[0];
  if (top && !top.excluded && top.base_portion_cents > 0 && top.bonus_portion_cents > 0) {
    const rest: Purchase = { ...purchase, amount_cents: top.base_portion_cents };
    const others: Evaluation[] = [];
    for (const card of (cards ?? []).filter((c) => c.id !== top.card.id)) {
      others.push(await evaluate(env, card, rest, { rules: rules ?? [], exclusions: exclusions ?? [] }));
    }
    others.sort((a, b) => b.value_cents - a.value_cents);
    const alt = others[0];

    // What the top card gives on the remainder is its BASE rate — the bonus is
    // spent by then. Re-evaluating it fresh would see the cap unused again and
    // wrongly conclude that nothing beats it, which is the exact case this
    // advice exists for.
    const mileValue = parseFloat(env.MILE_VALUE_CENTS || '1.5');
    const topRemainderValue =
      top.reward_type === 'cashback'
        ? Math.round(top.base_portion_cents * (top.base_rate / 100))
        : Math.round((top.base_portion_cents / 100) * top.base_rate * mileValue);

    if (alt && !alt.excluded && alt.value_cents > topRemainderValue) {
      split = {
        bonus_cents: top.bonus_portion_cents,
        remainder_cents: top.base_portion_cents,
        use: alt.card.product,
        earns:
          alt.reward_type === 'cashback'
            ? `$${money(alt.cashback_cents)} back`
            : `${alt.miles.toLocaleString()} miles`,
      };
    }
  }

  return { purchase, merchant, objective, picks, split_advice: split };
}
