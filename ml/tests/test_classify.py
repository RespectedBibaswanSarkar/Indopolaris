"""
Integration tests for `POST /classify`.

Section 6 requires at least one test per endpoint asserting the **full response
shape**, not just a 200. That matters here because the failure mode this
endpoint has is silent: a drifted field name or a confidence map that omits a
label still returns 200, and the Node client renders a blank confidence badge
with nothing in the logs to explain it.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.classifier import classifier
from tests.conftest import EXPECTED_TAGS

from app.classifier import classifier
from tests.conftest import CRYOSPHERIC_TAG, EXPECTED_TAGS

# Real polar-science prose. Deliberately *not* drawn from the training corpus:
# this is the input the service actually receives in production, and checking
# only on in-domain text would hide a domain-gap failure no unit test can see.
CRYOSPHERE_TEXT = (
    "Monthly surface elevation changes of the Greenland ice sheet are derived "
    "from ICESat-1, CryoSat-2 and ICESat-2 altimetry. Combining satellite "
    "track elevations with ice-penetrating radar sounding of the ice column "
    "indicates accelerating mass loss near the grounding zone."
)

BIOLOGY_TEXT = (
    "We deployed an upward-looking acoustic profiler through 340 m of first-year "
    "sea ice to image krill swarms during the austral winter. The instrument was "
    "left logging for 72 hours, giving 259,200 echo traces. Swarm depth tracked "
    "the under-ice brine channel, and we resolved seasonal variation in the "
    "abundance of Antarctic krill that forage beneath the ice shelf."
)

ATMOSPHERE_TEXT = (
    "A rawinsonde radiosonde was launched from the coastal station at 06:00 UTC "
    "to profile the lower stratosphere. Wind shear exceeding 20 knots was "
    "observed between 16 and 19 km, and the radiometer recorded a persistent "
    "temperature inversion above the polar tropopause."
)

LOGISTICS_TEXT = (
    "The vessel re-routed around a dense band of multi-year floe after the ice "
    "breaker made slow progress. Fuel consumption rose sharply, and the supply "
    "run to the inland base station was rescheduled by three days."
)


def test_classify_returns_the_full_documented_shape(client: TestClient) -> None:
    response = client.post(
        "/classify",
        json={"text": BIOLOGY_TEXT, "sourceType": "Report"},
    )

    assert response.status_code == 200
    body = response.json()

    # Exactly the three documented keys — an extra field here would mean the
    # Node client's generated types are already stale.
    assert set(body) == {"predictedTags", "confidenceScores", "modelVersion"}

    assert isinstance(body["predictedTags"], list)
    assert all(isinstance(tag, str) for tag in body["predictedTags"])
    assert body["modelVersion"] == "v1"

    scores = body["confidenceScores"]
    assert isinstance(scores, dict)
    # Every label is present, including those below threshold. The review queue
    # renders one confidence badge per key, so a truncated map would leave it
    # unable to explain a rejected tag.
    assert set(scores) == EXPECTED_TAGS

    for tag, value in scores.items():
        assert isinstance(value, float), f"{tag} is not a float"
        assert 0.0 <= value <= 1.0, f"{tag} confidence {value} outside [0,1]"

    # Soft-voting output is a distribution: if these do not sum to ~1, the
    # confidence numbers are not what the badge claims they are.
    assert sum(scores.values()) == pytest.approx(1.0, abs=1e-4)


def test_classify_predicted_tags_are_a_subset_ordered_by_confidence(
    client: TestClient,
) -> None:
    response = client.post("/classify", json={"text": ATMOSPHERE_TEXT, "sourceType": "Report"})
    body = response.json()

    tags = body["predictedTags"]
    scores = body["confidenceScores"]

    assert set(tags) <= set(scores)
    # Highest confidence first, so the caller can treat index 0 as the winner
    # without re-sorting.
    assert scores[tags[0]] == max(scores.values())


def test_classify_recognises_cryosphere_prose(client: TestClient) -> None:
    """
    Greenland mass-loss prose must land on Cryospheric Indicators.

    This is the claim the README makes about the corpus — that it carries a
    genuine polar-relevant class — so it is asserted directly rather than left
    to the metrics file. The text is not a training example, so passing means
    the TF-IDF signal generalises to unseen cryosphere phrasing.

    A weaker check ("the response is a 200") would pass even if the model
    returned noise for every input.
    """
    response = client.post("/classify", json={"text": CRYOSPHERE_TEXT})
    body = response.json()

    assert CRYOSPHERIC_TAG in body["predictedTags"]
    assert body["predictedTags"][0] == CRYOSPHERIC_TAG
    # And with real confidence behind it, not scraped over the threshold.
    assert body["confidenceScores"][CRYOSPHERIC_TAG] > 0.5


def test_classify_handles_short_and_long_input(client: TestClient) -> None:
    """Both bounds of the 1–5000 character contract must actually work."""
    shortest = client.post("/classify", json={"text": "ice core"})
    assert shortest.status_code == 200
    assert set(shortest.json()) == {"predictedTags", "confidenceScores", "modelVersion"}

    longest = client.post("/classify", json={"text": "ab " * 1666})  # 4998 chars
    assert longest.status_code == 200


def test_classify_accepts_a_source_id_for_audit(client: TestClient) -> None:
    """sourceId is optional; when present it is what gets logged."""
    response = client.post(
        "/classify",
        json={"text": LOGISTICS_TEXT, "sourceType": "Dataset", "sourceId": "probe-1"},
    )

    assert response.status_code == 200
    # No database in these fixtures, so the write is skipped by design — but it
    # must not turn a successful classification into an error.
    assert response.json()["predictedTags"]


# ---------------------------------------------------------------------------
# Validation — the check that keeps a bad payload away from the vectoriser
# ---------------------------------------------------------------------------


def test_classify_rejects_empty_text_with_the_error_envelope(
    client: TestClient,
) -> None:
    response = client.post("/classify", json={"text": ""})

    assert response.status_code == 422
    body = response.json()
    # FastAPI's default body is `{detail: [...]}`, which has no `error` key and
    # would leave the Node client unable to distinguish bad input from a crash.
    assert set(body) == {"error"}
    assert body["error"]["code"] == "INVALID_INPUT"
    assert "text" in body["error"]["message"]


def test_classify_rejects_over_long_text(client: TestClient) -> None:
    """5000 characters is the contract; 5001 must be refused before vectorising."""
    response = client.post("/classify", json={"text": "a" * 5001})

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_INPUT"


def test_classify_rejects_a_missing_text_field(client: TestClient) -> None:
    response = client.post("/classify", json={"sourceType": "Report"})

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_INPUT"


def test_classify_rejects_a_non_string_text(client: TestClient) -> None:
    response = client.post("/classify", json={"text": {"nested": "object"}})

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_INPUT"


def test_classify_defaults_source_type_to_report(client: TestClient) -> None:
    """sourceType is optional and defaults, so a minimal call is valid."""
    response = client.post("/classify", json={"text": ATMOSPHERE_TEXT})

    assert response.status_code == 200


def test_classify_returns_503_when_the_model_is_not_loaded(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    MODEL_NOT_LOADED is a documented code and must arrive as a 503.

    503 rather than 500 because the service is healthy and the caller should
    retry later; the Node client's degradation path (Section 6: a report saves
    with tagging "pending") keys off exactly this distinction.
    """
    from app.classifier import ModelNotLoadedError

    monkeypatch.setattr(
        classifier, "predict", lambda text: (_ for _ in ()).throw(ModelNotLoadedError("no artifact"))
    )

    response = client.post("/classify", json={"text": ATMOSPHERE_TEXT})

    assert response.status_code == 503
    body = response.json()
    assert body["error"]["code"] == "MODEL_NOT_LOADED"
    assert "no artifact" in body["error"]["message"]


