/**
 * Cards you choose the reward of.
 *
 * The Trust Freedom Card pays miles, or one of two cashback structures, or
 * stock — one at a time, locked for a membership quarter. Two things have to be
 * true for that to be modelled rather than approximated: only the selected
 * mode's rates apply, and a purchase from last quarter is still priced under
 * last quarter's mode after a switch. The second is the one that is easy to get
 * wrong and hard to notice, because the numbers stay plausible.
 */
import { DatabaseSync } from 'node:sqlite';
import { runMigrations, runSeed } from '../src/migrate';
import { evaluate } from '../src/rules';
import { chooseMode, choicesOf, defineMode, ModeError, modeOn } from '../src/cards/modes';
import { draftRuleSet, publishRuleSet } from '../src/catalog/rulesets';
import { modeComparison } from '../src/intelligence/planning/modes';
import type { Card, Env } from '../src/types';

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
  TZ_OFFSET_MINUTES: '480',
  MILE_VALUE_CENTS: '1.5',
  MIN_SPEND_WARN_DAYS: '7',
  OBJECTIVE: 'balanced',
} as unknown as Env;
Date.now = () => Date.parse('2026-09-30T04:00:00Z');

let fails = 0;
const check = (label: string, cond: boolean, detail = '') => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  -- ${detail}`}`);
};
const sql = (s: string, ...a: unknown[]) => db.prepare(s).run(...(a as any));

await runMigrations(env);
await runSeed(env);

// The card, as its terms describe it: four modes, one of them chosen.
// runSeed brings a catalogue with it, so take the id rather than assume one.
sql(
  `INSERT INTO card_products (product_key, issuer, product_name, source, verification_status)
   VALUES ('trust_freedom_card', 'Trust', 'Freedom Card', 'user', 'draft')`
);
const PRODUCT = (db.prepare(`SELECT id FROM card_products WHERE product_key = 'trust_freedom_card'`).get() as any).id as number;
sql(
  `INSERT INTO cards (id, issuer, product, product_key, nickname, credit_limit_cents, statement_day, opened_at, base_mpd, product_id)
   VALUES (1, 'Trust', 'Freedom Card', 'trust_freedom_card', 'freedom', 3910000, 19, '2026-01-19', 0, ?)`,
  PRODUCT
);
const card = db.prepare(`SELECT * FROM cards WHERE id = 1`).get() as unknown as Card;

await defineMode(env, PRODUCT, { mode_key: 'miles', label: 'Miles', payout: 'miles' });
await defineMode(env, PRODUCT, { mode_key: 'stockback', label: 'Stockback', payout: 'stock' });
await defineMode(env, PRODUCT, {
  mode_key: 'bonus_cashback',
  label: 'Bonus Cashback',
  payout: 'cash',
  picks_category: true,
  category_choices: 'dining,shopping,travel,wellness,transport,entertainment',
});

const SET = (await publishRuleSet(env, (await draftRuleSet(env, PRODUCT, '2026-01-01')).id, '2026-01-01')).id;

// Miles mode: 1.3 mpd on everything, rounded down to the nearest S$5.
sql(
  `INSERT INTO earn_rules (card_id, category, mpd, reward_type, mode_key, earn_step_cents)
   VALUES (1, '*', 1.3, 'miles', 'miles', 500)`
);
sql(`UPDATE earn_rules SET rule_set_id = ? WHERE rule_set_id IS NULL AND card_id = 1`, SET);
// Stockback: 3% on local spend, S$500 a quarter.
sql(
  `INSERT INTO earn_rules (card_id, category, mpd, reward_type, mode_key, cap_cents, cap_window)
   VALUES (1, '*', 3, 'cashback', 'stockback', 50000, 'calendar_quarter')`
);
sql(`UPDATE earn_rules SET rule_set_id = ? WHERE rule_set_id IS NULL AND card_id = 1`, SET);
// Bonus Cashback: 5% on the category picked for the quarter, 1% on the rest.
sql(
  `INSERT INTO earn_rules (card_id, category, mpd, reward_type, mode_key)
   VALUES (1, '@selected', 5, 'cashback', 'bonus_cashback')`
);
sql(`UPDATE earn_rules SET rule_set_id = ? WHERE rule_set_id IS NULL AND card_id = 1`, SET);
sql(
  `INSERT INTO earn_rules (card_id, category, mpd, reward_type, mode_key)
   VALUES (1, '*', 1, 'cashback', 'bonus_cashback')`
);
sql(`UPDATE earn_rules SET rule_set_id = ? WHERE rule_set_id IS NULL AND card_id = 1`, SET);

