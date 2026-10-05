"""
Request/response schemas and the error envelope.

Section 6 fixes the failure contract: `error.code` is one of
`INVALID_INPUT | MODEL_NOT_LOADED | INTERNAL`, alongside a human-readable
`error.message`. The Node client switches on `code`, never on the message, so
the message is free to change or to carry a detail string.

Why validation lives here and not in the handler: Pydantic rejects a malformed
payload before it reaches the vectoriser. `text` is length-bounded to 1–5000
characters precisely because an unbounded string is the most common way to turn
a linear model into an out-of-memory kill, and the failure looks like an
infrastructure problem rather than a bad request.

These schemas are also the OpenAPI source. The Node types are generated from
`/openapi.json` (see `npm run ml:types`), not hand-written, so a field renamed
here becomes a type error in TypeScript rather than an `undefined` at runtime.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

# Bounds from Section 6. `min_length=1` rejects "", `max_length=5000` bounds
# vectorisation cost — both enforced before any model code runs.
TextField = Annotated[str, Field(min_length=1, max_length=5000)]


class ErrorCode(StrEnum):
    """The three failure modes a caller has to be able to branch on."""

    INVALID_INPUT = "INVALID_INPUT"
    MODEL_NOT_LOADED = "MODEL_NOT_LOADED"
    INTERNAL = "INTERNAL"


class ErrorBody(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "code": "INVALID_INPUT",
                "message": "text: String should have at least 1 character",
            }
        }
    )

    code: ErrorCode
    message: str


class ErrorResponse(BaseModel):
    error: ErrorBody


class ClassifyRequest(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "text": (
                    "We deployed an upward-looking acoustic profiler through 340 m "
                    "of first-year ice to measure krill swarms during the austral "
                    "winter, sampling at 1 Hz for 72 hours."
                ),
                "sourceType": "Report",
            }
        }
    )

    #: Title + abstract + tags, concatenated by the caller. 1–5000 characters.
    text: TextField
    #: Section 5's ClassificationSourceType. A plain string rather than an enum
    #: so a new content type does not 422 every client until this service is
    #: redeployed; ClassificationLog.sourceType is the enum that actually
    #: constrains storage.
    sourceType: str = Field(default="Report", min_length=1, max_length=32)
    #: Optional id of the record being classified, so the prediction can be
    #: written to ClassificationLog. Absent when /classify is used as a
    #: standalone probe (and in tests) — the service still classifies, it just
    #: has nothing to attach the audit row to.
    sourceId: str | None = Field(default=None, max_length=64)


class ClassifyResponse(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "predictedTags": ["Biology / Ecology", "Data Science / Instrumentation"],
                "confidenceScores": {
                    "Biology / Ecology": 0.62,
                    "Data Science / Instrumentation": 0.24,
                },
                "modelVersion": "v1",
            }
        }
    )

    #: Tags at or above MIN_CONFIDENCE, highest first, capped at MAX_TAGS.
    #: May be empty — see `classifier.py` for why an empty list is a valid,
    #: meaningful answer rather than a failure.
    predictedTags: list[str]
    #: tag -> probability in [0,1], for **every** label including those below
    #: threshold. The review queue renders a confidence badge per key, so this
    #: is deliberately wider than predictedTags.
    confidenceScores: dict[str, float]
    modelVersion: str


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    modelLoaded: bool
    modelVersion: str | None = None
    checks: dict[str, dict[str, object]]


# ---------------------------------------------------------------------------
# Bandit
# ---------------------------------------------------------------------------

#: Kept as plain strings, not an enum, for the same reason `ClassifyRequest
#: .sourceType` is: a new channel should not 422 every existing client until
#: this service is redeployed. `TargetChannel` and `TimeSlot` in Postgres are
#: the enums that actually constrain storage.
ChannelName = Annotated[str, Field(min_length=1, max_length=32)]
TimeSlotName = Annotated[str, Field(min_length=1, max_length=32)]


class ArmState(BaseModel):
    """One arm's posterior, as reported by /recommend."""

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "arm": "instagram_morning",
                "channel": "instagram",
                "timeSlot": "morning",
                "alpha": 7.4,
                "beta": 3.1,
                "mean": 0.7048,
                "observedMean": 0.7,
                "totalPulls": 10,
                "totalReward": 7.0,
            }
        }
    )

    arm: str
    channel: str
    timeSlot: str
    alpha: float
    beta: float
    #: Posterior mean, alpha / (alpha + beta). Beta(1,1) -> 0.5.
    mean: float
    #: Empirical CTR over observed pulls. 0.0 when totalPulls is 0, because no
    #: observation is not a 50% click-through rate.
    observedMean: float
    totalPulls: int
    totalReward: float


class RecommendResponse(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "channel": "instagram",
                "timeSlot": "morning",
                "arm": "instagram_morning",
                "reason": "highest Thompson sample over 9 arms",
                "exploration": 0.8123,
                "expectedReward": 0.7048,
                "draftId": None,
                "arms": [],
            }
        }
    )

    #: The Thompson argmax. What the caller should publish to.
    channel: str
    timeSlot: str
    arm: str
    #: Human-readable justification. A recommendation an admin cannot interrogate
    #: is one they will override, so the sample is surfaced alongside the choice.
    reason: str
    #: The Beta sample that won, so the gap to `expectedReward` shows how much
    #: exploration this choice represents.
    exploration: float
    #: alpha / (alpha + beta) for the chosen arm.
    expectedReward: float
    #: Echoed back when the recommendation was made for a specific draft.
    draftId: str | None = None
    #: All 9 arms, so the dashboard can show the full posterior spread.
    arms: list[ArmState]


class FeedbackRequest(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "draftId": "clx0a1b2c3d4e5f6g7h8i9j0k1",
                "channel": "instagram",
                "timeSlot": "morning",
                "impressions": 1200,
                "clicks": 84,
                "isSimulated": False,
            }
        }
    )

    #: The published draft the observation belongs to. Required, because
    #: EngagementEvent has a non-null FK to OutreachDraft — a feedback row with
    #: no draft would be untraceable and the constraint rejects it anyway.
    draftId: str = Field(min_length=1, max_length=64)
    channel: ChannelName
    timeSlot: TimeSlotName
    impressions: int = Field(ge=0)
    clicks: int = Field(ge=0)
    #: Marks the observation synthetic. Section 6 requires synthetic feedback to
    #: stay permanently separable from real analytics, so this is not optional in
    #: spirit even though it defaults to false.
    isSimulated: bool = False


class FeedbackResponse(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "recorded": True,
                "arm": "instagram_morning",
                "reward": 0.07,
                "alpha": 8.4,
                "beta": 4.1,
                "mean": 0.672,
                "totalPulls": 11,
            }
        }
    )

    #: False means the observation was not written (no DATABASE_URL, or the
    #: insert failed). Reported rather than raised: the caller has the
    #: measurement either way, and a 500 would suggest it was lost.
    recorded: bool
    arm: str
    #: clicks / impressions, the normalised value the posterior absorbed.
    reward: float
    alpha: float
    beta: float
    mean: float
    totalPulls: int


# OpenAPI response mapping, applied per-route in main.py.
ERROR_RESPONSES: dict[int | str, dict[str, object]] = {
    422: {"model": ErrorResponse, "description": "Malformed request body"},
    500: {"model": ErrorResponse, "description": "Unexpected server error"},
    503: {"model": ErrorResponse, "description": "Model not loaded"},
}
