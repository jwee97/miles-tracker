import { ngrams, softmax, tf } from './text';

/**
 * A multinomial logistic regression over character n-grams, trained here.
 *
 * Written in TypeScript with no dependencies for one reason: it has to run
 * where the data already is. Training a personal model on a personal ledger
 * should not require installing Python, and it should not require sending
 * anybody's spending to a machine that is not theirs. This trains in the
 * browser tab that already holds the data, in a few seconds.
 *
 * It is not a large model and it is not trying to be. What makes it useful is
 * not capacity, it is that the alternative — asking a person to name the code
 * on every new merchant forever — is worse.
 *
 * Three properties this deliberately has:
 *
 *  - **It refuses classes it has not seen enough of.** A code with four
 *    examples cannot be predicted responsibly, so it is dropped from the model
 *    entirely rather than predicted badly. The resolver then abstains and the
 *    deterministic path answers, which is the correct outcome.
 *  - **It scores itself out of fold.** Every metric reported comes from
 *    predictions made on data the model did not train on.
 *  - **It is reproducible.** A fixed seed and a fixed feature order, so the
 *    same corpus gives the same model and a changed number means the data
 *    changed.
 */

export interface Example {
  /** The descriptor, already normalised by the app's own normaliser. */
  text: string;
  /** What it was confirmed to be. */
  label: string;
}

export interface TrainOptions {
  /** An n-gram must appear in at least this many descriptors to be a feature. */
  min_df?: number;
  /** Hard cap on the vocabulary, by document frequency. */
  max_features?: number;
  /** A class with fewer examples than this is excluded from the model. */
  min_per_class?: number;
  epochs?: number;
  learning_rate?: number;
  /** L2 penalty. Higher means a simpler model that is less sure of itself. */
  l2?: number;
  /** Folds for cross-validation, or 0 to skip it. */
  folds?: number;
  seed?: number;
  onProgress?: (done: number, total: number, note: string) => void;
}

export const DEFAULTS = {
  min_df: 2,
  max_features: 12_000,
  min_per_class: 25,
  epochs: 24,
  learning_rate: 0.5,
  l2: 1e-5,
  folds: 4,
  seed: 7,
} as const;

export interface Feature {
  ngram: string;
  idf: number;
  /** One weight per class, in the model's class order. */
  weights: number[];
}

export interface Metrics {
  training_examples: number;
  classes: number;
  /** Out-of-fold macro F1 across the classes kept. */
  macro_f1: number;
  /** Of predictions the model calls high-confidence, the share that were right. */
  high_confidence_precision: number;
  /** How often it is willing to be high-confidence at all. */
  high_confidence_share: number;
  /** Plain accuracy, out of fold. Reported, but not the number that decides. */
  accuracy: number;
  per_class: { label: string; support: number; precision: number; recall: number; f1: number }[];
  /** Examples whose class was dropped for having too few instances. */
  excluded_examples: number;
  excluded_classes: string[];
}

export interface TrainedModel {
  architecture: string;
  classes: string[];
  features: Feature[];
  intercept: number[];
  high_confidence: number;
  options: Required<Omit<TrainOptions, 'onProgress'>>;
  metrics: Metrics;
}

export const HIGH_CONFIDENCE = 0.85;

/** A small deterministic PRNG, so a training run can be repeated exactly. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

interface Vocab {
  index: Map<string, number>;
  idf: Float64Array;
  ngrams: string[];
}

/** Build the vocabulary from the training half only — see the note in `crossValidate`. */
function buildVocab(docs: Map<string, number>[], minDf: number, maxFeatures: number): Vocab {
  const df = new Map<string, number>();
  for (const d of docs) for (const g of d.keys()) df.set(g, (df.get(g) ?? 0) + 1);

  const kept = [...df.entries()]
    .filter(([, n]) => n >= minDf)
    // Sorted by document frequency, then alphabetically so the tie-break is
    // stable: a vocabulary that reorders between runs makes two models
    // impossible to compare.
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, maxFeatures);

  const index = new Map<string, number>();
  const idf = new Float64Array(kept.length);
  const list: string[] = [];
  const n = docs.length;

  kept.forEach(([g, freq], i) => {
    index.set(g, i);
    // Smoothed idf, the scikit-learn form, so a feature in every document
    // still carries a little weight instead of vanishing.
    idf[i] = Math.log((1 + n) / (1 + freq)) + 1;
    list.push(g);
  });

  return { index, idf, ngrams: list };
}

/** One document as (feature index, value) pairs, L2-normalised. */
function encode(doc: Map<string, number>, vocab: Vocab): { idx: Int32Array; val: Float64Array } {
  const idxs: number[] = [];
  const vals: number[] = [];
  for (const [g, c] of doc) {
    const i = vocab.index.get(g);
    if (i === undefined) continue;
    idxs.push(i);
    vals.push(tf(c) * vocab.idf[i]);
  }
  let norm = 0;
  for (const v of vals) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < vals.length; i++) vals[i] /= norm;
  return { idx: Int32Array.from(idxs), val: Float64Array.from(vals) };
}

