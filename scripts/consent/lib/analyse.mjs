// Reads a consent-form PDF, works out where the patient / clinician details go
// and where the tick boxes are, and returns a fillable copy plus a map of every
// field the browser will need to fill.
//
// Two kinds of form arrive:
//   * RCR forms are already interactive PDFs. Their own fields and check boxes
//     are kept; we only work out what each one is *for* from the printed label.
//   * CRUK forms are flat. We find the printed labels ("Patient's surname/family
//     name", "Date of birth" ...), the blank lines that go with them and the
//     printed tick boxes (Webdings glyphs), and add real form fields on top.
//     The printed text is never touched, so the wording stays as published.
//
// Everything here is heuristic, so every form gets a list of the details it could
// NOT place (`missing`). The tool page shows that list so a clinician knows which
// boxes to complete by hand.

import path from 'node:path';
import { createRequire } from 'node:module';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  PDFDocument, PDFName, PDFRef,
  PDFTextField, PDFCheckBox, PDFRadioGroup, StandardFonts,
} from 'pdf-lib';
import { cleanText } from './util.mjs';

const { getDocument, OPS } = pdfjs;
const require = createRequire(import.meta.url);
const STD_FONTS = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep;

/* Bump this whenever the detection logic changes: every form is then
   re-analysed on the next run even if the source PDF is unchanged. */
export const ANALYSER_VERSION = 4;

/* ── Tick-box glyphs ─────────────────────────────────────────────────────── */
const BOX_CHARS = new Set([
  '☐', '□', '❏', '❐', '❑', '❒', '▢', '⬜', '◻',
  '', '', '', '', '', // symbol fonts mapped to private use
]);
/* Symbol fonts draw boxes with ordinary letters: CRUK forms use Webdings "c".
   Only empty-box glyphs are listed. Ticked-box glyphs (Wingdings 2 "R", "☑")
   are printed instructions such as "☑ Tick all relevant boxes", not boxes. */
function isBoxGlyph(ch, fontName) {
  if (BOX_CHARS.has(ch)) return true;
  const f = String(fontName || '').toLowerCase();
  if (/webdings/.test(f)) return ch === 'c';
  if (/wingdings\s*-?\s*2/.test(f)) return ch === '£';
  if (/wingdings/.test(f)) return ch === 'o' || ch === 'q' || ch === 'r' || ch === '¨';
  return false;
}

const LEADER_RE = /[._…]{3,}|_{2,}/g;

/* ── Section headings: decide whose "Name" / "Job title" a line is asking for ─ */
const CONSULTANT_HEADING = /^responsible (consultant|clinician|doctor|health ?professional)s?\s*:?$/;
function sectionOf(lineText) {
  const t = lineText.toLowerCase().replace(/[‘’]/g, "'").trim();
  if (t.length > 160) return null;
  if (CONSULTANT_HEADING.test(t)) return 'consultant';
  const headingish = /^(\d+[.)]?\s*)?(statement|confirmation|declaration|signature|section|part|to be (completed|filled in)|for (the )?(use|completion) of|health ?professional|clinician|interpreter|witness|patient'?s? (statement|signature|declaration|agreement|details)|patient details|parent|person (taking|obtaining))/.test(t);
  if (!headingish) return null;
  if (/interpreter/.test(t)) return 'interpreter';
  if (/witness/.test(t)) return 'witness';
  if (/parent|guardian|person with parental/.test(t)) return 'parent';
  if (/confirmation of consent/.test(t)) return 'confirmation';
  if (/health ?professional|clinician|doctor|person (taking|obtaining) consent|consenting (clinician|professional)|oncologist|radiographer|nurse|practitioner/.test(t)) return 'professional';
  if (/patient/.test(t)) return 'patient';
  return null;
}