def test_classify_returns_500_with_a_safe_message_on_unexpected_error(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    An unexpected exception becomes INTERNAL, with no internals in the message.

    The message must not leak the exception text: it can contain connection
    strings and file paths. The request id is the join key back to the logs.
    """
    monkeypatch.setattr(
        classifier,
        "predict",
        lambda text: (_ for _ in ()).throw(RuntimeError("psycopg: password=hunter2 @10.0.0.4")),
    )

    response = client.post("/classify", json={"text": ATMOSPHERE_TEXT})

    assert response.status_code == 500
    body = response.json()
    assert body["error"]["code"] == "INTERNAL"
    assert "hunter2" not in body["error"]["message"]
    assert "10.0.0.4" not in body["error"]["message"]


def test_classify_echoes_the_request_id(client: TestClient) -> None:
    response = client.post(
        "/classify",
        json={"text": ATMOSPHERE_TEXT},
        headers={"X-Request-ID": "upload-abc-123"},
    )

    assert response.headers["X-Request-ID"] == "upload-abc-123"


# ---------------------------------------------------------------------------
# The contract Node generates its types from
# ---------------------------------------------------------------------------


def test_openapi_documents_the_error_envelope(client: TestClient) -> None:
    """
    `/openapi.json` is the source for `npm run ml:types`.

    If the Node types are generated from a schema that does not describe the
    documented failure shapes, drift between the two languages becomes
    undetectable — which Section 6 calls the most common real cause of these
    failures.
    """
    schema = client.get("/openapi.json").json()

    assert "/classify" in schema["paths"]
    assert "/health" in schema["paths"]

    classify = schema["paths"]["/classify"]["post"]
    for status_code in ("422", "503"):
        assert status_code in classify["responses"], f"{status_code} undocumented on /classify"
        content = classify["responses"][status_code]["content"]["application/json"]
        assert content["schema"]["$ref"] == "#/components/schemas/ErrorResponse"

    # The exact enum the Node client switches on. Adding a fourth code without
    # regenerating types is the drift this catches.
    assert set(schema["components"]["schemas"]) >= {
        "ClassifyRequest",
        "ClassifyResponse",
        "ErrorResponse",
        "ErrorCode",
        "HealthResponse",
    }
    assert schema["components"]["schemas"]["ErrorCode"]["enum"] == [
        "INVALID_INPUT",
        "MODEL_NOT_LOADED",
        "INTERNAL",
    ]

    # The 1–5000 character contract must be visible to generated clients, or a
    # TypeScript caller has no way to know it.
    text = schema["components"]["schemas"]["ClassifyRequest"]["properties"]["text"]
    assert text["type"] == "string"
    assert text["minLength"] == 1
    assert text["maxLength"] == 5000

    response = schema["components"]["schemas"]["ClassifyResponse"]["properties"]
    assert set(response) == {"predictedTags", "confidenceScores", "modelVersion"}
    assert response["confidenceScores"]["type"] == "object"
