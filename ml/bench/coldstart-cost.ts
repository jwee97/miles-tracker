/**
 * What a Worker pays to LOAD a model, which is the cost that actually matters.
 *
 * The first benchmark showed inference is ~10µs — nowhere near the 10ms Free
 * budget. That makes the interesting question the other one: a Worker isolate
 * starts cold, and whatever the module does at import time is CPU billed to
 * whichever unlucky request triggered the start. A 4 MB weight matrix has to
 * become a typed array before the first prediction, and that is where a
 * self-trained classifier either fits or does not.
 */

const CLASSES = 18;

function makeArtifact(vocabSize: number): { json: string; b64: string } {
  const vocab: Record<string, number> = {};
  const chars = 'abcdefghijklmnopqrstuvwxyz 0123456789';
  let n = 0;
  for (let i = 0; n < vocabSize; i++) {
    let g = '';
    let x = i;
    for (let k = 0; k < 4; k++) {
      g += chars[x % chars.length];
      x = Math.floor(x / chars.length);
    }
    if (vocab[g] === undefined) vocab[g] = n++;
  }
  const weights = new Float32Array(vocabSize * CLASSES);
  for (let k = 0; k < weights.length; k++) weights[k] = ((k * 2654435761) % 1000) / 1000 - 0.5;

  // Two shipping formats: plain JSON, and base64 typed arrays (the compact one).
  const json = JSON.stringify({ vocab, weights: Array.from(weights) });
  const b64 = Buffer.from(weights.buffer).toString('base64');
  return { json, b64 };
}

console.log('vocab\tJSON size\tJSON parse ms\tb64 size\tb64 decode ms\tvocab build ms');

for (const size of [5_000, 20_000, 50_000, 120_000]) {
  const { json, b64 } = makeArtifact(size);
  const vocabJson = JSON.stringify(
    Object.fromEntries(Object.entries(JSON.parse(json).vocab as Record<string, number>))
  );

  const t1 = process.hrtime.bigint();
  JSON.parse(json);
  const parseMs = Number(process.hrtime.bigint() - t1) / 1e6;

  const t2 = process.hrtime.bigint();
  const buf = Buffer.from(b64, 'base64');
  new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const b64Ms = Number(process.hrtime.bigint() - t2) / 1e6;

  const t3 = process.hrtime.bigint();
  const v = new Map<string, number>(Object.entries(JSON.parse(vocabJson) as Record<string, number>));
  const vocabMs = Number(process.hrtime.bigint() - t3) / 1e6;
  void v;

  console.log(
    `${size}\t${(json.length / 1e6).toFixed(1)} MB\t${parseMs.toFixed(1)}\t${(b64.length / 1e6).toFixed(1)} MB\t${b64Ms.toFixed(2)}\t${vocabMs.toFixed(1)}`
  );
}