/* ── What a printed label is asking for ──────────────────────────────────── */
// Order matters: the patient-label box and identifiers are tested before
// "hospital", so "Hospital number" is an identifier, not the hospital's name.
const P = "(patient'?s?\\s+)?";
const LABEL_RULES = [
  ['patient_label', /^(patient\s*(identifier|id|details)\s*\/\s*label|(affix|place|attach)\s+(patient\s+)?(label|sticker)(\s+here)?|patient\s+(label|sticker))$/],
  ['dob',          new RegExp(`^${P}(date of birth|d\\.?\\s?o\\.?\\s?b\\.?)\\b`)],
  ['nhs',          new RegExp(`^${P}nhs\\s*(number|no\\b|no\\.)`)],
  ['identifier',   new RegExp(`^${P}(unique (patient )?identifier|hospital\\s*(number|no\\b|no\\.|id\\b)|unit\\s*(number|no\\b|no\\.)|mrn\\b|case\\s*(number|no\\b)|patient\\s*(number|id\\b|identifier)|other identifier|identifier\\b|hospital\\s*\\/\\s*nhs\\s*number)`)],
  ['surname',      new RegExp(`^${P}(surname|family name|last name)`)],
  ['forenames',    new RegExp(`^${P}(first names?|first name\\(s\\)|forenames?|given names?|christian names?)`)],
  ['patient_name', /^(patient'?s?\s+(full\s+)?name|name of (the )?patient|full name of (the )?patient)\b/],
  ['hospital',     /^(name of (the )?(hospital|trust|organisation|cancer cent(re|er)|treating (hospital|cent(re|er)))|(nhs\s+)?(hospital|trust|health board)(\s*\/\s*(nhs\s+)?(hospital|trust|board|health board|site))*(\s*name)?$|hospital name(\s*\/\s*stamp)?$|hospital stamp$|treating (hospital|cent(re|er)|site))/],
  ['consultant',   /^(responsible|named)\s+(consultant|health\s?professional|clinician|oncologist|doctor)/],
  ['title',        /^(job title|designation|role|position|profession|grade)\b/],
  ['print_name',   /^(name|print name|printed name|name\s*\((print|printed|block capitals|capitals)\)|name in (block )?capitals)$/],
];

function normLabel(raw) {
  return cleanText(raw).toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[:*]+$/, '')
    .replace(/\s*\(.*?optional.*?\)$/, '')
    .trim();
}
export function classifyLabel(raw) {
  const t = normLabel(raw);
  if (!t || t.length > 110) return null;
  for (const [role, re] of LABEL_RULES) if (re.test(t)) return role;
  return null;
}

/* A label's role, resolved against the section it sits in. */
function resolveRole(role, section) {
  if (!role) return null;
  if (role === 'print_name') {
    if (section === 'professional') return 'clin_name';
    if (section === 'consultant') return 'consultant';
    return null;
  }
  if (role === 'title') {
    if (section === 'professional') return 'clin_role';
    if (section === 'consultant') return 'consultant_role';
    return null;
  }
  if (['interpreter', 'witness', 'parent', 'confirmation'].includes(section)) return null;
  return role;
}

/* ── pdf.js: text, lines, blank lines and drawn boxes ────────────────────── */
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
  const uniq = [];
  for (const b of out) if (!uniq.some((u) => Math.abs(u.x - b.x) < 1.5 && Math.abs(u.y - b.y) < 1.5)) uniq.push(b);
  return uniq;
}

