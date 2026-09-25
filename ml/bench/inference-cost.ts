/**
 * What a TF-IDF + logistic-regression classifier actually costs in a Worker.
 *
 * The Workers Free plan allows 10ms of CPU per request. That number decides
 * whether a self-trained classifier can run in production at all, and it is
 * not a number anyone should guess at — so this builds a model of the size the
 * merchant task would need and times the inference path on the same V8 the
 * Worker runs.
 *
 * Measured, not assumed: the spec's own instruction is "Do NOT assume a model
 * is small enough."
 */

const CLASSES = 18; // the app's 18 spend categories
const NGRAM_MIN = 3;
const NGRAM_MAX = 5;

/** Char n-grams, the feature set a descriptor classifier would use. */
function ngrams(s: string, lo = NGRAM_MIN, hi = NGRAM_MAX): string[] {
  const t = ` ${s.toLowerCase().trim()} `;
  const out: string[] = [];
  for (let n = lo; n <= hi; n++) {
    for (let i = 0; i + n <= t.length; i++) out.push(t.slice(i, i + n));
  }
  return out;
}

/** A vocabulary of the size a char 3–5 gram model over merchant text reaches. */
function buildModel(vocabSize: number) {
  const vocab = new Map<string, number>();
  const chars = 'abcdefghijklmnopqrstuvwxyz 0123456789';
  let i = 0;
  // Deterministic synthetic vocabulary: the cost is a function of size and
  // hashing, not of which strings happen to be in it.
  while (vocab.size < vocabSize) {
    let g = '';
    let x = i++;
    for (let k = 0; k < 4; k++) {
      g += chars[x % chars.length];
      x = Math.floor(x / chars.length);
    }
    vocab.set(g, vocab.size);
  }
  const idf = new Float32Array(vocabSize);
  for (let k = 0; k < vocabSize; k++) idf[k] = 1 + Math.log((vocabSize + 1) / (k + 2));
  // Dense weight matrix, which is what a one-vs-rest logistic regression is.
  const weights = new Float32Array(vocabSize * CLASSES);
  for (let k = 0; k < weights.length; k++) weights[k] = ((k * 2654435761) % 1000) / 1000 - 0.5;
  return { vocab, idf, weights };
}

function predict(model: ReturnType<typeof buildModel>, descriptor: string): number {
  const grams = ngrams(descriptor);
  const counts = new Map<number, number>();
  for (const g of grams) {
    const ix = model.vocab.get(g);
    if (ix !== undefined) counts.set(ix, (counts.get(ix) ?? 0) + 1);
  }
  let norm = 0;
  for (const [ix, c] of counts) {
    const v = (1 + Math.log(c)) * model.idf[ix];
    counts.set(ix, v);
    norm += v * v;
  }
  norm = Math.sqrt(norm) || 1;

  const scores = new Float64Array(CLASSES);
  for (const [ix, v] of counts) {
    const w = v / norm;
    const base = ix * CLASSES;
    for (let c = 0; c < CLASSES; c++) scores[c] += w * model.weights[base + c];
  }
  let best = 0;
  for (let c = 1; c < CLASSES; c++) if (scores[c] > scores[best]) best = c;
  return best;
}

const DESCRIPTORS = [
  'SQ *BLUE BOTTLE COFF SG',
  'GRAB*RIDE 8829 SINGAPORE SG',
  'NTUC FAIRPRICE FINEST 203 SINGAPORE',
  'PAYPAL *STEAMGAMES 4029357733',
  'SHOPEE SINGAPORE PTE LTD',
  'AMAZE*LAZADA SINGAPORE SG',
  'DBS PAYLAH TRANSFER 99281',
  'KOPITIAM 88 BEDOK SG',
];

const sizes = [5_000, 20_000, 50_000, 120_000];
console.log('vocab\tartifact\tbuild ms\tmedian µs/predict\tp95 µs\t1k-predict ms');

for (const size of sizes) {
  const t0 = process.hrtime.bigint();
  const model = buildModel(size);
  const buildMs = Number(process.hrtime.bigint() - t0) / 1e6;

  // Warm up, then measure.
  for (let i = 0; i < 200; i++) predict(model, DESCRIPTORS[i % DESCRIPTORS.length]);

  const samples: number[] = [];
  for (let i = 0; i < 2000; i++) {
    const s = process.hrtime.bigint();
    predict(model, DESCRIPTORS[i % DESCRIPTORS.length]);
    samples.push(Number(process.hrtime.bigint() - s) / 1000);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const p95 = samples[Math.floor(samples.length * 0.95)];

  // A float32 weight matrix plus the vocabulary strings, as shipped.
  const weightBytes = size * CLASSES * 4;
  const vocabBytes = size * 12;
  const artifactMb = (weightBytes + vocabBytes) / 1e6;

  console.log(
    `${size}\t${artifactMb.toFixed(1)} MB\t${buildMs.toFixed(0)}\t${median.toFixed(0)}\t${p95.toFixed(0)}\t${((median * 1000) / 1000).toFixed(1)}`
  );
}
