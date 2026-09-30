/**
 * /cardfix, on a card in the state a real one ends up in.
 *
 * The Freedom card this was written for had been set up three times over: the
 * extraction's rules, a first correction's, a second's — including a S$500
 * spend cap that capped Stockback at S$15 a quarter — a base rate of 1.5 typed
 * into the card form, exclusions pasted twice, and a mode chosen from a date
 * before the card existed. Each attempt added to the last, and /delearn did not
 * even stop a rule applying.
 *
 * What this proves: the preview changes nothing; the repair leaves the card
 * holding exactly the profile, prices it as Trust does, costs a handful of
 * subrequests however much it writes, and is safe to run twice.
 */
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index';
import { runMigrations, runSeed } from '../src/migrate';
import { evaluate } from '../src/rules';
import { modeComparison } from '../src/intelligence/planning/modes';
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
let subrequests = 0;
let inBatch = false;
const count = () => {
  if (!inBatch) subrequests++;
};
const wrap = (sql: string, args: unknown[] = []): any => ({
  bind: (...a: unknown[]) => wrap(sql, a),
  first: async <T>() => {
    count();
    return (db.prepare(sql).get(...(args as any)) ?? null) as T;
  },
  all: async <T>() => {
    count();
    return { results: db.prepare(sql).all(...(args as any)) as T[] };
  },
  run: async () => {
    count();
    const r = db.prepare(sql).run(...(args as any));
    return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  },
});
const env = {
  DB: {
    prepare: (s: string) => wrap(s),
    batch: async (ss: any[]) => {
      subrequests++;
      inBatch = true;
      try {
        const out = [];
        for (const x of ss) out.push(await x.all());
        return out;
      } finally {
        inBatch = false;
      }
    },
  },
  APP_SECRET: 'test-secret',
  TELEGRAM_BOT_TOKEN: 'x',
  TELEGRAM_SECRET: 'y',
  OWNER_CHAT_ID: '1',
  TZ_OFFSET_MINUTES: '480',
  MIN_SPEND_WARN_DAYS: '7',
  POSTING_LAG_DAYS: '0',
  MILE_VALUE_CENTS: '1.5',
} as unknown as Env;
Date.now = () => Date.parse('2026-09-30T04:00:00Z');

let fails = 0;
const check = (label: string, cond: boolean, detail = '') => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  -- ${detail}`}`);
};
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
const n = (sql: string, ...a: unknown[]) => Number((db.prepare(sql).get(...(a as any)) as any).n);

await runMigrations(env);
await runSeed(env);

// --- the card as it was found ------------------------------------------------
// Added through the app's form, as in the screenshot: opened 19 September, a
// base rate of 1.5 typed in, no programme.
await tg('/newcard Trust|Freedom Card|freedom|39100|19|2026-09-19');
db.prepare(`UPDATE cards SET base_mpd = 1.5 WHERE nickname = 'freedom'`).run();
await runMigrations(env);

// The extraction's rule, before modes existed.
await tg('/addearn freedom * 1.3');
// A first attempt at modes: no default, and a spend cap that was really a
// reward cap, on a calendar quarter.
await tg('/mode freedom add miles|Miles|miles');
await tg('/mode freedom add stockback|Stockback|stock');
await tg('/mode freedom add bonus|Bonus|cash');
await tg('/addearn freedom * 3% mode stockback cap 500 window calendar_quarter');
await tg('/addearn freedom * 1.3 mode miles step 5');
// A rule someone tried to remove, and could not.
await tg('/addearn freedom dining 4');
const dining = db.prepare(`SELECT id FROM earn_rules WHERE category = 'dining' AND active = 1`).get() as any;
await tg(`/delearn ${dining.id}`);
// Exclusions pasted twice.
for (let i = 0; i < 2; i++) {
  await tg('/exclude 4900,6513,7349 freedom utilities');
  await tg('/exclude 7995 freedom gambling');
}
// A mode "chosen" from before the card existed.
await tg('/mode freedom stockback 2026-07-01');