function splitLeaders(item) {
  // "Date of birth: ______" → label part and a leader (blank line) part
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

function glyphBox(x0, baseline, fs) {
  const s = Math.max(5, Math.min(14, fs * 0.8));
  return { x: x0 + fs * 0.09, y: baseline - fs * 0.05, w: s, h: s, glyph: true };
}

async function readPages(bytes) {
  const doc = await getDocument({
    data: new Uint8Array(bytes), standardFontDataUrl: STD_FONTS,
    disableFontFace: true, isEvalSupported: false, useSystemFonts: false, verbosity: 0,
  }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const [vx0, vy0, vx1, vy1] = page.view;
    // Operator list first: it loads the fonts, so their real names (Webdings…) are known.
    let ops = null;
    try { ops = await page.getOperatorList({ annotationMode: pdfjs.AnnotationMode.DISABLE }); } catch { ops = null; }
    const tc = await page.getTextContent();
    const fontNames = {};
    const fontOf = (id) => {
      if (!(id in fontNames)) { try { fontNames[id] = page.commonObjs.get(id)?.name || ''; } catch { fontNames[id] = ''; } }
      return fontNames[id];
    };
    const items = [], glyphBoxes = [];
    for (const it of tc.items) {
      if (!it.str || !it.transform) continue;
      const tr = it.transform;
      const fs = Math.hypot(tr[2], tr[3]) || it.height || 10;
      const font = fontOf(it.fontName);
      const base = { str: it.str, x0: tr[4], x1: tr[4] + (it.width || fs * 0.5 * it.str.length), y: tr[5], fs };
      const s = it.str.trim();
      if (!s) { items.push(base); continue; }
      if (isBoxGlyph(s[0], font)) {
        const lead = it.str.indexOf(s[0]);
        const cw = (base.x1 - base.x0) / Math.max(1, it.str.length);
        const bx = base.x0 + lead * cw;
        glyphBoxes.push(glyphBox(bx, base.y, fs));
        const rest = it.str.slice(lead + 1);
        if (rest.trim() && !/dings/i.test(font)) items.push(...splitLeaders({ ...base, str: rest, x0: bx + fs * 0.9 }));
        continue;
      }
      if (/dings/i.test(font)) continue; // other symbol glyphs (ticks, arrows) are not text
      items.push(...splitLeaders(base));
    }
    let boxes = [];
    try { if (ops) boxes = findDrawnBoxes(ops); } catch { boxes = []; }
    for (const g of glyphBoxes) if (!boxes.some((b) => Math.abs(b.x - g.x) < 4 && Math.abs(b.y - g.y) < 4)) boxes.push(g);
    const { lines, leaderLines } = buildLines(items);
    const fss = lines.map((l) => l.fs).sort((a, b) => a - b);
    pages.push({
      index: p - 1, view: [vx0, vy0, vx1, vy1], items, boxes, lines, leaderLines,
      bodyFs: fss.length ? fss[Math.floor(fss.length / 2)] : 10,
    });
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
    const phrases = [], leaders = [];
    let cur = null;
    for (const it of l.items) {
      if (it.leader) {
        cur = null;
        const last = leaders[leaders.length - 1];
        if (last && it.x0 - last.x1 < 6) last.x1 = Math.max(last.x1, it.x1);
        else leaders.push({ x0: it.x0, x1: it.x1 });
        continue;
      }
      if (!it.str.trim()) continue;
      const gap = cur ? it.x0 - cur.x1 : Infinity;
      if (cur && gap <= Math.max(2, it.fs * 0.9)) {
        cur.text += (gap > it.fs * 0.15 && !cur.text.endsWith(' ') && !it.str.startsWith(' ') ? ' ' : '') + it.str;
        cur.x1 = Math.max(cur.x1, it.x1);
        cur.fs = Math.max(cur.fs, it.fs);
      } else {
        cur = { text: it.str, x0: it.x0, x1: it.x1, y: it.y, fs: it.fs };
        phrases.push(cur);
      }
    }
    l.phrases = phrases.map((p) => ({ ...p, text: cleanText(p.text) })).filter((p) => p.text);
    l.leaders = leaders.filter((L) => L.x1 - L.x0 >= 12);
    l.text = l.phrases.map((p) => p.text).join(' ');
    const textItems = l.items.filter((i) => !i.leader && i.str.trim());
    l.fs = textItems.length ? Math.max(...textItems.map((i) => i.fs)) : Math.max(...l.items.map((i) => i.fs));
  }
  const byY = (a, b) => b.y - a.y;
  return {
    lines: lines.filter((l) => l.phrases.length).sort(byY),
    leaderLines: lines.filter((l) => !l.phrases.length && l.leaders.length).sort(byY),
  };
}

/* "Signed: Date:" style runs are split on the colon. */
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
    let options = [];
    if (kind === 'radio') { try { options = field.getOptions(); } catch { options = []; } }
    field.acroField.getWidgets().forEach((w, wi) => {
      const r = w.getRectangle();
      let onValue = null;
      try { onValue = w.getOnValue()?.decodeText?.() ?? w.getOnValue()?.toString().replace(/^\//, '') ?? null; } catch { onValue = null; }
      out.push({ name, kind, widgetIndex: wi, page: pageIndexOfWidget(doc, w), rect: { x: r.x, y: r.y, w: r.width, h: r.height }, onValue, option: options[wi] ?? null });
    });
  }
  return out;
}

/* pdf-lib paints new widgets with a white background and border, which would
   hide the printed box or ruling underneath. Remove both and redraw. */
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
  const cy = box.y + box.h / 2;
  const row = allBoxes.filter((b) => Math.abs((b.y + b.h / 2) - cy) < 5).sort((a, b) => a.x - b.x);
  const i = row.indexOf(box);
  const linePhrases = line ? line.phrases : [];
  const rightOf = (k) => {
    const x1 = row[k].x + row[k].w, stop = row[k + 1] ? row[k + 1].x : Infinity;
    const ph = line.phrases.filter((p) => p.x0 >= x1 - 2 && p.x0 < stop - 1);
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
  // A grid (RCR side-effect tables): a row label on the left and a row of empty
  // boxes under column headings such as Expected / Common / Rare.
  if (row.length >= 3) {
    const last = row[row.length - 1];
    const between = linePhrases.some((p) => p.x1 > row[0].x + row[0].w && p.x0 < last.x);
    const label = linePhrases.filter((p) => p.x1 <= row[0].x + 1).map((p) => p.text).join(' ');
    if (!between) {
      const near = (p) => Math.abs((p.x0 + p.x1) / 2 - (box.x + box.w / 2)) < 45;
      const heads = page.lines.filter((o) => o.y > box.y + box.h && o.y - box.y < 700 &&
        !allBoxes.some((b) => Math.abs((b.y + b.h / 2) - (o.y + o.fs * 0.33)) < 5) && o.phrases.some(near))
        .sort((a, b) => a.y - b.y);
      const header = [];
      if (heads[0]) {
        header.push(heads[0].phrases.filter(near).map((p) => p.text).join(' '));
        if (heads[1] && heads[1].y - heads[0].y < heads[0].fs * 2.4) header.unshift(heads[1].phrases.filter(near).map((p) => p.text).join(' '));
      }
      return { option: cleanText(header.join(' ')) || `column ${i + 1}`, prompt: cleanText(label) || 'Blank row for another side effect', text: line ? line.text : '', matrix: true };
    }
  }
  if (!line) return { option: '', prompt: '', text: '' };
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
    // Text left of a lone box is usually another column, not its question.
    if (row.length > 1) prompt = lead.filter((p) => row[0].x - p.x1 < 160).map((p) => p.text).join(' ');
  } else {
    const left = leftOf(i);
    option = i === 0 ? (left.length ? left[left.length - 1].text : '') : left.map((p) => p.text).join(' ');
    prompt = lead.slice(0, -1).map((p) => p.text).join(' ');
  }
  const shortOption = option.split(/\s+/).length <= 4;
  if (!shortOption || prompt === option) prompt = '';
  if (shortOption && !prompt) {
    // a question on the line above, in the same column ("Patient information leaflet provided:")
    const above = page.lines.filter((o) => o.y > line.y && o.y - line.y < line.fs * 2.6)
      .sort((a, b) => a.y - b.y)[0];
    if (above) {
      const ph = above.phrases.filter((p) => p.x0 >= row[0].x - 25 && p.x0 < row[0].x + 250);
      const t = ph.map((p) => p.text).join(' ');
      if (ph.length && /[:?]$/.test(t) && !classifyLabel(t)) prompt = t;
    }
  }
  // statements wrap: add up to three continuation lines (no box, in the same column)
  if (!shortOption && mode === 'after' && !/[.?!]$/.test(option)) {
    // Two-column pages: the next line *in this column* may not be the next line
    // on the page, so look for the nearest line below with text in this column.
    const x0 = rightOf(i)[0]?.x0;
    const colRight = (() => {
      const others = allBoxes.filter((b) => b.x > box.x + 60).map((b) => b.x);
      return others.length ? Math.min(...others) - 4 : Infinity;
    })();
    const inCol = (p) => x0 != null && p.x0 >= box.x - 20 && p.x0 < x0 + 25 && p.x0 < colRight;
    let prevY = line.y;
    for (let n = 0; n < 4; n++) {
      const nxt = page.lines.filter((o) => o.y < prevY - 1 && prevY - o.y <= line.fs * 1.9 && o.phrases.some(inCol))
        .sort((a, b) => b.y - a.y)[0];
      if (!nxt) break;
      if (allBoxes.some((b) => b.x < colRight && Math.abs(b.x - box.x) < 30 && Math.abs((b.y + b.h / 2) - (nxt.y + nxt.fs * 0.33)) < 5)) break;
      option += ' ' + nxt.phrases.filter(inCol).map((p) => p.text).join(' ');
      prevY = nxt.y;
      if (/[.?!]$/.test(option)) break;
    }
  }
  return { option: cleanText(option), prompt: cleanText(prompt), text: line.text };
}

