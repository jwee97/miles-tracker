# Model decision record

The study is `docs/intelligence-architecture.md`; the measurements are in
`ml/bench/README.md`. This is the short, checkable record of what was chosen,
in the form the brief asked for: one section per project, decided
independently, with the numbers that decided it and the conditions that would
overturn it.

Date: 2026-09-25. Both decisions are re-evaluated by measurement, not by
review — see **Failure and fallback** and the readiness/backtest endpoints.

---

## Project 1 — Merchant & MCC intelligence

> **Revised 2026-09-25, after the original decision.** This section previously
> read "D — no ML yet". It now reads "A — self-trained", because a premise
> underneath the original decision turned out to be wrong. The original
> reasoning is kept at the end of this section rather than deleted: a decision
> record that quietly rewrites itself is worth nothing.

### Chosen architecture

**A — self-trained.** A multinomial logistic regression over character
3–5-grams of the descriptor, predicting the merchant code directly.

- Trained **in the browser** (`shared/ml/train.ts`), on the owner's own device.
- Stored in D1 as **one row per n-gram** (`ml_model_features`).
- Inferred in the Worker by fetching only the n-grams the descriptor actually
  contains (`src/intelligence/models/classifier.ts`).
- Consulted **only** at step 7 of the nine-step resolution, after every form of
  evidence has found nothing.

### Why this changed

The original decision rested on a single measured fact: **zero labelled
descriptors**. That measurement was correct about the table it looked at and
wrong about the ledger.

Every imported statement that carried an MCC is a descriptor paired with **the
acquirer's own code**. Those pairs had been accumulating in
`merchant_mcc_evidence` since the first import, tagged with their source. The
original design excluded them because the rule was "only train on what a person
confirmed" — a rule written to prevent training on the app's own predictions,
which is a real hazard. But a bank's MCC is not the app's prediction. It is the
authoritative answer that a user confirmation is *trying to recover*.

So the corpus was there the whole time, mislabelled as unusable by a rule
aimed at something else. Recognising that is what changed the decision; nothing
about the compute, the catalogue or the model architecture changed at all.

Labels now come from exactly two sources, and nothing else is eligible:

| Source | What it is |
|---|---|
| `user_confirmed` | someone answered a review |
| `statement_verified` | the code the issuer put on the transaction |

`seed` rows remain excluded — a seed is somebody's note about what a merchant
usually does, not an observation of what it billed as. Anything the app
inferred remains excluded, which was the original rule's actual purpose and is
untouched.

### Alternatives tested

| Option | Verdict |
|---|---|
| **A — self-trained** | **Chosen.** Char n-grams survive the abbreviations and misspellings that destroy word tokenisation: `KOPITIAM 88`, `KOPI TIAM 88` and `KPTM88` are one shop to this model and three unrelated tokens to a word model. |
| B — Workers AI | Still rejected. The catalogue's only text classifiers are `distilbert-sst-2-int8` (sentiment) and `bge-reranker-base`. Embeddings would now be viable, but would add a network dependency, a per-request quota that *fails* on the free plan, and a privacy cost — to do worse than a model trained on this person's own codes. |
| C — hybrid | What now runs, in the only sense that matters: deterministic evidence first, model only where evidence is silent. |
| D — deterministic only | Still the fallback, still what answers whenever the model declines — which it does often, by design. |

### Data available

Harvested from the ledger, not imported from anywhere:

- every statement/SMS transaction whose bank supplied an MCC
- every MCC a person confirmed in Review

Harvesting is idempotent and runs on the daily cron. No external corpus is
used; a US merchant dataset does not describe Singapore acquirer behaviour, and
importing one would put confident wrong codes into the evidence table.

### Validation metrics

Measured out of fold, four-fold stratified, **with the vocabulary rebuilt
inside each fold**. Fitting the vectoriser before splitting lets the training
folds see which n-grams the held-out descriptors contain — a small leak that
flatters every number afterwards.

Reported and stored with the model: macro F1, accuracy, high-confidence
precision, high-confidence share, and per-code precision/recall/F1 with support.

