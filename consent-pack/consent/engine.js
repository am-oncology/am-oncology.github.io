/*
 * Consent pack engine
 * - parsePatient(text): pulls name, DOB, NHS number, hospital number from pasted EPR text
 * - analyse(bytes, opts): finds where patient/clinician details belong in a PDF
 *     * interactive PDFs (e.g. RCR): uses the existing form fields
 *     * flat PDFs (e.g. CRUK): finds printed labels and adds new fillable fields beside them
 * - fill(bytes, analysis, values, opts): writes the values, returns new PDF bytes
 * - merge(list of bytes): one print-ready PDF
 *
 * Runs entirely in the browser. Makes no network requests.
 * Needs globals: PDFLib (pdf-lib) and pdfjsLib (pdf.js 3.x).
 */
(function (root) {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Dates                                                               */
  /* ------------------------------------------------------------------ */
  const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
    'august', 'september', 'october', 'november', 'december'];

  function monthFromWord(w) {
    w = String(w || '').toLowerCase().replace(/\./g, '');
    if (w === 'sept') return 9;
    if (w.length < 3) return 0;
    const i = MONTH_NAMES.findIndex(m => m.startsWith(w));
    return i >= 0 ? i + 1 : 0;
  }

  function parseDate(s, today) {
    today = today || new Date();
    if (!s) return null;
    s = String(s).trim().replace(/(\d)(st|nd|rd|th)\b/gi, '$1');
    let d, m, y, mt;
    if ((mt = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/))) { y = +mt[1]; m = +mt[2]; d = +mt[3]; }
    else if ((mt = s.match(/^(\d{1,2})[\/\-. ](\d{1,2})[\/\-. ](\d{2}|\d{4})$/))) { d = +mt[1]; m = +mt[2]; y = +mt[3]; }
    else if ((mt = s.match(/^(\d{1,2})[\/\-. ]?([A-Za-z]{3,9})\.?[\/\-. ,]*(\d{2}|\d{4})$/))) { d = +mt[1]; m = monthFromWord(mt[2]); y = +mt[3]; }
    else if ((mt = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/))) { m = monthFromWord(mt[1]); d = +mt[2]; y = +mt[3]; }
    else if ((mt = s.match(/^(\d{2})(\d{2})(\d{4})$/))) { d = +mt[1]; m = +mt[2]; y = +mt[3]; }
    else return null;
    if (y < 100) { const cy = today.getFullYear() % 100; y += (y <= cy ? 2000 : 1900); }
    if (!m || m > 12 || d < 1 || d > 31) return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCMonth() !== m - 1) return null;
    return { d, m, y };
  }

  const pad2 = n => String(n).padStart(2, '0');
  function formatDate(o) { return o ? `${pad2(o.d)}/${pad2(o.m)}/${o.y}` : ''; }
  function ageOn(dob, today) {
    today = today || new Date();
    let a = today.getFullYear() - dob.y;
    if (today.getMonth() + 1 < dob.m || (today.getMonth() + 1 === dob.m && today.getDate() < dob.d)) a--;
    return a;
  }

  /* ------------------------------------------------------------------ */
  /* NHS number                                                          */
  /* ------------------------------------------------------------------ */
  function nhsValid(digits) {
    if (!/^\d{10}$/.test(digits)) return false;
    let s = 0;
    for (let i = 0; i < 9; i++) s += +digits[i] * (10 - i);
    let c = 11 - (s % 11);
    if (c === 11) c = 0;
    if (c === 10) return false;
    return c === +digits[9];
  }
  function formatNhs(d) { return /^\d{10}$/.test(d) ? `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}` : d; }

  /* ------------------------------------------------------------------ */
  /* Names                                                               */
  /* ------------------------------------------------------------------ */
  const TITLE_RE = /^(mr|mrs|ms|miss|mx|dr|prof|professor|sir|dame|rev|master)\.?$/i;

  function splitName(raw) {
    let s = String(raw || '')
      .replace(/\((?:mr|mrs|ms|miss|mx|dr|prof)\.?\)/ig, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[,;:\s]+|[,;:\s]+$/g, '')
      .trim();
    if (!s) return { surname: '', forenames: '' };
    const clean = part => part.trim().split(/\s+/).filter(t => t && !TITLE_RE.test(t)).join(' ');
    if (s.includes(',')) {
      const i = s.indexOf(',');
      return { surname: clean(s.slice(0, i)), forenames: clean(s.slice(i + 1).replace(/,/g, ' ')) };
    }
    const toks = s.split(/\s+/).filter(t => !TITLE_RE.test(t));
    if (toks.length === 1) return { surname: toks[0], forenames: '' };
    const isCaps = t => /[A-Z]/.test(t) && t === t.toUpperCase() && t.replace(/[^A-Za-z]/g, '').length > 1;
    const caps = toks.filter(isCaps);
    if (caps.length && caps.length < toks.length) {
      return { surname: caps.join(' '), forenames: toks.filter(t => !isCaps(t)).join(' ') };
    }
    return { surname: toks[toks.length - 1], forenames: toks.slice(0, -1).join(' ') };
  }

  function titleCase(s) {
    return String(s || '').toLowerCase()
      .replace(/(^|[\s\-'’])([a-z])/g, (m, p, c) => p + c.toUpperCase())
      .replace(/\bMc([a-z])/g, (m, c) => 'Mc' + c.toUpperCase());
  }

  /* ------------------------------------------------------------------ */
  /* Patient text parser                                                 */
  /* ------------------------------------------------------------------ */
  const DATE_SRC = String.raw`\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{1,2}(?:st|nd|rd|th)?[\/\-. ]?[A-Za-z]{3,9}\.?[\/\-. ,]*\d{2,4}`;
  const STOP_WORDS = String.raw`MRN|NHS|DOB|D\.O\.B|FIN|Age|Sex|Gender|Hosp(?:ital)?|Address|Born|Date\s+of\s+birth|Unit|PAS|CRN|Ward|Consultant|GP|Tel|Phone|Postcode`;

  function parsePatient(text, today) {
    today = today || new Date();
    const src = String(text || '').replace(/\r/g, '').replace(/\u00a0/g, ' ');
    const out = { surname: '', forenames: '', dob: null, nhs: '', mrn: '', sex: '', age: null, warnings: [], found: {} };
    if (!src.trim()) return out;

    // NHS number (labelled first, then any valid 10-digit number)
    let mt = src.match(/\bNHS\s*(?:No\.?|Num(?:ber)?|#|ID)?\s*[:\-]?\s*((?:\d[ \-]?){9}\d)\b/i);
    if (mt) { out.nhs = mt[1].replace(/\D/g, ''); out.found.nhs = 'labelled'; }
    else {
      const re = /(?:^|[^\d])((?:\d{3}[ \-]\d{3}[ \-]\d{4})|\d{10})(?!\d)/g;
      let m2;
      while ((m2 = re.exec(src))) {
        const before = src.slice(Math.max(0, m2.index - 12), m2.index + 1);
        if (/(MRN|FIN|CRN|PAS|Unit|Hosp|Tel|Phone|Mob)/i.test(before)) continue;
        const d = m2[1].replace(/\D/g, '');
        if (nhsValid(d)) { out.nhs = d; out.found.nhs = 'unlabelled'; break; }
      }
    }

    // Hospital number
    mt = src.match(/\b(?:MRN|Hospital\s*(?:No\.?|Num(?:ber)?|ID|#)|Hosp\.?\s*No\.?|Unit\s*(?:No\.?|Number)|PAS\s*(?:No\.?|Number|ID)?|Case\s*Note\s*(?:No\.?|Number)?|Local\s*(?:ID|No\.?|Number)|RNO?\s*No\.?)\s*[:#\-]?\s*([A-Z]{0,4}\d[\dA-Z]{3,14})\b/i);
    if (mt) { out.mrn = mt[1].toUpperCase(); out.found.mrn = true; }

    // DOB
    mt = src.match(new RegExp(String.raw`(?:\bD\.?\s?O\.?\s?B\.?|\bDate\s+of\s+Birth|\bBirth\s*Date|\bBorn)\s*[:\-]?\s*(${DATE_SRC})`, 'i'));
    if (mt) { out.dob = parseDate(mt[1], today); out.found.dob = 'labelled'; }
    if (!out.dob) {
      const all = src.match(new RegExp(DATE_SRC, 'g')) || [];
      const parsed = all.map(s => parseDate(s, today)).filter(Boolean);
      if (parsed.length === 1) { out.dob = parsed[0]; out.found.dob = 'assumed'; }
    }

    // Sex and age
    mt = src.match(/\b(?:Sex|Gender)\s*[:\-]?\s*(Male|Female|M|F|Other|Unknown|Indeterminate)\b/i);
    if (mt) {
      const v = mt[1].toLowerCase();
      out.sex = v === 'm' ? 'Male' : v === 'f' ? 'Female' : titleCase(v);
    }
    mt = src.match(/\bAge\s*[:\-]?\s*(\d{1,3})\s*(?:y|yr|yrs|years?)?\b/i);
    if (mt) out.age = +mt[1];

    // Name
    let rawName = '';
    mt = src.match(new RegExp(String.raw`(?:^|[\n\t]|\s)(?:Patient(?:'?s)?(?:\s*Name)?|Name)\s*[:\-]\s*([^\n\t]+?)(?=\s{2,}|\t|\s+(?:${STOP_WORDS})\b|\s*$)`, 'im'));
    if (mt && /[A-Za-z]/.test(mt[1])) rawName = mt[1];
    if (!rawName) {
      const lines = src.split('\n').map(l => l.trim()).filter(Boolean);
      for (const l of lines) {
        if (/\d|:/.test(l)) continue;
        if (/^[A-Za-z'’\-. ()]+,\s*[A-Za-z'’\-. ()]+$/.test(l)) { rawName = l; break; }
      }
      if (!rawName && lines.length) {
        const first = lines[0].split(/\s{2,}|\t/)[0];
        if (!/\d|:/.test(first) && /^[A-Za-z'’\-. ]{3,}$/.test(first) && first.trim().split(/\s+/).length <= 5) rawName = first;
      }
    }
    if (rawName) Object.assign(out, splitName(rawName));

    // Warnings
    if (!out.surname) out.warnings.push('No name found. Type it in below.');
    if (!out.nhs) out.warnings.push('No NHS number found.');
    else if (!nhsValid(out.nhs)) out.warnings.push(`NHS number ${formatNhs(out.nhs)} fails the check-digit test. Check it was copied correctly.`);
    if (!out.dob) out.warnings.push('No date of birth found.');
    else {
      const dobDate = new Date(out.dob.y, out.dob.m - 1, out.dob.d);
      if (dobDate > today) out.warnings.push('Date of birth is in the future.');
      else if (out.age != null && Math.abs(ageOn(out.dob, today) - out.age) >= 1) {
        out.warnings.push(`Age shown (${out.age}) doesn't match the date of birth (${ageOn(out.dob, today)} today). Check the DOB.`);
      }
      if (out.found.dob === 'assumed') out.warnings.push('Date of birth was not labelled. The only date in the text was used.');
    }
    if (out.found.nhs === 'unlabelled') out.warnings.push('NHS number was not labelled. A valid 10-digit number in the text was used.');
    return out;
  }

  /* Values written into forms, from patient + clinician details */
  function buildValues(p, c, prefs, today) {
    prefs = prefs || {};
    today = today || new Date();
    const sur = prefs.surnameCaps ? String(p.surname || '').toUpperCase() : (p.surname || '');
    const fore = p.forenames || '';
    const dob = typeof p.dob === 'string' ? p.dob : formatDate(p.dob);
    const nhs = formatNhs(String(p.nhs || '').replace(/\D/g, '')) || '';
    const mrn = p.mrn || '';
    const full = [fore, sur].filter(Boolean).join(' ');
    const labelLines = [
      [sur, fore].filter(Boolean).join(', '),
      dob && `DOB: ${dob}`,
      nhs && `NHS: ${nhs}`,
      mrn && `Hosp no: ${mrn}`
    ].filter(Boolean);
    const takerSame = c.takerSame !== false;
    return {
      patient_surname: sur,
      patient_forenames: fore,
      patient_fullname: full,
      patient_dob: dob,
      patient_nhs: nhs,
      patient_mrn: mrn,
      patient_sex: p.sex || '',
      patient_label: labelLines.join('\n'),
      consultant_name: c.consultantName || '',
      consultant_job: c.consultantJob || '',
      hospital: c.hospital || '',
      taker_name: takerSame ? (c.consultantName || '') : (c.takerName || ''),
      taker_job: takerSame ? (c.consultantJob || '') : (c.takerJob || ''),
      today: prefs.fillDate ? formatDate({ d: today.getDate(), m: today.getMonth() + 1, y: today.getFullYear() }) : ''
    };
  }

  /* ------------------------------------------------------------------ */
  /* Label classification                                                */
  /* ------------------------------------------------------------------ */
  const KEY_LABELS = {
    patient_surname: 'Surname',
    patient_forenames: 'First names',
    patient_fullname: 'Patient full name',
    patient_dob: 'Date of birth',
    patient_nhs: 'NHS number',
    patient_mrn: 'Hospital number',
    patient_sex: 'Sex',
    patient_label: 'Patient label (all details)',
    consultant_name: 'Responsible consultant',
    consultant_job: 'Consultant job title',
    hospital: 'Hospital / Trust',
    taker_name: 'Consent taken by (name)',
    taker_job: 'Consent taken by (job title)',
    today: "Today's date",
    skip: 'Leave blank'
  };

  const PERSON_NOT = /professional|clinician|consultant|doctor|witness|interpreter|parent|guardian|signature|signed|print|gp\b|next\s*of\s*kin|carer/;
  const RULES = [
    { key: 'patient_label', re: /patient\s*(identifier|id\s*label|label|sticker)|affix\s*(patient\s*)?(label|sticker)|addressograph|pre-?printed\s*label|^patient\s*details/ },
    { key: 'patient_nhs', re: /\bnhs\s*(no\b|num|number|#|id\b)|^nhs$|^nhs\s*no$/ },
    { key: 'patient_dob', re: /date\s*of\s*birth|\bd\s*o\s*b\b|\bdob\b|birth\s*date/ },
    { key: 'patient_mrn', re: /hospital\s*(no|num|number|id|identifier)\b|\bhosp\s*no\b|\bmrn\b|\bunit\s*(no|number)\b|case\s*note|\bpas\s*(no|number|id)\b|^pas$|local\s*(id|identifier|number)|other\s*identifier|record\s*number|\bcrn\b/ },
    { key: 'patient_surname', re: /surname|family\s*name|last\s*name/, not: PERSON_NOT },
    { key: 'patient_forenames', re: /first\s*names?|forenames?|given\s*names?|christian\s*names?/, not: PERSON_NOT },
    { key: 'consultant_name', re: /responsible\s*(health\s*(care\s*)?professional|consultant|clinician|doctor|oncologist)|named\s*(consultant|clinician)|^(name\s*of\s*)?(the\s*)?consultant('?s)?(\s*name)?$|^consultant\s*oncologist$|^clinician\s*responsible/ },
    { key: 'job_title', re: /job\s*title|designation|^role$|^position$|^grade$/ },
    { key: 'print_name', re: /name\s*\(?\s*print|print(ed)?\s*name|name\s*in\s*(block\s*)?capitals|\(print\)|name\s*\(\s*block/ },
    { key: 'hospital', re: /^(name\s*of\s*)?(the\s*)?(hospital|trust|nhs\s*trust|organisation|organization|hospital\s*(\/|or|and)\s*trust|treating\s*(hospital|centre|center)|treatment\s*cent(re|er)|cancer\s*cent(re|er))(\s*name)?$/ },
    { key: 'patient_sex', re: /^(sex|gender)$/ },
    { key: 'name_generic', re: /patient'?s?\s*(full\s*)?name|name\s*of\s*(the\s*)?patient|^full\s*name$|^name$/, not: /professional|clinician|consultant|doctor|witness|interpreter|parent|guardian|print|gp\b|next\s*of\s*kin|carer/ },
    { key: 'date', re: /^date$|^date\s*signed$|^today'?s?\s*date$/ }
  ];

  function norm(s) {
    return String(s || '')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .toLowerCase()
      .replace(/[’`]/g, "'")
      .replace(/[_.]+/g, ' ')
      .replace(/[^a-z0-9'()\/# ]+/g, ' ')
      .replace(/\b\d+\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function classify(raw) {
    const t = norm(raw);
    if (!t) return null;
    for (const r of RULES) if (r.re.test(t) && !(r.not && r.not.test(t))) return r.key;
    return null;
  }

  const CTX_HP = /statement\s+of\s+(the\s+)?(health\s*(care\s*)?professional|clinician|doctor)|health\s*(care\s*)?professional|clinician|doctor|to\s+be\s+(completed|filled\s+in)\s+by\s+(the\s+)?(health|clinician|doctor)|person\s+(obtaining|taking)\s+consent|consent\s+taken\s+by/i;
  const CTX_OTHER = /statement\s+of\s+(the\s+)?patient|patient'?s?\s+signature|signature\s+of\s+(the\s+)?patient|patient\s+(statement|agreement|declaration|confirmation)|interpreter|witness|parent|guardian|parental\s+responsibility|confirmation\s+of\s+consent|\bi\s+(agree|confirm|understand|have\s+read)\b/i;
  const CTX_PATIENT = /patient\s*details|patient\s*identifier|patient\s*information|about\s+the\s+patient|pre-?printed\s*label/i;

  /* ------------------------------------------------------------------ */
  /* Text layout helpers                                                 */
  /* ------------------------------------------------------------------ */
  function buildLines(items) {
    const sorted = items.slice().sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const it of sorted) {
      const tol = Math.max(1.5, it.fs * 0.3);
      let line = null;
      for (let i = lines.length - 1; i >= 0 && i >= lines.length - 4; i--) {
        if (Math.abs(lines[i].y - it.y) <= tol) { line = lines[i]; break; }
      }
      if (!line) { line = { y: it.y, items: [] }; lines.push(line); }
      line.items.push(it);
    }
    for (const l of lines) {
      l.items.sort((a, b) => a.x - b.x);
      l.x0 = l.items[0].x;
      l.x1 = Math.max(...l.items.map(i => i.x + i.w));
      l.text = l.items.map(i => i.str).join(' ').replace(/\s+/g, ' ').trim();
      l.fs = Math.max(...l.items.map(i => i.fs));
    }
    return lines;
  }

  const LEADER_ONLY = /^[\s._…·\-]{3,}$/;

  function segmentLine(line) {
    const segs = [];
    let cur = null;
    for (const it of line.items) {
      const isLeader = LEADER_ONLY.test(it.str);
      if (cur) {
        const gap = it.x - cur.x1;
        const limit = Math.max(10, 1.2 * it.fs);
        if (gap > limit && !(isLeader && gap < 40)) { segs.push(cur); cur = null; }
      }
      if (!cur) cur = { items: [], x0: it.x, x1: it.x + it.w };
      cur.items.push(it);
      cur.x1 = Math.max(cur.x1, it.x + it.w);
    }
    if (cur) segs.push(cur);
    return segs;
  }

  // Joined text with an x position for every character
  function segText(seg) {
    let s = '';
    const xs = [];
    seg.items.forEach((it, idx) => {
      if (idx > 0) {
        const prev = seg.items[idx - 1];
        if (it.x - (prev.x + prev.w) > it.fs * 0.2) { s += ' '; xs.push(prev.x + prev.w); }
      }
      const n = it.str.length || 1;
      for (let i = 0; i < it.str.length; i++) { s += it.str[i]; xs.push(it.x + it.w * (i / n)); }
    });
    xs.push(seg.x1);
    return { s, xs };
  }

  function rectsOverlap(a, b) {
    return a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
  }

  function labelForWidget(r, lines) {
    // r = [x1,y1,x2,y2]
    const [x1, y1, x2, y2] = r;
    let best = null;
    // Left of the field, same row
    for (const l of lines) {
      if (l.y < y1 - 3 || l.y > y2 + 3) continue;
      const left = l.items.filter(it => it.x + it.w <= x1 + 3 && x1 - (it.x + it.w) < 180);
      if (!left.length) continue;
      // walk left from nearest item while gaps are small
      const cluster = [left[left.length - 1]];
      for (let i = left.length - 2; i >= 0; i--) {
        const gap = cluster[0].x - (left[i].x + left[i].w);
        if (gap > 25) break;
        cluster.unshift(left[i]);
      }
      const dist = x1 - (cluster[cluster.length - 1].x + cluster[cluster.length - 1].w);
      const text = cluster.map(i => i.str).join(' ').replace(/[._…]{3,}/g, ' ').replace(/\s+/g, ' ').trim();
      if (text && (!best || dist < best.dist)) best = { text, dist, where: 'left' };
    }
    if (best && best.dist <= 150) return best.text;
    // Directly above the field
    let above = null;
    for (const l of lines) {
      if (l.y <= y2 - 2 || l.y > y2 + 18) continue;
      const over = l.items.filter(it => it.x < x2 && it.x + it.w > x1 - 6);
      if (!over.length) continue;
      const text = over.map(i => i.str).join(' ').replace(/\s+/g, ' ').trim();
      if (text && (!above || l.y < above.y)) above = { text, y: l.y };
    }
    if (above) return above.text;
    return best ? best.text : '';
  }

  function contextFor(page, y, x, lines) {
    let best = null;
    for (const l of lines) {
      const dy = l.y - y;
      if (dy < -2 || dy > 320) continue;
      if (dy < 2 && l.x0 > x) continue; // same line but to the right
      let kind = null;
      if (CTX_OTHER.test(l.text)) kind = 'other';
      else if (CTX_HP.test(l.text)) kind = 'hp';
      else if (CTX_PATIENT.test(l.text)) kind = 'patient';
      if (!kind) continue;
      if (!best || dy < best.dy) best = { kind, dy, text: l.text };
    }
    return best ? best.kind : 'none';
  }

  /* ------------------------------------------------------------------ */
  /* Analyse a PDF                                                       */
  /* ------------------------------------------------------------------ */
  async function analyse(bytes, opts) {
    opts = opts || {};
    const pdfjsLib = opts.pdfjsLib || root.pdfjsLib;
    const source = opts.source || 'other';
    const overrides = opts.overrides || {};
    const task = pdfjsLib.getDocument({
      data: bytes.slice(0),
      isEvalSupported: false,
      standardFontDataUrl: opts.standardFontDataUrl,
      disableFontFace: true,
      verbosity: 0
    });
    const doc = await task.promise;
    const pages = [];
    const targets = [];
    let nextId = 0;

    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const [vx0, vy0, vx1, vy1] = page.view;
      pages.push({ w: vx1 - vx0, h: vy1 - vy0, view: page.view, rotate: page.rotate });
      const tc = await page.getTextContent();
      const items = tc.items
        .filter(it => it.str && it.str.trim())
        .map(it => ({
          str: it.str,
          x: it.transform[4],
          y: it.transform[5],
          w: it.width,
          fs: Math.hypot(it.transform[2], it.transform[3]) || it.height || 10
        }));
      const lines = buildLines(items);
      const annots = await page.getAnnotations({ intent: 'display' });
      const widgets = annots.filter(a => a.subtype === 'Widget');
      const pageTargets = [];

      // 1. Existing text fields
      for (const a of widgets) {
        if (a.fieldType !== 'Tx' || a.readOnly || a.hidden) continue;
        const [ax1, ay1, ax2, ay2] = [Math.min(a.rect[0], a.rect[2]), Math.min(a.rect[1], a.rect[3]), Math.max(a.rect[0], a.rect[2]), Math.max(a.rect[1], a.rect[3])];
        const label = labelForWidget([ax1, ay1, ax2, ay2], lines);
        const nameKey = classify(a.fieldName) || classify(a.alternativeText);
        const labelKey = classify(label);
        const key = labelKey || nameKey;
        pageTargets.push({
          id: 't' + (nextId++), page: p, kind: 'acro',
          fieldName: a.fieldName,
          rect: [ax1, ay1, ax2 - ax1, ay2 - ay1],
          label: label || a.alternativeText || a.fieldName,
          rawKey: key,
          multiline: !!a.multiLine,
          maxLen: a.maxLen || 0,
          comb: !!a.comb,
          existing: (a.fieldValue || '').toString().trim(),
          fontSize: 10,
          baseY: ay1
        });
      }

      // 2. Printed labels on flat pages
      if (opts.detectFlat !== false && page.rotate % 360 === 0) {
        const widgetRects = widgets.map(a => [Math.min(a.rect[0], a.rect[2]), Math.min(a.rect[1], a.rect[3]), Math.abs(a.rect[2] - a.rect[0]), Math.abs(a.rect[3] - a.rect[1])]);
        const rightLimit = vx1 - 28;
        for (const line of lines) {
          const segs = segmentLine(line);
          segs.forEach((seg, si) => {
            const { s, xs } = segText(seg);
            const nextX = si + 1 < segs.length ? segs[si + 1].x0 - 6 : rightLimit;
            // split into label / leader pieces
            const pieceRe = /([^._…·]*?)\s*([._…·]{4,}|_{3,})|([^._…·]+)$/g;
            let m;
            while ((m = pieceRe.exec(s)) && m[0].length) {
              const labelRaw = (m[1] !== undefined ? m[1] : m[3]) || '';
              const hasLeader = !!m[2];
              const labelText = labelRaw.replace(/\s+/g, ' ').trim();
              const stripped = labelText.replace(/[:\s]+$/, '');
              if (stripped.length < 2 || stripped.length > 50 || stripped.split(/\s+/).length > 8) continue;
              const key = classify(stripped);
              if (!key) continue;
              const labelStartIdx = m.index + (m[0].length - m[0].trimStart().length);
              const labelEndIdx = m.index + labelRaw.replace(/\s+$/, '').length;
              const labelStartX = xs[Math.min(labelStartIdx, xs.length - 1)];
              const labelEndX = xs[Math.min(labelEndIdx, xs.length - 1)];
              const fs = Math.min(seg.items[0].fs, 12);
              let x0, x1;
              if (hasLeader) {
                const ls = m.index + m[0].indexOf(m[2]);
                x0 = xs[ls];
                x1 = xs[Math.min(ls + m[2].length, xs.length - 1)];
                if (ls + m[2].length >= s.length) x1 = Math.max(x1, seg.x1);
              } else {
                const endsColon = /:\s*$/.test(labelText);
                const atSegEnd = labelEndIdx >= s.replace(/\s+$/, '').length - 1;
                if (!atSegEnd) continue; // label followed by more words on the same segment: a sentence
                const free = nextX - labelEndX;
                if (!endsColon && free < 70) continue;
                x0 = labelEndX + 5;
                x1 = nextX;
              }
              let rect, below = false, multiline = false;
              const h = Math.min(16, Math.max(10, fs * 1.35));
              if (key === 'patient_label') {
                // A label box: write a 4-line block underneath the label text, stopping above any other text
                const bx = labelStartX;
                const bw = Math.min(230, rightLimit - bx);
                let bottom = line.y - 4 - 46;
                for (const other of lines) {
                  if (other === line || other.y >= line.y || other.y < bottom) continue;
                  if (other.items.some(it => it.x < bx + bw && it.x + it.w > bx)) bottom = Math.max(bottom, other.y + other.fs);
                }
                const bh = (line.y - 4) - bottom;
                if (bh >= 20) { rect = [bx, bottom, bw, bh]; multiline = true; below = true; }
              }
              if (rect) { /* already placed */ }
              else if (x1 - x0 >= 45) {
                // sit just above dot leaders; align with the label baseline otherwise
                rect = [x0 + (hasLeader ? 3 : 0), line.y - fs * 0.3 + (hasLeader ? 2.6 : 0), Math.min(x1 - x0 - (hasLeader ? 3 : 0), 330), h];
              } else {
                below = true;
                rect = [labelStartX, line.y - fs * 1.6 - h * 0.5, Math.min(220, rightLimit - labelStartX), h];
              }
              if (widgetRects.some(wr => rectsOverlap(rect, wr))) continue;
              if (pageTargets.some(t => t.kind === 'acro' && t.rawKey === key && Math.abs(t.baseY - line.y) < 30)) continue;
              pageTargets.push({
                id: 't' + (nextId++), page: p, kind: 'flat',
                rect, label: stripped, rawKey: key, multiline,
                maxLen: 0, comb: false, existing: '',
                fontSize: multiline ? 8 : Math.max(7, Math.min(10, fs)), baseY: line.y, below
              });
            }
          });
        }
      }

      // 3. Resolve context-dependent keys
      pageTargets.sort((a, b) => b.baseY - a.baseY || a.rect[0] - b.rect[0]);
      const hasIndividual = pageTargets.some(t => ['patient_surname', 'patient_forenames', 'patient_nhs', 'patient_dob', 'name_generic'].includes(t.rawKey));
      pageTargets.forEach((t, i) => {
        const ctx = contextFor(p, t.baseY, t.rect[0], lines);
        t.context = ctx;
        let k = t.rawKey;
        if (!k) k = null;
        else if (k === 'patient_label' && hasIndividual) k = 'skip';
        else if (k === 'print_name') k = ctx === 'hp' ? 'taker_name' : 'skip';
        else if (k === 'name_generic') k = ctx === 'hp' ? 'taker_name' : (ctx === 'other' ? 'skip' : 'patient_fullname');
        else if (k === 'date') k = ctx === 'hp' ? 'today' : 'skip';
        else if (k === 'job_title') {
          let paired = null;
          for (let j = i - 1; j >= 0; j--) {
            const q = pageTargets[j];
            if (q.baseY - t.baseY > 60) break;
            if (['consultant_name', 'taker_name', 'skip'].includes(q.key) && ['consultant_name', 'print_name', 'name_generic'].includes(q.rawKey)) { paired = q; break; }
          }
          if (paired) k = paired.key === 'consultant_name' ? 'consultant_job' : paired.key === 'taker_name' ? 'taker_job' : 'skip';
          else k = ctx === 'hp' ? 'taker_job' : ctx === 'other' ? 'skip' : 'consultant_job';
        }
        t.autoKey = k;
        t.key = k;
        t.sig = `${source}|${norm(t.label).slice(0, 60)}|${k || 'none'}`;
        const ov = overrides[t.sig];
        if (ov) {
          if (ov.key) t.key = ov.key;
          if (ov.dx || ov.dy || ov.dw) {
            if (t.kind === 'flat') t.rect = [t.rect[0] + (ov.dx || 0), t.rect[1] + (ov.dy || 0), Math.max(20, t.rect[2] + (ov.dw || 0)), t.rect[3]];
            t.adjusted = true;
          }
        }
      });
      targets.push(...pageTargets.filter(t => t.key));
    }
    try { await doc.destroy(); } catch (e) { /* ignore */ }
    return { numPages: pages.length, pages, targets };
  }

  /* ------------------------------------------------------------------ */
  /* Fill                                                                */
  /* ------------------------------------------------------------------ */
  function fitToField(v, key, maxLen, comb) {
    if (!maxLen || v.length <= maxLen) return v;
    if (key === 'patient_nhs') return v.replace(/\D/g, '').slice(0, maxLen);
    if (key === 'patient_dob') {
      const d = v.replace(/\D/g, '');
      if (maxLen >= 8) return d.slice(0, 8);
      if (maxLen === 6) return d.slice(0, 4) + d.slice(6, 8);
    }
    if (comb) return v.replace(/\s/g, '').slice(0, maxLen);
    return v.slice(0, maxLen);
  }

  // pdf-lib's flatten() can leave page /Annots entries pointing at deleted widgets; drop them
  function cleanAnnots(doc, PDFLib) {
    const { PDFName, PDFArray, PDFRef } = PDFLib;
    for (const page of doc.getPages()) {
      const annots = page.node.lookup(PDFName.of('Annots'));
      if (!(annots instanceof PDFArray)) continue;
      const keep = [];
      for (let i = 0; i < annots.size(); i++) {
        const entry = annots.get(i);
        if (entry instanceof PDFRef && !doc.context.lookup(entry)) continue;
        keep.push(entry);
      }
      if (keep.length) page.node.set(PDFName.of('Annots'), doc.context.obj(keep));
      else page.node.delete(PDFName.of('Annots'));
    }
  }

  async function fill(bytes, analysis, values, opts) {
    opts = opts || {};
    const PDFLib = opts.PDFLib || root.PDFLib;
    const { PDFDocument, StandardFonts, rgb, PDFName, PDFBool } = PDFLib;
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const form = doc.getForm();
    const pages = doc.getPages();
    const report = { filled: [], skipped: [], warnings: [] };
    let needAppearances = false;
    let n = 0;

    const addFlat = (t, v) => {
      const page = pages[t.page - 1];
      const tf = form.createTextField(`cpack_${t.key}_${t.page}_${n++}`);
      if (t.multiline || /\n/.test(v)) tf.enableMultiline();
      tf.setText(v);
      tf.addToPage(page, {
        x: t.rect[0], y: t.rect[1], width: t.rect[2], height: t.rect[3],
        font, textColor: rgb(0, 0, 0), backgroundColor: undefined, borderColor: undefined, borderWidth: 0
      });
      let size = t.fontSize || 10;
      const longest = Math.max(...v.split('\n').map(l => font.widthOfTextAtSize(l, size)));
      if (longest > t.rect[2] - 2) size = Math.max(6, size * (t.rect[2] - 2) / longest);
      tf.setFontSize(size);
      tf.updateAppearances(font);
    };

    for (const t of analysis.targets) {
      if (t.include === false || !t.key || t.key === 'skip') continue;
      let v = values[t.key];
      if (!v) { report.skipped.push({ id: t.id, reason: 'no value' }); continue; }
      v = String(v);
      if (t.kind === 'acro') {
        try {
          const f = form.getTextField(t.fieldName);
          const cur = (f.getText() || '').trim();
          if (cur && !opts.overwrite) { report.skipped.push({ id: t.id, reason: 'already filled' }); continue; }
          if (!f.isMultiline()) v = v.replace(/\n+/g, '   ');
          const fitted = fitToField(v, t.key, f.getMaxLength() || t.maxLen, f.isCombed ? f.isCombed() : t.comb);
          if (fitted !== v && t.key !== 'patient_nhs' && t.key !== 'patient_dob') report.warnings.push(`${t.label}: text shortened to fit the field.`);
          f.setText(fitted);
          try {
            if (!f.isCombed || !f.isCombed()) {
              const size = Math.min(10, t.rect[3] * 0.65);
              if (!f.isMultiline()) {
                const w = font.widthOfTextAtSize(fitted, size);
                f.setFontSize(w > t.rect[2] - 4 ? Math.max(6, size * (t.rect[2] - 4) / w) : size);
              } else f.setFontSize(Math.min(10, size));
            }
          } catch (e) { /* field may have no DA; fine */ }
          try { f.updateAppearances(font); } catch (e) { needAppearances = true; }
          report.filled.push({ id: t.id, key: t.key });
        } catch (e) {
          try { addFlat(t, v); report.filled.push({ id: t.id, key: t.key, fallback: true }); }
          catch (e2) { report.warnings.push(`Could not fill "${t.label}": ${e2.message}`); }
        }
      } else {
        try { addFlat(t, v); report.filled.push({ id: t.id, key: t.key }); }
        catch (e) { report.warnings.push(`Could not fill "${t.label}": ${e.message}`); }
      }
    }
    if (needAppearances) {
      try { form.acroForm.dict.set(PDFName.of('NeedAppearances'), PDFBool.True); } catch (e) { /* ignore */ }
    }
    if (opts.flatten) {
      try { form.flatten(); cleanAnnots(doc, PDFLib); } catch (e) { report.warnings.push('Could not lock the form fields; the file stays editable.'); }
    }
    const out = await doc.save({ useObjectStreams: false });
    return { bytes: out, report };
  }

  async function flattenCopy(bytes, opts) {
    const PDFLib = (opts && opts.PDFLib) || root.PDFLib;
    const doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    try { doc.getForm().flatten(); cleanAnnots(doc, PDFLib); } catch (e) { /* leave as is */ }
    return doc.save({ useObjectStreams: false });
  }

  async function merge(list, opts) {
    const PDFLib = (opts && opts.PDFLib) || root.PDFLib;
    const out = await PDFLib.PDFDocument.create();
    for (const b of list) {
      const src = await PDFLib.PDFDocument.load(b, { ignoreEncryption: true, updateMetadata: false });
      const copied = await out.copyPages(src, src.getPageIndices());
      copied.forEach(p => out.addPage(p));
    }
    return out.save({ useObjectStreams: false });
  }

  const api = {
    parsePatient, parseDate, formatDate, nhsValid, formatNhs, splitName, titleCase,
    buildValues, classify, norm, analyse, fill, flattenCopy, merge, KEY_LABELS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ConsentEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