/* What part of the form a tick box sits in, e.g. "Common side effects:" or
   "Site: (Tick as appropriate)". Used by the default tick rules. */
function tickSection(page, box, allBoxes) {
  const boxLine = lineForBox(page, box);
  const hasBox = (l) => allBoxes.some((b) => Math.abs((b.y + b.h / 2) - (l.y + l.fs * 0.33)) < 5);
  // 1. a row label in a left-hand column (RCR tables) — only where nothing to
  //    the left of this box is itself a tick box (i.e. not a two-column list)
  const boxesToLeft = allBoxes.some((b) => b.x < box.x - 40);
  if (!boxesToLeft) {
    const left = [];
    for (const l of page.lines) {
      if (l.y < box.y - 3 || l.y > box.y + 260) continue;
      const ph = l.phrases.filter((p) => p.x1 < box.x - 8 && p.x0 < box.x - 40);
      if (ph.length) left.push({ y: l.y, text: ph.map((p) => p.text).join(' '), fs: l.fs });
    }
    left.sort((a, b) => a.y - b.y);
    if (left.length && left[0].y - box.y < 200) {
      const parts = [left[0].text];
      if (left[1] && left[1].y - left[0].y < left[0].fs * 2.4) parts.unshift(left[1].text);
      return cleanText(parts.join(' '));
    }
  }
  // 2. the nearest heading above, in the same column
  const above = page.lines.filter((l) => l !== boxLine && l.y > box.y + box.h && l.y < box.y + 600)
    .sort((a, b) => a.y - b.y);
  for (const l of above) {
    const ph = l.phrases.filter((p) => p.x0 >= box.x - 30 && p.x0 <= box.x + 40);
    if (!ph.length || hasBox(l)) continue;
    const t = cleanText(l.phrases.filter((p) => p.x0 >= box.x - 30 && p.x0 < box.x + 260).map((p) => p.text).join(' '));
    if (/^(\u2611\s*)?tick all/i.test(t) || classifyLabel(t.replace(/[\s_]+$/, ''))) continue;
    const big = Math.max(...ph.map((p) => p.fs)) >= page.bodyFs * 1.08;
    if (/:\s*$/.test(t) || big || /^(tick|please tick)/i.test(t)) return withTopic(t);
  }
  return withTopic('');

  // Multi-column side-effect lists: the column's own heading may be a minor
  // one ("Other information:"), so add the page's side-effect/risk heading too.
  function withTopic(t) {
    const topic = page.lines.filter((l) => l.y > box.y + box.h && l.text.split(/\s+/).length <= 14 &&
      /side.?effects?|\brisks?\b/i.test(l.text) && !hasBox(l)).sort((a, b) => a.y - b.y)[0];
    return topic && !t.includes(topic.text) ? cleanText((t ? t + ' | ' : '') + topic.text) : t;
  }
}