### The promotion bar

| Requirement | Value | Why |
|---|---|---|
| Labels | ≥ 300 | Enough to have measured the two below on |
| Macro F1 | ≥ 0.55 | Low, because macro-F1 across a long tail of rare codes always is |
| **High-confidence precision** | **≥ 0.90** | The one that protects a recommendation |
| Features stored | ≥ 100 | A half-finished upload is not a model |

Lower than the 1,500 labels the architecture study named, and deliberately.
That figure was for a general 18-category classifier trained from nothing. This
model only predicts codes **this person's spending has actually presented**, at
least 25 examples each, and abstains everywhere else. The protection comes from
precision, which is measured, not from corpus size, which is a proxy.

High-confidence precision is weighted above everything because the resolver
consults the model only where evidence is silent and acts on it only above the
model's own threshold. A wrong code there produces a wrong card recommendation
and nothing in the ledger looks unusual afterwards.

### Production cost

S$0. No Neurons, no inference service, no network call. Inference is one
indexed D1 query returning a few hundred rows, plus a dot product over them —
proportional to the descriptor, not to the model. Training costs the owner's
browser a few seconds.

### Cloudflare compatibility

The reason the model is rows rather than a blob. A Worker request gets 10 ms of
CPU; deserialising a model and building its vocabulary costs tens of
milliseconds (~88 ms at 50k features, `ml/bench/README.md`). Module init has a
separate one-second budget, but a model that lives in the database cannot load
there, and a model in the bundle needs a redeploy per retrain.

Storing features as rows removes the cold start entirely and makes retraining a
write. Weights are base64 float32 — 1 ms to decode at 50k features against
181 ms for the same data as JSON.

### Failure and fallback

The model is allowed to decline, and does so in four distinct situations:

1. **No model deployed** → deterministic path, recorded in the trail.
2. **Class never seen enough** — a code with fewer than 25 examples is excluded
   from the model, so it cannot be predicted at all.
3. **Descriptor barely recognised** — below 15% n-gram overlap it returns
   nothing. This is the case that matters: a softmax hands back a
   confident-looking number for a string it has never seen anything like, and
   the overlap floor is what stops "never seen this" becoming "probably a
   restaurant".
4. **Below its own threshold** — the precision it was promoted on was measured
   above that line, not below it.

Beyond that: it is never consulted where evidence exists, so it cannot overturn
a confirmation or a bank's own code; promotion retires the incumbent rather
than deleting it; `/api/intelligence/models` lists what a retired model decided
while in charge; and every prediction records its model key and version.

### The original decision, kept

> **D — no ML yet**, scored 62 against C 53, A 39, B 37. "Not because ML is
> unsuitable for the task — descriptor→MCC is a textbook text classification
> problem — but because there are zero labels to train on."

That was right about the architecture and wrong about the data, for the reason
given above. Two things it got right are worth keeping: **compute was never the
blocker** (the benchmark that first seemed to say otherwise was misread against
the wrong CPU budget, and the correction is in `ml/bench/README.md`), and
**Workers AI has no model for this task**, which is still true.

---

## Project 2 — Predictive spend, caps and minimum spend

### Chosen architecture

**D — statistical, no ML.** Recurring-transaction detection plus a small set of
baseline forecasters, **selected per dimension by rolling-origin backtest**:
mean, moving average (window 4), EWMA (α 0.35), seasonal naive, recurring-only.
Prediction intervals from residual spread at z = 1.28 (80%).

Implemented in `src/intelligence/forecasting/{recurring,baselines,forecast}.ts`.

### Why

Every candidate ML approach loses on this data, for different reasons:

- A tabular model needs per-dimension history. Eighteen categories at weekly
  grain gives ~52 rows per category per year — not enough to beat an EWMA that
  has no parameters to overfit.
- **Workers AI has no tabular or time-series model at all.** Forecasting
  through it means asking a generative LLM for a number: unbacktestable,
  uncalibrated, non-reproducible, and a network round trip per forecast.

