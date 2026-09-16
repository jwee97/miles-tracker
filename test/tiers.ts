import { DatabaseSync } from 'node:sqlite';
import { runMigrations, runSeed } from '../src/migrate';
import { buildDigest } from '../src/digest';
import { evaluate } from '../src/rules';
import { cycleStartingIn, requirementProgress, standings, statementQuarter } from '../src/spend';
import type { Card, Env, Requirement } from '../src/types';

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
const base = {
  DB: { prepare: (s: string) => wrap(s) },
  TZ_OFFSET_MINUTES: '480',
  MILE_VALUE_CENTS: '1.5',
  MIN_SPEND_WARN_DAYS: '7',
  POSTING_LAG_DAYS: '0',
};
const env = base as unknown as Env;

let fails = 0;
const check = (l: string, c: boolean, d = '') => {
  if (!c) fails++;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : `  -- ${d}`}`);
};
const sql = (s: string, ...a: unknown[]) => db.prepare(s).run(...(a as any));
const at = (d: string) => {
  Date.now = () => Date.parse(`${d}T04:00:00Z`);
};

at('2026-03-01');
await runMigrations(env);
await runSeed(env);

// --- the quarter itself, against UOB's own worked example --------------------
// A card issued in February, closing on the 18th: Feb/Mar/Apr, then May/Jun/Jul,
// and a "month" runs 19th to 18th, not the 1st to the 31st.
{
  const q = statementQuarter('2026-02-10', 18, env);
  check('the first quarter starts in the issuance month', q.start === '2026-02-19', q.start);
  check('and runs three statement months', q.end === '2026-05-18', q.end);
  check('month 1 is 19 Feb to 18 Mar', `${q.months[0].start}..${q.months[0].end}` === '2026-02-19..2026-03-18', JSON.stringify(q.months[0]));
  check('month 2 is 19 Mar to 18 Apr', `${q.months[1].start}..${q.months[1].end}` === '2026-03-19..2026-04-18', JSON.stringify(q.months[1]));
  check('month 3 is 19 Apr to 18 May', `${q.months[2].start}..${q.months[2].end}` === '2026-04-19..2026-05-18', JSON.stringify(q.months[2]));
  check('it is quarter 1', q.index === 1, String(q.index));

  at('2026-05-20');
  const q2 = statementQuarter('2026-02-10', 18, env);
  check('the next quarter is May, Jun, Jul — not a calendar quarter', q2.start === '2026-05-19' && q2.end === '2026-08-18', `${q2.start}..${q2.end}`);
  check('and is numbered 2', q2.index === 2, String(q2.index));

  at('2027-01-05');
  const q4 = statementQuarter('2026-02-10', 18, env);
  check('a quarter may straddle the new year', q4.start === '2026-11-19' && q4.end === '2027-02-18', `${q4.start}..${q4.end}`);
  check('and keeps counting', q4.index === 4, String(q4.index));

  // A cycle is named for the month it opens in, which is what an anchor means.
  const c = cycleStartingIn(2026, 1, 31);
  check('a statement day past the end of a month clamps', c.start === '2026-03-01' && c.end === '2026-03-31', `${c.start}..${c.end}`);
}

// --- a UOB One-shaped card ---------------------------------------------------
sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,base_mpd)
     VALUES ('UOB','UOB One','uob_one','one',1000000,18,'2026-02-10',0)`);
const card = db.prepare(`SELECT * FROM cards WHERE nickname='one'`).get() as Card;

sql(
  `INSERT INTO requirements (card_id,kind,amount_cents,window,min_txns,anchor_at,per_month,prorate_first,reward_note)
   VALUES (?,'monthly_min',60000,'statement_quarter',10,'2026-02-10',1,1,'quarterly cashback')`,
  card.id
);
const req = db.prepare(`SELECT * FROM requirements WHERE card_id = ?`).get(card.id) as Requirement;
for (const [min, reward, label] of [
  [60000, 5000, '$600 a month'],
  [100000, 11000, '$1,000 a month'],
  [200000, 30000, '$2,000 a month'],
] as [number, number, string][]) {
  sql(`INSERT INTO requirement_tiers (requirement_id,min_spend_cents,reward_cents,label) VALUES (?,?,?,?)`, req.id, min, reward, label);
}

