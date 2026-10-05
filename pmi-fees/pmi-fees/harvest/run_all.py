"""Nightly run: harvest every schedule, merge, diff, write docs/data/*.json.

    python -m harvest.run_all                  # everything
    python -m harvest.run_all --only axa_fa    # one or more source ids

A source that fails, or returns far fewer rows than last time (a sign the
page layout changed and the parser broke), keeps its previous data and is
marked stale, so one bad night never blanks the table.
"""
from __future__ import annotations

import argparse
import csv
import json
import logging
import os
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path

from . import allianz, axa, browser, exeter, freedom, vitality
from .common import ROOT, clean, is_code, log, norm_code, parse_money

DATA_DIR = ROOT / "docs" / "data"
FEES_PATH = DATA_DIR / "fees.json"
CHANGES_PATH = DATA_DIR / "changes.json"
SUMMARY_PATH = ROOT / "changes_summary.md"  # exists only when fees changed -> workflow opens an issue
KEEP_CHANGES = 1000
SHRINK_GUARD = 0.7  # reject a harvest with < 70% of last night's row count
FIELDS = ("fee", "anaes", "complexity")

MANUAL_DIR = ROOT / "manual"
SOURCES = [
    {"id": "axa_fa", "insurer": "AXA Health", "schedule": "Fee-approved",
     "run": lambda: axa.harvest("contracted")},
    {"id": "axa_fl", "insurer": "AXA Health", "schedule": "Fee-limited",
     "run": lambda: axa.harvest("published")},
    {"id": "bupa", "insurer": "Bupa", "schedule": "Benefit maxima, checked by hand",
     "manual": MANUAL_DIR / "bupa.csv"},
    {"id": "aviva", "insurer": "Aviva", "schedule": "Fee schedule", "run": lambda: browser.harvest("aviva")},
    {"id": "vitality", "insurer": "Vitality", "schedule": "Fee finder", "run": vitality.harvest},
    {"id": "wpa", "insurer": "WPA", "schedule": "Fee schedule", "run": lambda: browser.harvest("wpa")},
    {"id": "exeter", "insurer": "The Exeter", "schedule": "Fee schedule", "run": exeter.harvest},
    {"id": "freedom", "insurer": "Freedom", "schedule": "Elite schedule", "run": freedom.harvest},
    {"id": "allianz", "insurer": "Allianz Care", "schedule": "UK fee schedule", "run": allianz.harvest},
    {"id": "healix", "insurer": "Healix", "schedule": "Fee schedule", "run": lambda: browser.harvest("healix")},
    {"id": "cshealthcare", "insurer": "CS Healthcare", "schedule": "Fee schedule",
     "run": lambda: browser.harvest("cshealthcare")},
]
# Names for hand-checked schedules: drop manual/<id>.csv in and it appears.
MANUAL_NAMES = {
    "cigna": "Cigna", "generalandmedical": "General & Medical", "general_medical": "General & Medical",
    "saga": "Saga", "nationalfriendly": "National Friendly", "simplyhealth": "Simplyhealth",
    "benenden": "Benenden", "bupa_global": "Bupa Global",
}


def all_sources() -> list[dict]:
    known = {s["id"] for s in SOURCES}
    extra = []
    for path in sorted(MANUAL_DIR.glob("*.csv")):
        sid = path.stem.lower()
        if sid not in known:
            extra.append({"id": sid, "insurer": MANUAL_NAMES.get(sid, sid.replace("_", " ").title()),
                          "schedule": "Checked by hand", "manual": path})
    return SOURCES + extra



def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def load_json(path: Path, default):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default


def _money(raw) -> float | None:
    raw = str(raw or "").strip()
    return parse_money(raw if raw.startswith("£") else f"£{raw}") if raw else None


