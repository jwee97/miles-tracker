/**
 * Turning points into miles.
 *
 * Almost every test here is about the same thing: this is a discrete problem,
 * not a ratio. Blocks strand points, the fee is charged once per transfer
 * rather than per point, and a promotion may or may not apply — so a plan built
 * by multiplying is confidently wrong, and wrong here means someone makes a
 * transfer they cannot undo.
 */
import { DatabaseSync } from 'node:sqlite';
import { runMigrations, runSeed } from '../src/migrate';
import { goalProgress, listGoals, reservedFor, saveGoal, setGoalStatus } from '../src/transfers/goals';
import { maximumInto, optimiseTransfer } from '../src/transfers/optimiser';
import { bonusUnits, migrateLegacyBonuses, promotionsFor, routesTo, usable } from '../src/transfers/routes';
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

sql(`DELETE FROM conversions`);
sql(`DELETE FROM programs`);
sql(`INSERT INTO programs (key,name,kind,unit) VALUES ('dbs','DBS Points','bank','points')`);
sql(`INSERT INTO programs (key,name,kind,unit) VALUES ('uni','UNI$','bank','points')`);
sql(`INSERT INTO programs (key,name,kind,unit) VALUES ('ty','Citi ThankYou','bank','points')`);
sql(`INSERT INTO programs (key,name,kind,unit) VALUES ('kf','KrisFlyer','airline','miles')`);

// DBS: 5,000 points → 10,000 miles, blocks of 5,000, $27.25 fee.
sql(`INSERT INTO conversions (from_program,to_program,from_units,to_units,fee_cents,min_block,block_increment,route,processing_days_max)
     VALUES ('dbs','kf',5000,10000,2725,5000,5000,'direct',7)`);
// UNI$: 1,000 → 2,000 miles, blocks of 1,000, $25 fee.
sql(`INSERT INTO conversions (from_program,to_program,from_units,to_units,fee_cents,min_block,block_increment,route,processing_days_max)
     VALUES ('uni','kf',1000,2000,2500,1000,1000,'direct',14)`);
// ThankYou: a poor ratio, 2,500 → 1,000, no fee.
sql(`INSERT INTO conversions (from_program,to_program,from_units,to_units,fee_cents,min_block,block_increment,route)
     VALUES ('ty','kf',2500,1000,0,2500,2500,'direct')`);

const tranche = (prog: string, points: number, expires: string | null = null) =>
  sql(`INSERT INTO balance_tranches (program_key,points,earned_at,expires_at) VALUES (?,?,'2025-01-01',?)`, prog, points, expires);

tranche('dbs', 26000);
tranche('uni', 20500);
tranche('ty', 25000);

// --- blocks strand points ---------------------------------------------------
let plan = await optimiseTransfer(env, { destination: 'kf', objective: 'maximize_destination_units' });
const dbsLeg = plan.routes.find((r) => r.from_program === 'dbs')!;
check('a transfer moves whole blocks only', dbsLeg.source_units === 25000, String(dbsLeg.source_units));
check('and says what it left behind', dbsLeg.stranded_units === 1000, String(dbsLeg.stranded_units));
check('the leftovers are not silently converted', dbsLeg.destination_units === 50000, String(dbsLeg.destination_units));
check('every route is used when maximising', plan.routes.length === 3, JSON.stringify(plan.routes.map((r) => r.from_program)));
check('and the total is the sum of them', plan.resulting_units === plan.routes.reduce((t, r) => t + r.destination_units, 0));
check('fees are added up', plan.total_fees_cents === 5225, String(plan.total_fees_cents));
check('the app never transfers anything itself', plan.assumptions.some((a) => a.includes('for you to carry out')), JSON.stringify(plan.assumptions));

check('the ceiling is reachable in one call', (await maximumInto(env, 'kf')) === plan.resulting_units);

// --- a target takes only what it needs -------------------------------------
plan = await optimiseTransfer(env, { destination: 'kf', target_units: 30000, objective: 'reach_target' });
check('a target is met', plan.resulting_units >= 30000, String(plan.resulting_units));
check('with no shortfall', plan.shortfall_units === 0);
check(
  'and it does not empty everything to get there',
  plan.routes.reduce((t, r) => t + r.source_units, 0) < 25000 + 20000 + 25000,
  JSON.stringify(plan.routes.map((r) => [r.from_program, r.source_units]))
);
check('taking the best source first', plan.routes[0].from_program === 'dbs', JSON.stringify(plan.routes.map((r) => r.from_program)));

