/**
 * The HSBC Revolution Card, set up the way it was found and checked against
 * HSBC's own worked example.
 *
 * Source: HSBC's 10X Reward Points Terms and Conditions
 *   https://www.hsbc.com.sg/content/dam/hsbc/sg/documents/credit-cards/revolution/offers/10x-reward-points-terms-and-conditions.pdf
 *
 * The card was reported as "No rates recorded, so this card never wins a
 * recommendation". Two things stood in the way of fixing it by command: there
 * was no way to say a rate is paid only online or by tapping, which is the
 * whole card; and /cardfix knew one card, and zeroed the base rate and
 * programme of whatever it was run on because every Trust rate belongs to a
 * mode.
 */
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index';
import { runMigrations, runSeed } from '../src/migrate';
import { evaluate } from '../src/rules';
import { recommendV2 } from '../src/recommendations/recommend';
import { cardRulesPrompt } from '../src/extraction';
import { HSBC_REVOLUTION, profileCommands, profileFor, TRUST_FREEDOM } from '../src/cards/profiles';
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
Date.now = () => Date.parse('2026-10-27T04:00:00Z');

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

await runMigrations(env);
await runSeed(env);

// --- which product is this? -------------------------------------------------------
// The catalogue calls it hsbc_revolution; the form makes hsbc_revolution_card.
check('the catalogue key finds the profile', profileFor('hsbc_revolution') === HSBC_REVOLUTION, '');
check('so does the one the form makes', profileFor('hsbc_revolution_card') === HSBC_REVOLUTION, '');
check('and the long one', profileFor('hsbc_revolution_credit_card') === HSBC_REVOLUTION, '');
check('Trust still resolves, by either key', profileFor('trust_freedom_card') === TRUST_FREEDOM && profileFor('trust_freedom') === TRUST_FREEDOM, '');
check('an unknown card has none', profileFor('dbs_altitude') === null && profileFor(null) === null, '');

// --- the card as it was found ----------------------------------------------------
await tg('/newcard HSBC|Revolution Card|hsbcrev|10000|10|2026-01-05');
await runMigrations(env);
await tg('/setprogram hsbcrev hsbc_points');
const card = db.prepare(`SELECT * FROM cards WHERE nickname = 'hsbcrev'`).get() as unknown as Card;
check('the card is linked to a product', !!(card as any).product_id, JSON.stringify(card));
check('with no rates recorded', n(`SELECT COUNT(*) AS n FROM earn_rules WHERE card_id = ? AND active = 1`, card.id) === 0, '');

// A plain 1.2 mpd card to be recommended against.
await tg('/newcard Other|Plain Card|plain|10000|10|2026-01-05');
await runMigrations(env);
await tg('/addearn plain * 1.2');

const buy = (
  cents: number,
  o: { mcc?: string | null; category?: string; channel?: 'online' | 'contactless' | 'offline' | null; foreign?: boolean; on?: string } = {}
) =>
  evaluate(
    env,
    card,
    {
      amount_cents: cents,
      mcc: o.mcc === undefined ? '5812' : o.mcc,
      category: o.category ?? 'dining',
      channel: o.channel === undefined ? 'online' : o.channel,
      foreign: o.foreign ?? false,
    },
    { on: o.on ?? '2026-10-15' }
  );

{
  const e = await buy(10000);
  check('so nothing prices: it earns nothing and has no rule', !e.rule && e.miles === 0, JSON.stringify(e.rule));
  const r = await recommendV2(env, { amount_cents: 10000, mcc: '5812', category: 'dining', channel: 'online' }, { on: '2026-10-15' });
  check('and it never wins', r.recommendation?.card.nickname !== 'hsbcrev', r.recommendation?.card.nickname ?? 'none');
}

