#!/usr/bin/env bash
# Run a command with `.env` exported, from a given working directory.
#
#   scripts/with-env.sh ml .venv/bin/python -m uvicorn app.main:app
#
# Why this exists: npm does not load `.env`, and neither does Python. Without it,
# `npm run ml:serve` starts a service whose DATABASE_URL is unset, so every
# classification log and bandit posterior write fails *silently* — the endpoint
# answers 200 and just does not persist. That is exactly the failure mode that
# makes a local run look healthy while losing data.
#
# `scripts/with-db.mjs` has the same problem and solves it in Node; this is the
# shell equivalent for the Python side. `.env` is sourced with `set -a` so the
# variables are exported, not merely set as shell locals.
set -euo pipefail

if [[ ! -f .env ]]; then
  echo "with-env: no .env at the repository root — copy .env.example" >&2
  exit 1
fi

dir="${1:?usage: with-env.sh <subdir> <command> [args...]}"
shift

set -a
# shellcheck disable=SC1091
. ./.env
set +a

cd "$dir"
exec "$@"
