// Reads a consent-form PDF, works out where the patient / clinician details go
// and where the tick boxes are, and returns a fillable copy plus a map of every
// field the browser will need to fill.
//
// Two kinds of form arrive:
//   * RCR forms are already interactive PDFs. Their own fields are kept; we only
//     work out what each one is *for* by reading the label printed next to it.
//   * CRUK forms are flat. We find the printed labels ("Date of birth", "NHS
//     number" ...) and the printed tick boxes, and add real form fields on top of
//     them. The printed text is never touched, so the form's wording stays exactly
//     as published.
//
// Everything here is heuristic, so every form gets a list of the details it could
// NOT place (`missing`). The tool page shows that list so a clinician knows which
// boxes to complete by hand.

import path from 'node:path';
import { createRequire } from 'node:module';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  PDFDocument, PDFName, PDFDict, PDFArray, PDFRef,
  PDFTextField, PDFCheckBox, PDFRadioGroup, StandardFonts,
} from 'pdf-lib';
import { cleanText } from './util.mjs';

const { getDocument, OPS } = pdfjs;
const require = createRequire(import.meta.url);
const STD_FONTS = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep;

/* Bump this whenever the detection logic changes: every form is then
   re-analysed on the next run even if the source PDF is unchanged. */
export const ANALYSER_VERSION = 3;

/* ── Characters that are drawn as an empty tick box ─────────────────────── */
const BOX_CHARS = new Set([
  '☐', '□', '❏', '❐', '❑', '❒', '▢', '⬜', '◻',
  '', '', '', '', '', '', // Wingdings / Symbol private-use
]);
const LEADER_RE = /[._…]{3,}|_{2,}/g;

/* ── Section headings: decide whose name a "Name (PRINT)" line is asking for ─ */
function sectionOf(lineText) {
  const t = lineText.toLowerCase().trim();
  if (t.length > 220) return null;
  const headingish = /^(\d+[.)]?\s*)?(statement|confirmation|declaration|signature|section|part|to be (completed|filled in)|for (the )?(use|completion) of|health ?professional|clinician|interpreter|witness|patient'?s? (statement|signature|declaration|agreement)|parent|person (taking|obtaining))/.test(t);
  if (!headingish) return null;
  if (/interpreter/.test(t)) return 'interpreter';
  if (/witness/.test(t)) return 'witness';
  if (/parent|guardian|person with parental/.test(t)) return 'parent';
  if (/health ?professional|clinician|doctor|person (taking|obtaining) consent|consenting (clinician|professional)|oncologist|radiographer|nurse|practitioner/.test(t)) return 'professional';
  if (/confirmation of consent/.test(t)) return 'confirmation';
  if (/patient/.test(t)) return 'patient';
  return null;
}