interface Fitted {
  weights: Float64Array;
  intercept: Float64Array;
}

/**
 * Multinomial logistic regression by stochastic gradient descent.
 *
 * Plain and small on purpose. The gradient of the softmax cross-entropy is
 * `(p - y)` per class, which touches only the features this descriptor has —
 * so an epoch costs (examples x nonzeros x classes), not (examples x vocabulary
 * x classes). That is the difference between a few seconds and a few minutes.
 */
function fit(
  encoded: { idx: Int32Array; val: Float64Array }[],
  labels: Int32Array,
  nFeatures: number,
  nClasses: number,
  opt: { epochs: number; learning_rate: number; l2: number; seed: number },
  onEpoch?: (e: number) => void
): Fitted {
  const weights = new Float64Array(nFeatures * nClasses);
  const intercept = new Float64Array(nClasses);
  const order = Int32Array.from(encoded.map((_, i) => i));
  const rand = rng(opt.seed);
  const scores = new Float64Array(nClasses);

  for (let epoch = 0; epoch < opt.epochs; epoch++) {
    // Shuffle, so the model does not learn the order the ledger happens to be
    // in — which for a statement import is chronological, and therefore
    // correlated with everything.
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = order[i];
      order[i] = order[j];
      order[j] = t;
    }

    // Decaying step size: big steps early to get near the answer, small ones
    // later so it settles instead of orbiting.
    const lr = opt.learning_rate / (1 + epoch);

    for (const s of order) {
      const { idx, val } = encoded[s];
      const y = labels[s];

      for (let c = 0; c < nClasses; c++) scores[c] = intercept[c];
      for (let k = 0; k < idx.length; k++) {
        const base = idx[k] * nClasses;
        const v = val[k];
        for (let c = 0; c < nClasses; c++) scores[c] += weights[base + c] * v;
      }

      const p = softmax(Array.from(scores));

      for (let c = 0; c < nClasses; c++) {
        const g = p[c] - (c === y ? 1 : 0);
        if (g === 0) continue;
        intercept[c] -= lr * g;
        for (let k = 0; k < idx.length; k++) {
          const w = idx[k] * nClasses + c;
          weights[w] -= lr * (g * val[k] + opt.l2 * weights[w]);
        }
      }
    }
    onEpoch?.(epoch + 1);
  }

  return { weights, intercept };
}

function predictOne(
  doc: Map<string, number>,
  vocab: Vocab,
  model: Fitted,
  nClasses: number
): { klass: number; probability: number } {
  const { idx, val } = encode(doc, vocab);
  const scores = new Array(nClasses);
  for (let c = 0; c < nClasses; c++) scores[c] = model.intercept[c];
  for (let k = 0; k < idx.length; k++) {
    const base = idx[k] * nClasses;
    for (let c = 0; c < nClasses; c++) scores[c] += model.weights[base + c] * val[k];
  }
  const p = softmax(scores);
  let best = 0;
  for (let c = 1; c < nClasses; c++) if (p[c] > p[best]) best = c;
  return { klass: best, probability: p[best] };
}

function scoreOutOfFold(
  truth: Int32Array,
  predicted: Int32Array,
  confidence: Float64Array,
  classes: string[],
  support: number[]
): Omit<Metrics, 'training_examples' | 'classes' | 'excluded_examples' | 'excluded_classes'> {
  const n = truth.length;
  let correct = 0;
  for (let i = 0; i < n; i++) if (truth[i] === predicted[i]) correct++;

  const perClass = classes.map((label, c) => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (let i = 0; i < n; i++) {
      if (predicted[i] === c && truth[i] === c) tp++;
      else if (predicted[i] === c) fp++;
      else if (truth[i] === c) fn++;
    }
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    return {
      label,
      support: support[c],
      precision: Math.round(precision * 1000) / 1000,
      recall: Math.round(recall * 1000) / 1000,
      f1: Math.round(f1 * 1000) / 1000,
    };
  });

  let highN = 0;
  let highRight = 0;
  for (let i = 0; i < n; i++) {
    if (confidence[i] >= HIGH_CONFIDENCE) {
      highN++;
      if (truth[i] === predicted[i]) highRight++;
    }
  }

  const round = (x: number) => Math.round(x * 1000) / 1000;
  return {
    macro_f1: round(perClass.reduce((s, c) => s + c.f1, 0) / (perClass.length || 1)),
    high_confidence_precision: highN ? round(highRight / highN) : 0,
    high_confidence_share: n ? round(highN / n) : 0,
    accuracy: n ? round(correct / n) : 0,
    per_class: perClass,
  };
}

