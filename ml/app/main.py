"""
IndoPolaris ML service — FastAPI application.

Four endpoints (Section 6):
    POST /classify   auto-tag a report / dataset / publication
    GET  /health     liveness + model-loaded + database-reachable
    GET  /recommend  Thompson-sampled channel x time-slot for the next publish
    POST /feedback   record engagement, fold it into the arm's Beta posterior

Every response carries an `X-Request-ID`, and the Node client forwards its own,
so one user action is traceable across both services in a single log query.
"""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app import bandit, db
from app.classifier import ModelNotLoadedError, classifier
from app.config import get_settings
from app.logging_config import REQUEST_ID_HEADER, RequestContextMiddleware, configure_logging
from app.schemas import (
    ClassifyRequest,
    ClassifyResponse,
    ErrorCode,
    ErrorResponse,
    FeedbackRequest,
    FeedbackResponse,
    HealthResponse,
    RecommendResponse,
)

logger = logging.getLogger("indopolaris.ml")

SERVICE_VERSION = "0.2.0"


def _seed_for(request: Request, draft_id: str | None) -> int:
    """
    Deterministic per-request sampler seed.

    Derived from the request id when there is one, so replaying a captured
    `/recommend` (same `X-Request-ID`) reproduces the identical recommendation.
    Without a request id, falls back to the wall clock, because a fixed seed
    would make every recommendation in a fresh process identical — which looks
    like the bandit is not sampling at all.
    """
    request_id = getattr(request.state, "request_id", None)
    if request_id:
        return abs(hash(f"{request_id}:{draft_id or ''}"))
    return int(time.time_ns() % (2**31))


def _error(code: ErrorCode, message: str, http_status: int) -> JSONResponse:
    return JSONResponse(
        status_code=http_status,
        content={"error": {"code": code.value, "message": message}},
    )


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    configure_logging(settings.log_level, settings.log_json)
    logger.info(
        "starting ml-service",
        extra={
            "extra_fields": {
                "version": SERVICE_VERSION,
                "model_path": str(settings.model_path),
                "database_configured": settings.database_configured,
                "min_confidence": settings.min_confidence,
                "max_tags": settings.max_tags,
            }
        },
    )
    # Load eagerly so a missing artifact is visible at boot (and in the
    # container's healthcheck) instead of on the first upload. A failure here is
    # logged, not fatal: /health must answer and report `degraded`, which is
    # what lets the Node side degrade to `tagging: "pending"` (Section 6).
    classifier.load()
    yield
    logger.info("stopping ml-service")