const card = db.prepare(`SELECT * FROM cards WHERE nickname = 'freedom'`).get() as unknown as Card;
const buy = (cents: number, opts: { on?: string; foreign?: boolean; mcc?: string; category?: string } = {}) =>
  evaluate(
    env,
    card,
    { amount_cents: cents, mcc: opts.mcc ?? '5999', category: opts.category ?? 'other', channel: null, foreign: opts.foreign ?? false },
    { on: opts.on ?? '2026-09-29' }
  );

// --- the damage, before -------------------------------------------------------
{
  const removed = await buy(10000, { mcc: '5812', category: 'dining' });
  check(
    'a rule removed with /delearn no longer prices anything',
    removed.rule?.category !== 'dining',
    JSON.stringify(removed.rule)
  );
  const q = await modeComparison(env, 'freedom', { from: '2026-09-01', to: '2026-09-30' });
  void q;
  check('before: duplicate exclusions', n(`SELECT COUNT(*) AS n FROM exclusions WHERE card_id = ? AND active = 1`, card.id) === 8, '');
}

// --- the preview changes nothing ---------------------------------------------
const snapshot = () =>
  JSON.stringify([
    db.prepare(`SELECT id, active FROM earn_rules ORDER BY id`).all(),
    db.prepare(`SELECT * FROM card_modes ORDER BY id`).all(),
    db.prepare(`SELECT * FROM card_mode_choices ORDER BY id`).all(),
    db.prepare(`SELECT id, active FROM exclusions ORDER BY id`).all(),
    db.prepare(`SELECT base_mpd, program_key FROM cards WHERE id = ${card.id}`).all(),
  ]);
{
  const before = snapshot();
  await tg('/cardfix freedom');
  const preview = last();
  check('the preview changes nothing', snapshot() === before, '');
  check('and lists the rules it would switch off', /rules switched off/.test(preview) && /3%/.test(preview), preview);
  check('and names the base rate it would clear', /base rate 1\.5 → 0/.test(preview), preview);
  check('and says how to apply it', /\/cardfix freedom confirm/.test(preview), preview);
}

// --- the repair -----------------------------------------------------------------
{
  subrequests = 0;
  await tg('/cardfix freedom confirm stockback');
  const cost = subrequests;
  const done = last();
  check('it applies', /\*Done:\*/.test(done), done);
  check(`in a handful of subrequests (${cost}), not one per row`, cost <= 25, String(cost));
  check('and says to re-price what was already logged', /Re-price/.test(done), done);

  const active = db.prepare(`SELECT * FROM earn_rules WHERE card_id = ? AND active = 1`).all(card.id) as any[];
  check(`the card holds exactly the profile's rules (${active.length})`, active.length === 30, String(active.length));
  check(
    'none of the old ones',
    !active.some((r) => r.mode_key === null) && !active.some((r) => r.cap_cents === 50000),
    JSON.stringify(active.filter((r) => r.mode_key === null || r.cap_cents === 50000))
  );
  const fixed = db.prepare(`SELECT base_mpd, program_key FROM cards WHERE id = ?`).get(card.id) as any;
  check('the stray base rate is gone', fixed.base_mpd === 0 && fixed.program_key === null, JSON.stringify(fixed));

  const modes = db.prepare(`SELECT mode_key, is_default FROM card_modes WHERE product_id = ? ORDER BY mode_key`).all(
    (card as any).product_id
  ) as any[];
  check(
    'the four modes, and only them',
    modes.map((m) => m.mode_key).join(',') === 'bonus_cashback,miles,stockback,unlimited_cashback',
    JSON.stringify(modes)
  );
  check('with Unlimited Cashback as the default', modes.find((m) => m.is_default)?.mode_key === 'unlimited_cashback', JSON.stringify(modes));

  const choices = db.prepare(`SELECT mode_key, effective_from FROM card_mode_choices WHERE card_id = ?`).all(card.id) as any[];
  check(
    'Stockback, from the day the card was opened — not from before it existed',
    choices.length === 1 && choices[0].mode_key === 'stockback' && choices[0].effective_from === '2026-09-19',
    JSON.stringify(choices)
  );

  check(
    'every excluded code once, and once only',
    n(`SELECT COUNT(*) AS n FROM exclusions WHERE card_id = ? AND active = 1`, card.id) === 32 &&
      n(`SELECT COUNT(DISTINCT mcc) AS n FROM exclusions WHERE card_id = ? AND active = 1`, card.id) === 32,
    ''
  );
  check(
    'the Bonus Cashback minimum, scoped to that mode, with its two rungs',
    n(`SELECT COUNT(*) AS n FROM requirements WHERE card_id = ? AND active = 1 AND mode_key = 'bonus_cashback'`, card.id) === 1 &&
      n(
        `SELECT COUNT(*) AS n FROM requirement_tiers WHERE requirement_id = (SELECT id FROM requirements WHERE card_id = ? AND active = 1)`,
        card.id
      ) === 2,
    ''
  );
}

