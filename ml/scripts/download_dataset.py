#!/usr/bin/env python3
"""
Download the NASA GES DISC Earth-science publication corpus into ml/data/raw.

This is a **real** labelled corpus, not a proxy: 2,327 publications harvested
by NASA GES DISC, each with a title, an abstract, a DOI, a year, and one or
more GES DISC *research-area* labels. Twenty-one distinct research areas, one
of which is `Cryospheric Indicators` — a genuine cryosphere class, which is why
this corpus is usable for a polar archive's discipline classifier at all.

It replaces the earlier 20 Newsgroups proxy. The proxy was honest about what it
was (see git history) but it was US discussion-group text, so every accuracy
figure it produced described the wrong distribution, and none of its 20
categories had anything to do with Earth science.

Two things this corpus is still *not*, and the README says so in the same
breath:

  - It is Earth science, not polar science. Only one of the 21 research areas
    is cryospheric. A model trained on it learns GES DISC's taxonomy, which
    overlaps NCPOR's but is not identical to it.
  - Publications carry multiple research-area labels, so exploding them into
    (text, label) pairs yields a deliberately multi-label corpus trained as
    single-label. That is an approximation, and `train_ensemble.py` reports the
    accuracy it produces without pretending it is a multi-label score.

Swapping in NCPOR's internal corpus later means pointing
`train_ensemble.py`'s loader at a JSON or CSV with the same shape (or just
replacing this file's output). That is the entire reason ingestion is isolated
behind one script.

Source: https://huggingface.co/datasets/nasa-gesdisc/es-publications-researchareas
Run it:  ml/.venv/bin/python ml/scripts/download_dataset.py
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter

import requests

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "raw")
OUT_NAME = "nasa_gesdisc_publications.json"

#: The `resolve/main` path is a redirect to a CDN, which `requests` follows
#: automatically. `?download=true` is not needed — `resolve/main` already serves
#: the file content rather than an LFS pointer.
SOURCE_URL = (
    "https://huggingface.co/datasets/nasa-gesdisc/"
    "es-publications-researchareas/resolve/main/publications_researchareas.json"
)


def fetch(*, force: bool = False, timeout: int = 60) -> tuple[list[dict], str]:
    """
    Download and normalise the corpus. Returns (records, output_path).

    Idempotent: if the output file already exists it is reused unless `force`.
    """
    os.makedirs(DATA_DIR, exist_ok=True)
    out_path = os.path.join(DATA_DIR, OUT_NAME)

    if os.path.exists(out_path) and not force:
        with open(out_path, encoding="utf-8") as fh:
            records = json.load(fh)
        print(f"Reusing cached corpus at {out_path} ({len(records):,} records)")
        return records, out_path

    print(f"Fetching {SOURCE_URL}", flush=True)
    resp = requests.get(SOURCE_URL, timeout=timeout)
    resp.raise_for_status()
    raw = resp.json()

    if not isinstance(raw, list):
        raise TypeError(f"expected a JSON list from the source, got {type(raw).__name__}")

    # The file's first row is the Croissant dataset metadata row, not a
    # publication: it has every label attached at once, a placeholder title, and
    # an empty DOI. Filtering on a real DOI drops it. Without this filter it
    # would become one training pair per label, weighted equally with a genuine
    # publication, and would poison the metrics.
    records = [r for r in raw if isinstance(r, dict) and r.get("doi")]

    if not records:
        raise RuntimeError(
            "no publication records survived filtering — the source schema "
            "probably changed. Check SOURCE_URL before assuming the corpus is "
            "just empty."
        )

    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(records, fh, ensure_ascii=False)
        fh.write("\n")

    print(f"Fetched {len(records):,} publication records -> {out_path}")
    return records, out_path


def describe(records: list[dict]) -> None:
    """
    Print what was actually downloaded.

    A count on its own is not evidence the corpus is the right one. This prints
    the label histogram and a few real titles so a reader can see the classes
    are real research areas — `Cryospheric Indicators` in particular — rather
    than taking the provenance on trust.
    """
    labels: Counter[str] = Counter()
    for record in records:
        for entry in record.get("labels") or []:
            name = entry.get("name") if isinstance(entry, dict) else entry
            if name:
                labels[str(name)] += 1

    unlabelled = sum(1 for r in records if not (r.get("labels") or []))
    empty_abstract = sum(1 for r in records if not (r.get("abstract") or "").strip())
    years = [r["year"] for r in records if isinstance(r.get("year"), int)]

    print("\nCorpus summary")
    print("=" * 72)
    print(f"  records            {len(records):,}")
    print(f"  (text, label) pairs {sum(labels.values()):,}")
    print(f"  distinct labels     {len(labels)}")
    print(f"  records w/o label   {unlabelled}")
    print(f"  empty abstract      {empty_abstract}")
    if years:
        print(f"  year range          {min(years)}–{max(years)}")

    print("\n  research areas (pairs, not records — labels are multi-valued):")
    for name, count in labels.most_common():
        print(f"    {count:5,d}  {name}")

    print("\n  sample titles:")
    for record in records[:5]:
        names = [
            e["name"] if isinstance(e, dict) else str(e)
            for e in (record.get("labels") or [])
        ]
        title = str(record.get("title", "")).strip()
        print(f"    [{', '.join(names) or 'unlabelled'}]")
        print(f"      {title[:96]}")
    print("=" * 72, flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--force",
        action="store_true",
        help="re-download even if the corpus is already cached on disk",
    )
    args = parser.parse_args()

    try:
        records, out_path = fetch(force=args.force)
    except requests.HTTPError as exc:
        print(f"ERROR: source returned HTTP {exc.response.status_code}", file=sys.stderr)
        return 1
    except requests.RequestException as exc:
        print(f"ERROR: could not reach the source: {exc}", file=sys.stderr)
        return 1

    describe(records)
    print(f"\nCorpus ready at {os.path.abspath(out_path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
