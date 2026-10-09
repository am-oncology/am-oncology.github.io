# Consent pack builder (`consent.html`)

## Files

```
consent.html                          the tool page
assets/js/consent.js                  page logic
assets/js/consent-core.js             paste parsing, NHS number check, tick defaults, PDF filling
assets/json/consent-ticks.json        default tick rules (edit here, not in code)
assets/json/tools.json                now includes the "consent" entry
assets/vendor/pdf-lib.min.js          bundled so NHS networks that block CDNs still work
assets/vendor/jszip.min.js            (licences in assets/vendor/LICENSES.txt)
.github/workflows/consent-forms.yml   weekly update, Mondays 04:17 UTC
scripts/consent/                      the update script and its dependencies
consent-data/                         created by the first run: forms, leaflets, catalogue.json, status.json, REPORT.md
```

## First run

1. Upload everything, keeping the folder structure. The `.github` folder is hidden on a Mac
   (press Cmd+Shift+. in Finder to show it before dragging it in).
2. In the repo, go to **Actions → Update consent forms → Run workflow**. The first run downloads
   every form and Macmillan page, so it takes a while (allow up to two hours).
3. When it finishes, open `consent-data/REPORT.md`. It lists any form where a detail could not be
   placed. The page warns about the same forms, so they still work, but the details have to be
   completed by hand.
4. If the run cannot push, go to **Settings → Actions → General → Workflow permissions** and choose
   "Read and write permissions".

After that it runs every Monday and commits only what has changed. If a source cannot be read, it
keeps the previous copies, opens a GitHub issue labelled `consent-update`, and the page shows an
amber notice.

## How the filling works

- **RCR forms** are already fillable. Each existing field is named after the label printed next to it.
- **CRUK forms** are flat. The script finds the printed labels (including curly-apostrophe
  "Patient’s surname/family name"), the blank line that goes with each, and the Webdings tick-box
  glyphs, and adds real form fields over them. The empty "Patient identifier/label" box on later
  pages gets the patient's name, DOB, NHS number and MRN, like a printed label. The printed text is never altered, so the CRUK footer and logo stay valid under
  their terms. The disclaimer CRUK asks for is on the page.
- **Macmillan pages** are rendered to PDF. Each page footer carries the line "© Macmillan Cancer
  Support. Reproduced with permission", plus the source URL and retrieval date. Keep the
  permission email on file.
- Output PDFs stay fillable, so anything can be changed before printing.
- Patient details are never stored or sent anywhere. Only the clinician's own name, title and site
  are kept, in that browser's localStorage, when "Remember" is ticked.

## Tick rules

`assets/json/consent-ticks.json` decides what is pre-ticked. Rules are tested in order and the
first match wins. A rule can test the box's label (`match`), the question and option separately
(`prompt`, `option`), or the part of the form the box sits in (`section`, e.g. "Common side effects:").

| tick | meaning |
|---|---|
| `always` | ticked: side effects and risks, clinician statements ("I have discussed…"), information leaflet given |
| `female` / `male` | ticked only for that sex (pregnancy, menopause, erectile function, Male/Female boxes) |
| `known` | ticked once any sex is chosen (e.g. "should not conceive a child") |
| `review` | left blank and flagged: treatment intent, site, where treatment is given, protocol Yes/No |
| `never` | left blank: the patient's own confirmations, interpreter/witness, copy accepted, pacemaker |

Boxes that match no rule are ticked if they read as a statement or risk (5+ words) and otherwise
left for review. A row of options on one line (Outpatient / Day unit / Inpatient) is never
auto-picked from its section alone. RCR side-effect **grids** (Expected / Common / Less common /
Rare columns) are left for the clinician, one choice per row, because the frequency is a clinical
judgement. Rows for the other sex are left blank.

## Options

Run the workflow manually with **force** to re-process everything (do this after changing
`lib/analyse.mjs`). Use **skip_macmillan** to refresh only the consent forms.

## Known limits

- Detection is heuristic. A layout change by the RCR or CRUK can move a field. REPORT.md and the
  on-page warnings are there to catch this.
- Macmillan's site may block automated browsers. If so, the run keeps the last good copies and
  opens an issue.
- The first real run is the real test. The code was only tested against mock forms, because the
  build environment could not reach the source sites.
