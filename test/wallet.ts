import { DatabaseSync } from 'node:sqlite';
import { runMigrations, runSeed } from '../src/migrate';
import {
  acceptCredits,
  defaultProgramForIssuer,
  guessProgram,
  pendingCredits,
  programForCard,
  undoCredit,
  wallet,
} from '../src/wallet';
import { daysUntil, sweepExpiredOffers } from '../src/offers';
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
  OFFER_RETENTION_DAYS: '90',
} as unknown as Env;
Date.now = () => Date.parse('2026-09-14T04:00:00Z'); // 12:00 SGT

let fails = 0;
const check = (l: string, c: boolean, d = '') => {
  if (!c) fails++;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : `  -- ${d}`}`);
};
const sql = (s: string, ...a: unknown[]) => db.prepare(s).run(...(a as any));

await runMigrations(env);
await runSeed(env);

sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,base_mpd,program_key)
     VALUES ('Citi','PremierMiles','citi_pm','pm',900000,20,'2026-01-01',1.4,'citi_ty')`);
sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,base_mpd)
     VALUES ('UOB','One Card','uob_one','one',600000,10,'2026-01-01',0)`);
const pm = (db.prepare(`SELECT * FROM cards WHERE nickname='pm'`).get() as any).id;
const one = (db.prepare(`SELECT * FROM cards WHERE nickname='one'`).get() as any).id;

// A rule that earns into a different programme than the card's default.
sql(`INSERT INTO earn_rules (card_id,category,mpd,reward_type,program_key) VALUES (?,'travel',4,'miles','krisflyer')`, pm);
const travelRule = (db.prepare(`SELECT id FROM earn_rules WHERE category='travel'`).get() as any).id;

// --- where a card's points land --------------------------------------------
check('a card names its programme', (await programForCard(env, pm)) === 'citi_ty', String(await programForCard(env, pm)));
check(
  'a rule overrides the card',
  (await programForCard(env, pm, travelRule)) === 'krisflyer',
  String(await programForCard(env, pm, travelRule))
);
check('a card without one says so', (await programForCard(env, one)) === null, '');
check('issuers map to the obvious programme', defaultProgramForIssuer('UOB') === 'uob_uni', defaultProgramForIssuer('UOB') ?? '');
check('including POSB as DBS', defaultProgramForIssuer('POSB') === 'dbs_points', '');
check('an unknown issuer is left alone', defaultProgramForIssuer('Revolut') === null, '');
check('and a guess is only offered for a programme that exists', (await guessProgram(env, 'Citi')) === 'citi_ty', '');

// --- pending credits --------------------------------------------------------
const txn = (id: number, date: string, miles: number, program: string | null, merchant: string) =>
  sql(
    `INSERT INTO transactions (card_id, amount_cents, occurred_at, merchant, expected_miles, expected_program)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    10000,
    date,
    merchant,
    miles,
    program
  );

txn(pm, '2026-09-02', 140, 'citi_ty', 'Cold Storage');
txn(pm, '2026-09-05', 400, 'krisflyer', 'Singapore Airlines');
txn(pm, '2026-08-28', 140, 'citi_ty', 'Fairprice');
txn(one, '2026-09-06', 90, null, 'Shell'); // earns, but nowhere to put it
sql(`INSERT INTO transactions (card_id, amount_cents, occurred_at, merchant, expected_cashback_cents)
     VALUES (?, 5000, '2026-09-07', 'Kopitiam', 250)`, one); // cashback earns no points

const pending = await pendingCredits(env);
check('lists what is waiting', pending.credits.length === 3, String(pending.credits.length));
check('grouped by programme', pending.by_program.length === 2, JSON.stringify(pending.by_program.map((g) => g.program_key)));
check('with the right totals', pending.by_program.find((g) => g.program_key === 'citi_ty')!.points === 280, '');
check('and a grand total', pending.total_points === 680, String(pending.total_points));
check('cashback is not a points credit', !pending.credits.some((c) => c.merchant === 'Kopitiam'), '');
check('a card with no programme is flagged, not dropped', pending.unassigned.length === 1, JSON.stringify(pending.unassigned));
check('naming the card to fix', pending.unassigned[0].nickname === 'one', pending.unassigned[0].nickname);

// --- accepting --------------------------------------------------------------
const citiIds = pending.credits.filter((c) => c.program_key === 'citi_ty').map((c) => c.id);
const accepted = await acceptCredits(env, citiIds);
check('accepting banks the points', accepted.points === 280, String(accepted.points));
check('for both purchases', accepted.accepted === 2, String(accepted.accepted));

const tranches = db.prepare(`SELECT * FROM balance_tranches WHERE program_key = 'citi_ty' ORDER BY period`).all() as any[];
check('one tranche per month, not per purchase', tranches.length === 2, JSON.stringify(tranches.map((t) => t.period)));
check('August holds its own', tranches[0].points === 140 && tranches[0].period === '2026-08', JSON.stringify(tranches[0]));
check('September holds its own', tranches[1].points === 140, JSON.stringify(tranches[1]));
check('with expiry from the programme', tranches[1].expires_at === '2031-09-01', String(tranches[1].expires_at));
check('marked as automatic', tranches[1].source === 'auto', String(tranches[1].source));

