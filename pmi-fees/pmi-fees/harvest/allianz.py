"""Allianz Care UK published fee schedule: a single PDF.

The December 2024 edition is tried first; the older 2015 document is the
fallback if that link ever disappears.
"""
from __future__ import annotations

from .common import HarvestError, debug_dump, get, log, parse_pdf, require_robots_ok, session

PDF_URLS = [
    "https://www.allianzcare.com/content/dam/onemarketing/azcare/allianzcare/documents/hidden/UK-Recognition-Fee-Schedule-EN.pdf",
    "https://www.allianzworldwidecare.com/content/dam/onemarketing/azcare/allianzcare/en/docs/hidden/UKreg_FeeSchedule.pdf",
]


def harvest() -> tuple[list[dict], dict]:
    s = session()
    errors = []
    for url in PDF_URLS:
        try:
            require_robots_ok(s, url)
            data = get(s, url).content
        except Exception as exc:  # try the next edition
            errors.append(f"{url}: {exc}")
            continue
        records, _ = parse_pdf(data)
        if records:
            for r in records:
                r["source_url"] = url
            log.info("Allianz: %d rows from %s", len(records), url)
            return records, {"source_url": url, "file_url": url}
        debug_dump("allianz_schedule.pdf", data)
        errors.append(f"{url}: parsed to zero rows")
    raise HarvestError("; ".join(errors))