/* ── Main entry ──────────────────────────────────────────────────────────── */
export async function analyseAndConvert(srcBytes) {
  const notes = [];
  const pages = await readPages(srcBytes);

  // Section headings, with their column, so "Name:" in the right-hand
  // "Health professional details" box is not confused with the interpreter's.
  const headings = [];
  for (const pg of pages) for (const l of pg.lines) {
    const s = sectionOf(l.text);
    if (s) headings.push({ page: pg.index, y: l.y, x0: l.phrases[0].x0, section: s });
  }
  const sectionAt = (page, y, x) => {
    const above = headings.filter((h) => h.page === page && h.y >= y - 1);
    const sameCol = above.filter((h) => Math.abs(h.x0 - x) < 60);
    const pick = (arr) => arr.reduce((best, h) => (!best || h.y < best.y ? h : best), null);
    const h = pick(sameCol) || pick(above);
    if (h) return h.section;
    const before = headings.filter((g) => g.page < page);
    return before.length ? before[before.length - 1].section : null;
  };

  const fullText = pages.map((p) => p.lines.map((l) => l.text).join('\n')).join('\n');
  const review = (fullText.match(/review date[:\s]*([A-Za-z]{0,9}[-\s.]*\d{2,4})/i) || [])[1] || null;
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
  const fields = [];
  const ticks = [];
  const usedLabels = new Set();

  /* 1. Existing text fields (RCR): name each after the label printed beside it */
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
    const role = resolveRole(classifyLabel(label.text), sectionAt(f.page, r.y, label.x0));
    usedLabels.add(`${f.page}:${Math.round(label.lineY)}:${Math.round(label.x0)}`);
    if (role && !fields.some((x) => x.name === f.name)) fields.push({ name: f.name, role, page: f.page, label: label.text });
  }

  /* 2. Printed labels with no field: add one on the blank line that goes with it */
  const created = { text: 0, tick: 0 };
  const widgetRects = existing.map((e) => ({ page: e.page, ...e.rect }));
  const pdfPages = doc.getPages();
  const form = doc.getForm();
  const helv = await doc.embedFont(StandardFonts.Helvetica);

  const textBlocks = (pg, except) => pg.lines.filter((o) => o !== except)
    .flatMap((o) => o.phrases.map((q) => ({ x: q.x0, y: o.y - q.fs * 0.2, w: q.x1 - q.x0, h: q.fs * 0.9 })));

  function placeField(pg, l, c, role) {
    const right = pg.view[2] - 28;
    const h = Math.max(12, Math.min(16, c.fs + 4));
    if (role === 'patient_label') {
      // The label sits at the bottom of an empty box: fill the box above it.
      const x = Math.max(pg.view[0] + 10, c.x0 - 4);
      const w = Math.min(205, right - x + 10);
      const y = l.y + c.fs + 1;
      const top = Math.min(pg.view[3] - 8, y + 66);
      const above = pg.lines.filter((o) => o.y > y && o.y < top && o.phrases.some((q) => q.x1 > x && q.x0 < x + w));
      const ceil = above.length ? Math.min(...above.map((o) => o.y)) - 2 : top;
      return ceil - y >= 26 ? { x, y, w, h: ceil - y, multiline: true } : null;
    }
    const next = l.phrases.find((q) => q.x0 > c.x1 + 2);
    const leader = l.leaders.find((L) => L.x1 > c.x1 && L.x0 >= c.x1 - 4 && L.x0 - c.x1 < 40 && (!next || L.x0 < next.x0));
    const lw = leader ? leader.x1 - Math.max(leader.x0, c.x1 + 3) : 0;
    if (leader && lw >= 110) return { x: c.x1 + 3, y: l.y - 1.5, w: leader.x1 - c.x1 - 3, h };
    // short blank after the label, longer blank line(s) underneath: write on the line below
    // (the blank line may share its row with text in another column, so look at every row)
    const blankUnder = (ll) => ll.leaders.find((M) => Math.abs(M.x0 - c.x0) < 25 && M.x1 - M.x0 >= 100 &&
      !ll.phrases.some((q) => q.x1 > M.x0 && q.x0 < M.x1));
    const below = [...pg.lines, ...pg.leaderLines].filter((ll) => ll.y < l.y && l.y - ll.y < Math.max(c.fs * 3, 26) && blankUnder(ll) &&
      !pg.lines.some((o) => o.y < l.y - 1 && o.y > ll.y + 1 && o.phrases.some((q) => q.x1 > c.x0 && q.x0 < c.x0 + 100)))
      .sort((a, b) => b.y - a.y)[0];
    if (below) {
      const L = blankUnder(below);
      return { x: L.x0, y: below.y - 1.5, w: L.x1 - L.x0, h };
    }
    if (leader && lw >= 40) return { x: c.x1 + 3, y: l.y - 1.5, w: leader.x1 - c.x1 - 3, h };
    if (leader) return null;
    // no printed blank: space to the right (up to the next text on this row,
    // even text in another column that sits a little higher or lower), else the line below
    const rowText = textBlocks(pg, null).filter((b) => b.x > c.x1 + 2 && b.y < l.y + h - 1.5 && b.y + b.h > l.y - 1.5);
    const end = Math.min(next ? next.x0 - 4 : right, c.x1 + 3 + 330, ...rowText.map((b) => b.x - 4));
    if (end - (c.x1 + 3) >= 55) return { x: c.x1 + 3, y: l.y - 1.5, w: end - (c.x1 + 3), h };
    return { x: c.x0, y: l.y - c.fs - 7, w: Math.min(280, right - c.x0), h };
  }

  for (const pg of pages) {
    for (const l of pg.lines) {
      for (const ph of l.phrases) for (const c of labelCandidates(ph)) {
        const key = `${pg.index}:${Math.round(l.y)}:${Math.round(c.x0)}`;
        if (usedLabels.has(key)) continue;
        if (sectionOf(c.text) === 'consultant') continue; // "Responsible consultant:" heading over Name/Job title
        const role = resolveRole(classifyLabel(c.text), sectionAt(pg.index, l.y, c.x0));
        if (!role) continue;
        const rect = placeField(pg, l, c, role);
        if (!rect || rect.w < 40) continue;
        const blocked =
          widgetRects.some((w) => w.page === pg.index && overlaps(w, rect, 0.5)) ||
          textBlocks(pg, rect.multiline ? null : l).some((b) => overlaps(b, rect, -1.5) &&
            !(b.y >= l.y - 2 && b.y <= l.y + c.fs && b.x <= c.x1)); // the label itself
        if (blocked) { notes.push(`No room for "${c.text}" on page ${pg.index + 1}`); continue; }
        const name = `cot_${role}_${++created.text}`;
        try {
          const tf = form.createTextField(name);
          if (rect.multiline) tf.enableMultiline();
          tf.addToPage(pdfPages[pg.index], { x: rect.x, y: rect.y, width: rect.w, height: rect.h, borderWidth: 0, font: helv });
          tf.setFontSize(rect.multiline ? 8 : 9);
          makeTransparent(tf, helv);
          widgetRects.push({ page: pg.index, x: rect.x, y: rect.y, w: rect.w, h: rect.h });
          fields.push({ name, role, page: pg.index, label: c.text, added: true, ...(rect.multiline ? { multiline: true } : {}) });
          usedLabels.add(key);
        } catch (e) {
          notes.push(`Could not add field for "${c.text}": ${e.message}`);
        }
      }
    }
  }

  /* 3. Tick boxes. A form that already has its own check boxes (RCR) keeps
        exactly those; printed boxes are only turned into fields on flat forms. */
  const tickBoxes = [];
  const onValuesByName = {};
  for (const e of existing) if (e.kind === 'check') (onValuesByName[e.name] ||= new Set()).add(e.onValue);
  const existingTicks = existing.filter((e) => (e.kind === 'check' || e.kind === 'radio') && e.page >= 0);
  for (const f of existingTicks) {
    const multi = f.kind === 'check' && onValuesByName[f.name].size > 1;
    tickBoxes.push({ page: f.page, ...f.rect, name: f.name, kind: multi ? 'radio' : f.kind, onValue: f.onValue, option: f.option, multiCheck: multi });
  }
  if (existingTicks.length < 3) {
    for (const pg of pages) {
      for (const b of pg.boxes) {
        if (widgetRects.some((w) => w.page === pg.index && overlaps(w, b, 1))) continue;
        if (tickBoxes.some((t) => t.page === pg.index && overlaps(t, b, 1))) continue;
        tickBoxes.push({ page: pg.index, x: b.x, y: b.y, w: b.w, h: b.h, name: null, kind: 'new' });
      }
    }
  }
  tickBoxes.sort((a, b) => a.page - b.page || (b.y - a.y) || (a.x - b.x));

  const seenNames = new Set();
  for (const tb of tickBoxes) {
    const pg = pages[tb.page];
    const pageBoxes = tickBoxes.filter((t) => t.page === tb.page);
    const lab = tickLabel(pg, tb, pageBoxes);
    if (tb.kind === 'new') {
      if (!lab.option && !lab.prompt) continue; // a stray square, not a labelled tick box
      const name = `cot_tick_${++created.tick}`;
      try {
        const cb = form.createCheckBox(name);
        cb.addToPage(pdfPages[tb.page], { x: tb.x, y: tb.y, width: tb.w, height: tb.h, borderWidth: 0 });
        makeTransparent(cb);
        tb.name = name; tb.kind = 'check';
      } catch (e) { notes.push(`Could not add tick box: ${e.message}`); continue; }
    }
    if (tb.kind === 'check' && seenNames.has(tb.name)) continue;
    seenNames.add(tb.name);
    const sameLine = pageBoxes.filter((t) => Math.abs((t.y + t.h / 2) - (tb.y + tb.h / 2)) < 5);
    const group = tb.kind === 'radio'
      ? `radio:${tb.name}`
      : (sameLine.length > 1 && (lab.matrix || lab.option.split(/\s+/).length <= 4) ? `p${tb.page}y${Math.round(tb.y)}` : null);
    const section = tickSection(pg, tb, pageBoxes);
    ticks.push({
      name: tb.name, kind: tb.kind, page: tb.page,
      option: lab.option, prompt: lab.prompt, line: lab.text,
      ...(lab.matrix ? { matrix: true } : {}),
      ...(section ? { section } : {}),
      ...(tb.kind === 'radio' ? { value: tb.option ?? tb.onValue, onValue: tb.onValue, ...(tb.multiCheck ? { multiCheck: true } : {}) } : {}),
      ...(group ? { group } : {}),
    });
  }

  const want = ['patient_name|surname', 'dob', 'nhs|identifier', 'hospital', 'clin_name'];
  const have = new Set(fields.map((f) => f.role));
  const missing = want.filter((w) => !w.split('|').some((r) => have.has(r)));

  let bytes;
  try {
    bytes = Buffer.from(await doc.save({ updateFieldAppearances: false }));
  } catch (e) {
    notes.push('Saving the converted form failed, served unchanged: ' + e.message);
    return { bytes: srcBytes, fields: [], ticks: [], missing: want, review, version, pages: pages.length, fillable: false, notes };
  }
  return { bytes, fields, ticks, missing, review, version, pages: pages.length, fillable: true, notes, added: created };
}
