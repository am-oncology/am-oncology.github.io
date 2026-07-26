# Clinical Oncology Tools

A static suite of browser-based tools for clinical oncology, weighted towards
neuro-oncology and lower GI cancer. No build step, no backend, no dependencies.
Everything runs client-side and is hosted on GitHub Pages.

## Layout

All pages sit at the repo root. Shared assets live under `assets/`.

```
index.html                    the only navigation hub
constraints.html              tool pages, all at the root
digest.html                   serves ?set=cns and ?set=crc
followup.html
geriatric.html
journals.html
salary.html
steroids.html
trials.html
assets/
  css/theme.css               all colour, type and spacing
  js/nav.js                   injects the header + "All tools" link
  js/pubmed.js                shared NCBI E-utilities client
  js/digest-config.js         every literature digest, as data
  json/tools.json             ← ADD AND REMOVE TOOLS HERE, NOWHERE ELSE
  json/constraints.json
  json/fractionation.json
  json/steroids.json
```

Paths are relative to the root, so a page links `assets/css/theme.css`, not
`../assets/...`. `nav.js` works out the site root from its own script URL, so
it keeps working on a GitHub Pages project subpath
(`username.github.io/repo-name/`) and would survive the pages being moved into
a subfolder later.

## Design language

Restyled to match a reference app (RheumTools) the person shared. Dark is now
the **default** theme — `:root` in `theme.css` holds the dark tokens directly,
and `[data-theme="light"]` is the override, not the other way round. Anyone
who explicitly chose light before this change keeps that choice; everyone
else now sees dark first.

What changed, concretely:

- **Rounder throughout.** `--radius-lg` went from 10px to 18px, and a new
  `--radius-pill` (999px) is used for every button, badge and toggle.
- **A second typeface.** `--font-display` (Lora) is for editorial headings —
  currently the digest and journal browser mastheads — as a deliberate
  contrast to the humanist sans used everywhere else. Use the `.display-font`
  class, don't hand-pick a font-family.