// --- and it prices as Trust does -----------------------------------------------
{
  const e = await buy(50000);
  check('S$500 on Stockback earns S$15', e.cashback_cents === 1500, String(e.cashback_cents));
  check('as stock, not miles', e.miles === 0, String(e.miles));

  const util = await buy(10000, { mcc: '4900', category: 'utilities' });
  check('an excluded code earns nothing', util.cashback_cents === 0 && util.miles === 0, JSON.stringify(util.trace.map((t) => t.detail)));

  // A quarter of S$20,000 would have hit the old S$500 SPEND cap at S$15. The
  // real cap is S$500 of stock.
  db.prepare(
    `INSERT INTO transactions (card_id, amount_cents, occurred_at, posted_at, merchant, category, mcc, is_foreign, status)
     VALUES (?, 2000000, '2026-09-25', '2026-09-25', 'Big', 'other', '5999', 0, 'posted')`
  ).run(card.id);
  const cmp = await modeComparison(env, 'freedom', { from: '2026-09-19', to: '2026-09-30' });
  const stock = cmp.modes.find((m) => m.mode_key === 'stockback');
  check('S$20,000 in a quarter earns S$500 of stock, not S$15', stock?.cashback_cents === 50000, JSON.stringify(stock));
  check('and the comparison knows Stockback is the mode in use', stock?.selected === true, JSON.stringify(stock));
}

// --- twice is the same as once -------------------------------------------------
{
  const before = [
    n(`SELECT COUNT(*) AS n FROM earn_rules WHERE card_id = ? AND active = 1`, card.id),
    n(`SELECT COUNT(*) AS n FROM exclusions WHERE card_id = ? AND active = 1`, card.id),
    n(`SELECT COUNT(*) AS n FROM requirements WHERE card_id = ? AND active = 1`, card.id),
    n(`SELECT COUNT(*) AS n FROM card_mode_choices WHERE card_id = ?`, card.id),
  ].join(',');
  await tg('/cardfix freedom confirm');
  const after = [
    n(`SELECT COUNT(*) AS n FROM earn_rules WHERE card_id = ? AND active = 1`, card.id),
    n(`SELECT COUNT(*) AS n FROM exclusions WHERE card_id = ? AND active = 1`, card.id),
    n(`SELECT COUNT(*) AS n FROM requirements WHERE card_id = ? AND active = 1`, card.id),
    n(`SELECT COUNT(*) AS n FROM card_mode_choices WHERE card_id = ?`, card.id),
  ].join(',');
  check('running it again leaves the card the same', before === after, `${before} → ${after}`);
  check(
    'and without a mode named, the mode already chosen is kept',
    (db.prepare(`SELECT mode_key FROM card_mode_choices WHERE card_id = ?`).get(card.id) as any)?.mode_key === 'stockback',
    ''
  );
}

// --- refusals ---------------------------------------------------------------
{
  await tg('/cardfix freedom confirm crypto');
  check('a mode the card does not offer is refused', /no mode called crypto/.test(last()), last());
  await tg('/cardfix freedom confirm bonus_cashback');
  check('and so is Bonus Cashback without its category', /needs a category/.test(last()), last());
  await tg('/newcard DBS|Altitude|alt|8000|1|2025-01-01');
  await tg('/cardfix alt');
  check('a card with no checked definition says so rather than guessing', /no checked definition/.test(last()), last());
}

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
