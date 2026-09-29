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
 * Which feature extractor a model was trained with.
 *
 * Bumped whenever the features change. A model scored with a different
 * extractor than it was trained with produces confident nonsense — the weights
 * are attached to n-grams that no longer mean the same thing — and nothing
 * about the output would look wrong. So the version travels with the model and
 * a mismatch refuses to answer.
 *
 * 1 — character 3–5 grams of the descriptor, and nothing else.
 * 2 — plus the structure the parser already recovers: which processor routed
 *     the payment, which country the terminal was in, whether the line carried
 *     a reference number, and how long the name is.
 */
export const FEATURE_VERSION = 2;

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

/**
 * Structure the descriptor carries that its characters do not.
 *
 * The first version of this model saw nothing but character n-grams, which
 * threw away things the parser had already worked out and that predict a code
 * strongly. `SQ *` means a small independent merchant on Square, and that is a
 * different distribution of codes from the same name arriving through an
 * airline's own gateway. A foreign country marker changes it again. None of
 * that is recoverable from the letters alone once the prefix has been
 * stripped, and it was being stripped.
 *
 * Prefixed with `` so these can never collide with a real n-gram.
 */
export function structureTokens(descriptor: string): string[] {
  const raw = (descriptor ?? '').toString();
  const tokens: string[] = [];

  const processor = raw.match(/^\s*(sq|sqc|stripe|paypal|pp|grab|amaze|shopback|fave|adyen|2c2p|nets|wl)\s*[*\s]/i);
  if (processor) tokens.push(`\u0001proc=${processor[1].toLowerCase()}`);

  const country = raw.match(/\b(sg|sgp|singapore|my|mys|hk|hkg|us|usa|au|aus|jp|jpn|gb|uk)\b\s*$/i);
  if (country) tokens.push(`\u0001country=${country[1].toLowerCase()}`);

  // A trailing reference number marks a terminal-generated line, which skews
  // toward physical acceptance rather than a web checkout. Looked for before
  // the country marker as well as at the very end, since a statement prints
  // "… 8829 SG" as often as "… 8829".
  if (/\s\d{4,}\s*(?:[a-z]{2,3}\s*)?$/i.test(raw)) tokens.push('\u0001ref');
  if (/\b(?:www\.|https?:|\.com|\.sg\b)/i.test(raw)) tokens.push('\u0001web');

  // Length in coarse buckets. Long descriptors are aggregators and marketplaces;
  // short ones are shops.
  const words = prepare(raw).trim().split(/\s+/).filter(Boolean).length;
  tokens.push(`\u0001words=${words <= 1 ? '1' : words <= 3 ? '2-3' : words <= 6 ? '4-6' : '7+'}`);

  return tokens;
}

/**
 * Every feature the model sees, with how often it appears.
 *
 * Character n-grams plus the structure tokens above. Callers pass extra
 * context — the channel a purchase came through, for instance — where they
 * have it; the trainer and the Worker must pass the same things or the
 * weights mean nothing, which is what `FEATURE_VERSION` guards.
 */
export function ngrams(
  descriptor: string,
  min = NGRAM_MIN,
  max = NGRAM_MAX,
  context: { channel?: string | null } = {}
): Map<string, number> {
  const s = prepare(descriptor);
  const out = new Map<string, number>();
  if (s.trim() === '') return out;

  for (let n = min; n <= max; n++) {
    for (let i = 0; i + n <= s.length; i++) {
      const g = s.slice(i, i + n);
      out.set(g, (out.get(g) ?? 0) + 1);
    }
  }

  for (const t of structureTokens(descriptor)) out.set(t, 1);
  if (context.channel) out.set(`\u0001channel=${context.channel.toLowerCase()}`, 1);

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
