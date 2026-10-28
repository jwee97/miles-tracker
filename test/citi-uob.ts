/**
 * The Citi Rewards Card and the UOB One Card, set up as they were found in
 * production and put right with /cardfix.
 *
 * Sources:
 *   Citi  — 10X Rewards Promotion Terms and Conditions, effective 1 April 2024
 *   UOB   — Terms and Conditions Governing UOB One Card, revised 1 July 2025
 *
 * What was wrong, in the order it was found:
 *   Citi  entered in points (10 and 1) where every other card is in miles, so it
 *         looked two and a half times better than the same 4 mpd elsewhere; the
 *         shopping rate paid on any purchase called "shopping" where Citi pays
 *         on a list of clothing and department-store codes; online spend had no
 *         travel exclusion; and a junk minimum sat on a card with none.
 *   UOB   paid the Tier 3 rate (6.67%) whatever the quarter's tier, for a card
 *         that has not held Tier 3; counted 5 transactions where UOB now needs
 *         10; and recorded none of UOB's excluded codes.
 */
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index';
import { runMigrations, runSeed } from '../src/migrate';
import { evaluate } from '../src/rules';
import { HELP } from '../src/extraction';
import { CITI_REWARDS, UOB_ONE, profileCommands, profileFor } from '../src/cards/profiles';
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
  DB: { prepare: (s: string) => wrap(s), batch: async (ss: any[]) => Promise.all(ss.map((x) => x.all())) },
  APP_SECRET: 'test-secret',
  TELEGRAM_BOT_TOKEN: 'x',
  TELEGRAM_SECRET: 'y',
  OWNER_CHAT_ID: '1',
  TZ_OFFSET_MINUTES: '480',
  MIN_SPEND_WARN_DAYS: '7',
  POSTING_LAG_DAYS: '0',
  MILE_VALUE_CENTS: '1.5',
} as unknown as Env;
Date.now = () => Date.parse('2026-10-28T04:00:00Z');

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
const last = () => said[said.length - 1] ?? '';
const n = (q: string, ...a: unknown[]) => Number((db.prepare(q).get(...(a as any)) as any).n);
const cardRow = (nick: string) => db.prepare(`SELECT * FROM cards WHERE nickname = ?`).get(nick) as unknown as Card;

await runMigrations(env);
await runSeed(env);

check('the catalogue key and the form key both find Citi', profileFor('citi_rewards') === CITI_REWARDS && profileFor('citi_rewards_card') === CITI_REWARDS, '');
check('and UOB', profileFor('uob_one') === UOB_ONE && profileFor('uob_one_card') === UOB_ONE, '');

// ======================================================================= Citi
// As found: points instead of miles, no code lists, a junk minimum.
await tg('/newcard Citi|Rewards|citirw|36180|15|2025-03-02');
await runMigrations(env);
await tg('/setprogram citirw citi_ty');
await tg('/addearn citirw shopping 10 cap 1000 group 10x');
await tg('/addearn citirw online 10 cap 1000 group 10x');
await tg('/addearn citirw * 1');
sql(
  `INSERT INTO requirements (card_id, kind, amount_cents, window, active) VALUES (?, 'monthly_min', 0, 'statement_cycle10004 mpd on first $1,000', 1)`,
  cardRow('citirw').id
);

