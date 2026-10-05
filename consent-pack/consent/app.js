/* Consent pack: user interface. All processing happens in this tab. */
(function () {
  'use strict';
  const E = window.ConsentEngine;
  const pdfjsLib = window.pdfjsLib;
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  const SFD = new URL('vendor/standard_fonts/', location.href).href;

  const $ = s => document.querySelector(s);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  };

  /* ---------------- settings kept on this computer (never patient data) ---------------- */
  const KEY = { prefs: 'cpack.prefs', clin: 'cpack.clinician', presets: 'cpack.presets', active: 'cpack.activePreset', bundles: 'cpack.bundles', overrides: 'cpack.overrides' };
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage may be disabled */ } }
  };
  const prefs = Object.assign({ surnameCaps: true, fillDate: false, showWelsh: false }, store.get(KEY.prefs, {}));

  const SOURCES = {
    rcr: { tag: 'RCR', name: 'RCR radiotherapy' },
    cruk: { tag: 'CRUK', name: 'CRUK SACT' },
    macmillan: { tag: 'Macmillan', name: 'Macmillan leaflet' },
    custom: { tag: 'Local', name: 'Local form' },
    upload: { tag: 'Added', name: 'Added from this computer' }
  };
  const ORDER = { rcr: 0, cruk: 1, custom: 2, upload: 3, macmillan: 4 };

  const state = {
    items: [], byId: new Map(), filter: 'all', query: '',
    pack: [], uploads: new Map(), bytesCache: new Map(),
    patientWarnings: [], docs: [], printUrl: null, building: false
  };

  /* ---------------- toast ---------------- */
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
  }

  /* ================================================================== */
  /* Patient                                                            */
  /* ================================================================== */
  const pf = { surname: $('#p-surname'), forenames: $('#p-forenames'), dob: $('#p-dob'), nhs: $('#p-nhs'), mrn: $('#p-mrn') };

  function tidyName(s) {
    s = (s || '').trim();
    return (s && (s === s.toUpperCase() || s === s.toLowerCase())) ? E.titleCase(s) : s;
  }

  function patientNow() {
    const dob = E.parseDate(pf.dob.value.trim());
    return {
      surname: pf.surname.value.trim(),
      forenames: pf.forenames.value.trim(),
      dob: dob || null,
      dobText: pf.dob.value.trim(),
      nhs: pf.nhs.value.replace(/\D/g, ''),
      mrn: pf.mrn.value.trim(),
      sex: ''
    };
  }

  function fieldWarnings(p) {
    const w = [];
    if (!p.surname) w.push('Surname is missing.');
    if (!p.dobText) w.push('Date of birth is missing.');
    else if (!p.dob) w.push(`Date of birth "${p.dobText}" isn't a date I can read. Use DD/MM/YYYY.`);
    else if (new Date(p.dob.y, p.dob.m - 1, p.dob.d) > new Date()) w.push('Date of birth is in the future.');
    if (!p.nhs) w.push('NHS number is missing.');
    else if (p.nhs.length !== 10) w.push('NHS number should have 10 digits.');
    else if (!E.nhsValid(p.nhs)) w.push(`NHS number ${E.formatNhs(p.nhs)} fails the check-digit test. Check it was copied correctly.`);
    return w;
  }

  function renderPatient() {
    const p = patientNow();
    const any = p.surname || p.forenames || p.dobText || p.nhs || p.mrn;
    const sticker = $('#sticker');
    sticker.classList.toggle('is-empty', !any);
    const sur = prefs.surnameCaps ? p.surname.toUpperCase() : p.surname;
    if (!any) {
      $('#sticker-name').textContent = 'No patient yet';
      $('#sticker-line1').textContent = 'Paste details above or type them below';
      $('#sticker-line2').textContent = '';
    } else {
      $('#sticker-name').textContent = [sur, p.forenames].filter(Boolean).join(', ') || '(no name)';
      $('#sticker-line1').textContent = `DOB ${p.dob ? E.formatDate(p.dob) : (p.dobText || '—')}    NHS ${p.nhs ? E.formatNhs(p.nhs) : '—'}`;
      $('#sticker-line2').textContent = `Hosp no ${p.mrn || '—'}`;
    }
    const warns = any ? [...state.patientWarnings, ...fieldWarnings(p)] : [];
    const uniq = [...new Set(warns)];
    $('#warnings').replaceChildren(...uniq.map(w => el('li', { text: w })));
    pf.nhs.classList.toggle('is-bad', !!p.nhs && !E.nhsValid(p.nhs));
    pf.dob.classList.toggle('is-bad', !!p.dobText && !p.dob);
    markStale();
  }

  let parseTimer;
  $('#paste').addEventListener('input', () => {
    clearTimeout(parseTimer);
    parseTimer = setTimeout(() => {
      const txt = $('#paste').value;
      if (!txt.trim()) { state.patientWarnings = []; renderPatient(); return; }
      const r = E.parsePatient(txt);
      pf.surname.value = prefs.surnameCaps ? r.surname.toUpperCase() : tidyName(r.surname);
      pf.forenames.value = tidyName(r.forenames);
      pf.dob.value = r.dob ? E.formatDate(r.dob) : '';
      pf.nhs.value = r.nhs ? E.formatNhs(r.nhs) : '';
      pf.mrn.value = r.mrn || '';
      // keep only the warnings that the field checks can't work out for themselves
      state.patientWarnings = r.warnings.filter(w => /Age shown|not labelled|No name found/.test(w));
      renderPatient();
    }, 120);
  });
  Object.values(pf).forEach(i => i.addEventListener('input', () => { state.patientWarnings = state.patientWarnings.filter(w => /Age shown|not labelled/.test(w)); renderPatient(); }));
  pf.nhs.addEventListener('blur', () => { const d = pf.nhs.value.replace(/\D/g, ''); if (d.length === 10) pf.nhs.value = E.formatNhs(d); });
  pf.dob.addEventListener('blur', () => { const d = E.parseDate(pf.dob.value); if (d) pf.dob.value = E.formatDate(d); renderPatient(); });

  const capsBox = $('#pref-caps');
  capsBox.checked = !!prefs.surnameCaps;
  capsBox.addEventListener('change', () => {
    prefs.surnameCaps = capsBox.checked; store.set(KEY.prefs, prefs);
    pf.surname.value = prefs.surnameCaps ? pf.surname.value.toUpperCase() : tidyName(pf.surname.value);
    renderPatient();
  });

  function clearPatient(silent) {
    $('#paste').value = '';
    Object.values(pf).forEach(i => { i.value = ''; });
    state.patientWarnings = [];
    clearReview();
    renderPatient();
    if (!silent) toast('Patient details cleared.');
  }
  $('#clear-patient').addEventListener('click', () => clearPatient());

  /* ================================================================== */
  /* Clinician and presets                                              */
  /* ================================================================== */
  const cf = { consultantName: $('#c-name'), consultantJob: $('#c-job'), hospital: $('#c-hospital'), takerName: $('#t-name'), takerJob: $('#t-job') };
  const sameBox = $('#c-same');

  function clinicianNow() {
    return {
      consultantName: cf.consultantName.value.trim(), consultantJob: cf.consultantJob.value.trim(), hospital: cf.hospital.value.trim(),
      takerSame: sameBox.checked, takerName: cf.takerName.value.trim(), takerJob: cf.takerJob.value.trim()
    };
  }
  function setClinician(c) {
    c = c || {};
    for (const k of Object.keys(cf)) cf[k].value = c[k] || '';
    sameBox.checked = c.takerSame !== false;
    $('#taker-fields').hidden = sameBox.checked;
  }
  function saveClinician() { store.set(KEY.clin, clinicianNow()); markStale(); }
  Object.values(cf).forEach(i => i.addEventListener('input', saveClinician));
  sameBox.addEventListener('change', () => { $('#taker-fields').hidden = sameBox.checked; saveClinician(); });

  function renderPresets() {
    const presets = store.get(KEY.presets, []);
    const active = store.get(KEY.active, '');
    const sel = $('#preset-select');
    sel.replaceChildren(
      el('option', { value: '', text: presets.length ? 'Choose saved details…' : 'None saved yet' }),
      ...presets.map(p => el('option', { value: p.name, text: p.name, selected: p.name === active }))
    );
    $('#preset-delete').disabled = !active;
  }
  $('#preset-select').addEventListener('change', e => {
    const p = store.get(KEY.presets, []).find(x => x.name === e.target.value);
    store.set(KEY.active, e.target.value || '');
    if (p) { setClinician(p); saveClinician(); toast(`Using "${p.name}".`); }
    renderPresets();
  });
  $('#preset-save').addEventListener('click', () => {
    const name = (prompt('Name these details (for example "Barts NHS" or "Private clinic"):', store.get(KEY.active, '')) || '').trim();
    if (!name) return;
    const presets = store.get(KEY.presets, []).filter(p => p.name !== name);
    presets.push({ name, ...clinicianNow() });
    presets.sort((a, b) => a.name.localeCompare(b.name));
    store.set(KEY.presets, presets); store.set(KEY.active, name);
    renderPresets(); toast(`Saved "${name}".`);
  });
  $('#preset-delete').addEventListener('click', () => {
    const active = store.get(KEY.active, '');
    if (!active || !confirm(`Delete the saved details "${active}"?`)) return;
    store.set(KEY.presets, store.get(KEY.presets, []).filter(p => p.name !== active));
    store.set(KEY.active, ''); renderPresets();
  });
  const dateBox = $('#pref-date');
  dateBox.checked = !!prefs.fillDate;
  dateBox.addEventListener('change', () => { prefs.fillDate = dateBox.checked; store.set(KEY.prefs, prefs); markStale(); });

  /* ================================================================== */
  /* Library                                                            */
  /* ================================================================== */
  const fmtDay = iso => { try { return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return iso; } };

  async function loadLibrary() {
    try {
      const r = await fetch('library/catalogue.json', { cache: 'no-cache' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const cat = await r.json();
      state.items = (cat.items || []).filter(i => i.file);
      state.items.forEach(i => { i._hay = `${i.title} ${i.group || ''} ${SOURCES[i.source] ? SOURCES[i.source].name : ''}`.toLowerCase(); });
      state.byId = new Map(state.items.map(i => [i.id, i]));
      const counts = {};
      state.items.forEach(i => { counts[i.source] = (counts[i.source] || 0) + 1; });
      const parts = ['rcr', 'cruk', 'macmillan', 'custom'].filter(s => counts[s]).map(s => `${SOURCES[s].tag} ${counts[s]}`);
      const failed = Object.entries(cat.sources || {}).filter(([, v]) => v && v.ok === false)
        .map(([k, v]) => `${(SOURCES[k] || { tag: k }).tag} couldn't be refreshed on the last run${v.lastSuccess ? `; using the copy from ${fmtDay(v.lastSuccess)}` : ''}.`);
      $('#library-status').textContent = state.items.length
        ? `Updated ${fmtDay(cat.generated)}. ${parts.join(', ')}.${failed.length ? ' ' + failed.join(' ') : ''}`
        : 'The library is empty.';
    } catch (e) {
      $('#library-status').textContent = 'The library could not be loaded.';
      state.items = [];
    }
    restorePack();
    renderBundles();
    renderResults();
  }

  const SYN = {
    rectal: ['rectal', 'rectum', 'colorectal', 'bowel'], rectum: ['rectal', 'rectum'], bowel: ['bowel', 'colorectal', 'rectal', 'colon'],
    colorectal: ['colorectal', 'bowel', 'rectal', 'colon'], colon: ['colon', 'colorectal', 'bowel'],
    brain: ['brain', 'cns', 'glioma'], cns: ['cns', 'brain'], glioma: ['glioma', 'brain', 'cns'], gbm: ['brain', 'cns', 'glioblastoma'],
    oesophageal: ['oesophag', 'esophag'], oesophagus: ['oesophag'], gastric: ['gastric', 'oesophago', 'stomach'], stomach: ['stomach', 'gastric'],
    anal: ['anal', 'anus'], lung: ['lung'], hn: ['head and neck'], pancreas: ['pancrea', 'hpb'], pancreatic: ['pancrea', 'hpb'],
    liver: ['liver', 'hpb', 'hepat'], biliary: ['biliary', 'hpb'], gynae: ['gynae'], cervix: ['cervi', 'gynae'], cervical: ['cervi', 'gynae'],
    womb: ['womb', 'endometri', 'gynae'], skin: ['skin', 'melanoma'], rt: ['radiotherapy'], chemo: ['chemotherapy', 'sact'],
    chemotherapy: ['chemotherapy', 'sact'], crt: ['radiotherapy'], chemoradiotherapy: ['radiotherapy'],
    capox: ['capox', 'xelox'], xelox: ['xelox', 'capox'], tmz: ['temozolomide'], cape: ['capecitabine'], '5fu': ['fluorouracil'],
    '5-fu': ['fluorouracil'], srs: ['stereotactic', 'srs'], srt: ['stereotactic', 'srt'], sabr: ['sabr', 'stereotactic'], sbrt: ['sabr', 'stereotactic'],
    pcv: ['pcv', 'procarbazine'], hdr: ['high dose rate', 'hdr'], ldr: ['low dose rate', 'ldr']
  };

  function matchItems(q) {
    const toks = q.toLowerCase().split(/[\s,+]+/).filter(t => t.length > 1);
    if (!toks.length) return null;
    const out = [];
    for (const it of state.items) {
      if (!visible(it)) continue;
      let score = 0, ok = true;
      const title = it.title.toLowerCase();
      for (const t of toks) {
        const alts = SYN[t] || [t];
        let s = 0;
        for (const a of alts) {
          if (new RegExp(`(^|[^a-z])${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(title)) s = Math.max(s, 3);
          else if (title.includes(a)) s = Math.max(s, 2);
          else if (it._hay.includes(a)) s = Math.max(s, 1);
        }
        if (!s) { ok = false; break; }
        score += s;
      }
      if (ok) out.push({ it, score });
    }
    out.sort((a, b) => b.score - a.score || ORDER[a.it.source] - ORDER[b.it.source] || a.it.title.localeCompare(b.it.title));
    return out.map(o => o.it);
  }

  function visible(it) {
    if (state.filter !== 'all' && it.source !== state.filter) return false;
    if (it.lang === 'cy' && !prefs.showWelsh) return false;
    return true;
  }

  const inPack = id => state.pack.some(p => p.id === id);

  function resultRow(it) {
    const on = inPack(it.id);
    return el('button', {
      type: 'button', class: 'result', 'data-id': it.id, 'aria-pressed': on ? 'true' : 'false',
      onclick: () => { togglePack(it); }
    },
    el('span', { class: `tag tag-${it.source}`, text: SOURCES[it.source].tag }),
    el('span', null,
      el('span', { class: 'result-title' }, it.title, it.lang === 'cy' ? el('span', { class: 'tag tag-welsh', text: 'Welsh' }) : null),
      it.group ? el('span', { class: 'result-group', text: it.group }) : null),
    el('span', { class: 'result-action', text: on ? 'Added ✓' : 'Add' }));
  }

  function refreshResultStates() {
    document.querySelectorAll('#results .result').forEach(b => {
      const on = inPack(b.dataset.id);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.querySelector('.result-action').textContent = on ? 'Added ✓' : 'Add';
    });
  }

  const openGroups = new Set();
  function renderResults() {
    const box = $('#results');
    if (!state.items.length) {
      box.replaceChildren(el('p', { class: 'empty' },
        'No forms in the library yet. In GitHub, open Actions, choose "Update consent library" and press "Run workflow". You can still add PDFs from this computer below.'));
      return;
    }
    const found = matchItems(state.query);
    if (found) {
      if (!found.length) { box.replaceChildren(el('p', { class: 'empty', text: `Nothing matches "${state.query}". Try a drug or tumour site, e.g. "capecitabine" or "rectal".` })); return; }
      box.replaceChildren(...found.slice(0, 150).map(resultRow));
      return;
    }
    // Browse: source → group
    const groups = new Map();
    for (const it of state.items) {
      if (!visible(it)) continue;
      const k = `${it.source}||${it.group || 'Other'}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(it);
    }
    const keys = [...groups.keys()].sort((a, b) => {
      const [sa, ga] = a.split('||'), [sb, gb] = b.split('||');
      return ORDER[sa] - ORDER[sb] || ga.localeCompare(gb);
    });
    box.replaceChildren(...keys.map(k => {
      const [src, g] = k.split('||');
      const list = groups.get(k).sort((a, b) => a.title.localeCompare(b.title));
      const det = el('details', { class: 'browse-group', open: openGroups.has(k) },
        el('summary', null, el('span', null, el('span', { class: `tag tag-${src}`, text: SOURCES[src].tag }), ' ', g), el('span', { class: 'count', text: String(list.length) })));
      if (openGroups.has(k)) det.append(...list.map(resultRow));
      det.addEventListener('toggle', () => {
        if (det.open) { openGroups.add(k); if (det.children.length === 1) det.append(...list.map(resultRow)); }
        else openGroups.delete(k);
      });
      return det;
    }));
  }

  let searchTimer;
  $('#search').addEventListener('input', e => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.query = e.target.value.trim(); renderResults(); }, 80); });
  document.querySelectorAll('.filter').forEach(b => b.addEventListener('click', () => {
    state.filter = b.dataset.filter;
    document.querySelectorAll('.filter').forEach(x => { const on = x === b; x.classList.toggle('is-on', on); x.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    renderResults();
  }));
  const welshBox = $('#pref-welsh');
  welshBox.checked = !!prefs.showWelsh;
  welshBox.addEventListener('change', () => { prefs.showWelsh = welshBox.checked; store.set(KEY.prefs, prefs); renderResults(); });

  /* ================================================================== */
  /* Pack                                                               */
  /* ================================================================== */
  function addToPack(it, quiet) {
    if (inPack(it.id)) return false;
    if (it.source === 'macmillan') state.pack.push(it);
    else {
      const firstLeaflet = state.pack.findIndex(p => p.source === 'macmillan');
      if (firstLeaflet === -1) state.pack.push(it); else state.pack.splice(firstLeaflet, 0, it);
    }
    if (!quiet) afterPackChange();
    return true;
  }
  function togglePack(it) {
    if (inPack(it.id)) state.pack = state.pack.filter(p => p.id !== it.id);
    else addToPack(it, true);
    afterPackChange();
  }
  function afterPackChange() {
    sessionStorage.setItem('cpack.pack', JSON.stringify(state.pack.filter(p => p.source !== 'upload').map(p => p.id)));
    renderPack(); refreshResultStates(); markStale();
  }
  function restorePack() {
    try {
      const ids = JSON.parse(sessionStorage.getItem('cpack.pack') || '[]');
      ids.forEach(id => { const it = state.byId.get(id); if (it) addToPack(it, true); });
    } catch (e) { /* ignore */ }
    renderPack();
  }

  function renderPack() {
    const list = $('#pack-list');
    $('#pack-count').textContent = state.pack.length ? `${state.pack.length} item${state.pack.length > 1 ? 's' : ''}` : '';
    if (!state.pack.length) {
      list.replaceChildren(el('li', { class: 'pack-empty' }, 'Nothing chosen yet. Search above, or pick a saved bundle.'));
    } else {
      list.replaceChildren(...state.pack.map((it, i) => el('li', null,
        el('span', { class: `tag tag-${it.source}`, text: SOURCES[it.source].tag }),
        el('span', { class: 'pi-title' }, it.title, it.group ? el('span', { class: 'pi-group', text: it.group }) : null),
        el('span', { class: 'pi-tools' },
          el('button', { type: 'button', class: 'icon-btn', title: 'Move up', 'aria-label': `Move ${it.title} up`, disabled: i === 0, onclick: () => movePack(i, -1) }, '↑'),
          el('button', { type: 'button', class: 'icon-btn', title: 'Move down', 'aria-label': `Move ${it.title} down`, disabled: i === state.pack.length - 1, onclick: () => movePack(i, 1) }, '↓'),
          el('button', { type: 'button', class: 'icon-btn', title: 'Remove', 'aria-label': `Remove ${it.title}`, onclick: () => togglePack(it) }, '×')))));
    }
    renderSuggestions();
  }
  function movePack(i, d) {
    const j = i + d; if (j < 0 || j >= state.pack.length) return;
    [state.pack[i], state.pack[j]] = [state.pack[j], state.pack[i]];
    afterPackChange();
  }
  $('#pack-clear').addEventListener('click', () => { if (state.pack.length && confirm('Remove everything from this pack?')) { state.pack = []; afterPackChange(); } });

  // Suggested Macmillan leaflets for the forms in the pack
  const STOP = new Set(('and with for the of to in an cancer cancers treatment treatments therapy consent form forms rcr radiotherapy ' +
    'chemotherapy drug drugs tablets plus your about what are side effects having external beam sact regimen ebrt information ' +
    'combined weekly oral language low high dose rate days day').split(' '));
  const SITE_EXPAND = {
    rectal: ['rectal', 'pelvic', 'bowel'], anal: ['anal', 'pelvic'], prostate: ['prostate', 'pelvic'], bladder: ['bladder', 'pelvic'],
    gynaecologic: ['pelvic', 'cervical', 'womb', 'vulval', 'vaginal'], brain: ['brain'], tumours: ['brain'], oesophageal: ['oesophageal', 'oesophagus'],
    breast: ['breast'], lung: ['lung'], skin: ['skin'], pancreatic: ['pancreatic', 'pancreas'], lymphoma: ['lymphoma'], colorectal: ['bowel', 'colon']
  };
  const sig = s => (s.toLowerCase().match(/[a-z0-9]+/g) || []).filter(t => t.length > 2 && !STOP.has(t));

  function suggestions() {
    const forms = state.pack.filter(p => p.source !== 'macmillan');
    if (!forms.length) return [];
    const have = new Set();
    for (const f of forms) for (const t of sig(`${f.title} ${f.group || ''}`)) { have.add(t); (SITE_EXPAND[t] || []).forEach(x => have.add(x)); }
    const out = [];
    for (const it of state.items) {
      if (it.source !== 'macmillan' || inPack(it.id)) continue;
      let toks = sig(it.title);
      if (!toks.length) { const last = (it.group || '').split('›').pop(); toks = sig(last || ''); }
      if (!toks.length) continue;
      const hits = toks.filter(t => have.has(t)).length;
      const acronymHit = toks.some(t => have.has(t) && new RegExp(`\\b${t.toUpperCase()}\\b`).test(it.title));
      if (hits === toks.length || acronymHit) out.push({ it, score: hits + (toks.length === 1 ? 1 : 0) });
    }
    out.sort((a, b) => b.score - a.score || a.it.title.length - b.it.title.length);
    return out.slice(0, 8).map(o => o.it);
  }
  function renderSuggestions() {
    const s = suggestions();
    const box = $('#suggestions');
    if (!s.length) { box.replaceChildren(); return; }
    box.replaceChildren(el('span', { class: 'chip-label', text: 'Suggested leaflets:' }),
      ...s.map(it => el('button', { type: 'button', class: 'suggest', title: it.group || '', onclick: () => { addToPack(it); } }, `+ ${it.title}`)));
  }

  // Files from this computer (kept in memory only)
  $('#local-file').addEventListener('change', async e => {
    for (const f of e.target.files) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') { toast(`${f.name} is not a PDF.`); continue; }
      const id = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const it = { id, source: 'upload', title: f.name.replace(/\.pdf$/i, ''), group: 'Added from this computer' };
      state.uploads.set(id, bytes);
      addToPack(it);
    }
    e.target.value = '';
  });

  /* ================================================================== */
  /* Bundles                                                            */
  /* ================================================================== */
  function renderBundles() {
    const bundles = store.get(KEY.bundles, []);
    const box = $('#bundles');
    if (!bundles.length) { box.replaceChildren(); return; }
    box.replaceChildren(el('span', { class: 'chip-label', text: 'Bundles:' }), ...bundles.map(b => el('span', { class: 'chip' },
      el('button', { type: 'button', title: `Add ${b.ids.length} items`, onclick: () => applyBundle(b) }, b.name),
      el('button', { type: 'button', class: 'chip-x', title: `Delete bundle ${b.name}`, 'aria-label': `Delete bundle ${b.name}`, onclick: () => deleteBundle(b.name) }, '×'))));
  }
  function applyBundle(b) {
    let added = 0, missing = 0;
    for (const id of b.ids) { const it = state.byId.get(id); if (!it) { missing++; continue; } if (addToPack(it, true)) added++; }
    afterPackChange();
    toast(`Added ${added} from "${b.name}".${missing ? ` ${missing} item${missing > 1 ? 's are' : ' is'} no longer in the library.` : ''}`);
  }
  function deleteBundle(name) {
    if (!confirm(`Delete the bundle "${name}"?`)) return;
    store.set(KEY.bundles, store.get(KEY.bundles, []).filter(b => b.name !== name)); renderBundles();
  }
  $('#bundle-save').addEventListener('click', () => {
    const ids = state.pack.filter(p => p.source !== 'upload').map(p => p.id);
    if (!ids.length) { toast('Add some forms first.'); return; }
    const name = (prompt('Name this bundle (for example "Rectal long-course CRT"):') || '').trim();
    if (!name) return;
    const bundles = store.get(KEY.bundles, []).filter(b => b.name !== name);
    bundles.push({ name, ids });
    bundles.sort((a, b) => a.name.localeCompare(b.name));
    store.set(KEY.bundles, bundles); renderBundles();
    toast(`Saved bundle "${name}".${state.pack.some(p => p.source === 'upload') ? ' Files added from this computer are not included.' : ''}`);
  });

  /* ================================================================== */
  /* Build                                                              */
  /* ================================================================== */
  async function bytesFor(it) {
    if (it.source === 'upload') return state.uploads.get(it.id);
    if (state.bytesCache.has(it.id)) return state.bytesCache.get(it.id);
    const r = await fetch(it.file, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`could not load ${it.title} (HTTP ${r.status})`);
    const b = new Uint8Array(await r.arrayBuffer());
    state.bytesCache.set(it.id, b);
    return b;
  }
  const valuesNow = () => {
    const p = patientNow();
    return E.buildValues({ ...p, dob: p.dob || p.dobText }, clinicianNow(), prefs);
  };

  function markStale() {
    if (!state.docs.length || state.building) return;
    $('#build-status').textContent = 'Details changed since the forms were filled. Press "Fill forms" again to update them.';
  }

  $('#build').addEventListener('click', build);
  async function build() {
    if (state.building) return;
    if (!state.pack.length) { toast('Choose at least one form or leaflet first.'); return; }
    const p = patientNow();
    const hasForms = state.pack.some(x => x.source !== 'macmillan');
    if (hasForms && (!p.surname || (!p.nhs && !p.mrn && !p.dob))) {
      if (!confirm('Some patient details are missing. Fill the forms anyway?')) return;
    }
    state.building = true;
    const btn = $('#build'); btn.disabled = true;
    const status = $('#build-status');
    clearReview(true);
    const values = valuesNow();
    const overrides = store.get(KEY.overrides, {});
    const docs = [];
    try {
      for (let i = 0; i < state.pack.length; i++) {
        const it = state.pack[i];
        status.textContent = `Preparing ${i + 1} of ${state.pack.length}: ${it.title}`;
        const original = await bytesFor(it);
        const doc = { it, original, analysis: null, filled: original, report: null, error: null };
        if (it.source !== 'macmillan') {
          try {
            doc.analysis = await E.analyse(original, { source: it.source === 'upload' ? 'upload' : it.source, standardFontDataUrl: SFD, overrides });
            const res = await E.fill(original, doc.analysis, values, {});
            doc.filled = res.bytes; doc.report = res.report;
          } catch (e) {
            doc.error = e.message || String(e);
          }
        }
        docs.push(doc);
      }
      state.docs = docs;
      renderReview();
      status.textContent = '';
      $('#review').hidden = false;
      $('#review').scrollIntoView({ behavior: 'smooth', block: 'start' });
      await refreshPrintPack();
    } catch (e) {
      status.textContent = `Stopped: ${e.message}`;
    } finally {
      state.building = false; btn.disabled = false;
    }
  }

  async function refill(doc) {
    const res = await E.fill(doc.original, doc.analysis, valuesNow(), {});
    doc.filled = res.bytes; doc.report = res.report;
  }

  /* ================================================================== */
  /* Review                                                             */
  /* ================================================================== */
  const KEY_LABELS = E.KEY_LABELS;
  const KEY_CHOICES = ['patient_surname', 'patient_forenames', 'patient_fullname', 'patient_dob', 'patient_nhs', 'patient_mrn', 'patient_label',
    'consultant_name', 'consultant_job', 'hospital', 'taker_name', 'taker_job', 'today', 'skip'];

  function clearReview(keepVisible) {
    state.docs = [];
    if (state.printUrl) { URL.revokeObjectURL(state.printUrl); state.printUrl = null; }
    $('#docs').replaceChildren();
    $('#open-print').disabled = true;
    if (!keepVisible) $('#review').hidden = true;
    $('#build-status').textContent = '';
  }
  $('#next-patient').addEventListener('click', () => { clearPatient(true); window.scrollTo({ top: 0, behavior: 'smooth' }); $('#paste').focus(); toast('Ready for the next patient. The pack is kept.'); });

  function summaryFor(doc) {
    if (doc.error) return { text: `Couldn't read this PDF: ${doc.error}. It's included unchanged.`, warn: true };
    if (!doc.analysis) return { text: 'Leaflet, included as it is.', warn: false };
    const filled = doc.report ? doc.report.filled.length : 0;
    const found = doc.analysis.targets.filter(t => t.key && t.key !== 'skip').length;
    if (!found) return { text: 'No places for patient details were found. Use the boxes in the PDF, or write them by hand.', warn: true };
    const extra = doc.report && doc.report.warnings.length ? ` ${doc.report.warnings.join(' ')}` : '';
    return { text: `${filled} detail${filled === 1 ? '' : 's'} filled.${extra}`, warn: !!extra };
  }

  function fileName(doc, idx) {
    const p = patientNow();
    const who = [(p.surname || 'patient').toUpperCase(), p.forenames.split(' ')[0]].filter(Boolean).join('_');
    const t = `${String(idx + 1).padStart(2, '0')} ${SOURCES[doc.it.source].tag} ${doc.it.title}`;
    return `${who}_${t}`.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '_').slice(0, 140) + '.pdf';
  }

  function renderReview() {
    const box = $('#docs');
    box.replaceChildren(...state.docs.map((doc, i) => {
      const s = summaryFor(doc);
      const body = el('div', { class: 'doc-body' });
      const showBtn = el('button', { type: 'button', class: 'btn-small' }, doc.analysis ? 'Hide pages' : 'Show pages');
      const card = el('article', { class: 'doc' },
        el('div', { class: 'doc-head' },
          el('span', { class: `tag tag-${doc.it.source}`, text: SOURCES[doc.it.source].tag }),
          el('div', null, el('div', { class: 'doc-title', text: doc.it.title }), el('div', { class: `doc-summary${s.warn ? ' is-warn' : ''}`, text: s.text })),
          el('div', { class: 'doc-actions' }, showBtn,
            el('button', { type: 'button', class: 'btn-small', onclick: () => downloadOne(doc, i) }, 'Download'))),
        body);
      doc.card = card; doc.body = body;
      let open = !!doc.analysis;
      body.hidden = !open;
      showBtn.addEventListener('click', () => {
        open = !open; body.hidden = !open; showBtn.textContent = open ? 'Hide pages' : 'Show pages';
        if (open && !body.childElementCount) renderDocBody(doc);
      });
      if (open) renderDocBody(doc);
      return card;
    }));
  }

  async function renderDocBody(doc, activeId) {
    const body = doc.body;
    const pagesBox = el('div', { class: 'pages' });
    const side = el('div');
    body.replaceChildren(pagesBox, side);
    const targets = doc.analysis ? doc.analysis.targets : [];
    const vals = valuesNow();
    const pagesWithTargets = [...new Set(targets.map(t => t.page))].sort((a, b) => a - b);
    const showAll = doc.showAll || !pagesWithTargets.length;
    let pdf;
    try {
      pdf = await pdfjsLib.getDocument({ data: doc.filled.slice(0), isEvalSupported: false, standardFontDataUrl: SFD, verbosity: 0 }).promise;
    } catch (e) { pagesBox.append(el('p', { class: 'doc-note', text: `Preview unavailable: ${e.message}` })); return; }
    const pageNums = showAll ? Array.from({ length: pdf.numPages }, (_, k) => k + 1) : pagesWithTargets;
    const boxes = new Map();
    for (const n of pageNums) {
      const page = await pdf.getPage(n);
      const cssW = Math.min(620, pagesBox.clientWidth || 620);
      const base = page.getViewport({ scale: 1 });
      const scale = cssW / base.width;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const vp = page.getViewport({ scale: scale * dpr });
      const canvas = el('canvas', { width: Math.round(vp.width), height: Math.round(vp.height), 'aria-label': `Page ${n} of ${doc.it.title}` });
      const wrap = el('div', { class: 'page-wrap' }, canvas, el('span', { class: 'page-no', text: `Page ${n}` }));
      pagesBox.append(wrap);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      const cssVp = page.getViewport({ scale });
      for (const t of targets.filter(x => x.page === n)) {
        const [x1, y1, x2, y2] = cssVp.convertToViewportRectangle([t.rect[0], t.rect[1], t.rect[0] + t.rect[2], t.rect[1] + t.rect[3]]);
        const left = Math.min(x1, x2), top = Math.min(y1, y2);
        const v = t.key && t.key !== 'skip' ? vals[t.key] : '';
        const off = t.key === 'skip' || (t.key === 'today' && !prefs.fillDate);
        const b = el('div', {
          class: `box${t.kind === 'flat' ? ' is-flat' : ''}${off ? ' is-skip' : ''}${!off && !v ? ' is-empty' : ''}`,
          title: `${t.label} → ${KEY_LABELS[t.key] || t.key}${t.kind === 'flat' ? ' (drag to move)' : ''}`
        });
        Object.assign(b.style, { left: `${left}px`, top: `${top}px`, width: `${Math.abs(x2 - x1)}px`, height: `${Math.abs(y2 - y1)}px` });
        if (t.kind === 'flat') { const g = el('span', { class: 'grip', title: 'Drag to resize' }); b.append(g); enableDrag(doc, t, b, g, scale); }
        b.addEventListener('click', () => highlight(doc, t.id));
        wrap.append(b);
        boxes.set(t.id, b);
      }
    }
    try { await pdf.destroy(); } catch (e) { /* ignore */ }
    doc.boxes = boxes;

    // Field table
    if (targets.length) {
      const rows = targets.map(t => {
        const sel = el('select', { 'aria-label': `What to write at "${t.label}" on page ${t.page}` },
          ...KEY_CHOICES.map(k => el('option', { value: k, text: KEY_LABELS[k], selected: k === t.key })));
        sel.addEventListener('change', () => changeKey(doc, t, sel.value));
        const v = t.key === 'today' && !prefs.fillDate ? '(turned off under Clinician)' : t.key && t.key !== 'skip' ? (vals[t.key] || '(no value)') : '';
        return el('tr', { 'data-id': t.id, onclick: () => highlight(doc, t.id) },
          el('td', { class: 'pg', text: String(t.page) }),
          el('td', { class: 'lbl', text: t.label }),
          el('td', null, sel, el('div', { class: 'val', text: v })));
      });
      side.append(el('table', { class: 'fields' },
        el('thead', null, el('tr', null, el('th', { text: 'Page' }), el('th', { text: 'Printed label' }), el('th', { text: 'Fill with' }))),
        el('tbody', null, rows)));
    }
    const notes = [];
    if (!showAll && pdf && pdf.numPages > pageNums.length) notes.push(el('button', { type: 'button', class: 'link', onclick: () => { doc.showAll = true; renderDocBody(doc); } }, `Show all ${pdf.numPages} pages`));
    if (showAll && pagesWithTargets.length) notes.push(el('button', { type: 'button', class: 'link', onclick: () => { doc.showAll = false; renderDocBody(doc); } }, 'Show only pages with details'));
    side.append(el('p', { class: 'doc-note' }, ...notes));
    if (activeId) highlight(doc, activeId);
  }

  function highlight(doc, id) {
    doc.card.querySelectorAll('.is-active').forEach(n => n.classList.remove('is-active'));
    const b = doc.boxes && doc.boxes.get(id);
    if (b) b.classList.add('is-active');
    const row = doc.card.querySelector(`tr[data-id="${id}"]`);
    if (row) row.classList.add('is-active');
  }

  async function applyToAll(sigKey, mutate, doneMsg) {
    const overrides = store.get(KEY.overrides, {});
    overrides[sigKey] = mutate(overrides[sigKey] || {});
    store.set(KEY.overrides, overrides);
    for (const d of state.docs) {
      if (!d.analysis) continue;
      let touched = false;
      for (const t of d.analysis.targets) if (t.sig === sigKey) { t._apply && t._apply(overrides[sigKey]); touched = true; }
      if (touched) { await refill(d); if (!d.body.hidden) await renderDocBody(d); updateSummary(d); }
    }
    await refreshPrintPack();
    if (doneMsg) toast(doneMsg);
  }
  function updateSummary(d) {
    const s = summaryFor(d); const n = d.card.querySelector('.doc-summary');
    n.textContent = s.text; n.classList.toggle('is-warn', s.warn);
  }

  function changeKey(doc, t, key) {
    const src = SOURCES[doc.it.source].tag;
    for (const d of state.docs) if (d.analysis) for (const x of d.analysis.targets) if (x.sig === t.sig) x._apply = ov => { x.key = ov.key || x.autoKey; };
    const msg = key === 'skip' ? `"${t.label}" will be left blank on ${src} forms.` : `"${t.label}" will be filled with ${KEY_LABELS[key].toLowerCase()} on ${src} forms.`;
    applyToAll(t.sig, ov => ({ ...ov, key }), msg);
  }

  function enableDrag(doc, t, box, grip, scale) {
    let start = null;
    const down = (ev, mode) => {
      ev.preventDefault(); ev.stopPropagation();
      start = { x: ev.clientX, y: ev.clientY, mode, left: parseFloat(box.style.left), top: parseFloat(box.style.top), width: parseFloat(box.style.width) };
      box.setPointerCapture(ev.pointerId);
      highlight(doc, t.id);
    };
    box.addEventListener('pointerdown', ev => { if (ev.target === grip) return; down(ev, 'move'); });
    grip.addEventListener('pointerdown', ev => down(ev, 'resize'));
    box.addEventListener('pointermove', ev => {
      if (!start) return;
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      if (start.mode === 'move') { box.style.left = `${start.left + dx}px`; box.style.top = `${start.top + dy}px`; }
      else box.style.width = `${Math.max(20, start.width + dx)}px`;
    });
    box.addEventListener('pointerup', ev => {
      if (!start) return;
      const dx = (ev.clientX - start.x) / scale, dy = -(ev.clientY - start.y) / scale, mode = start.mode;
      start = null;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      for (const d of state.docs) if (d.analysis) for (const x of d.analysis.targets) if (x.sig === t.sig && x.kind === 'flat') {
        x._apply = () => {
          if (mode === 'move') x.rect = [x.rect[0] + dx, x.rect[1] + dy, x.rect[2], x.rect[3]];
          else x.rect = [x.rect[0], x.rect[1], Math.max(20, x.rect[2] + dx), x.rect[3]];
        };
      }
      applyToAll(t.sig, ov => mode === 'move'
        ? { ...ov, dx: (ov.dx || 0) + dx, dy: (ov.dy || 0) + dy }
        : { ...ov, dw: (ov.dw || 0) + dx }, 'Position saved for forms with the same label.');
    });
  }

  /* ================================================================== */
  /* Downloads                                                          */
  /* ================================================================== */
  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  function downloadOne(doc, i) { saveBlob(new Blob([doc.filled], { type: 'application/pdf' }), fileName(doc, i)); }

  async function printPackBytes() {
    const parts = [];
    for (const d of state.docs) parts.push(d.analysis ? await E.flattenCopy(d.filled) : d.filled);
    return E.merge(parts);
  }
  async function refreshPrintPack() {
    const btn = $('#open-print');
    btn.disabled = true; btn.textContent = 'Preparing print pack…';
    try {
      const bytes = await printPackBytes();
      if (state.printUrl) URL.revokeObjectURL(state.printUrl);
      state.printUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      state.printBytes = bytes;
      btn.disabled = false; btn.textContent = 'Open print pack';
    } catch (e) {
      btn.textContent = 'Print pack unavailable';
      toast(`Couldn't combine the files: ${e.message}`);
    }
  }
  $('#open-print').addEventListener('click', () => {
    if (!state.printUrl) return;
    const w = window.open(state.printUrl, '_blank');
    if (!w) saveBlob(new Blob([state.printBytes], { type: 'application/pdf' }), packName().replace(/\.zip$/, '_print.pdf'));
  });
  function packName() {
    const p = patientNow();
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    return `${[(p.surname || 'patient').toUpperCase(), p.forenames.split(' ')[0]].filter(Boolean).join('_')}_consent_pack_${stamp}.zip`.replace(/[\\/:*?"<>|\s]+/g, '_');
  }
  $('#dl-zip').addEventListener('click', async () => {
    if (!state.docs.length) return;
    const btn = $('#dl-zip'); btn.disabled = true; btn.textContent = 'Zipping…';
    try {
      const zip = new JSZip();
      zip.file('00_Print_pack_all_documents.pdf', state.printBytes || await printPackBytes());
      state.docs.forEach((d, i) => zip.file(fileName(d, i), d.filled));
      const blob = await zip.generateAsync({ type: 'blob' });
      saveBlob(blob, packName());
    } finally { btn.disabled = false; btn.textContent = 'Download all (ZIP)'; }
  });

  /* ================================================================== */
  /* Settings export / import                                           */
  /* ================================================================== */
  $('#export-settings').addEventListener('click', () => {
    const data = { app: 'consent-pack', version: 1, presets: store.get(KEY.presets, []), clinician: store.get(KEY.clin, {}), bundles: store.get(KEY.bundles, []), overrides: store.get(KEY.overrides, {}), prefs };
    saveBlob(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }), 'consent-pack-settings.json');
  });
  $('#import-settings').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (d.app !== 'consent-pack') throw new Error('not a settings file from this tool');
      const merge = (k, incoming, keyFn) => { const cur = store.get(k, []); const m = new Map(cur.map(x => [keyFn(x), x])); (incoming || []).forEach(x => m.set(keyFn(x), x)); store.set(k, [...m.values()]); };
      merge(KEY.presets, d.presets, x => x.name);
      merge(KEY.bundles, d.bundles, x => x.name);
      store.set(KEY.overrides, Object.assign(store.get(KEY.overrides, {}), d.overrides || {}));
      if (d.clinician && !clinicianNow().consultantName) { setClinician(d.clinician); saveClinician(); }
      renderPresets(); renderBundles(); toast('Settings imported.');
    } catch (err) { toast(`Couldn't import: ${err.message}`); }
  });
  $('#reset-learned').addEventListener('click', () => {
    if (!confirm('Forget all field positions and choices you have adjusted?')) return;
    store.set(KEY.overrides, {}); toast('Adjustments cleared. Press "Fill forms" to apply.');
  });

  /* ================================================================== */
  /* Idle clear                                                         */
  /* ================================================================== */
  const IDLE_MS = 20 * 60 * 1000;
  let lastActive = Date.now();
  ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(ev => window.addEventListener(ev, () => { lastActive = Date.now(); }, { passive: true }));
  setInterval(() => {
    const p = patientNow();
    if (Date.now() - lastActive > IDLE_MS && (p.surname || p.nhs || p.dobText || $('#paste').value || state.docs.length)) {
      clearPatient(true);
      toast('Patient details were cleared after 20 minutes without use.');
    }
  }, 30000);

  /* ---------------- start ---------------- */
  setClinician(store.get(KEY.clin, {}));
  renderPresets();
  renderPatient();
  renderPack();
  loadLibrary();
})();
