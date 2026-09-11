import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { buildDigest, checkAlerts } from '../src/digest';
import { evaluateOffer } from '../src/eligibility';
import { utilization, requirementProgress, requirementsFor, activeCards } from '../src/spend';
import { balances, planTransfer, planRoutes, rankCards, rateIssues, ratesReview } from '../src/points';
import { statements } from '../src/sql';
import type { Env } from '../src/types';

// Minimal D1 shim over node:sqlite so the real Worker code runs unmodified.
const db = new DatabaseSync(':memory:');
for (const stmt of statements(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'))) {
  db.exec(stmt);
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
  RATE_RECHECK_DAYS: '90',
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

// --- points conversion ------------------------------------------------------
const direct = { id: 1, from_program: 'citi_ty', to_program: 'krisflyer', from_units: 25000, to_units: 10000,
  fee_cents: 2725, min_block: 25000, block_increment: 25000, route: 'direct', bonus_pct: 0, bonus_until: null, verified_at: null, source_url: null, note: null };
const krisplus = { ...direct, id: 2, from_units: 10000, to_units: 4000, fee_cents: 0, min_block: 10000, block_increment: 10000, route: 'Kris+' };

const p50 = planTransfer(50000, direct, '2026-09-11');
check('50k converts at 2.5:1', p50.miles === 20000, `got ${p50.miles}`);
check('nothing stranded on a clean multiple', p50.stranded === 0, `got ${p50.stranded}`);
check('fee is per transfer, not per point', p50.fee_cents === 2725, `got ${p50.fee_cents}`);

// The case a naive ratio gets wrong: points below a block boundary are stuck.
const p40 = planTransfer(40000, direct, '2026-09-11');
check('rounds down to whole blocks', p40.transferable === 25000 && p40.miles === 10000, `${p40.transferable}/${p40.miles}`);
check('reports the stranded remainder', p40.stranded === 15000, `got ${p40.stranded}`);

const p24 = planTransfer(24000, direct, '2026-09-11');
check('below the minimum is impossible, not pro-rated', !p24.possible && p24.miles === 0, JSON.stringify(p24.reason));
check('says how far short', /1,000 short/.test(p24.reason ?? ''), p24.reason ?? '');

// Same points, smaller blocks and no fee: strictly better.
const k40 = planTransfer(40000, krisplus, '2026-09-11');
check('smaller blocks strand less', k40.transferable === 40000 && k40.miles === 16000, `${k40.transferable}/${k40.miles}`);
check('free route costs nothing per mile', k40.cents_per_mile === 0, `got ${k40.cents_per_mile}`);

// A live promo lifts the miles out; an expired one does not.
const promo = { ...krisplus, bonus_pct: 8, bonus_until: '2026-12-31' };
check('live bonus applies', planTransfer(10000, promo, '2026-09-11').miles === 4320, 'expected 4000 + 8%');
check('expired bonus ignored', planTransfer(10000, { ...promo, bonus_until: '2026-08-01' }, '2026-09-11').miles === 4000, 'should not apply');

// Routes come back best-first from the seeded table.
sql(`INSERT INTO programs (key,name,kind,unit) VALUES ('citi_ty','Citi ThankYou','bank','points')`);
sql(`INSERT INTO programs (key,name,kind,unit,expiry_months) VALUES ('krisflyer','KrisFlyer','airline','miles',36)`);
sql(`INSERT INTO conversions (from_program,to_program,from_units,to_units,fee_cents,min_block,block_increment,route)
     VALUES ('citi_ty','krisflyer',25000,10000,2725,25000,25000,'direct')`);
sql(`INSERT INTO conversions (from_program,to_program,from_units,to_units,fee_cents,min_block,block_increment,route)
     VALUES ('citi_ty','krisflyer',10000,4000,0,10000,10000,'Kris+')`);
const routes = await planRoutes(env, 40000, 'citi_ty', 'krisflyer');
check('better route ranks first', routes[0].conversion.route === 'Kris+', routes.map((r) => r.conversion.route).join(','));

// --- balances and expiry ---
sql(`INSERT INTO balance_tranches (program_key,points,expires_at) VALUES ('citi_ty',38000,'2027-06-30')`);
sql(`INSERT INTO balance_tranches (program_key,points,expires_at) VALUES ('citi_ty',12000,'2026-10-31')`);
const bal = await balances(env, 90);
const tyBal = bal.find((b) => b.program_key === 'citi_ty')!;
check('tranches sum to the balance', tyBal.total === 50000, `got ${tyBal.total}`);
check('only the near-term tranche is flagged', tyBal.expiring_soon === 12000, `got ${tyBal.expiring_soon}`);
check('names the nearest expiry', tyBal.next_expiry === '2026-10-31', tyBal.next_expiry ?? 'null');

// --- which card to use ------------------------------------------------------
sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,base_mpd)
     VALUES ('Citi','Rewards','citi_rw','crw',500000,15,'2026-01-01',0.4)`);
sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,base_mpd)
     VALUES ('UOB','Lady''s','uob_lady','lady',500000,15,'2026-01-01',0.4)`);
