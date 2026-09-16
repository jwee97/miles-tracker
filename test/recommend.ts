import { DatabaseSync } from 'node:sqlite';
import { runMigrations, runSeed } from '../src/migrate';
import { recommendV2 } from '../src/recommendations/recommend';
import { WEIGHTS, scoreOf, totalScore } from '../src/recommendations/score';
import { draftRuleSet, publishRuleSet } from '../src/catalog/rulesets';
import { migrateCardsToProducts } from '../src/catalog/migrate-products';
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
  DB: { prepare: (s: string) => wrap(s) },
  TZ_OFFSET_MINUTES: '480',
  MILE_VALUE_CENTS: '1.5',
  MIN_SPEND_WARN_DAYS: '7',
  POSTING_LAG_DAYS: '0',
  OBJECTIVE: 'balanced',
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

const card = (issuer: string, product: string, key: string, nick: string, day = 15) => {
  sql(
    `INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,base_mpd)
     VALUES (?,?,?,?,900000,?, '2025-01-01', 0.4)`,
    issuer,
    product,
    key,
    nick,
    day
  );
  return one(`SELECT * FROM cards WHERE nickname = ?`, nick);
};
const rule = (cardId: number, cols: string, vals: unknown[]) =>
  sql(`INSERT INTO earn_rules (card_id, ${cols}) VALUES (?, ${vals.map(() => '?').join(', ')})`, cardId, ...vals);

// Three cards: one paying more, one with codes, one plain.
const rich = card('DBS', "Woman's World Card", 'dbs_womans_world', 'wwmc');
const coded = card('Citi', 'Rewards Card', 'citi_rewards', 'crw');
const plain = card('DBS', 'Altitude Visa Signature', 'dbs_altitude_visa', 'alt');

rule(rich.id, 'category,mpd,reward_type', ['online', 4, 'miles']);
rule(rich.id, 'category,mpd,reward_type', ['*', 0.3, 'miles']);
rule(coded.id, 'category,mpd,reward_type,mcc_include', ['shopping', 4, 'miles', '5311']);
rule(coded.id, 'category,mpd,reward_type', ['*', 0.4, 'miles']);
rule(plain.id, 'category,mpd,reward_type', ['*', 1.3, 'miles']);

await migrateCardsToProducts(env, '2026-09-18');

const buy = (over: Record<string, unknown> = {}) => ({
  amount_cents: 12000,
  mcc: null as string | null,
  category: 'online' as string | null,
  channel: null as any,
  ...over,
});

// --- the highest rate wins when nothing else differs ------------------------
{
  const r = await recommendV2(env, buy());
  check('the best-paying card is recommended', r.recommendation?.card.nickname === 'wwmc', JSON.stringify(r.recommendation?.card));
  check('the others come back as alternatives', r.alternatives.length === 2, String(r.alternatives.length));
  check('ranked below it', r.alternatives.every((a) => a.score <= r.recommendation!.score), '');
  check('the reward is a number, not a rate alone', (r.recommendation?.reward.amount ?? 0) > 0, JSON.stringify(r.recommendation?.reward));
  check('with the reasoning attached', (r.recommendation?.reasons.length ?? 0) > 0, JSON.stringify(r.recommendation?.reasons));
  check('and the version it came from', r.recommendation?.rule_set_id !== null, String(r.recommendation?.rule_set_id));

  // Every term is a named number, not a magic constant buried in a sort.
  const c = r.recommendation!.score_components;
  check('the score is made of named parts', typeof c.reward_value === 'number' && typeof c.urgency_bonus === 'number', JSON.stringify(c));
  check('and they add up to the score', totalScore(c) === r.recommendation!.score, `${totalScore(c)} vs ${r.recommendation!.score}`);
}

// --- an urgent minimum outranks a better rate -------------------------------
{
  sql(
    `INSERT INTO requirements (card_id,kind,amount_cents,window,deadline,starts_at)
     VALUES (?,'signup_min',100000,'fixed_window','2026-09-22','2026-08-01')`,
    plain.id
  );
  const r = await recommendV2(env, buy());
  check('a minimum closing this week beats a better rate', r.recommendation?.card.nickname === 'alt', JSON.stringify(r.recommendation?.card));
  check('and the reason is the minimum, not the reward', r.recommendation!.score_components.urgency_bonus === WEIGHTS.urgent_minimum, JSON.stringify(r.recommendation!.score_components));
  check('the better-paying card is still offered', r.alternatives.some((a) => a.card.nickname === 'wwmc'), '');
  check('with what is left to spend', (r.recommendation?.minimum_spend?.remaining_cents ?? 0) > 0, JSON.stringify(r.recommendation?.minimum_spend));
  check('and that it is urgent', r.recommendation?.minimum_spend?.urgent === true, '');

  // A minimum with months left is a tiebreaker, not a trump.
  sql(`UPDATE requirements SET deadline = '2026-12-31' WHERE card_id = ?`, plain.id);
  const later = await recommendV2(env, buy());
  check('a minimum with time left does not override the rate', later.recommendation?.card.nickname === 'wwmc', JSON.stringify(later.recommendation?.card));
  const alt = later.alternatives.find((a) => a.card.nickname === 'alt')!;
  check('but still counts for something', alt.score_components.minimum_spend_bonus === WEIGHTS.standing_minimum, JSON.stringify(alt.score_components));
  sql(`DELETE FROM requirements WHERE card_id = ?`, plain.id);
}

// --- hard disqualification is not a low score -------------------------------
{
  sql(`INSERT INTO exclusions (card_id,mcc,reason,source,active) VALUES (?,'5311','department stores','user',1)`, rich.id);
  const r = await recommendV2(env, buy({ mcc: '5311', category: 'shopping' }));
  check('an excluded card is not recommended', r.recommendation?.card.nickname !== 'wwmc', JSON.stringify(r.recommendation?.card));
  check('it is set aside rather than ranked last', r.ineligible.some((i) => i.card.nickname === 'wwmc'), JSON.stringify(r.ineligible.map((i) => i.card.nickname)));
  check('and never appears among the alternatives', !r.alternatives.some((a) => a.card.nickname === 'wwmc'), '');
  const out = r.ineligible.find((i) => i.card.nickname === 'wwmc')!;
  check('with a reason a person can read', out.disqualified?.reason === 'excluded_mcc', JSON.stringify(out.disqualified));
  sql(`UPDATE exclusions SET active = 0 WHERE card_id = ?`, rich.id);
}

// --- an expired version never applies ---------------------------------------
{
  const product = one(`SELECT * FROM card_products WHERE product_key = 'dbs_womans_world'`);
  const draft = await draftRuleSet(env, product.id, '2026-10-01');
  sql(`INSERT INTO earn_rules (rule_set_id,category,mpd,reward_type) VALUES (?,'online',0.1,'miles')`, draft.id);
  sql(`INSERT INTO earn_rules (rule_set_id,category,mpd,reward_type) VALUES (?,'*',0.1,'miles')`, draft.id);
  await publishRuleSet(env, draft.id, '2026-09-18');

  const now = await recommendV2(env, buy());
  check('a version that has not started does not apply', now.recommendation?.card.nickname === 'wwmc', JSON.stringify(now.recommendation?.card));

  const after = await recommendV2(env, buy(), { on: '2026-10-05' });
  check('once it does, the ranking changes with it', after.recommendation?.card.nickname === 'alt', JSON.stringify(after.recommendation?.card));
  check('and the old version is gone from the answer', after.recommendation?.rule_set_id !== now.recommendation?.rule_set_id, '');
}

// --- what is unknown, and whether it matters --------------------------------
{
  // A code nobody knows, on a purchase where a card pays by code: material.
  const unsure = await recommendV2(env, buy({ mcc: null, category: 'shopping' }), { merchantQuery: 'somewhere new' });
  check('an unknown code on a code-gated card lowers confidence', unsure.confidence.level === 'low', JSON.stringify(unsure.confidence));
  check('and says why in words', unsure.confidence.reasons.some((x) => /merchant code is unknown/.test(x)), JSON.stringify(unsure.confidence.reasons));
  check('the assumption is listed', unsure.assumptions.some((a) => a.weight === 'material'), JSON.stringify(unsure.assumptions));
  check('but a recommendation is still made', unsure.recommendation !== null, '');

  // Uncertainty is charged for, so a guess does not read like a certainty.
  check('and uncertainty costs the score something', unsure.recommendation!.score_components.uncertainty_penalty < 0, JSON.stringify(unsure.recommendation!.score_components));

  // The same unknown on cards that ignore codes is a footnote, not a warning.
  sql(`UPDATE earn_rules SET mcc_include = NULL WHERE mcc_include = '5311'`);
  const relaxed = await recommendV2(env, buy({ mcc: null, category: 'shopping' }), { merchantQuery: 'somewhere new' });
  check('the same unknown is only a footnote where no card cares', relaxed.confidence.level !== 'low', JSON.stringify(relaxed.confidence));
  sql(`UPDATE earn_rules SET mcc_include = '5311' WHERE category = 'shopping' AND card_id = ?`, coded.id);
}

