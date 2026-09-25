/**
 * The Action Centre.
 *
 * What is being tested is the ordering as much as the contents. A list that
 * shows the right seven things in the wrong order is worse than useless on a
 * home screen: the one deadline that matters tonight ends up below forty rows
 * of housekeeping, and the screen quietly trains you to ignore it.
 */
import { DatabaseSync } from 'node:sqlite';
import { actionCentre, CAP_NEARLY_GONE_PCT, EXPIRY_WARN_DAYS } from '../src/actions';
import { runMigrations, runSeed } from '../src/migrate';
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
  UTIL_THRESHOLDS: '50,80,90',
} as unknown as Env;

let fails = 0;
const check = (l: string, c: boolean, d = '') => {
  if (!c) fails++;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : `  -- ${d}`}`);
};
const sql = (s: string, ...a: unknown[]) => db.prepare(s).run(...(a as any));
Date.now = () => Date.parse('2026-09-18T04:00:00Z'); // 18 Sep 2026, noon SGT

await runMigrations(env);
await runSeed(env);

const card = (issuer: string, product: string, key: string, nick: string, day = 28) =>
  sql(
    `INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,base_mpd)
     VALUES (?,?,?,?,900000,?, '2025-01-01', 0.4)`,
    issuer,
    product,
    key,
    nick,
    day
  );

card('UOB', 'One Card', 'uob_one', 'one');
card('Citi', 'Rewards Card', 'citi_rewards', 'crw');
card('DBS', "Woman's World Card", 'dbs_womans_world', 'wwmc');

// A monthly minimum, part-met, closing at the end of September.
sql(`INSERT INTO requirements (card_id,kind,amount_cents,window,reward_note)
     VALUES (1,'monthly_min',60000,'calendar_month','$60 cashback')`);
sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at) VALUES (1,43600,'2026-09-04')`);

// A sign-up minimum with a deadline a fortnight out.
sql(`INSERT INTO requirements (card_id,kind,amount_cents,window,deadline,starts_at,reward_note)
     VALUES (2,'signup_min',100000,'fixed_window','2026-10-02','2026-08-01','30,000 miles')`);
sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at) VALUES (2,68800,'2026-08-20')`);

// A bonus cap with a sliver left.
sql(`INSERT INTO requirements (card_id,kind,amount_cents,window,bonus_cap_cents,reward_note)
     VALUES (3,'monthly_min',0,'calendar_month',100000,'4 mpd on the first $1,000')`);
sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at) VALUES (3,91700,'2026-09-02')`);

const items = await actionCentre(env);
const kinds = items.map((i) => i.kind);

check('a minimum still short is an action', kinds.includes('minimum_spend'));
check('so is a sign-up deadline', kinds.includes('signup_deadline'));
check('and a cap about to run out', kinds.includes('cap_nearly_gone'));

const min = items.find((i) => i.kind === 'minimum_spend')!;
check('the minimum says what to spend', min.amount_cents === 16400, String(min.amount_cents));
check('in the words a person would use', min.title === 'Spend another $164.00 on one', min.title);
check('and by when', min.deadline === '2026-09-30', String(min.deadline));
check('with the days left', min.days_left === 12, String(min.days_left));

const signup = items.find((i) => i.kind === 'signup_deadline')!;
check('the sign-up bonus says what it pays', signup.detail.includes('30,000 miles'));
check('and what is still needed', signup.amount_cents === 31200, String(signup.amount_cents));

const cap = items.find((i) => i.kind === 'cap_nearly_gone')!;
check('a nearly-spent cap says how little is left', cap.amount_cents === 8300, String(cap.amount_cents));
check('and that it is a stop, not a target', cap.detail.includes('base rate'));
check(
  'a cap with room to spare is not an action',
  (100000 - 91700) / 100000 <= CAP_NEARLY_GONE_PCT / 100
);

check(
  'a deadline outranks an allowance',
  kinds.indexOf('minimum_spend') < kinds.indexOf('cap_nearly_gone'),
  kinds.join(',')
);
check(
  'and a minimum outranks a sign-up bonus with longer to run',
  kinds.indexOf('minimum_spend') < kinds.indexOf('signup_deadline'),
  kinds.join(',')
);

// --- what a met minimum does, which is nothing ---------------------------
sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at) VALUES (1,20000,'2026-09-17')`);
const after = await actionCentre(env);
check(
  'a minimum that is met stops being an action',
  !after.some((i) => i.kind === 'minimum_spend' && i.subject === 'one'),
  after.map((i) => `${i.kind}:${i.subject}`).join(',')
);

// --- the housekeeping queues --------------------------------------------
sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at,merchant,needs_review)
     VALUES (1,1200,'2026-09-16','Kopitiam',1)`);
