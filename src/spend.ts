import type { Card, Env, Requirement, RequirementTier } from './types';

export const money = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const parseMoney = (s: string): number | null => {
  const m = s.replace(/[$,]/g, '').match(/^-?\d+(\.\d{1,2})?$/);
  return m ? Math.round(parseFloat(m[0]) * 100) : null;
};

const tz = (env: Env) => parseInt(env.TZ_OFFSET_MINUTES || '0', 10);

/** Minutes east of UTC, for the few callers outside this module that need it. */
export const tzOffset = (env: Env) => tz(env);

/** "Now" shifted into the user's timezone, so day boundaries match their calendar. */
export function localNow(env: Env): Date {
  return new Date(Date.now() + tz(env) * 60_000);
}

export const isoDate = (d: Date) => d.toISOString().slice(0, 10);
export const today = (env: Env) => isoDate(localNow(env));

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86400_000);
}

export function addMonths(date: string, months: number): string {
  const d = new Date(date + 'T00:00:00Z');
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const day = Math.min(d.getUTCDate(), daysInMonth(y + Math.floor(m / 12), ((m % 12) + 12) % 12));
  return isoDate(new Date(Date.UTC(y, m, day)));
}

/**
 * The statement cycle containing `ref`, as an inclusive [start, end] date range.
 * A statement closing on day N means the cycle runs from N+1 of one month
 * through N of the next. Months shorter than N clamp to the last day.
 */
export function statementCycle(statementDay: number, env: Env): { start: string; end: string } {
  return cycleContaining(today(env), statementDay);
}

/**
 * The statement cycle that STARTS in a given month.
 *
 * `statementCycle` answers "which cycle is today in"; this answers "which cycle
 * is the one beginning in March", which is what a quarter anchored to a card's
 * issuance month is counted in. A cycle closing on day 18 and starting in
 * February runs 19 Feb to 18 Mar — so a cycle is named for the month it opens
 * in, not the month it closes in.
 */
export function cycleStartingIn(
  year: number,
  month: number,
  statementDay: number
): { start: string; end: string } {
  const norm = (y: number, m: number) => [y + Math.floor(m / 12), ((m % 12) + 12) % 12] as const;
  const [sy, sm] = norm(year, month);
  const [ey, em] = norm(year, month + 1);
  const close = (y: number, m: number) => new Date(Date.UTC(y, m, Math.min(statementDay, daysInMonth(y, m))));
  return {
    start: isoDate(new Date(close(sy, sm).getTime() + 86400_000)),
    end: isoDate(close(ey, em)),
  };
}

export interface StatementQuarter {
  start: string;
  end: string;
  /** 1 for the card's first quarter, counting from the anchor month. */
  index: number;
  /** The three statement months, in order. */
  months: { start: string; end: string }[];
  /**
   * The months this card's quarters begin in, e.g. "Mar, Jun, Sep, Dec".
   *
   * The anchor decides this, and being one month out moves every quarter for
   * the life of the card. Naming a cycle that straddles two months is
   * ambiguous — 31 Aug to 30 Sep is nobody's idea of "August" — but the month
   * a quarter BEGINS in is a date, so that is what this says.
   */
  pattern: string;
  /** The month the count starts from, e.g. "March 2025". */
  anchor_month: string;
}

/**
 * Three consecutive statement months, anchored to the month a card was issued.
 *
 * Cards like UOB One do not use calendar quarters. A card issued in February
 * runs Feb–Mar–Apr, then May–Jun–Jul, for as long as it is held, and each
 * "month" is a statement period rather than the 1st to the 31st. Getting this
 * wrong by a single cycle would report a minimum as met a month before it is.
 */
/**
 * The key of a statement cycle: months since year zero of the month whose close
 * OPENS it.
 *
 * Both halves of the quarter arithmetic have to agree on what names a cycle,
 * and "the month the cycle starts in" is not it. On a card closing on the 31st,
 * August closes on the 31st and the next cycle starts on 1 September — so that
 * cycle *starts* in September but is opened by August's close, which is the key
 * `cycleStartingIn` already uses. Keying one side by the start month and the
 * other by the close month put every quarter a month out on the 29th, 30th and
 * 31st, and only on those.
 */
function keyOfCycleOpenedBy(year: number, month: number): number {
  return year * 12 + month;
}

