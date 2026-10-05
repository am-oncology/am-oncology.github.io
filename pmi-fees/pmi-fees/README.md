# PMI fee schedules

A private page that compares UK insurer maximum fees by CCSD code. A GitHub
Actions job harvests each insurer's published schedule every night, keeps a
log of every fee change, and opens a GitHub issue when anything moves.

| Insurer | Published as | How it is read | Confidence before first live run |
|---|---|---|---|
| AXA Health, fee-approved and fee-limited | Web pages, one per CCSD chapter | Plain HTTP and HTML parsing | High: structure seen |
| The Exeter | One web page with the whole schedule | Plain HTTP and HTML parsing | High: structure seen |
| Freedom (Elite) | One PDF per chapter | PDF text parsing | High: layout seen and tested on a replica |
| Allianz Care | One PDF (Dec 2024 edition, 2015 as fallback) | PDF text parsing | Medium-high: layouts seen and tested |
| Vitality | Downloadable spreadsheet | Spreadsheet, columns auto-detected | Medium: column names not yet seen |
| Aviva | Search form | Headless browser | Lower: forms not yet tried live |
| WPA | Search app | Headless browser | Lower: forms not yet tried live |
| Healix | Search app with a JSON API | Headless browser, reads the API replies | Lower: forms not yet tried live |
| CS Healthcare | Search form | Headless browser | Lower: forms not yet tried live |
| Bupa | Its robots.txt disallows automated access | Hand-checked rows in `manual/bupa.csv` | Exact, as entered |
| Cigna, General & Medical, Saga, others | No public schedule found | Optional hand-checked CSV each | Exact, as entered |

Consultation codes (20300, 20310) come as surgeon, physician and psychiatrist
maxima. The table shows the physician figure, and lists all three in the notes.
To show a different one, change `CONSULT_PICK` in `harvest/common.py`.

## Setup (about 10 minutes, all on GitHub)

1. **Create a repo** (e.g. `pmi-fees`) and push this folder to it.
2. **Turn on Pages.** Settings → Pages → Source: *Deploy from a branch* →
   Branch: `main`, folder: `/docs` → Save.
   The page will be at `https://am-oncology.github.io/pmi-fees/`.
3. **Run the first harvest.** Actions tab → *Nightly fee harvest* → *Run workflow*.
   It takes 5–15 minutes. The run summary shows a table of row counts per source.
   Each nightly commit to `docs/data` triggers a Pages rebuild a minute or two later.

Public or private repo: on a free GitHub plan, Pages only works from a public
repo, so the harvested data files are visible there too. GitHub Pro lets the
repo stay private, with the page still served. Either way, the page carries a
`noindex` tag, so search engines leave it alone.

## After the first run: what to check

- **Run summary table.** Expect several thousand rows for each AXA schedule.
- **Any source marked `failed`.** Download the `debug-…` artifact from the run.
  It holds the HTML or spreadsheet the harvester saw. Send it to Claude, and
  the parser can be fixed in one pass.
- **Aviva, WPA, Healix, CS Healthcare.** These are worked through their search
  forms, so they are the likeliest to need a tweak. `debug/<site>_requests.txt`
  lists every request each page made. If results come from a JSON endpoint,
  that harvester can become plain HTTP calls, which is faster and sturdier.
- **Vitality.** Confirm the fee column it picked matches the spreadsheet: open
  one code in the page and compare it against the downloaded file.

## Safety rails

- One failed source never blanks the table: it keeps the previous data and is
  shown in amber as *stale since …*.
- If a harvest returns under 70% of the previous row count, it is treated as a
  broken parse, and the previous data is kept.
- The harvester checks robots.txt before each site, identifies itself honestly,
  and waits 1.5 s between requests.

## Bupa and other insurers by hand

Look a code up at codes.bupa.co.uk and add a line to `manual/bupa.csv`:

```
code,fee,anaesthetist_fee,complexity,notes,checked_on
X0003,375,,,,2026-10-03
```

Commit the change, either in the GitHub web editor or from your machine. The
next run picks it up.

The same works for any insurer without a public schedule. Add a file such as
`manual/cigna.csv` or `manual/generalandmedical.csv` with the same columns,
and it appears as its own column on the page. Entries older than 60 days show their date in amber, as a
cue to re-check. It is also worth asking Bupa's provider team for the
schedule as a file; if they send one, it becomes another harvester.

## Running locally

```
pip install -r requirements.txt
python -m playwright install chromium
python -m tests.test_harvest           # offline parser and merge tests
python -m harvest.run_all --only axa_fa,exeter
cd docs && python -m http.server       # then open http://localhost:8000
```

## Adding an insurer

Write `harvest/<name>.py` with a `harvest()` function that returns
`(records, meta)`. Each record is a dict with `code`, `description`, `fee`, and
optionally `anaes`, `complexity`, `section`, `notes` and `unacceptable`.
`parse_fee_tables()` in `common.py` already handles most HTML tables of codes
and £ amounts. Then add an entry to `SOURCES` in `run_all.py`.
