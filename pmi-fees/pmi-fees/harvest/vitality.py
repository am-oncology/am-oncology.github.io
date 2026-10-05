"""Vitality fee finder.

The 'fee finder' is a downloadable .xlsx whose filename carries a date, so the
link is re-discovered from the page on every run. Column layout is detected
from the header row rather than assumed.
"""
from __future__ import annotations

import io
from urllib.parse import urljoin

import openpyxl
from bs4 import BeautifulSoup

from .common import HarvestError, clean, debug_dump, get, is_code, log, norm_code, parse_money, require_robots_ok, session

PAGE_URL = "https://www.vitality.co.uk/healthcare-providers/fee-finder/"
OLD_WORDS = ("old", "previous", "prior", "was")
FEE_WORDS = ("fee", "£", "price", "benefit", "max", "amount", "limit", "rate")


def find_xlsx_link(html: str) -> str:
    soup = BeautifulSoup(html, "lxml")
    candidates = []
    for a in soup.find_all("a", href=True):
        if ".xlsx" not in a["href"].lower():
            continue
        label = a.get_text(" ", strip=True).lower()
        score = ("surgical" in label) * 2 + ("fee" in label)
        candidates.append((score, urljoin(PAGE_URL, a["href"])))
    if not candidates:
        raise HarvestError("No .xlsx link found on the Vitality fee finder page")
    return max(candidates)[1]


def _header_map(row: list[str]) -> dict | None:
    h = [str(c or "").strip().lower() for c in row]
    code_col = next((i for i, t in enumerate(h) if "code" in t and "group" not in t), None)
    if code_col is None:
        return None
    fee_cols = [i for i, t in enumerate(h)
                if i != code_col and any(w in t for w in FEE_WORDS)
                and not any(t.startswith(w) or f" {w} " in f" {t} " for w in OLD_WORDS)]
    if not fee_cols:
        return None
    anaes = next((i for i in fee_cols if "anaes" in h[i] or "anes" in h[i]), None)
    proc = next((i for i in fee_cols if i != anaes), None)
    return {
        "code": code_col,
        "desc": next((i for i, t in enumerate(h) if "desc" in t or "procedure" == t), None),
        "complexity": next((i for i, t in enumerate(h) if "complex" in t), None),
        "fee": proc,
        "anaes": anaes,
        "headers": h,
    }


def parse_workbook(data: bytes) -> list[dict]:
    wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    records: dict[str, dict] = {}
    for ws in wb.worksheets:
        rows = ws.iter_rows(values_only=True)
        cols = None
        for _ in range(40):  # header row is somewhere near the top
            try:
                row = list(next(rows))
            except StopIteration:
                break
            cols = _header_map(row)
            if cols:
                break
        if not cols:
            log.info("Vitality: sheet %r has no recognisable header; skipped", ws.title)
            continue
        n = 0
        for row in rows:
            row = list(row)
            if len(row) <= cols["code"] or not is_code(row[cols["code"]]):
                continue
            code = norm_code(row[cols["code"]])
            fee = parse_money(row[cols["fee"]]) if cols["fee"] is not None and cols["fee"] < len(row) else None
            if fee is None or code in records:
                continue
            pick = lambda key: row[cols[key]] if cols[key] is not None and cols[key] < len(row) else None
            records[code] = {
                "code": code,
                "description": clean(pick("desc"), 400),
                "complexity": clean(pick("complexity"), 30),
                "fee": fee,
                "anaes": parse_money(pick("anaes")),
                "section": ws.title,
                "notes": "",
                "unacceptable": [],
            }
            n += 1
        log.info("Vitality: sheet %r -> %d rows", ws.title, n)
    return list(records.values())


def harvest() -> tuple[list[dict], dict]:
    s = session()
    require_robots_ok(s, PAGE_URL)
    page = get(s, PAGE_URL).text
    xlsx_url = find_xlsx_link(page)
    data = get(s, xlsx_url).content
    records = parse_workbook(data)
    if not records:
        debug_dump("vitality_fee_finder.xlsx", data)
        raise HarvestError(f"Spreadsheet parsed to zero rows: {xlsx_url}")
    for r in records:
        r["source_url"] = xlsx_url
    return records, {"source_url": PAGE_URL, "file_url": xlsx_url}
