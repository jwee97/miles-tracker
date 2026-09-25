/**
 * Is a card missing from my setup?
 *
 * The temptation in this feature is to assign a candidate card to every
 * transaction and report the difference, which is how comparison sites arrive
 * at numbers nobody ever sees. A card only earns on a purchase if it beats what
 * would otherwise have been used, so every test here is really checking that
 * caps, overlap and fees reduce the answer rather than decorating it.
 */
import { DatabaseSync } from 'node:sqlite';
import { acquisitionReport } from '../src/acquisition/economics';
import { portfolioGaps, spendingProfile } from '../src/acquisition/gaps';
import { candidates, simulateProduct } from '../src/acquisition/simulate';
import { draftFromCurrent, reviewAndPublish } from '../src/catalog/publish';
import { productByKey } from '../src/catalog/products';
import { runMigrations, runSeed } from '../src/migrate';
import { linkApplicability, publishPromotion, savePromotion } from '../src/promotions/model';
import { ingestTransaction } from '../src/transactions/ingest';
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
  DB: { prepare: (s: string) => wrap(s), batch: async (ss: any[]) => Promise.all(ss.map((x) => x.all())) },
  TZ_OFFSET_MINUTES: '480',
  MILE_VALUE_CENTS: '1.5',
  MIN_SPEND_WARN_DAYS: '7',
  POSTING_LAG_DAYS: '0',
} as unknown as Env;

