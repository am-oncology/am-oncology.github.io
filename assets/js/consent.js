/* ============================================================
   consent.js — page logic for consent.html.

   Data flow:  consent-data/catalogue.json  (written weekly by
   .github/workflows/consent-forms.yml) lists every form, where its
   fields are and what its tick boxes say. The page fills those
   fields with pdf-lib, entirely in this tab.

   Patient details live only in the inputs and in memory. They are
   never written to localStorage, never put in a URL and never sent
   over the network. Only the clinician's own details are stored,
   and only if "Remember" is ticked.
   ============================================================ */
window.addEventListener('DOMContentLoaded', function () {
  'use strict';

  var C = window.ConsentCore;
  var $ = function (id) { return document.getElementById(id); };
  var DATA = 'consent-data/';
  var CLIN_KEY = 'cot-consent-clinician';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtDay(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  /* ════ State ════════════════════════════════════════════════ */
  var catalogue = { forms: [], leaflets: [] };
  var formById = {}, leafletById = {};
  var rules = [];
  var sex = '';
  var source = 'rcr';
  var pack = [];           // [{ id, kind: 'form'|'leaflet', overrides: {tickKey: bool} }]
  var outputs = [];        // [{ name, url, blob }]
  var pdfCache = {};       // file path → ArrayBuffer (forms are public, caching them is fine)

  /* ════ Clinician details (the only thing persisted) ══════════ */
  var CLIN_FIELDS = { name: 'c-name', role: 'c-role', site: 'c-site', consultant: 'c-consultant', consultantRole: 'c-consultant-role' };

  function clinician() {
    var o = {};
    Object.keys(CLIN_FIELDS).forEach(function (k) { o[k] = $(CLIN_FIELDS[k]).value.trim(); });
    return o;
  }
  function saveClinician() {
    try {
      if ($('c-remember').checked) localStorage.setItem(CLIN_KEY, JSON.stringify(clinician()));
      else localStorage.removeItem(CLIN_KEY);
    } catch (e) { /* private mode */ }
  }
  function loadClinician() {
    try {
      var s = JSON.parse(localStorage.getItem(CLIN_KEY) || 'null');
      if (!s) return;
      Object.keys(CLIN_FIELDS).forEach(function (k) { if (s[k]) $(CLIN_FIELDS[k]).value = s[k]; });
    } catch (e) {}
  }
  Object.keys(CLIN_FIELDS).forEach(function (k) {
    $(CLIN_FIELDS[k]).addEventListener('input', function () { saveClinician(); invalidateOutputs(); });
  });
  $('c-remember').addEventListener('change', saveClinician);
  $('c-forget').addEventListener('click', function () {
    try { localStorage.removeItem(CLIN_KEY); } catch (e) {}
    Object.keys(CLIN_FIELDS).forEach(function (k) { $(CLIN_FIELDS[k]).value = ''; });
    invalidateOutputs();
  });

  /* ════ Patient ══════════════════════════════════════════════ */
  var P_FIELDS = { surname: 'p-surname', forenames: 'p-forenames', dob: 'p-dob', nhs: 'p-nhs', mrn: 'p-mrn' };

  function patient() {
    var dobP = C.parseDate($('p-dob').value);
    return {
      surname: $('p-surname').value.trim(),
      forenames: $('p-forenames').value.trim(),
      dob: dobP ? C.formatDate(dobP) : $('p-dob').value.trim(),
      nhs: C.nhsDigits($('p-nhs').value),
      mrn: $('p-mrn').value.trim().toUpperCase(),
      sex: sex
    };
  }

  function setSex(v) {
    sex = v;
    Array.prototype.forEach.call($('sex-toggle').querySelectorAll('button'), function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.sex === v));
    });
    renderPack();
    invalidateOutputs();
  }
  $('sex-toggle').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-sex]');
    if (b) setSex(b.dataset.sex);
  });

  function validatePatient() {
    var p = patient();
    // DOB
    var h = $('h-dob'), dobP = C.parseDate($('p-dob').value);
    $('p-dob').classList.remove('invalid');
    if (!$('p-dob').value.trim()) { h.textContent = ''; h.className = 'field-hint'; }
    else if (!dobP) { h.textContent = 'Not a valid date (dd/mm/yyyy)'; h.className = 'field-hint hint-bad'; $('p-dob').classList.add('invalid'); }
    else {
      var age = C.ageOn(dobP);
      if (age < 0) { h.textContent = 'Date is in the future'; h.className = 'field-hint hint-bad'; $('p-dob').classList.add('invalid'); }
      else if (age > 115) { h.textContent = 'Age ' + age + ' — check'; h.className = 'field-hint hint-warn'; }
      else { h.textContent = 'Age ' + age; h.className = 'field-hint hint-ok'; }
    }
    // NHS number
    var hn = $('h-nhs'), raw = $('p-nhs').value.trim();
    $('p-nhs').classList.remove('invalid');
    if (!raw) { hn.textContent = p.mrn ? 'None — MRN will be used' : ''; hn.className = 'field-hint'; }
    else if (C.nhsDigits(raw).length !== 10) { hn.textContent = 'Needs 10 digits'; hn.className = 'field-hint hint-bad'; $('p-nhs').classList.add('invalid'); }
    else if (!C.nhsValid(raw)) { hn.textContent = 'Check digit does not match — re-check'; hn.className = 'field-hint hint-bad'; $('p-nhs').classList.add('invalid'); }
    else { hn.textContent = 'Valid NHS number'; hn.className = 'field-hint hint-ok'; }
    return p;
  }

  Object.keys(P_FIELDS).forEach(function (k) {
    var el = $(P_FIELDS[k]);
    el.addEventListener('input', function () { el.classList.remove('needs-entry'); validatePatient(); invalidateOutputs(); });
  });
  $('p-nhs').addEventListener('blur', function () {
    var d = C.nhsDigits(this.value);
    if (d.length === 10) this.value = C.nhsFormat(d);
  });
  $('p-dob').addEventListener('blur', function () {
    var p = C.parseDate(this.value);
    if (p) { this.value = C.formatDate(p); validatePatient(); }
  });

  function clearPatient() {
    Object.keys(P_FIELDS).forEach(function (k) { $(P_FIELDS[k]).value = ''; $(P_FIELDS[k]).classList.remove('needs-entry', 'invalid'); });
    $('paste').value = '';
    $('parse-msg').textContent = 'Pasting reads the details automatically. Check every box below.';
    setSex('');
    validatePatient();
  }

  /* A new paste is a new patient: every box is replaced, never merged,
     so details from two patients can't end up on one form. */
  function readPaste() {
    var text = $('paste').value;
    if (!text.trim()) return;
    var r = C.parsePatient(text);
    $('p-surname').value = r.surname;
    $('p-forenames').value = r.forenames;
    $('p-dob').value = r.dob;
    $('p-nhs').value = r.nhs ? C.nhsFormat(r.nhs) : '';
    $('p-mrn').value = r.mrn;
    var missing = [];
    [['name', ['p-surname', 'p-forenames'], 'name'], ['dob', ['p-dob'], 'date of birth'],
     ['nhs', ['p-nhs'], 'NHS number'], ['mrn', ['p-mrn'], 'MRN']].forEach(function (x) {
      x[1].forEach(function (id) { $(id).classList.toggle('needs-entry', !r.found[x[0]]); });
      if (!r.found[x[0]]) missing.push(x[2]);
    });
    setSex(r.sex || '');
    validatePatient();
    $('parse-msg').textContent = missing.length
      ? 'Not found in the paste: ' + missing.join(', ') + '. Type these in if needed.'
      : 'All details read. Check them against the record.';
    invalidateOutputs();
  }
  $('parse-btn').addEventListener('click', readPaste);
  $('paste').addEventListener('paste', function () { setTimeout(readPaste, 0); });
  $('new-patient-btn').addEventListener('click', function () {
    clearPatient();
    pack.forEach(function (it) { it.overrides = {}; });
    renderPack();
    invalidateOutputs(true);
    $('paste').focus();
  });

  /* ════ Catalogue and status ═════════════════════════════════ */
  function loadJSON(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    });
  }

  function paintStatus(status) {
    var dot = $('st-dot'), txt = $('st-text');
    if (!catalogue.forms.length) {
      dot.className = 'st-dot st-err';
      txt.textContent = 'No forms available yet';
      return;
    }
    var when = fmtDay(catalogue.generated);
    var ok = !status || status.ok;
    dot.className = 'st-dot ' + (ok ? 'st-ok' : 'st-bad');
    txt.textContent = 'Forms checked ' + when;
    $('st-counts').textContent =
      (catalogue.counts ? catalogue.counts.rcr + ' RCR · ' + catalogue.counts.cruk + ' CRUK · ' + catalogue.counts.macmillan + ' Macmillan' : '');
    var age = (Date.now() - new Date(catalogue.generated).getTime()) / 86400000;
    var notes = [];
    if (status && !status.ok) {
      var bad = Object.keys(status.sources || {}).filter(function (k) { return !status.sources[k].ok; });
      notes.push('The last weekly update could not fully refresh: ' + bad.map(function (k) {
        var s = status.sources[k];
        return k.toUpperCase() + (s.error ? ' (' + s.error + ')' : s.failed && s.failed.length ? ' (' + s.failed.length + ' downloads failed)' : '');
      }).join('; ') + '. The previous copies are still served — check the review date on each form.');
    }
    if (age > 10) notes.push('Forms were last checked ' + Math.floor(age) + ' days ago; the weekly update may not be running.');
    $('update-notice').innerHTML = notes.length
      ? '<div class="notice notice-warn" style="margin-bottom: var(--sp-4);">' + notes.map(esc).join('<br>') + '</div>'
      : '';
  }

  /* ════ Document picker ══════════════════════════════════════ */
  function itemsFor(src) {
    if (src === 'macmillan') return catalogue.leaflets.map(function (l) { return { id: l.id, kind: 'leaflet', title: l.title, group: groupForLeaflet(l), entry: l }; });
    return catalogue.forms.filter(function (f) { return f.source === src; })
      .map(function (f) { return { id: f.id, kind: 'form', title: f.title, group: f.group, entry: f }; });
  }
  function groupForLeaflet(l) {
    var c = (l.title || '?').trim().charAt(0).toUpperCase();
    return /[A-Z]/.test(c) ? c : '0–9';
  }
  function inPack(id) { return pack.some(function (p) { return p.id === id; }); }

  function metaFor(it) {
    var e = it.entry, bits = [];
    if (it.kind === 'form') {
      if (e.review) bits.push('Review date ' + e.review);
      if (!e.fillable) bits.push('cannot be pre-filled');
      else if (e.missing && e.missing.length) bits.push('some boxes by hand');
    } else if (e.review) bits.push('Reviewed ' + e.review);
    return bits.join(' · ');
  }

  function renderDocs() {
    var host = $('doc-groups');
    var items = itemsFor(source);
    if (!items.length) {
      host.innerHTML = '<div class="state">' + (catalogue.forms.length || catalogue.leaflets.length
        ? 'Nothing from this source yet.'
        : 'No forms yet. The weekly update (GitHub Actions → “Update consent forms”) has not run.') + '</div>';
      return;
    }
    var q = $('doc-search').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    var groups = {}, order = [];
    items.forEach(function (it) {
      var hay = (it.title + ' ' + it.group).toLowerCase();
      if (q.length && !q.every(function (w) { return hay.indexOf(w) >= 0; })) return;
      if (!groups[it.group]) { groups[it.group] = []; order.push(it.group); }
      groups[it.group].push(it);
    });
    if (source === 'macmillan') order.sort();
    if (!order.length) { host.innerHTML = '<div class="state">No matches.</div>'; return; }
    var open = q.length > 0 || order.length === 1;
    host.innerHTML = order.map(function (g) {
      var list = groups[g];
      var picked = list.filter(function (it) { return inPack(it.id); }).length;
      return '<details class="doc-group"' + (open || picked ? ' open' : '') + '>' +
        '<summary>' + esc(g) + '<span class="count">' + (picked ? picked + ' / ' : '') + list.length + '</span></summary>' +
        '<div class="doc-list">' + list.map(function (it) {
          return '<label class="doc-row">' +
            '<input type="checkbox" data-pick="' + esc(it.id) + '" data-kind="' + it.kind + '"' + (inPack(it.id) ? ' checked' : '') + '>' +
            '<span><span class="doc-title">' + esc(it.title) + '</span>' +
            '<span class="doc-meta">' + esc(metaFor(it)) + '</span></span></label>';
        }).join('') + '</div></details>';
    }).join('');
  }

  $('src-toggle').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-src]');
    if (!b) return;
    source = b.dataset.src;
    Array.prototype.forEach.call(this.querySelectorAll('button'), function (x) { x.setAttribute('aria-pressed', String(x === b)); });
    renderDocs();
  });
  $('doc-search').addEventListener('input', renderDocs);
  $('doc-groups').addEventListener('change', function (e) {
    var cb = e.target.closest('input[data-pick]');
    if (!cb) return;
    if (cb.checked) addToPack(cb.dataset.pick, cb.dataset.kind); else removeFromPack(cb.dataset.pick);
  });

  function addToPack(id, kind) {
    if (inPack(id)) return;
    pack.push({ id: id, kind: kind, overrides: {} });
    renderPack(); renderDocs(); invalidateOutputs();
  }
  function removeFromPack(id) {
    pack = pack.filter(function (p) { return p.id !== id; });
    renderPack(); renderDocs(); invalidateOutputs();
  }

  /* ════ Pack and tick review ═════════════════════════════════ */
  function effectiveTicks(item) {
    var form = formById[item.id];
    var def = C.defaultTicks(form, sex, rules);
    var out = {};
    Object.keys(def).forEach(function (k) {
      var o = item.overrides.hasOwnProperty(k);
      out[k] = { on: o ? item.overrides[k] : def[k].on, why: def[k].why, action: def[k].action, changed: o && item.overrides[k] !== def[k].on };
    });
    return out;
  }

  function renderPack() {
    var host = $('pack-list');
    if (!pack.length) {
      host.innerHTML = '<div class="state">Nothing chosen yet. Pick forms and information sheets above.</div>';
      return;
    }
    host.innerHTML = pack.map(function (item) {
      if (item.kind === 'leaflet') {
        var l = leafletById[item.id];
        if (!l) return '';
        return '<div class="pack-item leaflet"><div class="pack-head"><div>' +
          '<div class="pack-title">' + esc(l.title) + '</div>' +
          '<div class="pack-sub">Macmillan information' + (l.review ? ' · reviewed ' + esc(l.review) : '') + '</div></div>' +
          '<button type="button" class="icon-btn" data-remove="' + esc(item.id) + '">Remove</button></div></div>';
      }
      var f = formById[item.id];
      if (!f) return '';
      var ticks = effectiveTicks(item);
      var nOn = 0, nReview = 0;
      (f.ticks || []).forEach(function (t) { var s = ticks[C.tickKey(t)]; if (s.on) nOn++; else if (s.action === 'review' && !s.changed) nReview++; });

      var warn = '';
      if (!f.fillable) warn = '<div class="notice notice-warn" style="margin-top:var(--sp-3);">This form could not be made fillable. It will be included as published — complete it by hand.</div>';
      else if (f.missing && f.missing.length) warn = '<div class="notice notice-warn" style="margin-top:var(--sp-3);">Complete by hand: ' + esc(f.missing.map(missingName).join(', ')) + ' (no box found on this form).</div>';

      var sugg = (f.suggest || []).map(function (id) { return leafletById[id]; }).filter(Boolean);
      var suggHtml = sugg.length
        ? '<div class="chip-row"><span class="small">Suggested information:</span>' + sugg.map(function (l) {
            var on = inPack(l.id);
            return '<button type="button" class="chip-btn" data-suggest="' + esc(l.id) + '" aria-pressed="' + on + '">' +
              (on ? '✓ ' : '+ ') + esc(l.title) + '</button>';
          }).join('') + '</div>'
        : '';

      var tickHtml = '';
      if (f.ticks && f.ticks.length) {
        tickHtml = '<details class="ticks"' + (item.ticksOpen ? ' open' : '') + ' data-ticks="' + esc(item.id) + '">' +
          '<summary>Tick boxes — ' + nOn + ' pre-ticked' + (nReview ? ', ' + nReview + ' to review' : '') + ' of ' + f.ticks.length + '</summary>' +
          '<div class="tick-body">' +
          (function () {
            var last = null;
            return f.ticks.map(function (t) {
              var k = C.tickKey(t), s = ticks[k];
              // a small heading whenever the part of the form changes, so long lists stay readable
              var sec = (t.section || '').split(' | ')[0];
              var head = '';
              var key = t.page + '|' + sec;
              if (sec && key !== last) head = '<div class="tick-sec">Page ' + (t.page + 1) + ' \u00b7 ' + esc(sec) + '</div>';
              last = key;
              return head + '<label class="tick-row' + (s.changed ? ' changed' : '') + '">' +
              '<input type="checkbox" data-form="' + esc(item.id) + '" data-key="' + esc(k) + '"' +
                (t.group ? ' data-group="' + esc(t.group) + '"' : '') + (s.on ? ' checked' : '') + '>' +
              '<span class="tick-text">' + esc(C.tickLabel(t)) +
              '<span class="tick-why">Page ' + (t.page + 1) + ' · ' + esc(s.why) + '</span></span></label>';
            }).join('');
          })() +
          '<div class="tick-actions">' +
            '<button type="button" data-tick-all="' + esc(item.id) + '">Tick all still to review</button>' +
            '<button type="button" data-tick-reset="' + esc(item.id) + '">Back to suggested</button>' +
          '</div></div></details>';
      } else if (f.fillable) {
        tickHtml = '<div class="small" style="margin-top:var(--sp-2);">No tick boxes found on this form.</div>';
      }

      return '<div class="pack-item"><div class="pack-head"><div>' +
        '<div class="pack-title">' + esc(f.title) + '</div>' +
        '<div class="pack-sub">' + (f.source === 'rcr' ? 'RCR radiotherapy consent' : 'CRUK SACT consent') +
          ' · ' + esc(f.group) + (f.review ? ' · review date ' + esc(f.review) : '') + '</div></div>' +
        '<button type="button" class="icon-btn" data-remove="' + esc(item.id) + '">Remove</button></div>' +
        warn + suggHtml + tickHtml + '</div>';
    }).join('');
  }

  function missingName(m) {
    return ({ 'patient_name|surname': 'patient name', dob: 'date of birth', 'nhs|identifier': 'NHS number', hospital: 'hospital', clin_name: 'clinician name' })[m] || m;
  }

  function packItem(id) { return pack.filter(function (p) { return p.id === id; })[0]; }

  $('pack-list').addEventListener('click', function (e) {
    var b;
    if ((b = e.target.closest('[data-remove]'))) { removeFromPack(b.dataset.remove); return; }
    if ((b = e.target.closest('[data-suggest]'))) {
      if (inPack(b.dataset.suggest)) removeFromPack(b.dataset.suggest); else addToPack(b.dataset.suggest, 'leaflet');
      return;
    }
    if ((b = e.target.closest('[data-tick-all]'))) {
      var it = packItem(b.dataset.tickAll), f = formById[it.id], t0 = effectiveTicks(it);
      f.ticks.forEach(function (t) {
        var k = C.tickKey(t);
        // only plain "review" boxes: never options in a Yes/No group, never deliberate blanks
        if (!t0[k].on && t0[k].action === 'review' && !t.group && !t.matrix) it.overrides[k] = true;
      });
      it.ticksOpen = true; renderPack(); invalidateOutputs(); return;
    }
    if ((b = e.target.closest('[data-tick-reset]'))) {
      var it2 = packItem(b.dataset.tickReset);
      it2.overrides = {}; it2.ticksOpen = true; renderPack(); invalidateOutputs();
    }
  });
  $('pack-list').addEventListener('change', function (e) {
    var cb = e.target.closest('input[data-key]');
    if (!cb) return;
    var it = packItem(cb.dataset.form);
    it.overrides[cb.dataset.key] = cb.checked;
    // options in one group (Yes / No) exclude each other
    if (cb.checked && cb.dataset.group) {
      Array.prototype.forEach.call(document.querySelectorAll('input[data-form="' + cb.dataset.form + '"][data-group="' + cb.dataset.group + '"]'), function (o) {
        if (o !== cb) it.overrides[o.dataset.key] = false;
      });
    }
    it.ticksOpen = true;
    renderPack();
    invalidateOutputs();
  });
  $('pack-list').addEventListener('toggle', function (e) {
    var d = e.target;
    if (d.dataset && d.dataset.ticks) { var it = packItem(d.dataset.ticks); if (it) it.ticksOpen = d.open; }
  }, true);

  /* ════ Build ════════════════════════════════════════════════ */
  function invalidateOutputs(silent) {
    if (!outputs.length) return;
    outputs.forEach(function (o) { URL.revokeObjectURL(o.url); });
    outputs = [];
    $('out-list').innerHTML = '';
    $('build-issues').innerHTML = '';
    $('zip-btn').disabled = true;
    $('build-msg').textContent = silent ? '' : 'Details changed — build the pack again.';
  }

  function getPdf(file) {
    if (pdfCache[file]) return Promise.resolve(pdfCache[file]);
    return fetch(DATA + file).then(function (r) {
      if (!r.ok) throw new Error('could not load ' + file + ' (' + r.status + ')');
      return r.arrayBuffer();
    }).then(function (b) { pdfCache[file] = b; return b; });
  }

  function checksBeforeBuild(p, c) {
    var errors = [], warnings = [];
    if (!p.surname && !p.forenames) errors.push('Patient name is missing.');
    if (!C.parseDate(p.dob)) errors.push('Date of birth is missing or not a valid date.');
    if (!p.nhs && !p.mrn) errors.push('Enter an NHS number or MRN.');
    if (p.nhs && !C.nhsValid(p.nhs)) warnings.push('The NHS number fails its check digit.');
    if (!c.name) errors.push('Clinician name is missing.');
    if (!c.site) warnings.push('Treating hospital / site is blank.');
    if (!pack.length) errors.push('Choose at least one form or information sheet.');
    var needSex = pack.some(function (it) {
      if (it.kind !== 'form') return false;
      var d = C.defaultTicks(formById[it.id], '', rules);
      return Object.keys(d).some(function (k) { return /choose the patient/i.test(d[k].why); });
    });
    if (!p.sex && needSex) warnings.push('Sex is not set, so sex-specific tick boxes are left blank.');
    return { errors: errors, warnings: warnings };
  }

  function fileBase(p) {
    return C.safeFileName(p.mrn || (p.surname ? p.surname.toUpperCase() : 'patient'));
  }

  function build() {
    var p = validatePatient(), c = clinician();
    var chk = checksBeforeBuild(p, c);
    $('build-issues').innerHTML = (chk.errors.length || chk.warnings.length)
      ? '<div class="notice ' + (chk.errors.length ? 'notice-warn' : 'notice-info') + '" style="margin-top:var(--sp-3);">' +
        chk.errors.concat(chk.warnings).map(esc).join('<br>') + '</div>'
      : '';
    if (chk.errors.length) { $('build-msg').textContent = 'Fix the items above first.'; return; }
    if (chk.warnings.length && !confirm(chk.warnings.join('\n') + '\n\nBuild the pack anyway?')) return;

    invalidateOutputs(true);
    $('build-btn').disabled = true;
    $('build-msg').textContent = 'Building…';
    var data = { patient: p, clinician: c };
    var base = fileBase(p);
    var results = [];

    pack.reduce(function (chain, item, idx) {
      return chain.then(function () {
        $('build-msg').textContent = 'Building ' + (idx + 1) + ' of ' + pack.length + '…';
        if (item.kind === 'leaflet') {
          var l = leafletById[item.id];
          return getPdf(l.file).then(function (buf) {
            results.push({ name: base + ' - Macmillan - ' + C.safeFileName(l.title) + '.pdf', bytes: buf, problems: [] });
          });
        }
        var f = formById[item.id];
        var label = (f.source === 'rcr' ? 'RCR consent - ' : 'CRUK consent - ') + C.safeFileName(f.title.replace(/^RCR\s+/i, ''));
        return getPdf(f.file).then(function (buf) {
          if (!f.fillable) return { bytes: buf, problems: ['Included unfilled — complete by hand.'] };
          return C.fillPdf(buf, f, data, effectiveTicks(item), window.PDFLib);
        }).then(function (r) {
          var problems = r.problems.slice();
          if (f.missing && f.missing.length) problems.push('Complete by hand: ' + f.missing.map(missingName).join(', '));
          results.push({ name: base + ' - ' + label + '.pdf', bytes: r.bytes, problems: problems });
        });
      }).catch(function (err) {
        results.push({ name: (formById[item.id] || leafletById[item.id] || {}).title || item.id, error: err.message });
      });
    }, Promise.resolve()).then(function () {
      outputs = results.filter(function (r) { return !r.error; }).map(function (r) {
        var blob = new Blob([r.bytes], { type: 'application/pdf' });
        return { name: r.name, blob: blob, url: URL.createObjectURL(blob), problems: r.problems };
      });
      $('out-list').innerHTML = outputs.map(function (o, i) {
        return '<div class="out-row"><span class="out-name">' + esc(o.name) + '</span>' +
          '<button type="button" data-open="' + i + '">Open / print</button>' +
          '<button type="button" data-dl="' + i + '">Download</button>' +
          (o.problems.length ? '<span class="out-warn">' + esc(o.problems.join(' · ')) + '</span>' : '') + '</div>';
      }).join('') + results.filter(function (r) { return r.error; }).map(function (r) {
        return '<div class="out-row"><span class="out-name">' + esc(r.name) + '</span><span class="out-warn">Failed: ' + esc(r.error) + '</span></div>';
      }).join('');
      $('zip-btn').disabled = !outputs.length;
      $('build-msg').textContent = outputs.length + ' document' + (outputs.length === 1 ? '' : 's') + ' ready. Check each one before it is signed.';
    }).then(function () { $('build-btn').disabled = false; }, function () { $('build-btn').disabled = false; });
  }

  function download(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  $('build-btn').addEventListener('click', build);
  $('out-list').addEventListener('click', function (e) {
    var b;
    if ((b = e.target.closest('[data-open]'))) window.open(outputs[+b.dataset.open].url, '_blank', 'noopener');
    else if ((b = e.target.closest('[data-dl]'))) { var o = outputs[+b.dataset.dl]; download(o.blob, o.name); }
  });
  $('zip-btn').addEventListener('click', function () {
    if (!outputs.length || !window.JSZip) return;
    var zip = new window.JSZip();
    outputs.forEach(function (o) { zip.file(o.name, o.blob); });
    zip.generateAsync({ type: 'blob' }).then(function (blob) {
      download(blob, fileBase(patient()) + ' - consent pack.zip');
    });
  });

  // Nothing about the patient should outlive the tab.
  window.addEventListener('pagehide', function () {
    outputs.forEach(function (o) { URL.revokeObjectURL(o.url); });
    Object.keys(P_FIELDS).forEach(function (k) { $(P_FIELDS[k]).value = ''; });
    $('paste').value = '';
  });

  /* ════ Init ═════════════════════════════════════════════════ */
  loadClinician();
  validatePatient();
  renderPack();

  Promise.all([
    loadJSON(DATA + 'catalogue.json').catch(function () { return null; }),
    loadJSON(DATA + 'status.json').catch(function () { return null; }),
    loadJSON('assets/json/consent-ticks.json').catch(function () { return { rules: [] }; })
  ]).then(function (res) {
    if (res[0]) catalogue = res[0];
    catalogue.forms = catalogue.forms || [];
    catalogue.leaflets = catalogue.leaflets || [];
    catalogue.forms.forEach(function (f) { formById[f.id] = f; });
    catalogue.leaflets.forEach(function (l) { leafletById[l.id] = l; });
    rules = res[2].rules || [];
    paintStatus(res[1]);
    renderDocs();
  });
});