{
  const citi = cardRow('citirw');
  const at = (cents: number, o: { mcc?: string | null; category?: string; channel?: 'online' | 'offline' | null; on?: string }) =>
    evaluate(
      env,
      citi,
      { amount_cents: cents, mcc: o.mcc === undefined ? null : o.mcc, category: o.category ?? 'shopping', channel: o.channel ?? null, foreign: false },
      { on: o.on ?? '2026-10-10' }
    );

  const before = await at(10000, { mcc: '5732', category: 'shopping', channel: 'offline' });
  check('before: in-store electronics (5732) is paid 10 "miles" a dollar, which Citi does not pay', before.miles === 1000, String(before.miles));

  await tg('/cardfix citirw');
  const preview = last();
  check('the preview says three rules and no minimum spend', /3 rules added/.test(preview) && /no minimum spend/.test(preview), preview);
  check('and lists what it does not model', /Not modelled/.test(preview) && /mobile wallet/.test(preview), preview);
  await tg('/cardfix citirw confirm');
  check('it applies', /\*Done:\*/.test(last()), last());

  const rules = db.prepare(`SELECT * FROM earn_rules WHERE card_id = ? AND active = 1 ORDER BY mpd DESC, category`).all(citi.id) as any[];
  check('the card holds exactly three rules', rules.length === 3, String(rules.length));
  check('in miles: 4, 4 and 0.4', rules.map((r) => r.mpd).join(',') === '4,4,0.4', rules.map((r) => r.mpd).join(','));
  check('each rounding down to S$1, as Citi does per purchase', rules.every((r) => r.earn_step_cents === 100), JSON.stringify(rules.map((r) => r.earn_step_cents)));
  const shop = rules.find((r) => r.category === 'shopping');
  const online = rules.find((r) => r.category === 'online');
  check("shopping is Citi's list of clothing, shoe, luggage and department-store codes", shop.mcc_include === '5311,5611,5621,5631,5641,5651,5655,5661,5691,5699,5948', shop.mcc_include);
  check('online needs paying online, and never pays on travel', online.channel === 'online' && /3000-3999/.test(online.mcc_exclude) && /4722/.test(online.mcc_exclude), JSON.stringify(online));
  check('one S$1,000 cap, shared, on the statement month', shop.cap_cents === 100000 && online.cap_cents === 100000 && shop.cap_group === online.cap_group && shop.cap_window === 'statement_cycle', JSON.stringify([shop, online]));
  const fixed = db.prepare(`SELECT base_mpd, program_key FROM cards WHERE id = ?`).get(citi.id) as any;
  check('base 0.4, and the ThankYou programme it pays into is left alone', fixed.base_mpd === 0.4 && fixed.program_key === 'citi_ty', JSON.stringify(fixed));
  check('the junk minimum is gone', n(`SELECT COUNT(*) AS n FROM requirements WHERE card_id = ? AND active = 1`, citi.id) === 0, '');

  // What the old rules paid is no longer paid.
  const e = await at(10000, { mcc: '5732', category: 'shopping', channel: 'offline' });
  check('in-store electronics now earns only the base: 0.4 mpd', e.miles === 40, String(e.miles));
  const unknown = await at(10000, { mcc: null, category: 'shopping', channel: 'offline' });
  check('a shopping purchase with no merchant code is not assumed eligible', unknown.miles === 40, String(unknown.miles));
  const dept = await at(10000, { mcc: '5311', category: 'shopping', channel: 'offline', on: '2026-11-10' });
  check('a department store (5311) earns 4 mpd', dept.miles === 400, String(dept.miles));
  const web = await at(10000, { mcc: '5399', category: 'online', channel: 'online', on: '2026-11-10' });
  check('online retail earns 4 mpd', web.miles === 400, String(web.miles));
  const flight = await at(10000, { mcc: '4511', category: 'online', channel: 'online', on: '2026-11-10' });
  check('an airline bought online is travel: base only', flight.miles === 40, String(flight.miles));
  const hotel = await at(10000, { mcc: '7011', category: 'online', channel: 'online', on: '2026-11-10' });
  check('so is a hotel (7011)', hotel.miles === 40, String(hotel.miles));
  const tapped = await at(10000, { mcc: '5399', category: 'online', channel: 'offline', on: '2026-11-10' });
  check('the online rate needs the purchase to be online', tapped.miles === 40, String(tapped.miles));
  check('S$10.99 earns on S$10: 40 miles', (await at(1099, { mcc: '5311', on: '2026-11-10' })).miles === 40, '');
  check('and 99 cents earns nothing', (await at(99, { mcc: '5311', on: '2026-11-10' })).miles === 0, '');

  // Citi's own worked example, in one statement month:
  //   Department stores S$800.99 → 800 base + 7,200 bonus points
  //   Shoe stores       S$550.24 → 550 base + 4,950 bonus points, of which the cap lets through 1,800
  //   Total 1,350 base + 9,000 bonus (capped from 12,150) = 10,350 points = 4,140 miles at 0.4.
  let k = 0;
  const log = (cents: number, mcc: string) =>
    sql(
      `INSERT INTO transactions (card_id, amount_cents, occurred_at, posted_at, merchant, category, mcc, channel, is_foreign, status)
       VALUES (?, ?, '2026-12-05', '2026-12-05', ?, 'shopping', ?, 'offline', 0, 'posted')`,
      citi.id,
      cents,
      `Example ${++k}`,
      mcc
    );
  const first = await at(80099, { mcc: '5311', channel: 'offline', on: '2026-12-05' });
  log(80099, '5311');
  const second = await at(55024, { mcc: '5661', channel: 'offline', on: '2026-12-05' });
  const total = first.miles + second.miles;
  check('Citi\'s department store purchase earns 800 × 4 = 3,200 miles', first.miles === 3200, String(first.miles));
  // The cap counts the ledger's cents (S$800.99), where Citi counts the S$800 it
  // paid on, so the engine lets 99 cents more through than Citi does.
  check(
    "and the month comes to Citi's 10,350 points, 4,140 miles, to within the cents the cap counts",
    Math.abs(total - 4140) <= 5,
    `${first.miles} + ${second.miles} = ${total}`
  );
  check('the second purchase is split at the cap', second.bonus_portion_cents > 0 && second.base_portion_cents > 0, JSON.stringify([second.bonus_portion_cents, second.base_portion_cents]));
}

// ======================================================================== UOB
// As found: Tier 3 rates on everything, 5 transactions, no exclusions.
await tg('/newcard UOB|One Card|uobone|35700|31|2025-03-06');
await runMigrations(env);
for (const [cat, rate] of [['transport', 6.67], ['dining', 6.67], ['online', 6.67], ['groceries', 4.67], ['fuel', 1.67], ['utilities', 1]] as const) {
  await tg(`/addearn uobone ${cat} ${rate}% cap 1800 group selected window statement_cycle`);
}
await tg('/addearn uobone * 0.03%');
await tg('/req uobone|monthly_min|600|statement_quarter|||5|$60 quarterly rebate');
await tg('/tiers uobone 600=60 1000=100 2000=200');

{
  const uob = cardRow('uobone');
  const at = (cents: number, o: { mcc?: string | null; category: string; tier?: number | null }) =>
    evaluate(
      env,
      uob,
      { amount_cents: cents, mcc: o.mcc === undefined ? null : o.mcc, category: o.category, channel: null, foreign: false },
      { on: '2026-10-10', tier_cents: o.tier }
    );

  const before = await at(10000, { category: 'transport', tier: 0 });
  check('before: with no tier held at all, transport still pays 6.67%', before.cashback_cents === 667, String(before.cashback_cents));
  check('before: the minimum counts 5 transactions', n(`SELECT min_txns AS n FROM requirements WHERE card_id = ? AND active = 1`, uob.id) === 5, '');

  await tg('/cardfix uobone');
  const preview = last();
  check('the preview names the exclusions it will record', /38 codes/.test(preview), preview);
  check("and doesn't call the minimum Trust's", !/Bonus Cashback/.test(preview) && !/only in its mode/.test(preview), preview);
  await tg('/cardfix uobone confirm');
  check('it applies', /\*Done:\*/.test(last()), last());

  const rules = db.prepare(`SELECT * FROM earn_rules WHERE card_id = ? AND active = 1`).all(uob.id) as any[];
  check('the card holds the eleven rules', rules.length === 11, String(rules.length));
  check('nothing is left from before', !rules.some((r) => r.cap_cents === 180000 && r.min_tier_cents === null), '');

  const req = db.prepare(`SELECT * FROM requirements WHERE card_id = ? AND active = 1`).all(uob.id) as any[];
  check('one minimum, S$600 in each statement month of a quarter', req.length === 1 && req[0].amount_cents === 60000 && req[0].window === 'statement_quarter' && req[0].per_month === 1, JSON.stringify(req));
  check('now counting the 10 transactions UOB asks for', req[0].min_txns === 10, JSON.stringify(req[0]));
  const tiers = db.prepare(`SELECT min_spend_cents AS s, reward_cents AS r FROM requirement_tiers WHERE requirement_id = ? ORDER BY s`).all(req[0].id) as any[];
  check('and the three rungs pay S$60, S$100 and S$200 a quarter', JSON.stringify(tiers) === JSON.stringify([{ s: 60000, r: 6000 }, { s: 100000, r: 10000 }, { s: 200000, r: 20000 }]), JSON.stringify(tiers));
  check('the old minimum is switched off, not deleted', n(`SELECT COUNT(*) AS n FROM requirements WHERE card_id = ? AND active = 0`, uob.id) === 1, '');

  const ex = db.prepare(`SELECT DISTINCT mcc FROM exclusions WHERE card_id = ? AND active = 1`).all(uob.id) as any[];
  check('all 38 of UOB\'s excluded codes are recorded', ex.length === 38, String(ex.length));

  // The additional cashback by tier, from the table in UOB's terms.
  const cb = async (cents: number, category: string, tier: number, mcc: string | null = null) =>
    (await at(cents, { category, tier, mcc })).cashback_cents;
  const T1 = 60000, T2 = 100000, T3 = 200000;
  check('no tier held: only the 0.03% base (3 cents on S$100)', (await cb(10000, 'transport', 0)) === 3, String(await cb(10000, 'transport', 0)));
  check('Tier 1: Grab-type spend pays 5%', (await cb(10000, 'transport', T1)) === 500, String(await cb(10000, 'transport', T1)));
  check('Tier 2: still 5%', (await cb(10000, 'dining', T2)) === 500, String(await cb(10000, 'dining', T2)));
  check('Tier 3: 6.67%', (await cb(10000, 'online', T3)) === 667, String(await cb(10000, 'online', T3)));
  check('groceries (5411) pay nothing extra at Tier 1', (await cb(10000, 'groceries', T1, '5411')) === 3, String(await cb(10000, 'groceries', T1, '5411')));
  check('2.67% at Tier 2', (await cb(10000, 'groceries', T2, '5411')) === 267, String(await cb(10000, 'groceries', T2, '5411')));
  check('4.67% at Tier 3', (await cb(10000, 'groceries', T3, '5411')) === 467, String(await cb(10000, 'groceries', T3, '5411')));
  check('groceries without the 5411 code are not paid extra', (await cb(10000, 'groceries', T3, '5499')) === 3, String(await cb(10000, 'groceries', T3, '5499')));
  check('Shell (fuel) pays only at Tier 3: 1.67%', (await cb(10000, 'fuel', T3)) === 167 && (await cb(10000, 'fuel', T2)) === 3, '');
  check('Singapore Power pays 1% from Tier 1', (await cb(10000, 'utilities', T1, '4900')) === 100 && (await cb(10000, 'utilities', 0, '4900')) === 3, '');

  // S$120 of additional cashback a statement month, whatever the rate.
  const big3 = await cb(300000, 'transport', T3);
  check('at Tier 3 the S$120 cap stops 6.67% at S$1,800 of spend (S$120.06, then the base on the other S$1,200)', Math.abs(big3 - 12042) <= 5, String(big3));
  const big1 = await cb(300000, 'transport', T1);
  check('at Tier 1 it stops 5% at S$2,400: exactly S$120, plus base on the other S$600', Math.abs(big1 - 12018) <= 5, String(big1));

  for (const [mcc, why] of [['7523', 'parking'], ['8062', 'hospitals'], ['5993', 'cigar stores'], ['8699', 'membership organisations'], ['5965', 'catalog merchants']] as const) {
    const e = await at(10000, { category: 'other', mcc, tier: T3 });
    check(`${why} (${mcc}) earns nothing at all`, e.excluded && e.cashback_cents === 0, JSON.stringify([e.excluded, e.cashback_cents]));
  }
}

// ======================================================= commands == /cardfix
// Pasted by hand, on cards with products of their own so /cardfix leaves them be.
{
  const paste = async (nick: string, text: string, profile: typeof CITI_REWARDS) => {
    const lines = profileCommands(profile, nick).split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/'));
    let bad = '';
    for (let i = 0; i < lines.length; i += 8) {
      const before = said.length;
      await tg(lines.slice(i, i + 8).join('\n'));
      const reply = said.slice(before).join('\n');
      if (/Error|Unknown command|Could not|Cannot|Format:|takes four-digit|is `online`/i.test(reply)) bad += reply + '\n';
    }
    return { lines, bad, text };
  };
  const shape = (nick: string) =>
    JSON.stringify(
      db
        .prepare(
          `SELECT category, mpd, reward_type, channel, cap_cents, cap_window, cap_group, min_tier_cents, earn_step_cents, mcc_include, mcc_exclude
             FROM earn_rules WHERE card_id = (SELECT id FROM cards WHERE nickname = ?) AND active = 1
            ORDER BY category, mpd, min_tier_cents, channel`
        )
        .all(nick)
    );
  const codes = (nick: string) =>
    (db.prepare(`SELECT mcc FROM exclusions WHERE active = 1 AND card_id = (SELECT id FROM cards WHERE nickname = ?) ORDER BY mcc`).all(nick) as any[])
      .map((r) => r.mcc)
      .join(',');
  const minimum = (nick: string) =>
    JSON.stringify([
      db
        .prepare(
          `SELECT amount_cents, window, min_txns, per_month, prorate_first, mode_key FROM requirements
            WHERE active = 1 AND card_id = (SELECT id FROM cards WHERE nickname = ?)`
        )
        .all(nick),
      db
        .prepare(
          `SELECT t.min_spend_cents AS s, t.reward_cents AS r FROM requirement_tiers t JOIN requirements q ON q.id = t.requirement_id
            WHERE q.active = 1 AND q.card_id = (SELECT id FROM cards WHERE nickname = ?) ORDER BY s`
        )
        .all(nick),
    ]);

  await tg('/newcard Citi|Rewards Pasted|citip|36180|15|2025-03-02');
  await tg('/newcard UOB|One Pasted|uobp|35700|31|2025-03-06');
  await runMigrations(env);

  const c = await paste('citip', 'citi', CITI_REWARDS);
  check('Citi\'s commands are all accepted', c.bad === '', c.bad);
  check('and leave the same rules as /cardfix', shape('citip') === shape('citirw'), `${shape('citip')}\n${shape('citirw')}`);

  const u = await paste('uobp', 'uob', UOB_ONE);
  check("UOB's commands are all accepted", u.bad === '', u.bad);
  check('and leave the same rules as /cardfix', shape('uobp') === shape('uobone'), `${shape('uobp')}\n${shape('uobone')}`);
  check('the same exclusions', codes('uobp') === codes('uobone') && codes('uobp').split(',').length === 38, codes('uobp'));
  check('and the same minimum and rungs', minimum('uobp') === minimum('uobone'), `${minimum('uobp')}\n${minimum('uobone')}`);

  // Safe to run twice.
  await tg('/cardfix citirw confirm');
  await tg('/cardfix uobone confirm');
  check('running /cardfix again changes nothing', n(`SELECT COUNT(*) AS n FROM earn_rules WHERE card_id = ? AND active = 1`, cardRow('citirw').id) === 3 && n(`SELECT COUNT(*) AS n FROM earn_rules WHERE card_id = ? AND active = 1`, cardRow('uobone').id) === 11, '');
  check('or doubles the exclusions', n(`SELECT COUNT(*) AS n FROM exclusions WHERE card_id = ? AND active = 1`, cardRow('uobone').id) === 38, '');
}

// --- the documented /req example means what it says -----------------------------
// `statement_quarter||||10|…` has one pipe too many: the 10 lands in the note and
// the note's text in the mode, which switches the minimum off for a card that
// has no such mode.
{
  const example = HELP.match(/\/req uobone\|[^\n`]*/)?.[0] ?? '';
  const fields = example.replace('/req ', '').split('|');
  check('the help example for UOB puts 10 in the transaction count', fields[6] === '10', JSON.stringify(fields));
  check('and the words in the note, with no mode', fields[7] === 'quarterly cashback' && fields[8] === undefined, JSON.stringify(fields));
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall passed');
process.exit(fails ? 1 : 0);