let fails = 0;
const check = (l: string, c: boolean, d = '') => {
  if (!c) fails++;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : `  -- ${d}`}`);
};
const sql = (s: string, ...a: unknown[]) => db.prepare(s).run(...(a as any));
const one = (s: string, ...a: unknown[]) => db.prepare(s).get(...(a as any)) as any;
Date.now = () => Date.parse('2026-09-18T04:00:00Z');

await runMigrations(env);
await runSeed(env);

const product = async (key: string, name: string, fee: number | null, base: number) => {
  sql(
    `INSERT INTO card_products (product_key, issuer, product_name, reward_type, base_mpd, annual_fee_cents, verification_status, last_verified_at)
     VALUES (?, 'T', ?, 'miles', ?, ?, 'verified', '2026-09-01')`,
    key,
    name,
    base,
    fee
  );
  return (await productByKey(env, key))!;
};

const version = async (pid: number, rules: [string, number, number | null][]) => {
  const d = await draftFromCurrent(env, pid, '2025-01-01', { today: '2025-01-01' });
  for (const [category, mpd, cap] of rules) {
    sql(
      `INSERT INTO earn_rules (rule_set_id,category,mpd,reward_type,cap_cents,cap_window,active) VALUES (?,?,?,?,?,?,1)`,
      d.draft.id,
      category,
      mpd,
      'miles',
      cap,
      cap ? 'calendar_month' : null
    );
  }
  await reviewAndPublish(env, d.draft.id, '2025-01-01');
};

// The card held: 1.2 mpd flat.
const held = await product('held', 'Plain Card', null, 1.2);
await version(held.id, [['*', 1.2, null]]);
sql(
  `INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,base_mpd,product_id)
   VALUES ('T','Plain Card','held','plain',900000,18,'2025-01-01',1.2,?)`,
  held.id
);
const card = one(`SELECT * FROM cards WHERE nickname = 'plain'`);

// Six months of real spending: a lot of dining, some online.
for (let m = 4; m <= 9; m++) {
  const mm = String(m).padStart(2, '0');
  await ingestTransaction(env, { source: 'manual', card_id: card.id, amount_cents: 54000, occurred_at: `2026-${mm}-05`, merchant: 'Restaurant', mcc: '5812', category: 'dining' });
  await ingestTransaction(env, { source: 'manual', card_id: card.id, amount_cents: 12000, occurred_at: `2026-${mm}-12`, merchant: 'Shopee', mcc: '5311', category: 'online' });
}

// --- the profile ------------------------------------------------------------
const profile = await spendingProfile(env, 6);
check('spending is grouped by category', profile.slices.length >= 2, JSON.stringify(profile.slices.map((s) => s.category)));
check('with a monthly figure', profile.slices.find((s) => s.category === 'dining')!.monthly_cents === 54000, String(profile.slices.find((s) => s.category === 'dining')?.monthly_cents));
check('and what it actually earned', profile.slices.find((s) => s.category === 'dining')!.return_pct > 0);
check('over the months that have data', profile.months_with_data === 6, String(profile.months_with_data));

// --- gaps -------------------------------------------------------------------
const gaps = await portfolioGaps(env, 6);
const dining = gaps.find((g) => g.category === 'dining');
check('a big category earning the base rate is a gap', dining !== undefined, JSON.stringify(gaps.map((g) => g.category)));
check('naming what it costs a month', dining!.detail.includes('540.00'), dining?.detail);
check('and that nothing you hold pays a bonus on it', dining!.detail.includes('no card of yours'), dining?.detail);
check('and how bad it is', dining!.severity === 'high', dining?.severity);
check('gaps come before any card is considered', Array.isArray(gaps));

// --- a candidate that genuinely helps ---------------------------------------
const better = await product('better', 'Dining Card', null, 0.4);
await version(better.id, [['dining', 4, null], ['*', 0.4, null]]);

let sim = await simulateProduct(env, better, 6);
check('a card that beats what you use adds value', sim.projected_annual_incremental_value_cents > 0, String(sim.projected_annual_incremental_value_cents));
check('and the improvement is attributed to a category', sim.categories_improved[0].category === 'dining', JSON.stringify(sim.categories_improved.map((c) => c.category)));
check(
  'while where it does not help is also reported',
  sim.no_improvement.some((n) => n.includes('online')),
  JSON.stringify(sim.no_improvement)
);
check('with what it assumed', sim.assumptions.some((a) => a.includes('wherever it beat')), JSON.stringify(sim.assumptions));
check('and eligibility is not guessed at', sim.eligibility === 'unknown', sim.eligibility);

// --- a cap limits the benefit ------------------------------------------------
// The cap has to be large enough that the card still beats a flat 1.2 mpd one:
// at a $100 cap and a 0.4 base it genuinely loses, and zero would be the right
// answer rather than an interesting one.
const capped = await product('capped', 'Capped Dining Card', null, 0.4);
await version(capped.id, [['dining', 4, 30000], ['*', 0.4, null]]);
const cappedSim = await simulateProduct(env, capped, 6);
check(
  'a cap holds the projection down',
  cappedSim.projected_annual_incremental_value_cents < sim.projected_annual_incremental_value_cents,
  `${cappedSim.projected_annual_incremental_value_cents} vs ${sim.projected_annual_incremental_value_cents}`
);
check(
  'rather than paying the bonus rate on everything',
  cappedSim.projected_annual_incremental_value_cents > 0,
  `${cappedSim.projected_annual_incremental_value_cents}; improved ${JSON.stringify(cappedSim.categories_improved)}`
);

// --- a card that repeats what you hold ---------------------------------------
const twin = await product('twin', 'Another Plain Card', null, 1.2);
await version(twin.id, [['*', 1.2, null]]);
const twinSim = await simulateProduct(env, twin, 6);
check('a card that ties adds nothing', twinSim.projected_annual_incremental_value_cents === 0, String(twinSim.projected_annual_incremental_value_cents));
check('and its overlap is visible', twinSim.overlap_score > 0.5, String(twinSim.overlap_score));

// --- a fee that outweighs the benefit ----------------------------------------
const expensive = await product('expensive', 'Expensive Dining Card', 50000, 0.4);
await version(expensive.id, [['dining', 4, null], ['*', 0.4, null]]);
const feeSim = await simulateProduct(env, expensive, 6);
check('the fee is kept separate from the reward', feeSim.annual_fee_cents === 50000 && feeSim.projected_annual_incremental_value_cents > 0);
check('and the net is what is left after it', feeSim.net_value_cents === feeSim.projected_annual_incremental_value_cents - 50000);

// --- a welcome offer stays separate ------------------------------------------
const promo = await savePromotion(env, {
  promotion_type: 'welcome_offer',
  issuer: 'T',
  title: '25,000 welcome miles',
  terms: { minimum_spend_cents: 80000, reward_miles: 25000 },
});
await linkApplicability(env, promo.id!, { product_keys: ['better'] });
await publishPromotion(env, promo.id!);

const report = await acquisitionReport(env, { months: 6 });
const pick = report.suggestions.find((s) => s.product.product_key === 'better')!;
check('a candidate is suggested', pick !== undefined, JSON.stringify(report.suggestions.map((s) => s.product.product_key)));
check('the welcome offer is shown separately', pick.welcome_offer!.reward === '25,000 miles', JSON.stringify(pick.welcome_offer));
check(
  'and never folded into the ongoing value',
  pick.projected_annual_incremental_value_cents < 25000 * 1.5,
  String(pick.projected_annual_incremental_value_cents)
);
check('what it requires is stated', pick.welcome_offer!.requires === '$800.00 of spend', pick.welcome_offer?.requires);

// --- what is not worth it ------------------------------------------------------
check('cards that are not worth it are reported too', report.not_worth_it.length > 0, JSON.stringify(report.not_worth_it));
const tooExpensive = report.not_worth_it.find((n) => n.product_name === 'Expensive Dining Card');
const duplicate = report.not_worth_it.find((n) => n.product_name === 'Another Plain Card');
check('a fee bigger than the benefit is the reason given', tooExpensive === undefined || tooExpensive.why.includes('fee'), JSON.stringify(tooExpensive));
check('and so is overlapping a card you hold', duplicate !== undefined, JSON.stringify(report.not_worth_it));

check('another card is never free', pick.complexity_cost_cents > 0, String(pick.complexity_cost_cents));
check(
  'so the score is below the gross reward',
  pick.score_cents < pick.projected_annual_incremental_value_cents,
  `${pick.score_cents} vs ${pick.projected_annual_incremental_value_cents}`
);
check('the gaps it closes are named', pick.closes_gaps.includes('dining'), JSON.stringify(pick.closes_gaps));

// --- objectives change the ranking ---------------------------------------------
const simple = await acquisitionReport(env, { months: 6, objective: 'simpler_wallet' });
check('wanting a simpler wallet costs a candidate more', simple.suggestions[0]?.complexity_cost_cents > report.suggestions[0].complexity_cost_cents, JSON.stringify([simple.suggestions[0]?.complexity_cost_cents, report.suggestions[0].complexity_cost_cents]));

// --- not enough history ----------------------------------------------------------
sql(`DELETE FROM transactions WHERE COALESCE(posted_at, occurred_at) < '2026-08-01'`);
const thin = await acquisitionReport(env, { months: 6 });
check('thin history lowers confidence', thin.confidence === 'low', thin.confidence);
check('and the history is reported', thin.history.months_with_data <= 2, String(thin.history.months_with_data));
if (thin.suggestions.length) {
  check('with the assumption stated on the card', thin.suggestions[0].assumptions.some((a) => a.includes('not much to go on')), JSON.stringify(thin.suggestions[0].assumptions));
}

// --- a card with no rules cannot be simulated -------------------------------------
sql(`INSERT INTO card_products (product_key, issuer, product_name, reward_type) VALUES ('norules','T','No Rules','miles')`);
const bare = (await productByKey(env, 'norules'))!;
const bareSim = await simulateProduct(env, bare, 6);
check('a card with no rates is not simulated', bareSim.projected_annual_incremental_value_cents === 0);
check('and says why rather than reporting zero as a finding', bareSim.assumptions[0].includes('no rates'), JSON.stringify(bareSim.assumptions));
check('nor is it offered as a candidate', !(await candidates(env)).some((c) => c.product_key === 'norules'));
check('and neither is a card you already hold', !(await candidates(env)).some((c) => c.product_key === 'held'));

// --- eligibility is deterministic or unknown ---------------------------------------
sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,closed_at,product_id)
     VALUES ('T','Dining Card','better','old',900000,18,'2025-01-01','2026-06-01',?)`, better.id);
const afterClose = await acquisitionReport(env, { months: 6 });
const excluded = afterClose.not_worth_it.find((n) => n.product_name === 'Dining Card');
check('a card closed recently is called ineligible', excluded !== undefined, JSON.stringify(afterClose.not_worth_it));
check('with the reason', excluded!.why.includes('recent holder'), excluded?.why);

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
