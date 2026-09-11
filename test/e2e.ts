import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { buildDigest, checkAlerts } from '../src/digest';
import { evaluateOffer } from '../src/eligibility';
import { utilization, requirementProgress, requirementsFor, activeCards } from '../src/spend';
import type { Env } from '../src/types';

// Minimal D1 shim over node:sqlite so the real Worker code runs unmodified.
const db = new DatabaseSync(':memory:');
const ddl = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')
  .split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');
for (const stmt of ddl.split(';')) {
  if (stmt.trim()) db.exec(stmt);
}
const wrap = (sql: string, args: unknown[] = []) => ({
  bind: (...a: unknown[]) => wrap(sql, a),
  first: async <T>() => (db.prepare(sql).get(...(args as any)) ?? null) as T,
  all: async <T>() => ({ results: db.prepare(sql).all(...(args as any)) as T[] }),
  run: async () => {
    const r = db.prepare(sql).run(...(args as any));
    return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  },
});
const env = {
  DB: { prepare: (sql: string) => wrap(sql) },
  TZ_OFFSET_MINUTES: '480',
  UTIL_THRESHOLDS: '50,80,90',
  MIN_SPEND_WARN_DAYS: '7',
  POSTING_LAG_DAYS: '3',
} as unknown as Env;

Date.now = () => Date.parse('2026-09-11T04:00:00Z'); // 12:00 SGT, 11 Sep

const sql = (s: string, ...a: unknown[]) => db.prepare(s).run(...(a as any));

let fails = 0;
const check = (label: string, cond: boolean, detail = '') => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  -- ${detail}`}`);
};

// Two cards: one nearing its limit, one with a sign-up minimum in progress.
sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at)
     VALUES ('DBS','Woman''s World','dbs_womans_world','wwmc',500000,18,'2024-05-10')`);
sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at)
     VALUES ('UOB','PRVI Miles','uob_prvi_miles','prvi',800000,5,'2026-08-20')`);
// A closed Citi card — history is what eligibility turns on.
sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,closed_at)
     VALUES ('Citi','Rewards','citi_rewards','citirw',400000,1,'2024-01-01','2026-06-15')`);

sql(`INSERT INTO requirements (card_id,kind,amount_cents,window,bonus_cap_cents,reward_note)
     VALUES (1,'monthly_min',80000,'calendar_month',100000,'4 mpd on first $1,000')`);
sql(`INSERT INTO requirements (card_id,kind,amount_cents,window,deadline,starts_at,reward_note)
     VALUES (2,'signup_min',100000,'fixed_window','2026-10-19','2026-08-20','30,000 miles')`);

// wwmc: $4,200 this cycle against a $5,000 limit = 84%, and past the $1,000 cap.
sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at) VALUES (1,420000,'2026-09-05')`);
// prvi: $380 of the $1,000 sign-up minimum.
sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at) VALUES (2,38000,'2026-09-02')`);
// Outside the wwmc cycle (which starts 2026-08-19) — must NOT be counted.
sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at) VALUES (1,99999,'2026-08-01')`);

const cards = await activeCards(env);
check('closed card excluded from active', cards.length === 2, `got ${cards.length}`);

const u = await utilization(env, cards.find((c) => c.nickname === 'wwmc')!);
check('utilization ignores prior cycle', u.balance_cents === 420000, `got ${u.balance_cents}`);
check('utilization percent', Math.round(u.percent) === 84, `got ${u.percent}`);
check('cycle window', u.cycle.start === '2026-08-19' && u.cycle.end === '2026-09-18', JSON.stringify(u.cycle));

const wwmc = cards.find((c) => c.nickname === 'wwmc')!;
const [monthly] = await requirementsFor(env, wwmc.id);
const mp = await requirementProgress(env, wwmc, monthly);
check('monthly min met', mp.met, `remaining ${mp.remaining_cents}`);
check('bonus cap flagged', mp.cap_reached && mp.over_cap_cents === 320000, `over ${mp.over_cap_cents}`);