const buy = (amount: number, on: string, category: string | null = 'dining') =>
  evaluate(env, card, { amount_cents: amount, category, mcc: null, channel: null }, { on });

// --- nothing chosen ----------------------------------------------------------
{
  const e = await buy(10000, '2026-02-01');
  check(
    'with no mode chosen, no mode-specific rate applies',
    e.rule === null || e.bonus_rate === 0,
    JSON.stringify({ rule: e.rule?.mpd, miles: e.miles, cashback: e.cashback_cents })
  );
  check('and it is not quietly given the best of the four', e.cashback_cents === 0 && e.miles === 0, JSON.stringify(e.miles));
}

// --- the mode in force is the one that prices ------------------------------
await chooseMode(env, { id: 1, product_id: PRODUCT, nickname: 'freedom' }, 'miles', { from: '2026-04-01' });
{
  const e = await buy(10000, '2026-05-02');
  check('the chosen mode earns its own rate', e.miles === 130, String(e.miles));
  check('and the reward is the kind that mode pays', e.reward_type === 'miles', e.reward_type);
  check('while the other modes earn nothing', e.cashback_cents === 0, String(e.cashback_cents));
}

// The rounding is the difference between what this card is advertised at and
// what it pays: S$4.99 earns nothing at all.
{
  const small = await buy(499, '2026-05-02');
  check('a purchase under the rounding step earns nothing', small.miles === 0, String(small.miles));
  check('and says why rather than just showing a zero', small.trace.some((t) => /rounds down/i.test(t.detail)), JSON.stringify(small.trace.map((t) => t.detail)));

  const nearly = await buy(999, '2026-05-02');
  const exact = await buy(500, '2026-05-02');
  check('and $9.99 earns exactly what $5 earns', nearly.miles === exact.miles && exact.miles === 7, `${nearly.miles} vs ${exact.miles}`);
}

// --- switching, and what it must not do to the past ------------------------
await chooseMode(env, { id: 1, product_id: PRODUCT, nickname: 'freedom' }, 'stockback', { from: '2026-07-01' });
{
  const now = await buy(10000, '2026-08-02');
  check('after switching, the new mode prices', now.cashback_cents === 300, String(now.cashback_cents));
  check('and it is no longer earning miles', now.miles === 0, String(now.miles));

  const past = await buy(10000, '2026-05-02');
  check(
    'a purchase from before the switch keeps the mode it was made under',
    past.miles === 130 && past.cashback_cents === 0,
    JSON.stringify({ miles: past.miles, cashback: past.cashback_cents })
  );

  const history = await choicesOf(env, 1);
  check('the old choice is closed rather than deleted', history.length === 2, JSON.stringify(history));
  check(
    'and closed the day before the new one starts, so no day has two modes',
    history[0].effective_until === '2026-06-30',
    String(history[0].effective_until)
  );
}

// --- the category some modes also make you pick ----------------------------
{
  let refused = '';
  try {
    await chooseMode(env, { id: 1, product_id: PRODUCT, nickname: 'freedom' }, 'bonus_cashback', { from: '2026-10-01' });
  } catch (e) {
    refused = (e as ModeError).message;
  }
  check('a mode that picks a category will not be set without one', /picks a category/.test(refused), refused);

  let wrong = '';
  try {
    await chooseMode(env, { id: 1, product_id: PRODUCT, nickname: 'freedom' }, 'bonus_cashback', {
      from: '2026-10-01',
      category: 'groceries',
    });
  } catch (e) {
    wrong = (e as ModeError).message;
  }
  check('and not to a category it does not offer', /cannot be set to groceries/.test(wrong), wrong);

  await chooseMode(env, { id: 1, product_id: PRODUCT, nickname: 'freedom' }, 'bonus_cashback', {
    from: '2026-10-01',
    category: 'dining',
  });
  const dining = await buy(10000, '2026-10-05', 'dining');
  const other = await buy(10000, '2026-10-05', 'transport');
  check('the picked category earns the bonus rate', dining.cashback_cents === 500, String(dining.cashback_cents));
  check('and everything else the base one', other.cashback_cents === 100, String(other.cashback_cents));
}

