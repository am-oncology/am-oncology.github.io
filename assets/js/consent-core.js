/* ============================================================
   consent-core.js — the parts of the consent pack builder that do
   not touch the page: parsing pasted patient details, validating
   them, deciding default ticks, and filling a PDF.

   Works in the browser (window.ConsentCore, with window.PDFLib) and
   in Node for tests (module.exports, pass pdf-lib in).

   Nothing here stores or transmits anything.
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ConsentCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  var TITLES = /^(mr|mrs|ms|miss|mx|dr|prof|professor|sir|dame|rev|revd|lord|lady)\.?\s+/i;

  function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

  /* ── NHS number ─────────────────────────────────────────────── */
  function nhsDigits(s) { return String(s || '').replace(/\D/g, ''); }

  /* Modulus 11 check digit, as specified by NHS Digital. */
  function nhsValid(s) {
    var d = nhsDigits(s);
    if (d.length !== 10) return false;
    var sum = 0;
    for (var i = 0; i < 9; i++) sum += Number(d[i]) * (10 - i);
    var check = 11 - (sum % 11);
    if (check === 11) check = 0;
    if (check === 10) return false;
    return check === Number(d[9]);
  }

  function nhsFormat(s) {
    var d = nhsDigits(s);
    return d.length === 10 ? d.slice(0, 3) + ' ' + d.slice(3, 6) + ' ' + d.slice(6) : clean(s);
  }

  /* ── Dates (UK order only: day/month/year) ──────────────────── */
  function parseDate(s) {
    var t = clean(s);
    if (!t) return null;
    var m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    var d, mo, y;
    if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else {
      m = t.match(/^(\d{1,2})[\/.\- ]+([A-Za-z]{3,9}|\d{1,2})[\/.\-, ]+(\d{2}|\d{4})$/);
      if (!m) return null;
      d = +m[1];
      mo = /\d/.test(m[2]) ? +m[2] : MONTHS[m[2].slice(0, 4).toLowerCase()] || MONTHS[m[2].slice(0, 3).toLowerCase()];
      y = +m[3];
      if (m[3].length === 2) {
        var yy = new Date().getFullYear() % 100;
        y += (y > yy ? 1900 : 2000);
      }
    }
    if (!mo || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    var date = new Date(Date.UTC(y, mo - 1, d));
    if (date.getUTCMonth() !== mo - 1) return null; // 31/02 etc.
    return { y: y, m: mo, d: d };
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function formatDate(p) { return p ? pad(p.d) + '/' + pad(p.m) + '/' + p.y : ''; }
  function ageOn(p, now) {
    now = now || new Date();
    var a = now.getFullYear() - p.y;
    if (now.getMonth() + 1 < p.m || (now.getMonth() + 1 === p.m && now.getDate() < p.d)) a--;
    return a;
  }

  /* ── Pasted patient details ─────────────────────────────────────
     Handles the two Cerner layouts in use:

       SURNAME, Firstname
       MRN: 10126432
       NHS: 123-123-1234
       DOB: 10/10/1952

       Patient:   SURNAME, Firstname    MRN: 10126432    FIN: 18901188
       Age:   73 years     Sex:  Female     DOB:  10/Oct/1952

     and anything reasonably close to them. Each field is reported as
     found or not, so the page can highlight what needs typing. */
  function splitName(raw) {
    var s = clean(raw).replace(/\s{2,}.*/, '');
    var m = s.match(/^([^,]+),\s*(.+)$/);
    if (!m) return null;
    var surname = clean(m[1]).replace(TITLES, '');
    var forenames = clean(m[2]).replace(TITLES, '').replace(/\s*\(.*?\)\s*/g, ' ').trim();
    if (!/[A-Za-z]/.test(surname) || !/[A-Za-z]/.test(forenames)) return null;
    return { surname: surname, forenames: forenames };
  }

  function parsePatient(text) {
    var t = String(text || '').replace(/\r/g, '').replace(/ /g, ' ');
    var out = { surname: '', forenames: '', dob: '', nhs: '', mrn: '', sex: '', found: {} };

    // name: after "Patient:" / "Name:", else the first line that looks like "SURNAME, First"
    var nm = t.match(/(?:^|\n|\s)(?:patient(?:\s+name)?|name)\s*:\s*([^\n]*?)(?=\s{2,}|\s+(?:MRN|NHS|DOB|FIN|Age|Sex)\b|\n|$)/i);
    var name = nm ? splitName(nm[1]) : null;
    if (!name) {
      var lines = t.split('\n');
      for (var i = 0; i < lines.length && !name; i++) {
        var L = clean(lines[i]);
        if (!L || /:/.test(L.split(',')[0])) continue;
        if (/^[A-Za-z'’\-. ]+,\s*[A-Za-z'’\-. ()]+$/.test(L)) name = splitName(L);
      }
    }
    if (name) { out.surname = name.surname; out.forenames = name.forenames; out.found.name = true; }

    var mrn = t.match(/\b(?:MRN|hospital\s*(?:no|number)|unit\s*(?:no|number))\.?\s*[:#]?\s*([A-Z]{0,3}\d{4,12})\b/i);
    if (mrn) { out.mrn = mrn[1].toUpperCase(); out.found.mrn = true; }

    var nhs = t.match(/\bNHS\s*(?:no\.?|number|#)?\s*:?\s*((?:\d[\s-]?){9}\d)\b/i);
    if (!nhs) {
      // an unlabelled 3-3-4 number is taken only if its check digit is right
      var loose = t.match(/\b(\d{3}[\s-]\d{3}[\s-]\d{4})\b/);
      if (loose && nhsValid(loose[1])) nhs = loose;
    }
    if (nhs) { out.nhs = nhsDigits(nhs[1]); out.found.nhs = true; }

    var dob = t.match(/\b(?:DOB|D\.O\.B\.?|date\s+of\s+birth)\s*:?\s*(\d{1,2}[\/.\- ]+(?:[A-Za-z]{3,9}|\d{1,2})[\/.\-, ]+\d{2,4})/i);
    if (dob) {
      var p = parseDate(dob[1]);
      if (p) { out.dob = formatDate(p); out.found.dob = true; }
    }

    var sex = t.match(/\b(?:sex|gender)\s*:?\s*(female|male|f|m)\b/i);
    if (sex) { out.sex = /^f/i.test(sex[1]) ? 'F' : 'M'; out.found.sex = true; }
    return out;
  }

  /* ── What goes in each kind of box ──────────────────────────── */
  function fullName(p) {
    return clean([p.forenames, (p.surname || '').toUpperCase()].join(' '));
  }
  function identifierText(p) {
    var parts = [];
    if (p.nhs) parts.push('NHS ' + nhsFormat(p.nhs));
    if (p.mrn) parts.push('MRN ' + p.mrn);
    return parts.join('   ');
  }

  /* What goes in an empty "Patient identifier/label" box: a printed-label look. */
  function patientLabel(p) {
    var lines = [];
    var name = clean([(p.surname || '').toUpperCase(), p.forenames].filter(Boolean).join(', '));
    if (name) lines.push(name);
    if (p.dob) lines.push('DOB: ' + p.dob);
    if (p.nhs) lines.push('NHS: ' + nhsFormat(p.nhs));
    if (p.mrn) lines.push('MRN: ' + p.mrn);
    return lines.join('\n');
  }

  function valueFor(role, data, form) {
    var p = data.patient || {}, c = data.clinician || {};
    var roles = {};
    (form.fields || []).forEach(function (f) { roles[f.role] = true; });
    switch (role) {
      case 'surname': return (p.surname || '').toUpperCase();
      case 'forenames': return p.forenames || '';
      case 'patient_name': return fullName(p);
      case 'dob': return p.dob || '';
      case 'nhs': return p.nhs ? nhsFormat(p.nhs) : (p.mrn ? 'MRN ' + p.mrn : '');
      // A generic identifier box gets both numbers unless the form also has an NHS box.
      case 'identifier': return roles.nhs ? (p.mrn || '') : identifierText(p);
      case 'patient_label': return patientLabel(p);
      case 'hospital': return c.site || '';
      case 'consultant': return c.consultant || c.name || '';
      case 'consultant_role': return c.consultant ? (c.consultantRole || '') : (c.role || '');
      case 'clin_name': return c.name || '';
      case 'clin_role': return c.role || '';
      default: return '';
    }
  }

  /* ── Default ticks ──────────────────────────────────────────────
     rules come from assets/json/consent-ticks.json. First matching
     rule wins; anything unmatched is left blank for the clinician. */
  function compile(rules) {
    return (rules || []).map(function (r) {
      return {
        id: r.id, tick: r.tick, note: r.note || '',
        match: r.match ? new RegExp(r.match, 'i') : null,
        prompt: r.prompt ? new RegExp(r.prompt, 'i') : null,
        option: r.option ? new RegExp(r.option, 'i') : null,
        section: r.section ? new RegExp(r.section, 'i') : null
      };
    });
  }

  function ruleFor(tick, compiled) {
    var opt = clean(tick.option), prompt = clean(tick.prompt || ''), line = clean(tick.line || '');
    var section = clean(tick.section || '');
    var all = clean(prompt + ' ' + opt) || line;
    for (var i = 0; i < compiled.length; i++) {
      var r = compiled[i];
      if (r.match && !r.match.test(all) && !r.match.test(opt)) continue;
      if (r.prompt && !r.prompt.test(prompt || line)) continue;
      if (r.option && !r.option.test(opt)) continue;
      if (r.section && !r.section.test(section)) continue;
      if (!r.match && !r.prompt && !r.option && !r.section) continue;
      return r;
    }
    return null;
  }

  /* Returns { name|name#value: {on, why, action} } for one form.
     action: always | female | male | known | review | never | statement */
  function defaultTicks(form, sex, rules) {
    var compiled = compile(rules);
    var out = {};
    (form.ticks || []).forEach(function (t) {
      var r = ruleFor(t, compiled);
      var action, note;
      if (r) { action = r.tick; note = r.note; }
      else if (!t.matrix && !t.group && clean(t.option).split(/\s+/).length >= 5) { action = 'always'; note = 'Statement or risk \u2014 pre-ticked'; }
      else { action = 'review'; note = ''; }
      // A row of options (Outpatient / Day unit / Inpatient) is a choice: a rule
      // that only knows which part of the form it is in must not pick one.
      if (t.group && r && r.section && !r.match && !r.option && !r.prompt && action === 'always') {
        action = 'review'; note = 'Choose one';
      }
      // Grids (Expected / Common / Rare …) need a clinical judgement per row,
      // unless the row is for the other sex.
      if (t.matrix && action !== 'never') {
        var otherSex = (action === 'female' && sex === 'M') || (action === 'male' && sex === 'F');
        if (!otherSex) { action = 'review'; note = 'Choose how likely for this patient (one per row)'; }
      }
      var on = false, why;
      if (action === 'always') { on = true; why = note || 'Pre-ticked'; }
      else if (action === 'female' || action === 'male') {
        var want = action === 'female' ? 'F' : 'M';
        if (sex === want) { on = true; why = note || (action === 'female' ? 'Female patient' : 'Male patient'); }
        else if (sex) { why = 'Not applicable (' + (sex === 'F' ? 'female' : 'male') + ' patient)'; }
        else { why = 'Choose the patient\u2019s sex to decide'; }
      } else if (action === 'known') {
        if (sex) { on = true; why = note || 'Applies to all patients'; }
        else { why = 'Choose the patient\u2019s sex to decide'; }
      } else if (action === 'never') { why = note || 'Left blank'; }
      else { action = 'review'; why = note ? note + ' \u2014 review' : 'Not pre-ticked \u2014 review'; }
      out[tickKey(t)] = { on: on, why: why, action: action };
    });
    // only one option per group may be on
    var seen = {};
    (form.ticks || []).forEach(function (t) {
      var g = t.group;
      if (!g) return;
      var k = tickKey(t);
      if (out[k].on) { if (seen[g]) out[k].on = false; else seen[g] = true; }
    });
    return out;
  }

  function tickKey(t) { return t.kind === 'radio' ? t.name + '#' + t.value : t.name; }

  function tickLabel(t) {
    var o = clean(t.option), p = clean(t.prompt);
    if (p && o) return p.replace(/[:\s]+$/, '') + ' — ' + o;
    return o || clean(t.line) || 'Unlabelled tick box (page ' + (t.page + 1) + ')';
  }

  /* ── Fill one PDF ───────────────────────────────────────────── */
  // Helvetica can only draw WinAnsi characters; strip accents rather than fail.
  function winAnsi(s) {
    return String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^\n\x20-\x7E -ÿ‘’“”–—•€]/g, '?');
  }

  async function fillPdf(bytes, form, data, ticks, PDFLib) {
    var doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
    var pdfForm = doc.getForm();
    var problems = [];

    var helv = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    (form.fields || []).forEach(function (f) {
      var v = valueFor(f.role, data, form);
      if (!v) return;
      try {
        var tf = pdfForm.getTextField(f.name);
        var text = winAnsi(v);
        var max = tf.getMaxLength();
        if (max && text.length > max) text = text.slice(0, max);
        var widget = tf.acroField.getWidgets()[0];
        var rect = widget ? widget.getRectangle() : null;
        if (rect) {
          if (text.indexOf('\n') >= 0) {
            // multi-line box: size so every line fits across and down
            if (!tf.isMultiline()) tf.enableMultiline();
            var rows = text.split('\n');
            var widest = Math.max.apply(null, rows.map(function (r) { return helv.widthOfTextAtSize(r, 1); }));
            var size = Math.min(9, (rect.width - 6) / widest, (rect.height - 4) / (rows.length * 1.2));
            tf.setFontSize(Math.max(5, Math.floor(size * 2) / 2));
          } else {
            // one line: shrink long text so it is never cut off
            var w1 = helv.widthOfTextAtSize(text, 1);
            var fit = Math.min(10, (rect.width - 6) / w1, rect.height * 0.75);
            if (fit < 9 || f.added) tf.setFontSize(Math.max(5, Math.floor(Math.min(9, fit) * 2) / 2));
          }
        }
        tf.setText(text);
      } catch (e) {
        problems.push('Could not fill "' + (f.label || f.role) + '"');
      }
    });

    var radios = {};
    (form.ticks || []).forEach(function (t) {
      var st = ticks[tickKey(t)];
      var on = !!(st && st.on);
      if (t.kind === 'radio') {
        (radios[t.name] = radios[t.name] || []).push({ t: t, on: on });
        return;
      }
      try {
        var cb = pdfForm.getCheckBox(t.name);
        if (on) cb.check(); else cb.uncheck();
      } catch (e) { problems.push('Could not set tick "' + tickLabel(t) + '"'); }
    });
    Object.keys(radios).forEach(function (name) {
      var chosen = radios[name].filter(function (x) { return x.on; })[0];
      try {
        var field = pdfForm.getField(name);
        if (field instanceof PDFLib.PDFRadioGroup) {
          if (chosen) field.select(String(chosen.t.value)); else field.clear();
        } else if (field instanceof PDFLib.PDFCheckBox) {
          if (chosen && chosen.t.onValue) field.acroField.setValue(PDFLib.PDFName.of(String(chosen.t.onValue)));
          else field.uncheck();
        }
      } catch (e) { problems.push('Could not set option "' + name + '"'); }
    });

    pdfForm.updateFieldAppearances(helv);
    var bytesOut = await doc.save({ updateFieldAppearances: false }); // form stays fillable
    return { bytes: bytesOut, problems: problems };
  }

  function safeFileName(s) {
    return clean(s).replace(/[\\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').slice(0, 110);
  }

  return {
    nhsDigits: nhsDigits, nhsValid: nhsValid, nhsFormat: nhsFormat,
    parseDate: parseDate, formatDate: formatDate, ageOn: ageOn,
    parsePatient: parsePatient, fullName: fullName, identifierText: identifierText,
    valueFor: valueFor, defaultTicks: defaultTicks, tickKey: tickKey, tickLabel: tickLabel,
    fillPdf: fillPdf, safeFileName: safeFileName, winAnsi: winAnsi
  };
});
