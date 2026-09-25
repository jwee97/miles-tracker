# Benchmarks behind the architecture decision

Run them yourself:

```
npx esbuild ml/bench/inference-cost.ts --bundle --platform=node --format=esm --outfile=/tmp/b.mjs && node /tmp/b.mjs
npx esbuild ml/bench/coldstart-cost.ts --bundle --platform=node --format=esm --outfile=/tmp/c.mjs && node /tmp/c.mjs
```

Node and Workers both run V8, so these are indicative of Worker CPU rather than
exact. They were run on the development container, 2026-09-25.

## Inference — cheap, and not the constraint

| vocab | artifact | median µs/predict | p95 µs |
|---|---|---|---|
| 5,000 | 0.4 MB | 11 | 20 |
| 20,000 | 1.7 MB | 8 | 18 |
| 50,000 | 4.2 MB | 9 | 17 |
| 120,000 | 10.1 MB | 11 | 60 |

Against a 10 ms per-request budget on Workers Free, a prediction costs about
0.1% of it. Inference was never the problem.

## Cold start — the cost that actually matters

| vocab | JSON size | JSON parse | base64 weights | b64 decode | vocab Map build |
|---|---|---|---|---|---|
| 5,000 | 1.9 MB | 18 ms | 0.5 MB | 0.17 ms | 6 ms |
| 20,000 | 7.5 MB | 76 ms | 1.9 MB | 0.49 ms | 51 ms |
| 50,000 | 18.7 MB | 181 ms | 4.8 MB | 1.06 ms | 87 ms |
| 120,000 | 44.9 MB | 495 ms | 11.5 MB | 2.48 ms | 189 ms |

Two things follow.

Shipping weights as JSON is wasteful and shipping them as base64 typed arrays
is nearly free — 0.5 ms against 181 ms at 50k features. The vocabulary Map is
the irreducible part, because a string→index lookup has to exist.

**The correction that changed the decision.** Read against the 10 ms
per-request limit, these numbers say no self-trained model can ever cold-start
in a Worker, and that is how they were first read here. It is wrong. Cloudflare
budgets module initialisation separately, at 1 second, on both Free and Paid —
so a 50k-feature model loading in ~88 ms of startup CPU is comfortably
deployable, and only the first request after an isolate starts pays anything
unusual at all.

So compute does not rule out a self-trained classifier on the Free plan. The
reason not to train one is the amount of labelled data, which is a different
argument and is made in `docs/intelligence-architecture.md`.