const spend = (date: string, cents: number, n = 1) => {
  for (let i = 0; i < n; i++)
    sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at,merchant) VALUES (?,?,?,'shop')`, card.id, Math.round(cents / n), date);
};

// Month 1: $700 over 10 transactions — the $600 tier, both halves of the gate.
spend('2026-03-01', 70000, 10);

at('2026-03-10');
{
  const p = await requirementProgress(env, card, req);
  check('the window is the statement month, not the quarter', `${p.window.start}..${p.window.end}` === '2026-02-19..2026-03-18', JSON.stringify(p.window));
  check('the quarter is reported around it', p.quarter?.index === 1, JSON.stringify(p.quarter?.index));
  check('all three months are shown', p.months.length === 3, String(p.months.length));
  check('this month counts its spend', p.spent_cents === 70000, String(p.spent_cents));
  check('and its transactions', p.txn_count === 10, String(p.txn_count));
  check('the monthly minimum is met', p.met, JSON.stringify({ r: p.remaining_cents, t: p.txns_remaining }));
  check('at the $600 tier, not the $1,000 one', p.tier?.min_spend_cents === 60000, JSON.stringify(p.tier));
  check('month 1 is the current one', p.months[0].state === 'current', p.months[0].state);
  check('months 2 and 3 are still ahead', p.months[1].state === 'future' && p.months[2].state === 'future', '');
  check('nothing is missed yet', p.months_missed === 0, String(p.months_missed));
  check('the quarter tracks the tier month 1 reached', p.quarter_tier?.reward_cents === 5000, JSON.stringify(p.quarter_tier));
  // Mid-quarter the months ahead are assumed to continue, which is what makes
  // this a projection — a full quarter at the tier held so far.
  check('and projects a whole quarter while it is on course', p.thirds === 3, String(p.thirds));
  check('worth the tier being held', p.projected_reward_cents === 5000, String(p.projected_reward_cents));
}

// Month 2: only $300 and 3 transactions — the month fails on both counts.
spend('2026-04-01', 30000, 3);
at('2026-04-25');
{
  const p = await requirementProgress(env, card, req);
  check('the window rolls to the next statement month', p.window.start === '2026-04-19', p.window.start);
  check('a closed month that fell short is counted as missed', p.months_missed === 1, String(p.months_missed));
  check('month 2 did not qualify', p.months[1].qualified === false, JSON.stringify(p.months[1]));
  check('and the reason is visible in its numbers', p.months[1].spent_cents === 30000 && p.months[1].txn_count === 3, JSON.stringify(p.months[1]));
}

// Month 3: $1,100 over 12 transactions. A missed month 2 breaks the run, so the
// first quarter pro-rates to a single third — of the tier month 3 reached.
spend('2026-05-01', 110000, 12);
at('2026-05-15');
{
  const p = await requirementProgress(env, card, req);
  check('month 3 qualifies', p.months[2].qualified === true, JSON.stringify(p.months[2]));
  check('the first quarter pays one third for a trailing single month', p.thirds === 1, String(p.thirds));
  check('at the tier that month reached', p.quarter_tier?.min_spend_cents === 100000, JSON.stringify(p.quarter_tier));
  check('so the projection is a third of it', p.projected_reward_cents === Math.round(11000 / 3), String(p.projected_reward_cents));
}

// --- the pro-ration the terms actually name: months 2 and 3 -----------------
{
  sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,base_mpd)
       VALUES ('UOB','One Late','uob_one2','late',1000000,18,'2026-02-10',0)`);
  const late = db.prepare(`SELECT * FROM cards WHERE nickname='late'`).get() as Card;
  sql(
    `INSERT INTO requirements (card_id,kind,amount_cents,window,min_txns,anchor_at,per_month,prorate_first)
     VALUES (?,'monthly_min',60000,'statement_quarter',10,'2026-02-10',1,1)`,
    late.id
  );
  const lr = db.prepare(`SELECT * FROM requirements WHERE card_id = ?`).get(late.id) as Requirement;
  sql(`INSERT INTO requirement_tiers (requirement_id,min_spend_cents,reward_cents) VALUES (?,60000,5000)`, lr.id);

  // Nothing in month 1; months 2 and 3 both clear the gate.
  for (let i = 0; i < 10; i++) {
    sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at,merchant) VALUES (?,7000,'2026-04-01','shop')`, late.id);
    sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at,merchant) VALUES (?,7000,'2026-05-01','shop')`, late.id);
  }
  at('2026-05-15');
  const p = await requirementProgress(env, late, lr);
  check('joining late, month 1 is missed', p.months[0].qualified === false, JSON.stringify(p.months[0].spent_cents));
  check('months 2 and 3 qualify', p.months[1].qualified && p.months[2].qualified, JSON.stringify(p.months.map((m) => m.qualified)));
  check('and the first quarter pays two thirds', p.thirds === 2, String(p.thirds));
  check('which is two thirds of the tier', p.projected_reward_cents === Math.round((5000 * 2) / 3), String(p.projected_reward_cents));
}