def read_manual(path: Path) -> list[dict]:
    """Hand-checked rows: code,fee,anaesthetist_fee,complexity,notes,checked_on (YYYY-MM-DD)."""
    if not path.exists():
        return []
    out = []
    with path.open(newline="", encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            code = norm_code(row.get("code"))
            fee = _money(row.get("fee"))
            if not is_code(code) or fee is None:
                continue
            out.append({
                "code": code,
                "description": "",
                "fee": fee,
                "anaes": _money(row.get("anaesthetist_fee")),
                "complexity": clean(row.get("complexity"), 30),
                "notes": clean(row.get("notes"), 600),
                "as_of": (row.get("checked_on") or "").strip() or None,
                "unacceptable": [],
            })
    return out


def slice_for(dataset: dict, sid: str) -> dict:
    """{code: entry} for one source from a built dataset."""
    return {code: c["fees"][sid] for code, c in dataset.get("codes", {}).items() if sid in c.get("fees", {})}


def to_entry(rec: dict) -> dict:
    keep = ("fee", "anaes", "complexity", "section", "chapter", "notes", "unacceptable", "as_of", "source_url")
    return {k: rec[k] for k in keep if rec.get(k) not in (None, "", [])}


def build(previous: dict, results: dict, stamp: str, sources: list[dict] | None = None) -> tuple[dict, list[dict]]:
    """Pure merge step. results: {sid: ("ok", records, meta) | ("error", message, None)}."""
    sources = sources if sources is not None else all_sources()
    prev_sources = previous.get("sources", {})
    descriptions: dict[str, str] = {code: c.get("description", "") for code, c in previous.get("codes", {}).items()}
    slices: dict[str, dict] = {}
    sources_meta: dict[str, dict] = {}
    changes: list[dict] = []

    for src in sources:
        sid = src["id"]
        prev_meta = prev_sources.get(sid, {})
        prev_slice = slice_for(previous, sid)
        meta = {"insurer": src["insurer"], "schedule": src["schedule"],
                "manual": "manual" in src, "last_attempt": stamp}
        outcome = results.get(sid)

        if outcome is None:  # not run this time (--only): carry forward untouched
            if prev_slice or prev_meta:
                slices[sid] = prev_slice
                sources_meta[sid] = prev_meta
            continue

        status, payload, extra = outcome
        if status == "ok" and prev_slice and len(prev_slice) >= 50 and len(payload) < SHRINK_GUARD * len(prev_slice):
            status, payload = "error", (f"Parsed {len(payload)} rows against {len(prev_slice)} last time; "
                                        "kept previous data in case the page layout changed")

        if status == "ok":
            new_slice = {}
            for rec in payload:
                new_slice[rec["code"]] = to_entry(rec)
                if rec.get("description") and not descriptions.get(rec["code"]):
                    descriptions[rec["code"]] = rec["description"]
            if prev_slice and not meta["manual"]:
                changes += diff_slice(sid, prev_slice, new_slice, stamp)
            slices[sid] = new_slice
            meta.update({"status": "manual" if meta["manual"] else "ok", "last_success": stamp,
                         "count": len(new_slice), "error": None, **(extra or {})})
        else:
            slices[sid] = prev_slice
            meta.update({k: prev_meta.get(k) for k in ("last_success", "source_url", "file_url")})
            meta.update({"status": "stale" if prev_slice else "failed", "count": len(prev_slice),
                         "error": str(payload)[:500]})
        sources_meta[sid] = meta

    codes: dict[str, dict] = {}
    for sid, sl in slices.items():
        for code, entry in sl.items():
            codes.setdefault(code, {"description": descriptions.get(code, ""), "fees": {}})["fees"][sid] = entry
    dataset = {"generated_at": stamp, "sources": sources_meta, "codes": dict(sorted(codes.items()))}
    return dataset, changes


def diff_slice(sid: str, old: dict, new: dict, stamp: str) -> list[dict]:
    out = []
    for code in sorted(set(old) | set(new)):
        a, b = old.get(code), new.get(code)
        if a is None:
            out.append({"at": stamp, "source": sid, "code": code, "kind": "added", "old": None, "new": b.get("fee")})
        elif b is None:
            out.append({"at": stamp, "source": sid, "code": code, "kind": "removed", "old": a.get("fee"), "new": None})
        else:
            for f in FIELDS:
                if a.get(f) != b.get(f):
                    out.append({"at": stamp, "source": sid, "code": code, "kind": f, "old": a.get(f), "new": b.get(f)})
    return out


def summary_markdown(dataset: dict, changes: list[dict]) -> str:
    lines = ["| Source | Status | Rows | Note |", "|---|---|---|---|"]
    for sid, m in dataset["sources"].items():
        lines.append(f"| {m['insurer']} ({m['schedule']}) | {m['status']} | {m['count']} | {m.get('error') or ''} |")
    if changes:
        lines += ["", f"**{len(changes)} change(s) detected**", "", "| Source | Code | Change | Old | New |", "|---|---|---|---|---|"]
        for c in changes[:300]:
            lines.append(f"| {c['source']} | {c['code']} | {c['kind']} | {c['old']} | {c['new']} |")
        if len(changes) > 300:
            lines.append(f"\n…and {len(changes) - 300} more; see docs/data/changes.json")
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="comma-separated source ids")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    only = set(args.only.split(",")) if args.only else None
    stamp = now_iso()

    sources = all_sources()
    results = {}
    for src in sources:
        sid = src["id"]
        if only and sid not in only:
            continue
        try:
            if "manual" in src:
                results[sid] = ("ok", read_manual(src["manual"]), {"source_url": f"manual/{src['manual'].name}"})
            else:
                records, meta = src["run"]()
                results[sid] = ("ok", records, meta)
            log.info("%s: %d rows", sid, len(results[sid][1]))
        except Exception as exc:  # one source failing must not stop the others
            log.error("%s failed: %s", sid, exc)
            traceback.print_exc()
            results[sid] = ("error", f"{type(exc).__name__}: {exc}", None)

    previous = load_json(FEES_PATH, {})
    dataset, changes = build(previous, results, stamp, sources)

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    FEES_PATH.write_text(json.dumps(dataset, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    history = (changes + load_json(CHANGES_PATH, []))[:KEEP_CHANGES]
    CHANGES_PATH.write_text(json.dumps(history, ensure_ascii=False, indent=0), encoding="utf-8")

    summary = summary_markdown(dataset, changes)
    if changes:
        SUMMARY_PATH.write_text(summary, encoding="utf-8")
    elif SUMMARY_PATH.exists():
        SUMMARY_PATH.unlink()
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as fh:
            fh.write(summary + "\n")
    print(summary)

    manual_ids = {s["id"] for s in sources if "manual" in s}
    automatic = [r for sid, r in results.items() if sid not in manual_ids]
    return 1 if automatic and all(r[0] == "error" for r in automatic) else 0


if __name__ == "__main__":
    sys.exit(main())