/** The statement cycle containing a given date. */
export function cycleContaining(date: string, statementDay: number): { start: string; end: string } {
  const [y, m, d] = date.split('-').map(Number);
  const clamp = (yy: number, mm: number) => Math.min(statementDay, daysInMonth(yy, mm));
  // The cycle ends at this month's close, unless the date is past it.
  let endY = y;
  let endM = m - 1;
  if (d > clamp(y, m - 1)) {
    endM += 1;
    if (endM > 11) {
      endM = 0;
      endY += 1;
    }
  }
  return cycleStartingIn(endY, endM - 1, statementDay);
}

/**
 * Three consecutive statement months, anchored to the month a card was issued.
 *
 * Cards like UOB One do not use calendar quarters. A card issued in February
 * runs Feb–Mar–Apr, then May–Jun–Jul, for as long as it is held, and each
 * "month" is a statement period rather than the 1st to the 31st.
 *
 * Month one is the first cycle that STARTS on or after the anchor date, which
 * is the only reading that holds for every statement day. A card issued on 10
 * February with an 18th close begins on 19 February — the part-month before
 * that was never a whole statement month. A card closing on the 31st and
 * anchored to 1 March begins on 1 March, because that is when its March
 * statement opens.
 */
export function statementQuarter(anchorDate: string, statementDay: number, env: Env): StatementQuarter {
  const anchorCycle = cycleContaining(anchorDate, statementDay);
  // `cycleContaining` gives the cycle the anchor sits INSIDE; month one is the
  // first that starts on or after it, which is the same cycle only when the
  // anchor lands exactly on a cycle's first day.
  const first = anchorCycle.start >= anchorDate ? anchorCycle : cycleAfter(anchorCycle, statementDay);

  const keyOf = (cycle: { start: string }) => {
    // The month whose close opened this cycle is the month of the day before it.
    const before = new Date(Date.parse(`${cycle.start}T00:00:00Z`) - 86400_000);
    return keyOfCycleOpenedBy(before.getUTCFullYear(), before.getUTCMonth());
  };

  const anchorKey = keyOf(first);
  const hereKey = keyOf(cycleContaining(today(env), statementDay));

  const q = Math.floor(Math.max(0, hereKey - anchorKey) / 3);
  const firstKey = anchorKey + q * 3;

  const months = [0, 1, 2].map((i) =>
    cycleStartingIn(Math.floor((firstKey + i) / 12), (firstKey + i) % 12, statementDay)
  );

  // Which months this card's quarters begin in. Four of them, in calendar
  // order, so it reads the same whenever you look at it.
  const NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const startsIn = (key: number) => {
    const c = cycleStartingIn(Math.floor(key / 12), key % 12, statementDay);
    return new Date(`${c.start}T00:00:00Z`).getUTCMonth();
  };
  const pattern = [0, 1, 2, 3]
    .map((n) => startsIn(anchorKey + n * 3))
    .sort((a, b) => a - b)
    .map((m) => NAMES[m])
    .join(', ');

  const anchorFirst = new Date(`${first.start}T00:00:00Z`);
  const anchorMonth = `${NAMES[anchorFirst.getUTCMonth()]} ${anchorFirst.getUTCFullYear()}`;

  return { start: months[0].start, end: months[2].end, index: q + 1, months, pattern, anchor_month: anchorMonth };
}

/** The cycle immediately after a given one. */
function cycleAfter(cycle: { end: string }, statementDay: number): { start: string; end: string } {
  const end = new Date(`${cycle.end}T00:00:00Z`);
  return cycleStartingIn(end.getUTCFullYear(), end.getUTCMonth(), statementDay);
}

export function calendarQuarter(env: Env): { start: string; end: string } {
  const l = localNow(env);
  const y = l.getUTCFullYear();
  const q = Math.floor(l.getUTCMonth() / 3);
  const startM = q * 3;
  const endM = startM + 2;
  return {
    start: isoDate(new Date(Date.UTC(y, startM, 1))),
    end: isoDate(new Date(Date.UTC(y, endM, daysInMonth(y, endM)))),
  };
}

export function calendarMonth(env: Env): { start: string; end: string } {
  const l = localNow(env);
  const y = l.getUTCFullYear();
  const m = l.getUTCMonth();
  return { start: isoDate(new Date(Date.UTC(y, m, 1))), end: isoDate(new Date(Date.UTC(y, m, daysInMonth(y, m)))) };
}

