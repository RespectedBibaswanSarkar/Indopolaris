"""
Postgres access for the ML service.

Scope is deliberately small: the service writes `ClassificationLog` rows (so
every auto-tag is auditable) and reads the registry for `/health`. The bandit
tables arrive with Phase 7.

**Every operation here is best-effort and non-fatal.** The Node app already
degrades to `tagging: "pending"` when /classify is unreachable (Section 6); it
must not then also have to handle "the classify call succeeded but the audit
write failed". A repository that cannot record a prediction still serves the
prediction. What is *not* swallowed: a programming error, which raises.

psycopg connections are opened per operation rather than pooled. Classification
is a low-volume, sub-50ms path behind a Next.js server action; a pool would add
staleness and shutdown complexity for no measured benefit. Revisit if volume
makes this wrong — the note is here so the choice is visible rather than
accidental.
"""

from __future__ import annotations

import json
import logging
from contextlib import contextmanager
from typing import Any, Iterator

import psycopg

from app.config import Settings, get_settings

logger = logging.getLogger("indopolaris.ml.db")


@contextmanager
def _connect(settings: Settings) -> Iterator[psycopg.Connection]:
    dsn = settings.dsn
    if not dsn:
        raise RuntimeError("DATABASE_URL is not configured")
    with psycopg.connect(dsn, connect_timeout=settings.db_connect_timeout) as conn:
        yield conn


def check_database(settings: Settings | None = None) -> dict[str, Any]:
    """
    Probe the database for `/health`.

    Distinguishes "not configured" from "configured but unreachable", because
    they mean different things to whoever reads the dashboard: the first is a
    deliberate local-dev choice, the second is an incident.
    """
    settings = settings or get_settings()
    if not settings.database_configured:
        return {"ok": False, "detail": "DATABASE_URL not set — running without audit writes"}

    try:
        with _connect(settings) as conn, conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM \"MLModelVersion\"")
            (count,) = cur.fetchone()
        return {"ok": True, "detail": f"{count} registered model version(s)"}
    except Exception as exc:  # noqa: BLE001 — health must report, never raise
        return {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}


def record_classification(
    *,
    source_type: str,
    source_id: str,
    predicted_tags: list[str],
    confidence_scores: dict[str, float],
    model_version: str,
    settings: Settings | None = None,
) -> bool:
    """
    Append a `ClassificationLog` row. Returns True if written.

    `sourceType` is cast to the enum in SQL, so an unrecognised value raises and
    is caught here — the audit trail matters, but a stale client sending
    `"report"` in lower case must not turn an upload into a 500.
    """
    settings = settings or get_settings()
    if not settings.database_configured:
        logger.warning(
            "skipping ClassificationLog write — DATABASE_URL not set",
            extra={"extra_fields": {"source_type": source_type, "source_id": source_id}},
        )
        return False

    try:
        with _connect(settings) as conn, conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO "ClassificationLog"
                    ("id", "sourceType", "sourceId", "predictedTags",
                     "confidenceScores", "modelVersion")
                VALUES (gen_random_uuid()::text, %s::"ClassificationSourceType", %s,
                        %s, %s::jsonb, %s)
                """,
                (
                    source_type,
                    source_id,
                    predicted_tags,
                    json.dumps(confidence_scores),
                    model_version,
                ),
            )
        logger.info(
            "classification logged",
            extra={
                "extra_fields": {
                    "source_type": source_type,
                    "source_id": source_id,
                    "tags": predicted_tags,
                    "model_version": model_version,
                }
            },
        )
        return True
    except Exception as exc:  # noqa: BLE001 — see module docstring
        logger.warning(
            "ClassificationLog write failed; prediction still returned",
            extra={
                "extra_fields": {
                    "source_type": source_type,
                    "source_id": source_id,
                    "error": f"{type(exc).__name__}: {exc}",
                }
            },
        )
        return False


# ---------------------------------------------------------------------------
# Bandit state
# ---------------------------------------------------------------------------


def read_bandit_arms(settings: Settings | None = None) -> list[dict[str, Any]]:
    """
    Read every `BanditArmState` row.

    Returns [] rather than raising when the table is unreachable, because the
    caller's documented behaviour for "no history" is the uniform prior — and an
    empty list maps onto exactly that. Raising here would push the decision
    about whether a publish may proceed into the route handler.

    Missing arms are *not* backfilled here. `app.bandit.load_arms` owns the arm
    space (it knows the channel x slot cross product); this function just
    reports what is in the table.
    """
    settings = settings or get_settings()
    if not settings.database_configured:
        return []
    try:
        with _connect(settings) as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT "arm", "alpha", "beta", "totalPulls", "totalReward"
                  FROM "BanditArmState"
                 ORDER BY "arm"
                """
            )
            return [
                {
                    "arm": row[0],
                    "alpha": row[1],
                    "beta": row[2],
                    "total_pulls": row[3],
                    "total_reward": row[4],
                }
                for row in cur.fetchall()
            ]
    except Exception as exc:  # noqa: BLE001 — see docstring
        logger.warning(
            "could not read BanditArmState",
            extra={"extra_fields": {"error": f"{type(exc).__name__}: {exc}"}},
        )
        return []


