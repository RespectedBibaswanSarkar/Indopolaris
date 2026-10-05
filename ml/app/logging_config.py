"""
Structured JSON logging (Section 6).

Every line is a single JSON object so the container's stdout can be shipped
straight into a log aggregator without a regex parser. uvicorn's own access log
is replaced rather than augmented, because having two formats interleaved on the
same stream is worse than one format that is merely less detailed.

Each request logs: method, path, status, latency_ms, request_id. The request id
is generated here if the caller did not send `X-Request-ID`, echoed back in the
response header, and forwarded to the Node side — which means a single user
action can be traced across both services.
"""

from __future__ import annotations

import json
import logging
import sys
import time
import uuid
from typing import Any

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

REQUEST_ID_HEADER = "X-Request-ID"


class JsonFormatter(logging.Formatter):
    """Render a LogRecord as one JSON object per line."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created))
            + f".{int(record.msecs):03d}Z",
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        # Anything passed via `extra=` lands here.
        for key, value in getattr(record, "extra_fields", {}).items():
            payload[key] = value
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False, default=str)


def configure_logging(level: str = "INFO", as_json: bool = True) -> None:
    """Install the root handler. Idempotent — safe to call from tests."""
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        JsonFormatter()
        if as_json
        else logging.Formatter("%(asctime)s %(levelname)-7s %(name)s  %(message)s")
    )

    root = logging.getLogger()
    # Replace, not append: a second call (tests reload the app) must not double
    # every log line.
    for existing in list(root.handlers):
        root.removeHandler(existing)
    root.addHandler(handler)
    root.setLevel(level.upper())

    # uvicorn installs its own handlers at import; point them at ours instead of
    # letting them write unparseable lines to stderr alongside ours.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        uv_logger = logging.getLogger(name)
        uv_logger.handlers = []
        uv_logger.propagate = True


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)


def log_event(logger: logging.Logger, level: int, message: str, **fields: Any) -> None:
    """Log `message` with arbitrary structured fields attached."""
    logger.log(level, message, extra={"extra_fields": fields})


class RequestContextMiddleware(BaseHTTPMiddleware):
    """
    Assign/propagate a request id and log one line per completed request.

    Reads the status off the response *before* the body is streamed, which for
    FastAPI is after handlers have run — so an exception handler that returns a
    503 is still recorded with its real status code rather than 200.
    """

    async def dispatch(self, request: Request, call_next) -> Response:
        request_id = request.headers.get(REQUEST_ID_HEADER) or uuid.uuid4().hex
        request.state.request_id = request_id

        logger = get_logger("indopolaris.ml.request")
        started = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception:
            latency_ms = round((time.perf_counter() - started) * 1000, 2)
            log_event(
                logger,
                logging.ERROR,
                "request failed",
                request_id=request_id,
                method=request.method,
                path=request.url.path,
                status=500,
                latency_ms=latency_ms,
            )
            raise

        latency_ms = round((time.perf_counter() - started) * 1000, 2)
        log_event(
            logger,
            logging.INFO,
            "request",
            request_id=request_id,
            method=request.method,
            path=request.url.path,
            status=response.status_code,
            latency_ms=latency_ms,
        )
        response.headers[REQUEST_ID_HEADER] = request_id
        return response
