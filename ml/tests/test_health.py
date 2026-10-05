"""
Integration tests for `GET /health`.

Section 6 names this endpoint as the input to both Docker's healthcheck and
Node's startup probe, so it has to answer — with an accurate verdict — even when
its dependencies are broken. The interesting cases are the degraded ones.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.classifier import classifier
from app.config import get_settings


def test_health_reports_ok_when_model_is_loaded(client: TestClient) -> None:
    response = client.get("/health")

    assert response.status_code == 200
    body = response.json()

    # Full shape, not just "it returned 200" (Section 6).
    assert set(body) == {"status", "modelLoaded", "modelVersion", "checks"}
    assert body["status"] == "ok"
    assert body["modelLoaded"] is True
    assert body["modelVersion"] == "v1"
    assert body["checks"]["model"]["ok"] is True


def test_health_echoes_the_caller_request_id(client: TestClient) -> None:
    """Node sends its own request id; it is the join key across both services."""
    response = client.get("/health", headers={"X-Request-ID": "req-from-node-42"})

    assert response.headers["X-Request-ID"] == "req-from-node-42"


def test_health_generates_a_request_id_when_none_is_sent(client: TestClient) -> None:
    response = client.get("/health")

    assert response.headers.get("X-Request-ID")


def test_health_degrades_when_the_artifact_is_missing(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    A missing artifact must read `degraded` — not 500, and not a 200 claiming ok.

    This is the state Docker's healthcheck and Node's startup probe actually
    have to interpret: the process is alive and answering, it just cannot serve
    /classify yet. Crashing hides a real outage; reporting `ok` lets the app
    start and then fail on the first upload.
    """
    settings = get_settings()
    broken = settings.model_copy(update={"model_path": Path("/nonexistent/model.joblib")})
    monkeypatch.setattr(classifier, "_settings", broken)
    monkeypatch.setattr(classifier, "_bundle", None)
    monkeypatch.setattr(classifier, "_load_error", None)

    response = client.get("/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "degraded"
    assert body["modelLoaded"] is False
    assert body["modelVersion"] is None
    assert body["checks"]["model"]["ok"] is False
    # The operator needs to know what to run, not merely that it broke.
    assert "train_ensemble" in str(body["checks"]["model"]["detail"])


def test_health_distinguishes_unconfigured_database_from_unreachable(
    client: TestClient,
) -> None:
    """
    No DATABASE_URL is a valid local-dev mode, and is reported distinctly.

    These fixtures deliberately run without a database. Asserting the wording is
    what stops "database unreachable" and "database not configured" from
    collapsing into one ambiguous failure later.
    """
    response = client.get("/health")
    database = response.json()["checks"]["database"]

    assert database["ok"] is False
    assert "DATABASE_URL" in str(database["detail"])


def test_health_reports_the_registered_model_when_a_database_is_configured(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    With a database present, /health surfaces the MLModelVersion row.

    This is the row Section 8.4 says the admin dashboard's accuracy figure is
    read from — the point of asserting its shape here is that a rename in the
    training script cannot silently detach the dashboard from real numbers.
    """
    from app import db

    monkeypatch.setattr(
        db,
        "check_database",
        lambda settings=None: {"ok": True, "detail": "1 registered model version(s)"},
    )
    monkeypatch.setattr(
        db,
        "get_active_model_version",
        lambda settings=None: {
            "name": "discipline-ensemble",
            "version": "v1",
            "accuracy": 0.4448,
            "macroF1": 0.4518,
            "datasetSource": (
                "NASA GES DISC Earth-science publications "
                "| ensemble=MultinomialNB + LogisticRegression "
                "+ RandomForestClassifier (soft voting)"
            ),
            "trainedAt": "2026-01-01T00:00:00+00:00",
        },
    )

    response = client.get("/health")
    body = response.json()

    assert body["status"] == "ok"
    registered = body["checks"]["registeredModel"]
    assert registered["ok"] is True
    assert registered["detail"]["accuracy"] == 0.4448
    assert registered["detail"]["macroF1"] == 0.4518
    # The corpus's identity must stay visible at every layer, not just the README,
    # and so must which three learners compose the active ensemble.
    source = registered["detail"]["datasetSource"]
    assert "NASA GES DISC" in source
    assert "RandomForestClassifier" in source