sql(`INSERT INTO transactions (card_id,amount_cents,occurred_at,merchant,needs_review)
     VALUES (1,1800,'2026-09-16','Toast Box',1)`);

const withQueues = await actionCentre(env);
const review = withQueues.find((i) => i.kind === 'unreviewed_import')!;
check('unreviewed rows are one job, not many', review.count === 2, String(review?.count));
check('and they say so in one line', review.title === '2 transactions have no category', review.title);

const codes = withQueues.find((i) => i.kind === 'unknown_code')!;
check('merchants with no code are counted once each', codes.count === 2, String(codes?.count));

const q = withQueues.map((i) => i.kind);
check(
  'housekeeping never outranks a deadline',
  q.indexOf('unreviewed_import') > q.indexOf('signup_deadline'),
  q.join(',')
);
check('nor does an unknown code', q.indexOf('unknown_code') > q.indexOf('cap_nearly_gone'), q.join(','));

// A question the pipeline queued is named by what it is asking, because
// "5 things need review" says nothing about whether it is worth opening.
sql(`INSERT INTO review_items (transaction_id, reason, detail) VALUES
     ((SELECT MAX(id) FROM transactions), 'possible_duplicate', 'same card and amount, 1 day apart')`);
const withReview = await actionCentre(env);
const asked = withReview.find((i) => i.kind === 'unreviewed_import' && i.subject === 'Review')!;
check('an open question is an action', asked !== undefined);
check('named by what it is asking', asked.detail.includes('counted twice'), asked?.detail);
check('and a possible duplicate is not merely watched', asked.urgency === 'soon', asked?.urgency);

// An ignored merchant is a decision already taken, not an outstanding job.
sql(`INSERT INTO merchant_ignored (merchant) VALUES ('Toast Box')`);
const afterIgnore = await actionCentre(env);
check(
  'an ignored merchant is not still asking to be coded',
  afterIgnore.find((i) => i.kind === 'unknown_code')!.count === 1
);

// --- points that expire ---------------------------------------------------
sql(`INSERT INTO balance_tranches (program_key,points,earned_at,expires_at)
     VALUES ('krisflyer',14000,'2023-11-01','2026-10-10')`);
sql(`INSERT INTO balance_tranches (program_key,points,earned_at,expires_at)
     VALUES ('krisflyer',9000,'2025-01-01','2029-01-01')`);

const withExpiry = await actionCentre(env);
const exp = withExpiry.filter((i) => i.kind === 'points_expiring');
check('points close to expiring are an action', exp.length === 1, String(exp.length));
check('with the number and the date', exp[0].title.includes('14,000') && exp[0].title.includes('2026-10-10'));
check('and what to do about it', exp[0].detail.includes('Transferring out'));
check(
  'points years away are not',
  EXPIRY_WARN_DAYS < 800 && !exp.some((i) => i.title.includes('9,000'))
);

const order = withExpiry.map((i) => i.kind);
check('an expiry sits below the card deadlines', order.indexOf('points_expiring') > order.indexOf('signup_deadline'));
check('and above the housekeeping', order.indexOf('points_expiring') < order.indexOf('unreviewed_import'));

// --- a card whose quarter is already lost --------------------------------
// Nothing spent now can bring that window's bonus back, so it is not an action
// however short it is — sending spend there is the one recommendation that
// cannot possibly pay.
sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at)
     VALUES ('UOB','Lady''s Card','uob_ladys','lady',900000,28,'2026-01-28')`);
sql(`INSERT INTO requirements (card_id,kind,amount_cents,window,per_month,anchor_at,reward_note)
     VALUES (4,'monthly_min',60000,'statement_quarter',1,'2026-01-28','tiered cashback')`);
const lost = await actionCentre(env);
check(
  'a quarter already lost is not urged on',
  !lost.some((i) => i.subject === 'lady' && i.kind === 'minimum_spend'),
  lost.filter((i) => i.subject === 'lady').map((i) => i.kind).join(',')
);

// --- rates nobody has checked ---------------------------------------------
// The recommendation layer rests on these numbers, so an unchecked one is
// worth a line — and it is the last line, because it is already costing the
// recommendation its confidence where that actually matters.
sql(`UPDATE cards SET product_id = (SELECT id FROM card_products WHERE product_key = 'uob_one') WHERE nickname = 'one'`);
const withStale = await actionCentre(env);
const rates = withStale.find((i) => i.kind === 'stale_rules');
check('a card whose rates were never checked is reported', rates !== undefined, withStale.map((i) => i.kind).join(','));
check('naming the card it affects', rates!.detail.includes('one'), rates?.detail);
check('and it sits below everything actionable', withStale[withStale.length - 1].kind === 'stale_rules', withStale.map((i) => i.kind).join(','));

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
