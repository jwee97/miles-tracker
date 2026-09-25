# Intelligence architecture study

Two projects were asked for: merchant/MCC intelligence, and predictive spend.
This is the study that decides what each should be built from, before any
production ML was written. The brief's own framing is the one used here — the
task is not "add AI", it is "make Miles Tracker more intelligent while
preserving correctness."

The conclusion is different for the two projects, and neither conclusion is
"train a model now."

---

## 0. The principle that does not move

```
statistics / ML          estimates an uncertain fact
        ↓
deterministic engine     decides what that fact is worth
        ↓
financial decision
```

The rules engine, caps, statement cycles, requirements, eligibility and
reconciliation stay authoritative. Nothing in either project is allowed to
predict a reward. The most a model may ever say here is *"this descriptor is
probably MCC 5814"* or *"dining spend next week is probably $95–$140"*; what
those imply is arithmetic the existing engine already does.

---

## 1. What the repository already has

Much of what the brief describes as Phase 1 exists.

| Concern | Where | State |
|---|---|---|
| Descriptor normalisation | `src/merchants/normalize.ts` | Processor prefixes, country suffixes, `GRAB*RIDE` splitting, Levenshtein similarity |
| Merchant identity | `merchants`, `merchant_aliases` | Canonical name + normalised key + aliases with confidence |
| MCC as evidence | `merchant_mcc_evidence` | Per-observation rows, weighted by source, derived distribution — already *not* one-merchant-one-MCC |
| Weighting | `src/merchants/evidence.ts` | `user: 100, statement: 40, sms: 20, seed: 5`, confirmed bonus 200 |
| Review queue | `review_items`, `src/transactions/review.ts` | Unknown codes queued rather than guessed |
| MCC dictionary | `mcc_codes` seed | **924 codes** mapped to 18 categories |

So the evidence architecture the brief asks for is largely built, and the
honest framing of this work is *what to add to it*, not what to replace.

---

## 2. The measurement that decides Project 1

### 2.1 Labelled data

```
seeded mcc_codes rows:      924      (a code → category dictionary)
seeded merchant_mcc rows:     0
seeded descriptor labels:     0
```

Every descriptor→merchant and merchant→MCC label in this system comes from one
person confirming one review. There is no imported corpus, and the app is
single-user by construction — there is no second user whose labels could help.

A character TF-IDF + logistic regression over the app's 18 categories wants
roughly 100+ examples per class before its confidence means anything: **~1,800
labelled descriptors**. At a heavy Singapore card user's volume — call it 150
transactions a month, most of them repeat merchants — distinct new descriptors
arrive at perhaps 20–40 a month, and only the ones a person actually answers
become labels. Reaching 1,800 confirmed labels is a multi-year proposition, and
reaching it *per class* is worse, because spend is not uniform across
categories.

For MCC specifically the arithmetic is hopeless: 924 codes, a few hundred
labels, most codes never observed once.

### 2.2 Compute — the check that reversed itself

The brief insists on benchmarking rather than assuming, and it was right to.

Measured (`ml/bench/`, numbers in `ml/bench/README.md`):

- Inference: **8–11 µs** per prediction at every vocabulary size tested. Against
  a 10 ms request budget this is 0.1%.
- Cold start at 50k features: **88 ms** to build the vocabulary Map, plus
  **1 ms** if weights ship as base64 typed arrays (181 ms if they ship as JSON).

Read against the Workers Free **10 ms per-request** CPU limit, those cold-start
numbers say no model can ever load, and that was the first conclusion drawn
here. It is wrong. Cloudflare budgets **module initialisation separately, at 1
second**, identically on Free and Paid. A 50k-feature classifier loading in
~88 ms of startup CPU deploys comfortably and then predicts for microseconds.

**So compute does not block a self-trained model on the Free tier.** The
argument against training one is entirely about data. Recording the reversal
because the opposite claim would have been convenient and would have looked
like diligence.

### 2.3 Workers AI, checked against the current catalogue

| Task | What is actually offered |
|---|---|
| Text classification | `distilbert-sst-2-int8` (sentiment), `bge-reranker-base` (reranking) |
| Text embeddings | `bge-small-en-v1.5` (384-dim), `bge-base-en-v1.5` (768), `bge-large-en-v1.5`, `bge-m3`, `embeddinggemma-300m`, `qwen3-embedding-0.6b` |

There is no merchant classifier and no MCC classifier. The only
classification models are a **sentiment** classifier and a **reranker** —
neither answers this question. So "Workers AI text classification" is not an
option for Project 1; it is a category that exists in the brief and not in the
catalogue.

Embeddings *are* a real option: embed a descriptor, compare against embeddings
of known merchants, take the nearest. That needs no training data at all, which
is precisely where this project is weak.

Free allocation is **10,000 Neurons/day**, and on the Free plan exceeding it
**fails the request** rather than billing. Any design that depends on it must
degrade rather than break.

---

## 3. Option scorecard — Project 1 (merchant & MCC)

Scored 1–5, 5 best. "High-confidence precision" is weighted heaviest: a model
that says *I don't know* is better than one that confidently returns the wrong
MCC, because the wrong MCC silently produces the wrong card recommendation.

| Criterion | A: self-trained | B: Workers AI embeddings | C: hybrid | D: deterministic only |
|---|---|---|---|---|
| Accuracy today (0 labels) | 1 | 3 | 4 | 3 |
| High-confidence precision | 1 | 2 | **5** | **5** |
| Calibration | 2 | 1 | 4 | 4 |
| Latency | 5 | 2 | 4 | 5 |
| Worker CPU | 4 | 5 | 5 | 5 |
| Memory / artifact size | 3 | 5 | 4 | 5 |
| Cost | 5 | 3 | 4 | 5 |
| Privacy | 5 | 2 | 4 | 5 |
| Explainability | 3 | 1 | 4 | **5** |
| Maintainability | 2 | 3 | 3 | 5 |
| Training data needed | 1 | **5** | 4 | **5** |
| Singapore performance | 2 | 2 | 4 | 4 |
| Offline availability | 5 | 1 | 4 | 5 |
| Dependency risk | 5 | 2 | 4 | 5 |
| **Total** | **39** | **37** | **53** | **62** |