// --- the repair ---------------------------------------------------------------------
{
  await tg('/cardfix hsbcrev');
  const preview = last();
  check('the preview names the card', /HSBC Revolution Card/.test(preview), preview);
  check('says nine rules would be added, with no modes', /9 rules added(?! across)/.test(preview), preview);
  check('says the 48 excluded codes', /48 codes/.test(preview), preview);
  check('says there is no minimum spend, rather than offering a Trust minimum', /no minimum spend/.test(preview) && !/Cashback minimum/.test(preview), preview);
  check('and does not offer a mode to record', !/confirm stockback|to also record the mode/.test(preview), preview);
  check('and lists what it does not model', /Not modelled/.test(preview), preview);
  check('the preview changed nothing', n(`SELECT COUNT(*) AS n FROM earn_rules WHERE card_id = ?`, card.id) === 0, '');

  await tg('/cardfix hsbcrev confirm');
  check('it applies', /\*Done:\*/.test(last()), last());

  const rules = db.prepare(`SELECT * FROM earn_rules WHERE card_id = ? AND active = 1`).all(card.id) as any[];
  check('the card holds the nine rules', rules.length === 9, String(rules.length));
  const bonus = rules.filter((r) => r.category !== '*');
  check('eight of them are 4 mpd, and one is the 0.4 base', bonus.length === 8 && bonus.every((r) => r.mpd === 4) && rules.find((r) => r.category === '*')?.mpd === 0.4, JSON.stringify(rules.map((r) => [r.category, r.mpd])));
  check(
    'each bonus rate is paid online or by tapping, both ways for every category',
    ['travel', 'shopping', 'dining', 'transport'].every((c) =>
      ['online', 'contactless'].every((ch) => bonus.some((r) => r.category === c && r.channel === ch))
    ),
    JSON.stringify(bonus.map((r) => [r.category, r.channel]))
  );
  check(
    'all sharing one S$1,000 monthly cap',
    bonus.every((r) => r.cap_cents === 100000 && r.cap_window === 'calendar_month' && r.cap_group === 'tenx'),
    JSON.stringify(bonus.map((r) => [r.cap_cents, r.cap_window, r.cap_group]))
  );
  check('the base rate has no cap and no channel', rules.find((r) => r.category === '*')?.cap_cents === null && rules.find((r) => r.category === '*')?.channel === null, '');

  const fixed = db.prepare(`SELECT base_mpd, program_key FROM cards WHERE id = ?`).get(card.id) as any;
  check('the base rate is 0.4', fixed.base_mpd === 0.4, JSON.stringify(fixed));
  check('and the programme it pays into is left alone', fixed.program_key === 'hsbc_points', JSON.stringify(fixed));

  const ex = db.prepare(`SELECT DISTINCT mcc FROM exclusions WHERE card_id = ? AND active = 1`).all(card.id) as any[];
  check('all 48 excluded codes are recorded, once each', ex.length === 48 && n(`SELECT COUNT(*) AS n FROM exclusions WHERE card_id = ? AND active = 1`, card.id) === 48, String(ex.length));
  check('there is no minimum to meet, so no /req', n(`SELECT COUNT(*) AS n FROM requirements WHERE card_id = ? AND active = 1`, card.id) === 0, '');

  // Safe to run twice: nothing doubles.
  await tg('/cardfix hsbcrev confirm');
  check('running it twice leaves nine rules', n(`SELECT COUNT(*) AS n FROM earn_rules WHERE card_id = ? AND active = 1`, card.id) === 9, '');
  check('and 48 exclusions', n(`SELECT COUNT(*) AS n FROM exclusions WHERE card_id = ? AND active = 1`, card.id) === 48, '');
}

// --- the same card from pasted commands ----------------------------------------------
// Generated from the profile /cardfix applies, so the two cannot drift. Run
// against a card on a product of its own, since /cardfix retires whatever its
// product's rule sets hold.
{
  await tg('/newcard HSBC|Revolution Paste Test|hsbcp|10000|10|2026-01-05');
  await runMigrations(env);
  const pasted = profileCommands(HSBC_REVOLUTION, 'hsbcp').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/'));
  check('the commands include a channel on every bonus rule', pasted.filter((l) => /channel (online|contactless)/.test(l)).length === 8, pasted.join('\n'));
  for (let i = 0; i < pasted.length; i += 8) {
    const before = said.length;
    await tg(pasted.slice(i, i + 8).join('\n'));
    const reply = said.slice(before).join('\n');
    check(`commands ${i + 1}–${Math.min(i + 8, pasted.length)} are all accepted`, !/Error|Unknown command|Could not|Cannot|Format:|is `online`/i.test(reply), reply);
  }
  const shape = (cardNick: string) =>
    JSON.stringify(
      (
        db
          .prepare(
            `SELECT category, mpd, reward_type, channel, cap_cents, cap_window, cap_group, mcc_include
               FROM earn_rules WHERE card_id = (SELECT id FROM cards WHERE nickname = ?) AND active = 1
              ORDER BY category, channel, mcc_include`
          )
          .all(cardNick) as any[]
      ).map((r) => ({ ...r, cap_window: r.cap_cents ? r.cap_window : null }))
    );
  check('pasted commands and /cardfix leave the same rules', shape('hsbcp') === shape('hsbcrev'), `${shape('hsbcp')}\n${shape('hsbcrev')}`);
  const codes = (nick: string) =>
    (db.prepare(`SELECT mcc FROM exclusions WHERE active = 1 AND card_id = (SELECT id FROM cards WHERE nickname = ?) ORDER BY mcc`).all(nick) as any[])
      .map((r) => r.mcc)
      .join(',');
  check('and the same exclusions', codes('hsbcp') === codes('hsbcrev') && codes('hsbcp').split(',').length === 48, codes('hsbcp'));
}