// --- a switch that would leave a day with two modes -------------------------
{
  let clash = '';
  try {
    await chooseMode(env, { id: 1, product_id: PRODUCT, nickname: 'freedom' }, 'miles', { from: '2026-09-01' });
  } catch (e) {
    clash = (e as ModeError).message;
  }
  check('a backdated switch over the current one is refused', /cannot start on or before/.test(clash), clash);

  let unknown = '';
  try {
    await chooseMode(env, { id: 1, product_id: PRODUCT, nickname: 'freedom' }, 'crypto', { from: '2027-01-01' });
  } catch (e) {
    unknown = (e as ModeError).message;
  }
  check('and so is a mode the card does not offer', /no mode called/.test(unknown), unknown);
}

// --- an ordinary card is untouched ------------------------------------------
{
  sql(
    `INSERT INTO cards (id, issuer, product, product_key, nickname, credit_limit_cents, statement_day, opened_at, base_mpd)
     VALUES (2, 'DBS', 'Altitude', 'dbs_altitude', 'alt', 800000, 15, '2025-01-01', 1.2)`
  );
  sql(`INSERT INTO earn_rules (card_id, category, mpd, reward_type) VALUES (2, '*', 1.2, 'miles')`);
  const plain = db.prepare(`SELECT * FROM cards WHERE id = 2`).get() as unknown as Card;
  const e = await evaluate(env, plain, { amount_cents: 10000, category: 'dining', mcc: null, channel: null }, { on: '2026-08-02' });
  check('a card with no modes prices exactly as before', e.miles === 120, String(e.miles));
  check('and says nothing about modes', !e.trace.some((t) => t.check === 'Reward mode'), JSON.stringify(e.trace.map((t) => t.check)));
  check('nor about rounding', !e.trace.some((t) => t.check === 'Rounding'), JSON.stringify(e.trace.map((t) => t.check)));
}

// --- which mode would have paid best ----------------------------------------
{
  // A quarter of spend, all of it local and none of it huge.
  for (let i = 0; i < 10; i++) {
    sql(
      `INSERT INTO transactions (card_id, amount_cents, occurred_at, posted_at, merchant, category)
       VALUES (1, 20000, '2026-08-0${(i % 9) + 1}', '2026-08-0${(i % 9) + 1}', 'Somewhere', 'dining')`
    );
  }

  const cmp = await modeComparison(env, 'freedom', { from: '2026-08-01', to: '2026-08-31' });
  check('every mode the card offers is priced', cmp.modes.length === 3, JSON.stringify(cmp.modes.map((m) => m.mode_key)));
  check('the one actually in force is marked', cmp.modes.some((m) => m.selected), JSON.stringify(cmp.modes.map((m) => m.selected)));
  check('and they are ranked by what they were worth', cmp.modes[0].value_cents >= cmp.modes[1].value_cents, JSON.stringify(cmp.modes.map((m) => m.value_cents)));
  // $2,000 of spend, a $500 quarterly cap at 3%, and nothing past it: $15.
  check(
    'a cap stops the rate even when it is the rate on everything',
    cmp.modes.find((m) => m.mode_key === 'stockback')?.value_cents === 1500,
    JSON.stringify(cmp.modes.find((m) => m.mode_key === 'stockback'))
  );
  check('the comparison says it is measured on spending already done', cmp.caveats.some((c) => /already/i.test(c)), JSON.stringify(cmp.caveats));
  check('and names the card it is about', cmp.card === 'freedom', cmp.card);
}

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
