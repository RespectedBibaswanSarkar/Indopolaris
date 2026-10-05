"""
Discipline classifier: artifact loading and inference.

The bundle persisted by `scripts/train_ensemble.py` is a dict holding the fitted
TfidfVectorizer, the fitted VotingClassifier, the label list and the metrics
measured at training time. It is loaded once at startup and cached; reloading
per request would cost a ~15 MB disk read and vectoriser construction on every
upload.

**Why the vectoriser is a sibling rather than a Pipeline step.** The ensemble is
composed over three estimators that all consume the same TF-IDF matrix, so there
is no single Pipeline step to hang the vectoriser on. Both are read from the
bundle here and applied in sequence, which keeps the "vectorisation and
prediction cannot drift apart" guarantee: one fitted vectoriser, one model, the
same pair at training time and at inference time.

**Confidence comes from soft voting.** A `VotingClassifier(voting="soft")`
averages each member's `predict_proba`, so `predict_proba` on the ensemble is a
real probability over the averaged posteriors. The `_softmax` fallback below
exists only for artifacts from the previous single-model pipeline, where the
winner was a `LinearSVC` — a margin classifier with no `predict_proba`, whose
`decision_function` outputs are unbounded signed distances. Those are squashed
through a softmax, which is monotone in the true label ranking but is not a
calibrated posterior. Both paths are kept so an old artifact still serves rather
than failing to load.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import joblib
import numpy as np

from app.config import Settings, get_settings

logger = logging.getLogger("indopolaris.ml.classifier")


class ModelNotLoadedError(RuntimeError):
    """Raised when /classify is called before the artifact is available."""


@dataclass(frozen=True)
class Prediction:
    predicted_tags: list[str]
    confidence_scores: dict[str, float]
    model_version: str


def _softmax(scores: np.ndarray) -> np.ndarray:
    """
    Numerically stable softmax over decision-function margins.

    The `-max` shift is not optional: raw SVM margins run to ±10 or more, and
    `exp(10)` is fine but `exp(800)` overflows float64 to `inf`, turning every
    probability into `nan`.
    """
    shifted = scores - np.max(scores)
    exponentials = np.exp(shifted)
    return exponentials / exponentials.sum()


class DisciplineClassifier:
    """
    Thread-safe, lazily-loaded wrapper around the trained artifact.

    Load happens once and the failure is cached too: if the artifact is missing,
    every subsequent request gets a fast `MODEL_NOT_LOADED` instead of waiting on
    a filesystem probe that will keep failing. `retry()` exists for the case
    where the file appears later (a retrained model, a mounted volume).
    """

    def __init__(self, settings: Settings | None = None) -> None:
        self._settings = settings or get_settings()
        self._bundle: dict[str, Any] | None = None
        self._lock = threading.Lock()
        self._load_error: str | None = None

    # --- lifecycle ---------------------------------------------------------

    @property
    def model_version(self) -> str | None:
        bundle = self._bundle
        return str(bundle["model_version"]) if bundle else None

    @property
    def is_loaded(self) -> bool:
        return self._bundle is not None

    @property
    def load_error(self) -> str | None:
        return self._load_error

    def load(self, *, force: bool = False) -> bool:
        """Load the artifact. Returns True on success; never raises."""
        with self._lock:
            if self._bundle is not None and not force:
                return True

            path = Path(self._settings.model_path)
            if not path.exists():
                self._load_error = (
                    f"model artifact not found at {path}. "
                    "Run: ml/.venv/bin/python ml/scripts/train_ensemble.py"
                )
                logger.error(self._load_error)
                self._bundle = None
                return False

            try:
                bundle = joblib.load(path)
            except Exception as exc:  # noqa: BLE001 — any unpickle failure is fatal here
                # sklearn refuses to unpickle an artifact built by a different
                # major version. That is a *version* problem, and the message
                # says so rather than surfacing a bare ImportError.
                self._load_error = f"failed to load model artifact at {path}: {exc}"
                logger.error(self._load_error)
                self._bundle = None
                return False

            for key in ("model", "labels", "model_version"):
                if key not in bundle:
                    self._load_error = f"artifact at {path} is missing key {key!r}"
                    logger.error(self._load_error)
                    self._bundle = None
                    return False

            self._bundle = bundle
            self._load_error = None
            logger.info(
                "model loaded",
                extra={
                    "extra_fields": {
                        "path": str(path),
                        "model_version": bundle["model_version"],
                        "labels": len(bundle["labels"]),
                        "train_accuracy": bundle.get("accuracy"),
                        "train_macro_f1": bundle.get("macro_f1"),
                        "dataset_source": bundle.get("dataset_source"),
                    }
                },
            )
            return True

    def retry(self) -> bool:
        """Attempt a load even if a previous one failed."""
        self._load_error = None
        return self.load(force=True)

    # --- inference ---------------------------------------------------------

    def predict(self, text: str) -> Prediction:
        """
        Classify `text`.

        Raises ModelNotLoadedError when the artifact is unavailable — the
        route maps that to a 503 with code MODEL_NOT_LOADED.
        """
        if self._bundle is None:
            # One last attempt: the artifact may have appeared since startup.
            if not self.load():
                raise ModelNotLoadedError(self._load_error or "model not loaded")

        assert self._bundle is not None  # for type checkers; load() guarantees it
        model = self._bundle["model"]
        labels: list[str] = list(self._bundle["labels"])

        # One fitted vectoriser, shared by training and inference, so
        # vectorisation and prediction cannot drift apart — a mismatch here is
        # the classic cause of "accuracy was great offline, garbage in
        # production".
        if "vectorizer" in self._bundle:
            features = self._bundle["vectorizer"].transform([text])
            estimator = model
        else:
            # Previous artifact shape: a fitted Pipeline carrying both steps.
            features = model.named_steps["tfidf"].transform([text])
            estimator = model.named_steps["clf"]

        if hasattr(estimator, "predict_proba"):
            probabilities = estimator.predict_proba(features)[0]
        else:
            probabilities = _softmax(estimator.decision_function(features)[0])

        # Zip against the estimator's own class order, NOT the bundle's label
        # list — they can disagree if the artifact was retrained against a
        # reordered mapping, and pairing by position would silently attach each
        # confidence to the wrong discipline.
        class_order = list(getattr(estimator, "classes_", labels))
        scores = {
            str(label): round(float(probability), 6)
            for label, probability in zip(class_order, probabilities, strict=True)
        }

        ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
        predicted = [
            tag
            for tag, score in ranked[: self._settings.max_tags]
            if score >= self._settings.min_confidence
        ]

        return Prediction(
            predicted_tags=predicted,
            # Every label, including those below threshold: the review queue
            # renders one confidence badge per key, so truncating here would
            # leave it unable to show *why* a tag was rejected.
            confidence_scores={tag: scores[tag] for tag in sorted(scores)},
            model_version=str(self._bundle["model_version"]),
        )


#: Process-wide singleton. FastAPI handlers run on a threadpool, so the loader
#: lock matters; a per-request instance would re-read the artifact each time.
classifier = DisciplineClassifier()
