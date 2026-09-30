/**
 * The Trust Freedom Card, set up with the commands a person would paste and
 * checked against the numbers Trust itself publishes.
 *
 * Source: https://trustbank.sg/legal/trust-freedom-credit-card-key-facts-sheet/
 * and the Product Terms beside it, read on 30 September 2026. The rates on that
 * page are images; the numbers here were read off them, and the merchant code
 * lists are the page's own text.
 *
 * The point of this file is the worked examples. Trust prints what its own
 * card pays in three situations, and an engine that reproduces those numbers
 * to the cent — from the same commands a person types — is modelling the card
 * rather than approximating it. The Bonus Cashback example in particular
 * exercises nearly everything this card needed that the engine did not have:
 * a mode, a category picked inside it and defined by merchant code, a rate that
 * depends on the quarter's lowest month, local and foreign rates that differ, a
 * cap on the reward rather than the spend, and a quarter counted from the month
 * the card was approved.
 */
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index';
import { runMigrations, runSeed } from '../src/migrate';
import { evaluate } from '../src/rules';
import { modeComparison } from '../src/intelligence/planning/modes';
import { profileCommands, TRUST_FREEDOM } from '../src/cards/profiles';
import type { Card, Env } from '../src/types';

const said: string[] = [];
globalThis.fetch = (async (input: any, init?: any) => {
  if (String(input).includes('sendMessage')) {
    try {
      said.push(String(JSON.parse(String(init?.body ?? '{}')).text ?? ''));
    } catch {
      said.push('');
    }
  }
  return new Response('{"ok":true}', { status: 200 });
}) as typeof fetch;

const db = new DatabaseSync(':memory:');
const wrap = (sql: string, args: unknown[] = []): any => ({
  bind: (...a: unknown[]) => wrap(sql, a),
  first: async <T>() => (db.prepare(sql).get(...(args as any)) ?? null) as T,
  all: async <T>() => ({ results: db.prepare(sql).all(...(args as any)) as T[] }),
  run: async () => {
    const r = db.prepare(sql).run(...(args as any));
    return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  },
});
const env = {
  DB: { prepare: (s: string) => wrap(s), batch: async (ss: any[]) => Promise.all(ss.map((x: any) => x.all())) },
  APP_SECRET: 'test-secret',
  TELEGRAM_BOT_TOKEN: 'x',
  TELEGRAM_SECRET: 'y',
  OWNER_CHAT_ID: '1',
  TZ_OFFSET_MINUTES: '480',
  MIN_SPEND_WARN_DAYS: '7',
  POSTING_LAG_DAYS: '0',
  MILE_VALUE_CENTS: '1.5',
} as unknown as Env;

// After the quarter in Trust's example, which runs March to May.
Date.now = () => Date.parse('2026-06-15T04:00:00Z');

let fails = 0;
const check = (label: string, cond: boolean, detail = '') => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  -- ${detail}`}`);
};
const sql = (s: string, ...a: unknown[]) => db.prepare(s).run(...(a as any));

const tg = (text: string) =>
  worker.fetch(
    new Request('https://x.test/tg', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': 'y', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { chat: { id: 1 }, from: { id: 1 }, text } }),
    }),
    env
  );

await runMigrations(env);
await runSeed(env);

// Trust's example card: signed up on 1 March. Added the way the app adds one,
// then linked to its product so modes and rules have somewhere to live.
await tg('/newcard Trust|Freedom Card|freedom|39100|19|2026-03-01');
await runMigrations(env);
const card = db.prepare(`SELECT * FROM cards WHERE nickname = 'freedom'`).get() as unknown as Card;
check('the card exists and is linked to a product', !!(card as any)?.product_id, JSON.stringify(card));

// --- the commands, exactly as they would be pasted ---------------------------
// Sent in blocks of up to eight lines, which is what the bot accepts in one
// message — so this also proves the pasted-block path handles all of them.
// Generated from the same profile /cardfix applies, so the commands a person
// pastes and the repair cannot describe two different cards.
const lines = profileCommands(TRUST_FREEDOM, 'freedom').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/'));
for (let i = 0; i < lines.length; i += 8) {
  const before = said.length;
  await tg(lines.slice(i, i + 8).join('\n'));
  const reply = said.slice(before).join('\n');
  check(
    `commands ${i + 1}–${Math.min(i + 8, lines.length)} are all accepted`,
    !/Error|Unknown command|Could not|Cannot|has no mode|does not offer|Format:/i.test(reply),
    reply
  );
}

const ruleCount = (db.prepare(`SELECT COUNT(*) AS n FROM earn_rules WHERE card_id = ?`).get(card.id) as any).n;
check(`every rule was stored (${ruleCount})`, ruleCount >= 30, String(ruleCount));

