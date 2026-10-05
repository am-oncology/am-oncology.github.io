"""Shared helpers for the fee-schedule harvesters."""
from __future__ import annotations

import logging
import re
import time
import urllib.robotparser
from pathlib import Path
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

log = logging.getLogger("harvest")

# Identify the harvester honestly. Put a contact address here if you like.
USER_AGENT = (
    "PMIFeeReference/1.0 (private fee-schedule reference for a recognised "
    "consultant; one low-rate run per night)"
)
REQUEST_DELAY_S = 1.5  # pause before every request to the same site

ROOT = Path(__file__).resolve().parent.parent
DEBUG_DIR = ROOT / "debug"

# CCSD codes: one or two letters, 3-4 digits, optional trailing letter/digit
# (X0001, A5480, AA536, BT253, IM269; AXA writes some in lower case, x0005),
# or the five-digit chapter 1 codes (20300 initial consultation, 25000, 64300).
# Numeric codes are limited to 2xxxx/6xxxx so phone numbers never match.
CODE_RE = re.compile(r"^(?:[A-Z]{1,2}\d{3,4}[A-Z0-9]?|[26]\d{4})$")
# Consultation tables list surgeon, physician and psychiatrist maxima side by
# side. The physician figure is used as "the" fee (clinical oncology bills as a
# physician); all three are kept in the notes.
CONSULT_ROLES = ("surgeon", "physician", "psychiatrist")
CONSULT_PICK = 1  # index into CONSULT_ROLES
COMPLEXITY_WORDS = {"minor", "intermediate", "major", "xmajor", "major+", "complex", "complex major",
                    "major plus", "non", "n/a", "na"}
# Money: "£1,234.00", "£125", or a bare "125.00". Bare numbers need two
# decimals so a complexity grade such as "3" is never read as a fee.
MONEY_RE = re.compile(r"^(?:£\s*([\d,]+(?:\.\d{1,2})?)|([\d,]+\.\d{2}))$")
SITE_ERROR_FRAGMENTS = ("an error has occured", "an error has occurred", "value cannot be null")


class HarvestError(RuntimeError):
    """A harvester could not produce a result worth trusting."""


def session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": USER_AGENT, "Accept-Language": "en-GB,en;q=0.9"})
    retry = Retry(total=3, backoff_factor=2, status_forcelist=(429, 500, 502, 503, 504))
    s.mount("https://", HTTPAdapter(max_retries=retry))
    s.mount("http://", HTTPAdapter(max_retries=retry))
    return s


def require_robots_ok(s: requests.Session, url: str) -> None:
    """Stop if robots.txt disallows the URL. A missing robots.txt counts as allowed."""
    parts = urlparse(url)
    try:
        r = s.get(f"{parts.scheme}://{parts.netloc}/robots.txt", timeout=20)
    except requests.RequestException as exc:
        log.warning("robots.txt unreachable for %s (%s); continuing", parts.netloc, exc)
        return
    if r.status_code >= 400:
        return
    rp = urllib.robotparser.RobotFileParser()
    rp.parse(r.text.splitlines())
    if not rp.can_fetch(USER_AGENT, url):
        raise HarvestError(f"robots.txt disallows automated access to {url}")


def get(s: requests.Session, url: str, **kw) -> requests.Response:
    time.sleep(REQUEST_DELAY_S)
    r = s.get(url, timeout=kw.pop("timeout", 60), **kw)
    r.raise_for_status()
    return r


def norm_code(text) -> str:
    return re.sub(r"\s+", "", str(text or "")).upper()


def is_code(text) -> bool:
    return bool(CODE_RE.match(norm_code(text)))


