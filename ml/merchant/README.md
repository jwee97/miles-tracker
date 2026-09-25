# The merchant-code model

A classifier that reads a statement descriptor and names the merchant code it
is most likely to be, trained on the codes your own banks have already put on
your transactions.

**It trains in the browser.** Settings → *Train a code detector*. There is no
Python here and no CLI step, and that is a design decision rather than a
shortcut — see below.

## Where the code lives

| Piece | File |
|---|---|
| Feature extraction | `shared/ml/text.ts` |
| Training | `shared/ml/train.ts` |
| Inference, in the Worker | `src/intelligence/models/classifier.ts` |
| Registry and promotion | `src/intelligence/models/registry.ts` |
| Label harvesting | `src/intelligence/merchants/labels.ts` |
| The button | `web/src/ModelTrainer.tsx` |

`shared/ml/text.ts` is shared deliberately. A vectoriser that drifts from its
trainer produces a model that silently scores nonsense, and the failure looks
exactly like a model that simply turned out to be worse than expected. One
implementation, two callers, and a test that trains a model and then checks the
Worker reproduces the trainer's own predictions.

## Why the browser

Training needs the whole corpus at once. A Cloudflare Worker request gets 10 ms
of CPU, so the Worker cannot do it. That leaves a local machine or the browser,
and the browser is the one that already holds an authenticated session, already
holds the data, and is unambiguously the owner's.

Nothing is uploaded except the model: a few thousand n-gram weights, which
cannot be read back into the descriptors they came from. The spending stays
where it was.

## Where the labels come from

Two sources, and the boundary between them is the point:

- **`user_confirmed`** — someone answered a review.
- **`statement_verified`** — the code the issuer itself put on the transaction
  when it was imported.

Nothing the app inferred is ever a label. Training on your own predictions
teaches you your own mistakes with growing confidence, which is why
`merchant_mcc_evidence` records a source at all. `seed` rows are excluded too:
a seed is somebody's note about what a merchant usually does, not an
observation of what it billed as.

Harvesting is idempotent and runs on the daily cron, so the corpus is never
behind the ledger.

## Why the model lives in D1 as rows

A model in the bundle needs a redeploy every time it is retrained. A model
deserialised per request blows the 10 ms budget — measured at ~88 ms just to
build a 50k vocabulary (`ml/bench/README.md`).

So `ml_model_features` holds one row per n-gram, and inference fetches only the
few hundred n-grams the descriptor being classified actually contains. One
indexed query. Cost is proportional to the descriptor, not the model, there is
no cold start, and retraining is a write.

## What stops it doing harm

1. **It is asked last.** Step 7 of nine. By the time it is consulted, no
   confirmed alias, no user evidence and no bank-supplied code exists for that
   merchant — so it can never overturn one. The worst it can do is answer where
   the alternative was no answer.
2. **It refuses codes it barely saw.** A class with fewer than 25 examples is
   dropped from the model entirely. Those merchants keep going to Review.
3. **It refuses descriptors it barely recognises.** Below 15% n-gram overlap it
   returns nothing, because a softmax will hand back a confident-looking number
   for a string it has never seen anything like.
4. **It refuses to speak below its own threshold.** The precision it was
   promoted on was measured above that line.
5. **Promotion is a bar, not a button.** ≥300 labels, ≥0.55 macro F1, ≥0.9
   precision on the answers it calls confident, and a complete upload. The
   override exists and records that it was used.
6. **Promotion retires, it never deletes.** Rollback is one press, and
   `/api/intelligence/models` lists what a retired model decided while it was
   in charge.

## Exporting the corpus

`npm run ml:export-training-data` writes `ml/merchant/data/labels.jsonl` for
inspection or for training elsewhere. That directory is git-ignored: confirmed
descriptors are your own spending and a repository is the wrong place for them.