/**
 * Reads a date written the way someone actually types one into a chat:
 * `2026-09-05`, `5/9` (day/month), `yesterday`, or `-3` for three days ago.
 * Returns null for anything that isn't a date, so callers can treat the token
 * as part of the note instead.
 */
export function parseDateToken(token: string, env: Env): string | null {
  const t = token.trim().toLowerCase();
  const now = localNow(env);

  if (t === 'today') return isoDate(now);
  if (t === 'yesterday') return isoDate(new Date(now.getTime() - 86400_000));

  const rel = t.match(/^-(\d{1,3})$/);
  if (rel) return isoDate(new Date(now.getTime() - parseInt(rel[1], 10) * 86400_000));

  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    const d = new Date(t + 'T00:00:00Z');
    return Number.isNaN(d.getTime()) || isoDate(d) !== t ? null : t;
  }

  const dm = t.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (dm) {
    const day = parseInt(dm[1], 10);
    const mon = parseInt(dm[2], 10);
    if (day < 1 || day > 31 || mon < 1 || mon > 12) return null;
    const build = (y: number) => new Date(Date.UTC(y, mon - 1, day));
    let d = build(now.getUTCFullYear());
    if (d.getUTCDate() !== day) return null; // 31/2 and friends
    // A day/month more than a week ahead means last year — logging December
    // spend in January is far likelier than logging spend that hasn't happened.
    if (isoDate(d) > isoDate(new Date(now.getTime() + 7 * 86400_000))) d = build(now.getUTCFullYear() - 1);
    return isoDate(d);
  }

  return null;
}

/**
 * The date a window is judged on. Banks assess statement cycles, minimum spend
 * and bonus caps on when a transaction POSTED, so posted_at wins whenever it is
 * known; until then occurred_at is the best estimate available.
 */
export const EFFECTIVE_DATE = `COALESCE(posted_at, occurred_at)`;

export interface Spend {
  /** Everything whose effective date falls in the window. */
  total_cents: number;
  /**
   * The part of `total_cents` that could still move out of this window: made
   * close enough to the end that it may post after it, with no confirmed
   * posting date yet.
   */
  at_risk_cents: number;
  at_risk_count: number;
  /** Spend on a code the card excludes. Part of `total_cents` — it still uses
   *  the limit — but reported so a minimum can leave it out. */
  excluded_cents: number;
  excluded_count: number;
}

export async function spendIn(
  env: Env,
  cardId: number,
  start: string,
  end: string
): Promise<Spend> {
  const lag = parseInt(env.POSTING_LAG_DAYS || '0', 10);
  // Spend on or after this date, not yet confirmed posted, may slip.
  const riskFrom = isoDate(new Date(Date.parse(end + 'T00:00:00Z') - lag * 86400_000));

  // Spend on an excluded merchant code is counted here — it still uses the
  // credit limit — but reported separately, because most issuers do not let it
  // count toward a minimum.
  const row = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(t.amount_cents), 0) AS total,
       COALESCE(SUM(CASE WHEN t.posted_at IS NULL AND t.occurred_at >= ? THEN t.amount_cents ELSE 0 END), 0) AS at_risk,
       COALESCE(SUM(CASE WHEN t.posted_at IS NULL AND t.occurred_at >= ? THEN 1 ELSE 0 END), 0) AS at_risk_n,
       COALESCE(SUM(CASE WHEN x.mcc IS NOT NULL THEN t.amount_cents ELSE 0 END), 0) AS excluded,
       COALESCE(SUM(CASE WHEN x.mcc IS NOT NULL THEN 1 ELSE 0 END), 0) AS excluded_n
     FROM transactions t
     LEFT JOIN exclusions x
       ON x.mcc = t.mcc AND x.active = 1 AND (x.card_id IS NULL OR x.card_id = t.card_id)
     WHERE t.card_id = ? AND ${EFFECTIVE_DATE} >= ? AND ${EFFECTIVE_DATE} <= ?`
  )
    .bind(riskFrom, riskFrom, cardId, start, end)
    .first<{ total: number; at_risk: number; at_risk_n: number; excluded: number; excluded_n: number }>();

  return {
    total_cents: row?.total ?? 0,
    at_risk_cents: lag > 0 ? (row?.at_risk ?? 0) : 0,
    at_risk_count: lag > 0 ? (row?.at_risk_n ?? 0) : 0,
    excluded_cents: row?.excluded ?? 0,
    excluded_count: row?.excluded_n ?? 0,
  };
}

export async function spentBetween(env: Env, cardId: number, start: string, end: string): Promise<number> {
  return (await spendIn(env, cardId, start, end)).total_cents;
}

export async function countBetween(env: Env, cardId: number, start: string, end: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM transactions
     WHERE card_id = ? AND ${EFFECTIVE_DATE} >= ? AND ${EFFECTIVE_DATE} <= ? AND amount_cents > 0`
  )
    .bind(cardId, start, end)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export interface Utilization {
  card: Card;
  cycle: { start: string; end: string };
  balance_cents: number;
  at_risk_cents: number;
  limit_cents: number;
  percent: number;
  days_left: number;
}

