"""Search-app insurers, driven with a headless browser.

Aviva, WPA, Healix and CS Healthcare publish their schedules only through an
interactive search. One harvester serves all four: it loads the page, works
the search in a few generic ways (each option of a drop-down, a custom
drop-down, an empty search, or a search per code letter), and collects rows
two ways at once:

  * from the page itself (any table of codes and £ amounts), and
  * from the JSON the page fetches behind the scenes, whatever its shape.

Every data request the page makes is listed in debug/<site>_requests.txt. If a
site turns out to serve a clean JSON API, that harvester can later become a
few plain HTTP calls.

These are the least certain sources, because the forms could not be tried
before the first live run. A site that yields nothing keeps its previous data
and leaves its HTML in debug/ for a fix.
"""
from __future__ import annotations

import json
import string
import time

from .common import (USER_AGENT, HarvestError, debug_dump, log, parse_fee_tables, records_from_json,
                     require_robots_ok, session)

SITES = {
    "aviva": {"url": "https://www.aviva.co.uk/health-insurance/providers/practitioners/fee-schedule/details",
              "strategies": ["select_each", "search_terms"]},
    "wpa": {"url": "https://www.wpa.org.uk/healthcare-providers/medical-fees",
            "strategies": ["custom_dropdown", "search_terms"], "dropdown_text": "Select an area of speciality"},
    "healix": {"url": "https://hsp.healix.com/hfs", "strategies": ["empty_search", "search_terms"]},
    "cshealthcare": {"url": "https://www.cshealthcare.co.uk/hospitals-and-fees/our-fee-schedule/",
                     "strategies": ["select_each", "search_terms"]},
}
SEARCH_TERMS = list(string.ascii_uppercase) + ["20", "22", "25", "64"]
ENOUGH_ROWS = 300          # a strategy that reaches this is taken as the whole schedule
MAX_SELECT_OPTIONS = 60    # beyond this a drop-down is a code list, not a set of groups
MAX_PAGES = 60
SITE_TIME_LIMIT_S = 20 * 60
PAUSE_MS = 1500


class _Collector:
    def __init__(self, page, site: str):
        self.page, self.site = page, site
        self.records: dict[str, dict] = {}
        self.responses: list = []
        self.requests: list[str] = []
        self.dumped = 0
        page.on("request", lambda r: self.requests.append(f"{r.method} {r.resource_type} {r.url}")
                if r.resource_type in ("xhr", "fetch", "document") else None)
        page.on("response", lambda r: self.responses.append(r)
                if "json" in (r.headers.get("content-type") or "") else None)

    def harvest_view(self, label: str) -> int:
        """Collect from the current page plus any JSON received since last time."""
        before = len(self.records)
        for pn in range(MAX_PAGES):
            try:
                self.page.wait_for_load_state("networkidle", timeout=20000)
            except Exception:
                pass
            for r in parse_fee_tables(self.page.content()):
                self._add(r, label)
            while self.responses:
                resp = self.responses.pop(0)
                try:
                    for r in records_from_json(resp.json()):
                        self._add(r, label)
                except Exception:
                    continue
            if not _next_page(self.page):
                break
        found = len(self.records) - before
        if not found and self.dumped < 5:
            debug_dump(f"{self.site}_empty_{self.dumped}.html", self.page.content())
            self.dumped += 1
        return found

    def _add(self, rec: dict, label: str) -> None:
        have = self.records.get(rec["code"])
        if have is None:
            rec["section"] = rec.get("section") or label
            self.records[rec["code"]] = rec
            return
        for key in ("anaes", "description", "complexity", "notes", "unacceptable"):
            if have.get(key) in (None, "", []) and rec.get(key) not in (None, "", []):
                have[key] = rec[key]  # e.g. the table shows the fee, the JSON adds the anaesthetist fee


def harvest(site: str) -> tuple[list[dict], dict]:
    from playwright.sync_api import sync_playwright  # only needed for these sources

    cfg = SITES[site]
    url = cfg["url"]
    require_robots_ok(session(), url)
    started = time.monotonic()
    used = None

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(user_agent=USER_AGENT, locale="en-GB")
        col = _Collector(page, site)
        _open(page, url)
        col.harvest_view("")  # some sites show everything (or fire the API) on load

        for strategy in cfg["strategies"]:
            if len(col.records) >= ENOUGH_ROWS:
                break
            before = len(col.records)
            try:
                STRATEGIES[strategy](page, col, cfg, started)
            except Exception as exc:
                log.warning("%s: strategy %s failed: %s", site, strategy, exc)
            if len(col.records) > before and used is None:
                used = strategy
            log.info("%s: after %s, %d rows", site, strategy, len(col.records))

        debug_dump(f"{site}_requests.txt", "\n".join(dict.fromkeys(col.requests)))
        if not col.records:
            debug_dump(f"{site}_page.html", page.content())
        browser.close()

    if not col.records:
        raise HarvestError(f"No fee rows found on {url} (see debug/{site}_*.html and {site}_requests.txt)")
    records = list(col.records.values())
    for r in records:
        r["source_url"] = url
    return records, {"source_url": url, "method": used or "page load"}