const crw = (await activeCards(env)).find((c) => c.nickname === 'crw')!;
const lady = (await activeCards(env)).find((c) => c.nickname === 'lady')!;

// Citi Rewards: one $1,000 cap shared across several bonus categories.
for (const cat of ['shopping', 'online', 'groceries']) {
  sql(`INSERT INTO earn_rules (card_id,category,mpd,cap_cents,cap_group,cap_window)
       VALUES (?,?,4,100000,'tenx','statement_cycle')`, crw.id, cat);
}
sql(`INSERT INTO earn_rules (card_id,category,mpd) VALUES (?,'*',0.4)`, crw.id);
// UOB Lady's: the bonus category is chosen, so it is just a rule you edit.
sql(`INSERT INTO earn_rules (card_id,category,mpd,cap_cents,cap_group,cap_window,note)
     VALUES (?,'dining',4,100000,'chosen','calendar_month','selected category')`, lady.id);
sql(`INSERT INTO earn_rules (card_id,category,mpd) VALUES (?,'*',0.4)`, lady.id);

let ranked = await rankCards(env, 'dining', 10000, { cards: [crw, lady] });
check('chosen-category card wins on its category', ranked[0].card.nickname === 'lady', ranked.map((r) => r.card.nickname).join(','));
check('the other card falls back to base', ranked[1].effective_mpd === 0.4, `got ${ranked[1].effective_mpd}`);
check('miles computed for the purchase', ranked[0].miles === 400, `got ${ranked[0].miles}`);

ranked = await rankCards(env, 'shopping', 10000, { cards: [crw, lady] });
check('category the chosen card lacks goes to Citi', ranked[0].card.nickname === 'crw', ranked[0].card.nickname);

// A shared cap is consumed by ANY category in its group, not just one.
sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at,category) VALUES (?,?,?,?)`, crw.id, 60000, '2026-09-02', 'online');
sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at,category) VALUES (?,?,?,?)`, crw.id, 45000, '2026-09-03', 'groceries');
ranked = await rankCards(env, 'shopping', 10000, { cards: [crw] });
check('shared cap counts sibling categories', ranked[0].cap_spent_cents === 105000, `got ${ranked[0].cap_spent_cents}`);
check('exhausted cap drops to base rate', ranked[0].effective_mpd === 0.4, `got ${ranked[0].effective_mpd}`);
check('says why', /cap of \$1,000\.00 used up/.test(ranked[0].reasons.join(' ')), ranked[0].reasons.join('; '));

