"""Freedom Health Insurance (Freedom Elite): one PDF per CCSD chapter, linked from an index page."""
from __future__ import annotations

from urllib.parse import urljoin

from bs4 import BeautifulSoup

from .common import HarvestError, clean, debug_dump, get, log, parse_pdf, require_robots_ok, session

INDEX_URL = "https://www.freedomhealthinsurance.co.uk/elite/schedule-of-procedures"


def chapter_links(html: str) -> list[tuple[str, str]]:
    soup = BeautifulSoup(html, "lxml")
    out, seen = [], set()
    for a in soup.find_all("a", href=True):
        href, label = a["href"], a.get_text(" ", strip=True)
        if "getmedia" in href.lower() and "chapter" in (href + label).lower():
            url = urljoin(INDEX_URL, href)
            if url not in seen:
                seen.add(url)
                out.append((url, clean(label, 120)))
    return out


def harvest() -> tuple[list[dict], dict]:
    s = session()
    require_robots_ok(s, INDEX_URL)
    index = get(s, INDEX_URL).text
    links = chapter_links(index)
    if not links:
        debug_dump("freedom_index.html", index)
        raise HarvestError("No chapter PDFs linked from the Freedom schedule page")
    records: dict[str, dict] = {}
    for url, title in links:
        data = get(s, url).content
        rows, note = parse_pdf(data)
        if not rows:
            debug_dump(f"freedom_{len(records)}.pdf", data)
            log.warning("Freedom: no rows parsed from %s", title)
        for r in rows:
            if r["code"] not in records:
                r["chapter"], r["source_url"] = title, url
                r["notes"] = " ".join(x for x in (note, r["notes"]) if x)
                records[r["code"]] = r
        log.info("Freedom: %-60s %4d rows", title[:60], len(rows))
    return list(records.values()), {"source_url": INDEX_URL, "chapters": len(links)}
