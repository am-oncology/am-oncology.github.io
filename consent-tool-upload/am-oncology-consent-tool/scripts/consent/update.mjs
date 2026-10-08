#!/usr/bin/env node
// Weekly consent-form update. Run from the repository root:
//
//   node scripts/consent/update.mjs
//
// Environment:
//   FORCE=1            re-process every form and re-render every leaflet
//   SKIP_MACMILLAN=1   leave the Macmillan leaflets as they are
//   CONSENT_FIXTURES=path/to/fixtures.json   offline test mode (no network)
//
// Writes everything under consent-data/: the fillable PDFs, catalogue.json
// (what the tool page reads), status.json (how this run went) and REPORT.md
// (forms whose fields could not all be placed, for a human to look at).
// It never deletes the previous set of forms when a source cannot be read.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  fetchWithRetry, sha256, slugify, sleep, readJSON, writeJSON, exists, uniqueId,
} from './lib/util.mjs';
import { listRcr, listCruk } from './lib/sources.mjs';
import { analyseAndConvert, ANALYSER_VERSION } from './lib/analyse.mjs';
import { leafletKeys, suggestLeaflets } from './lib/match.mjs';

const ROOT = process.env.GITHUB_WORKSPACE || process.cwd();
const DATA = path.join(ROOT, 'consent-data');
const FORCE = !!process.env.FORCE && process.env.FORCE !== 'false' && process.env.FORCE !== '0';
const SKIP_MAC = !!process.env.SKIP_MACMILLAN && process.env.SKIP_MACMILLAN !== 'false' && process.env.SKIP_MACMILLAN !== '0';
const FIXTURES = process.env.CONSENT_FIXTURES ? path.resolve(process.env.CONSENT_FIXTURES) : null;
const today = new Date().toISOString().slice(0, 10);

const log = (...a) => console.log('[consent]', ...a);

/* ── Offline fixtures (tests) ────────────────────────────────────────────── */
let fixtures = null;
if (FIXTURES) fixtures = JSON.parse(await fs.readFile(FIXTURES, 'utf8'));
const fixturePath = (f) => path.resolve(path.dirname(FIXTURES), f);

const listers = {
  rcr: fixtures ? async () => fixtures.rcr.map((x) => ({ ...x, url: x.url || 'fixture:' + x.file })) : listRcr,
  cruk: fixtures ? async () => fixtures.cruk.map((x) => ({ ...x, url: x.url || 'fixture:' + x.file })) : listCruk,
};
async function download(item) {
  if (fixtures) return fs.readFile(fixturePath(item.file));
  return fetchWithRetry(item.url, { as: 'buffer' });
}
const isPdf = (b) => b && b.length > 4 && b.slice(0, 5).toString('latin1').startsWith('%PDF');

