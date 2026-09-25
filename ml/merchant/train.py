"""Train a descriptor -> MCC-category classifier, offline.

This script is deliberately small and deliberately boring. Character n-grams
plus logistic regression is not fashionable, but it is the right shape for the
problem: statement descriptors are short, noisy, and full of abbreviations and
misspellings that word tokenisation destroys and character n-grams survive.

It refuses to run on too little data rather than producing a model nobody
should trust. See docs/intelligence-model-decision.md for the thresholds and
why they are where they are.
"""

from __future__ import annotations

import base64
import json
import pathlib
import sys
from collections import Counter

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import classification_report, f1_score
from sklearn.model_selection import StratifiedKFold, cross_val_predict

ROOT = pathlib.Path(__file__).resolve().parents[2]
DATA = ROOT / "ml" / "merchant" / "data" / "labels.jsonl"
OUT = ROOT / "ml" / "merchant" / "artifacts"

MIN_LABELS = 1500
MIN_PER_CLASS = 50
MIN_CLASSES = 8
HIGH_CONFIDENCE = 0.85


def load() -> list[dict]:
    if not DATA.exists():
        sys.exit(f"no corpus at {DATA} — run: npm run ml:export-training-data")
    rows = [json.loads(line) for line in DATA.read_text().splitlines() if line.strip()]
    return [r for r in rows if r.get("normalized_descriptor") and r.get("category")]


def gate(rows: list[dict]) -> tuple[list[str], list[str]]:
    counts = Counter(r["category"] for r in rows)
    usable = {c for c, n in counts.items() if n >= MIN_PER_CLASS}

    problems = []
    if len(rows) < MIN_LABELS:
        problems.append(f"{len(rows)} labels, need {MIN_LABELS}")
    if len(usable) < MIN_CLASSES:
        problems.append(f"{len(usable)} categories with >={MIN_PER_CLASS} labels, need {MIN_CLASSES}")
    if problems:
        sys.exit("not enough confirmed data to train anything meaningful:\n  - " + "\n  - ".join(problems))

    kept = [r for r in rows if r["category"] in usable]
    return [r["normalized_descriptor"] for r in kept], [r["category"] for r in kept]


def main() -> None:
    rows = load()
    X, y = gate(rows)

    vec = TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5), min_df=2, max_features=50_000)
    clf = LogisticRegression(max_iter=2000, C=4.0, class_weight="balanced")

    features = vec.fit_transform(X)

    # Cross-validated predictions, so the reported numbers are out-of-fold
    # rather than the model grading its own homework.
    folds = StratifiedKFold(n_splits=5, shuffle=True, random_state=0)
    proba = cross_val_predict(clf, features, y, cv=folds, method="predict_proba")
    classes = np.unique(y)
    predicted = classes[proba.argmax(axis=1)]
    confidence = proba.max(axis=1)

    macro_f1 = float(f1_score(y, predicted, average="macro"))
    high = confidence >= HIGH_CONFIDENCE
    high_precision = float((predicted[high] == np.array(y)[high]).mean()) if high.any() else 0.0

    print(classification_report(y, predicted, zero_division=0))
    print(f"macro F1                    {macro_f1:.3f}")
    print(f"high-confidence share       {high.mean():.3f}")
    print(f"high-confidence precision   {high_precision:.3f}")

    clf.fit(features, y)

    OUT.mkdir(parents=True, exist_ok=True)
    weights = np.asarray(clf.coef_, dtype=np.float32)

    # Weights as base64 float32, not JSON: measured at 50k features, JSON costs
    # 181 ms to parse and base64 costs 1 ms. Module init is budgeted at 1 s, so
    # this is the difference between comfortable and careless.
    (OUT / "model.json").write_text(
        json.dumps(
            {
                "architecture": "tfidf_char_wb_3_5 + logistic_regression_ovr",
                "classes": list(map(str, clf.classes_)),
                "vocabulary": {t: int(i) for t, i in vec.vocabulary_.items()},
                "idf": [float(v) for v in vec.idf_],
                "intercept": [float(v) for v in clf.intercept_],
                "coef_shape": list(weights.shape),
                "coef_b64": base64.b64encode(weights.tobytes()).decode(),
                "high_confidence": HIGH_CONFIDENCE,
            }
        )
    )
    (OUT / "metrics.json").write_text(
        json.dumps(
            {
                "training_examples": len(X),
                "macro_f1": round(macro_f1, 4),
                "high_confidence_precision": round(high_precision, 4),
                "high_confidence_share": round(float(high.mean()), 4),
                "classes": len(classes),
            },
            indent=2,
        )
    )
    print(f"\nwrote {OUT}/model.json and metrics.json")
    print("Register with POST /api/intelligence/models — it enters as a candidate, not as active.")


if __name__ == "__main__":
    main()