def parse_money(value) -> float | None:
    """Float for a fee-looking value, else None."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace("\u00a0", " ").replace("Â£", "£")  # tolerate mis-declared encodings
    m = MONEY_RE.match(text)
    if not m:
        return None
    return float((m.group(1) or m.group(2)).replace(",", ""))


def clean(text, limit: int = 600) -> str:
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    if any(f in text.lower() for f in SITE_ERROR_FRAGMENTS):
        return ""
    return text[:limit]


def debug_dump(name: str, content) -> Path:
    """Keep raw material so an empty or failed run can be diagnosed."""
    DEBUG_DIR.mkdir(exist_ok=True)
    path = DEBUG_DIR / name
    if isinstance(content, bytes):
        path.write_bytes(content)
    else:
        path.write_text(content, encoding="utf-8")
    return path


def _section_for(tr) -> str:
    heading = tr.find_previous(["h3", "h4"])
    return clean(heading.get_text(" ", strip=True), 160) if heading else ""


def make_record(code: str, description: str, amounts: list[float], complexity: str = "",
                section: str = "", consult: bool = False) -> dict:
    """One schedule row. In consultation mode the amounts are surgeon/physician/psychiatrist."""
    rec = {"code": norm_code(code), "description": clean(description, 400), "complexity": complexity,
           "fee": amounts[0], "anaes": amounts[1] if len(amounts) > 1 else None,
           "section": section, "notes": "", "unacceptable": []}
    if consult and len(amounts) > 1:
        pick = min(CONSULT_PICK, len(amounts) - 1)
        rec["fee"], rec["anaes"] = amounts[pick], None
        parts = [f"{role} £{amt:,.2f}".replace(".00", "") for role, amt in zip(CONSULT_ROLES, amounts)]
        rec["notes"] = f"Consultation maxima: {', '.join(parts)} ({CONSULT_ROLES[pick]} figure shown)."
    return rec


def _mode_from_text(text: str, consult: bool) -> bool:
    t = text.lower()
    if "physician" in t:
        return True
    if "anaesthe" in t or "anesthe" in t:
        return False
    return consult


def parse_fee_tables(html: str) -> list[dict]:
    """Generic parser for HTML fee schedules.

    A fee row is any <tr> whose first direct cell is a CCSD code and which has
    at least one money cell: first money cell = procedure fee, second =
    anaesthetist fee, a short text cell in between = complexity. Rows carrying
    a code but no money that follow a fee row are that code's 'unacceptable
    combinations' (AXA nests them under each fee row). A header row naming
    'Physician' switches to consultation mode until one naming 'Anaesthetist'.
    """
    soup = BeautifulSoup(html, "lxml")
    records: dict[str, dict] = {}
    current: dict | None = None
    consult = False

    for tr in soup.find_all("tr"):
        cells = tr.find_all(["td", "th"], recursive=False)
        if not cells:
            continue
        texts = [c.get_text(" ", strip=True) for c in cells]
        if not is_code(texts[0]):
            if len(" ".join(texts)) < 200:
                consult = _mode_from_text(" ".join(texts), consult)
            continue
        code = norm_code(texts[0])
        money_idx = [i for i, t in enumerate(texts[1:], start=1) if parse_money(t) is not None]

        if money_idx:
            if code in records:  # a repeat listing of a row we already hold
                current = records[code]
                continue
            between = [t for t in texts[2:money_idx[0]] if t and len(t) <= 30]
            rec = make_record(code, texts[1] if len(texts) > 1 else "",
                              [parse_money(texts[i]) for i in money_idx[:3]],
                              between[0] if between else "", _section_for(tr), consult)
            records[code] = rec
            current = rec
        elif current is not None and code != current["code"] and code not in current["unacceptable"]:
            current["unacceptable"].append(code)

    return list(records.values())


# ---------------------------------------------------------------- PDF text ---

MONEY_TOKEN_RE = re.compile(r"^-?(£)?[\d,]+(?:\.\d{1,2})?$")
SECTION_RE = re.compile(r"^(\d{1,2}\.\d{1,2})\s+(\S.*)$")
CHAPTER_RE = re.compile(r"^(?:Chapter|Section)\s+\d+\b", re.I)
BOILERPLATE = ("www.", "registered", "authorised", "regulated", "trading name", " | ", "page ", "copyright")


def _split_money(tokens: list[str]) -> tuple[list[str], list[float]]:
    """Peel up to three trailing money tokens (at least one carrying £) off a line."""
    tail = []
    while tokens and len(tail) < 3 and MONEY_TOKEN_RE.match(tokens[-1]):
        tail.insert(0, tokens.pop())
    if not any("£" in t for t in tail):
        return tokens + tail, []
    return tokens, [float(t.lstrip("-£").replace(",", "")) for t in tail]


def parse_pdf_lines(lines: list[str]) -> tuple[list[dict], str]:
    """Parse extracted PDF text lines into records, plus the chapter's free-text note.

    Handles the layouts seen in insurer PDFs: code, description and fees on one
    line; description wrapping before the fees (code line has no fees yet); and
    description wrapping after the fees (continuation lines in lower case).
    """
    records: dict[str, dict] = {}
    pending: dict | None = None   # code seen, fees not yet
    last: dict | None = None      # most recent complete record, for continuations
    pending_age = 0
    section, consult = "", False
    note_lines: list[str] = []
    in_note = False

    for raw in lines:
        line = re.sub(r"\s+", " ", raw or "").strip()
        if not line or line.isdigit():
            continue
        low = line.lower()
        if any(b in low for b in BOILERPLATE):
            continue
        tokens = line.split(" ")

        if CHAPTER_RE.match(line):
            in_note, note_lines = True, []
            continue
        m = SECTION_RE.match(line)
        if m and not is_code(tokens[0]):
            section, in_note, pending, last = line[:160], False, None, None
            consult = _mode_from_text(line, False)
            continue

        if is_code(tokens[0]):
            in_note = False
            body, amounts = _split_money(tokens[1:])
            cx = ""
            if amounts and body and body[-1].lower() in COMPLEXITY_WORDS:
                cx = body.pop()
            if amounts:
                rec = make_record(tokens[0], " ".join(body), amounts, cx, section, consult)
                if rec["code"] not in records:
                    records[rec["code"]] = rec
                last, pending = rec, None
                if not body:  # description follows on the next lines
                    pending, last = None, rec
            else:
                pending, pending_age, last = {"code": tokens[0], "desc": " ".join(body)}, 0, None
            continue

        body, amounts = _split_money(tokens)
        if pending is not None:
            if amounts:
                cx = body.pop() if body and body[-1].lower() in COMPLEXITY_WORDS else ""
                rec = make_record(pending["code"], f"{pending['desc']} {' '.join(body)}", amounts, cx, section, consult)
                if rec["code"] not in records:
                    records[rec["code"]] = rec
                pending, last = None, rec
            else:
                pending["desc"] += " " + line
                pending_age += 1
                if pending_age > 3:
                    pending = None
            continue

        if not amounts and last is not None and (line[0].islower() or line[0] in "(-+&/" or not last["description"]):
            last["description"] = clean(f"{last['description']} {line}", 400)
            continue
        consult = _mode_from_text(line, consult) if len(line) < 120 else consult
        if in_note:
            note_lines.append(line)
        last = None

    return list(records.values()), clean(" ".join(note_lines), 600)


def parse_pdf(data: bytes) -> tuple[list[dict], str]:
    import io

    import pdfplumber

    lines: list[str] = []
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        for page in pdf.pages:
            lines.extend((page.extract_text() or "").splitlines())
    return parse_pdf_lines(lines)


# ------------------------------------------------------------------- JSON ---

FEE_KEYS = ("procedurefee", "surgeonfee", "specialistfee", "surgeon", "specialist", "procedure_fee",
            "fee", "amount", "price", "maximum", "max", "benefit")


def _num(v) -> float | None:
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)):
        return None if v < 0 else float(v)  # -1 is used as "none" by some APIs
    m = parse_money(v) if isinstance(v, str) and "£" in v else None
    if m is not None:
        return m
    try:
        f = float(str(v).replace(",", ""))
        return None if f < 0 else f
    except ValueError:
        return None


def _dict_record(d: dict) -> dict | None:
    low = {k.lower(): v for k, v in d.items() if isinstance(k, str)}
    code = next((v for k, v in low.items() if "code" in k and isinstance(v, str) and is_code(v)), None)
    if not code:
        return None
    anaes_key = next((k for k in low if "anaes" in k or "anes" in k), None)
    fee = None
    for want in FEE_KEYS:
        key = next((k for k in low if want in k and k != anaes_key and "code" not in k), None)
        if key is not None and _num(low[key]) is not None:
            fee = _num(low[key])
            break
    if fee is None:
        return None
    desc = next((v for k, v in low.items() if isinstance(v, str) and ("desc" in k or "narrative" in k)), "")
    cx = next((v for k, v in low.items() if isinstance(v, str) and "complex" in k), "")
    notes = next((v for k, v in low.items() if isinstance(v, str) and "note" in k), "")
    combos = []
    for k, v in low.items():
        if "unaccept" in k or "combination" in k:
            for item in v if isinstance(v, list) else []:
                c = item if isinstance(item, str) else next(
                    (x for kk, x in item.items() if "code" in str(kk).lower() and isinstance(x, str)), "") if isinstance(item, dict) else ""
                if is_code(c):
                    combos.append(norm_code(c))
    rec = make_record(code, desc, [fee] + ([_num(low[anaes_key])] if anaes_key and _num(low[anaes_key]) is not None else []), clean(cx, 30))
    rec["notes"], rec["unacceptable"] = clean(notes, 600), combos
    return rec


def records_from_json(obj) -> list[dict]:
    """Find fee rows anywhere inside an API response, whatever its shape."""
    out: list[dict] = []

    def walk(o):
        if isinstance(o, dict):
            rec = _dict_record(o)
            if rec:
                out.append(rec)
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(obj)
    return out