// --- /addearn takes a channel ------------------------------------------------------
{
  await tg('/addearn plain dining 3 channel contactless mcc 5812');
  const stored = db.prepare(`SELECT channel FROM earn_rules WHERE card_id = (SELECT id FROM cards WHERE nickname='plain') AND category = 'dining'`).get() as any;
  check('the channel is stored', stored?.channel === 'contactless', JSON.stringify(stored));
  check('and said back', /paid by tapping/.test(last()), last());
  await tg('/addearn plain groceries 3 channel swipe');
  check('a channel that is not one is refused', /`online`, `contactless` or `offline`/.test(last()), last());
  check('and nothing was stored for it', n(`SELECT COUNT(*) AS n FROM earn_rules WHERE category = 'groceries'`) === 0, '');
  check('the extraction prompt asks for it', cardRulesPrompt('hsbcrev', 'Revolution').includes('channel <online|contactless|offline>'), '');
  sql(`DELETE FROM earn_rules WHERE category = 'dining' AND card_id = (SELECT id FROM cards WHERE nickname='plain')`);
}

// --- HSBC's own worked example ------------------------------------------------------
// From the terms, all in one calendar month:
//   Airline ticket, online          S$900   10X  → 900 base + 8,100 bonus
//   Shopping, online                S$250   10X  → 250 base + 2,250 bonus
//   Department stores, contactless  S$350   10X  → 350 base + 3,150 bonus
//   Restaurant, not contactless     S$200    1X  → 200 base
//   0% instalment plan             S$1000    1X  → nothing (excluded from qualifying)
// "Total 1,700 Reward points, 9,000 Bonus points*  — capped at 9,000 even though
//  the total would otherwise amount to 13,500."
// In miles at 0.4 a point: (1,700 + 9,000) × 0.4 = 4,280.
{
  let k = 0;
  const log = (cents: number, mcc: string, category: string, channel: string) =>
    sql(
      `INSERT INTO transactions (card_id, amount_cents, occurred_at, posted_at, merchant, category, mcc, channel, is_foreign, status)
       VALUES (?, ?, '2026-09-12', '2026-09-12', ?, ?, ?, ?, 0, 'posted')`,
      card.id,
      cents,
      `Example ${++k}`,
      category,
      mcc,
      channel
    );
  const rows: [string, number, string, string, string][] = [
    ['airline, online', 90000, '4511', 'travel', 'online'],
    ['shopping, online', 25000, '5311', 'shopping', 'online'],
    ['department store, contactless', 35000, '5311', 'shopping', 'contactless'],
    ['restaurant, not contactless', 20000, '5812', 'dining', 'offline'],
  ];
  let miles = 0;
  const priced: Record<string, number> = {};
  for (const [label, cents, mcc, category, channel] of rows) {
    const e = await buy(cents, { mcc, category, channel: channel as any, on: '2026-09-12' });
    priced[label] = e.miles;
    miles += e.miles;
    log(cents, mcc, category, channel);
  }
  check('the airline ticket gets all of its 10X: 900 × 4 = 3,600 miles', priced['airline, online'] === 3600, JSON.stringify(priced));
  check('the shopping splits at the cap: S$100 at 4 mpd and S$150 at 0.4 = 460', priced['shopping, online'] === 460, JSON.stringify(priced));
  check('the department store is past the cap, so base only: 350 × 0.4 = 140', priced['department store, contactless'] === 140, JSON.stringify(priced));
  check('the restaurant, not tapped, is base only: 200 × 0.4 = 80', priced['restaurant, not contactless'] === 80, JSON.stringify(priced));
  check("the month comes to HSBC's 10,700 points: 4,280 miles", miles === 4280, String(miles));
  // Base points are 1,700 (every dollar above, bar the instalment plan); what is
  // left of the 4,280 miles is the bonus, and must be the capped 9,000 points,
  // not the 13,500 the purchases would otherwise have earned.
  const bonusPoints = Math.round((miles - 1700 * 0.4) / 0.4);
  check("and the bonus is the bank's 9,000 points, not the 13,500 it would otherwise be", bonusPoints === 9000, String(bonusPoints));

  // The next month starts the cap again.
  const next = await buy(90000, { mcc: '4511', category: 'travel', channel: 'online', on: '2026-10-05' });
  check('the cap resets with the calendar month', next.miles === 3600, String(next.miles));
}

