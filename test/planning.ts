/**
 * Planning, leakage, and noticing that a bank changed its card.
 *
 * The common thread: each of these takes a thing the app already knows how to
 * do for one transaction and asks it about a month, a history, or a product —
 * and each is easy to make dishonest. A leakage figure that quietly assumes
 * perfect foresight, a plan that reads as an instruction to spend, a rule
 * change applied without anybody looking. So most of what is checked here is
 * the restraint rather than the arithmetic.
 */
import { DatabaseSync } from 'node:sqlite';
import { runMigrations, runSeed } from '../src/migrate';
import { rewardLeakage, MATERIAL_LOSS_CENTS } from '../src/intelligence/planning/leakage';
import { monthlyPlan } from '../src/intelligence/planning/allocate';
import { diffRules, mergeCandidates, effectiveFrom, applyChange, dismissChange, pendingChanges } from '../src/catalog/watch/detect';
import { ruleSetOn } from '../src/catalog/rulesets';
import type { Env } from '../src/types';

const db = new DatabaseSync(':memory:');

// A Worker invocation may make fifty subrequests, and every D1 call is one.
// A report that replays the ledger is exactly the shape that quietly exceeds
// that, and the failure is an error about API requests that says nothing about
// the report.
const FREE_PLAN_SUBREQUESTS = 50;
let subrequests = 0;
let inBatch = false;
const countOne = () => {
  if (!inBatch) subrequests++;
};
const wrap = (sql: string, args: unknown[] = []): any => ({
  bind: (...a: unknown[]) => wrap(sql, a),
  first: async () => {
    countOne();
    return db.prepare(sql).get(...(args as any)) ?? null;
  },
  all: async () => {
    countOne();
    return { results: db.prepare(sql).all(...(args as any)) };
  },
  run: async () => {
    countOne();
    const r = db.prepare(sql).run(...(args as any));
    return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  },
});
const env = {
  DB: {
    prepare: (s: string) => wrap(s),
    batch: async (ss: any[]) => {
      subrequests++;
      inBatch = true;
      try {
        return await Promise.all(ss.map((x) => x.all()));
      } finally {
        inBatch = false;
      }
    },
  },
  TZ_OFFSET_MINUTES: '480',
  MILE_VALUE_CENTS: '1.5',
  POSTING_LAG_DAYS: '0',
  MIN_SPEND_WARN_DAYS: '7',
  OBJECTIVE: 'balanced',
} as unknown as Env;
Date.now = () => Date.parse('2026-09-20T04:00:00Z');

let fails = 0;
const check = (l: string, c: boolean, d = '') => {
  if (!c) fails++;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : `  -- ${d}`}`);
};
const sql = (s: string, ...a: unknown[]) => db.prepare(s).run(...(a as any));

await runMigrations(env);
await runSeed(env);

// Two cards: one pays well on dining, the other on nothing in particular.
sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,base_mpd)
     VALUES ('UOB','Lady''s','uob_lady','lady',800000,15,'2025-01-01',0.4)`);
sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,base_mpd)
     VALUES ('Citi','Rewards','citi_rw','crw',500000,15,'2025-01-01',0.4)`);
const lady = (db.prepare(`SELECT id FROM cards WHERE nickname='lady'`).get() as any).id;
const crw = (db.prepare(`SELECT id FROM cards WHERE nickname='crw'`).get() as any).id;

sql(`INSERT INTO earn_rules (card_id,category,mpd,reward_type,cap_cents,cap_window) VALUES (?,'dining',4,'miles',50000,'calendar_month')`, lady);
sql(`INSERT INTO earn_rules (card_id,category,mpd,reward_type) VALUES (?,'*',0.4,'miles')`, lady);
sql(`INSERT INTO earn_rules (card_id,category,mpd,reward_type) VALUES (?,'online',4,'miles')`, crw);
sql(`INSERT INTO earn_rules (card_id,category,mpd,reward_type) VALUES (?,'*',0.4,'miles')`, crw);

// --- leakage: what the wrong card cost --------------------------------------
//
// Dining put on the card that pays base rate, when the other pays 4 mpd.
// Dates built in JS, not in SQL: `'2026-08-0' || 1` comes back as
// "2026-08-01.0" because the integer bind is coerced to a float first, and a
// malformed date fails deep inside the engine with "Invalid time value".
for (let i = 1; i <= 6; i++) {
  const day = `2026-08-0${i}`;
  sql(
    `INSERT INTO transactions (card_id, amount_cents, occurred_at, posted_at, merchant, category, status)
     VALUES (?, 6000, ?, ?, 'Din Tai Fung', 'dining', 'posted')`,
    crw, day, day
  );
}
// And one put on the right card, which must not show as a loss.
sql(
  `INSERT INTO transactions (card_id, amount_cents, occurred_at, posted_at, merchant, category, status)
   VALUES (?, 9000, '2026-08-09', '2026-08-09', 'Din Tai Fung', 'dining', 'posted')`,
  lady
);

const leak = await rewardLeakage(env, { from: '2026-08-01', to: '2026-08-31' });
check('every posted transaction is examined', leak.transactions_examined === 7, String(leak.transactions_examined));
check('and priced', leak.priced === 7, `${leak.priced} priced, unpriced: ${JSON.stringify(leak.unpriced)}`);
check('a wrong card shows as leakage', leak.leakage_cents > 0, String(leak.leakage_cents));
check('the best figure is at least the actual one', leak.best_value_cents >= leak.actual_value_cents, '');
check('capture rate is a fraction of what was available', leak.capture_rate > 0 && leak.capture_rate < 1, String(leak.capture_rate));

check('losses are grouped by category', leak.by_category[0]?.category === 'dining', JSON.stringify(leak.by_category));
check('the repeated mistake is named', leak.patterns.length >= 1, JSON.stringify(leak.patterns));
check('with the card used and the better one', leak.patterns[0]?.used_card === 'crw' && leak.patterns[0]?.better_card === 'lady', JSON.stringify(leak.patterns[0]));
check('and how many times', (leak.patterns[0]?.occurrences ?? 0) >= 5, String(leak.patterns[0]?.occurrences));
check('in a sentence rather than a table', /would have earned more/.test(leak.patterns[0]?.summary ?? ''), String(leak.patterns[0]?.summary));

check(
  'the transaction on the right card is not a regret',
  !leak.worst.some((w) => w.used_card === 'lady'),
  JSON.stringify(leak.worst.map((w) => w.used_card))
);
check('rounding is not reported as a mistake', MATERIAL_LOSS_CENTS > 0, '');

// The honesty this report has to carry, or it is a report about a fantasy.
check('it says it judged against the rules of the time', leak.caveats.some((c) => /in force on each/.test(c)), JSON.stringify(leak.caveats));
check(
  'and that perfect foresight is not achievable',
  leak.caveats.some((c) => /perfect foresight/.test(c)),
  JSON.stringify(leak.caveats)
);
check('and it never tells anyone to spend', !leak.caveats.join(' ').match(/you should spend|spend more/i), '');

// --- what the report costs to produce ---------------------------------------
// Replaying the ledger is the most expensive thing this app does. Measured
// rather than assumed, because the ceiling is not a soft one: past it the
// platform cuts the invocation off and the screen shows an error about API
// requests.
{
  for (let i = 0; i < 40; i++) {
    sql(
      `INSERT INTO transactions (card_id, amount_cents, occurred_at, posted_at, merchant, category, mcc)
       VALUES (1, 4000, '2026-07-${String((i % 28) + 1).padStart(2, '0')}', '2026-07-${String((i % 28) + 1).padStart(2, '0')}', 'Somewhere', 'dining', '5812')`
    );
  }
  subrequests = 0;
  const r = await rewardLeakage(env, { from: '2026-07-01', to: '2026-07-31' });
  const cost = subrequests;
  check(`forty purchases were replayed (${r.priced} priced)`, r.transactions_examined === 40, JSON.stringify(r.transactions_examined));
  check(
    `and the report fits in one Worker invocation (${cost} of ${FREE_PLAN_SUBREQUESTS})`,
    cost <= FREE_PLAN_SUBREQUESTS,
    `${cost} subrequests for 40 rows — past ${FREE_PLAN_SUBREQUESTS} the platform stops the request`
  );
  check(
    'with room to spare, since a real ledger is longer than forty rows',
    cost <= FREE_PLAN_SUBREQUESTS / 2,
    `${cost} of ${FREE_PLAN_SUBREQUESTS}`
  );

  // The cost has to be flat in the number of rows, not merely small at forty:
  // the reads this makes are of reference data, and re-reading it per row is
  // what made the report fail on exactly the histories worth reporting on.
  for (let i = 0; i < 40; i++) {
    const d = `2026-07-${String((i % 28) + 1).padStart(2, '0')}`;
    sql(
      `INSERT INTO transactions (card_id, amount_cents, occurred_at, posted_at, merchant, category, mcc)
       VALUES (1, 4000, ?, ?, 'Somewhere', 'dining', '5812')`,
      d,
      d
    );
  }
  subrequests = 0;
  await rewardLeakage(env, { from: '2026-07-01', to: '2026-07-31' });
  check(
    `and twice the rows costs no more (${subrequests} for 80)`,
    subrequests <= cost,
    `${cost} for 40, ${subrequests} for 80 — the cost has to be flat in the rows`
  );

  // Left behind, these would change what the plan below is asked about.
  sql(`DELETE FROM transactions WHERE occurred_at LIKE '2026-07-%'`);
}

const quiet = await rewardLeakage(env, { from: '2026-01-01', to: '2026-01-31' });
check('a month with nothing in it leaks nothing', quiet.leakage_cents === 0, String(quiet.leakage_cents));
check('and claims full capture rather than zero', quiet.capture_rate === 1, String(quiet.capture_rate));

// --- the plan: an order to use cards in, not a budget ------------------------
//
// Enough dining history for a forecast, spread over months so the cold-start
// ladder reaches its full form.
for (let m = 2; m <= 8; m++) {
  for (let d = 1; d <= 20; d += 2) {
    sql(
      `INSERT INTO transactions (card_id, amount_cents, occurred_at, posted_at, merchant, category, status)
       VALUES (?, 4000, ?, ?, 'Some Restaurant', 'dining', 'posted')`,
      lady,
      `2026-0${m}-${String(d).padStart(2, '0')}`,
      `2026-0${m}-${String(d).padStart(2, '0')}`
    );
  }
}

const plan = await monthlyPlan(env, { start: '2026-09-01', end: '2026-09-30' });
check('the plan covers the rest of the period', plan.period.days_left >= 0, String(plan.period.days_left));
const dining = plan.categories.find((c) => c.category === 'dining');
check('dining is planned', !!dining, JSON.stringify(plan.categories.map((c) => c.category)));
check('with a range, not a single figure', (dining?.upper_cents ?? 0) > (dining?.lower_cents ?? 0), JSON.stringify(dining));
check('the best-paying card comes first', dining?.allocations[0]?.card === 'lady', JSON.stringify(dining?.allocations));
check('with a reason a person can read', /pays the most here/.test(dining?.allocations[0]?.why ?? ''), String(dining?.allocations[0]?.why));
check(
  'and the amount is bounded by the cap, not by the forecast',
  (dining?.allocations[0]?.amount_cents ?? 0) <= 50000,
  `${dining?.allocations[0]?.amount_cents} against a $500 cap`
);

check('the headline says where to start and where to move', plan.headlines.some((h) => /dining/.test(h)), JSON.stringify(plan.headlines));
check('a category with no history is listed rather than dropped', Array.isArray(plan.unplanned), '');
check('the plan says the amounts are forecasts, not instructions', plan.caveats.some((c) => /not what you should spend/.test(c)), JSON.stringify(plan.caveats));
// The caveats say "not what you should spend", which is the disclaimer, so
// only the advice itself is checked for instructions.
check(
  'and never urges spending',
  !plan.headlines.join(' ').match(/you should spend|spend more|try to spend|put more/i),
  JSON.stringify(plan.headlines)
);

// --- a bank changed its card ------------------------------------------------

const before = [{ category: 'dining', mpd: 4, reward_type: 'miles' as const, cap_cents: 150000, cap_window: 'calendar_month', quote: '' }];
const after = [{ category: 'dining', mpd: 4, reward_type: 'miles' as const, cap_cents: 100000, cap_window: 'calendar_month', quote: 'capped at $1,000' }];

const d1 = diffRules(before, after);
check('a smaller cap is a change', d1.length === 1, JSON.stringify(d1));
check('and a material one', d1[0].material, '');
check('described in the direction it moved', /1,500.00 → \$1,000.00/.test(d1[0].summary), d1[0].summary);

const d2 = diffRules(before, [{ ...after[0], cap_cents: 150000, quote: 'reworded' }]);
check('a page reworded around the same rates is not a change', d2.length === 0, JSON.stringify(d2));

const d3 = diffRules(before, [{ category: 'dining', mpd: 4, reward_type: null, cap_cents: null, cap_window: null, quote: '' }]);
check(
  'a page that stays silent about the cap does not remove it',
  d3.length === 0,
  'reading silence as "no cap" would delete a real one on every rewording'
);

const d4 = diffRules(before, []);
check('a category that vanished is reported', d4.length === 1 && d4[0].after === null, JSON.stringify(d4));
check('as a withdrawal rather than a changed number', /no longer mentioned/.test(d4[0].summary), d4[0].summary);

const merged = mergeCandidates([
  { kind: 'rate', quote: '4 mpd on dining', rate: 4, reward_type: 'miles', category: 'dining' },
  { kind: 'cap', quote: 'capped at $1,000 a month', cap_cents: 100000, cap_window: 'calendar_month', category: 'dining' },
] as any);
check('a rate and a cap stated separately become one rule', merged.length === 1, JSON.stringify(merged));
check('carrying both', merged[0].mpd === 4 && merged[0].cap_cents === 100000, JSON.stringify(merged[0]));

check('a stated start date is read', effectiveFrom('With effect from 1 November 2026, rates change.') === '2026-11-01', String(effectiveFrom('With effect from 1 November 2026, rates change.')));
check('and an unstated one is not invented', effectiveFrom('Rates are changing soon.') === null, '');

// Applying a change closes the old version and opens a new one.
sql(`INSERT INTO card_products (issuer, product_name, product_key) VALUES ('UOB', 'Lady''s Card', 'uob_ladys_v2')`);
const productId = (db.prepare(`SELECT id FROM card_products WHERE product_key='uob_ladys_v2'`).get() as any).id;
sql(
  `INSERT INTO rule_sets (product_id, version, effective_from, status, published_at)
   VALUES (?, 1, '2026-01-01', 'published', '2026-01-01')`,
  productId
);
const oldSet = (db.prepare(`SELECT id FROM rule_sets WHERE product_id = ?`).get(productId) as any).id;
sql(`INSERT INTO earn_rules (rule_set_id, category, mpd, reward_type, cap_cents, cap_window, active) VALUES (?, 'dining', 4, 'miles', 150000, 'calendar_month', 1)`, oldSet);

sql(
  `INSERT INTO rule_change_candidates (product_id, source_url, detected_at, content_hash, proposed_json, diff_json, material, effective_from, status)
   VALUES (?, 'https://bank.invalid/lady', '2026-09-20', 'abc', ?, ?, 1, '2026-11-01', 'pending')`,
  productId, JSON.stringify(after), JSON.stringify(d1)
);
const candId = (db.prepare(`SELECT id FROM rule_change_candidates`).get() as any).id;

const queue = await pendingChanges(env);
check('a detected change waits for a person', queue.length === 1, String(queue.length));
check('with the diff already worked out', queue[0].diff.length === 1, JSON.stringify(queue[0].diff));
check('and marked material', queue[0].material, '');
check('naming the page it came from', queue[0].source_url.includes('bank.invalid'), queue[0].source_url);

check(
  'nothing was written to the rules by detection alone',
  (db.prepare(`SELECT COUNT(*) AS n FROM rule_sets WHERE product_id = ?`).get(productId) as any).n === 1,
  'a bank page is a claim; rates are what every recommendation is built on'
);

const applied = await applyChange(env, candId, after, { effective_from: '2026-11-01' });
check('a reviewer can apply it', applied.ok, JSON.stringify(applied));
check('creating a new version', applied.version === 2, String(applied.version));
check('effective from the date the page gave', applied.effective_from === '2026-11-01', String(applied.effective_from));

const closed = db.prepare(`SELECT effective_until, status FROM rule_sets WHERE id = ?`).get(oldSet) as any;
check('the version it replaces is closed', closed.effective_until === '2026-10-31', JSON.stringify(closed));
check('the day before the new one opens', closed.effective_until < '2026-11-01', '');

const inOctober = await ruleSetOn(env, productId, '2026-10-15');
const inNovember = await ruleSetOn(env, productId, '2026-11-15');
check('October still resolves to the old rates', inOctober?.id === oldSet, String(inOctober?.id));
check('and November to the new ones', inNovember?.id === applied.rule_set_id, String(inNovember?.id));
check(
  'so a purchase is always judged by the rules of its own day',
  inOctober?.id !== inNovember?.id,
  'this is the property the whole versioning scheme exists for'
);

check('and the change is no longer pending', (await pendingChanges(env)).length === 0, '');

sql(
  `INSERT INTO rule_change_candidates (product_id, source_url, detected_at, content_hash, proposed_json, diff_json, material, status)
   VALUES (?, 'https://bank.invalid/lady', '2026-09-21', 'def', '[]', '[]', 0, 'pending')`,
  productId
);
const second = (db.prepare(`SELECT id FROM rule_change_candidates ORDER BY id DESC LIMIT 1`).get() as any).id;
const dismissed = await dismissChange(env, second, 'only the wording moved');
check('a change can be dismissed', dismissed.ok, '');
check('with the reason kept', (db.prepare(`SELECT review_note FROM rule_change_candidates WHERE id = ?`).get(second) as any).review_note === 'only the wording moved', '');
check('and it does not come back', (await pendingChanges(env)).length === 0, '');
check('applying something already resolved is refused', !(await applyChange(env, second, after)).ok, '');

console.log(fails ? `\n${fails} check(s) failed` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