const again = await pendingCredits(env);
check('accepted credits leave the queue', again.credits.length === 1, String(again.credits.length));
check('accepting twice adds nothing', (await acceptCredits(env, citiIds)).accepted === 0, '');

// A second purchase in a month already banked extends that tranche.
txn(pm, '2026-09-09', 60, 'citi_ty', 'Guardian');
const more = await pendingCredits(env);
await acceptCredits(env, more.credits.filter((c) => c.program_key === 'citi_ty').map((c) => c.id));
const sept = db.prepare(`SELECT * FROM balance_tranches WHERE program_key='citi_ty' AND period='2026-09'`).all() as any[];
check('the month is extended, not duplicated', sept.length === 1 && sept[0].points === 200, JSON.stringify(sept));

// --- undo -------------------------------------------------------------------
const credited = db.prepare(`SELECT id FROM transactions WHERE merchant = 'Guardian'`).get() as any;
check('a credit can be taken back', await undoCredit(env, credited.id), '');
const afterUndo = db.prepare(`SELECT points FROM balance_tranches WHERE program_key='citi_ty' AND period='2026-09'`).get() as any;
check('and the points come back out', afterUndo.points === 140, String(afterUndo.points));
check('it returns to the queue', (await pendingCredits(env)).credits.some((c) => c.id === credited.id), '');
check('undoing something never credited is not an error', (await undoCredit(env, credited.id)) === false, '');

// --- the wallet view --------------------------------------------------------
sql(`INSERT INTO balance_tranches (program_key, points, earned_at, expires_at, note)
     VALUES ('krisflyer', 20000, '2026-01-01', '2026-10-15', 'manual')`);
const w = await wallet(env);
const citi = w.programs.find((p) => p.program_key === 'citi_ty')!;
check('the wallet shows a bank balance', citi.points === 280, String(citi.points));
check('in its own unit', citi.unit === 'points', citi.unit);
check('with a miles equivalent from a real route', citi.miles_equivalent !== null && citi.miles_equivalent > 0, JSON.stringify(citi));
check('and says which route that was', /to krisflyer/.test(citi.rate_note ?? ''), String(citi.rate_note));
check('unverified routes are labelled', /unverified/.test(citi.rate_note ?? ''), String(citi.rate_note));
const kf = w.programs.find((p) => p.program_key === 'krisflyer')!;
check('miles count as themselves', kf.miles_equivalent === kf.points, `${kf.miles_equivalent} vs ${kf.points}`);
check('valued at the configured rate', kf.value_cents === Math.round(kf.points * 1.5), String(kf.value_cents));
check('the total is in miles, not mixed units', w.totals.miles_equivalent > 20000, String(w.totals.miles_equivalent));
check('pending is reported alongside', w.totals.pending_points > 0, String(w.totals.pending_points));
check('expiring batches are listed', w.expiring.some((e) => e.program_key === 'krisflyer'), JSON.stringify(w.expiring));
check('with days remaining', w.expiring[0].days === 31, String(w.expiring[0].days));

// --- offers that have ended -------------------------------------------------
check('days until counts forward', daysUntil('2026-09-20', '2026-09-14') === 6, '');
check('and negative once past', daysUntil('2026-09-01', '2026-09-14') === -13, '');
check('no date means no answer', daysUntil(null, '2026-09-14') === null, '');

sql(`INSERT INTO offers (id,status,issuer,valid_until) VALUES (1,'tracked','UOB','2026-09-01')`);
sql(`INSERT INTO offers (id,status,issuer,valid_until) VALUES (2,'tracked','DBS','2026-12-31')`);
sql(`INSERT INTO offers (id,status,issuer,valid_until) VALUES (3,'applied','Citi','2026-01-01')`);
sql(`INSERT INTO offers (id,status,issuer,valid_until) VALUES (4,'tracked','HSBC','2026-03-01')`);
sql(`INSERT INTO offers (id,status,issuer) VALUES (5,'tracked','SC')`);

const sweep = await sweepExpiredOffers(env, '2026-09-14');
check('ended offers are marked expired', sweep.expired === 2, String(sweep.expired));
check('and the long-gone one is removed', sweep.deleted === 1, String(sweep.deleted));
check('the live offer is untouched', (db.prepare(`SELECT status FROM offers WHERE id=2`).get() as any).status === 'tracked', '');
check('one you applied for is your own history', (db.prepare(`SELECT status FROM offers WHERE id=3`).get() as any).status === 'applied', '');
check('one with no end date is left alone', (db.prepare(`SELECT status FROM offers WHERE id=5`).get() as any).status === 'tracked', '');
check('the recently-ended one is kept, marked', (db.prepare(`SELECT status FROM offers WHERE id=1`).get() as any).status === 'expired', '');
check('sweeping twice changes nothing', (await sweepExpiredOffers(env, '2026-09-14')).expired === 0, '');

console.log(fails ? `\n${fails} check(s) failed` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