export async function utilization(env: Env, card: Card): Promise<Utilization> {
  const cycle = statementCycle(card.statement_day, env);
  const spend = await spendIn(env, card.id, cycle.start, cycle.end);
  const balance = spend.total_cents;
  return {
    card,
    cycle,
    balance_cents: balance,
    at_risk_cents: spend.at_risk_cents,
    limit_cents: card.credit_limit_cents,
    percent: card.credit_limit_cents > 0 ? (balance / card.credit_limit_cents) * 100 : 0,
    days_left: daysBetween(today(env), cycle.end),
  };
}

/** One statement month inside a quarter, and what it did. */
export interface MonthSlice {
  /** 1, 2 or 3 within the quarter. */
  index: number;
  window: { start: string; end: string };
  spent_cents: number;
  confirmed_cents: number;
  at_risk_cents: number;
  txn_count: number;
  /** Both halves of the gate: the amount and the transaction count. */
  qualified: boolean;
  /** Highest tier this month's spend reached, or null for none. */
  tier_index: number | null;
  /** Where today is relative to this month. */
  state: 'past' | 'current' | 'future';
}

export interface Progress {
  requirement: Requirement;
  card: Card;
  window: { start: string; end: string };
  spent_cents: number;
  /** spent_cents minus anything that may still post into the next window. */
  confirmed_cents: number;
  at_risk_cents: number;
  at_risk_count: number;
  /** Spend on an excluded code, left out of the total above. */
  excluded_cents: number;
  excluded_count: number;
  /** True when the minimum is only met by counting spend that may yet slip. */
  met_only_with_at_risk: boolean;
  remaining_cents: number;
  days_left: number;
  per_day_cents: number;
  /** True only when BOTH the amount and the transaction count are satisfied. */
  met: boolean;
  txn_count: number;
  txns_required: number;
  txns_remaining: number;
  /** Set when the elevated earn rate has been exhausted — stop using this card. */
  cap_reached: boolean;
  over_cap_cents: number;

  // --- tiered, per-statement-month windows (UOB One and its like) ----------
  /** The quarter the current statement month sits in, when there is one. */
  quarter: StatementQuarter | null;
  /** Every statement month in that quarter, so a missed one is visible. */
  months: MonthSlice[];
  tiers: RequirementTier[];
  /**
   * The minimum that actually has to be hit this window.
   *
   * With tiers, that is the LOWEST rung — clear it and the quarter pays
   * something, miss it and it pays nothing. The amount stored on the
   * requirement is ignored when a ladder exists, because a card with rungs at
   * $600/$1,000/$2,000 has a minimum of $600 whatever number was typed in when
   * the requirement was created.
   */
  floor_cents: number;
  /** The tier THIS window's spend has reached — what you are on right now. */
  tier: RequirementTier | null;
  /**
   * The best tier the quarter can still pay, given the months already closed.
   *
   * The quarter pays at its weakest month, so a month that closed at $700 caps
   * the whole quarter at the $600 rung however much is spent afterwards. Null
   * while nothing is decided, when every rung is still reachable.
   */
  ceiling_tier: RequirementTier | null;
  /** Which month set that ceiling, and at what, in a few words. */
  ceiling_reason: string | null;
  /** What to spend this window to hold the best tier still available. */
  target_cents: number | null;
  /** Still to spend to reach that target. */
  to_target_cents: number;
  /**
   * Spend past the target that buys no more cashback this quarter. Not wasted
   * money — it still earns the base rate — but it earns nothing *extra*, which
   * is the moment to put the next purchase on another card.
   */
  beyond_target_cents: number;
  /**
   * What the quarter pays if it ends the way it stands: the LOWEST tier across
   * the months that have qualified, because the reward is for sustaining the
   * spend and one large month does not carry two thin ones. Null once a decided
   * month has failed, since then there is nothing to pay.
   */
  quarter_tier: RequirementTier | null;
  /** Thirds earned, when the first quarter pro-rates. 3 means the whole thing. */
  thirds: number | null;
  projected_reward_cents: number;
  /** Months already closed that failed — those cannot be recovered. */
  months_missed: number;
  /**
   * Set when the window looks like the wrong one for this card, in words that
   * say what to change. A minimum measured across a whole quarter adds three
   * months together and reads as a total four times what you spent — the
   * commonest way for this app to look broken while doing exactly as told.
   */
  shape_warning: string | null;
}