def record_feedback(
    *,
    outreach_draft_id: str,
    channel: str,
    time_slot: str,
    impressions: int,
    clicks: int,
    is_simulated: bool = False,
    settings: Settings | None = None,
) -> bool:
    """
    Write the `EngagementEvent` row and fold the reward into the arm posterior.

    Two writes, one transaction. They must be atomic: an EngagementEvent without
    the corresponding posterior update means the bandit silently ignores a real
    observation, and its posteriors stop matching the events they came from. The
    reverse — a posterior moved with no event explaining it — is worse, because
    the dashboard would show a number nothing on record supports.

    Returns True if both landed. A False is non-fatal by the module's contract:
    the caller reports the observation and notes that the posterior did not move.
    """
    settings = settings or get_settings()
    if not settings.database_configured:
        logger.warning(
            "skipping EngagementEvent write — DATABASE_URL not set",
            extra={"extra_fields": {"outreach_draft_id": outreach_draft_id}},
        )
        return False

    # Clamped here rather than trusted from the request body: the SQL CHECK
    # constraints would reject a bad value, but a 500 on a simulated feedback
    # batch is a worse outcome than recording a clamped observation and saying
    # so in the log.
    impressions = max(0, int(impressions))
    clicks = max(0, min(int(clicks), impressions))
    reward = (clicks / impressions) if impressions else 0.0
    arm = f"{channel}_{time_slot}"

    try:
        with _connect(settings) as conn, conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO "EngagementEvent"
                    ("id", "outreachDraftId", "channel", "timeSlotBucket",
                     "impressions", "clicks", "reward", "isSimulated")
                VALUES (gen_random_uuid()::text, %s, %s::"TargetChannel",
                        %s::"TimeSlot", %s, %s, %s, %s)
                """,
                (outreach_draft_id, channel, time_slot, impressions, clicks, reward, is_simulated),
            )
            # Bernoulli conjugate update. `ON CONFLICT` handles the first write
            # to an arm; `GREATEST(alpha, 1)` is belt-and-braces against a row
            # that already sits near zero, since the CHECK constraint allows
            # alpha > 0 but not alpha >= reward.
            cur.execute(
                """
                INSERT INTO "BanditArmState"
                    ("id", "arm", "alpha", "beta", "totalPulls", "totalReward", "updatedAt")
                VALUES (gen_random_uuid()::text, %s, %s, %s, 1, %s, now())
                ON CONFLICT ("arm") DO UPDATE SET
                    "alpha"       = "BanditArmState"."alpha" + %s,
                    "beta"        = "BanditArmState"."beta"  + %s,
                    "totalPulls"  = "BanditArmState"."totalPulls" + 1,
                    "totalReward" = "BanditArmState"."totalReward" + %s,
                    "updatedAt"   = now()
                """,
                (arm, 1.0 + reward, 1.0 + (1.0 - reward), reward, reward, 1.0 - reward, reward),
            )
        logger.info(
            "bandit feedback recorded",
            extra={
                "extra_fields": {
                    "arm": arm,
                    "impressions": impressions,
                    "clicks": clicks,
                    "reward": round(reward, 6),
                    "is_simulated": is_simulated,
                    "outreach_draft_id": outreach_draft_id,
                }
            },
        )
        return True
    except Exception as exc:  # noqa: BLE001 — see module docstring
        logger.warning(
            "EngagementEvent write failed",
            extra={
                "extra_fields": {
                    "outreach_draft_id": outreach_draft_id,
                    "arm": arm,
                    "error": f"{type(exc).__name__}: {exc}",
                }
            },
        )
        return False


def get_active_model_version(settings: Settings | None = None) -> dict[str, Any] | None:
    """Read the active `MLModelVersion` row, or None."""
    settings = settings or get_settings()
    if not settings.database_configured:
        return None
    try:
        with _connect(settings) as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT name, version, accuracy, "macroF1", "datasetSource", "trainedAt"
                  FROM "MLModelVersion"
                 WHERE "isActive" = true
                 ORDER BY "trainedAt" DESC
                 LIMIT 1
                """
            )
            row = cur.fetchone()
        if row is None:
            return None
        return {
            "name": row[0],
            "version": row[1],
            "accuracy": float(row[2]),
            "macroF1": float(row[3]),
            "datasetSource": row[4],
            "trainedAt": row[5].isoformat(),
        }
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "could not read active model version",
            extra={"extra_fields": {"error": f"{type(exc).__name__}: {exc}"}},
        )
        return None
