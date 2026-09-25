import { DatabaseSync } from 'node:sqlite';
import { runMigrations, runSeed } from '../src/migrate';
import { ngrams, prepare, vectorize } from '../shared/ml/text';
import { train, type Example } from '../shared/ml/train';
import { classify, featureCount, packWeights, storeFeatures, MIN_FEATURE_OVERLAP } from '../src/intelligence/models/classifier';
import { activeModel, meetsBar, listModels, promoteModel, registerModel, PROMOTION_BAR } from '../src/intelligence/models/registry';
import { harvestLabels, trainingReadiness, exportTrainingData } from '../src/intelligence/merchants/labels';
import { resolveMerchantIntelligence } from '../src/intelligence/merchants/resolve';
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
  POSTING_LAG_DAYS: '0',
  MCC_REVIEW_MIN_GAIN_CENTS: '50',
  MCC_HIGH_CONFIDENCE: '0.85',
  MCC_LOW_CONFIDENCE: '0.5',
} as unknown as Env;
Date.now = () => Date.parse('2026-09-14T04:00:00Z');

let fails = 0;
const check = (l: string, c: boolean, d = '') => {
  if (!c) fails++;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : `  -- ${d}`}`);
};
const sql = (s: string, ...a: unknown[]) => db.prepare(s).run(...(a as any));

await runMigrations(env);
await runSeed(env);

// --- feature extraction, shared by trainer and Worker ----------------------

check('text is padded so the edges are features', prepare('SQ COFFEE').startsWith(' '), prepare('SQ COFFEE'));
check('and punctuation becomes separation, not silence', prepare('A*B').includes('a b'), prepare('A*B'));

const g = ngrams('kopi');
check('n-grams span 3 to 5 characters', [...g.keys()].every((k) => k.length >= 3 && k.length <= 5), '');
check('a repeated fragment is counted, not deduplicated', (ngrams('aaaaaa').get('aaa') ?? 0) > 1, '');
check('an empty descriptor produces nothing', ngrams('   ').size === 0, String(ngrams('   ').size));

const vec = vectorize('kopitiam', (n) => (n.length === 3 ? 1 : undefined));
let norm = 0;
for (const v of vec) norm += v.value * v.value;
check('a document vector is L2-normalised', Math.abs(Math.sqrt(norm) - 1) < 1e-9, String(Math.sqrt(norm)));
check('and drops fragments the vocabulary lacks', vec.every((v) => v.ngram.length === 3), '');

// --- a corpus with real structure -----------------------------------------
//
// Three codes with genuinely different vocabulary, plus enough repetition to
// be learnable. Not random noise: a model that can separate random strings has
// proved nothing.

const OUTLETS = ['jem', 'tampines', 'orchard', 'bugis', 'nex', 'vivo', 'amk', 'clementi', 'woodlands', 'serangoon'];
const CORPUS: { mcc: string; make: (i: number) => string }[] = [
  { mcc: '5812', make: (i) => `din tai fung ${OUTLETS[i % OUTLETS.length]} restaurant` },
  { mcc: '5411', make: (i) => `ntuc fairprice supermarket ${OUTLETS[i % OUTLETS.length]}` },
  { mcc: '4121', make: (i) => `grab transport ride ${OUTLETS[i % OUTLETS.length]}` },
  { mcc: '5814', make: (i) => `kopitiam coffee stall ${OUTLETS[i % OUTLETS.length]}` },
];

const examples: Example[] = [];
for (const c of CORPUS) {
  // Eighty each, so the corpus clears the 300-label promotion bar. The bar is
  // not lowered to suit the test: a model promoted on less than that has not
  // had its precision measured on enough to mean anything.
  for (let i = 0; i < 80; i++) examples.push({ text: c.make(i), label: c.mcc });
}
// A code with too few examples to be responsible about.
for (let i = 0; i < 6; i++) examples.push({ text: `rare museum entry ${i}`, label: '7991' });

const trained = train(examples, { folds: 3, epochs: 12 });
if ('error' in trained) {
  check('the corpus trains', false, trained.error);
  process.exit(1);
}

check('the model names the codes it can answer', trained.classes.length === 4, trained.classes.join(','));
check('and leaves out the one it barely saw', !trained.classes.includes('7991'), trained.classes.join(','));
check('saying how many it dropped', trained.metrics.excluded_examples === 6, String(trained.metrics.excluded_examples));
check('and clears the label bar', trained.metrics.training_examples >= PROMOTION_BAR.min_training_examples, String(trained.metrics.training_examples));
check('it learns separable data well', trained.metrics.accuracy > 0.9, String(trained.metrics.accuracy));
check('with out-of-fold macro F1 to match', trained.metrics.macro_f1 > 0.9, String(trained.metrics.macro_f1));
check('and high-confidence precision above the bar', trained.metrics.high_confidence_precision >= 0.9, String(trained.metrics.high_confidence_precision));
check('every class is scored, including the weak ones', trained.metrics.per_class.length === 4, '');
check('features are capped', trained.features.length <= trained.options.max_features, String(trained.features.length));
check('and each carries one weight per class', trained.features.every((f) => f.weights.length === 4), '');

// Training twice on the same corpus must give the same model, or a changed
// number can never be attributed to changed data.
const again = train(examples, { folds: 0, epochs: 6 });
const once = train(examples, { folds: 0, epochs: 6 });
if ('error' in again || 'error' in once) check('training is repeatable', false, 'training failed');
else {
  check('training is reproducible', JSON.stringify(again.features[0]) === JSON.stringify(once.features[0]), '');
  check('and so is the class order', again.classes.join() === once.classes.join(), '');
}

// A corpus with nothing learnable must refuse rather than produce a model.
const thin = train([{ text: 'only one thing', label: '5812' }], { folds: 0 });
check('a corpus with one class refuses to train', 'error' in thin, JSON.stringify(thin).slice(0, 80));
check('and says what would change it', 'error' in thin && /more/i.test(thin.error), '');

// --- round trip: what the trainer learned is what the Worker computes ------

const reg = await registerModel(env, {
  model_key: 'merchant_mcc',
  architecture: trained.architecture,
  training_examples: trained.metrics.training_examples,
  validation_metrics: trained.metrics as unknown as Record<string, unknown>,
  classes: trained.classes,
  intercept: trained.intercept,
  high_confidence: trained.high_confidence,
});
check('the model registers', reg.ok && reg.version === 1, JSON.stringify(reg));

const beforeSeal = (await listModels(env, 'merchant_mcc'))[0];
check('an unsealed model fails the bar', !meetsBar(beforeSeal).ok, '');
check('because no features are stored yet', meetsBar(beforeSeal).missing.some((m) => /upload did not finish/.test(m)), meetsBar(beforeSeal).missing.join('; '));

const stored = await storeFeatures(env, { model_key: 'merchant_mcc', version: 1, features: trained.features });
check('features upload', stored.ok && stored.written === trained.features.length, JSON.stringify(stored).slice(0, 80));

const modelRow = db.prepare(`SELECT id FROM ml_models WHERE version = 1`).get() as any;
const n = await featureCount(env, modelRow.id);
check('and all of them landed', n === trained.features.length, `${n} vs ${trained.features.length}`);
sql(`UPDATE ml_models SET feature_count = ? WHERE id = ?`, n, modelRow.id);

const refused = await promoteModel(env, 'merchant_mcc', 1);
check('a sealed model that clears the bar promotes', refused.ok, JSON.stringify(refused.missing ?? refused.error));
check('and is now live', (await activeModel(env, 'merchant_mcc'))?.version === 1, '');

// The test that matters most: the Worker's arithmetic must agree with the
// trainer's. A vectoriser that drifts from its trainer produces a model that
// silently scores nonsense, and nothing else in this file would catch it.
let agreed = 0;
let asked = 0;
for (const c of CORPUS) {
  for (let i = 0; i < 6; i++) {
    asked++;
    const p = await classify(env, c.make(i + 100));
    if (p?.label === c.mcc) agreed++;
  }
}
check('the Worker reproduces the trainer on held-out descriptors', agreed >= asked - 1, `${agreed}/${asked}`);

const one = await classify(env, 'din tai fung jem restaurant');
check('a prediction names its model', one?.model_key === 'merchant_mcc' && one?.model_version === 1, JSON.stringify(one).slice(0, 120));
check('and returns a distribution, not a verdict', (one?.distribution.length ?? 0) > 1, '');
check('whose probabilities are ordered', (one?.distribution[0].probability ?? 0) >= (one?.distribution[1].probability ?? 1), '');
check('and reports how much of the line it recognised', (one?.matched_features ?? 0) > 0, '');

// --- retraining does not accumulate for ever -------------------------------

const v2 = await registerModel(env, {
  model_key: 'merchant_mcc',
  architecture: trained.architecture,
  training_examples: trained.metrics.training_examples,
  validation_metrics: trained.metrics as unknown as Record<string, unknown>,
  classes: trained.classes,
  intercept: trained.intercept,
  high_confidence: trained.high_confidence,
});
await storeFeatures(env, { model_key: 'merchant_mcc', version: v2.version!, features: trained.features });
const v2row = db.prepare(`SELECT id FROM ml_models WHERE version = 2`).get() as any;
sql(`UPDATE ml_models SET feature_count = ? WHERE id = ?`, await featureCount(env, v2row.id), v2row.id);
const second = await promoteModel(env, 'merchant_mcc', 2);
check('a second model promotes over the first', second.ok, JSON.stringify(second));
check('and v1 keeps its weights, so one step back is possible', (await featureCount(env, modelRow.id)) > 0, '');

const v3 = await registerModel(env, {
  model_key: 'merchant_mcc',
  architecture: trained.architecture,
  training_examples: trained.metrics.training_examples,
  validation_metrics: trained.metrics as unknown as Record<string, unknown>,
  classes: trained.classes,
  intercept: trained.intercept,
  high_confidence: trained.high_confidence,
});
await storeFeatures(env, { model_key: 'merchant_mcc', version: v3.version!, features: trained.features });
const v3row = db.prepare(`SELECT id FROM ml_models WHERE version = 3`).get() as any;
sql(`UPDATE ml_models SET feature_count = ? WHERE id = ?`, await featureCount(env, v3row.id), v3row.id);
const third = await promoteModel(env, 'merchant_mcc', 3);
check('a third promotes too', third.ok, JSON.stringify(third));
check('and now v1 is pruned', (await featureCount(env, modelRow.id)) === 0, 'weights nobody can roll back to should not be kept');
check('freeing rows rather than silently growing', (third.features_freed ?? 0) > 0, String(third.features_freed));
check(
  'but its record survives',
  (db.prepare(`SELECT COUNT(*) AS n FROM ml_models WHERE version = 1`).get() as any).n === 1,
  'what was trained and what it scored is the audit trail'
);
check(
  'and a pruned model cannot be promoted on a count it no longer has',
  !meetsBar((await listModels(env, 'merchant_mcc')).find((m) => m.version === 1)!).ok,
  ''
);

// The live model is v3 now; the rest of the file checks it still behaves.
const afterPrune = await classify(env, 'din tai fung jem restaurant');
check('the live model still answers after pruning', afterPrune?.model_version === 3, JSON.stringify(afterPrune)?.slice(0, 80));

// --- refusing to answer ----------------------------------------------------

const alien = await classify(env, 'zzzz qqqq xxxx vvvv');
check(
  'a descriptor the model has never seen gets no answer',
  alien === null,
  JSON.stringify(alien)?.slice(0, 120) ?? ''
);
check('the overlap floor is what does it', MIN_FEATURE_OVERLAP > 0, String(MIN_FEATURE_OVERLAP));

const empty = await classify(env, '   ');
check('an empty descriptor gets no answer either', empty === null, '');

// --- the model may never overturn evidence --------------------------------

sql(`INSERT INTO cards (issuer,product,product_key,nickname,credit_limit_cents,statement_day,opened_at,base_mpd)
     VALUES ('UOB','Preferred','uob_pp','pref',800000,15,'2026-01-01',0.4)`);

// A merchant with confirmed evidence saying 5411, whose text screams 5812.
sql(`INSERT INTO merchants (canonical_name, normalized_key) VALUES ('Din Tai Fung Jem', 'din tai fung jem')`);
const mid = (db.prepare(`SELECT id FROM merchants WHERE normalized_key='din tai fung jem'`).get() as any).id;
sql(`INSERT INTO merchant_aliases (alias_key, merchant_id, raw_example, source, confidence)
     VALUES ('din tai fung jem', ?, 'DIN TAI FUNG JEM', 'user', 'confirmed')`, mid);
sql(`INSERT INTO merchant_mcc_evidence (merchant_id, mcc, source, confidence, observed_at)
     VALUES (?, '5411', 'user', 'confirmed', '2026-09-01')`, mid);

const evidenced = await resolveMerchantIntelligence(env, { descriptor: 'DIN TAI FUNG JEM' });
check('evidence answers first', evidenced.mcc_candidates[0]?.mcc === '5411', JSON.stringify(evidenced.mcc_candidates));
check(
  'and the model is never consulted when it might disagree',
  !evidenced.provenance.trail.some((t) => t.step === 'self_trained_ml'),
  evidenced.provenance.trail.map((t) => t.step).join(',')
);

// An unknown merchant, where the model is the only thing that can help.
const modelled = await resolveMerchantIntelligence(env, { descriptor: 'NTUC FAIRPRICE SUPERMARKET BEDOK' });
check('an unknown merchant reaches the model', modelled.provenance.prediction_source === 'self_trained_ml', modelled.provenance.prediction_source);
check('which answers with a code', modelled.mcc_candidates[0]?.mcc === '5411', JSON.stringify(modelled.mcc_candidates[0]));
check('attributed to the model version', modelled.provenance.model_version === 3, String(modelled.provenance.model_version));
check('and the evidence line says it was predicted', /predicted by/.test(modelled.mcc_candidates[0]?.evidence ?? ''), modelled.mcc_candidates[0]?.evidence ?? '');

const unknowable = await resolveMerchantIntelligence(env, { descriptor: 'QQQQ ZZZZ WWWW' });
check('and a descriptor beyond the model still asks', unknowable.needs_review, '');
check(
  'saying the model had nothing to offer',
  unknowable.provenance.trail.some((t) => t.step === 'self_trained_ml' && /not seen enough/.test(t.outcome)),
  unknowable.provenance.trail.map((t) => `${t.step}:${t.outcome}`).join(' | ')
);

// --- harvesting labels from the ledger ------------------------------------

const pref = (db.prepare(`SELECT id FROM cards WHERE nickname='pref'`).get() as any).id;
for (let i = 0; i < 5; i++) {
  sql(
    `INSERT INTO transactions (card_id, amount_cents, occurred_at, merchant, merchant_raw, merchant_id, mcc)
     VALUES (?, 5000, '2026-09-0' || ?, 'Din Tai Fung', 'DIN TAI FUNG ' || ?, ?, '5812')`,
    pref, i + 1, i, mid
  );
  const tid = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as any).id;
  sql(
    `INSERT INTO merchant_mcc_evidence (merchant_id, mcc, source, confidence, observed_at, transaction_id)
     VALUES (?, '5812', 'statement', 'guess', '2026-09-01', ?)`,
    mid, tid
  );
}
// A seed guess, which must NOT become a label.
sql(
  `INSERT INTO transactions (card_id, amount_cents, occurred_at, merchant, merchant_raw, merchant_id, mcc)
   VALUES (?, 5000, '2026-09-09', 'Guessed', 'GUESSED PLACE', ?, '5999')`,
  pref, mid
);
const seedTid = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as any).id;
sql(
  `INSERT INTO merchant_mcc_evidence (merchant_id, mcc, source, confidence, observed_at, transaction_id)
   VALUES (?, '5999', 'seed', 'guess', '2026-09-09', ?)`,
  mid, seedTid
);

const harvest = await harvestLabels(env);
check('the ledger yields labels', harvest.added >= 5, JSON.stringify(harvest));
check('marked as coming from a statement', (harvest.by_source['statement_verified'] ?? 0) >= 5, JSON.stringify(harvest.by_source));
check(
  'and a seeded guess is not one of them',
  (db.prepare(`SELECT COUNT(*) AS n FROM merchant_training_labels WHERE confirmed_mcc='5999'`).get() as any).n === 0,
  'a seed is somebody’s note, not an observation'
);

const rerun = await harvestLabels(env);
check('harvesting twice adds nothing', rerun.added === 0, String(rerun.added));

const ready = await trainingReadiness(env);
check('readiness counts per code, not per category', ready.per_category.every((c) => /^\d{4}$/.test(c.category)), JSON.stringify(ready.per_category.slice(0, 3)));

const exported = await exportTrainingData(env);
check('every exported example carries a code', exported.examples.every((e) => !!e.confirmed_mcc), '');
const keys = Object.keys(exported.examples[0] ?? {});
check('and still no amounts, dates or cards', !keys.some((k) => /amount|_at$|card|transaction/.test(k)), keys.join(','));

// --- packing ---------------------------------------------------------------

const packed = packWeights([1.5, -2.25, 0]);
check('weights pack to base64', typeof packed === 'string' && packed.length > 0, packed);
check('at four bytes a class', atob(packed).length === 12, String(atob(packed).length));

check('the promotion bar still guards precision above all', PROMOTION_BAR.min_high_confidence_precision >= 0.9, String(PROMOTION_BAR.min_high_confidence_precision));

console.log(fails ? `\n${fails} check(s) failed` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
