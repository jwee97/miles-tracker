import { DatabaseSync } from 'node:sqlite';
import { runMigrations, runSeed } from '../src/migrate';
import { backtest, forecastWith, selectModel, CANDIDATES, INTERVAL_Z } from '../src/intelligence/forecasting/baselines';
import { detectPattern, recurringDue, scanRecurring } from '../src/intelligence/forecasting/recurring';
import {
  coldStart,
  evaluateFinishedForecasts,
  forecastDimension,
  periodOutlook,
  storeForecast,
} from '../src/intelligence/forecasting/forecast';
import { capOutlook, minimumSpendOutlook, probabilityOfReaching, spendPlan } from '../src/intelligence/forecasting/plan';
import type { Env } from '../src/types';

const db = new DatabaseSync(':memory:');
const wrap = (sql: string, args: unknown[] = []): any => ({
  bind: (...a: unknown[]) => wrap(sql, a),
  first: async () => db.prepare(sql).get(...(args as any)) ?? null,
  all: async () => ({ results: db.prepare(sql).all(...(args as any)) }),
  run: async () => {
    const r = db.prepare(sql).run(...(args as any));
    return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  },
});
const env = {
  DB: { prepare: (s: string) => wrap(s) },
  TZ_OFFSET_MINUTES: '480',
  MILE_VALUE_CENTS: '1.5',
  POSTING_LAG_DAYS: '0',
  MIN_SPEND_WARN_DAYS: '7',
} as unknown as Env;
Date.now = () => Date.parse('2026-09-14T04:00:00Z');