// --- the second quarter: all three months or nothing ------------------------
{
  // May, Jun, Jul. Two good months and a thin one pays nothing at all.
  spend('2026-06-01', 70000, 10); // month 1 of Q2 (19 May - 18 Jun)
  spend('2026-07-01', 70000, 10); // month 2 (19 Jun - 18 Jul)
  at('2026-08-15'); // month 3 (19 Jul - 18 Aug), nothing spent
  const p = await requirementProgress(env, card, req);
  check('the second quarter is quarter 2', p.quarter?.index === 2, String(p.quarter?.index));
  check('two of its months qualified', p.months.filter((m) => m.qualified).length === 2, JSON.stringify(p.months.map((m) => m.qualified)));
  check('but a later quarter does not pro-rate', p.thirds === null || p.thirds === 0, String(p.thirds));
  check('so nothing is projected', p.projected_reward_cents === 0, String(p.projected_reward_cents));

  // Fill month 3 and the whole quarter pays, at the lowest month's tier.
  spend('2026-08-01', 250000, 10);
  const q = await requirementProgress(env, card, req);
  check('all three months qualified', q.months.every((m) => m.qualified), JSON.stringify(q.months.map((m) => m.qualified)));
  check('the quarter is whole', q.thirds === 3, String(q.thirds));
  check('and pays at the LOWEST month, not the best', q.quarter_tier?.min_spend_cents === 60000, JSON.stringify(q.quarter_tier));
  check('which is the whole tier reward', q.projected_reward_cents === 5000, String(q.projected_reward_cents));
}