const excluded = (db.prepare(`SELECT COUNT(*) AS n FROM exclusions WHERE card_id = ?`).get(card.id) as any).n;
// 3 + 9 + 1 + 6 + 10 + 3 codes, from the Product Terms' own list.
check(`every excluded code from the Product Terms is recorded (${excluded})`, excluded === 32, String(excluded));

const buy = (amount: number, opts: { mcc?: string; category?: string; foreign?: boolean; on?: string } = {}) =>
  evaluate(
    env,
    card,
    { amount_cents: amount, mcc: opts.mcc ?? '5999', category: opts.category ?? 'other', channel: null, foreign: opts.foreign ?? false },
    { on: opts.on ?? '2026-06-10' }
  );

// --- before any mode is chosen ------------------------------------------------
// "If you start using your card before making a selection, Unlimited cashback
// will apply by default."
{
  const local = await buy(10000);
  check('with nothing chosen, Unlimited cashback applies', local.cashback_cents === 150, String(local.cashback_cents));
  const foreign = await buy(10000, { foreign: true });
  check('at 0.5% on foreign spend', foreign.cashback_cents === 50, String(foreign.cashback_cents));
  const tiny = await buy(99);
  check('and nothing under S$1', tiny.cashback_cents === 0, String(tiny.cashback_cents));
}

// --- Stockback: "S$500 spend ... You earn 3% Stockback value ... S$15" ---------
await tg('/mode freedom stockback 2026-03-01');
{
  const e = await buy(50000);
  check("Trust's Stockback example: S$500 earns S$15", e.cashback_cents === 1500, String(e.cashback_cents));
  const abroad = await buy(50000, { foreign: true });
  check('and the same 3% abroad until the end of 2026', abroad.cashback_cents === 1500, String(abroad.cashback_cents));
}

// --- Miles: "awarded for every S$5 spent" -----------------------------------
await tg('/mode freedom miles 2026-06-01');
{
  const small = await buy(499);
  check('Miles: under S$5 earns nothing', small.miles === 0, String(small.miles));
  const a = await buy(999);
  const b = await buy(500);
  check('and S$9.99 earns exactly what S$5 does', a.miles === b.miles && b.miles > 0, `${a.miles} vs ${b.miles}`);
  const hundred = await buy(10000, { foreign: true });
  check('1.3 Trust Miles per S$1, local or foreign', hundred.miles === 130, String(hundred.miles));
}

// --- the mode follows the authorisation date --------------------------------
// "if you made a purchase on 30 September under Unlimited cashback mode and it
// is posted ... on 2 October after you've switched to Stockback mode, you'll
// still earn Unlimited cashback on the transaction." Here: authorised 31 May
// under Stockback, posted 2 June under Miles.
{
  const e = await evaluate(
    env,
    card,
    { amount_cents: 10000, mcc: '5999', category: 'other', channel: null, foreign: false },
    { on: '2026-06-02', authorised_on: '2026-05-31' }
  );
  check(
    'a purchase authorised before a switch earns the old mode, even posted after it',
    e.cashback_cents === 300 && e.miles === 0,
    JSON.stringify({ cashback: e.cashback_cents, miles: e.miles })
  );
}