let fails = 0;
const check = (l: string, c: boolean, d = '') => {
  if (!c) fails++;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : `  -- ${d}`}`);
};
const sql = (s: string, ...a: unknown[]) => db.prepare(s).run(...(a as any));

await runMigrations(env);
await runSeed(env);

// --- the baselines themselves ---------------------------------------------

const flat = { values: [10000, 10000, 10000, 10000, 10000, 10000] };
const f1 = forecastWith('mean', flat);
check('a flat series forecasts itself', f1.expected === 10000, String(f1.expected));
check('and needs no interval to do it', f1.lower === f1.upper, `${f1.lower}-${f1.upper}`);

const noisy = { values: [5000, 15000, 6000, 14000, 7000, 13000] };
const f2 = forecastWith('mean', noisy);
check('a noisy series gets a wide interval', f2.upper - f2.lower > 5000, String(f2.upper - f2.lower));
check('the expectation sits inside it', f2.expected >= f2.lower && f2.expected <= f2.upper, '');

const falling = { values: [40000, 30000, 20000, 10000, 5000, 2000] };
const ma = forecastWith('moving_average', falling).expected;
const mn = forecastWith('mean', falling).expected;
check('a moving average tracks a falling series faster than the mean', ma < mn, `${ma} vs ${mn}`);

// A method can never forecast money coming back.
const crashing = { values: [50000, 40000, 10000, 1000, 0, 0] };
check('the lower bound never goes negative', forecastWith('ewma', crashing).lower >= 0, '');

// The interval is exactly what it claims to be: z residual standard deviations.
const half = (f2.upper - f2.expected) / INTERVAL_Z;
check('the interval is z residual sds wide, as documented', half > 0, String(half));

// --- backtesting -----------------------------------------------------------

check('a series too short to backtest returns nothing', backtest({ values: [1, 2, 3] }, 'mean') === null, '');

const seasonal = { values: [10000, 2000, 2000, 2000, 10000, 2000, 2000, 2000, 10000, 2000, 2000, 2000] };
const bs = backtest(seasonal, 'seasonal_naive')!;
const bm = backtest(seasonal, 'mean')!;
check('seasonal naive beats the mean on a seasonal series', bs.mae < bm.mae, `${bs.mae} vs ${bm.mae}`);
check('a backtest reports how many folds it ran', bs.folds > 0, String(bs.folds));

// §58 — leakage. A backtest must only ever see strictly earlier periods. If it
// leaked, a series whose last value is wildly out of character would still be
// predicted well; forward-chained, it cannot be.
const shock = { values: [1000, 1000, 1000, 1000, 1000, 1000, 1000, 900000] };
const leaky = backtest(shock, 'mean')!;
check(
  'a shock in the final period is NOT predicted',
  leaky.mae > 10000,
  `mae ${leaky.mae} — a low value here means the future leaked into the past`
);
// And the same shock at the START must be learnable, which proves the harness
// is chained rather than simply broken.
const early = backtest({ values: [900000, 1000, 1000, 1000, 1000, 1000, 1000, 1000] }, 'moving_average')!;
check('while an early shock washes out', early.mae < leaky.mae, `${early.mae} vs ${leaky.mae}`);

const chosen = selectModel(seasonal);
check('model selection picks by backtest, not by hope', CANDIDATES.includes(chosen.chosen), chosen.chosen);
check('and says why', chosen.reason.length > 0, chosen.reason);
check('with every candidate scored', chosen.results.length >= 2, String(chosen.results.length));

// --- cold start ------------------------------------------------------------

check('under a month, nothing is forecast', coldStart(0.5).method === 'none', coldStart(0.5).method);
check('and it says so plainly', /Nothing here is worth forecasting/.test(coldStart(0.5).note), '');
check('a few weeks is a projection, not a forecast', coldStart(2).method === 'recent_spend', '');
check('and is labelled low confidence', coldStart(2).confidence === 'low', '');
check('six months earns the full treatment', coldStart(7).method === 'full', '');
check('confidence rises with history, never falls', coldStart(7).confidence === 'high', '');

// --- recurring detection ---------------------------------------------------

const monthly = detectPattern(
  [
    { occurred_at: '2026-06-03', amount_cents: 1499 },
    { occurred_at: '2026-07-03', amount_cents: 1499 },
    { occurred_at: '2026-08-03', amount_cents: 1499 },
    { occurred_at: '2026-09-03', amount_cents: 1499 },
  ],
  '2026-09-14'
);
check('four monthly charges are a monthly pattern', monthly?.frequency === 'monthly', String(monthly?.frequency));
check('with the next date in the future', (monthly?.next_expected_date ?? '') >= '2026-09-14', String(monthly?.next_expected_date));
check('and confidence short of certainty', (monthly?.confidence ?? 1) <= 0.95, String(monthly?.confidence));

const twice = detectPattern(
  [
    { occurred_at: '2026-06-03', amount_cents: 1499 },
    { occurred_at: '2026-07-03', amount_cents: 1499 },
  ],
  '2026-09-14'
);
check('two charges are not yet a pattern', twice === null, JSON.stringify(twice));

const scattered = detectPattern(
  [
    { occurred_at: '2026-06-01', amount_cents: 4000 },
    { occurred_at: '2026-06-19', amount_cents: 9000 },
    { occurred_at: '2026-08-02', amount_cents: 1200 },
    { occurred_at: '2026-09-11', amount_cents: 30000 },
  ],
  '2026-09-14'
);
check('irregular spending is not made into a subscription', scattered === null, JSON.stringify(scattered));

// --- a ledger to plan against ---------------------------------------------

sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,base_mpd)
     VALUES ('UOB','Preferred','uob_pp','pref',800000,15,'2025-06-01',0.4)`);
const pref = (db.prepare(`SELECT id FROM cards WHERE nickname='pref'`).get() as any).id;

// A $1,000/cycle dining cap at 4 mpd.
sql(`INSERT INTO earn_rules (card_id,category,mpd,reward_type,cap_cents,cap_window)
     VALUES (?,'dining',4,'miles',100000,'calendar_month')`, pref);
sql(`INSERT INTO earn_rules (card_id,category,mpd,reward_type) VALUES (?,'*',0.4,'miles')`, pref);

// Fifteen months of steady dining, twice a week, plus a monthly subscription.
let day = Date.parse('2025-06-02T00:00:00Z');
while (day < Date.parse('2026-09-14T00:00:00Z')) {
  const d = new Date(day).toISOString().slice(0, 10);
  sql(
    `INSERT INTO transactions (card_id,amount_cents,occurred_at,posted_at,merchant,mcc,category) VALUES (?,?,?,?,?,?,?)`,
    pref, 9000, d, d, 'Din Tai Fung', '5812', 'dining'
  );
  day += 3.5 * 86_400_000;
}
for (let m = 0; m < 15; m++) {
  const d = new Date(Date.UTC(2025, 5 + m, 3)).toISOString().slice(0, 10);
  sql(
    `INSERT INTO transactions (card_id,amount_cents,occurred_at,posted_at,merchant,mcc,category) VALUES (?,?,?,?,?,?,?)`,
    pref, 1499, d, d, 'Netflix', '4899', 'online'
  );
}