export function train(examples: Example[], options: TrainOptions = {}): TrainedModel | { error: string } {
  const opt = { ...DEFAULTS, ...options };
  const progress = options.onProgress ?? (() => {});

  // --- decide which classes the model is allowed to have an opinion about ---
  const counts = new Map<string, number>();
  for (const e of examples) counts.set(e.label, (counts.get(e.label) ?? 0) + 1);

  const kept = [...counts.entries()].filter(([, n]) => n >= opt.min_per_class).map(([l]) => l);
  const dropped = [...counts.entries()].filter(([, n]) => n < opt.min_per_class).map(([l]) => l);

  if (kept.length < 2) {
    return {
      error:
        `Not enough of any one code to learn from: ${kept.length} code(s) have at least ` +
        `${opt.min_per_class} examples, and a model needs at least two to tell apart. ` +
        `Answering more reviews, or importing more statements, is what moves this.`,
    };
  }

  const classes = kept.slice().sort();
  const classIndex = new Map(classes.map((c, i) => [c, i]));
  const used = examples.filter((e) => classIndex.has(e.label));
  const excludedExamples = examples.length - used.length;

  progress(0, opt.epochs + opt.folds, 'reading descriptors');

  const docs = used.map((e) => ngrams(e.text));
  const labels = Int32Array.from(used.map((e) => classIndex.get(e.label)!));
  const support = classes.map((c) => counts.get(c) ?? 0);

  // --- out-of-fold scoring -------------------------------------------------
  const metricsCore =
    opt.folds >= 2
      ? crossValidate(docs, labels, classes, support, opt, progress)
      : {
          macro_f1: 0,
          high_confidence_precision: 0,
          high_confidence_share: 0,
          accuracy: 0,
          per_class: classes.map((label, i) => ({ label, support: support[i], precision: 0, recall: 0, f1: 0 })),
        };

  // --- the model that actually ships ---------------------------------------
  const vocab = buildVocab(docs, opt.min_df, opt.max_features);
  if (!vocab.ngrams.length) return { error: 'no feature survived the minimum document frequency' };

  const encoded = docs.map((d) => encode(d, vocab));
  const fitted = fit(encoded, labels, vocab.ngrams.length, classes.length, opt, (e) =>
    progress(opt.folds + e, opt.epochs + opt.folds, `training, pass ${e} of ${opt.epochs}`)
  );

  const features: Feature[] = vocab.ngrams.map((ngram, i) => {
    const weights = new Array(classes.length);
    for (let c = 0; c < classes.length; c++) weights[c] = fitted.weights[i * classes.length + c];
    return { ngram, idf: vocab.idf[i], weights };
  });

  return {
    architecture: 'tfidf_char_3_5 + multinomial_logistic_regression',
    classes,
    features,
    intercept: Array.from(fitted.intercept),
    high_confidence: HIGH_CONFIDENCE,
    options: opt as Required<Omit<TrainOptions, 'onProgress'>>,
    metrics: {
      training_examples: used.length,
      classes: classes.length,
      excluded_examples: excludedExamples,
      excluded_classes: dropped,
      ...metricsCore,
    },
  };
}

/**
 * Stratified k-fold, with the vocabulary rebuilt inside every fold.
 *
 * That last part is the one people skip, and it is the one that matters.
 * Fitting the vectoriser on all the data before splitting lets the training
 * folds see which n-grams the held-out descriptors contain — a small leak that
 * flatters every number afterwards. Rebuilding per fold costs a few seconds
 * and makes the reported score mean what it says.
 */
function crossValidate(
  docs: Map<string, number>[],
  labels: Int32Array,
  classes: string[],
  support: number[],
  opt: Required<Omit<TrainOptions, 'onProgress'>>,
  progress: (done: number, total: number, note: string) => void
) {
  const folds = opt.folds;
  const assignment = new Int32Array(labels.length);

  // Stratify: deal each class's examples round-robin into the folds, so a rare
  // code is not entirely absent from one of them.
  const byClass = new Map<number, number[]>();
  labels.forEach((y, i) => byClass.set(y, [...(byClass.get(y) ?? []), i]));
  for (const idxs of byClass.values()) idxs.forEach((i, k) => (assignment[i] = k % folds));

  const predicted = new Int32Array(labels.length);
  const confidence = new Float64Array(labels.length);

  for (let f = 0; f < folds; f++) {
    progress(f, opt.epochs + folds, `checking fold ${f + 1} of ${folds}`);

    const trainIdx: number[] = [];
    const testIdx: number[] = [];
    for (let i = 0; i < labels.length; i++) (assignment[i] === f ? testIdx : trainIdx).push(i);
    if (!trainIdx.length || !testIdx.length) continue;

    const vocab = buildVocab(
      trainIdx.map((i) => docs[i]),
      opt.min_df,
      opt.max_features
    );
    if (!vocab.ngrams.length) continue;

    const fitted = fit(
      trainIdx.map((i) => encode(docs[i], vocab)),
      Int32Array.from(trainIdx.map((i) => labels[i])),
      vocab.ngrams.length,
      classes.length,
      // Fewer passes in cross-validation than in the final fit: this is
      // measuring the method, and four full trainings at full length is a long
      // time to hold a browser tab.
      { ...opt, epochs: Math.max(6, Math.round(opt.epochs / 2)) }
    );

    for (const i of testIdx) {
      const r = predictOne(docs[i], vocab, fitted, classes.length);
      predicted[i] = r.klass;
      confidence[i] = r.probability;
    }
  }

  return scoreOutOfFold(labels, predicted, confidence, classes, support);
}