# ---------------------------------------------------------------- strategies

def _select_each(page, col, cfg, started):
    selects = [s for s in page.locator("select").all() if s.is_visible()]
    for sel in selects:
        options = [o.strip() for o in sel.locator("option").all_inner_texts()]
        options = [o for o in options if o and not o.lower().startswith(("select", "choose", "please"))]
        if not options or len(options) > MAX_SELECT_OPTIONS or all(o.isdigit() for o in options):
            continue
        for label in options:
            if time.monotonic() - started > SITE_TIME_LIMIT_S:
                return
            _open(page, cfg["url"])
            target = [s for s in page.locator("select").all() if s.is_visible()][selects.index(sel)]
            target.select_option(label=label)
            _submit_near(page, target)
            _maximise_page_size(page)
            col.harvest_view(label.title())
            page.wait_for_timeout(PAUSE_MS)
        return


def _custom_dropdown(page, col, cfg, started):
    trigger_text = cfg.get("dropdown_text")
    trigger = page.get_by_text(trigger_text, exact=False).first
    trigger.click()
    page.wait_for_timeout(500)
    opts = page.locator("[role=option], [role=listbox] li, ul[class*=option] li, ul[class*=dropdown] li")
    labels = [t.strip() for t in opts.all_inner_texts() if t.strip()]
    for label in labels[:MAX_SELECT_OPTIONS]:
        if time.monotonic() - started > SITE_TIME_LIMIT_S:
            return
        _open(page, cfg["url"])
        page.get_by_text(trigger_text, exact=False).first.click()
        page.wait_for_timeout(300)
        page.get_by_text(label, exact=True).first.click()
        _submit_near(page, None)
        _maximise_page_size(page)
        col.harvest_view(label)
        page.wait_for_timeout(PAUSE_MS)


def _empty_search(page, col, cfg, started):
    _submit_near(page, None)
    _maximise_page_size(page)
    col.harvest_view("")


def _search_terms(page, col, cfg, started):
    for term in SEARCH_TERMS:
        if time.monotonic() - started > SITE_TIME_LIMIT_S:
            return
        _open(page, cfg["url"])
        box = _search_box(page)
        if box is None:
            return
        box.fill(term)
        box.press("Enter")
        _submit_near(page, box, only_if_needed=True)
        _maximise_page_size(page)
        col.harvest_view("")
        page.wait_for_timeout(PAUSE_MS)


STRATEGIES = {"select_each": _select_each, "custom_dropdown": _custom_dropdown,
              "empty_search": _empty_search, "search_terms": _search_terms}


# ------------------------------------------------------------------- helpers

def _open(page, url):
    page.goto(url, wait_until="networkidle", timeout=60000)
    for label in ("Accept all cookies", "Accept all", "Accept cookies", "Allow all", "Reject all"):
        btn = page.get_by_role("button", name=label)
        if btn.count():
            try:
                btn.first.click(timeout=3000)
            except Exception:
                pass
            break


def _search_box(page):
    for sel in ("input[type=search]", "input[type=text]"):
        boxes = [b for b in page.locator(sel).all() if b.is_visible()]
        if boxes:
            return boxes[0]
    return None


def _submit_near(page, element, only_if_needed=False):
    if element is not None:
        form_btn = element.locator("xpath=ancestor::form[1]//*[self::button or self::input[@type='submit']]")
        if form_btn.count():
            form_btn.first.click()
            return
    if only_if_needed:
        return
    buttons = [b for b in page.get_by_role("button", name="Search").all() if b.is_visible()]
    if buttons:
        (buttons[1] if element is not None and len(buttons) > 1 else buttons[0]).click()


def _maximise_page_size(page):
    for sel in page.locator("select").all():
        try:
            opts = [o.strip() for o in sel.locator("option").all_inner_texts()]
        except Exception:
            continue
        if opts and all(o.isdigit() or o.lower() == "all" for o in opts):
            best = "All" if any(o.lower() == "all" for o in opts) else max(opts, key=int)
            try:
                sel.select_option(label=best)
                page.wait_for_load_state("networkidle", timeout=15000)
            except Exception:
                pass


def _next_page(page) -> bool:
    nxt = page.locator("a[rel='next'], a:has-text('Next'), button:has-text('Next'), li.next a")
    try:
        if nxt.count() and nxt.first.is_visible() and nxt.first.is_enabled():
            nxt.first.click()
            page.wait_for_timeout(800)
            return True
    except Exception:
        pass
    return False
