#!/usr/bin/env bash
#
# IndoPolaris — ML service bootstrap.
#
# Takes a fresh clone to a working ML service:
#
#   1. create the virtualenv
#   2. install pinned dependencies
#   3. download the proxy training corpus into ml/data/raw
#   4. train and validate the discipline classifier
#   5. run the integration tests against the artifact just produced
#
# Usage:
#   npm run bootstrap            # everything
#   npm run bootstrap -- --skip-train
#   npm run bootstrap -- --force-recreate-venv
#
# Every step is idempotent, so re-running after a dependency bump is cheap.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ML_DIR="$REPO_ROOT/ml"
VENV_DIR="$ML_DIR/.venv"
PY="$VENV_DIR/bin/python"

SKIP_TRAIN=0
FORCE_RECREATE=0
for arg in "$@"; do
  case "$arg" in
    --skip-train) SKIP_TRAIN=1 ;;
    --force-recreate-venv) FORCE_RECREATE=1 ;;
    -h|--help) sed -n '3,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1;34m==>\033[0m \033[1m%s\033[0m\n' "$1"; }
fail() { printf '\033[1;31merror:\033[0m %s\n' "$1" >&2; exit 1; }

step "1/5  Virtualenv"

# `python3 -m venv` on some distro builds ships without pip and without the
# ensurepip wheels; `--upgrade-deps` then fails for a reason that has nothing to
# do with this project. Check for a usable interpreter up front instead.
PYTHON_BIN="${PYTHON_BIN:-python3}"
command -v "$PYTHON_BIN" >/dev/null 2>&1 || fail "$PYTHON_BIN not found. Install Python 3.11+."

"$PYTHON_BIN" - <<'PYEOF' || fail "Python 3.11+ is required (scikit-learn wheels)."
import sys
raise SystemExit(0 if sys.version_info >= (3, 11) else 1)
PYEOF
echo "  $($PYTHON_BIN --version) at $(command -v "$PYTHON_BIN")"

if [[ $FORCE_RECREATE -eq 1 && -d "$VENV_DIR" ]]; then
  echo "  --force-recreate-venv: removing $VENV_DIR"
  rm -rf "$VENV_DIR"
fi

if [[ ! -x "$PY" ]]; then
  echo "  creating $VENV_DIR"
  "$PYTHON_BIN" -m venv "$VENV_DIR" || fail "venv creation failed. On Debian/Ubuntu: apt install python3-venv"
fi

# Abort rather than install into a broken venv and fail 400 lines later.
"$PY" -c "import sys" >/dev/null 2>&1 || fail "$PY is not runnable; delete $VENV_DIR and retry."

step "2/5  Dependencies"
"$PY" -m pip install --quiet --upgrade pip
"$PY" -m pip install --quiet -r "$ML_DIR/requirements.txt"
echo "  installed $("$PY" -m pip list --format=freeze 2>/dev/null | wc -l) packages"

step "3/5  Training corpus (NASA GES DISC publications)"
# No-op if ml/data/raw already holds the downloaded JSON.
"$PY" "$ML_DIR/scripts/download_dataset.py"

if [[ $SKIP_TRAIN -eq 1 ]]; then
  step "5/5  Tests — skipped (--skip-train), so no artifact exists yet"
  printf '\n\033[1;33mBootstrap complete (training skipped).\033[0m\n'
  printf 'Run:  %s %s/scripts/train_ensemble.py\n\n' "$PY" "$ML_DIR"
  exit 0
fi

step "4/5  Training the discipline ensemble"
# DATABASE_URL is optional here: without it the MLModelVersion row is skipped
# and the script says so. Re-run it later with the database up to populate the
# row the admin dashboard reads.
"$PY" "$ML_DIR/scripts/train_ensemble.py"

step "5/5  Integration tests"
cd "$ML_DIR"
"$PY" -m pytest

printf '\n\033[1;32mBootstrap complete.\033[0m\n'
cat <<'EOF'

  Serve the service:
    ml/.venv/bin/python -m uvicorn app.main:app --reload --port 8000
    (run from the ml/ directory)

  Or bring up the whole stack with healthcheck gating:
    docker compose up -d db minio minio-init
    DATABASE_URL=postgresql://... ml/.venv/bin/python ml/scripts/train_classifier.py
    docker compose up -d ml-service

EOF
