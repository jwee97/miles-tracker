import { DatabaseSync } from 'node:sqlite';
import { runMigrations, runSeed } from '../src/migrate';
import { recordEvidence } from '../src/merchants/evidence';
import { linkAlias, resolveMerchant } from '../src/merchants/lookup';
import { parseDescriptor, sameMerchantLikely } from '../src/intelligence/merchants/normalize';
import { recordPrediction, resolveMerchantIntelligence } from '../src/intelligence/merchants/resolve';
import { decideReview, policyFrom, rewardImpactOfUncertainty } from '../src/intelligence/merchants/reward-impact';
import { recordTrainingLabel, trainingReadiness, exportTrainingData, READINESS } from '../src/intelligence/merchants/labels';
import { activeModel, listModels, meetsBar, promoteModel, registerModel } from '../src/intelligence/models/registry';
import { merchantMetrics } from '../src/intelligence/merchants/metrics';
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
const base = {
  DB: { prepare: (s: string) => wrap(s) },
  TZ_OFFSET_MINUTES: '480',
  MILE_VALUE_CENTS: '1.5',
  POSTING_LAG_DAYS: '0',
  MCC_REVIEW_MIN_GAIN_CENTS: '50',
  MCC_HIGH_CONFIDENCE: '0.85',
  MCC_LOW_CONFIDENCE: '0.5',
};
const env = base as unknown as Env;
Date.now = () => Date.parse('2026-09-14T04:00:00Z');

let fails = 0;
const check = (l: string, c: boolean, d = '') => {
  if (!c) fails++;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : `  -- ${d}`}`);
};
const sql = (s: string, ...a: unknown[]) => db.prepare(s).run(...(a as any));

await runMigrations(env);
await runSeed(env);

// --- descriptor parsing ----------------------------------------------------

const grab = parseDescriptor('GRAB*RIDE 8829 SINGAPORE SG');
check('a processor star is recognised', grab.processor === 'GRAB', String(grab.processor));
check('a country suffix is stripped', !/\bsingapore\b|\bsg\b/i.test(grab.normalized), grab.normalized);
check('and the country is kept as a fact', grab.country_hint === 'SG', String(grab.country_hint));
check('a trailing reference is removed', !/8829/.test(grab.normalized), grab.normalized);

const sq = parseDescriptor('SQ *THE COFFEE ACADEMICS');
check('a Square prefix is recognised', sq.processor === 'SQUARE', String(sq.processor));
check('the merchant survives the prefix', /coffee/i.test(sq.normalized), sq.normalized);

check(
  'one merchant through two routes is seen as the same',
  sameMerchantLikely('NTUC FAIRPRICE SINGAPORE SG', 'SQ *NTUC FAIRPRICE'),
  ''
);
check(
  'the same words in a different order too',
  sameMerchantLikely('DIN TAI FUNG JEM', 'JEM DIN TAI FUNG'),
  ''
);
check(
  'two different merchants are not',
  !sameMerchantLikely('NTUC FAIRPRICE', 'COLD STORAGE'),
  ''
);
check(
  'and two outlets of one chain are kept apart',
  !sameMerchantLikely('NTUC FAIRPRICE 123', 'NTUC FAIRPRICE'),
  'pooling two outlets would pool their MCC evidence'
);

const empty = parseDescriptor('  9931  ');
check('a descriptor of pure noise has no comparison key', empty.key === '', `"${empty.key}"`);
check('but the original is never destroyed', empty.raw === '  9931  ', `"${empty.raw}"`);

// --- cards, so the reward engine has something to price --------------------

sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,base_mpd)
     VALUES ('UOB','Preferred','uob_pp','pref',800000,15,'2026-01-01',0.4)`);
sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,base_mpd)
     VALUES ('Citi','Rewards','citi_rw2','crw',500000,15,'2026-01-01',0.4)`);
const pref = (db.prepare(`SELECT id FROM cards WHERE nickname='pref'`).get() as any).id;
const crw = (db.prepare(`SELECT id FROM cards WHERE nickname='crw'`).get() as any).id;

// Dining pays well on one card; groceries pays base on both. So a dining/
// grocery ambiguity is worth money and a grocery/pharmacy one is not.
sql(`INSERT INTO earn_rules (card_id,category,mpd,reward_type) VALUES (?,'dining',4,'miles')`, pref);
sql(`INSERT INTO earn_rules (card_id,category,mpd,reward_type) VALUES (?,'*',0.4,'miles')`, pref);
sql(`INSERT INTO earn_rules (card_id,category,mpd,reward_type) VALUES (?,'*',0.4,'miles')`, crw);

// --- resolution hierarchy --------------------------------------------------

const id = (await resolveMerchant(env, 'Din Tai Fung'))!.id;
await linkAlias(env, 'DIN TAI FUNG 1234 SG', id, { source: 'user', confidence: 'confirmed' });

const confirmed = await resolveMerchantIntelligence(env, { descriptor: 'DIN TAI FUNG 1234 SG' });
check('a confirmed alias wins outright', confirmed.provenance.prediction_source === 'user_confirmed', confirmed.provenance.prediction_source);
check('and is fully confident', confirmed.merchant?.confidence === 1, String(confirmed.merchant?.confidence));

const unknown = await resolveMerchantIntelligence(env, { descriptor: 'ZZQQ UNHEARD OF 77' });
check('an unrecognised descriptor asks', unknown.needs_review, unknown.review_reason ?? '');
check('and says so rather than guessing', unknown.merchant === null, JSON.stringify(unknown.merchant));
check(
  'and asking does not invent a merchant',
  (db.prepare(`SELECT COUNT(*) AS n FROM merchants WHERE canonical_name LIKE 'Zzqq%'`).get() as any).n === 0,
  'resolving is a question, not an assertion'
);

// The two steps that do not exist must SAY they do not exist.
const steps = unknown.provenance.trail.map((t) => t.step);
check('the missing model step is recorded, not omitted', steps.includes('self_trained_ml'), steps.join(','));
check('and it names where the decision is written down',
  unknown.provenance.trail.find((t) => t.step === 'self_trained_ml')!.outcome.includes('intelligence-model-decision'),
  '');
check('external evidence is recorded as unconfigured', steps.includes('external'), steps.join(','));

// --- conflicting evidence --------------------------------------------------

const petrol = (await resolveMerchant(env, 'Shell Bukit Timah'))!.id;
await linkAlias(env, 'SHELL BUKIT TIMAH', petrol, { source: 'statement', confidence: 'guess' });
await recordEvidence(env, { merchant_id: petrol, mcc: '5541', source: 'statement', observed_at: '2026-08-01' });
await recordEvidence(env, { merchant_id: petrol, mcc: '5541', source: 'statement', observed_at: '2026-08-15' });
await recordEvidence(env, { merchant_id: petrol, mcc: '5812', source: 'statement', observed_at: '2026-08-20' });

const mixed = await resolveMerchantIntelligence(env, { descriptor: 'SHELL BUKIT TIMAH' });
check('a merchant with two codes reports both', mixed.mcc_candidates.length === 2, String(mixed.mcc_candidates.length));
check('the heavier code leads', mixed.mcc_candidates[0].mcc === '5541', mixed.mcc_candidates[0].mcc);
check(
  'probabilities are a distribution, not a verdict',
  mixed.mcc_candidates[0].probability < 1 && mixed.mcc_candidates[0].probability > 0.5,
  String(mixed.mcc_candidates[0].probability)
);

// A user confirmation must outrank the pile of statement observations.
await recordEvidence(env, {
  merchant_id: petrol,
  mcc: '5812',
  source: 'user',
  confidence: 'confirmed',
  observed_at: '2026-09-01',
});
const afterUser = await resolveMerchantIntelligence(env, { descriptor: 'SHELL BUKIT TIMAH' });
check('one confirmation outweighs three observations', afterUser.mcc_candidates[0].mcc === '5812', afterUser.mcc_candidates[0].mcc);

// --- reward impact: the two cases from the brief ---------------------------

const policy = policyFrom(env);

// Case 1: the codes lead to different rates. Worth asking, even at 80%.
const sensitive = await rewardImpactOfUncertainty(
  env,
  { amount_cents: 20000, on: '2026-09-14' },
  [
    { mcc: '5812', probability: 0.8 },
    { mcc: '5411', probability: 0.2 },
  ]
);
check('a dining/grocery ambiguity has a real spread', sensitive.spread_cents > 0, String(sensitive.spread_cents));
check('and is not outcome-insensitive', !sensitive.outcome_insensitive, '');
const d1 = decideReview({ mcc: '5812', probability: 0.8 }, sensitive, policy);
check('so the app asks despite 80% confidence', d1.verdict === 'needs_answer', d1.verdict);
check('and the reason names the money', /changes the reward/.test(d1.reason), d1.reason);

// Case 2: both codes pay base on every card. Not worth asking, even at 55%.
const insensitive = await rewardImpactOfUncertainty(
  env,
  { amount_cents: 20000, on: '2026-09-14' },
  [
    { mcc: '5411', probability: 0.55 },
    { mcc: '5912', probability: 0.45 },
  ]
);
check('two codes that pay the same have no spread', insensitive.spread_cents === 0, String(insensitive.spread_cents));
check('and are recognised as outcome-insensitive', insensitive.outcome_insensitive, JSON.stringify(insensitive.per_mcc));
const d2 = decideReview({ mcc: '5411', probability: 0.55 }, insensitive, policy);
check('so the app resolves without asking', d2.verdict === 'resolve_with_uncertainty', d2.verdict);

// High confidence plus no consequence resolves outright.
const d3 = decideReview({ mcc: '5411', probability: 0.95 }, insensitive, policy);
check('high confidence and no stakes resolves outright', d3.verdict === 'auto_resolve', d3.verdict);

// Below the floor nothing is auto-resolved, however small the stakes.
const d4 = decideReview({ mcc: '5411', probability: 0.2 }, insensitive, policy);
check('too uncertain still asks, stakes or not', d4.verdict === 'needs_answer', d4.verdict);

// And a difference under the material threshold is not worth a tap.
const tiny = { spread_cents: 10, best: null, worst: null, outcome_insensitive: false, per_mcc: [] };
const d5 = decideReview({ mcc: '5812', probability: 0.9 }, tiny as any, policy);
check('a ten-cent difference is not a question', d5.verdict === 'auto_resolve', d5.verdict);

// --- provenance ------------------------------------------------------------

await recordPrediction(env, confirmed, null);
const stored = db.prepare(`SELECT * FROM merchant_predictions ORDER BY id DESC LIMIT 1`).get() as any;
check('a resolution is written down', !!stored, '');
check('with where it came from', stored.prediction_source === 'user_confirmed', stored.prediction_source);
check('and no model attributed when none ran', stored.model_key === null, String(stored.model_key));
check('and the whole distribution, not just the pick', typeof stored.candidate_distribution_json === 'string', '');

// --- labels ----------------------------------------------------------------

await recordTrainingLabel(env, {
  raw_descriptor: 'DIN TAI FUNG 1234 SG',
  normalized_descriptor: '',
  processor: null,
  country: null,
  merchant_id: id,
  canonical_merchant: 'Din Tai Fung',
  confirmed_mcc: '5812',
  category: 'dining',
  channel: null,
  issuer: null,
  network: null,
  transaction_id: null,
});
const labels = db.prepare(`SELECT * FROM merchant_training_labels`).all() as any[];
check('a confirmation becomes a label', labels.length === 1, String(labels.length));
check('labelled only as user-confirmed', labels[0].source === 'user_confirmed', labels[0].source);
check('the descriptor is stored normalised', labels[0].normalized_descriptor.length > 0, labels[0].normalized_descriptor);

// A label that asserts nothing teaches nothing.
await recordTrainingLabel(env, {
  raw_descriptor: 'SOMETHING ELSE',
  normalized_descriptor: '',
  processor: null,
  country: null,
  merchant_id: null,
  canonical_merchant: null,
  confirmed_mcc: null,
  category: null,
  channel: null,
  issuer: null,
  network: null,
  transaction_id: null,
});
check(
  'an empty confirmation is not recorded as a label',
  (db.prepare(`SELECT COUNT(*) AS n FROM merchant_training_labels`).get() as any).n === 1,
  ''
);

const readiness = await trainingReadiness(env);
check('readiness is honest about one label', !readiness.ready, '');
check('and says how far off it is', readiness.blocking.length > 0, readiness.blocking.join('; '));
check(
  'against the stated thresholds',
  readiness.thresholds.min_labels === READINESS.min_labels,
  String(readiness.thresholds.min_labels)
);
check('and names the decision it supports', /Deterministic evidence remains/.test(readiness.verdict), readiness.verdict);

const exported = await exportTrainingData(env);
const keys = Object.keys(exported.examples[0] ?? {});
check('the export carries no amounts', !keys.some((k) => /amount|cents/.test(k)), keys.join(','));
check('no dates', !keys.some((k) => /_at$|date/.test(k)), keys.join(','));
check('and no card identifiers', !keys.some((k) => /card|transaction/.test(k)), keys.join(','));

// --- model registry --------------------------------------------------------

const reg = await registerModel(env, {
  model_key: 'merchant_mcc',
  architecture: 'tfidf + logreg',
  training_examples: 40,
  validation_metrics: { macro_f1: 0.5, high_confidence_precision: 0.6 },
});
check('a model registers as version 1', reg.version === 1, String(reg.version));
check('registering does not deploy', (await activeModel(env, 'merchant_mcc')) === null, '');

const weak = (await listModels(env, 'merchant_mcc'))[0];
check('a weak model fails the bar', !meetsBar(weak).ok, '');
check('and the bar says why, in full', meetsBar(weak).missing.length === 5, meetsBar(weak).missing.join('; '));
check(
  'coverage is judged as well as accuracy',
  meetsBar({ ...weak, classes_json: '["5812","5411"]', intercept_json: '[0,0]' }).missing.some((m) =>
    /names only 2 codes/.test(m)
  ),
  ''
);
check(
  'including that no model was actually uploaded',
  meetsBar(weak).missing.some((m) => /upload did not finish/.test(m)),
  meetsBar(weak).missing.join('; ')
);

const refused = await promoteModel(env, 'merchant_mcc', 1);
check('so promotion is refused', !refused.ok, refused.error ?? '');
check('still nothing active', (await activeModel(env, 'merchant_mcc')) === null, '');

const forced = await promoteModel(env, 'merchant_mcc', 1, { force: true });
check('an override is possible', forced.ok, forced.error ?? '');
const active = await activeModel(env, 'merchant_mcc');
check('and it is now active', active?.version === 1, String(active?.version));
check('with the override recorded, not silent', /promoted despite/.test(active?.note ?? ''), String(active?.note));

await registerModel(env, {
  model_key: 'merchant_mcc',
  architecture: 'tfidf + logreg',
  training_examples: 2000,
  validation_metrics: { macro_f1: 0.81, high_confidence_precision: 0.93 },
  classes: ['5812', '5411', '4121', '5814'],
  intercept: [0.1, -0.1, 0.05, 0],
});
// Sealing is what records that the upload finished. Set here directly because
// this suite is about the registry, not about uploading a model — the round
// trip has its own file.
sql(`UPDATE ml_models SET feature_count = 500 WHERE version = 2`);
const good = await promoteModel(env, 'merchant_mcc', 2);
check('a model that clears the bar promotes', good.ok, good.error ?? '');
check('and the incumbent is retired, not deleted', good.retired === 1, String(good.retired));
check(
  'the old version is still on record',
  (db.prepare(`SELECT status FROM ml_models WHERE version = 1`).get() as any).status === 'retired',
  ''
);
check('exactly one model is active',
  (db.prepare(`SELECT COUNT(*) AS n FROM ml_models WHERE model_key='merchant_mcc' AND status='active'`).get() as any).n === 1,
  ''
);

// A prediction attributed to a model that is no longer in charge must be
// findable — otherwise a rollback only undoes half the damage.
sql(
  `INSERT INTO merchant_predictions (raw_descriptor, predicted_mcc, confidence, prediction_source, model_key, model_version, predicted_at)
   VALUES ('OLD MODEL SAID', '5814', 0.9, 'self_trained_ml', 'merchant_mcc', 1, '2026-09-01')`
);
const { predictionsFromRetiredModels } = await import('../src/intelligence/models/registry');
const audit = await predictionsFromRetiredModels(env);
check('predictions from a retired model can be audited', audit.length === 1, String(audit.length));

// --- metrics ---------------------------------------------------------------

const metrics = await merchantMetrics(env, 365);
check('metrics count the resolutions recorded', metrics.resolutions >= 1, String(metrics.resolutions));
check('and name correction rate as the one that matters', /Correction rate/.test(metrics.note), metrics.note);

console.log(fails ? `\n${fails} check(s) failed` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