// --- a target that cannot be met -------------------------------------------
plan = await optimiseTransfer(env, { destination: 'kf', target_units: 200000, objective: 'reach_target' });
check('an impossible target reports the shortfall', plan.shortfall_units > 0, String(plan.shortfall_units));
check('rather than pretending', plan.resulting_units < 200000);
check('and warns in words', plan.warnings.some((w) => w.includes('short of the target')), JSON.stringify(plan.warnings));

// --- fees --------------------------------------------------------------------
plan = await optimiseTransfer(env, { destination: 'kf', objective: 'minimize_fees' });
check('minimising fees puts the cheapest per mile first', plan.routes[0].from_program === 'ty', JSON.stringify(plan.routes.map((r) => [r.from_program, r.fee_cents])));

// --- expiry ------------------------------------------------------------------
sql(`DELETE FROM balance_tranches`);
tranche('dbs', 26000);
tranche('uni', 12000, '2026-11-01');
tranche('ty', 25000);

plan = await optimiseTransfer(env, { destination: 'kf', objective: 'minimize_expiry_loss' });
check('points about to lapse are moved first', plan.routes[0].from_program === 'uni', JSON.stringify(plan.routes.map((r) => r.from_program)));
check('and the plan says how many were saved', plan.expiring_points_saved === 12000, String(plan.expiring_points_saved));
check('with the reason in words', plan.routes[0].reason.includes('expire'), plan.routes[0].reason);
check('naming when', plan.routes[0].reason.includes('2026-11-01'), plan.routes[0].reason);

plan = await optimiseTransfer(env, { destination: 'kf', objective: 'maximize_destination_units' });
check('maximising does not chase expiry', plan.routes[0].from_program === 'dbs', JSON.stringify(plan.routes.map((r) => r.from_program)));

// --- promotions sit on top of routes, never inside them ---------------------
const dbsRoute = one(`SELECT id FROM conversions WHERE from_program = 'dbs'`).id;
sql(`INSERT INTO transfer_promotions (conversion_id,bonus_pct,start_at,end_at,registration_required,registered,title)
     VALUES (?,25,'2026-09-01','2026-09-30',0,0,'25% transfer bonus')`, dbsRoute);

plan = await optimiseTransfer(env, { destination: 'kf', objective: 'maximize_destination_units' });
const withBonus = plan.routes.find((r) => r.from_program === 'dbs')!;
check('a live bonus is applied', withBonus.bonus_units === 12500, String(withBonus.bonus_units));
check('on top of the plain ratio', withBonus.destination_units === 62500, String(withBonus.destination_units));
check('and the plan names it', withBonus.promotion!.title === '25% transfer bonus');
check('with the date it ends', withBonus.promotion!.ends === '2026-09-30');
check('saying the bonus has to be used by then', plan.assumptions.some((a) => a.includes('before the date shown')), JSON.stringify(plan.assumptions));

const without = await optimiseTransfer(env, { destination: 'kf', include_promotions: false });
check('a plan can be asked for without bonuses', without.routes.find((r) => r.from_program === 'dbs')!.bonus_units === 0);
check('and says so', without.assumptions.some((a) => a.includes('left out of this plan')));

// A bonus that ended is not a bonus.
sql(`UPDATE transfer_promotions SET end_at = '2026-09-10' WHERE conversion_id = ?`, dbsRoute);
plan = await optimiseTransfer(env, { destination: 'kf' });
check('an expired bonus is not counted', plan.routes.find((r) => r.from_program === 'dbs')!.bonus_units === 0, JSON.stringify(plan.routes[0]));
check('and the route ratio is untouched by it', one(`SELECT bonus_pct FROM conversions WHERE id = ?`, dbsRoute).bonus_pct === 0);
sql(`UPDATE transfer_promotions SET end_at = '2026-09-30' WHERE conversion_id = ?`, dbsRoute);

// One that needs registering may not be assumed.
sql(`UPDATE transfer_promotions SET registration_required = 1, registered = 0 WHERE conversion_id = ?`, dbsRoute);
plan = await optimiseTransfer(env, { destination: 'kf' });
check('an unregistered bonus is not counted', plan.routes.find((r) => r.from_program === 'dbs')!.bonus_units === 0);
check('but it is mentioned', plan.warnings.some((w) => w.includes('needs registering')), JSON.stringify(plan.warnings));

sql(`UPDATE transfer_promotions SET registered = 1 WHERE conversion_id = ?`, dbsRoute);
plan = await optimiseTransfer(env, { destination: 'kf' });
check('once registered it counts', plan.routes.find((r) => r.from_program === 'dbs')!.bonus_units === 12500);

