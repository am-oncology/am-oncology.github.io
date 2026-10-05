"""The Exeter: the whole schedule (procedures plus a consultations table) is one HTML page."""
from __future__ import annotations

from .common import HarvestError, debug_dump, get, parse_fee_tables, require_robots_ok, session

PAGE_URL = "https://dyn.the-exeter.com/feeschedule"


def harvest() -> tuple[list[dict], dict]:
    s = session()
    require_robots_ok(s, PAGE_URL)
    html = get(s, PAGE_URL).text
    records = parse_fee_tables(html)
    if not records:
        debug_dump("exeter_feeschedule.html", html)
        raise HarvestError("No fee rows parsed from The Exeter's fee schedule page")
    for r in records:
        r["source_url"] = PAGE_URL
    return records, {"source_url": PAGE_URL}