// Part of a purchase can earn the bonus and the rest spill past the cap.
sql(`DELETE FROM transactions WHERE card_id = ?`, crw.id);
sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at,category) VALUES (?,?,?,?)`, crw.id, 96000, '2026-09-02', 'online');
ranked = await rankCards(env, 'shopping', 10000, { cards: [crw] });
check('blends across the cap boundary', ranked[0].miles === 184, `got ${ranked[0].miles} (40 at 4mpd + 60 at 0.4)`);

// An urgent minimum can outrank a better headline rate.
ranked = await rankCards(env, 'dining', 10000, {
  cards: [crw, lady],
  minSpendNudge: [{ cardId: crw.id, remaining: 20000, daysLeft: 3 }],
});
check('urgent minimum outranks the better rate', ranked[0].card.nickname === 'crw', ranked[0].card.nickname);
check('and explains itself', /short of its minimum/.test(ranked[0].reasons.join(' ')), ranked[0].reasons.join('; '));

// The converse matters just as much: a minimum with weeks left must not
// override a materially better earn rate.
ranked = await rankCards(env, 'dining', 10000, {
  cards: [crw, lady],
  minSpendNudge: [{ cardId: crw.id, remaining: 20000, daysLeft: 45 }],
});
check('a distant minimum does not beat a better rate', ranked[0].card.nickname === 'lady', ranked[0].card.nickname);

// --- weekly rates review ----------------------------------------------------
// Seeded routes are deliberately unverified; the review must say so rather
// than let a placeholder fee be trusted silently.
let issues = await rateIssues(env);
check('unverified routes are reported', issues.some((i) => i.kind === 'never_verified'), JSON.stringify(issues.map((i) => i.kind)));

sql(`UPDATE conversions SET verified_at = '2026-09-01' WHERE id = 1`);
issues = await rateIssues(env);
check('a freshly verified route stops being flagged',
  !issues.some((i) => i.kind === 'never_verified' && i.text.includes('#1')),
  issues.filter((i) => i.kind === 'never_verified').map((i) => i.text).join(' | '));

// Checked 200 days ago, against a 90-day recheck window.
sql(`UPDATE conversions SET verified_at = '2026-02-20' WHERE id = 2`);
issues = await rateIssues(env);
check('a long-stale route is flagged for re-checking',
  issues.some((i) => i.kind === 'stale' && i.text.includes('#2')),
  issues.filter((i) => i.kind === 'stale').map((i) => i.text).join(' | '));

// A bonus ending inside a fortnight is the one that needs acting on.
sql(`UPDATE conversions SET bonus_pct = 8, bonus_until = '2026-09-20' WHERE id = 1`);
issues = await rateIssues(env);
check('a bonus ending soon outranks everything', issues[0].kind === 'bonus_ending', issues[0].kind);
sql(`UPDATE conversions SET bonus_until = '2027-06-30' WHERE id = 1`);
issues = await rateIssues(env);
check('a distant bonus is not urgent', !issues.some((i) => i.kind === 'bonus_ending'), 'should not flag');

// Expiring points, but only those actually within the horizon.
issues = await rateIssues(env);
check('near-term expiry is reported',
  issues.some((i) => i.kind === 'points_expiring' && i.text.includes('12,000')),
  issues.filter((i) => i.kind === 'points_expiring').map((i) => i.text).join(' | '));
check('a 2027 tranche is not reported yet',
  !issues.some((i) => i.kind === 'points_expiring' && i.text.includes('38,000')),
  'should be outside the 90-day horizon');

// A third route, never checked, so the review has all its groups populated.
sql(`INSERT INTO conversions (from_program,to_program,from_units,to_units,fee_cents,min_block,block_increment,route)
     VALUES ('citi_ty','krisflyer',20000,8000,2000,20000,20000,'seeded')`);
const review = await ratesReview(env);
check('review names the re-check command', /\/verified/.test(review), review.slice(0, 120));
check('review lists never-verified routes', /Never verified/.test(review), review.slice(0, 300));
check('review lists stale routes', /Worth re-checking/.test(review), review.slice(0, 300));
check('review lists expiring points', /Points expiring/.test(review), review.slice(0, 300));

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall passed');
process.exit(fails ? 1 : 0);
