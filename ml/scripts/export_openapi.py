#!/usr/bin/env python3
"""
Write the service's OpenAPI document to `ml/openapi.json`.

Section 6 calls out schema drift between Python and Node as "the most common
real cause of these failures", and prescribes generating the Node types from
the FastAPI schema instead of hand-duplicating them. This script is the source
of that generation: it needs no running server, so `npm run ml:types` works in
CI and on a fresh clone without booting anything.

    ml/.venv/bin/python ml/scripts/export_openapi.py
    npm run ml:types
"""

from __future__ import annotations

import json
import os
import sys

ML_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ML_DIR)

from app.main import SERVICE_VERSION, create_app  # noqa: E402

OUTPUT = os.path.join(ML_DIR, "openapi.json")


def main() -> int:
    schema = create_app().openapi()
    schema["info"]["x-generated-by"] = "ml/scripts/export_openapi.py"

    with open(OUTPUT, "w", encoding="utf-8") as fh:
        json.dump(schema, fh, indent=2, sort_keys=True)
        fh.write("\n")

    paths = sorted(schema["paths"])
    print(f"OpenAPI {schema['info']['version']} written to {OUTPUT}")
    print(f"  paths:     {', '.join(paths)}")
    print(f"  schemas:   {', '.join(sorted(schema['components']['schemas']))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