And the thing that actually makes this feature good is not the forecast, it is
what the deterministic engine does with it — cap headroom, statement-cycle
boundaries, minimum-spend requirements. A better point estimate moves that
answer far less than getting the cycle arithmetic right does.

### Alternatives tested

| Option | Score | Why not |
|---|---|---|
| A — self-trained tabular (GBM) | 34 | Real option later; needs ≥12 months per dimension. |
| B — Workers AI | 21 | No suitable model exists. Worst on backtestability, calibration, privacy, explainability and dependency risk simultaneously. |
| C — hybrid | 30 | Inherits B's problems without escaping A's data requirement. |
| **D — statistical** | **53** | Chosen. |

### Data available

Whatever transaction history the ledger holds — which for a new install is
none. The cold-start ladder is explicit about that rather than extrapolating
from three weeks of data: `<1 month` → no forecast; `<3` → recent-spend
estimate, low confidence; `<6` → category baseline, medium; `6+` → full model
selection, high.

No data leaves the device. No transaction is uploaded anywhere for training or
inference.

### Validation metrics

Stored, not asserted. Every forecast is written to `spend_forecasts` with the
model that produced it, and `evaluateFinishedForecasts()` scores each one once
its period has closed, into `forecast_evaluations`:

- **MAE** and **bias** (signed, so systematic over-forecasting is visible)
- **interval coverage** — share of actuals inside the 80% interval; nominal is
  80%, and a coverage of 40% means the intervals are lying
- all three broken down **by model**, so "EWMA is better here" is a query, not
  a claim

Model selection itself uses rolling-origin (forward-chained) backtesting. A
random train/test split of a time series leaks the future into the past and
would make every model look good; the code says so at the point where someone
might be tempted to simplify it.

### Production cost

S$0. Arithmetic over rows already in D1. Pattern scanning and forecast
evaluation run on cron, not in request path.

### Cloudflare compatibility

No model artifact, no module-init cost, no Neurons. The heavy passes
(`scanRecurring`, `evaluateFinishedForecasts`) are total re-derivations and
therefore idempotent — safe to re-run after a partial failure, which matters
because a Worker can be evicted mid-job.

### Failure and fallback

- Insufficient history → **no forecast**, with the reason named. Not a number
  with a shrug attached.
- A pattern unseen for 95 days retires itself rather than continuing to predict
  a subscription that was cancelled.
- Forecasts inform; they never enter a reward computation. Cap headroom and
  minimum-spend progress remain computed from posted transactions by the
  deterministic engine — the forecast only says what *might* happen to them.
- Lower interval bounds clamp at zero; a forecast never predicts negative
  spend.
- Nothing in this project tells a person to spend in order to earn. A
  minimum-spend outlook states the requirement, the progress and the shortfall,
  and stops there.

### What flips this decision

A tabular model is adopted for a dimension when it has **≥12 months of
history** *and* beats the best baseline on MAE in a rolling backtest **with
interval coverage within 5 points of nominal**. Both halves are required:
a model that is more accurate on average but whose intervals are wrong is worse
here, because the interval is what the cap and minimum-spend advice is built
on.

---

## Summary

| | Project 1 | Project 2 |
|---|---|---|
| Chosen | **A — self-trained**, behind deterministic evidence | D — statistical |
| Was | D — no ML yet (revised; see above) | unchanged |
| Workers AI | No classifier for the task | No tabular/time-series model at all |
| ML in request path | One indexed query + a dot product | None |
| Cost | S$0 | S$0 |
| Re-decision mechanism | Precision measured out of fold, per model version | Stored forecasts scored against actuals |

The two projects no longer agree, and the disagreement is the honest outcome.
Project 1 had the right algorithm and turned out to have had the data all
along, filed under a rule that was guarding against something else. Project 2
has the data and still has no algorithm worth adding — the catalogue contains
nothing that forecasts, and a year of weekly history is ~52 rows per category,
fewer than a tabular model has hyperparameters to overfit with.
