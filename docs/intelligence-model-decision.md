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

### Chosen architecture

**D — no ML yet.** Deterministic evidence resolution, with the machinery for
option C (hybrid) built and left unwired.

What runs in production: descriptor parsing → exact alias → processor-stripped
alias → fuzzy candidate → per-merchant MCC evidence distribution → confidence →
either resolve, resolve-with-uncertainty, or ask. Implemented in
`src/intelligence/merchants/{normalize,resolve,reward-impact}.ts` over the
existing `merchant_mcc_evidence` table.

What is built but does not run: a model registry (`ml_models`), a prediction
log with provenance (`merchant_predictions`), a label corpus
(`merchant_training_labels`), and two resolution steps — `self_trained_ml` and
`external` — that currently record *"no model deployed"* in the trail rather
than being absent from it. Dropping a classifier in is a registry row and a
function body, not a schema change.

### Why

Not because ML is unsuitable for the task — descriptor→MCC is a textbook text
classification problem — but because **there are zero labels to train on**:

```
seeded mcc_codes rows:      924   (code → category dictionary, not labels)
seeded merchant_mcc rows:     0
seeded descriptor labels:     0
```

The app is single-user by construction, so every label must come from this
person answering a review. At ~20–40 distinct new descriptors a month, of which
only the answered ones become labels, a 1,800-label corpus is a multi-year
proposition — and 924 MCC codes against a few hundred labels is hopeless per
class regardless of total.

Two things that were *not* reasons, recorded because they were checked and came
back the other way:

- **Compute is not a reason.** Inference measures 8–11 µs and cold start 88 ms
  at 50k features, against a module-init budget of 1 second that Cloudflare
  bills separately from the 10 ms request limit. The first reading of these
  numbers here concluded a model could never load; that was wrong, and the
  correction is kept in `ml/bench/README.md` rather than quietly fixed.
- **Cost is not a reason.** A self-trained artifact costs nothing to serve.

The reason is data, and only data.

### Alternatives tested

| Option | Score | Why not |
|---|---|---|
| A — self-trained TF-IDF + logistic regression | 39 | 0 labels. Benchmarked anyway: fast enough, trainable in minutes, simply has nothing to learn from. |
| B — Workers AI | 37 | **The catalogue has no merchant or MCC classifier.** Its only text classifiers are `distilbert-sst-2-int8` (sentiment) and `bge-reranker-base` (reranking). Embeddings (`bge-*`) are real and need no labels — but with no labelled merchant set to embed *against*, they would buy a network dependency, a privacy cost and a quota failure mode for nothing measurable. |
| C — hybrid | 53 | The right destination; premature as an implementation while its ML half is empty. Its interfaces ship. |
| **D — deterministic** | **62** | Chosen. |

Precision at high confidence was weighted heaviest. D wins it because it
**abstains**: it answers from evidence it has and otherwise asks. A confidently
wrong MCC is worse than a question, because it silently recommends the wrong
card and nothing in the ledger looks unusual afterwards.

### Data available

| | Count |
|---|---|
| MCC dictionary (`mcc_codes`) | 924 codes → 18 categories |
| Confirmed descriptor labels | 0 at time of writing; grows by one per MCC confirmation |
| Merchant evidence rows | Per observation, weighted `user 100 / statement 40 / sms 20 / seed 5`, confirmed +200 |
| External corpora used | None. No US merchant dataset was imported — it does not describe Singapore acquirer behaviour, and importing it as if it did is exactly the failure this design is organised against. |

Labels are captured at the one moment a person actually asserts something —
`resolveReview()` calls `recordTrainingLabel()` with `source='user_confirmed'`,
the only source that table accepts. Export
(`exportTrainingData()`) emits `normalized_descriptor, processor, country,
confirmed_mcc, category, channel` — no amounts, no dates, no card identifiers,
no account numbers.

### Validation metrics

Because nothing is predicted, the metric today is **resolution quality**, not
model accuracy:

- coverage: share of transactions resolved without a question
- abstention rate: share sent to review
- correction rate: resolutions a person later overrode — the one that matters,
  since it counts confident errors
- reward-impact triage: share of questions avoided because every candidate MCC
  paid the same on every card held

When a model exists, the gate it must pass before being registered as active:
macro-F1 and per-class precision on a held-out split, plus calibration —
predictions at claimed confidence ≥0.85 must be right at least 85% of the time,
measured on `merchant_predictions` against later confirmations.

### Production cost

£0. No Neurons, no inference, no network calls, no added per-request CPU beyond
the SQL the resolver already runs. A future 50k-feature artifact would add
~4.8 MB to the bundle and ~88 ms of one-time isolate startup.

### Cloudflare compatibility

Runs inside the 10 ms request budget and the 128 MB isolate today. The reserved
ML path was sized against real limits rather than assumed ones: weights ship as
base64 typed arrays (1 ms to decode at 50k features, against 181 ms for the
same data as JSON), and the vocabulary Map build lands in module init, which is
budgeted at 1 second on Free and Paid alike. No Python at inference time, ever
— training scaffolding is offline only.

### Failure and fallback

- Ambiguous evidence → resolve with uncertainty, or ask; never a silent pick.
- **Reward-impact triage decides whether ambiguity is worth a question.**
  `rewardImpactOfUncertainty()` runs the real recommendation engine once per
  candidate MCC; if every candidate names the same card at the same value, the
  uncertainty is `outcome_insensitive` and no question is asked. Only a spread
  above `MCC_REVIEW_MIN_GAIN_CENTS` (default 50¢) earns one.
- A registered model that fails to load, or predicts below
  `MCC_LOW_CONFIDENCE`, falls through to the deterministic answer. There is no
  state in which a missing model blocks a resolution.
- User-confirmed evidence is never overwritten by any automated source.
- Every resolution carries a trail of which step produced it, so a bad answer
  can be traced to the rule that made it.

### What flips this decision

`GET /api/intelligence/readiness` measures the live corpus against:
**≥1,500 confirmed labels, ≥50 per category, ≥8 categories, ≥200 merchants.**
It reports the current standing and what is blocking, so the decision
re-evaluates itself against data rather than against opinion.

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

£0. Arithmetic over rows already in D1. Pattern scanning and forecast
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
| Chosen | D — deterministic, hybrid interfaces reserved | D — statistical |
| Blocking reason | Zero labelled descriptors | No suitable model; insufficient per-dimension history |
| Workers AI | No classifier for the task; embeddings deferred | No tabular/time-series model at all |
| ML in request path | None | None |
| Cost | £0 | £0 |
| Re-decision mechanism | Readiness gate on the live corpus | Stored forecasts scored against actuals |

The two projects were decided independently and happened to land on the same
letter for entirely different reasons: Project 1 has the right algorithm and no
data, Project 2 has data and no algorithm worth adding.