// --- Bonus Cashback: Trust's own worked example ------------------------------
// Sign up 1 March, pick Shopping. Every month of the quarter:
//   local  — S$300 on Shopping, S$1,000 elsewhere
//   foreign — S$200 on Shopping, S$500 elsewhere
// "Total cashback earned in a quarter: S$274.50"
//   = 15% on S$1,500 of Shopping (S$225)
//   + 1% on S$3,900 local (S$39) + 0.5% on S$2,100 foreign (S$10.50)
{
  let n = 0;
  const add = (date: string, cents: number, mcc: string, category: string, foreign: boolean) =>
    sql(
      `INSERT INTO transactions (card_id, amount_cents, occurred_at, posted_at, merchant, category, mcc, is_foreign, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'posted')`,
      card.id,
      cents,
      date,
      date,
      `Example ${++n}`,
      category,
      mcc,
      foreign ? 1 : 0
    );
  for (const month of ['03', '04', '05']) {
    const d = `2026-${month}-10`;
    // 5311 is a department store: Shopping, in Trust's list. 5999 is in none of
    // them, so "elsewhere" really is outside every bonus category.
    add(d, 30000, '5311', 'shopping', false);
    add(d, 100000, '5999', 'other', false);
    add(d, 20000, '5311', 'shopping', true);
    add(d, 50000, '5999', 'other', true);
  }

  const cmp = await modeComparison(env, 'freedom', { from: '2026-03-01', to: '2026-05-31' });
  const bonus = cmp.modes.find((m) => m.mode_key === 'bonus_cashback');
  check(
    "Trust's Bonus Cashback example comes to S$274.50 exactly",
    bonus?.cashback_cents === 27450,
    JSON.stringify(bonus)
  );
  check('and the category it priced was Shopping', bonus?.category === 'shopping', String(bonus?.category));

  // The same quarter under the other modes, from the rates on the same page.
  const unlimited = cmp.modes.find((m) => m.mode_key === 'unlimited_cashback');
  check(
    'Unlimited on the same spending: 1.5% of S$3,900 + 0.5% of S$2,100 = S$69',
    unlimited?.cashback_cents === 6900,
    JSON.stringify(unlimited)
  );
  const stock = cmp.modes.find((m) => m.mode_key === 'stockback');
  check('Stockback: 3% of S$6,000 = S$180', stock?.cashback_cents === 18000, JSON.stringify(stock));
  const miles = cmp.modes.find((m) => m.mode_key === 'miles');
  check('Miles: 1.3 × 6,000 = 7,800 miles', miles?.miles === 7800, JSON.stringify(miles));
  check(
    'so on this spending Bonus Cashback is the one to have picked',
    cmp.modes[0].mode_key === 'bonus_cashback',
    cmp.modes.map((m) => `${m.mode_key}=${m.value_cents}`).join(' ')
  );
}

// --- the caps are on the REWARD ------------------------------------------------
// "Quarterly Stockback Cap: S$500" is S$500 of stock, which at 3% is S$16,666.67
// of spending — not S$500 of spending, which would have capped it at S$15.
{
  const heavy = await modeComparison(env, 'freedom', { from: '2026-03-01', to: '2026-05-31' });
  const stock = heavy.modes.find((m) => m.mode_key === 'stockback');
  check('S$6,000 of spending is nowhere near the Stockback cap', stock?.cashback_cents === 18000, JSON.stringify(stock));

  for (let i = 0; i < 3; i++) {
    sql(
      `INSERT INTO transactions (card_id, amount_cents, occurred_at, posted_at, merchant, category, mcc, is_foreign, status)
       VALUES (?, 1000000, '2026-04-20', '2026-04-20', 'Big', 'other', '5999', 0, 'posted')`,
      card.id
    );
  }
  const capped = await modeComparison(env, 'freedom', { from: '2026-03-01', to: '2026-05-31' });
  const s = capped.modes.find((m) => m.mode_key === 'stockback');
  check('but S$36,000 in a quarter stops at S$500 of stock', s?.cashback_cents === 50000, JSON.stringify(s));

  // And the 15% bonus stops at S$250 of bonus: the Shopping pick earns the
  // same S$225 + at most S$25 more, however much Shopping there is.
  sql(
    `INSERT INTO transactions (card_id, amount_cents, occurred_at, posted_at, merchant, category, mcc, is_foreign, status)
     VALUES (?, 500000, '2026-05-20', '2026-05-20', 'Mall', 'shopping', '5311', 0, 'posted')`,
    card.id
  );
  const shop = (await modeComparison(env, 'freedom', { from: '2026-03-01', to: '2026-05-31' })).modes.find(
    (m) => m.mode_key === 'bonus_cashback'
  );
  // Base on everything — S$3,900 + S$30,000 + S$5,000 local, S$2,100 foreign —
  // is S$389 + S$10.50, and the bonus adds its capped S$250 however much
  // Shopping there was: S$649.50.
  check(
    'and the 15% bonus stops at S$250 of bonus cashback',
    shop?.cashback_cents === 38900 + 1050 + 25000,
    JSON.stringify(shop)
  );
}

// --- a quarter counted from the approval month ------------------------------
// Approved in March: quarters start March, June, September, December — so a
// cap window here is not a calendar quarter.
{
  const { membershipQuarter } = await import('../src/spend');
  const q = membershipQuarter('2026-03-01', '2026-05-31');
  check('the March card’s quarter runs March to May', q.start === '2026-03-01' && q.end === '2026-05-31', JSON.stringify(q));
  check('not the calendar April to June', membershipQuarter('2026-03-01', '2026-06-01').start === '2026-06-01', '');
}

// --- a minimum that belongs to one mode --------------------------------------
{
  await tg('/mode freedom stockback 2026-06-12');
  const onStock = await buy(10000, { on: '2026-06-13' });
  check(
    'on Stockback, the Bonus Cashback minimum is not mentioned',
    !onStock.trace.some((t) => /minimum/i.test(t.check)),
    JSON.stringify(onStock.trace.map((t) => t.check))
  );
}

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