const prvi = cards.find((c) => c.nickname === 'prvi')!;
const [signup] = await requirementsFor(env, prvi.id);
const sp = await requirementProgress(env, prvi, signup);
check('signup remaining', sp.remaining_cents === 62000, `got ${sp.remaining_cents}`);
check('signup days left', sp.days_left === 38, `got ${sp.days_left}`);
check('signup per-day', sp.per_day_cents === Math.ceil(62000 / 38), `got ${sp.per_day_cents}`);

const digest = await buildDigest(env);
console.log('\n--- digest ---\n' + digest + '\n--------------\n');
check('digest shows utilization', digest.includes('84%'));
check('digest shows sign-up gap', digest.includes('$620.00 to go'));
check('digest flags the cap', digest.includes('Bonus cap'));
check('digest shows overall', /Overall/.test(digest));

const a1 = await checkAlerts(env);
check('alert fires at 80', a1.some((m) => m.includes('80%') || m.includes('84%')), JSON.stringify(a1));
check('cap alert fires', a1.some((m) => m.includes('bonus cap')), JSON.stringify(a1));
const a2 = await checkAlerts(env);
check('alerts dedupe on second run', a2.length === 0, `got ${a2.length}`);

// Eligibility against the real card history above.
sql(`INSERT INTO offers (status,issuer,product,product_key) VALUES ('tracked','Citi','Rewards','citi_rewards')`);
sql(`INSERT INTO offer_rules (offer_id,predicate,quote) VALUES (1,'{"type":"no_issuer_card_within_months","issuer":"Citi","months":12}','no principal Citi card in the past 12 months')`);
sql(`INSERT INTO offer_rules (offer_id,predicate,quote) VALUES (1,'{"type":"min_income","amount_cents":3000000,"period":"year"}','minimum annual income of S$30,000')`);
const e1 = await evaluateOffer(env, 1);
check('closed-4-months-ago Citi card blocks', e1.verdict === 'not_eligible', JSON.stringify(e1.rules.map((r) => r.reason)));
check('names the date you become eligible', e1.rules[0].reason.includes('2027-06-15'), e1.rules[0].reason);

sql(`INSERT INTO offers (status,issuer,product,product_key) VALUES ('tracked','HSBC','Revolution','hsbc_revolution')`);
sql(`INSERT INTO offer_rules (offer_id,predicate,quote) VALUES (2,'{"type":"new_to_bank","issuer":"HSBC"}','new-to-bank customers only')`);
sql(`INSERT INTO offer_rules (offer_id,predicate,quote) VALUES (2,'{"type":"min_income","amount_cents":3000000,"period":"year"}','income requirement')`);
const e2 = await evaluateOffer(env, 2);
check('unknown clause downgrades to review, not eligible', e2.verdict === 'needs_review', e2.verdict);

sql(`INSERT INTO offers (status) VALUES ('tracked')`);
const e3 = await evaluateOffer(env, 3);
check('offer with no rules is needs_review', e3.verdict === 'needs_review', e3.verdict);