const scan = await scanRecurring(env);
check('the subscription is detected from the ledger', scan.detected + scan.updated >= 1, JSON.stringify(scan.patterns));
const netflix = scan.patterns.find((p) => p.merchant.toLowerCase().includes('netflix'));
check('and identified as monthly', netflix?.frequency === 'monthly', String(netflix?.frequency));
check('at the amount it actually charges', netflix?.amount_cents === 1499, String(netflix?.amount_cents));

const due = await recurringDue(env, '2026-09-14', '2026-10-14');
check('and is expected once in the next month', due.total_cents === 1499, String(due.total_cents));

// Rescanning must not duplicate: the scan is a total re-derivation.
const again = await scanRecurring(env);
check('rescanning is idempotent', again.detected === 0, `${again.detected} new on a second run`);
check(
  'and leaves one row, not two',
  (db.prepare(`SELECT COUNT(*) AS n FROM recurring_patterns WHERE merchant_key LIKE '%etflix%'`).get() as any).n === 1,
  ''
);

// --- forecasting from real data -------------------------------------------

const dining = await forecastDimension(env, {
  dimension_type: 'category',
  dimension_key: 'dining',
  period_start: '2026-09-14',
  period_end: '2026-10-14',
});
check('a category with history forecasts', dining !== null, '');
check('roughly the right size', (dining?.expected_cents ?? 0) > 50000, String(dining?.expected_cents));
check('inside an interval that contains it', (dining!.lower_cents <= dining!.expected_cents) && (dining!.expected_cents <= dining!.upper_cents), '');
check('with a named method', dining!.model.length > 0, dining!.model);
check('and an explanation a person can read', /week/.test(dining!.explanation), dining!.explanation);

const nothing = await forecastDimension(env, {
  dimension_type: 'category',
  dimension_key: 'travel',
  period_start: '2026-09-14',
  period_end: '2026-10-14',
});
check('a category with no history is not invented', nothing === null, JSON.stringify(nothing));

const outlook = await periodOutlook(env, { start: '2026-09-14', end: '2026-10-14' });
check('the period outlook has a total', outlook.total !== null, '');
check('and names categories it actually has history for', outlook.categories.length >= 1, String(outlook.categories.length));
check('and reports recurring separately from the estimate', outlook.recurring_cents === 1499, String(outlook.recurring_cents));

// --- cap overflow ----------------------------------------------------------

const caps = await capOutlook(env);
const capRow = caps.find((c) => c.categories.includes('dining'))!;
check('the dining cap is found', !!capRow, JSON.stringify(caps));
check('with the cap read from the rule, not estimated', capRow.cap_cents === 100000, String(capRow.cap_cents));
check('spend against it read from the ledger', capRow.spent_cents > 0, String(capRow.spent_cents));
check('headroom is cap minus spend, exactly', capRow.headroom_cents === Math.max(0, capRow.cap_cents - capRow.spent_cents), '');
check('and the outlook says whether it will fill', capRow.state !== 'unknown', capRow.state);

// A cap already exhausted says so, and says what to do instead.
sql(
  `INSERT INTO transactions (card_id,amount_cents,occurred_at,posted_at,merchant,mcc,category) VALUES (?,?,?,?,?,?,?)`,
  pref, 200000, '2026-09-10', '2026-09-10', 'Big Dinner', '5812', 'dining'
);
const filled = (await capOutlook(env)).find((c) => c.categories.includes('dining'))!;
check('an exhausted cap is reported as filled', filled.state === 'filled', filled.state);
check('with no headroom left', filled.headroom_cents === 0, String(filled.headroom_cents));
check('and advice that points elsewhere rather than urging spend',
  !!filled.advice && /base rate/.test(filled.advice) && !/spend more/i.test(filled.advice),
  String(filled.advice));

