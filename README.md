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

## Migrating the remaining pages

The digest engine and index are done. Each remaining page needs the same four
changes:

1. Delete its `<style>` block and link `../assets/css/theme.css` instead.
   Map the old variable names onto the house tokens — most already correspond
   (`--ink`, `--paper`, `--card`, `--rule`, `--red`, `--amber`, `--green`).
2. Delete its bespoke header and add the `nav.js` tag with the right `data-tool`.
3. Rename local classes to the shared ones: `.paper-item` → `.result-item`,
   `.paper-title` → `.result-title`, `.loading-state`/`.error-state` → `.state`,
   `.abstract-drawer` → `.drawer`, `.action-btn` → `button`.
4. Add the `.disclaimer` block.

Suggested order: `journals.html` and `followup.html` first — they already use
the ink/paper token names, so they are mostly a find-and-replace. `salary.html`
last, because it has its own dark mode implementation that needs unpicking in
favour of the shared one.

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