export async function requirementTiers(env: Env, requirementId: number): Promise<RequirementTier[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM requirement_tiers WHERE requirement_id = ? ORDER BY min_spend_cents`
  )
    .bind(requirementId)
    .all<RequirementTier>();
  return results ?? [];
}

/**
 * How much of a window's spend the issuer will actually count.
 *
 * Most issuers leave the same codes out of a minimum that they leave out of
 * earning — tax, insurance, top-ups. Counting them would call a minimum met
 * when the bank does not, and that costs the whole bonus; not counting them
 * only means spending a little more than strictly necessary. The safer error is
 * the default, and the amount left out is always reported.
 */
async function countedSpend(env: Env, cardId: number, start: string, end: string) {
  const spend = await spendIn(env, cardId, start, end);
  const countsExcluded = (env.MIN_SPEND_COUNTS_EXCLUDED ?? '').toLowerCase() === 'true';
  const excluded = countsExcluded ? 0 : spend.excluded_cents;
  return {
    spend,
    excluded,
    excluded_count: countsExcluded ? 0 : spend.excluded_count,
    spent: spend.total_cents - excluded,
  };
}

/** The highest tier a given spend reaches, or null when it clears none. */
function tierFor(tiers: RequirementTier[], spent: number): number | null {
  let hit: number | null = null;
  for (let i = 0; i < tiers.length; i++) if (spent >= tiers[i].min_spend_cents) hit = i;
  return hit;
}

export async function requirementProgress(env: Env, card: Card, req: Requirement): Promise<Progress> {
  const now = today(env);
  const tiers = await requirementTiers(env, req.id);

  // A quarter of three statement months, anchored to the month the card was
  // issued. The minimum itself is still a MONTHLY one — that is what you act on
  // today — so the window stays the current statement month and the quarter is
  // reported around it.
  const quarter =
    req.window === 'statement_quarter'
      ? statementQuarter(req.anchor_at ?? req.starts_at ?? card.opened_at ?? now, card.statement_day, env)
      : null;

  let window: { start: string; end: string };
  if (quarter && req.per_month) window = quarter.months.find((m) => m.end >= now) ?? quarter.months[2];
  else if (quarter) window = quarter;
  else if (req.window === 'calendar_month') window = calendarMonth(env);
  else if (req.window === 'calendar_quarter') window = calendarQuarter(env);
  else if (req.window === 'statement_cycle') window = statementCycle(card.statement_day, env);
  else window = { start: req.starts_at ?? card.opened_at ?? now, end: req.deadline ?? now };

  // With a ladder, the lowest rung IS the minimum. Any other figure stored on
  // the requirement predates the tiers, and believing it reports a perfectly
  // good month as a miss: a card with rungs at $600/$1,000/$2,000 has a
  // minimum of $600 whatever number was typed in when it was created.
  const floor = tiers.length ? tiers[0].min_spend_cents : req.amount_cents;

  const { spend, excluded, excluded_count, spent } = await countedSpend(env, card.id, window.start, window.end);
  const confirmed = spent - spend.at_risk_cents;
  const remaining = Math.max(0, floor - spent);
  const daysLeft = Math.max(0, daysBetween(now, window.end));
  const cap = req.bonus_cap_cents ?? 0;

  // Cards like UOB One gate the reward on a transaction count as well as a
  // dollar amount, so a requirement is only met when both are satisfied.
  const txnsRequired = req.min_txns ?? 0;
  const txnCount = txnsRequired > 0 ? await countBetween(env, card.id, window.start, window.end) : 0;
  const txnsRemaining = Math.max(0, txnsRequired - txnCount);

  // Every month of the quarter, so a month already missed is visible rather
  // than discovered when the cashback does not arrive.
  const months: MonthSlice[] = [];
  if (quarter && req.per_month) {
    for (const [i, m] of quarter.months.entries()) {
      const c = await countedSpend(env, card.id, m.start, m.end);
      const txns = await countBetween(env, card.id, m.start, m.end);
      months.push({
        index: i + 1,
        window: m,
        spent_cents: c.spent,
        confirmed_cents: c.spent - c.spend.at_risk_cents,
        at_risk_cents: c.spend.at_risk_cents,
        txn_count: txns,
        qualified: c.spent >= floor && txns >= txnsRequired,
        tier_index: tierFor(tiers, c.spent),
        state: m.end < now ? 'past' : m.start > now ? 'future' : 'current',
      });
    }
  }

  // What the quarter is on course to pay.
  //
  // `tier` is where this month stands. `quarter_tier` is the lowest tier across
  // the months that have qualified so far — sustained spend, not a best month —
  // and it goes to null the moment a closed month failed, because then there is
  // nothing left to pay.
  const tier = tiers.length ? (tierFor(tiers, spent) !== null ? tiers[tierFor(tiers, spent)!] : null) : null;

  // The quarter pays at its weakest month, so a month that closed one rung down
  // caps every month after it. Spending past that rung this month buys nothing
  // more THIS quarter — which is the difference between a useful target and a
  // number that just says "spend more".
  let ceilingTier: RequirementTier | null = null;
  let ceilingReason: string | null = null;
  if (tiers.length) {
    let lowest: number | null = null;
    let by: MonthSlice | null = null;
    for (const m of months) {
      if (m.state !== 'past' || !m.qualified || m.tier_index === null) continue;
      if (lowest === null || m.tier_index < lowest) {
        lowest = m.tier_index;
        by = m;
      }
    }
    if (lowest !== null && by) {
      ceilingTier = tiers[lowest];
      ceilingReason = `month ${by.index} closed at $${money(by.spent_cents)}`;
    }
  }

  // Aim at the ceiling when there is one. Without one — the first month of a
  // quarter — nothing is decided yet and every rung is still reachable, so the
  // app declines to invent an aspiration and shows the ladder instead.
  const targetCents = ceilingTier ? ceilingTier.min_spend_cents : null;
  const toTarget = targetCents === null ? 0 : Math.max(0, targetCents - spent);
  const beyondTarget = targetCents === null ? 0 : Math.max(0, spent - targetCents);
  let thirds: number | null = null;
  let quarterTier: RequirementTier | null = null;
  let projected = 0;

  if (months.length) {
    const decided = months.filter((m) => m.state !== 'future');
    const failed = decided.filter((m) => !m.qualified && m.state === 'past');

    // Pro-ration applies to the first quarter only, and to a trailing run:
    // qualify in the 3rd month alone and a third is paid, in the 2nd and 3rd and
    // two thirds. Every later quarter is all three months or nothing.
    //
    // The run is measured over the months that have HAPPENED. The months still
    // ahead are assumed to continue it, which is what makes this a projection
    // rather than a result, and it is labelled as one wherever it is shown.
    const prorating = quarter!.index === 1 && !!req.prorate_first;
    const ahead = months.filter((m) => m.state === 'future').length;
    let run = 0;
    for (let i = decided.length - 1; i >= 0; i--) {
      if (decided[i].qualified) run++;
      else break;
    }

    // Under pro-ration only the trailing run is paid for, so only those months
    // set the tier: a good month before a missed one buys nothing.
    const counted = prorating ? decided.slice(decided.length - run) : decided;
    const qualified = counted.filter((m) => m.qualified);
    if (qualified.length && (prorating || !failed.length)) {
      let lowest: number | null = null;
      for (const m of qualified) {
        if (m.tier_index === null) {
          lowest = null;
          break;
        }
        lowest = lowest === null ? m.tier_index : Math.min(lowest, m.tier_index);
      }
      quarterTier = lowest === null ? null : tiers[lowest];
    }

    thirds = prorating
      ? Math.min(3, run + ahead)
      : failed.length
        ? 0
        : decided.length > 0 && decided.every((m) => m.qualified)
          ? 3
          : null;
    if (quarterTier && thirds) projected = Math.round((quarterTier.reward_cents * thirds) / 3);
  }

  return {
    requirement: req,
    card,
    window,
    spent_cents: spent,
    confirmed_cents: confirmed,
    at_risk_cents: spend.at_risk_cents,
    at_risk_count: spend.at_risk_count,
    excluded_cents: excluded,
    excluded_count,
    met_only_with_at_risk: remaining === 0 && confirmed < floor,
    remaining_cents: remaining,
    days_left: daysLeft,
    per_day_cents: daysLeft > 0 ? Math.ceil(remaining / daysLeft) : remaining,
    met: remaining === 0 && txnsRemaining === 0,
    txn_count: txnCount,
    txns_required: txnsRequired,
    txns_remaining: txnsRemaining,
    cap_reached: cap > 0 && spent >= cap,
    over_cap_cents: cap > 0 ? Math.max(0, spent - cap) : 0,
    quarter,
    months,
    tiers,
    floor_cents: floor,
    tier,
    ceiling_tier: ceilingTier,
    ceiling_reason: ceilingReason,
    target_cents: targetCents,
    to_target_cents: toTarget,
    beyond_target_cents: beyondTarget,
    quarter_tier: quarterTier,
    thirds,
    projected_reward_cents: projected,
    months_missed: months.filter((m) => m.state === 'past' && !m.qualified).length,
    shape_warning: shapeWarning(req, tiers),
  };
}

/**
 * Whether this requirement's window is probably not the one meant.
 *
 * Only two cases are flagged, both unambiguous, because a warning that fires on
 * a correct setup is worse than none: a quarter measured as one lump, and a
 * transaction count measured over a window longer than a month. Neither is how
 * an issuer that pays quarterly actually counts.
 */
function shapeWarning(req: Requirement, tiers: RequirementTier[]): string | null {
  if (req.window === 'calendar_quarter' && !req.per_month) {
    return (
      'This adds three calendar months into one total, so it reads far higher than a month\u2019s spend. ' +
      'A card that pays quarterly almost always wants the minimum in EACH month \u2014 change the window to ' +
      '\u201cevery statement month of a rolling quarter\u201d' +
      (tiers.length ? '.' : ', and add its spend tiers.')
    );
  }
  if (req.window === 'statement_quarter' && !req.per_month) {
    return (
      'This is set to one total across the whole quarter rather than a minimum in each of its three statement ' +
      'months, which is how these cards are actually counted.'
    );
  }
  return null;
}

/**
 * A card ranked by what you can still do something about.
 *
 * The credit limit is what a credit score reads, but it is not what decides
 * where the next purchase should go. A minimum you are short of is: miss it and
 * the whole month's bonus is gone, and the only way to fix that is to spend on
 * that card before the window closes. So the headline is the minimum, and
 * utilization rides along underneath it.
 */
export interface Standing {
  card: Card;
  utilization: Utilization;
  requirements: Progress[];
  /** The requirement to act on now, or null when the card has none. */
  headline: Progress | null;
  /** Progress toward the headline minimum, 0-100. Utilization when there is none. */
  percent: number;
  /** Lower sorts first: the card most at risk of losing a bonus. */
  rank: number;
  /**
   * True when the window's reward is already gone — a quarter with a statement
   * month closed short. Nothing you spend now can bring it back, so the card
   * stops being urgent even though its minimum is unmet.
   */
  lost: boolean;
}

/**
 * Which minimum matters right now: the one that can still be missed, soonest.
 * A met minimum needs no action, and among unmet ones the deadline decides —
 * $900 due in twenty days is a smaller problem than $200 due tomorrow.
 */
function headlineOf(progress: Progress[]): Progress | null {
  if (!progress.length) return null;
  const open = progress.filter((p) => !p.met);
  if (!open.length) return progress.slice().sort((a, b) => a.days_left - b.days_left)[0];
  return open.slice().sort((a, b) => a.days_left - b.days_left || b.remaining_cents - a.remaining_cents)[0];
}

export async function standings(env: Env): Promise<Standing[]> {
  const out: Standing[] = [];
  for (const card of await activeCards(env)) {
    const utilization_ = await utilization(env, card);
    const requirements: Progress[] = [];
    for (const req of await requirementsFor(env, card.id)) {
      requirements.push(await requirementProgress(env, card, req));
    }
    const headline = headlineOf(requirements);
    const percent = headline
      ? headline.floor_cents > 0
        ? Math.min(100, (headline.spent_cents / headline.floor_cents) * 100)
        : 100
      : utilization_.percent;

    // A quarter with a month already closed short pays nothing whatever you do
    // now, so it is not urgent — putting it above a minimum you can still hit
    // would send spend to the one card where it cannot help.
    const lost = !!headline && headline.months.length > 0 && headline.months_missed > 0 && !headline.thirds;

    // Sort key, most urgent first: unmet minimums by days left, then met ones,
    // then lost windows, then cards with nothing to hit. Days left is scaled so
    // it never collides with the band above it.
    const rank = !headline
      ? 900_000
      : lost
        ? 700_000 + headline.days_left
        : headline.met
          ? 500_000 + headline.days_left
          : headline.days_left * 1000 + Math.round(100 - percent);

    out.push({ card, utilization: utilization_, requirements, headline, percent, rank, lost });
  }
  return out.sort((a, b) => a.rank - b.rank);
}

/**
 * Which spend tier this card is actually holding, in cents of monthly spend.
 *
 * Cards like UOB One do not have one rate per category — they have one per
 * category *per tier*, and which tier you are on is decided by the quarter's
 * weakest month. So a rate that only applies above a rung needs to know the
 * rung the card is really on, not the one it might reach.
 *
 * Returns null when the card has no ladder, which is most cards.
 */
export async function currentTierCents(env: Env, card: Card): Promise<number | null> {
  for (const req of await requirementsFor(env, card.id)) {
    const tiers = await requirementTiers(env, req.id);
    if (!tiers.length) continue;
    const p = await requirementProgress(env, card, req);
    // What the quarter will pay is the honest answer: a big month inside a
    // quarter capped one rung down does not earn at the higher rate.
    const held = p.quarter_tier ?? p.ceiling_tier ?? p.tier;
    return held ? held.min_spend_cents : 0;
  }
  return null;
}

export async function activeCards(env: Env): Promise<Card[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM cards WHERE closed_at IS NULL ORDER BY issuer, product`
  ).all<Card>();
  return results ?? [];
}