/* ── What a printed label is asking for ──────────────────────────────────── */
// Order matters: identifiers are tested before "hospital", so "Hospital number"
// is an identifier and not the name of the hospital.
const LABEL_RULES = [
  ['dob',          /^(patient'?s?\s+)?(date of birth|d\.?\s?o\.?\s?b\.?)\b/],
  ['nhs',          /^(patient'?s?\s+)?nhs\s*(number|no\b|no\.)/],
  ['identifier',   /^(patient'?s?\s+)?(unique (patient )?identifier|hospital\s*(number|no\b|no\.|id\b)|unit\s*(number|no\b|no\.)|mrn\b|case\s*(number|no\b)|patient\s*(number|id\b|identifier)|other identifier|identifier\b|hospital\s*\/\s*nhs\s*number)/],
  ['surname',      /^(patient'?s?\s+)?(surname|family name|last name)/],
  ['forenames',    /^(patient'?s?\s+)?(first names?|forenames?|given names?|christian names?)/],
  ['patient_name', /^(patient'?s?\s+(full\s+)?name|name of (the )?patient|full name of (the )?patient)\b/],
  ['hospital',     /^(name of (the )?(hospital|trust|organisation|cancer cent(re|er)|treating (hospital|cent(re|er)))|hospital(\s*\/\s*trust)?(\s*name)?$|(nhs\s+)?trust(\s*name)?$|treating (hospital|cent(re|er)|site)|hospital\s*\/\s*site)/],
  ['consultant',   /^(responsible|named)\s+(consultant|health\s?professional|clinician|oncologist|doctor)/],
  ['title',        /^(job title|designation|role|position|profession|grade)\b/],
  ['print_name',   /^(name|print name|printed name|name\s*\((print|printed|block capitals|capitals)\)|name in (block )?capitals)$/],
];

export function classifyLabel(raw) {
  const t = cleanText(raw).toLowerCase().replace(/[:*]+$/, '').replace(/\s*\(.*?optional.*?\)$/, '').trim();
  if (!t || t.length > 110) return null;
  for (const [role, re] of LABEL_RULES) if (re.test(t)) return role;
  return null;
}

/* A label's role, resolved against the section it sits in. */
function resolveRole(role, section) {
  if (!role) return null;
  if (role === 'print_name') return section === 'professional' ? 'clin_name' : null;
  if (role === 'title') {
    if (section === 'professional') return 'clin_role';
    if (section === null) return 'consultant_role';
    return null;
  }
  if (['interpreter', 'witness', 'parent'].includes(section)) return null;
  return role;
}

/* ── pdf.js: text, lines and drawn boxes ─────────────────────────────────── */
function mul(m, n) { // 2D affine multiply, pdf.js order [a b c d e f]
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
function apply(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }

function squareFromPoints(pts, ctm) {
  const t = pts.map(([x, y]) => apply(ctm, x, y));
  const xs = t.map((p) => p[0]), ys = t.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  // every point must sit on the bounding box edge (axis-aligned rectangle)
  const onEdge = t.every(([x, y]) =>
    (Math.abs(x - x0) < 0.6 || Math.abs(x - x1) < 0.6) && (Math.abs(y - y0) < 0.6 || Math.abs(y - y1) < 0.6));
  if (!onEdge) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function isTickSized(b) {
  return b.w >= 5 && b.w <= 18 && b.h >= 5 && b.h <= 18 && Math.abs(b.w - b.h) <= 3;
}

function findDrawnBoxes(opList) {
  const out = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const { fnArray, argsArray } = opList;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i], args = argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = mul(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (Array.isArray(args?.[0])) ctm = mul(ctm, args[0]); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.constructPath) {
      const ops = args[0], nums = args[1];
      let k = 0, pts = [];
      const flush = () => { if (pts.length >= 4) { const b = squareFromPoints(pts, ctm); if (b && isTickSized(b)) out.push(b); } pts = []; };
      for (const op of ops) {
        if (op === OPS.rectangle) {
          const [x, y, w, h] = nums.slice(k, k + 4); k += 4;
          const b = squareFromPoints([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], ctm);
          if (b && isTickSized(b)) out.push(b);
        } else if (op === OPS.moveTo) { flush(); pts.push(nums.slice(k, k + 2)); k += 2; }
        else if (op === OPS.lineTo) { pts.push(nums.slice(k, k + 2)); k += 2; }
        else if (op === OPS.curveTo) { k += 6; pts = []; }
        else if (op === OPS.curveTo2 || op === OPS.curveTo3) { k += 4; pts = []; }
        else if (op === OPS.closePath) { flush(); }
      }
      flush();
    }
  }
  // de-duplicate (a box is often filled then stroked)
  const uniq = [];
  for (const b of out) {
    if (!uniq.some((u) => Math.abs(u.x - b.x) < 1.5 && Math.abs(u.y - b.y) < 1.5)) uniq.push(b);
  }
  return uniq;
}

function splitLeaders(item) {
  // "Date of birth: ......." → label part and a leader (blank) part
  const { str } = item;
  const cw = (item.x1 - item.x0) / Math.max(1, str.length);
  const parts = [];
  let last = 0;
  for (const m of str.matchAll(LEADER_RE)) {
    if (m.index > last) parts.push({ ...item, str: str.slice(last, m.index), x0: item.x0 + last * cw, x1: item.x0 + m.index * cw });
    parts.push({ ...item, str: m[0], leader: true, x0: item.x0 + m.index * cw, x1: item.x0 + (m.index + m[0].length) * cw });
    last = m.index + m[0].length;
  }
  if (last < str.length) parts.push({ ...item, str: str.slice(last), x0: item.x0 + last * cw, x1: item.x1 });
  return parts.length ? parts : [item];
}

async function readPages(bytes) {
  const task = getDocument({
    data: new Uint8Array(bytes), standardFontDataUrl: STD_FONTS,
    disableFontFace: true, isEvalSupported: false, useSystemFonts: false, verbosity: 0,
  });
  const doc = await task.promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const [vx0, vy0, vx1, vy1] = page.view;
    const tc = await page.getTextContent();
    const items = [], glyphBoxes = [];
    for (const it of tc.items) {
      if (!it.str || !it.transform) continue;
      const tr = it.transform;
      const fs = Math.hypot(tr[2], tr[3]) || it.height || 10;
      const base = { str: it.str, x0: tr[4], x1: tr[4] + (it.width || fs * 0.5 * it.str.length), y: tr[5], fs };
      const s = it.str.trim();
      if (s.length === 1 && BOX_CHARS.has(s)) {
        const w = Math.max(5, Math.min(14, (base.x1 - base.x0) || fs * 0.8));
        glyphBoxes.push({ x: base.x0, y: base.y - fs * 0.12, w, h: w, glyph: true });
        continue;
      }
      // a box glyph glued to its label ("☐ Yes") — peel it off
      if (s.length > 1 && BOX_CHARS.has(s[0])) {
        const lead = it.str.indexOf(s[0]);
        const cw = (base.x1 - base.x0) / it.str.length;
        const bx = base.x0 + lead * cw;
        glyphBoxes.push({ x: bx, y: base.y - fs * 0.12, w: Math.max(5, fs * 0.8), h: Math.max(5, fs * 0.8), glyph: true });
        items.push(...splitLeaders({ ...base, str: it.str.slice(lead + 1), x0: bx + fs * 0.9 }));
        continue;
      }
      items.push(...splitLeaders(base));
    }
    let boxes = [];
    // annotations (existing form widgets) are excluded: their boxes are already fields
    try { boxes = findDrawnBoxes(await page.getOperatorList({ annotationMode: pdfjs.AnnotationMode.DISABLE })); } catch { boxes = []; }
    for (const g of glyphBoxes) if (!boxes.some((b) => Math.abs(b.x - g.x) < 4 && Math.abs(b.y - g.y) < 4)) boxes.push(g);
    pages.push({ index: p - 1, view: [vx0, vy0, vx1, vy1], items, boxes, lines: buildLines(items) });
  }
  await doc.destroy();
  return pages;
}

function buildLines(items) {
  const sorted = items.filter((i) => i.str.trim() || i.leader).sort((a, b) => b.y - a.y || a.x0 - b.x0);
  const lines = [];
  for (const it of sorted) {
    const tol = Math.max(2, it.fs * 0.35);
    let line = lines.find((l) => Math.abs(l.y - it.y) <= tol);
    if (!line) { line = { y: it.y, items: [] }; lines.push(line); }
    line.items.push(it);
  }
  for (const l of lines) {
    l.items.sort((a, b) => a.x0 - b.x0);
    // merge items into phrases; leaders split phrases and are dropped
    const phrases = [];
    let cur = null;
    for (const it of l.items) {
      if (it.leader) { cur = null; continue; }
      const gap = cur ? it.x0 - cur.x1 : Infinity;
      if (cur && gap <= Math.max(2, it.fs * 0.9)) {
        cur.text += (gap > it.fs * 0.15 && !cur.text.endsWith(' ') && !it.str.startsWith(' ') ? ' ' : '') + it.str;
        cur.x1 = Math.max(cur.x1, it.x1);
      } else {
        cur = { text: it.str, x0: it.x0, x1: it.x1, y: it.y, fs: it.fs };
        phrases.push(cur);
      }
    }
    l.phrases = phrases.map((p) => ({ ...p, text: cleanText(p.text) })).filter((p) => p.text);
    l.text = l.phrases.map((p) => p.text).join(' ');
    l.fs = Math.max(...l.items.map((i) => i.fs));
  }
  return lines.filter((l) => l.phrases.length).sort((a, b) => b.y - a.y);
}

/* Split a phrase that holds two labels ("Signed: Date: Name (PRINT):") is not
   attempted: labels that share a run are rare on these forms and a wrong split
   is worse than a missed field. Labels ending in ':' that are followed by more
   text in the same phrase are split on the colon though, because "Date of birth:
   NHS number:" style runs do occur. */
function labelCandidates(phrase) {
  const parts = phrase.text.split(/(?<=:)\s+(?=[A-Z])/);
  if (parts.length === 1) return [phrase];
  const cw = (phrase.x1 - phrase.x0) / Math.max(1, phrase.text.length);
  const out = [];
  let pos = 0;
  for (const part of parts) {
    const start = phrase.text.indexOf(part, pos);
    out.push({ ...phrase, text: part, x0: phrase.x0 + start * cw, x1: phrase.x0 + (start + part.length) * cw });
    pos = start + part.length;
  }
  return out;
}

/* ── pdf-lib: existing fields and their widgets ──────────────────────────── */
function pageIndexOfWidget(doc, widget) {
  const pages = doc.getPages();
  const pRef = widget.P();
  if (pRef) {
    const i = pages.findIndex((pg) => pg.ref === pRef);
    if (i >= 0) return i;
  }
  for (let i = 0; i < pages.length; i++) {
    const annots = pages[i].node.Annots();
    if (!annots) continue;
    for (let k = 0; k < annots.size(); k++) {
      const ref = annots.get(k);
      if (ref instanceof PDFRef && doc.context.lookup(ref) === widget.dict) return i;
    }
  }
  return -1;
}

function listExistingFields(doc) {
  const out = [];
  let form;
  try { form = doc.getForm(); } catch { return out; }
  for (const field of form.getFields()) {
    const name = field.getName();
    let kind = null;
    if (field instanceof PDFTextField) kind = 'text';
    else if (field instanceof PDFCheckBox) kind = 'check';
    else if (field instanceof PDFRadioGroup) kind = 'radio';
    else continue;
    const widgets = field.acroField.getWidgets();
    let options = [];
    if (kind === 'radio') { try { options = field.getOptions(); } catch { options = []; } }
    widgets.forEach((w, wi) => {
      const r = w.getRectangle();
      let onValue = null;
      try { onValue = w.getOnValue()?.decodeText?.() ?? w.getOnValue()?.toString().replace(/^\//, '') ?? null; } catch { onValue = null; }
      out.push({ name, kind, widgetIndex: wi, page: pageIndexOfWidget(doc, w), rect: { x: r.x, y: r.y, w: r.width, h: r.height }, onValue, option: options[wi] ?? null });
    });
  }
  return out;
}

/* pdf-lib paints new widgets with a white background, which would hide the
   printed box or ruling underneath. Drop the background and redraw. */
function makeTransparent(field, font) {
  for (const w of field.acroField.getWidgets()) {
    const mk = w.getAppearanceCharacteristics();
    if (mk) { mk.dict.delete(PDFName.of('BG')); mk.dict.delete(PDFName.of('BC')); }
  }
  if (field instanceof PDFTextField) field.updateAppearances(font);
  else field.updateAppearances();
}

function overlaps(a, b, pad = 0) {
  return a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
}

/* ── Labels for a tick box ───────────────────────────────────────────────── */
function lineForBox(page, box) {
  const cy = box.y + box.h / 2;
  let best = null, bestD = Infinity;
  for (const l of page.lines) {
    const mid = l.y + l.fs * 0.33;
    const d = Math.abs(mid - cy);
    if (d < bestD && d <= Math.max(5, box.h * 0.8)) { best = l; bestD = d; }
  }
  return best;
}

function tickLabel(page, box, allBoxes) {
  const line = lineForBox(page, box);
  if (!line) return { option: '', prompt: '', text: '' };
  const cy = box.y + box.h / 2;
  const row = allBoxes.filter((b) => Math.abs((b.y + b.h / 2) - cy) < 5).sort((a, b) => a.x - b.x);
  const i = row.indexOf(box);

  // Text between each box and its neighbours on the same line.
  const rightOf = (k) => {
    const x1 = row[k].x + row[k].w, stop = row[k + 1] ? row[k + 1].x : Infinity;
    const ph = line.phrases.filter((p) => p.x0 >= x1 - 1 && p.x0 < stop - 1);
    if (!ph.length || ph[0].x0 - x1 > 45) return [];
    const keep = [ph[0]];
    for (let j = 1; j < ph.length && ph[j].x0 - ph[j - 1].x1 <= 30; j++) keep.push(ph[j]);
    return keep;
  };
  const leftOf = (k) => {
    const start = row[k - 1] ? row[k - 1].x + row[k - 1].w : -Infinity;
    const ph = line.phrases.filter((p) => p.x1 <= row[k].x + 1 && p.x1 > start - 1);
    if (!ph.length || row[k].x - ph[ph.length - 1].x1 > 45) return [];
    return ph;
  };
  // Is this row laid out "☐ Yes ☐ No" (label after) or "Yes ☐ No ☐" (label before)?
  let mode;
  if (row.length === 1) mode = rightOf(0).length ? 'after' : 'before';
  else {
    const after = row.filter((_, k) => rightOf(k).length).length;
    const before = row.filter((_, k) => leftOf(k).length).length;
    mode = before > after ? 'before' : 'after';
  }

  let option = '', prompt = '';
  const lead = line.phrases.filter((p) => p.x1 <= row[0].x + 1);
  if (mode === 'after') {
    option = rightOf(i).map((p) => p.text).join(' ');
    prompt = lead.map((p) => p.text).join(' ');
  } else {
    const left = leftOf(i);
    if (i === 0) {
      option = left.length ? left[left.length - 1].text : '';
      prompt = lead.slice(0, -1).map((p) => p.text).join(' ');
    } else {
      option = left.map((p) => p.text).join(' ');
      prompt = lead.slice(0, -1).map((p) => p.text).join(' ');
    }
  }
  const shortOption = option.split(/\s+/).length <= 4;
  if (!shortOption || prompt === option) prompt = '';
  if (shortOption && !prompt) {
    const idx = page.lines.indexOf(line);
    const prev = page.lines[idx - 1];
    if (prev && prev.y - line.y < line.fs * 2.6 && /[:?]$/.test(prev.text)) prompt = prev.text;
  }
  // long statements wrap: add up to two continuation lines (same indent, no boxes)
  if (!shortOption && mode === 'after') {
    const x0 = rightOf(i)[0]?.x0;
    let idx = page.lines.indexOf(line);
    for (let n = 0; n < 2; n++) {
      const nxt = page.lines[idx + 1];
      if (!nxt || line.y - nxt.y > line.fs * 2.2 * (n + 1)) break;
      if (allBoxes.some((b) => Math.abs((b.y + b.h / 2) - (nxt.y + nxt.fs * 0.33)) < 5)) break;
      if (x0 == null || Math.abs(nxt.phrases[0].x0 - x0) > 25 || /[.?]$/.test(option)) break;
      option += ' ' + nxt.text;
      idx++;
    }
  }
  return { option: cleanText(option), prompt: cleanText(prompt), text: line.text };
}

/* ── Main entry ──────────────────────────────────────────────────────────── */
export async function analyseAndConvert(srcBytes, { title = '' } = {}) {
  const notes = [];
  const pages = await readPages(srcBytes);

  // sections in reading order
  const headings = [];
  for (const pg of pages) for (const l of pg.lines) {
    const s = sectionOf(l.text);
    if (s) headings.push({ page: pg.index, y: l.y, section: s });
  }
  const sectionAt = (page, y) => {
    let cur = null;
    for (const h of headings) {
      if (h.page < page || (h.page === page && h.y >= y - 1)) cur = h.section; else break;
    }
    return cur;
  };

  const fullText = pages.map((p) => p.lines.map((l) => l.text).join('\n')).join('\n');
  const review = (fullText.match(/review date[:\s]*([A-Za-z]{0,9}\.?\s*\d{4})/i) || [])[1] || null;
  const version = cleanText((fullText.match(/(?:date of issue and version|version(?: number)?)[:\s]*([^\n]{2,40})/i) || [])[1] || '') || null;

  let doc;
  try {
    doc = await PDFDocument.load(srcBytes, { ignoreEncryption: true, updateMetadata: false });
    if (doc.isEncrypted) {
      return { bytes: srcBytes, fields: [], ticks: [], missing: [], review, version, pages: pages.length, fillable: false, notes: ['PDF is encrypted; served unchanged and cannot be pre-filled'] };
    }
  } catch (e) {
    return { bytes: srcBytes, fields: [], ticks: [], missing: [], review, version, pages: pages.length, fillable: false, notes: ['pdf-lib could not open this PDF: ' + e.message] };
  }

  const existing = listExistingFields(doc);
  const fields = [];   // {name, role, page, label}
  const ticks = [];    // {name, kind, page, option, prompt, group, value?}
  const usedLabels = new Set();

  /* 1. Existing text fields: name each one after the label printed beside it */
  for (const f of existing.filter((e) => e.kind === 'text' && e.page >= 0)) {
    const pg = pages[f.page];
    const r = f.rect;
    let label = null;
    for (const l of pg.lines) {
      if (Math.abs(l.y - (r.y + 2)) > Math.max(7, r.h * 0.7)) continue;
      for (const p of l.phrases) for (const c of labelCandidates(p)) {
        if (c.x1 <= r.x + 6 && r.x - c.x1 < 320 && (!label || c.x1 > label.x1)) label = { ...c, lineY: l.y };
      }
    }
    if (!label) {
      for (const l of pg.lines) {
        if (l.y > r.y + r.h - 2 && l.y < r.y + r.h + 16) {
          const p = l.phrases.find((q) => q.x0 < r.x + r.w && q.x1 > r.x - 4);
          if (p) { label = { ...p, lineY: l.y }; break; }
        }
      }
    }
    if (!label) continue;
    const role = resolveRole(classifyLabel(label.text), sectionAt(f.page, r.y));
    usedLabels.add(`${f.page}:${Math.round(label.lineY)}:${Math.round(label.x0)}`);
    if (role && !fields.some((x) => x.name === f.name)) fields.push({ name: f.name, role, page: f.page, label: label.text });
  }

  /* 2. Printed labels with no field next to them: add one */
  const created = { text: 0, tick: 0 };
  const widgetRects = existing.map((e) => ({ page: e.page, ...e.rect }));
  const pdfPages = doc.getPages();
  const form = doc.getForm();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  for (const pg of pages) {
    const right = pg.view[2] - 28;
    for (const l of pg.lines) {
      for (const ph of l.phrases) for (const c of labelCandidates(ph)) {
        const key = `${pg.index}:${Math.round(l.y)}:${Math.round(c.x0)}`;
        if (usedLabels.has(key)) continue;
        const role = resolveRole(classifyLabel(c.text), sectionAt(pg.index, l.y));
        if (!role) continue;
        const next = l.phrases.find((q) => q.x0 > c.x1 + 2);
        const end = Math.min(next ? next.x0 - 4 : right, c.x1 + 3 + 330);
        const h = Math.max(12, c.fs + 4);
        let rect = { x: c.x1 + 3, y: l.y - 1.5, w: end - (c.x1 + 3), h };
        if (rect.w < 55) {
          rect = { x: c.x0, y: l.y - c.fs - 7, w: Math.min(280, right - c.x0), h };
        }
        const blocked =
          rect.w < 40 ||
          widgetRects.some((w) => w.page === pg.index && overlaps(w, rect, 1)) ||
          pg.lines.some((o) => o !== l && o.phrases.some((q) => overlaps({ x: q.x0, y: o.y, w: q.x1 - q.x0, h: q.fs * 0.7 }, rect, -1)));
        if (blocked) continue;
        const name = `cot_${role}_${++created.text}`;
        try {
          const tf = form.createTextField(name);
          tf.addToPage(pdfPages[pg.index], { ...rect, width: rect.w, height: rect.h, borderWidth: 0, font: helv });
          makeTransparent(tf, helv);
          widgetRects.push({ page: pg.index, ...rect });
          fields.push({ name, role, page: pg.index, label: c.text, added: true });
          usedLabels.add(key);
        } catch (e) {
          notes.push(`Could not add field for "${c.text}": ${e.message}`);
        }
      }
    }
  }

  /* 3. Tick boxes — existing check boxes / radios first, then printed boxes */
  const tickBoxes = []; // {page, rect, name, kind, onValue}
  // A check box with several widgets carrying different "on" values behaves as a
  // set of options (Yes / No), exactly like a radio group — treat it as one.
  const onValuesByName = {};
  for (const e of existing) if (e.kind === 'check') (onValuesByName[e.name] ||= new Set()).add(e.onValue);
  for (const f of existing.filter((e) => (e.kind === 'check' || e.kind === 'radio') && e.page >= 0)) {
    const multi = f.kind === 'check' && onValuesByName[f.name].size > 1;
    tickBoxes.push({ page: f.page, ...f.rect, name: f.name, kind: multi ? 'radio' : f.kind, onValue: f.onValue, option: f.option, multiCheck: multi });
  }
  for (const pg of pages) {
    for (const b of pg.boxes) {
      if (widgetRects.some((w) => w.page === pg.index && overlaps(w, b, 1))) continue;
      if (tickBoxes.some((t) => t.page === pg.index && overlaps(t, b, 1))) continue;
      tickBoxes.push({ page: pg.index, x: b.x, y: b.y, w: b.w, h: b.h, name: null, kind: 'new' });
    }
  }
  // reading order
  tickBoxes.sort((a, b) => a.page - b.page || (b.y - a.y) || (a.x - b.x));

  const seenNames = new Set();
  for (const tb of tickBoxes) {
    const pg = pages[tb.page];
    const pageBoxes = tickBoxes.filter((t) => t.page === tb.page);
    const lab = tickLabel(pg, tb, pageBoxes);
    if (tb.kind === 'new') {
      const name = `cot_tick_${++created.tick}`;
      try {
        const cb = form.createCheckBox(name);
        cb.addToPage(pdfPages[tb.page], { x: tb.x, y: tb.y, width: tb.w, height: tb.h, borderWidth: 0 });
        makeTransparent(cb);
        tb.name = name; tb.kind = 'check';
      } catch (e) { notes.push(`Could not add tick box: ${e.message}`); continue; }
    }
    if (tb.kind === 'check' && seenNames.has(tb.name)) continue; // multi-widget check box: one entry
    seenNames.add(tb.name);
    const sameLine = pageBoxes.filter((t) => Math.abs((t.y + t.h / 2) - (tb.y + tb.h / 2)) < 5);
    const group = tb.kind === 'radio'
      ? `radio:${tb.name}`
      : (sameLine.length > 1 && lab.option.split(/\s+/).length <= 4 ? `p${tb.page}y${Math.round(tb.y)}` : null);
    ticks.push({
      name: tb.name, kind: tb.kind, page: tb.page,
      option: lab.option, prompt: lab.prompt, line: lab.text,
      ...(tb.kind === 'radio' ? { value: tb.option ?? tb.onValue, onValue: tb.onValue, ...(tb.multiCheck ? { multiCheck: true } : {}) } : {}),
      ...(group ? { group } : {}),
    });
  }

  const want = ['patient_name|surname', 'dob', 'nhs|identifier', 'hospital', 'clin_name'];
  const have = new Set(fields.map((f) => f.role));
  const missing = want.filter((w) => !w.split('|').some((r) => have.has(r) || (r === 'patient_name' && have.has('surname'))));

  let bytes;
  try {
    bytes = Buffer.from(await doc.save({ updateFieldAppearances: false }));
  } catch (e) {
    notes.push('Saving the converted form failed, served unchanged: ' + e.message);
    return { bytes: srcBytes, fields: [], ticks: [], missing: want, review, version, pages: pages.length, fillable: false, notes };
  }

  return {
    bytes, fields, ticks, missing, review, version,
    pages: pages.length, fillable: true, notes,
    added: created,
  };
}
