import { calendarMonth, calendarQuarter, claimAlert, localNow, money, statementCycle, today, EFFECTIVE_DATE } from './spend';
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
  verified_at: string | null;
  source_url: string | null;
  note: string | null;
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

export interface RateIssue {
  kind: 'bonus_ending' | 'never_verified' | 'stale' | 'points_expiring';
  text: string;
  /** 3 = act now, 2 = worth knowing, 1 = housekeeping. */
  urgency: number;
  /** Stable per-issue key, so a daily job can avoid repeating itself. */
  key: string;
}

/**
 * Weekly sweep over everything that silently goes out of date: promo bonuses
 * about to end, conversion terms never checked or checked long ago, and points
 * approaching expiry. Seeded rates are deliberately unverified, so this reports
 * them until you confirm each against your own bank.
 */
export async function rateIssues(env: Env): Promise<RateIssue[]> {
  const now = today(env);
  const plus = (days: number) =>
    new Date(Date.parse(now + 'T00:00:00Z') + days * 86400_000).toISOString().slice(0, 10);
  const staleDays = parseInt(env.RATE_RECHECK_DAYS || '90', 10);
  const issues: RateIssue[] = [];

  const { results: convs } = await env.DB.prepare(
    `SELECT c.*, pf.name AS from_name, pt.name AS to_name
     FROM conversions c
     JOIN programs pf ON pf.key = c.from_program
     JOIN programs pt ON pt.key = c.to_program
     WHERE c.active = 1`
  ).all<Conversion & { from_name: string; to_name: string }>();

  for (const c of convs ?? []) {
    const label = `${c.from_name} → ${c.to_name}${c.route ? ` (${c.route})` : ''}`;

    if (c.bonus_pct > 0 && c.bonus_until && c.bonus_until >= now && c.bonus_until <= plus(14)) {
      issues.push({
        kind: 'bonus_ending',
        urgency: 3,
        key: `bonus:${c.id}:${c.bonus_until}`,
        text: `🔥 ${label}: ${c.bonus_pct}% bonus ends ${c.bonus_until}`,
      });
    }
    if (!c.verified_at) {
      issues.push({
        kind: 'never_verified',
        urgency: 1,
        key: `unverified:${c.id}`,
        text: `❓ #${c.id} ${label} — never verified`,
      });
    } else if (c.verified_at < plus(-staleDays)) {
      issues.push({
        kind: 'stale',
        urgency: 1,
        key: `stale:${c.id}:${c.verified_at}`,
        text: `🕓 #${c.id} ${label} — last checked ${c.verified_at}`,
      });
    }
  }

  const { results: exp } = await env.DB.prepare(
    `SELECT t.points, t.expires_at, p.name, p.unit FROM balance_tranches t
     JOIN programs p ON p.key = t.program_key
     WHERE t.expires_at IS NOT NULL AND t.expires_at <= ? AND t.expires_at >= ?
     ORDER BY t.expires_at`
  )
    .bind(plus(90), now)
    .all<{ points: number; expires_at: string; name: string; unit: string; program_key: string }>();

  for (const t of exp ?? []) {
    const days = Math.round((Date.parse(t.expires_at) - Date.parse(now)) / 86400_000);
    issues.push({
      kind: 'points_expiring',
      urgency: days <= 30 ? 3 : 2,
      key: `expiry:${t.program_key}:${t.expires_at}`,
      text: `⏳ ${t.points.toLocaleString()} ${t.name} ${t.unit} expire ${t.expires_at} (${days}d)`,
    });
  }

  return issues.sort((a, b) => b.urgency - a.urgency);
}

/**
 * The rates report. Run daily, it must not repeat itself: housekeeping items —
 * routes never verified, routes gone stale — are the same every morning, and a
 * notification that says the same thing daily gets ignored, including on the
 * day it finally matters. In quiet mode those are held to once a week each
 * while anything urgent or genuinely new still goes out immediately, and the
 * whole report is suppressed when there is nothing to say.
 */
export async function ratesReview(
  env: Env,
  opts: { quiet?: boolean } = {}
): Promise<string | null> {
  const quiet = opts.quiet ?? false;
  const all = await rateIssues(env);

  let issues = all;
  if (quiet) {
    issues = [];
    for (const issue of all) {
      // Urgent items always go out; the rest at most once a week each.
      if (issue.urgency >= 2 || (await claimAlert(env, `rate:${issue.key}:${weekStamp(env)}`))) {
        issues.push(issue);
      }
    }
  }

  const { results: news } = await env.DB.prepare(
    `SELECT title, link FROM feed_items
     WHERE topic = 'rates' AND seen_at >= datetime('now', ?)
     ORDER BY seen_at DESC LIMIT 8`
  )
    .bind(quiet ? '-36 hours' : '-8 days')
    .all<{ title: string; link: string }>();

  if (quiet && !issues.length && !news?.length) return null;

  const lines: string[] = [quiet ? '*Rates check*' : '*Rates review*', ''];

  const group = (kind: string, heading: string) => {
    const rows = issues.filter((i) => i.kind === kind);
    if (!rows.length) return;
    lines.push(`*${heading}*`);
    for (const r of rows) lines.push(r.text);
    lines.push('');
  };

  group('bonus_ending', 'Ending soon');
  group('points_expiring', 'Points expiring');
  group('never_verified', 'Never verified');
  group('stale', 'Worth re-checking');

  if (news?.length) {
    lines.push('*In the feeds this week*');
    for (const n of news) lines.push(`• ${n.title}\n  ${n.link}`);
    lines.push('');
  }

  if (issues.length === 0 && !news?.length) {
    lines.push('Nothing to flag — every route verified recently, no expiries within 90 days.');
  } else {
    lines.push('_`/verified <id>` once you have checked a route against the bank._');
  }

  return lines.join('\n');
}