export async function requirementsFor(env: Env, cardId: number): Promise<Requirement[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM requirements WHERE card_id = ? AND active = 1`
  )
    .bind(cardId)
    .all<Requirement>();
  return results ?? [];
}

/** Fires an alert at most once per key; returns false if already sent. */
export async function claimAlert(env: Env, key: string): Promise<boolean> {
  const r = await env.DB.prepare(`INSERT OR IGNORE INTO alerts_sent (key) VALUES (?)`).bind(key).run();
  return (r.meta.changes ?? 0) > 0;
}

/** The named ranges the ledger and the scanner inbox both offer. */
export const RANGES = ['today', 'yesterday', '7d', '30d', 'month', 'lastmonth', 'ytd', 'all'] as const;
export type RangeName = (typeof RANGES)[number];

export const RANGE_LABEL: Record<RangeName, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  month: 'This month',
  lastmonth: 'Last month',
  ytd: 'Year to date',
  all: 'All time',
};

/**
 * Resolve a named range to dates. Done here rather than in the browser so it
 * follows the app's configured timezone, not the device's — the two disagree
 * about what "today" is for eight hours of every day.
 */
export function resolveRange(
  env: Env,
  range: string | null,
  from: string | null = null,
  to: string | null = null
): { from: string | null; to: string | null; label: string } {
  const now = today(env);
  const day = (offset: number) => isoDate(new Date(Date.parse(now + 'T00:00:00Z') + offset * 86400_000));

  switch (range) {
    case 'today':
      return { from: now, to: now, label: RANGE_LABEL.today };
    case 'yesterday':
      return { from: day(-1), to: day(-1), label: RANGE_LABEL.yesterday };
    case '7d':
      return { from: day(-6), to: now, label: RANGE_LABEL['7d'] };
    case '30d':
      return { from: day(-29), to: now, label: RANGE_LABEL['30d'] };
    case 'month':
      return { from: now.slice(0, 8) + '01', to: now, label: RANGE_LABEL.month };
    case 'lastmonth': {
      const [y, m] = now.split('-').map(Number);
      return {
        from: isoDate(new Date(Date.UTC(y, m - 2, 1))),
        to: isoDate(new Date(Date.UTC(y, m - 1, 0))),
        label: RANGE_LABEL.lastmonth,
      };
    }
    case 'ytd':
      return { from: `${now.slice(0, 4)}-01-01`, to: now, label: RANGE_LABEL.ytd };
    case 'all':
      return { from: null, to: null, label: RANGE_LABEL.all };
    default:
      return { from, to, label: from || to ? `${from ?? '…'} to ${to ?? '…'}` : RANGE_LABEL.all };
  }
}
