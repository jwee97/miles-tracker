# Offline merchant classifier

**Nothing here is deployed.** `docs/intelligence-model-decision.md` records why:
there are currently zero confirmed descriptor labels, and a classifier trained
on nothing has confidence that means nothing.

This directory exists so that the day the readiness gate passes, the training
path is a script that already runs rather than a project that has to be
started. It is also the reason the Worker carries `ml_models`,
`merchant_predictions` and a `self_trained_ml` step in the resolution trail —
the seam is cut, the part just isn't made yet.

## The path

```
GET /api/intelligence/readiness          # is there enough data?
npm run ml:export-training-data          # → ml/merchant/data/labels.jsonl
python -m venv .venv && . .venv/bin/activate
pip install -r ml/merchant/requirements.txt
python ml/merchant/train.py              # → ml/merchant/artifacts/
POST /api/intelligence/models            # register as a candidate
POST /api/intelligence/models/promote    # only if it clears the bar
```

## Rules this path does not bend

- **Only user-confirmed labels.** The exporter serves one source and the table
  accepts one source. Training on the app's own predictions teaches it its own
  mistakes with increasing confidence.
- **No Python in production.** The artifact is JSON plus base64 weights; the
  Worker reads it in TypeScript. Measured cost: ~88 ms of module-init CPU at
  50k features, ~9 µs per prediction (`ml/bench/README.md`).
- **Registering is not deploying.** A model enters as `candidate` and must
  clear macro-F1 ≥ 0.75 and high-confidence precision ≥ 0.85 to be promoted,
  with the metrics stored alongside it.
- **Promotion retires, it never deletes.** Rollback is flipping two rows, and
  `/api/intelligence/models` lists the predictions a retired model made while
  it was in charge.
- **No foreign corpus.** A US merchant dataset does not describe Singapore
  acquirer behaviour, and importing one would put confident wrong MCCs into the
  evidence table — the exact failure this design is organised against.
