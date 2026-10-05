#!/usr/bin/env python3
"""
Build the library used by consent/index.html.

What it does
  * RCR      downloads every national radiotherapy consent form (PDF)
  * CRUK     downloads every SACT regimen consent form (PDF)
  * Macmillan saves treatment / drug / radiotherapy information pages as PDFs
  * custom   indexes any PDFs you put in consent/custom/ (e.g. local Trust forms)
and writes consent/library/catalogue.json.

Only files whose content has changed are rewritten, so weekly runs make small commits.
If a source can't be reached, its previous files and catalogue entries are kept.

Run by .github/workflows/update-consent-library.yml. To run locally:
    pip install -r scripts/requirements-consent.txt
    python -m playwright install chromium
    python scripts/update_consent_library.py                 # everything
    python scripts/update_consent_library.py --sources rcr cruk
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import io
import json
import os
import pathlib
import re
import sys
import time
import traceback
import urllib.parse

import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

try:
    import pikepdf
except ImportError:  # pragma: no cover
    pikepdf = None

ROOT = pathlib.Path(__file__).resolve().parents[1]
SITE = ROOT / "consent"
LIB = SITE / "library"
CUSTOM = SITE / "custom"
CATALOGUE = LIB / "catalogue.json"

RCR_URL = "https://www.rcr.ac.uk/our-services/management-service-delivery/national-radiotherapy-consent-forms/"
CRUK_URL = ("https://www.cancerresearchuk.org/health-professional/treatment-and-other-post-diagnosis-issues/"
            "consent-forms-for-sact-systemic-anti-cancer-therapy")
MAC_BASE = "https://www.macmillan.org.uk"
MAC_HUBS = [
    "/cancer-information-and-support/treatments-and-drugs",
    "/cancer-information-and-support/treatment/types-of-treatment/radiotherapy",
    "/cancer-information-and-support/treatment/types-of-treatment/chemotherapy",
]
# Which Macmillan pages to keep (matched against the URL path)
MAC_INCLUDE = [
    r"^/cancer-information-and-support/treatments-and-drugs/[a-z0-9\-]+/?$",
    r"^/cancer-information-and-support/treatment/types-of-treatment/(radiotherapy|chemotherapy|immunotherapy|targeted-therapies|hormonal-therapies)(/[a-z0-9\-]+){0,2}/?$",
    r"^/cancer-information-and-support/[a-z0-9\-/]*/[a-z0-9\-]*(radiotherapy|chemoradiation|chemoradiotherapy|brachytherapy)[a-z0-9\-]*/?$",
]
MAC_EXCLUDE = [r"/(stories-and-media|news|community|in-your-area|get-help|booklets-and-resources|healthcare-professionals)/"]

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/129.0 Safari/537.36")
TODAY = dt.date.today().isoformat()


# --------------------------------------------------------------------------- helpers
def log(*a):
    print(*a, flush=True)


def slug(s: str, n: int = 70) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return s[:n].strip("-") or "item"


def clean_title(s: str) -> str:
    s = re.sub(r"\(\s*PDF[^)]*\)", "", s, flags=re.I)
    s = re.sub(r"\s+", " ", s).strip(" -–\u200b\xa0")
    return s


def sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def make_session() -> requests.Session:
    s = requests.Session()
    retry = Retry(total=4, backoff_factor=2, status_forcelist=(429, 500, 502, 503, 504), allowed_methods=("GET", "HEAD"))
    s.mount("https://", HTTPAdapter(max_retries=retry))
    s.mount("http://", HTTPAdapter(max_retries=retry))
    s.headers.update({"User-Agent": UA, "Accept-Language": "en-GB,en;q=0.9"})
    return s


class Browser:
    """Lazily started headless Chromium (Playwright), used for Macmillan and as a fallback."""

    def __init__(self):
        self._pw = None
        self._browser = None
        self.context = None

    def start(self):
        if self.context:
            return self
        from playwright.sync_api import sync_playwright
        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.launch()
        self.context = self._browser.new_context(user_agent=UA, locale="en-GB", viewport={"width": 1200, "height": 1600})
        return self

    def html(self, url: str) -> str:
        self.start()
        page = self.context.new_page()
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=60000)
            try:
                page.wait_for_load_state("networkidle", timeout=15000)
            except Exception:
                pass
            return page.content()
        finally:
            page.close()

    def get_bytes(self, url: str) -> bytes:
        self.start()
        r = self.context.request.get(url, timeout=60000)
        if not r.ok:
            raise RuntimeError(f"HTTP {r.status}")
        return r.body()

    def close(self):
        try:
            if self._browser:
                self._browser.close()
            if self._pw:
                self._pw.stop()
        except Exception:
            pass


class Fetcher:
    def __init__(self, delay: float = 0.5):
        self.s = make_session()
        self.browser = Browser()
        self.delay = delay

    def html(self, url: str, must_match: str | None = None) -> str:
        err = None
        try:
            r = self.s.get(url, timeout=60)
            if r.ok and (not must_match or re.search(must_match, r.text, re.I)):
                return r.text
            err = f"HTTP {r.status_code}" if not r.ok else "expected links not in static HTML"
        except Exception as e:  # network error
            err = str(e)
        log(f"  static fetch of {url} failed ({err}); trying headless browser")
        return self.browser.html(url)

    def pdf(self, url: str, etag: str | None = None, last_modified: str | None = None):
        """Returns (bytes or None if unchanged, headers)."""
        headers = {}
        if etag:
            headers["If-None-Match"] = etag
        if last_modified:
            headers["If-Modified-Since"] = last_modified
        time.sleep(self.delay)
        try:
            r = self.s.get(url, timeout=90, headers=headers)
            if r.status_code == 304:
                return None, r.headers
            if r.ok and r.content[:5] == b"%PDF-":
                return r.content, r.headers
            err = f"HTTP {r.status_code}" if not r.ok else "not a PDF"
        except Exception as e:
            err = str(e)
        log(f"    direct download failed ({err}); trying headless browser")
        body = self.browser.get_bytes(url)
        if body[:5] != b"%PDF-":
            raise RuntimeError("not a PDF")
        return body, {}


def normalise_pdf(raw: bytes) -> tuple[bytes, dict]:
    """Decrypts (removes owner-password restrictions), drops XFA so the AcroForm is used,
    and reports page / field counts."""
    info = {"pages": None, "fillable": False, "fields": 0}
    if not pikepdf:
        return raw, info
    try:
        with pikepdf.open(io.BytesIO(raw)) as pdf:
            info["pages"] = len(pdf.pages)
            af = pdf.Root.get("/AcroForm")
            if af is not None:
                if "/XFA" in af:
                    del af["/XFA"]
                fields = af.get("/Fields")
                info["fields"] = len(fields) if fields is not None else 0
                info["fillable"] = info["fields"] > 0
            buf = io.BytesIO()
            pdf.save(buf, static_id=True)
            return buf.getvalue(), info
    except Exception as e:
        log(f"    could not normalise PDF ({e}); keeping original bytes")
        return raw, info


def heading_text(el) -> str:
    return re.sub(r"\s+", " ", el.get_text(" ", strip=True)).strip()


HEADING_TAGS = ["h1", "h2", "h3", "h4", "h5", "button", "summary"]


def is_heading(el) -> bool:
    if el.name in HEADING_TAGS:
        return True
    cls = " ".join(el.get("class", []))
    return bool(re.search(r"accordion[-_]*(title|heading|header|button|trigger)", cls, re.I))


def group_for(a, fallback: str) -> str:
    """Nearest heading that precedes the link within its containing blocks."""
    node = a
    for _ in range(8):
        parent = node.parent
        if parent is None:
            break
        for sib in node.find_previous_siblings():
            cands = [sib] if is_heading(sib) else []
            if not cands:
                cands = [h for h in sib.find_all(True) if is_heading(h)]
            for h in reversed(cands):
                t = heading_text(h)
                if 1 < len(t) < 90 and not t.lower().startswith(("skip", "open to read", "show all")):
                    return t
        node = parent
    return fallback


# --------------------------------------------------------------------------- scrapers
def scrape_rcr(f: Fetcher, url: str, include_welsh: bool) -> list[dict]:
    html = f.html(url, must_match=r"/media/[^\"']+\.pdf")
    soup = BeautifulSoup(html, "lxml")
    items, seen = [], set()
    group = "Radiotherapy"
    skip_groups = re.compile(r"supporting documents|acknowledg|faq", re.I)
    skip_titles = re.compile(r"implementation|development of|summary letter|acknowledg", re.I)
    for el in soup.find_all(["h2", "h3", "a"]):
        if el.name in ("h2", "h3"):
            t = heading_text(el)
            if t:
                group = t
            continue
        href = el.get("href") or ""
        if not re.search(r"\.pdf($|\?)", href, re.I):
            continue
        if skip_groups.search(group):
            continue
        abs_url = urllib.parse.urljoin(url, href)
        title = clean_title(el.get_text(" ", strip=True))
        if not title or skip_titles.search(title) or abs_url in seen:
            continue
        seen.add(abs_url)
        welsh = bool(re.search(r"welsh", title + href, re.I))
        if welsh and not include_welsh:
            continue
        title = re.sub(r"^RCR\s+", "", title)
        items.append({
            "id": "rcr-" + slug(title),
            "source": "rcr", "title": title, "group": group,
            "lang": "cy" if welsh else "en", "url": abs_url,
        })
    return items


def scrape_cruk(f: Fetcher, url: str, include_welsh: bool) -> list[dict]:
    html = f.html(url, must_match=r"\.pdf")
    soup = BeautifulSoup(html, "lxml")
    main = soup.find("main") or soup.body or soup
    items, seen_url, seen_id = [], set(), set()
    skip = re.compile(r"guidance|faq|electronic consent|remote consent|healthcare improvement", re.I)
    current = "SACT"
    for el in main.find_all(True):
        if is_heading(el):
            t = heading_text(el)
            if 1 < len(t) < 90:
                current = t
            continue
        if el.name != "a":
            continue
        href = el.get("href") or ""
        if not re.search(r"\.pdf($|\?)", href, re.I):
            continue
        abs_url = urllib.parse.urljoin(url, href)
        title = clean_title(el.get_text(" ", strip=True))
        group = group_for(el, current)
        group = re.sub(r"\s*Last updated.*$", "", group, flags=re.I).strip()
        if not title or abs_url in seen_url or skip.search(title) or skip.search(group):
            continue
        welsh = bool(re.search(r"welsh", title + " " + href, re.I))
        if welsh and not include_welsh:
            continue
        seen_url.add(abs_url)
        iid = f"cruk-{slug(group, 30)}-{slug(title, 60)}"
        k = 2
        while iid in seen_id:
            iid = f"cruk-{slug(group, 30)}-{slug(title, 60)}-{k}"
            k += 1
        seen_id.add(iid)
        items.append({"id": iid, "source": "cruk", "title": title, "group": group,
                      "lang": "cy" if welsh else "en", "url": abs_url})
    return items


def mac_wanted(path: str) -> bool:
    if any(re.search(p, path) for p in MAC_EXCLUDE):
        return False
    return any(re.search(p, path) for p in MAC_INCLUDE)


def mac_discover(f: Fetcher, base: str, sitemap: str | None, limit: int) -> list[str]:
    urls: set[str] = set()
    maps: list[str] = []
    if sitemap:
        maps = [sitemap]
    else:
        try:
            r = f.s.get(base.rstrip("/") + "/robots.txt", timeout=30)
            maps = re.findall(r"(?im)^\s*sitemap:\s*(\S+)", r.text) if r.ok else []
        except Exception:
            maps = []
        if not maps:
            maps = [base.rstrip("/") + "/sitemap.xml"]
    seen_maps = set()
    while maps and len(seen_maps) < 80:
        m = maps.pop(0)
        if m in seen_maps:
            continue
        seen_maps.add(m)
        try:
            r = f.s.get(m, timeout=60)
            if not r.ok:
                continue
            body = r.text
        except Exception:
            continue
        locs = [l.strip() for l in re.findall(r"<loc>\s*(.*?)\s*</loc>", body, re.S)]
        if "<sitemapindex" in body:
            maps.extend(locs)
            continue
        for loc in locs:
            path = urllib.parse.urlparse(loc).path
            if mac_wanted(path):
                urls.add(loc.split("#")[0].rstrip("/"))
    if not urls:
        log("  sitemap gave no matching pages; reading the A to Z hub pages instead")
        for hub in MAC_HUBS:
            try:
                html = f.browser.html(base.rstrip("/") + hub)
            except Exception as e:
                log(f"    hub {hub} failed: {e}")
                continue
            soup = BeautifulSoup(html, "lxml")
            for a in soup.find_all("a", href=True):
                u = urllib.parse.urljoin(base, a["href"]).split("#")[0].split("?")[0].rstrip("/")
                if urllib.parse.urlparse(u).netloc == urllib.parse.urlparse(base).netloc and mac_wanted(urllib.parse.urlparse(u).path):
                    urls.add(u)
    out = sorted(urls)
    if len(out) > limit:
        log(f"  {len(out)} Macmillan pages found; keeping the first {limit} (raise --mac-limit to include more)")
        out = out[:limit]
    return out


def humanise_segment(seg: str) -> str:
    s = seg.replace("-", " ").strip()
    return s[:1].upper() + s[1:]


MAC_CLEANUP_JS = r"""
() => {
  const main = document.querySelector('main') || document.querySelector('#content') || document.querySelector('[role=main]') || document.body;
  // open accordions / details so all text is printed
  main.querySelectorAll('details').forEach(d => d.open = true);
  main.querySelectorAll('[aria-expanded="false"]').forEach(b => { try { b.click(); } catch (e) {} });
  main.querySelectorAll('[hidden]').forEach(e => { if (e.closest('main')) e.hidden = false; });
  const kill = ['nav', 'header', 'footer', 'aside', 'form', 'iframe', 'video', 'button', 'script', 'noscript',
    '[class*="breadcrumb"]', '[class*="share"]', '[class*="donate"]', '[class*="feedback"]', '[class*="newsletter"]',
    '[class*="cookie"]', '[id*="cookie"]', '[class*="chat"]', '[class*="related"]', '[class*="promo"]', '[class*="banner"]',
    '[class*="sidebar"]', '[class*="in-this-section"]', '[class*="search"]', '[class*="skip"]'];
  const h1 = main.querySelector('h1') || document.querySelector('h1');
  const title = h1 ? h1.innerText.trim() : document.title.replace(/\s*\|.*$/, '');
  const keep = main.cloneNode(true);
  kill.forEach(sel => keep.querySelectorAll(sel).forEach(e => e.remove()));
  if (h1 && !keep.querySelector('h1')) keep.prepend(h1.cloneNode(true));
  document.body.innerHTML = '';
  document.body.appendChild(keep);
  const style = document.createElement('style');
  style.textContent = `
    @page { size: A4; margin: 16mm 15mm 18mm; }
    html, body { background: #fff !important; }
    body { font-size: 11pt; line-height: 1.45; color: #111; }
    img { max-width: 100% !important; height: auto !important; page-break-inside: avoid; }
    h1, h2, h3 { page-break-after: avoid; }
    a { color: inherit; text-decoration: none; }
    * { position: static !important; box-shadow: none !important; }
  `;
  document.head.appendChild(style);
  return { title, text: keep.innerText.replace(/\s+/g, ' ').trim() };
}
"""


def render_macmillan(f: Fetcher, url: str, base: str):
    f.browser.start()
    page = f.browser.context.new_page()
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=60000)
        try:
            page.wait_for_load_state("networkidle", timeout=15000)
        except Exception:
            pass
        res = page.evaluate(MAC_CLEANUP_JS)
        page.wait_for_timeout(300)
        text_hash = sha256(res["text"].encode("utf-8"))
        footer = (
            "<div style='font-size:7pt;color:#555;width:100%;padding:0 15mm;display:flex;justify-content:space-between'>"
            f"<span>Macmillan Cancer Support. Saved from {url} on {TODAY}. Check the website for the latest version.</span>"
            "<span><span class='pageNumber'></span>/<span class='totalPages'></span></span></div>"
        )
        pdf = page.pdf(format="A4", print_background=False, display_header_footer=True,
                       header_template="<span></span>", footer_template=footer,
                       margin={"top": "16mm", "bottom": "18mm", "left": "15mm", "right": "15mm"})
        return res["title"], text_hash, pdf
    finally:
        page.close()


# --------------------------------------------------------------------------- main build
def load_catalogue() -> dict:
    if CATALOGUE.exists():
        try:
            return json.loads(CATALOGUE.read_text("utf-8"))
        except Exception:
            pass
    return {"generated": None, "sources": {}, "items": []}


def write_if_changed(path: pathlib.Path, data: bytes) -> bool:
    if path.exists() and path.read_bytes() == data:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return True


def sync_pdf_items(f: Fetcher, source: str, scraped: list[dict], old: dict[str, dict], stats: dict) -> list[dict]:
    out = []
    folder = LIB / source
    for i, it in enumerate(scraped, 1):
        prev = old.get(it["id"])
        rel = f"library/{source}/{it['id'][len(source) + 1:]}.pdf"
        path = SITE / rel
        try:
            same_url = prev and prev.get("url") == it["url"] and path.exists()
            raw, headers = f.pdf(it["url"],
                                 etag=prev.get("etag") if same_url else None,
                                 last_modified=prev.get("lastModified") if same_url else None)
            if raw is None:  # 304 not modified
                out.append({**prev, **it, "file": rel})
                stats["unchanged"] += 1
                continue
            h = sha256(raw)
            if same_url and prev.get("sha256") == h:
                entry = {**prev, **it, "file": rel}
                stats["unchanged"] += 1
            else:
                data, info = normalise_pdf(raw)
                write_if_changed(path, data)
                entry = {**it, "file": rel, "sha256": h, "size": len(data), **info, "retrieved": TODAY}
                stats["updated"] += 1
                log(f"  [{i}/{len(scraped)}] updated: {it['title']}")
            entry["etag"] = headers.get("ETag") or entry.get("etag")
            entry["lastModified"] = headers.get("Last-Modified") or entry.get("lastModified")
            out.append(entry)
        except Exception as e:
            stats["failed"] += 1
            log(f"  [{i}/{len(scraped)}] FAILED {it['title']}: {e}")
            if prev and (SITE / prev["file"]).exists():
                out.append(prev)
    # remove files that are no longer listed
    keep = {(SITE / e["file"]).resolve() for e in out}
    if folder.exists():
        for p in folder.glob("*.pdf"):
            if p.resolve() not in keep:
                p.unlink()
                stats["removed"] += 1
    return out


def build_macmillan(f: Fetcher, args, old: dict[str, dict], stats: dict) -> list[dict]:
    urls = mac_discover(f, args.mac_base, args.mac_sitemap, args.mac_limit)
    log(f"  {len(urls)} Macmillan pages to check")
    if not urls:
        raise RuntimeError("no Macmillan pages found")
    out = []
    base_path = "/cancer-information-and-support/"
    for i, url in enumerate(urls, 1):
        path = urllib.parse.urlparse(url).path.rstrip("/")
        rest = path.split(base_path, 1)[-1]
        segs = [s for s in rest.split("/") if s]
        iid = "mac-" + slug("-".join(segs), 90)
        rel = f"library/macmillan/{iid[4:]}.pdf"
        prev = old.get(iid)
        if segs and segs[0] == "treatments-and-drugs":
            group = "Drugs and treatments"
        else:
            group = " › ".join(humanise_segment(s) for s in segs[:-1]) or "Treatment"
        time.sleep(f.delay)
        try:
            title, text_hash, pdf = render_macmillan(f, url, args.mac_base)
            if prev and prev.get("contentHash") == text_hash and (SITE / rel).exists():
                out.append({**prev, "title": title or prev["title"], "group": group})
                stats["unchanged"] += 1
                continue
            write_if_changed(SITE / rel, pdf)
            pages = None
            if pikepdf:
                try:
                    with pikepdf.open(io.BytesIO(pdf)) as p:
                        pages = len(p.pages)
                except Exception:
                    pass
            out.append({"id": iid, "source": "macmillan", "title": title or humanise_segment(segs[-1]),
                        "group": group, "lang": "en", "url": url, "file": rel, "contentHash": text_hash,
                        "size": len(pdf), "pages": pages, "fillable": False, "fields": 0, "retrieved": TODAY})
            stats["updated"] += 1
            log(f"  [{i}/{len(urls)}] saved: {title}")
        except Exception as e:
            stats["failed"] += 1
            log(f"  [{i}/{len(urls)}] FAILED {url}: {e}")
            if prev and (SITE / prev["file"]).exists():
                out.append(prev)
    keep = {(SITE / e["file"]).resolve() for e in out}
    folder = LIB / "macmillan"
    if folder.exists():
        for p in folder.glob("*.pdf"):
            if p.resolve() not in keep:
                p.unlink()
                stats["removed"] += 1
    return out


def build_custom(stats: dict) -> list[dict]:
    out = []
    if not CUSTOM.exists():
        return out
    for p in sorted(CUSTOM.rglob("*.pdf")):
        rel = p.relative_to(SITE).as_posix()
        sub = p.parent.relative_to(CUSTOM).as_posix()
        group = "Local forms" if sub in ("", ".") else humanise_segment(sub.split("/")[0])
        title = re.sub(r"[_\-]+", " ", p.stem).strip()
        raw = p.read_bytes()
        _, info = normalise_pdf(raw)
        out.append({"id": "custom-" + slug(rel[len("custom/"):-4], 90), "source": "custom", "title": title,
                    "group": group, "lang": "en", "url": None, "file": rel, "sha256": sha256(raw),
                    "size": len(raw), **info})
        stats["updated"] += 1
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sources", nargs="+", default=["rcr", "cruk", "macmillan", "custom"],
                    choices=["rcr", "cruk", "macmillan", "custom"])
    ap.add_argument("--include-welsh", action="store_true", help="also keep Welsh-language forms")
    ap.add_argument("--mac-limit", type=int, default=700, help="maximum Macmillan pages to save")
    ap.add_argument("--delay", type=float, default=0.6, help="seconds between requests")
    ap.add_argument("--rcr-url", default=RCR_URL)
    ap.add_argument("--cruk-url", default=CRUK_URL)
    ap.add_argument("--mac-base", default=MAC_BASE)
    ap.add_argument("--mac-sitemap", default=None, help="use this sitemap URL instead of robots.txt")
    ap.add_argument("--site-dir", default=None, help="folder containing index.html (default: consent/)")
    args = ap.parse_args(argv)

    global SITE, LIB, CUSTOM, CATALOGUE
    if args.site_dir:
        SITE = pathlib.Path(args.site_dir).resolve()
        LIB, CUSTOM, CATALOGUE = SITE / "library", SITE / "custom", SITE / "library" / "catalogue.json"

    LIB.mkdir(parents=True, exist_ok=True)
    cat = load_catalogue()
    old_items = {it["id"]: it for it in cat.get("items", [])}
    by_source: dict[str, list[dict]] = {}
    for it in cat.get("items", []):
        by_source.setdefault(it["source"], []).append(it)
    status = cat.get("sources", {})

    f = Fetcher(delay=args.delay)
    summary = []
    try:
        for src in args.sources:
            stats = {"updated": 0, "unchanged": 0, "failed": 0, "removed": 0}
            log(f"\n== {src.upper()}")
            try:
                if src == "rcr":
                    scraped = scrape_rcr(f, args.rcr_url, args.include_welsh)
                    log(f"  {len(scraped)} forms listed")
                    if not scraped:
                        raise RuntimeError("no forms found on the RCR page (layout may have changed)")
                    items = sync_pdf_items(f, "rcr", scraped, old_items, stats)
                elif src == "cruk":
                    scraped = scrape_cruk(f, args.cruk_url, args.include_welsh)
                    log(f"  {len(scraped)} forms listed")
                    if not scraped:
                        raise RuntimeError("no forms found on the CRUK page (layout may have changed)")
                    items = sync_pdf_items(f, "cruk", scraped, old_items, stats)
                elif src == "macmillan":
                    items = build_macmillan(f, args, old_items, stats)
                else:
                    items = build_custom(stats)
                if src != "custom" and not items:
                    raise RuntimeError("nothing could be downloaded")
                by_source[src] = items
                status[src] = {"ok": True, "count": len(items), "lastSuccess": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                               "error": None, **{k: v for k, v in stats.items()}}
            except Exception as e:
                traceback.print_exc()
                prev = status.get(src, {})
                status[src] = {**prev, "ok": False, "error": str(e)[:300],
                               "count": len(by_source.get(src, []))}
                log(f"  {src}: kept {len(by_source.get(src, []))} existing entries")
            summary.append((src, status[src], stats))
    finally:
        f.browser.close()

    items = [it for src in ("rcr", "cruk", "macmillan", "custom") for it in by_source.get(src, [])]
    items.sort(key=lambda x: (x["source"], (x.get("group") or "").lower(), x["title"].lower()))
    new_cat = {"generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "sources": status, "items": items}
    # avoid a commit when only the timestamp would change
    old_cmp = dict(cat, generated=None)
    new_cmp = dict(new_cat, generated=None)
    old_cmp["sources"] = {k: {kk: vv for kk, vv in v.items() if kk not in ("lastSuccess", "updated", "unchanged", "removed", "failed")} for k, v in cat.get("sources", {}).items()}
    new_cmp["sources"] = {k: {kk: vv for kk, vv in v.items() if kk not in ("lastSuccess", "updated", "unchanged", "removed", "failed")} for k, v in status.items()}
    if json.dumps(old_cmp, sort_keys=True) != json.dumps(new_cmp, sort_keys=True) or not CATALOGUE.exists():
        CATALOGUE.write_text(json.dumps(new_cat, indent=1, ensure_ascii=False), "utf-8")
        log("\ncatalogue.json written")
    else:
        log("\nno changes to the library")

    lines = ["| Source | Status | Items | Updated | Unchanged | Failed | Removed |", "|---|---|---|---|---|---|---|"]
    for src, st, stats in summary:
        lines.append(f"| {src} | {'ok' if st.get('ok') else 'FAILED: ' + str(st.get('error'))} | {st.get('count')} | "
                     f"{stats['updated']} | {stats['unchanged']} | {stats['failed']} | {stats['removed']} |")
    report = "\n".join(lines)
    log("\n" + report)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as fh:
            fh.write("## Consent library update\n\n" + report + "\n")
    return 0 if any(st.get("ok") for _, st, _ in summary) else 1


if __name__ == "__main__":
    sys.exit(main())