/* ── Consent forms (RCR, CRUK) ───────────────────────────────────────────── */
async function updateForms(source, prevForms) {
  const st = { ok: false, listed: 0, added: 0, updated: 0, unchanged: 0, removed: 0, failed: [] };
  let list;
  try { list = await listers[source](); }
  catch (e) { st.error = e.message; log(source, 'listing failed:', e.message); return { forms: prevForms, st }; }
  st.listed = list.length;
  if (prevForms.length && list.length < prevForms.length * 0.6) {
    st.error = `Only ${list.length} forms listed (previously ${prevForms.length}); kept the previous set rather than delete forms`;
    return { forms: prevForms, st };
  }

  const taken = new Set();
  const out = [];
  for (const item of list) {
    const prev = prevForms.find((f) => f.url === item.url) ||
                 prevForms.find((f) => f.title === item.title && f.group === item.group);
    const id = prev && !taken.has(prev.id)
      ? (taken.add(prev.id), prev.id)
      : uniqueId(`${source}-${slugify(item.group, 28)}-${slugify(item.title, 60)}`, taken);
    const file = `forms/${source}/${id}.pdf`;

    let bytes;
    try { bytes = await download(item); }
    catch (e) {
      st.failed.push({ title: item.title, error: e.message });
      if (prev) out.push(prev);
      continue;
    }
    if (!isPdf(bytes)) {
      st.failed.push({ title: item.title, error: 'download was not a PDF (blocked or moved?)' });
      if (prev) out.push(prev);
      continue;
    }
    const srcSha = sha256(bytes);
    if (prev && prev.srcSha === srcSha && prev.analyser === ANALYSER_VERSION && !FORCE &&
        await exists(path.join(DATA, prev.file))) {
      out.push({ ...prev, title: item.title, group: item.group, url: item.url });
      st.unchanged++;
      continue;
    }

    let res;
    try { res = await analyseAndConvert(bytes, { title: item.title }); }
    catch (e) {
      st.failed.push({ title: item.title, error: 'analysis failed: ' + e.message });
      if (prev) out.push(prev);
      continue;
    }
    await fs.mkdir(path.join(DATA, 'forms', source), { recursive: true });
    await fs.writeFile(path.join(DATA, file), res.bytes);
    if (prev && prev.file !== file) await fs.rm(path.join(DATA, prev.file), { force: true });

    out.push({
      id, source, group: item.group, title: item.title, url: item.url, file,
      srcSha, analyser: ANALYSER_VERSION,
      updated: prev && prev.srcSha === srcSha ? (prev.updated || today) : today,
      review: res.review, version: res.version, pages: res.pages,
      fillable: res.fillable, fields: res.fields, ticks: res.ticks,
      missing: res.missing, notes: res.notes,
    });
    if (prev) st.updated++; else st.added++;
    log(source, prev ? 'updated' : 'added', item.title,
        `fields=${res.fields.length} ticks=${res.ticks.length}${res.missing.length ? ' missing=' + res.missing.join(',') : ''}`);
    if (!fixtures) await sleep(400);
  }

  for (const p of prevForms) {
    if (!out.some((o) => o.id === p.id)) {
      st.removed++;
      await fs.rm(path.join(DATA, p.file), { force: true });
      log(source, 'removed (no longer published)', p.title);
    }
  }
  st.ok = st.failed.length === 0;
  return { forms: out, st };
}

/* ── Macmillan leaflets ──────────────────────────────────────────────────── */
async function updateLeaflets(prev) {
  const st = { ok: false, listed: 0, added: 0, updated: 0, unchanged: 0, removed: 0, failed: [] };
  if (SKIP_MAC) { st.ok = true; st.skipped = true; return { leaflets: prev, st }; }

  if (fixtures) {
    const out = [];
    for (const x of fixtures.macmillan || []) {
      const id = 'mac-' + slugify(x.url.split('/').filter(Boolean).pop());
      const file = `leaflets/macmillan/${id}.pdf`;
      await fs.mkdir(path.join(DATA, 'leaflets', 'macmillan'), { recursive: true });
      await fs.copyFile(fixturePath(x.pdf), path.join(DATA, file));
      out.push({ id, source: 'macmillan', title: x.title, url: x.url, file, textHash: sha256(x.title), retrieved: today, keys: leafletKeys(x.title) });
      st.added++;
    }
    st.listed = out.length; st.ok = true;
    return { leaflets: out, st };
  }

  const { openBrowser, listMacmillan, renderMacmillan } = await import('./lib/macmillan.mjs');
  let browser, ctx;
  try { ({ browser, ctx } = await openBrowser()); }
  catch (e) { st.error = 'Could not start the browser: ' + e.message; return { leaflets: prev, st }; }

  try {
    let list;
    try { list = await listMacmillan(ctx); }
    catch (e) { st.error = e.message; return { leaflets: prev, st }; }
    st.listed = list.length;
    if (prev.length && list.length < prev.length * 0.6) {
      st.error = `Only ${list.length} Macmillan pages found (previously ${prev.length}); kept the previous set`;
      return { leaflets: prev, st };
    }

    const out = [];
    const taken = new Set();
    for (const item of list) {
      const id = uniqueId('mac-' + slugify(item.url.split('/').filter(Boolean).pop()), taken);
      const file = `leaflets/macmillan/${id}.pdf`;
      const old = prev.find((p) => p.id === id);
      const haveFile = old && await exists(path.join(DATA, old.file));
      try {
        const r = await renderMacmillan(ctx, item.url, { skipIfHash: !FORCE && haveFile ? old.textHash : null });
        if (!r.pdf) {
          out.push({ ...old, title: r.title || old.title, review: r.review ?? old.review, nextReview: r.nextReview ?? old.nextReview });
          st.unchanged++;
        } else {
          await fs.mkdir(path.join(DATA, 'leaflets', 'macmillan'), { recursive: true });
          await fs.writeFile(path.join(DATA, file), r.pdf);
          const title = r.title || item.title || id;
          out.push({ id, source: 'macmillan', title, url: item.url, file, textHash: r.textHash, retrieved: today, review: r.review, nextReview: r.nextReview, keys: leafletKeys(title) });
          if (old) st.updated++; else st.added++;
          log('macmillan', old ? 'updated' : 'added', title);
        }
      } catch (e) {
        st.failed.push({ title: item.title || item.url, error: e.message });
        if (old) out.push(old);
      }
      await sleep(1200);
    }
    for (const p of prev) {
      if (!out.some((o) => o.id === p.id)) {
        st.removed++;
        await fs.rm(path.join(DATA, p.file), { force: true });
      }
    }
    // A handful of individual page failures is normal; most failing means blocked.
    st.ok = st.failed.length <= Math.max(3, list.length * 0.05);
    return { leaflets: out, st };
  } finally {
    await browser.close().catch(() => {});
  }
}