// A minimum on the bonus itself.
sql(`UPDATE transfer_promotions SET min_transfer_units = 999999 WHERE conversion_id = ?`, dbsRoute);
plan = await optimiseTransfer(env, { destination: 'kf' });
check('a bonus below its own minimum does not apply', plan.routes.find((r) => r.from_program === 'dbs')!.bonus_units === 0);
sql(`DELETE FROM transfer_promotions`);

check('the best of several bonuses is chosen', bonusUnits({ bonus_pct: 10, bonus_flat_units: null } as any, 1000) === 100);
check('a flat bonus counts too', bonusUnits({ bonus_pct: null, bonus_flat_units: 500 } as any, 1000) === 500);
check('and an unregistered one is never usable', usable([{ registration_required: 1, registered: 0, bonus_pct: 50 } as any], 5000) === null);

// --- a legacy bonus written into the route ---------------------------------
sql(`UPDATE conversions SET bonus_pct = 15, bonus_until = '2026-10-31' WHERE id = ?`, dbsRoute);
const moved = await migrateLegacyBonuses(env);
check('a bonus baked into a route is moved off it', moved.moved === 1, JSON.stringify(moved));
check('onto a row with its own dates', (await promotionsFor(env, dbsRoute, '2026-09-18')).length === 1);
check('and running it again moves nothing', (await migrateLegacyBonuses(env)).moved === 0);
sql(`UPDATE conversions SET bonus_pct = 0, bonus_until = NULL WHERE id = ?`, dbsRoute);
sql(`DELETE FROM transfer_promotions`);

// --- versioned routes --------------------------------------------------------
sql(`UPDATE conversions SET effective_until = '2026-08-31' WHERE from_program = 'ty'`);
check('a route that has ended is out of the plan', (await routesTo(env, 'kf', '2026-09-18')).length === 2, String((await routesTo(env, 'kf', '2026-09-18')).length));
check('but was in force before it ended', (await routesTo(env, 'kf', '2026-08-01')).length === 3);
sql(`UPDATE conversions SET effective_until = NULL WHERE from_program = 'ty'`);

// --- processing time ---------------------------------------------------------
plan = await optimiseTransfer(env, { destination: 'kf', target_date: '2026-09-20', target_units: 10000 });
check('a route too slow for the date is flagged', plan.warnings.some((w) => w.includes('may not land by')), JSON.stringify(plan.warnings));
check('rather than silently missing it', plan.routes.length > 0);

// --- goals -------------------------------------------------------------------
const goal = await saveGoal(env, { program_key: 'kf', target_units: 85000, target_date: '2026-12-15', description: 'Japan business class' });
check('a goal can be saved', goal.id > 0);
check('and listed', (await listGoals(env)).length === 1);

const progress = await goalProgress(env, goal);
check('progress counts what is held and what could be transferred', progress.total_units > 0, JSON.stringify(progress));
check('separately', progress.held_units === 0 && progress.convertible_units > 0, JSON.stringify(progress));
check('with the days left', progress.days_left === 88, String(progress.days_left));
check('and whether it is at risk', typeof progress.at_risk === 'boolean');

tranche('kf', 54200);
const closer = await goalProgress(env, goal);
check('points already in the destination count', closer.held_units === 54200, String(closer.held_units));
check('and only the difference is planned for', closer.convertible_units >= 85000 - 54200, JSON.stringify(closer));

// Points promised to one goal are not available to another.
const second = await saveGoal(env, { program_key: 'kf', target_units: 40000 });
const held = await reservedFor(env, second.id);
check('another goal reserves the points it needs', Object.keys(held).length > 0, JSON.stringify(held));

await setGoalStatus(env, second.id, 'abandoned');
check('a goal can be set aside', (await listGoals(env)).length === 1);

// --- nothing to work with ----------------------------------------------------
sql(`DELETE FROM balance_tranches`);
plan = await optimiseTransfer(env, { destination: 'kf', target_units: 10000 });
check('with no points there is no plan', plan.routes.length === 0, JSON.stringify(plan.routes));
check('and it says why', plan.warnings.some((w) => w.includes('to transfer at all')), JSON.stringify(plan.warnings));

sql(`INSERT INTO programs (key,name,kind,unit) VALUES ('nowhere','Nowhere','airline','miles')`);
plan = await optimiseTransfer(env, { destination: 'nowhere' });
check('a programme with no route says so', plan.warnings.some((w) => w.includes('No transfer route')), JSON.stringify(plan.warnings));

let threw = false;
try {
  await optimiseTransfer(env, { destination: 'not_a_programme' });
} catch {
  threw = true;
}
check('an unknown programme is refused', threw);

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