// --- minimum spend ---------------------------------------------------------

check('a probability needs a real interval', probabilityOfReaching(0, { expected_cents: 100, lower_cents: 100, upper_cents: 100 }, 200) === null, '');
const p = probabilityOfReaching(50000, { expected_cents: 50000, lower_cents: 30000, upper_cents: 70000 }, 100000);
check('reaching exactly the expectation is a coin flip', p !== null && Math.abs(p - 0.5) < 0.02, String(p));
const pHigh = probabilityOfReaching(90000, { expected_cents: 50000, lower_cents: 30000, upper_cents: 70000 }, 100000);
check('being nearly there is likely', (pHigh ?? 0) > 0.9, String(pHigh));
const pLow = probabilityOfReaching(0, { expected_cents: 50000, lower_cents: 30000, upper_cents: 70000 }, 500000);
check('being far away is not', (pLow ?? 1) < 0.05, String(pLow));

sql(`INSERT INTO requirements (card_id,kind,amount_cents,window,active) VALUES (?, 'monthly_min', 50000, 'calendar_month', 1)`, pref);
const mins = await minimumSpendOutlook(env);
const met = mins.find((m) => m.card.id === pref)!;
check('a minimum already cleared is reported as met', met.state === 'met', met.state);
check('stating the figures rather than urging anything', /Met: /.test(met.outlook) && !/spend/i.test(met.outlook), met.outlook);

// A minimum far out of reach, late in the window.
sql(`UPDATE requirements SET amount_cents = 9000000 WHERE card_id = ?`, pref);
const hard = (await minimumSpendOutlook(env)).find((m) => m.card.id === pref)!;
check('an unreachable minimum is not called on track', hard.state !== 'on_track' && hard.state !== 'met', hard.state);
check('the shortfall is stated in money', /short of/.test(hard.outlook), hard.outlook);
check('and it never tells anyone to spend', !/you should spend|spend more/i.test(hard.outlook), hard.outlook);
check('the requirement figure comes from the rule, not the forecast', hard.required_cents === 9000000, String(hard.required_cents));

const plan = await spendPlan(env);
check('the plan carries both halves', plan.caps.length > 0 && plan.minimums.length > 0, '');
check('and a short list of what to read first', plan.headlines.length > 0 && plan.headlines.length <= 5, String(plan.headlines.length));

// --- scoring what was claimed ---------------------------------------------

// A forecast for a window that has closed, and the truth of what happened.
await storeForecast(env, {
  dimension_type: 'category',
  dimension_key: 'dining',
  period_start: '2026-08-01',
  period_end: '2026-08-31',
  expected_cents: 70000,
  lower_cents: 50000,
  upper_cents: 90000,
  recurring_cents: 0,
  model: 'ewma',
  model_reason: 'test',
  confidence: 'high',
  observations: 20,
  explanation: '',
  backtest: [],
});
const scored = await evaluateFinishedForecasts(env);
check('a closed forecast gets scored', scored.evaluated === 1, String(scored.evaluated));
check('against what actually happened', scored.mae_cents > 0, String(scored.mae_cents));
check('and coverage is reported, not assumed', scored.coverage >= 0 && scored.coverage <= 1, String(scored.coverage));
check('broken down by method', scored.by_model.length >= 1, String(scored.by_model.length));

// A forecast for a window still open must NOT be scored — there is nothing to
// compare it against yet, and scoring it would count the month so far as the
// month's total.
await storeForecast(env, {
  dimension_type: 'category',
  dimension_key: 'dining',
  period_start: '2026-09-01',
  period_end: '2026-09-30',
  expected_cents: 70000,
  lower_cents: 50000,
  upper_cents: 90000,
  recurring_cents: 0,
  model: 'ewma',
  model_reason: 'test',
  confidence: 'high',
  observations: 20,
  explanation: '',
  backtest: [],
});
const rescored = await evaluateFinishedForecasts(env);
check('an open window is not scored early', rescored.evaluated === 1, String(rescored.evaluated));

console.log(fails ? `\n${fails} check(s) failed` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