/* ── Report for a human ──────────────────────────────────────────────────── */
const ROLE_NAMES = {
  'patient_name|surname': 'patient name', dob: 'date of birth', 'nhs|identifier': 'NHS number / identifier',
  hospital: 'hospital', clin_name: 'clinician name',
};
function report(cat, status) {
  const lines = [
    '# Consent form update report', '',
    `Run: ${status.run}  `,
    `Overall: ${status.ok ? 'OK' : '**needs attention**'}`, '',
    '| Source | Listed | Added | Updated | Unchanged | Removed | Failed | Problem |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const [k, s] of Object.entries(status.sources)) {
    lines.push(`| ${k} | ${s.listed ?? ''} | ${s.added ?? ''} | ${s.updated ?? ''} | ${s.unchanged ?? ''} | ${s.removed ?? ''} | ${s.failed?.length ?? ''} | ${s.skipped ? 'skipped' : (s.error || '')} |`);
  }
  const failed = Object.entries(status.sources).flatMap(([k, s]) => (s.failed || []).map((f) => `- ${k}: ${f.title} — ${f.error}`));
  if (failed.length) lines.push('', '## Failed downloads', '', ...failed);

  const gaps = cat.forms.filter((f) => !f.fillable || f.missing?.length);
  lines.push('', `## Forms with details that could not be placed (${gaps.length} of ${cat.forms.length})`, '',
    'These still work; the tool tells the clinician which boxes to complete by hand.', '');
  for (const f of gaps) {
    lines.push(`- **${f.title}** (${f.source}, ${f.group}) — ${!f.fillable ? 'not fillable' : 'missing: ' + f.missing.map((m) => ROLE_NAMES[m] || m).join(', ')}`);
  }
  const noTicks = cat.forms.filter((f) => f.fillable && !f.ticks?.length);
  if (noTicks.length) {
    lines.push('', `## Forms with no tick boxes found (${noTicks.length})`, '');
    for (const f of noTicks) lines.push(`- ${f.title} (${f.source})`);
  }
  return lines.join('\n') + '\n';
}

/* ── Run ─────────────────────────────────────────────────────────────────── */
const prev = await readJSON(path.join(DATA, 'catalogue.json'), { forms: [], leaflets: [] });
const status = { run: new Date().toISOString(), sources: {} };

const rcr = await updateForms('rcr', prev.forms.filter((f) => f.source === 'rcr'));
status.sources.rcr = rcr.st;
const cruk = await updateForms('cruk', prev.forms.filter((f) => f.source === 'cruk'));
status.sources.cruk = cruk.st;
const mac = await updateLeaflets(prev.leaflets || []);
status.sources.macmillan = mac.st;

const forms = [...rcr.forms, ...cruk.forms];
for (const f of forms) f.suggest = suggestLeaflets(f.title, mac.leaflets);

const catalogue = {
  generated: status.run,
  analyserVersion: ANALYSER_VERSION,
  counts: { rcr: rcr.forms.length, cruk: cruk.forms.length, macmillan: mac.leaflets.length },
  forms,
  leaflets: mac.leaflets,
};
status.ok = Object.values(status.sources).every((s) => s.ok);
status.counts = catalogue.counts;

await writeJSON(path.join(DATA, 'catalogue.json'), catalogue);
await writeJSON(path.join(DATA, 'status.json'), status);
await fs.writeFile(path.join(DATA, 'REPORT.md'), report(catalogue, status));
log('done', JSON.stringify(catalogue.counts), status.ok ? 'OK' : 'NEEDS ATTENTION');
