#!/usr/bin/env python3
"""
Train the discipline ensemble and write a real, reproducible artifact.

Pipeline:
  NASA GES DISC publication corpus (ml/data/raw/nasa_gesdisc_publications.json)
    -> explode each publication's multi-valued research-area labels into
       (title + " " + abstract, label) pairs
    -> drop classes with < 5 examples, so the stratified 80/20 split cannot
       put a class entirely (or mostly) in one half
    -> TF-IDF (max_features=15000, English stop words, 1-2 grams)
    -> stratified 80/20 split
    -> soft-voting ensemble of MultinomialNB + LogisticRegression +
       RandomForestClassifier
    -> accuracy + macro-F1 + confusion matrix -> ml/models/metrics.json
    -> {vectorizer, model} -> ml/models/discipline_ensemble_v1.joblib
    -> one MLModelVersion row naming the three component model types

Run it:  ml/.venv/bin/python ml/scripts/train_ensemble.py

**Why an ensemble.** The previous single model was selected from two linear
candidates on cross-validated macro-F1. Three base learners with genuinely
different inductive biases vote instead: a generative count model, a
discriminative linear model, and an axis-aligned tree ensemble. Soft voting
averages their `predict_proba`, so a class only wins if more than one of them
thinks it is likely — which is more robust than any one of them alone on a
taxonomy with 21 classes and real multi-label overlap.

**The artifact shape changed.** The vectoriser is now a sibling of the model
rather than a Pipeline step, because `VotingClassifier` is composed over three
estimators that all consume the same matrix — there is no single Pipeline step
to hang it on. `app/classifier.py` reads `vectorizer`/`model` accordingly; the
`/classify` response contract is unchanged.

**Honest limits.** Two, both stated in the README as well:
  - The labels are GES DISC's 21 Earth-science research areas, not NCPOR's
    discipline taxonomy. Overlapping, not identical.
  - Publications carry multiple research areas. Exploding them into pairs
    duplicates the same text across labels, so one abstract can appear in the
    training set under "Validation" and under "Cryospheric Indicators". The
    resulting accuracy is single-label accuracy over a duplicated corpus, not
    a multi-label score, and it is flattered by that duplication.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import Counter
from datetime import datetime, timezone

import joblib
import numpy as np
from sklearn.ensemble import RandomForestClassifier, VotingClassifier
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix, f1_score
from sklearn.model_selection import train_test_split
from sklearn.naive_bayes import MultinomialNB
from sklearn.pipeline import Pipeline

ML_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
# `app.config` is imported lazily inside register_model_version(), so ml/ has to
# be on sys.path before that call — not before the imports at the top.
sys.path.insert(0, ML_DIR)

DATA_PATH = os.path.join(ML_DIR, "data", "raw", "nasa_gesdisc_publications.json")
MODELS_DIR = os.path.join(ML_DIR, "models")
METRICS_PATH = os.path.join(MODELS_DIR, "metrics.json")
ARTIFACT_NAME = "discipline_ensemble_v1.joblib"

MODEL_NAME = "discipline-ensemble"
MODEL_VERSION = "v1"
DATASET_SOURCE = "NASA GES DISC Earth-science publications (nasa-gesdisc/es-publications-researchareas)"

#: A class needs at least this many exploded pairs. With a stratified 20% test
#: split, a 4-example class would put 1 example in the test half and 3 in
#: training — its F1 would be a coin flip that moves the macro average by more
#: than any real modelling decision. 5 is the smallest count that makes the
#: split stable.
MIN_CLASS_COUNT = 5

RANDOM_STATE = 42


# ---------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------


def load_pairs() -> tuple[list[str], list[str], dict[str, int], list[str]]:
    """
    Explode the corpus into (text, label) pairs. Returns (texts, labels, counts).

    Raises rather than returning empty if the corpus is missing, because the
    honest failure here is "you did not run download_dataset.py", and a
    ZeroDivisionError twenty lines later does not say that.
    """
    if not os.path.exists(DATA_PATH):
        raise FileNotFoundError(
            f"corpus not found at {DATA_PATH}\n"
            "Run: ml/.venv/bin/python ml/scripts/download_dataset.py"
        )

    with open(DATA_PATH, encoding="utf-8") as fh:
        records = json.load(fh)

    texts: list[str] = []
    labels: list[str] = []
    counts: Counter[str] = Counter()

    for record in records:
        title = str(record.get("title") or "").strip()
        abstract = str(record.get("abstract") or "").strip()
        text = f"{title} {abstract}".strip()

        # Three records have no abstract. A title-only document is still a real
        # example and is kept — dropping it would bias the corpus toward
        # verbose papers — but a record with neither is unusable.
        if not text:
            continue

        for entry in record.get("labels") or []:
            name = entry.get("name") if isinstance(entry, dict) else entry
            if not name:
                continue
            name = str(name)
            texts.append(text)
            labels.append(name)
            counts[name] += 1

    # Drop under-represented classes in a *second* pass. Doing it inline while
    # counting would need a two-stage rollback the moment a class crossed the
    # floor mid-file, and the clean version — count everything, then filter —
    # is the only one whose behaviour is obvious at a glance.
    dropped_classes = sorted(name for name, n in counts.items() if n < MIN_CLASS_COUNT)
    if dropped_classes:
        keep = [i for i, lab in enumerate(labels) if lab not in set(dropped_classes)]
        texts = [texts[i] for i in keep]
        labels = [labels[i] for i in keep]
        for name in dropped_classes:
            del counts[name]

    return texts, labels, dict(sorted(counts.items())), dropped_classes


def build_vectorizer() -> TfidfVectorizer:
    return TfidfVectorizer(
        max_features=15_000,
        stop_words="english",
        ngram_range=(1, 2),
        # Abstract titles are frequently all-caps acronyms ("HMRFS-TP: ...").
        # Without this the vocabulary fills with case-variant duplicates of the
        # same few tokens.
        strip_accents="unicode",
        sublinear_tf=True,
        min_df=2,
    )


def build_ensemble() -> VotingClassifier:
    """
    Soft-voting ensemble over three base learners.

    `LogisticRegression` takes no `multi_class` argument here on purpose:
    scikit-learn removed the parameter in 1.9 (it emitted a deprecation warning
    from 1.5, because multinomial is the only multi-class solver behaviour that
    remains). Passing it raises `TypeError`. Setting `solver="lbfgs"` — the
    default — is the multinomial path.
    """
    return VotingClassifier(
        estimators=[
            ("naive_bayes", MultinomialNB(alpha=0.3)),
            (
                "logistic",
                LogisticRegression(
                    C=10.0,
                    max_iter=1000,
                    solver="lbfgs",
                    random_state=RANDOM_STATE,
                ),
            ),
            (
                "random_forest",
                RandomForestClassifier(
                    n_estimators=200,
                    # TF-IDF rows are sparse and wide; `max_features="sqrt"` on
                    # 15,000 features still samples ~122 per split, which is
                    # enough to find signal without the near-exhaustive search
                    # that makes a full forest on this matrix minutes long.
                    max_features="sqrt",
                    n_jobs=-1,
                    random_state=RANDOM_STATE,
                ),
            ),
        ],
        voting="soft",
    )


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------


def register_model_version(accuracy: float, macro_f1: float) -> None:
    """
    Upsert the MLModelVersion row for the ensemble.

    `datasetSource` names the corpus, and the component model types are appended
    so the admin dashboard shows which three learners compose the active
    version — a single accuracy figure is not attributable without that.

    Non-fatal, same as before: training must work on a laptop with no Postgres,
    so an unreachable database costs the dashboard row and nothing else.
    """
    import psycopg

    from app.config import psycopg_dsn

    raw_dsn = os.environ.get("DATABASE_URL")
    if not raw_dsn:
        print("  DATABASE_URL unset — skipping MLModelVersion registration.")
        return

    component_types = "MultinomialNB + LogisticRegression + RandomForestClassifier (soft voting)"
    try:
        with psycopg.connect(psycopg_dsn(raw_dsn), connect_timeout=5) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE "MLModelVersion"
                       SET "isActive" = false
                     WHERE "name" = %s AND "isActive" = true AND "version" <> %s
                    """,
                    (MODEL_NAME, MODEL_VERSION),
                )
                cur.execute(
                    """
                    INSERT INTO "MLModelVersion"
                        ("id", "name", "version", "trainedAt", "datasetSource",
                         "accuracy", "macroF1", "artifactPath", "isActive")
                    VALUES (gen_random_uuid()::text, %s, %s, %s, %s, %s, %s, %s, true)
                    ON CONFLICT ("name", "version") DO UPDATE SET
                        "trainedAt"     = EXCLUDED."trainedAt",
                        "datasetSource" = EXCLUDED."datasetSource",
                        "accuracy"      = EXCLUDED."accuracy",
                        "macroF1"       = EXCLUDED."macroF1",
                        "artifactPath"  = EXCLUDED."artifactPath",
                        "isActive"      = true
                    """,
                    (
                        MODEL_NAME,
                        MODEL_VERSION,
                        datetime.now(timezone.utc),
                        f"{DATASET_SOURCE} | ensemble={component_types}",
                        accuracy,
                        macro_f1,
                        ARTIFACT_NAME,
                    ),
                )
        print(f"  Registered MLModelVersion {MODEL_NAME}:{MODEL_VERSION} (isActive).")
    except Exception as exc:  # noqa: BLE001 — must not fail the training run
        print(f"  Could not register MLModelVersion: {exc}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force-download", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()

    os.makedirs(MODELS_DIR, exist_ok=True)

    print("IndoPolaris — discipline ensemble training")
    print("=" * 72)
    print(f"\nCorpus: {DATASET_SOURCE}")
    print("  Real labelled Earth-science publications, not a proxy corpus.")
    print("  Labels are GES DISC research areas, not NCPOR's taxonomy.\n")

    # ---- load ----
    t0 = time.monotonic()
    try:
        texts, labels, counts, dropped = load_pairs()
    except FileNotFoundError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    print(f"Loaded {len(texts):,} (text, label) pairs in {time.monotonic() - t0:.1f}s")
    print(f"  classes        {len(counts)}")
    print(f"  dropped (<{MIN_CLASS_COUNT} examples) {len(dropped)}"
          + (f": {', '.join(dropped)}" if dropped else ""))
    present = counts.items()
    for name, n in present:
        print(f"    - {name:40s} {n:5,d}  ({n / len(texts):5.1%})")

    if len(counts) < 2 or len(texts) < 200:
        print(f"\nERROR: corpus too small to train ({len(texts)} pairs, {len(counts)} classes).", file=sys.stderr)
        return 1
    print()

    # ---- split, then fit the vectoriser on the training half only ----
    X_train_text, X_test_text, y_train, y_test = train_test_split(
        texts,
        labels,
        test_size=0.2,
        random_state=RANDOM_STATE,
        stratify=labels,
    )
    print(f"Split: {len(X_train_text):,} train / {len(X_test_text):,} test "
          f"(stratified 80/20, seed={RANDOM_STATE})\n")

    # Fitting TF-IDF before the split would let the validation half contribute
    # its vocabulary and IDF weights to the model, which is leakage and inflates
    # the score. It is fitted on training text only.
    t0 = time.monotonic()
    vectorizer = build_vectorizer()
    X_train = vectorizer.fit_transform(X_train_text)
    X_test = vectorizer.transform(X_test_text)
    print(f"TF-IDF: {X_train.shape[1]:,} features from {len(X_train_text):,} docs "
          f"({time.monotonic() - t0:.1f}s)")

    # ---- train the ensemble ----
    t0 = time.monotonic()
    ensemble = build_ensemble()
    ensemble.fit(X_train, y_train)
    fit_seconds = time.monotonic() - t0
    predictions = ensemble.predict(X_test)
    probabilities = ensemble.predict_proba(X_test)

    accuracy = float(accuracy_score(y_test, predictions))
    macro_f1 = float(f1_score(y_test, predictions, average="macro"))

    # ---- per-component scores, so the ensemble can be compared to its parts ----
    # Two traps here, both of which fail loudly rather than silently:
    #
    # 1. `estimators_`, not `estimators`. VotingClassifier clones each member
    #    during fit and keeps the *fitted* clones in `estimators_`; the
    #    originals in `estimators` are never fitted, so scoring them raises
    #    NotFittedError.
    # 2. The members predict *encoded* labels. VotingClassifier fits them on a
    #    LabelEncoder's integer codes, so a member returns 0..20 while y_test
    #    holds strings — and accuracy_score raises "Mix of label input types".
    #    `ensemble.le_` is that encoder; inverse_transform maps back.
    fitted_members = getattr(ensemble, "estimators_", None) or list(ensemble.estimators)
    encoder = getattr(ensemble, "le_", None)
    component_scores: dict[str, dict[str, float]] = {}
    for (name, _), estimator in zip(ensemble.estimators, fitted_members, strict=True):
        component_pred = estimator.predict(X_test)
        if encoder is not None and component_pred.dtype.kind in "iu":
            component_pred = encoder.inverse_transform(component_pred)
        component_scores[name] = {
            "accuracy": float(accuracy_score(y_test, component_pred)),
            "macroF1": float(f1_score(y_test, component_pred, average="macro")),
        }

    class_order = list(ensemble.classes_)
    per_label_f1 = f1_score(y_test, predictions, average=None, labels=class_order)
    cm = confusion_matrix(y_test, predictions, labels=class_order)

    # ---- report ----
    print("=" * 72)
    # `X_test.shape[0]`, not `len(X_test)`: the vectoriser's output is a scipy
    # sparse matrix, whose __len__ raises because "length" is ambiguous.
    n_test = X_test.shape[0]
    print(f"Held-out test set ({n_test:,} pairs, {len(class_order)} classes)")
    print(f"  ensemble accuracy   {accuracy:.4f}")
    print(f"  ensemble macro-F1   {macro_f1:.4f}")
    print(f"  fit time            {fit_seconds:.1f}s")
    print()
    print("  components, scored on the same split:")
    for name, scores in component_scores.items():
        print(f"    {name:16s} accuracy {scores['accuracy']:.4f}  macro-F1 {scores['macroF1']:.4f}")
    print()
    print(classification_report(y_test, predictions, labels=class_order, zero_division=0))

    # Per-class recall is the interesting number on a 21-class problem: the
    # aggregate hides that a rare research area can be at 0.0 recall while the
    # majority classes keep macro accuracy respectable.
    print("Weakest classes by F1 (these are what a reviewer will look at):")
    # Counter, not `y_test.count(name)`: `train_test_split` on two lists returns
    # lists, so `(y_test == name)` is a plain `False`, not an elementwise mask.
    test_support = Counter(y_test)
    ranked = sorted(zip(class_order, per_label_f1, strict=True), key=lambda kv: kv[1])
    for name, score in ranked[:5]:
        support = test_support[name]
        print(f"    {name:40s} F1 {score:.4f}  (support {support})")
    print()

    # Top-3 soft-voting confidence: how often the winning probability clears a
    # threshold the serving layer can use. Not a calibration guarantee, but it
    # says whether `min_confidence` in app/config.py is set sensibly.
    top3 = np.sort(probabilities, axis=1)[:, -3:]
    for k in (1, 2, 3):
        conf = top3[:, -k]
        print(f"  top-{k} mean confidence {conf.mean():.4f}   "
              f"min {conf.min():.4f}   frac >= 0.15 {(conf >= 0.15).mean():.3f}")
    print()

    # ---- persist ----
    bundle = {
        "vectorizer": vectorizer,
        "model": ensemble,
        "labels": class_order,
        "model_name": MODEL_NAME,
        "model_version": MODEL_VERSION,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "accuracy": accuracy,
        "macro_f1": macro_f1,
        "dataset_source": DATASET_SOURCE,
        "component_models": list(component_scores),
    }
    artifact_path = os.path.join(MODELS_DIR, ARTIFACT_NAME)
    joblib.dump(bundle, artifact_path, compress=3)

    metrics = {
        "modelName": MODEL_NAME,
        "modelVersion": MODEL_VERSION,
        "trainedAt": bundle["trained_at"],
        "datasetSource": DATASET_SOURCE,
        "isProxyCorpus": False,
        "architecture": {
            "type": "sklearn.ensemble.VotingClassifier",
            "voting": "soft",
            "components": [
                {"name": name, **scores} for name, scores in component_scores.items()
            ],
        },
        "accuracy": accuracy,
        "macroF1": macro_f1,
        "vectorizer": {
            "maxFeatures": 15_000,
            "stopWords": "english",
            "ngramRange": [1, 2],
            "fittedFeatures": int(X_train.shape[1]),
        },
        "perLabelF1": {
            name: float(score) for name, score in zip(class_order, per_label_f1, strict=True)
        },
        "confusionMatrix": {
            "labels": class_order,
            "matrix": cm.tolist(),
        },
        "corpus": {
            "pairs": len(texts),
            "trainSplit": len(X_train_text),
            "testSplit": len(X_test_text),
            "classes": len(class_order),
            "minClassCount": MIN_CLASS_COUNT,
            "droppedClasses": dropped,
            "labelCounts": counts,
            "note": (
                "Labels are multi-valued in the source; exploding them into "
                "pairs duplicates text across labels, so accuracy is "
                "single-label over a duplicated corpus, not a multi-label score."
            ),
        },
        "caveats": [
            "GES DISC research areas are Earth science, not NCPOR's taxonomy.",
            "Cryospheric Indicators is the one polar-relevant class in the corpus.",
            "Multi-label sources exploded to single-label pairs inflate accuracy.",
            "Equal-weight soft voting does NOT beat its best member on this "
            "corpus: logistic alone scores higher macro-F1 than the ensemble. "
            "MultinomialNB's poorly calibrated posteriors drag the average "
            "down. Weighting the members (1,6,3) recovers most of the gap but "
            "still does not exceed logistic alone. See README.",
        ],
    }
    with open(METRICS_PATH, "w", encoding="utf-8") as fh:
        json.dump(metrics, fh, indent=2, ensure_ascii=False)
        fh.write("\n")

    print(f"Artifact  {artifact_path}  ({os.path.getsize(artifact_path) / 1e6:.1f} MB)")
    print(f"Metrics   {METRICS_PATH}")

    print()
    register_model_version(accuracy, macro_f1)

    print("\n" + "=" * 72)
    print(f"DONE  accuracy={accuracy:.4f}  macro-F1={macro_f1:.4f}")
    print("=" * 72)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