// --- the ordinary windows still work ----------------------------------------
{
  sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,base_mpd)
       VALUES ('DBS','Plain','dbs_plain','plain',500000,1,'2026-01-01',0.4)`);
  const plain = db.prepare(`SELECT * FROM cards WHERE nickname='plain'`).get() as Card;
  sql(`INSERT INTO requirements (card_id,kind,amount_cents,window) VALUES (?,'monthly_min',80000,'calendar_month')`, plain.id);
  const r = db.prepare(`SELECT * FROM requirements WHERE card_id = ?`).get(plain.id) as Requirement;
  at('2026-08-15');
  const p = await requirementProgress(env, plain, r);
  check('a calendar-month minimum is untouched', `${p.window.start}..${p.window.end}` === '2026-08-01..2026-08-31', JSON.stringify(p.window));
  check('and reports no quarter', p.quarter === null && p.months.length === 0, '');
  check('and no tiers', p.tiers.length === 0 && p.tier === null, '');
}

// --- the ladder IS the minimum, and the target follows the weakest month -----
//
// UOB One's real shape: S$600 / S$1,000 / S$2,000 a statement month, sustained
// across three, paying S$60 / S$100 / S$200 a quarter. The quarter pays at its
// weakest month, so once a month has closed one rung down, spending to a higher
// rung in the months after it buys nothing more that quarter.
{
  sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,base_mpd)
       VALUES ('UOB','One Real','uob_real','real',1000000,18,'2026-02-10',0)`);
  const real = db.prepare(`SELECT * FROM cards WHERE nickname='real'`).get() as Card;

  // Deliberately stored with the MIDDLE rung as the amount, which is the state
  // that reported a $900 month as a miss.
  sql(
    `INSERT INTO requirements (card_id,kind,amount_cents,window,min_txns,anchor_at,per_month,prorate_first)
     VALUES (?,'monthly_min',100000,'statement_quarter',10,'2026-02-10',1,0)`,
    real.id
  );
  const rr = db.prepare(`SELECT * FROM requirements WHERE card_id = ?`).get(real.id) as Requirement;
  for (const [min, reward] of [[60000, 6000], [100000, 10000], [200000, 20000]] as [number, number][]) {
    sql(`INSERT INTO requirement_tiers (requirement_id,min_spend_cents,reward_cents) VALUES (?,?,?)`, rr.id, min, reward);
  }

  const put = (date: string, cents: number, n = 10) => {
    for (let i = 0; i < n; i++)
      sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at,merchant) VALUES (?,?,?,'shop')`, real.id, Math.round(cents / n), date);
  };

  // Month 1 of Q3 (19 Aug - 18 Sep): $900. Short of the stored $1,000, but well
  // clear of the real minimum.
  put('2026-09-01', 90000);
  at('2026-09-10');
  {
    const p = await requirementProgress(env, real, rr);
    check('the lowest rung is the minimum, not the number stored', p.floor_cents === 60000, String(p.floor_cents));
    check('so a $900 month is met, not missed', p.met === true, JSON.stringify({ spent: p.spent_cents, remaining: p.remaining_cents }));
    check('and nothing is reported as still to spend', p.remaining_cents === 0, String(p.remaining_cents));
    check('$900 sits on the $600 rung, not the $1,000 one', p.tier?.min_spend_cents === 60000, JSON.stringify(p.tier));
    check('with nothing decided, no rung is ruled out yet', p.ceiling_tier === null, JSON.stringify(p.ceiling_tier));
    check('so no target is invented', p.target_cents === null, String(p.target_cents));
  }

  // Month 2 (19 Sep - 18 Oct): another $900. Month 1 has now closed at the
  // bottom rung, which caps the whole quarter there.
  put('2026-10-01', 90000);
  at('2026-10-10');
  {
    const p = await requirementProgress(env, real, rr);
    check('a closed month at the bottom rung caps the quarter', p.ceiling_tier?.min_spend_cents === 60000, JSON.stringify(p.ceiling_tier));
    check('and says which month did it', /month 1 closed at \$900\.00/.test(p.ceiling_reason ?? ''), String(p.ceiling_reason));
    check('the target for this month is that rung, not the one above', p.target_cents === 60000, String(p.target_cents));
    check('which is already cleared', p.to_target_cents === 0, String(p.to_target_cents));
    check('and the overshoot is named', p.beyond_target_cents === 30000, String(p.beyond_target_cents));
    check('the quarter is tracking the $600 tier', p.quarter_tier?.reward_cents === 6000, JSON.stringify(p.quarter_tier));
  }

  // Month 3 (19 Oct - 18 Nov): $100 so far. The number that matters is $600 —
  // reaching $1,000 would pay exactly the same, because month 1 already capped it.
  put('2026-11-01', 10000, 2);
  at('2026-11-05');
  {
    const p = await requirementProgress(env, real, rr);
    check('the aim in the last month is the capped rung', p.target_cents === 60000, String(p.target_cents));
    check('and what is left to it is the actionable number', p.to_target_cents === 50000, String(p.to_target_cents));
    check('the minimum still to go agrees with it', p.remaining_cents === 50000, String(p.remaining_cents));
    check('the transaction count is still short', p.txns_remaining === 8, String(p.txns_remaining));
  }

  // Finish month 3 at exactly the floor: the quarter pays the bottom tier.
  put('2026-11-06', 50000, 8);
  {
    const p = await requirementProgress(env, real, rr);
    check('all three months qualify', p.months.every((m) => m.qualified), JSON.stringify(p.months.map((m) => [m.index, m.spent_cents, m.qualified])));
    check('and the quarter pays the rung its weakest month held', p.quarter_tier?.min_spend_cents === 60000, JSON.stringify(p.quarter_tier));
    check('which is $60, not $100', p.projected_reward_cents === 6000, String(p.projected_reward_cents));
  }
}

// --- what the bot says about a capped quarter --------------------------------
{
  at('2026-10-10');
  const text = await buildDigest(env);
  check('the digest names the rung to aim at', /aim for \$600\.00 this month/.test(text), '');
  check('and why it is that one', /month 1 closed at \$900\.00/.test(text), '');
  check('and that spending higher pays no more', /still pays \$60\.00/.test(text), '');
  check('the minimum shown is the lowest rung', /\$600\.00 met/.test(text) || /\/ \$600\.00/.test(text), '');
  check('it does not urge the next rung up', !/reaches the \$1,000\.00 tier/.test(text), '');
}

// --- a quarter held at the top rung ------------------------------------------
{
  sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,base_mpd)
       VALUES ('UOB','One Big','uob_big','big',1000000,18,'2026-02-10',0)`);
  const big = db.prepare(`SELECT * FROM cards WHERE nickname='big'`).get() as Card;
  sql(
    `INSERT INTO requirements (card_id,kind,amount_cents,window,min_txns,anchor_at,per_month,prorate_first)
     VALUES (?,'monthly_min',60000,'statement_quarter',10,'2026-02-10',1,0)`,
    big.id
  );
  const br = db.prepare(`SELECT * FROM requirements WHERE card_id = ?`).get(big.id) as Requirement;
  for (const [min, reward] of [[60000, 6000], [100000, 10000], [200000, 20000]] as [number, number][]) {
    sql(`INSERT INTO requirement_tiers (requirement_id,min_spend_cents,reward_cents) VALUES (?,?,?)`, br.id, min, reward);
  }
  const put = (date: string, cents: number) => {
    for (let i = 0; i < 10; i++)
      sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at,merchant) VALUES (?,?,?,'shop')`, big.id, Math.round(cents / 10), date);
  };

  put('2026-09-01', 250000); // month 1 at the top rung
  at('2026-10-10');
  const p = await requirementProgress(env, big, br);
  check('a strong first month leaves the top rung reachable', p.ceiling_tier?.min_spend_cents === 200000, JSON.stringify(p.ceiling_tier));
  check('and the target is that rung', p.target_cents === 200000, String(p.target_cents));
  check('with the full gap to it reported', p.to_target_cents === 200000, String(p.to_target_cents));
  check('while the minimum to not lose the quarter stays the floor', p.remaining_cents === 60000, String(p.remaining_cents));
}

// --- a rate that moves with the tier -----------------------------------------
//
// UOB One pays 3.33% on groceries at the S$600 rung, 6% at S$1,000 and 8% at
// S$2,000. Which one applies is decided by the tier the QUARTER is holding, not
// by how much went on the card this month — spending into a quarter already
// capped one rung down does not buy the higher rate.
{
  sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,base_mpd)
       VALUES ('UOB','One Rates','uob_rates','rates',1000000,18,'2026-02-10',0)`);
  const rc = db.prepare(`SELECT * FROM cards WHERE nickname='rates'`).get() as Card;
  sql(
    `INSERT INTO requirements (card_id,kind,amount_cents,window,min_txns,anchor_at,per_month,prorate_first)
     VALUES (?,'monthly_min',60000,'statement_quarter',10,'2026-02-10',1,0)`,
    rc.id
  );
  const rq = db.prepare(`SELECT * FROM requirements WHERE card_id = ?`).get(rc.id) as Requirement;
  for (const [min, reward] of [[60000, 6000], [100000, 10000], [200000, 20000]] as [number, number][]) {
    sql(`INSERT INTO requirement_tiers (requirement_id,min_spend_cents,reward_cents) VALUES (?,?,?)`, rq.id, min, reward);
  }
  // One rate per rung, plus a base that never depends on one.
  for (const [rate, tier] of [[3.33, 60000], [6, 100000], [8, 200000]] as [number, number][]) {
    sql(
      `INSERT INTO earn_rules (card_id,category,mpd,reward_type,min_tier_cents) VALUES (?,'groceries',?,'cashback',?)`,
      rc.id,
      rate,
      tier
    );
  }
  sql(`INSERT INTO earn_rules (card_id,category,mpd,reward_type) VALUES (?,'*',0.3,'cashback')`, rc.id);

  const buy = { amount_cents: 10000, category: 'groceries', mcc: null, channel: null };
  const put = (date: string, cents: number) => {
    for (let i = 0; i < 10; i++)
      sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at,merchant) VALUES (?,?,?,'shop')`, rc.id, Math.round(cents / 10), date);
  };

  // Month 1 of Q3 at $900 — the bottom rung.
  put('2026-09-01', 90000);
  at('2026-09-10');
  {
    const e = await evaluate(env, rc, buy);
    check('a tier-gated rate uses the rung the card is on', e.bonus_rate === 3.33, String(e.bonus_rate));
    check('and the reason is in the trace', e.trace.some((t) => /Spend tier/.test(t.check)), JSON.stringify(e.trace.map((t) => t.check)));
  }

  // Month 2, spending $2,500. The quarter is still capped by month 1 at the
  // bottom rung, so this does NOT earn 8% however big the month is.
  put('2026-10-01', 250000);
  at('2026-10-10');
  {
    const e = await evaluate(env, rc, buy);
    check('a big month does not buy a rate the quarter cannot pay', e.bonus_rate === 3.33, String(e.bonus_rate));
    check('the higher rungs are refused with a reason', e.trace.some((t) => t.check === 'Spend tier' && t.pass === false), JSON.stringify(e.trace.filter((t) => t.check === 'Spend tier')));
  }

  // A card holding the top rung earns the top rate.
  {
    const e = await evaluate(env, rc, buy, { tier_cents: 200000 });
    check('holding a higher rung earns the higher rate', e.bonus_rate === 8, String(e.bonus_rate));
  }
  {
    const e = await evaluate(env, rc, buy, { tier_cents: 100000 });
    check('and the middle rung earns the middle rate', e.bonus_rate === 6, String(e.bonus_rate));
  }

  // A card with no ladder at all cannot claim a tier-gated rate.
  {
    const e = await evaluate(env, rc, buy, { tier_cents: null });
    check('no ladder means no tier-gated rate', e.bonus_rate === 0.3, String(e.bonus_rate));
    check('and it says why rather than silently dropping to base', e.trace.some((t) => /no tiers recorded/.test(t.detail)), JSON.stringify(e.trace.map((t) => t.detail)));
  }
}

// --- a window measured as one lump says so -----------------------------------
{
  sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,base_mpd)
       VALUES ('UOB','One Lumped','uob_lump','lump',3570000,30,'2026-01-01',0)`);
  const lc = db.prepare(`SELECT * FROM cards WHERE nickname='lump'`).get() as Card;
  // Exactly the shape that reported $1,621 against a $1,000 minimum.
  sql(
    `INSERT INTO requirements (card_id,kind,amount_cents,window,min_txns,reward_note)
     VALUES (?,'monthly_min',100000,'calendar_quarter',5,'$100 quarterly rebate')`,
    lc.id
  );
  const lq = db.prepare(`SELECT * FROM requirements WHERE card_id = ?`).get(lc.id) as Requirement;
  at('2026-09-16');
  const p = await requirementProgress(env, lc, lq);
  check('a quarter measured as one lump is flagged', p.shape_warning !== null, String(p.shape_warning));
  check('and the warning names the fix', /every statement month of a rolling quarter/.test(p.shape_warning ?? ''), String(p.shape_warning));
  check('and mentions the tiers, since there are none', /add its spend tiers/.test(p.shape_warning ?? ''), String(p.shape_warning));
  check('the window really is three months', p.window.start === '2026-07-01' && p.window.end === '2026-09-30', JSON.stringify(p.window));

  // A correctly shaped one must not be nagged.
  const fine = db.prepare(`SELECT * FROM requirements WHERE card_id = (SELECT id FROM cards WHERE nickname='real')`).get() as Requirement;
  const q = await requirementProgress(env, db.prepare(`SELECT * FROM cards WHERE nickname='real'`).get() as Card, fine);
  check('a correctly shaped minimum is left alone', q.shape_warning === null, String(q.shape_warning));
}