def create_app() -> FastAPI:
    app = FastAPI(
        title="IndoPolaris ML Service",
        version=SERVICE_VERSION,
        summary=(
            "Discipline auto-tagging for the IndoPolaris polar archive, plus the "
            "publish-time contextual bandit (Phase 7)."
        ),
        lifespan=lifespan,
    )
    app.add_middleware(RequestContextMiddleware)

    # ---- error handling ---------------------------------------------------

    @app.exception_handler(RequestValidationError)
    async def _validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        """
        Map Pydantic failures onto the documented error envelope.

        FastAPI's default 422 body has shape `{detail: [...]}` with no `error`
        key, which would leave the Node client — which branches on
        `error.code` — falling through to its generic catch-all. Same status
        code, but the caller can no longer tell "bad input" from "server broke".
        """
        problems = "; ".join(
            f"{'.'.join(str(p) for p in err['loc'][1:]) or 'body'}: {err['msg']}"
            for err in exc.errors()
        )
        logger.info(
            "invalid request",
            extra={
                "extra_fields": {
                    "request_id": getattr(request.state, "request_id", None),
                    "path": request.url.path,
                    "problems": problems,
                }
            },
        )
        # `_UNPROCESSABLE_CONTENT`, not the older `_ENTITY`: Starlette 1.7 renamed
        # the constant and emits a deprecation warning for the old name.
        return _error(
            ErrorCode.INVALID_INPUT, problems, status.HTTP_422_UNPROCESSABLE_CONTENT
        )

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        logger.exception(
            "unhandled error",
            extra={
                "extra_fields": {
                    "request_id": getattr(request.state, "request_id", None),
                    "path": request.url.path,
                }
            },
        )
        # The message stays generic: exception text can contain connection
        # strings and file paths. The request id in the log is the join key.
        return _error(
            ErrorCode.INTERNAL,
            "Internal error while classifying. See service logs for the request id.",
            status.HTTP_500_INTERNAL_SERVER_ERROR,
        )

    # ---- routes -----------------------------------------------------------

    @app.get(
        "/health",
        response_model=HealthResponse,
        summary="Liveness, model artifact and database reachability",
    )
    async def health() -> HealthResponse:
        """
        Docker's healthcheck and Node's startup probe both read this.

        `ok` requires the model to be loaded. The database is reported but does
        not gate the status: an unconfigured database is a valid local-dev mode,
        and failing readiness on it would make the container flap instead of
        letting the service serve predictions without an audit trail.
        """
        settings = get_settings()
        model_loaded = classifier.is_loaded or classifier.load()
        database = db.check_database(settings)

        checks: dict[str, dict[str, object]] = {
            "model": {
                "ok": model_loaded,
                "detail": (
                    classifier.load_error
                    if not model_loaded
                    # From settings, not a literal: the registered name changed
                    # to discipline-ensemble with the new artifact, and a
                    # hardcoded string here reported the retired model's name.
                    else f"{settings.model_name}:{classifier.model_version}"
                ),
            },
            "database": database,
        }

        registered = db.get_active_model_version(settings)
        if registered:
            checks["registeredModel"] = {"ok": True, "detail": registered}

        return HealthResponse(
            status="ok" if model_loaded else "degraded",
            modelLoaded=model_loaded,
            modelVersion=classifier.model_version,
            checks=checks,
        )

    @app.post(
        "/classify",
        response_model=ClassifyResponse,
        responses={
            422: {"model": ErrorResponse, "description": "Malformed request body"},
            503: {"model": ErrorResponse, "description": "Model artifact not loaded"},
        },
        summary="Predict IndoPolaris discipline tags for a document",
    )
    async def classify(payload: ClassifyRequest, request: Request) -> ClassifyResponse | JSONResponse:
        """
        Auto-tag `text` (1–5000 characters) with IndoPolaris discipline tags.

        Returns `predictedTags` (at or above the confidence threshold) and
        `confidenceScores` for every label. An empty `predictedTags` is a valid
        answer meaning "no confident tag" — the Node side then stores the record
        with tagging pending rather than attaching a weak guess (Section 6).
        """
        request_id = getattr(request.state, "request_id", None)
        try:
            prediction = classifier.predict(payload.text)
        except ModelNotLoadedError as exc:
            # 503, not 500: the service is fine, the dependency is missing, and
            # the caller should retry later rather than treat it as a bug.
            return _error(ErrorCode.MODEL_NOT_LOADED, str(exc), status.HTTP_503_SERVICE_UNAVAILABLE)

        # Absent sourceId means /classify was used as a standalone probe, so
        # there is no ClassificationLog row to write. The prediction stands.
        if payload.sourceId:
            db.record_classification(
                source_type=payload.sourceType,
                source_id=payload.sourceId,
                predicted_tags=prediction.predicted_tags,
                confidence_scores=prediction.confidence_scores,
                model_version=prediction.model_version,
            )

        logger.info(
            "classified",
            extra={
                "extra_fields": {
                    "request_id": request_id,
                    "source_type": payload.sourceType,
                    "source_id": payload.sourceId,
                    "model_version": prediction.model_version,
                    "predicted_tags": prediction.predicted_tags,
                    "text_length": len(payload.text),
                }
            },
        )

        return ClassifyResponse(
            predictedTags=prediction.predicted_tags,
            confidenceScores=prediction.confidence_scores,
            modelVersion=prediction.model_version,
        )

    # ---- bandit -----------------------------------------------------------
    #
    # Unlike /classify, these two do not depend on the model artifact. A missing
    # ML model is a degraded tagging feature; the bandit is independent of it, so
    # gating /recommend on `classifier.is_loaded` would take publish decisions
    # offline for no reason.

    @app.get(
        "/recommend",
        response_model=RecommendResponse,
        summary="Thompson-sampled channel and time-slot for the next publish",
    )
    async def recommend(
        request: Request,
        draftId: str | None = None,
        exclude: str | None = None,
    ) -> RecommendResponse:
        """
        Pick where and when to publish.

        Samples Beta(alpha, beta) once per arm and returns the argmax. Reads
        `BanditArmState` on every call — no in-memory cache — because the
        posteriors are the shared state between this service and any other
        writer, and a cached copy would recommend from a snapshot the rest of
        the system has already moved past.

        `exclude` is a comma-separated list of arms to hold back, so a simulator
        or an A/B harness can force exploration of a specific arm.

        `draftId` is echoed back and otherwise unused: it makes the response
        traceable in a log, which is the only reason it exists.
        """
        arms = bandit.load_arms()
        excluded = tuple(a for a in (exclude or "").split(",") if a)

        # Seeded per request from the request id when present, so two successive
        # calls are different samples (that is the exploration) while a single
        # call replayed with the same id reproduces exactly — which is what makes
        # a /recommend response debuggable.
        seed = _seed_for(request, draftId)
        chosen, samples = bandit.select_arm(arms, seed=seed, exclude=excluded)

        logger.info(
            "bandit recommendation",
            extra={
                "extra_fields": {
                    "request_id": getattr(request.state, "request_id", None),
                    "arm": chosen.arm,
                    "sample": round(samples[chosen.arm], 6),
                    "expected_reward": round(chosen.mean, 6),
                    "total_pulls": chosen.total_pulls,
                    "excluded": list(excluded),
                }
            },
        )

        return RecommendResponse(
            channel=chosen.channel,
            timeSlot=chosen.time_slot,
            arm=chosen.arm,
            reason=(
                f"highest Thompson sample over {len(arms)} arms"
                if not excluded
                else f"highest Thompson sample over {len(arms) - len(excluded)} arms "
                     f"({len(excluded)} held back)"
            ),
            exploration=round(samples[chosen.arm], 6),
            expectedReward=round(chosen.mean, 6),
            draftId=draftId,
            arms=[bandit.summarise(a) for a in arms],
        )

    @app.post(
        "/feedback",
        response_model=FeedbackResponse,
        responses={
            422: {"model": ErrorResponse, "description": "Malformed request body"},
        },
        summary="Record engagement and update the arm posterior",
    )
    async def feedback(payload: FeedbackRequest) -> FeedbackResponse:
        """
        Fold one engagement observation into its arm's Beta posterior.

        The write is two statements in one transaction: the `EngagementEvent`
        row and the `BanditArmState` update. They cannot come apart — see
        `db.record_feedback`.

        `recorded: false` in the response means the observation was *not*
        persisted (no DATABASE_URL configured, or the insert failed). That is a
        200, not a 500: the caller has a genuine measurement either way, and
        raising would misrepresent a lost write as a bad request. The distinction
        matters — a false here means the bandit will not learn from this event,
        which someone has to notice.
        """
        impressions = payload.impressions
        clicks = min(payload.clicks, impressions)
        reward = (clicks / impressions) if impressions else 0.0
        arm_name = bandit.build_arm(payload.channel, payload.timeSlot)

        recorded = db.record_feedback(
            outreach_draft_id=payload.draftId,
            channel=payload.channel,
            time_slot=payload.timeSlot,
            impressions=impressions,
            clicks=clicks,
            is_simulated=payload.isSimulated,
        )

        # Re-read rather than computing the new posterior locally: the UPDATE ran
        # in its own transaction, so the authoritative alpha/beta is whatever the
        # database now holds. Reporting a locally-derived number would be wrong
        # under concurrency and would not reveal a failed write.
        updated = next(
            (a for a in bandit.load_arms() if a.arm == arm_name),
            None,
        )
        if updated is None:
            # Only reachable if the arm was somehow unparseable, which the CHECK
            # constraint prevents. Returned rather than raised so the caller
            # still learns the reward.
            updated = bandit.Arm(arm=arm_name, alpha=1.0, beta=1.0, total_pulls=0, total_reward=0.0)

        return FeedbackResponse(
            recorded=recorded,
            arm=arm_name,
            reward=round(reward, 6),
            alpha=round(updated.alpha, 4),
            beta=round(updated.beta, 4),
            mean=round(updated.mean, 4),
            totalPulls=updated.total_pulls,
        )

    @app.get("/", include_in_schema=False)
    async def root() -> dict[str, str]:
        return {
            "service": "indopolaris-ml",
            "version": SERVICE_VERSION,
            "health": "/health",
            "recommend": "/recommend",
            "feedback": "/feedback",
        }

    return app


app = create_app()