/** ISO-ish week stamp, used to hold repeat reminders to once a week. */
function weekStamp(env: Env): string {
  const d = localNow(env);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  const monday = new Date(d.getTime() - day * 86400_000);
  return monday.toISOString().slice(0, 10);
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
  /** Miles per dollar, or percent back when reward_type is 'cashback'. */
  mpd: number;
  reward_type: 'miles' | 'cashback';
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
  reward_type: 'miles' | 'cashback';
  /** Spend still available at the bonus rate, null when uncapped. */
  headroom_cents: number | null;
  cap_spent_cents: number;
  /** Miles this purchase earns, blended across the cap. Null for cashback. */
  miles: number | null;
  /** Cashback in cents. Null for miles cards. */
  cashback_cents: number | null;
  /**
   * What the reward is worth in cents, whatever form it takes. This is what
   * makes a cashback card and a miles card comparable, and what ranking uses.
   */
  value_cents: number;
  /** Value per dollar spent, for comparing when no amount was given. */
  value_per_dollar: number;
  reasons: string[];
  score: number;
}

/**
 * How a rate reads. Every display path must go through this — /earn previously
 * hardcoded "mpd" and so reported cashback rules as miles, which looked like a
 * storage bug but was only ever a formatting one.
 */
export function formatRate(rate: number, rewardType: 'miles' | 'cashback' | string | null): string {
  return rewardType === 'cashback' ? `${rate}% back` : `${rate} mpd`;
}

/** Learned merchant -> category mapping, so spend categorises itself. */
export async function categoryForMerchant(env: Env, merchant: string | null): Promise<string | null> {
  if (!merchant) return null;
  const row = await env.DB.prepare(`SELECT category FROM merchant_categories WHERE merchant = ?`)
    .bind(merchant.trim().toLowerCase())
    .first<{ category: string }>();
  return row?.category ?? null;
}

export async function rememberMerchant(env: Env, merchant: string | null, category: string | null): Promise<void> {
  if (!merchant || !category) return;
  await env.DB.prepare(
    `INSERT INTO merchant_categories (merchant, category) VALUES (?, ?)
     ON CONFLICT(merchant) DO UPDATE SET category = excluded.category,
       hits = hits + 1, updated_at = datetime('now')`
  )
    .bind(merchant.trim().toLowerCase(), category)
    .run();
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
    const rewardType: 'miles' | 'cashback' = rule?.reward_type ?? 'miles';
    const mileValue = parseFloat(env.MILE_VALUE_CENTS || '1.5');
    /** One dollar of spend, in cents of reward value, at a given rate. */
    const valueOf = (rate: number) => (rewardType === 'cashback' ? rate : rate * mileValue);

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
    let cashback: number | null = null;
    let valueCents = 0;
    const bonusRate = rule?.mpd ?? baseMpd;

    if (amountCents !== null) {
      const atBonus = headroom === null ? amountCents : Math.min(amountCents, headroom);
      const atBase = amountCents - atBonus;
      const dollarsBonus = atBonus / 100;
      const dollarsBase = atBase / 100;

      if (rewardType === 'cashback') {
        cashback = Math.round(atBonus * (bonusRate / 100) + atBase * (baseMpd / 100));
        valueCents = cashback;
      } else {
        miles = Math.round(dollarsBonus * bonusRate + dollarsBase * baseMpd);
        valueCents = miles * mileValue;
      }
      if (atBase > 0 && atBonus > 0) reasons.push(`$${money(atBase)} of this spills past the cap`);
    }

    const valuePerDollar = valueOf(effective);

    // Value per dollar, not the headline rate, is what ranks cards — it is the
    // only scale on which cashback and miles can be compared at all. A minimum that is genuinely about to
    // lapse is a different kind of consideration — missing it forfeits a whole
    // bonus, which dwarfs the per-dollar difference — so it ranks as its own
    // tier rather than as points added to a rate. A minimum with weeks left
    // gets only a tie-breaking nudge, never enough to beat a better rate.
    const warnDays = parseInt(env.MIN_SPEND_WARN_DAYS || '7', 10);
    let score = valuePerDollar * 1000;
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
      reward_type: rewardType,
      headroom_cents: headroom,
      cap_spent_cents: capSpent,
      miles,
      cashback_cents: cashback,
      value_cents: valueCents,
      value_per_dollar: valuePerDollar,
      reasons,
      score,
    });
  }

  return picks.sort((a, b) => b.score - a.score);
}