// --- quarterly minimum with a transaction count (UOB One shape) ---
sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at)
     VALUES ('UOB','One Card','uob_one','uobone',600000,10,'2026-01-15')`);
const uob = (await activeCards(env)).find((c) => c.nickname === 'uobone')!;
sql(`INSERT INTO requirements (card_id,kind,amount_cents,window,min_txns,reward_note)
     VALUES (${uob.id},'monthly_min',100000,'calendar_quarter',5,'$100 quarterly rebate')`);

// Four transactions totalling $1,200 — amount cleared, count is not.
for (const [amt, d] of [[30000,'2026-07-05'],[40000,'2026-08-02'],[30000,'2026-09-01'],[20000,'2026-09-09']] as [number,string][]) {
  sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at) VALUES (?,?,?)`, uob.id, amt, d);
}
// Dated inside Q2, so it must fall outside the current quarter's window.
sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at) VALUES (?,?,?)`, uob.id, 50000, '2026-06-30');

const [qreq] = await requirementsFor(env, uob.id);
const qp = await requirementProgress(env, uob, qreq);
check('quarter window is Q3', qp.window.start === '2026-07-01' && qp.window.end === '2026-09-30', JSON.stringify(qp.window));
check('prior quarter excluded', qp.spent_cents === 120000, `got ${qp.spent_cents}`);
check('amount satisfied', qp.remaining_cents === 0, `got ${qp.remaining_cents}`);
check('txn count tracked', qp.txn_count === 4 && qp.txns_remaining === 1, `${qp.txn_count}/${qp.txns_required}`);
check('NOT met while a txn is short', qp.met === false, 'met should require both halves');

sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at) VALUES (?,?,?)`, uob.id, 1500, '2026-09-10');
const qp2 = await requirementProgress(env, uob, qreq);
check('met once both halves clear', qp2.met === true && qp2.txns_remaining === 0, `${qp2.txn_count} txns`);

const d2 = await buildDigest(env);
check('digest shows the txn fraction', /5\/5 txns|4\/5 txns/.test(d2), 'no txn fraction in digest');

// --- cap with no minimum (Citi Rewards shape) ---
sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at)
     VALUES ('Citi','Rewards','citi_rewards_2','citirw2',500000,15,'2026-02-01')`);
const citi = (await activeCards(env)).find((c) => c.nickname === 'citirw2')!;
sql(`INSERT INTO requirements (card_id,kind,amount_cents,window,bonus_cap_cents,reward_note)
     VALUES (${citi.id},'monthly_min',0,'statement_cycle',100000,'4 mpd, capped')`);
sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at) VALUES (?,?,?)`, citi.id, 110000, '2026-09-05');
const [creq] = await requirementsFor(env, citi.id);
const cp = await requirementProgress(env, citi, creq);
check('zero-minimum requirement is met immediately', cp.met === true, `remaining ${cp.remaining_cents}`);
check('cap still flags past the ceiling', cp.cap_reached && cp.over_cap_cents === 10000, `over ${cp.over_cap_cents}`);

// --- backdating lands in the right window ---
sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at)
     VALUES ('HSBC','Revolution','hsbc_rev','rev',300000,20,'2026-03-01')`);
const rev = (await activeCards(env)).find((c) => c.nickname === 'rev')!;
sql(`INSERT INTO requirements (card_id,kind,amount_cents,window) VALUES (${rev.id},'monthly_min',50000,'calendar_month')`);
const [rreq] = await requirementsFor(env, rev.id);

// Dated last month: outside the calendar-month window, so it must not count.
sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at) VALUES (?,?,?)`, rev.id, 60000, '2026-08-20');
const back = await requirementProgress(env, rev, rreq);
check('backdated outside the window does not count', back.spent_cents === 0, `got ${back.spent_cents}`);

// Dated earlier this month: inside the window, so it must count.
sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at) VALUES (?,?,?)`, rev.id, 60000, '2026-09-02');
const fwd = await requirementProgress(env, rev, rreq);
check('backdated inside the window counts', fwd.spent_cents === 60000 && fwd.met, `got ${fwd.spent_cents}`);

// Utilization uses the statement cycle instead: for statement day 20 on 11 Sep
// the cycle runs 21 Aug - 20 Sep, so the 20 Aug entry sits one day outside it.
const ru = await utilization(env, rev);
check('cycle starts the day after the statement closes', ru.cycle.start === '2026-08-21', ru.cycle.start);
check('entry one day before the cycle is excluded', ru.balance_cents === 60000, `got ${ru.balance_cents}`);

// Move it inside the cycle and it counts.
sql(`UPDATE transactions SET occurred_at = '2026-08-21' WHERE card_id = ? AND occurred_at = '2026-08-20'`, rev.id);
const ru2 = await utilization(env, rev);
check('entry on the cycle start is included', ru2.balance_cents === 120000, `got ${ru2.balance_cents}`);

// --- posting date vs transaction date --------------------------------------
// Banks judge windows on when a transaction POSTS. Statement day 20 on 11 Sep
// means the cycle runs 21 Aug - 20 Sep.
sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at)
     VALUES ('SC','Journey','sc_journey','sj',400000,20,'2026-01-01')`);