// --- an amount is optional ---------------------------------------------------
{
  const r = await recommendV2(env, buy({ amount_cents: null }));
  check('a recommendation works without an amount', r.recommendation !== null, '');
  check('and says what was assumed', r.assumptions.some((a) => /No amount/.test(a.what)), JSON.stringify(r.assumptions));
  check('with no split advice, since there is nothing to split', r.split_advice === null, '');
}

// --- splitting, only when it is worth the trouble ---------------------------
{
  sql(`DELETE FROM earn_rules WHERE rule_set_id IS NOT NULL AND mpd = 0.1`);
  sql(`UPDATE rule_sets SET status='withdrawn' WHERE effective_from = '2026-10-01'`);
  // The cap has to be big enough that the capped card still wins overall,
  // otherwise there is nothing to split — which is the correct answer, not a
  // missing feature.
  sql(`UPDATE earn_rules SET cap_cents = 60000, cap_window = 'calendar_month' WHERE card_id = ? AND category='online'`, rich.id);

  const big = await recommendV2(env, buy({ amount_cents: 100000 }));
  check('the capped card is still the best overall', big.recommendation?.card.nickname === 'wwmc', JSON.stringify(big.recommendation?.card));
  check('a purchase past its cap suggests a split', big.split_advice !== null, JSON.stringify(big.split_advice));
  check('naming what to put where', (big.split_advice?.remainder_cents ?? 0) > 0, JSON.stringify(big.split_advice));
  check('and what it gains', (big.split_advice?.gain_cents ?? 0) > 0, JSON.stringify(big.split_advice));

  // A gain of a few cents is noise: two taps at the till for nothing.
  const fussy = await recommendV2(env, buy({ amount_cents: 100000 }), { split_min_gain_cents: 10_000_000 });
  check('a negligible gain is not suggested', fussy.split_advice === null, JSON.stringify(fussy.split_advice));
}

// --- the shape of the answer -------------------------------------------------
{
  const r = await recommendV2(env, buy());
  check('the answer is dated', /^\d{4}-\d{2}-\d{2}T/.test(r.evaluated_at), r.evaluated_at);
  check('and says how fresh the card data is', typeof r.data_version === 'string', r.data_version);
  check('which is honest about never having been verified', r.data_version === 'unverified', r.data_version);
  check('the objective is stated', r.objective === 'balanced', r.objective);
}

// --- scoring, in isolation ---------------------------------------------------
{
  const base = {
    value_cents: 500,
    reward_type: 'miles' as const,
    min_spend_short_cents: 0,
    min_spend_days_left: null,
    cap_cents: null,
    headroom_cents: null,
  } as any;
  check('value alone is the score when nothing else applies', totalScore(scoreOf(base, { objective: 'balanced', warn_days: 7, unknowns: 0 })) === 500, '');
  check('the miles objective favours miles', scoreOf(base, { objective: 'miles', warn_days: 7, unknowns: 0 }).objective_bonus === WEIGHTS.objective_currency, '');
  check('and does not favour cashback', scoreOf({ ...base, reward_type: 'cashback' }, { objective: 'miles', warn_days: 7, unknowns: 0 }).objective_bonus === 0, '');
  check(
    'an exhausted cap is a real disadvantage',
    scoreOf({ ...base, cap_cents: 1000, headroom_cents: 0 }, { objective: 'balanced', warn_days: 7, unknowns: 0 }).exhausted_cap_penalty === -WEIGHTS.cap_exhausted,
    ''
  );
  check(
    'each unknown is charged once',
    scoreOf(base, { objective: 'balanced', warn_days: 7, unknowns: 2 }).uncertainty_penalty === -2 * WEIGHTS.uncertainty_each,
    ''
  );
  // The band that makes "an urgent minimum wins" mean something: no pile of
  // reward value can reach it.
  check('urgency outranks any plausible reward', WEIGHTS.urgent_minimum > 100_000, String(WEIGHTS.urgent_minimum));
  check('and the minspend objective outranks urgency', WEIGHTS.objective_minspend > WEIGHTS.urgent_minimum, '');
}

console.log(fails ? `\n${fails} check(s) failed` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