// --- what counts ---------------------------------------------------------------------
{
  const dining = (o: Parameters<typeof buy>[1]) => buy(10000, { mcc: '5812', category: 'dining', on: '2026-11-03', ...o });
  check('dining online earns 4 mpd', (await dining({ channel: 'online' })).miles === 400, '');
  check('dining by tapping earns 4 mpd', (await dining({ channel: 'contactless' })).miles === 400, '');
  const dip = await dining({ channel: 'offline' });
  check('dining in store without tapping earns only the base 0.4', dip.miles === 40, `${dip.miles} ${dip.rule?.category}`);
  check('abroad is the same as at home', (await dining({ channel: 'online', foreign: true, on: '2026-12-03' })).miles === 400, '');

  const unknown = await dining({ channel: null, on: '2027-01-03' });
  check('with no channel recorded it is priced as qualifying (and the notes say so)', unknown.miles === 400, String(unknown.miles));
  check('the card says so itself', HSBC_REVOLUTION.not_modelled.some((t) => /no payment method recorded/.test(t)), '');

  const fastFood = await buy(10000, { mcc: '5814', category: 'dining', channel: 'online', on: '2027-02-03' });
  check('fast food (5814) is not in HSBC\'s list: base only', fastFood.miles === 40, String(fastFood.miles));
  const agent = await buy(10000, { mcc: '4722', category: 'travel', channel: 'online', on: '2027-02-03' });
  check('travel agencies (4722) are not eligible: base only', agent.miles === 40, String(agent.miles));
  const hotel = await buy(10000, { mcc: '3501', category: 'travel', channel: 'online', on: '2027-02-03' });
  check('a hotel chain code in 3000–3999 is travel: 4 mpd', hotel.miles === 400, String(hotel.miles));
  const taxi = await buy(10000, { mcc: '4121', category: 'transport', channel: 'contactless', on: '2027-03-03' });
  check('taxis by tapping: 4 mpd', taxi.miles === 400, String(taxi.miles));
  const unknownCode = await buy(10000, { mcc: null, category: 'dining', channel: 'online', on: '2027-03-03' });
  check('a merchant with no known code is not assumed eligible: base only', unknownCode.miles === 40, String(unknownCode.miles));

  for (const [mcc, why] of [['4900', 'utilities'], ['7523', 'parking'], ['9311', 'tax'], ['6012', 'financial institutions'], ['5199', 'nondurable goods']] as const) {
    const e = await buy(10000, { mcc, category: 'other', channel: 'online', on: '2027-04-03' });
    check(`${why} (${mcc}) earns nothing at all, not even the base`, e.excluded && e.miles === 0, JSON.stringify([e.excluded, e.miles]));
  }

  const other = await buy(10000, { mcc: '5499', category: 'groceries', channel: 'offline', on: '2027-04-03' });
  check('everything else not excluded earns the 0.4 base', other.miles === 40, String(other.miles));
  check('and no minimum spend ever holds a purchase back', (await dining({ on: '2027-05-03' })).min_spend_short_cents === 0, '');
}

// --- and now it wins ------------------------------------------------------------------
{
  const now = { amount_cents: 10000, mcc: '5812', category: 'dining', channel: 'online' as const };
  const r = await recommendV2(env, now, { on: '2027-06-03' });
  check('an online dinner goes on the Revolution, not the 1.2 mpd card', r.recommendation?.card.nickname === 'hsbcrev', r.recommendation?.card.nickname ?? 'none');
  const dip = await recommendV2(env, { ...now, channel: 'offline' }, { on: '2027-06-03' });
  check('but the same dinner paid in store without tapping goes on the plain card', dip.recommendation?.card.nickname === 'plain', dip.recommendation?.card.nickname ?? 'none');
}

// --- a rule added on the damaged table is still on -----------------------------
// Production's earn_rules once lost the default on `active`. A rule added with
// /addearn then had NULL there, which the engine reads as off — so the HSBC
// rates that were typed in went in and never applied.
{
  sql(`ALTER TABLE earn_rules RENAME TO earn_rules_ok`);
  sql(`CREATE TABLE earn_rules (id INTEGER PRIMARY KEY AUTOINCREMENT, card_id INTEGER, category TEXT, mpd TEXT,
        program_key TEXT, cap_cents TEXT, cap_group TEXT, cap_window TEXT, note TEXT, active TEXT, reward_type TEXT,
        mcc_include TEXT, mcc_exclude TEXT, channel TEXT, min_txn_cents TEXT, min_tier_cents TEXT, rule_set_id TEXT,
        priority TEXT, mode_key TEXT, earn_step_cents INTEGER, region TEXT)`);
  await tg('/addearn plain online 3 channel online');
  const added = db.prepare(`SELECT active, channel FROM earn_rules WHERE category = 'online'`).get() as any;
  check('/addearn names `active`, so the rule is on even without a default', String(added?.active) === '1' && added?.channel === 'online', JSON.stringify(added));
  sql(`DROP TABLE earn_rules`);
  sql(`ALTER TABLE earn_rules_ok RENAME TO earn_rules`);
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall passed');
process.exit(fails ? 1 : 0);
