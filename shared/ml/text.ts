/**
 * Turning a descriptor into features.
 *
 * Shared deliberately. The trainer and the Worker must extract features in
 * exactly the same way or the model scores nonsense — and the failure is
 * silent, because a mismatched vocabulary just looks like a model that
 * performs worse than it did in testing. One implementation, two callers.
 *
 * Character n-grams rather than words, because statement text is not prose.
 * `KOPITIAM 88 OUTLET 3`, `KOPI TIAM 88`, `KPTM88` and `KOPITAM 88` are the
 * same shop to a character model and four unrelated tokens to a word model.
 */

export const NGRAM_MIN = 3;
export const NGRAM_MAX = 5;

/**
 * The text a model sees.
 *
 * Padded with a space at each end so that the start and end of the string are
 * themselves features — `_sq` at the front of a descriptor means something
 * different from `sq` in the middle of one.
 */
export function prepare(descriptor: string): string {
  return ` ${descriptor.toLowerCase().replace(/[^a-z0-9& ]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

/** Every character n-gram in the descriptor, with how often it appears. */
export function ngrams(descriptor: string, min = NGRAM_MIN, max = NGRAM_MAX): Map<string, number> {
  const s = prepare(descriptor);
  const out = new Map<string, number>();
  if (s.trim() === '') return out;

  for (let n = min; n <= max; n++) {
    for (let i = 0; i + n <= s.length; i++) {
      const g = s.slice(i, i + n);
      out.set(g, (out.get(g) ?? 0) + 1);
    }
  }
  return out;
}

/**
 * Term frequency, sub-linear.
 *
 * `1 + log(count)` rather than the raw count: a descriptor that repeats a
 * fragment four times is not four times as much about it, and long merchant
 * names would otherwise dominate short ones purely by length.
 */
export const tf = (count: number): number => 1 + Math.log(count);

/**
 * The document vector for one descriptor, against a known vocabulary.
 *
 * L2-normalised, so a long descriptor and a short one are comparable. Features
 * the vocabulary does not contain are dropped — which is the standard thing to
 * do, and also the honest one: an n-gram the model never saw carries no
 * information about what it means.
 */
export function vectorize(
  descriptor: string,
  idf: (ngram: string) => number | undefined
): { ngram: string; value: number }[] {
  const counts = ngrams(descriptor);
  const raw: { ngram: string; value: number }[] = [];

  for (const [g, c] of counts) {
    const w = idf(g);
    if (w === undefined) continue;
    raw.push({ ngram: g, value: tf(c) * w });
  }

  let norm = 0;
  for (const r of raw) norm += r.value * r.value;
  norm = Math.sqrt(norm);
  if (norm === 0) return [];

  for (const r of raw) r.value /= norm;
  return raw;
}

/** Numerically stable softmax, so a confident score does not become NaN. */
export function softmax(scores: number[]): number[] {
  let max = -Infinity;
  for (const s of scores) if (s > max) max = s;
  let sum = 0;
  const out = new Array(scores.length);
  for (let i = 0; i < scores.length; i++) {
    const e = Math.exp(scores[i] - max);
    out[i] = e;
    sum += e;
  }
  for (let i = 0; i < out.length; i++) out[i] /= sum;
  return out;
}