// --- the status report leads with minimum spend ------------------------------
{
  // A card with nothing to hit still has to render, and sorts last: there is
  // nothing about it you could act on today.
  sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,base_mpd)
       VALUES ('Amex','Free','amex_free','free',300000,5,'2026-01-01',1.2)`);

  at('2026-08-15');
  const rows = await standings(env);
  check('every open card gets a standing', rows.length >= 2, String(rows.length));
  check('the bar is the minimum, not the limit', rows.every((r) => !r.headline || r.percent <= 100), '');

  // Cards whose window is already lost are excluded: they are deliberately
  // demoted below every minimum that can still be hit.
  const unmet = rows.filter((r) => r.headline && !r.headline.met && !r.lost);
  check(
    'the card closest to missing a minimum comes first',
    unmet.every((r, i) => i === 0 || unmet[i - 1].headline!.days_left <= r.headline!.days_left),
    JSON.stringify(unmet.map((r) => [r.card.nickname, r.headline!.days_left]))
  );

  const text = await buildDigest(env);
  check('the digest names the minimum before the limit', text.indexOf('minimum') < text.indexOf('Overall balance'), '');
  check('and totals how many are met', /\*Minimums\* \d+\/\d+ met/.test(text), text.slice(-400));
  check('the limit is still reported', /balance \$[\d,]+\.\d\d of \$/.test(text), '');
  check('the quarter is drawn month by month', /M1 \$/.test(text) && /M3 \$/.test(text), text.slice(0, 600));
  check('a card with no minimum says so plainly', /no minimum to hit/.test(text), '');
  check('and sorts last, having nothing to act on', rows[rows.length - 1].card.nickname === 'free', rows.map((r) => r.card.nickname).join(','));

  // A quarter already short pays nothing whatever you spend now, so it must not
  // sit above a minimum you can still hit — that would send spend to the one
  // card where it cannot help.
  const late = rows.find((r) => r.card.nickname === 'late')!;
  const plain = rows.find((r) => r.card.nickname === 'plain')!;
  check('a quarter already short is marked lost', late.lost === true, JSON.stringify({ missed: late.headline?.months_missed, thirds: late.headline?.thirds }));
  check('and stops outranking a minimum still worth hitting', rows.indexOf(plain) < rows.indexOf(late), rows.map((r) => r.card.nickname).join(','));
  check('the digest stops warning about it', !/One Late.*⚠️/.test(text), text.slice(0, 200));
  check('and says why spending there no longer helps', /already short/.test(text), '');
}

console.log(fails ? `\n${fails} check(s) failed` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
