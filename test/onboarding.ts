/**
 * Getting set up.
 *
 * Most of these are about what the app does NOT ask. A person adding three
 * cards should never meet a merchant code, a cap window or a reward rate —
 * those are facts about the product, and asking a person to supply them is
 * asking them to look something up and to be wrong about it on their own.
 */
import { DatabaseSync } from 'node:sqlite';
import { runMigrations, runSeed } from '../src/migrate';
import { fieldsFor, declareField } from '../src/onboarding/questions';
import { addAlias, aliasKey, initialsOf, searchProducts, seedAliases } from '../src/onboarding/search';
import { allCardSetups, cardSetup, onboardingView, readState, writeState } from '../src/onboarding/state';
import { attachWelcomeOffer, knownOffers } from '../src/onboarding/welcome';
import { requirementsFor, requirementProgress } from '../src/spend';
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
} as unknown as Env;

let fails = 0;
const check = (l: string, c: boolean, d = '') => {
  if (!c) fails++;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : `  -- ${d}`}`);
};
const sql = (s: string, ...a: unknown[]) => db.prepare(s).run(...(a as any));
const one = (s: string, ...a: unknown[]) => db.prepare(s).get(...(a as any)) as any;
Date.now = () => Date.parse('2026-09-18T04:00:00Z');

await runMigrations(env);
await runSeed(env);

// --- a new user ------------------------------------------------------------
const fresh = await onboardingView(env);
check('a user with no cards has not started', fresh.state.status === 'not_started', fresh.state.status);
check('and is not told they are ready', fresh.ready === false);

// --- finding a card by whatever you call it -------------------------------
check('the full name finds it', (await searchProducts(env, "DBS Woman's World Card"))[0]?.product.product_key === 'dbs_womans_world', JSON.stringify((await searchProducts(env, "DBS Woman's World Card"))[0]?.product.product_key));
check('so does part of it', (await searchProducts(env, 'womans world'))[0]?.product.product_key === 'dbs_womans_world');
check('so does the issuer plus a word', (await searchProducts(env, 'dbs woman'))[0]?.product.product_key.startsWith('dbs_womans'), JSON.stringify((await searchProducts(env, 'dbs woman'))[0]?.product.product_key));
check(
  'an apostrophe is dropped rather than splitting the word',
  aliasKey("DBS Woman's World Card") === 'dbs womans world card',
  aliasKey("DBS Woman's World Card")
);
check('an unknown card finds nothing', (await searchProducts(env, 'zzzz nonexistent')).length === 0);

check('initials are derived from the name', initialsOf('DBS', "Woman's World Card") === 'dwsw', initialsOf('DBS', "Woman's World Card"));

// The nickname people actually use.
const wwmc = one(`SELECT id FROM card_products WHERE product_key = 'dbs_womans_world'`);
await addAlias(env, wwmc.id, 'wwmc');
const byNickname = await searchProducts(env, 'wwmc');
check('a taught nickname finds the card', byNickname[0]?.product.product_key === 'dbs_womans_world', JSON.stringify(byNickname[0]?.product.product_key));
check('and it outranks everything else', byNickname[0]?.matched_on === 'alias' && byNickname[0].score === 100);

// An alias two cards would both claim helps nobody.
const before = one(`SELECT COUNT(*) AS n FROM card_product_aliases`).n;
await seedAliases(env);
check('seeding aliases twice adds nothing the second time', one(`SELECT COUNT(*) AS n FROM card_product_aliases`).n === before, `${before} → ${one(`SELECT COUNT(*) AS n FROM card_product_aliases`).n}`);
const ambiguous = db.prepare(`SELECT alias_key, COUNT(*) AS n FROM card_product_aliases GROUP BY alias_key HAVING n > 1`).all();
check('and no alias points at two cards', ambiguous.length === 0, JSON.stringify(ambiguous));

// --- the questions, which vary by card ------------------------------------
const general = await fieldsFor(env, wwmc.id);
check('every card is asked when its statement closes', general.some((f) => f.key === 'statement_day' && f.required));
check('the credit limit is optional', general.find((f) => f.key === 'credit_limit')!.required === false);
check('and says why it is not needed', general.find((f) => f.key === 'credit_limit')!.help_text!.includes('do not need it'));
check('nothing asks for a reward rate', !general.some((f) => f.key.includes('mpd') || f.key.includes('rate')), general.map((f) => f.key).join(','));
check('nor for merchant codes', !general.some((f) => f.key.includes('mcc')));

const one_ = one(`SELECT id FROM card_products WHERE product_key = 'uob_one'`);
const uobFields = await fieldsFor(env, one_.id);
check(
  'a card that runs in quarters needs its opening date',
  uobFields.find((f) => f.key === 'opened_at')!.required === true,
  JSON.stringify(uobFields.find((f) => f.key === 'opened_at'))
);
check(
  'and says why, in terms of the card',
  uobFields.find((f) => f.key === 'opened_at')!.help_text!.includes('quarter')
);
check('while an ordinary card does not', general.find((f) => f.key === 'opened_at')!.required === false);

// A product can add a question of its own.
await declareField(env, wwmc.id, {
  key: 'credit_limit',
  type: 'money',
  label: 'Credit limit',
  required: true,
  affects: 'notification',
  sort: 90,
});
check('a product can make an optional question required', (await fieldsFor(env, wwmc.id)).find((f) => f.key === 'credit_limit')!.required === true);
sql(`DELETE FROM product_onboarding_fields WHERE product_id = ? AND field_key = 'credit_limit'`, wwmc.id);

// --- a card that is missing something -------------------------------------
sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,product_id)
     VALUES ('DBS','Woman''s World Card','dbs_womans_world','wwmc',900000,18,'2026-03-14',?)`, wwmc.id);
sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,product_id)
     VALUES ('UOB','One Card','uob_one','one',900000,28,NULL,?)`, one_.id);

const setups = await allCardSetups(env);
const ready = setups.find((s) => s.nickname === 'wwmc')!;
check('a fully answered card is ready', ready.status === 'ready', JSON.stringify(ready));

const gap = setups.find((s) => s.nickname === 'one')!;
check('a card missing a required detail needs setup', gap.status === 'needs_setup' || gap.status === 'usable_with_limits', gap.status);
check('and names what is missing', gap.missing.some((m) => m.field_key === 'opened_at'), JSON.stringify(gap.missing));
check('with what the gap costs, in words', typeof gap.consequence === 'string' && gap.consequence!.length > 0, String(gap.consequence));

// A statement day nobody supplied is a limit, not a blocker. Every window
// calculation still has a number to work with — it is just the default, and the
// card says so instead of looking like it genuinely bills on the 1st.
sql(`UPDATE cards SET opened_at = '2026-01-28', statement_day = 1, statement_day_known = 0 WHERE nickname = 'one'`);
const limited = await cardSetup(env, one(`SELECT * FROM cards WHERE nickname = 'one'`));
check('an assumed statement day is usable with limits', limited.status === 'usable_with_limits', JSON.stringify(limited));
check('and is reported as missing', limited.missing.some((m) => m.field_key === 'statement_day'), JSON.stringify(limited.missing));
check(
  'while the app says the rewards still work',
  limited.consequence!.includes('Standard rewards still work'),
  limited.consequence ?? ''
);
check(
  'a day that was actually supplied is not reported as missing',
  !(await cardSetup(env, one(`SELECT * FROM cards WHERE nickname = 'wwmc'`))).missing.some((m) => m.field_key === 'statement_day')
);
sql(`UPDATE cards SET statement_day = 28, statement_day_known = 1 WHERE nickname = 'one'`);

// --- an existing user is not a new one ------------------------------------
const existing = await onboardingView(env);
check('someone with cards is treated as set up', existing.state.status === 'completed', existing.state.status);
check('and is never shown a welcome screen again', (await readState(env)).status === 'completed');
check('but outstanding gaps are offered as a repair', Array.isArray(existing.repairs));

// --- resuming halfway ------------------------------------------------------
await writeState(env, { status: 'in_progress', cards_completed: 2 });
const resumed = await onboardingView(env);
check('setup can be left half done', resumed.state.status === 'in_progress');
check('and remembers how far it got', resumed.state.cards_completed === 2, String(resumed.state.cards_completed));
check('without forcing a restart', resumed.cards.length === 2, String(resumed.cards.length));

// --- a welcome offer -------------------------------------------------------
const card = one(`SELECT * FROM cards WHERE nickname = 'wwmc'`);
check('nothing is known about offers until promotions exist', (await knownOffers(env, wwmc.id)).length === 0);

const attached = await attachWelcomeOffer(env, card.id, {
  amount_cents: 80000,
  window_days: 60,
  reward_note: '20,000 bonus points',
});
check('an offer can be attached', attached.ok === true, attached.error);
check('with the deadline counted from the opening date', attached.deadline === '2026-05-13', String(attached.deadline));
check('and a sentence saying what is tracked', attached.summary!.includes('800.00'), attached.summary ?? '');

const reqs = await requirementsFor(env, card.id);
const signup = reqs.find((r) => r.kind === 'signup_min')!;
check('it becomes an ordinary requirement', signup !== undefined);
check('rather than a second progress system', signup.window === 'fixed_window', signup?.window);
check('and keeps where it came from', one(`SELECT source_note FROM requirements WHERE id = ?`, signup.id).source_note === 'added during setup');

const progress = await requirementProgress(env, card, signup);
check('the existing engine tracks it', progress.remaining_cents === 80000, String(progress.remaining_cents));

check('the same offer cannot be attached twice', (await attachWelcomeOffer(env, card.id, { amount_cents: 80000, window_days: 60, reward_note: 'x' })).ok === false);

// Without an opening date there is nothing to count the window from.
sql(`UPDATE cards SET opened_at = NULL WHERE nickname = 'one'`);
const noDate = await attachWelcomeOffer(env, one(`SELECT id FROM cards WHERE nickname = 'one'`).id, {
  amount_cents: 50000,
  window_days: 90,
  reward_note: 'x',
});
check('an offer needs a date to count from', noDate.ok === false, JSON.stringify(noDate));
check('and says so rather than guessing one', noDate.error!.includes('date you got the card'), noDate.error ?? '');

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