- **New components in `theme.css`**: `.seg-toggle` (a pill-shaped multi-select,
  see the reference's Standard/High Risk switch), `.step-head`/`.step-num`
  (numbered wizard steps, ① ② ③ style), `.is-pending` (dashed border, no fill —
  for "not yet decided" states, the reference's TBC cards).
- **The theme toggle is now a sun/moon pill**, not a text button. Markup lives
  in `nav.js` for tool pages and duplicated inline in `index.html` (which
  doesn't load `nav.js`, since it isn't a tool page).
- **Every `<details>` on the site animates open/close.** This is handled once,
  generically, in `nav.js` — any new `<details>` anywhere gets it for free,
  no per-page code needed.
- **Per-item recolouring.** The reference's DMARD Helper recolours its whole
  screen to match the selected medication. `steroids.html` now does the same
  thing with the selected drug — see `renderEquiv()`, which sets `--accent`
  from `steroids.json`'s new `color` field on each drug. `--accent-soft` is
  then derived from it automatically via `color-mix()`, so nothing downstream
  needed to change. This is the pattern to reach for if a future tool has a
  natural "pick one of these, then work within it" shape.

Not yet retrofitted with the dashed `.is-pending` treatment: the "unverified"
rows in `constraints.html` and `fractionation.json` still rely on the amber
tint alone. Worth adding the dashed border there too for consistency, since
conceptually it's the same "don't rely on this yet" signal.

One caveat on the colours themselves: they're read off compressed phone
screenshots, not the site's own CSS, so treat the exact hex values as good
approximations rather than a pixel-perfect match. If precision matters,
pull the real values from the reference site's DevTools and swap them in —
they're all in one place at the top of `theme.css`.

## The two rules

**1. Adding or removing a tool means editing `tools.json` and nothing else.**
The index builds its card grid from the manifest at load time, and each tool
page pulls its own display name and accent colour from the same file. There is
no list of tools hard-coded in any HTML.

**2. No page defines its own colours, fonts or spacing.**
`theme.css` is the single source of truth. A tool distinguishes itself with one
value — `--accent` — which `nav.js` sets from the manifest. If you need a value
that isn't in the token list, add it to `theme.css` rather than writing a
one-off in a page.

## Adding a tool

```jsonc
// in assets/json/tools.json, inside the right section's "tools" array
{
  "id": "eqd2",
  "name": "EQD2 calculator",
  "href": "eqd2.html",
  "desc": "Linear-quadratic dose conversion, with cumulative tracking for retreatment.",
  "accent": "#B45309",
  "tags": ["General", "Radiotherapy"]
}
```

Then start the page from this skeleton:

```html
<!DOCTYPE html>
<html lang="en-GB">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>EQD2 calculator | Clinical Oncology Tools</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="assets/css/theme.css">
<script src="assets/js/nav.js" data-tool="eqd2" defer></script>
</head>
<body>
  <div class="masthead">
    <div class="masthead-inner">
      <div>
        <div class="eyebrow">Radiotherapy</div>
        <h1>EQD2 calculator</h1>
        <p>One sentence on what this does and what it does not do.</p>
      </div>
    </div>
  </div>

  <main class="main main-narrow">
    <div class="card">…</div>
  </main>

  <div class="disclaimer">
    <strong>Check every number against its source.</strong> …
    <a href="index.html">All tools</a>
  </div>
</body>
</html>
```

The `data-tool` attribute is what links the page back to its manifest entry.

## Adding a literature digest

Add a key to `DIGEST_SETS` in `assets/js/digest-config.js`, then add a manifest
entry pointing at `tools/digest.html?set=yourkey`. No new HTML file.

## Migration status

All pages are on the shared theme. Each one links `theme.css`, loads `nav.js`
with a `data-tool` matching its manifest entry, and carries a `.disclaimer`
with a link back to the index. No page defines its own colours, fonts or
spacing; page-level `<style>` blocks contain layout only, written against the
house tokens.

What changed during migration, beyond styling:

- **followup.html** — the "Patient name / ref" field invited name, DOB and
  hospital number, and persisted them to `localStorage`. It is now a
  non-identifying "Schedule label", is no longer written to storage, and the
  stored schema version was bumped to 2 so existing entries containing a label
  are discarded on next load. The label is still used in-memory for the ICS and
  clipboard exports.
- **salary.html** — its private dark-mode implementation (`toggleTheme`,
  `restoreTheme`, its own `localStorage` key) was removed in favour of the
  shared one in `nav.js`, which uses the key `cot-theme`.
- **journals.html** — already escaped fetched fields correctly; left as-is.
- **theme.css** — gained `--on-accent`, `--brand-solid` and `--on-brand`.
  `--accent` is dark in light mode and light in dark mode, so anything filled
  with it needs a foreground that flips too. Use `--on-accent` on accent fills
  and `--brand-solid` / `--on-brand` for panels that should stay dark in both
  themes.

Still worth doing: `journals.html` and `digest.html` both talk to PubMed but
only the digest uses `assets/js/pubmed.js`. Folding the journal browser onto
the shared client would remove another duplicated fetch/parse/cite path and put
it behind the same rate-limit throttle.

## Notes

- **NCBI rate limits.** Unauthenticated requests are capped at 3/sec.
  `pubmed.js` serialises everything through one throttle so rapid tab-switching
  cannot trip a 429. To lift the cap, set `window.NCBI_API_KEY` before
  `pubmed.js` loads — but remember a static site makes the key public, so use
  one you are willing to expose and can rotate.
- **Escaping.** PubMed titles contain real markup (`<i>BRAF</i>`, `<sub>2</sub>`).
  Every record field goes through `PubMed.esc()` before it touches `innerHTML`.
  Keep it that way.
- **Local development.** `index.html` and `nav.js` use `fetch` for the manifest,
  which browsers block on `file://`. Run `python3 -m http.server` and open
  `http://localhost:8000`.
- **No patient data.** No tool in this suite should accept or store
  patient-identifiable information. See the note in the review about the
  follow-up scheduler.
