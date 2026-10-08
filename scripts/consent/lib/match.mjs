// Suggest Macmillan pages for a consent form by matching drug and regimen
// names in the form title against Macmillan page titles. Suggestions only —
// the clinician still chooses what goes in the pack.

function norm(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[®™]/g, '')
    .toLowerCase();
}
const words = (s) => ' ' + norm(s).replace(/[^a-z0-9]+/g, ' ').trim() + ' ';

/* "Fluorouracil (5FU)" → ["fluorouracil", "5fu"]; "CAPOX (XELOX)" → ["capox", "xelox"] */
export function leafletKeys(title) {
  const t = norm(title);
  const keys = new Set();
  const main = t.replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (main) keys.add(main);
  for (const m of t.matchAll(/\((.*?)\)/g)) {
    for (const alt of m[1].split(/,|\/|\bor\b|\balso called\b/)) {
      const a = alt.trim();
      if (a) keys.add(a);
    }
  }
  return [...keys]
    .map((k) => words(k).trim())
    .filter((k) => k.replace(/ /g, '').length >= 3);
}

/* Regimen pages (CAPOX, FOLFOX, PCV …) go ahead of single-drug pages. */
export function isRegimenTitle(title) {
  const raw = String(title || '');
  return /\b[A-Z][A-Z0-9-]{2,}\b/.test(raw.replace(/\(.*?\)/g, '')) || /\b(and|with)\b/i.test(raw) || / - /.test(raw);
}

export function suggestLeaflets(formTitle, leaflets, max = 5) {
  const t = words(formTitle);
  const hits = [];
  for (const lf of leaflets) {
    const keys = lf.keys || leafletKeys(lf.title);
    let best = null;
    for (const k of keys) {
      const pos = t.indexOf(' ' + k + ' ');
      if (pos >= 0 && (!best || k.length > best.k.length)) best = { k, pos };
    }
    if (best) hits.push({ id: lf.id, pos: best.pos, regimen: isRegimenTitle(lf.title), len: best.k.length });
  }
  // a longer key that contains a shorter matched key wins (e.g. "stereotactic radiotherapy" over "radiotherapy")
  const kept = hits.filter((h) => !hits.some((o) => o !== h && o.pos <= h.pos && o.pos + o.len >= h.pos + h.len && o.len > h.len && !h.regimen));
  kept.sort((a, b) => (b.regimen - a.regimen) || (a.pos - b.pos));
  return kept.slice(0, max).map((h) => h.id);
}
