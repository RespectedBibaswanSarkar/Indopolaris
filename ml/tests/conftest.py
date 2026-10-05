"""
Shared test fixtures.

These are integration tests, not unit tests: they drive the real FastAPI app
through `TestClient`, against the real artifact produced by
`train_ensemble.py`. A stubbed classifier would pass every assertion here
while proving nothing about the thing that ships.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ML_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ML_DIR))

from app.config import Settings, get_settings  # noqa: E402
from app.main import create_app  # noqa: E402

#: Force the documented "configured without a database" mode before anything
#: reads settings. Set through the constructor rather than the environment,
#: because pydantic-settings ranks a dotenv file above a bare environment
#: variable for empty values — the repo `.env` defines DATABASE_URL, so a
#: conftest that only touched `os.environ` would leave the suite quietly
#: dependent on whether Postgres happened to be running.
TEST_SETTINGS = Settings(database_url=None)

from app import config as _config  # noqa: E402

_config._settings = TEST_SETTINGS

#: The 21 NASA GES DISC research areas the ensemble predicts over. Hardcoded
#: rather than read out of the artifact on purpose: a contract asserted against
#: itself can never detect drift, so if the label set changes these tests must
#: FAIL and force a deliberate update.
#:
#: This is the real taxonomy, not the old five-bucket IndoPolaris proxy map.
EXPECTED_TAGS = {
    "Agriculture",
    "Air Quality",
    "Atmospheric/Ocean Indicators",
    "Cryospheric Indicators",
    "Droughts",
    "Earthquakes",
    "Ecosystems",
    "Energy Production/Use",
    "Environmental Impacts",
    "Floods",
    "Greenhouse Gases",
    "Habitat Conversion/Fragmentation",
    "Heat",
    "Land Surface/Agriculture Indicators",
    "Public Health",
    "Severe Storms",
    "Sun-Earth Interactions",
    "Validation",
    "Volcanic Eruptions",
    "Water Quality",
    "Wildfires",
}

#: The one polar-relevant class in the corpus. Asserted directly because it is
#: the claim the README makes about this dataset, and a reviewer will check it.
CRYOSPHERIC_TAG = "Cryospheric Indicators"


@pytest.fixture(scope="session")
def artifact_path() -> Path:
    """Fail loudly if the model was never trained."""
    path = get_settings().model_path
    if not path.exists():
        pytest.fail(
            f"Model artifact missing at {path}.\n"
            "Run:  ml/.venv/bin/python ml/scripts/train_ensemble.py\n"
            "  or:  npm run bootstrap"
        )
    return path


@pytest.fixture(scope="session")
def settings(artifact_path: Path) -> Settings:
    return TEST_SETTINGS


@pytest.fixture(scope="session")
def client(settings: Settings) -> TestClient:
    """
    `raise_server_exceptions=False` is required, not a convenience.

    With the default True, TestClient re-raises anything that escapes the app,
    so the `@app.exception_handler(Exception)` branch is never reached and
    `test_classify_returns_500_with_a_safe_message_on_unexpected_error` cannot
    observe the 500 it is asserting on.
    """
    app = create_app()
    with TestClient(app, raise_server_exceptions=False) as test_client:
        yield test_client


@pytest.fixture
def reset_classifier() -> "object":
    """Restore the module-level classifier singleton after a test perturbs it."""
    from app.classifier import classifier

    was_loaded = classifier.is_loaded
    yield classifier
    if was_loaded:
        classifier.load(force=True)
    else:
        classifier._bundle = None
        classifier._load_error = None