const sj = (await activeCards(env)).find((c) => c.nickname === 'sj')!;

// Made inside the cycle, but posted after it closed: belongs to the NEXT cycle.
sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at,posted_at) VALUES (?,?,?,?)`,
    sj.id, 20000, '2026-09-19', '2026-09-22');
// Made before the cycle opened, but posted inside it: belongs to THIS cycle.
sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at,posted_at) VALUES (?,?,?,?)`,
    sj.id, 30000, '2026-08-19', '2026-08-25');
// Ordinary confirmed spend, comfortably inside.
sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at,posted_at) VALUES (?,?,?,?)`,
    sj.id, 50000, '2026-09-01', '2026-09-03');

const su = await utilization(env, sj);
check('posted-after is excluded from the cycle', su.balance_cents === 80000, `got ${su.balance_cents}`);
check('posted-into is included in the cycle', su.balance_cents === 80000, 'the 19 Aug entry should count via posted_at');
check('nothing at risk when all are confirmed', su.at_risk_cents === 0, `got ${su.at_risk_cents}`);

// Unconfirmed spend within the posting lag of the cycle end is at risk.
sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at) VALUES (?,?,?)`, sj.id, 15000, '2026-09-19');
const su2 = await utilization(env, sj);
check('unconfirmed near the boundary is at risk', su2.at_risk_cents === 15000, `got ${su2.at_risk_cents}`);
check('at-risk still counts toward the total', su2.balance_cents === 95000, `got ${su2.balance_cents}`);

// Unconfirmed spend well inside the window is NOT at risk.
sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at) VALUES (?,?,?)`, sj.id, 10000, '2026-09-05');
const su3 = await utilization(env, sj);
check('unconfirmed mid-window is not at risk', su3.at_risk_cents === 15000, `got ${su3.at_risk_cents}`);

// --- a minimum met only by spend that might not post ---
sql(`INSERT INTO requirements (card_id,kind,amount_cents,window) VALUES (${sj.id},'monthly_min',100000,'statement_cycle')`);
const [sreq] = await requirementsFor(env, sj.id);
const jp = await requirementProgress(env, sj, sreq);
check('total clears the minimum', jp.spent_cents === 105000 && jp.met, `spent ${jp.spent_cents}`);
check('confirmed alone does not', jp.confirmed_cents === 90000, `confirmed ${jp.confirmed_cents}`);
check('flagged as met only with at-risk spend', jp.met_only_with_at_risk === true, 'should warn');

const riskDigest = await buildDigest(env);
check('digest warns instead of showing met', /met only if/.test(riskDigest), 'no at-risk warning in digest');
check('digest names the confirmed shortfall', /spend \$100\.00 more to be safe/.test(riskDigest), riskDigest.slice(0, 200));

// Confirming a late posting date moves the spend out of this window.
sql(`UPDATE transactions SET posted_at = '2026-09-23' WHERE card_id = ? AND occurred_at = '2026-09-19' AND posted_at IS NULL`, sj.id);
const jp2 = await requirementProgress(env, sj, sreq);
check('confirming a late post removes it', jp2.spent_cents === 90000 && !jp2.met, `spent ${jp2.spent_cents}`);
check('nothing at risk once confirmed', jp2.at_risk_cents === 0, `got ${jp2.at_risk_cents}`);

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall passed');
process.exit(fails ? 1 : 0);
