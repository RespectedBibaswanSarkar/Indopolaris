# ---------------------------------------------------------------------------
# IndoPolaris ML service
#
# Two things to know about this image:
#
#  1. It does NOT train. Training is a network-dependent, ~25 second step that
#     `npm run ml:train` runs on the host, and the resulting artifact is copied
#     in. Baking training into the image would make every build re-download the
#     corpus and refit a model that rarely changes.
#
#     A hosted build is the exception: Render's build command can run
#     `download_dataset.py && train_ensemble.py` once, so a fresh deploy comes
#     up already trained. That is a build-time step, not a request-time one —
#     /classify never trains.
#
#  2. The training corpus (ml/data/raw, ~5 MB) is NOT copied in, only the
#     artifact derived from it. The image stays small and contains no corpus.
#
# `scripts/` is copied so a hosted build can train inside the image. It is not
# needed at runtime.
# ---------------------------------------------------------------------------

FROM python:3.14-slim-bookworm AS base

# PYTHONUNBUFFERED matters more than usual here: the service logs JSON to
# stdout for a log shipper, and block buffering would hold lines until the
# 8 KB buffer filled, making a request appear to hang in the dashboard.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# --- dependencies -----------------------------------------------------------
# Copied on its own so `pip install` is cached independently of app source
# changes. Editing a route should not re-download scikit-learn and numpy.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# --- application ------------------------------------------------------------
COPY app ./app

# The artifact is produced by `npm run ml:train` (or bootstrap.sh) on the host.
# If it is missing the image still builds — /health reports `degraded` and
# /classify returns 503, which is the documented behaviour and lets Node degrade
# an upload to `tagging: "pending"` instead of failing outright.
# The artifact is produced by `npm run ml:train` (or bootstrap.sh) on the host.
# If it is missing the image still builds — /health reports `degraded` and
# /classify returns 503, which is the documented behaviour and lets Node degrade
# an upload to `tagging: "pending"` instead of failing outright.
COPY models ./models

# Training scripts, for build-time training on a hosted builder. Harmless in a
# local image.
COPY scripts ./scripts

# --- non-root ---------------------------------------------------------------
RUN useradd --create-home --uid 10001 ml \
    && chown -R ml:ml /app
USER ml

EXPOSE 8000

# Reports ok/degraded and the real model + database status. Used by
# docker-compose's `condition: service_healthy`, which is what stops the web
# container from booting against an ML service that cannot answer.
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
    CMD ["python", "-c", "import urllib.request,sys,json; \
r=urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4); \
sys.exit(0 if r.status==200 else 1)"]

# One worker: the service is stateless apart from a cached model in each worker,
# and uvicorn's default single process avoids N copies of a ~15 MB artifact.
# Scale with replicas behind a load balancer rather than --workers.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
