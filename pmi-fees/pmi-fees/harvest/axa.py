"""AXA Health Schedule of Procedures and Fees.

Plain server-rendered HTML: an index page lists ~22 CCSD chapters, each a
SectionDetails page holding that chapter's fee rows. Two variants exist:
'contracted' (fee-approved specialists) and 'published' (fee-limited).
"""
from __future__ import annotations

import re
from urllib.parse import parse_qs, urlencode, urljoin, urlparse, urlunparse

from bs4 import BeautifulSoup

from .common import HarvestError, clean, debug_dump, get, log, parse_fee_tables, require_robots_ok, session

BASE = "https://specialistforms.onlineapps.axahealth.co.uk/"
INDEX_URLS = {
    "contracted": BASE + "?source=contracted",
    "published": BASE + "SpecialistCode.mvc?source=published",
}
SECTION_NOTE_RE = re.compile(r"Chapter\s+\d+\s*/[^\n]*\n(.*?)\n\s*\d+\.\d+\s*-", re.S)


def _with_source(url: str, source: str) -> str:
    parts = urlparse(url)
    q = parse_qs(parts.query)
    q["source"] = [source]
    return urlunparse(parts._replace(query=urlencode(q, doseq=True)))


def chapter_links(index_html: str, source: str) -> list[tuple[str, str]]:
    soup = BeautifulSoup(index_html, "lxml")
    seen, out = set(), []
    for a in soup.find_all("a", href=True):
        if "SectionDetails" not in a["href"]:
            continue
        url = _with_source(urljoin(BASE, a["href"]), source)
        if url in seen:
            continue
        seen.add(url)
        row = a.find_parent("tr")
        title = clean(row.get_text(" ", strip=True) if row else a.get_text(" ", strip=True), 160)
        out.append((url, title))
    return out


def chapter_note(html: str) -> str:
    """Free text above the first section, e.g. 'These fees are intended to be all inclusive...'."""
    text = BeautifulSoup(html, "lxml").get_text("\n", strip=True)
    m = SECTION_NOTE_RE.search(text)
    return clean(m.group(1), 600) if m else ""


def harvest(source: str) -> tuple[list[dict], dict]:
    index_url = INDEX_URLS[source]
    s = session()
    require_robots_ok(s, index_url)
    index_html = get(s, index_url).text
    links = chapter_links(index_html, source)
    if not links:
        debug_dump(f"axa_{source}_index.html", index_html)
        raise HarvestError("No chapter links found on the AXA index page")

    records: dict[str, dict] = {}
    for url, title in links:
        html = get(s, url).text
        rows = parse_fee_tables(html)
        if not rows:
            debug_dump(f"axa_{source}_{url.rsplit('/', 1)[-1].split('?')[0]}.html", html)
            log.warning("AXA %s: no rows parsed from %s", source, title)
        note = chapter_note(html)
        for r in rows:
            if r["code"] in records:
                continue
            r["chapter"] = title
            r["notes"] = note
            r["source_url"] = url
            records[r["code"]] = r
        log.info("AXA %s: %-60s %4d rows", source, title[:60], len(rows))

    return list(records.values()), {"source_url": index_url, "chapters": len(links)}