Notes on the low scores, since the totals hide the reasoning:

- **A scores 1 on accuracy and precision today** purely because there is
  nothing to train on. The same column in two years could be the winner, which
  is why the design keeps the door open rather than closing it.
- **B scores 2 on privacy** because it sends merchant descriptors off-box. It
  scores 1 on explainability because "these vectors were close" is not a reason
  a person can check, and 1 on offline availability because quota exhaustion
  fails the request.
- **D scores 5 on precision** not because it is always right but because it
  *abstains* — it only answers from evidence it has, and otherwise asks.

> **Superseded 2026-09-25.** Project 1 now trains a model. The premise this
> section rests on — that there are no labels — was wrong: every imported
> statement that carried an MCC is a descriptor paired with the acquirer's own
> code, and those were excluded by a rule written to prevent training on the
> app's *own predictions*, which a bank's code is not. The measurement below is
> still what was true of the `merchant_training_labels` table at the time;
> `docs/intelligence-model-decision.md` has the revised decision and why it
> changed. Everything else in this study — the compute reversal, the Workers AI
> catalogue, Project 2 — stands.

### Decision for Project 1: **D now, C by construction**

Deterministic evidence is the production path today. But "no ML yet" is only a
defensible answer if it comes with the machinery to stop being the answer, so
this ships:

1. The full evidence pipeline, with provenance on every resolution.
2. **Training-label capture** on every confirmation, so the corpus starts
   filling from day one.
3. A **readiness gate** that measures the real corpus against stated thresholds
   and reports how far off it is — the decision re-evaluates itself against
   data instead of against opinion.
4. A model registry and a provenance field, so a classifier can be dropped in
   without schema work.

Workers AI embeddings are deliberately **not** wired up yet: with zero labels
there is nothing to embed *against*, so it would add a network dependency, a
privacy cost and a quota failure mode in exchange for nothing measurable. The
interface it would plug into exists.

---

## 4. Option scorecard — Project 2 (forecasting)

| Criterion | A: self-trained tabular | B: Workers AI | C: hybrid | D: statistical |
|---|---|---|---|---|
| Accuracy at <6 months history | 1 | 1 | 2 | 4 |
| Interval calibration | 2 | 1 | 3 | 4 |
| Latency | 4 | 2 | 3 | 5 |
| Worker CPU | 3 | 5 | 4 | 5 |
| Cost | 5 | 2 | 3 | 5 |
| Privacy | 5 | 1 | 3 | 5 |
| Explainability | 2 | 1 | 2 | **5** |
| Maintainability | 2 | 3 | 2 | 5 |
| Training data needed | 1 | 3 | 2 | **5** |
| Backtestability | 4 | 1 | 3 | 5 |
| Dependency risk | 5 | 1 | 3 | 5 |
| **Total** | **34** | **21** | **30** | **53** |

Workers AI scores worst of the four, and it is worth saying why plainly: **the
catalogue contains no tabular or time-series model.** Forecasting through
Workers AI would mean asking a generative LLM to predict a number, which is
unbacktestable, uncalibrated, non-reproducible, costs a network round trip, and
the brief explicitly warns against it. It is not a close call.

A self-trained gradient-boosted model is a real option *later*. It needs
per-category history measured in months; with 18 categories and weekly grain, a
year of data is ~52 rows per category, which is not enough to beat an EWMA that
has no parameters to overfit.

### Decision for Project 2: **D, statistical, with the gate that would change it**

Recurring-transaction detection, then EWMA/moving-average/mean baselines,
chosen **per dimension by rolling backtest**. Every forecast is stored and
scored against what actually happened, so the claim "the model is better than
the baseline" becomes a measurement the app can answer rather than an
assertion. If a tabular model ever beats the baselines on held-out data, the
promotion criteria are written down and the storage already exists.

---

## 5. What gets built

| | Project 1 | Project 2 |
|---|---|---|
| Production method | Deterministic evidence + fuzzy | Recurring detector + statistical baselines |
| ML today | None | None |
| Gate to change that | Labelled-corpus readiness thresholds | Rolling backtest vs baseline |
| Workers AI | Interface only, not wired | Rejected outright |
| Cost on Free tier | S$0, no Neurons, no extra CPU | S$0 |

And the feature that motivated the whole exercise, which needs no ML at all:
**reward-impact-aware review**. Two candidate MCCs that pay the same on every
card you hold are not worth a question; two that differ by 4 mpd are worth
asking about even at high confidence. That is uncertainty × consequence, it
runs entirely on the existing rules engine, and it is the single largest
improvement available here.

---

## 6. What would change these decisions

**Project 1** flipped, in the event, for a reason not on this list: the corpus
was already there. The gate itself survives with different numbers, tuned to
the model that actually exists — see `docs/intelligence-model-decision.md`.
`GET /api/intelligence/readiness` reports current standing against them.

It flips to Workers AI embeddings sooner if a legally reusable **Singapore**
merchant corpus appears — the constraint there is geography, not licensing in
general. US merchant data does not describe Singapore acquirer behaviour, and
importing it as though it did would put confident wrong MCCs into the evidence
table, which is the specific failure this whole design is organised against.

**Project 2** flips to a tabular model when ≥12 months of history exists in a
dimension *and* a rolling backtest shows it beating the best baseline on MAE
with interval coverage within 5 points of nominal.
