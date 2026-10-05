"""
Service configuration.

Single source of truth for every environment variable the ML service reads,
validated once at import. pydantic-settings gives us the same behaviour as
`src/lib/env.ts` on the Node side: a missing variable fails immediately with a
readable message instead of surfacing as `None` three layers deep.

Note the asymmetry between `DATABASE_URL` here and in the Node app: the Node
side runs through Prisma, which accepts a `?schema=public` query parameter and
adds it itself. libpq — and therefore psycopg — rejects any query parameter it
does not recognise, so the same string that Prisma is perfectly happy with is a
hard error for this service. `psycopg_dsn()` reconciles the two.
"""

from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ML_DIR = Path(__file__).resolve().parent.parent

#: Query parameters libpq (and therefore psycopg) understands. Anything else in
#: a DATABASE_URL is a Prisma-ism and is stripped before connecting.
#:
#: Allowlist rather than denylist: a Prisma release that adds another
#: parameter then keeps working here without a code change.
_LIBPQ_QUERY_PARAMS = frozenset(
    {
        "application_name",
        "channel_binding",
        "client_encoding",
        "connect_timeout",
        "fallback_application_name",
        "gssencmode",
        "keepalives",
        "options",
        "passfile",
        "replication",
        "row_factory",
        "sslcompression",
        "sslcrl",
        "sslmode",
        "sslcert",
        "sslkey",
        "sslrootcert",
        "target_session_attrs",
    }
)


def psycopg_dsn(url: str) -> str:
    """
    Return `url` in a form psycopg will accept.

    Prisma's DATABASE_URL convention appends `?schema=public` (and sometimes
    `connection_limit`, `pgbouncer=true`). psycopg passes unknown query
    parameters straight to libpq, which fails with
    `invalid URI query parameter: "schema"` — a connection error that looks
    like a network problem and sends you debugging the wrong thing.

    Only the URL is touched; the value is never logged.
    """
    parts = urlsplit(url)
    if not parts.query:
        return url

    kept = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if k in _LIBPQ_QUERY_PARAMS]
    dropped = {k for k, _ in parse_qsl(parts.query, keep_blank_values=True)} - _LIBPQ_QUERY_PARAMS
    if dropped:
        # Worth a heads-up: silently dropping a param the operator *meant* to
        # apply is how you get a connection that behaves unlike production.
        print(
            f"[config] stripped non-libpq DATABASE_URL params: {sorted(dropped)}",
            flush=True,
        )
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(kept), parts.fragment))


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=os.path.join(ML_DIR.parent, ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        # An empty variable means "not configured", not "connect to the empty
        # string". Without this, `DATABASE_URL=` in a .env silently falls back
        # to the next source and /health reports a connection error against a
        # URL that was never set — a confusing failure for a one-character typo.
        env_ignore_empty=True,
    )

    # --- model ---
    #: Where train_ensemble.py writes the joblib bundle. Resolved relative to
    #: ml/ so the container path and the local path both work.
    model_path: Path = Field(default=ML_DIR / "models" / "discipline_ensemble_v1.joblib")
    model_name: str = "discipline-ensemble"

    # --- predictions ---
    #: Minimum posterior mean for a tag to be returned in `predictedTags`.
    #: Below this, /classify returns an empty tag list and the caller degrades to
    #: "tagging: pending" (Section 6) rather than attaching a weak guess to a
    #: citable record.
    min_confidence: float = Field(default=0.15, ge=0.0, le=1.0)
    #: At most this many tags per classification, so one long multi-topic report
    #: cannot flood the review queue with every tag it brushed against.
    max_tags: int = Field(default=3, ge=1, le=5)

    # --- database ---
    #: Optional. Without it the service still serves /classify and reports
    #: database: "not configured" from /health; it just cannot write
    #: ClassificationLog rows.
    database_url: str | None = None
    db_connect_timeout: int = Field(default=5, ge=1, le=60)

    # --- logging ---
    log_level: str = "INFO"
    #: Emit one JSON object per line (Section 6 structured logging). Disable for
    #: human-readable output during local debugging.
    log_json: bool = True

    @field_validator("model_path", mode="before")
    @classmethod
    def _expand(cls, v: str | Path) -> Path:
        return Path(str(v)).expanduser()

    @property
    def dsn(self) -> str | None:
        return psycopg_dsn(self.database_url) if self.database_url else None

    @property
    def database_configured(self) -> bool:
        return bool(self.database_url)


_settings: Settings | None = None


def get_settings() -> Settings:
    """Memoised settings accessor."""
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings
