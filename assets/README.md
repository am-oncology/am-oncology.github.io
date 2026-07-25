# Clinical Oncology Tools

A static suite of browser-based tools for clinical oncology, weighted towards
neuro-oncology and lower GI cancer. No build step, no backend, no dependencies.
Everything runs client-side and is hosted on GitHub Pages.

## Layout

```
index.html                    the only navigation hub
tools.json                    ← ADD AND REMOVE TOOLS HERE, NOWHERE ELSE
assets/
  css/theme.css               all colour, type and spacing
  js/nav.js                   injects the header + "All tools" link
  js/pubmed.js                shared NCBI E-utilities client
  js/digest-config.js         every literature digest, as data
tools/
  digest.html                 one engine, serves ?set=cns and ?set=crc
  followup.html
  geriatric.html
  journals.html
  trials.html
  salary.html
```

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
// in tools.json, inside the right section's "tools" array
{
  "id": "eqd2",
  "name": "EQD2 calculator",
  "href": "tools/eqd2.html",
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
<link rel="stylesheet" href="../assets/css/theme.css">
<script src="../assets/js/nav.js" data-tool="eqd2" defer></script>
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
    <a href="../index.html">All tools</a>
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
