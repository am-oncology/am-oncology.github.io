const { JSDOM } = require('jsdom');
const fs = require('fs');

let fail = 0;
const ok = (label, cond, extra) => {
  if (!cond) fail++;
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (extra ? '   ' + extra : ''));
};

function boot(storage) {
  const dom = new JSDOM(fs.readFileSync('followup.html', 'utf8'), {
    runScripts: 'dangerously', url: 'http://localhost/', pretendToBeVisual: true
  });
  const w = dom.window;
  const store = Object.assign({}, storage);
  Object.defineProperty(w, 'localStorage', {
    configurable: true,
    value: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
    }
  });
  // gov.uk is unreachable here; exercise the fallback path.
  w.fetch = () => Promise.reject(new Error('offline'));
  w.confirm = () => true;
  w._store = store;
  w.document.dispatchEvent(new w.Event('DOMContentLoaded', { bubbles: true }));
  return { dom, w, d: w.document };
}

/* ---------- Structural ---------- */
{
  const { d } = boot();
  const ids = [...d.querySelectorAll('[id]')].map(e => e.id);
  ok('no duplicate ids', ids.filter((v, i) => ids.indexOf(v) !== i).length === 0);

  const orphans = [...d.querySelectorAll('label[for]')]
    .map(l => l.getAttribute('for')).filter(f => !d.getElementById(f));
  ok('every label[for] resolves', orphans.length === 0, orphans.join(','));

  const styleText = [...d.querySelectorAll('style')].map(s => s.textContent).join('\n');
  const hex = styleText.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  ok('no hex colours in page <style>', hex.length === 0, hex.join(','));

  const html = fs.readFileSync('followup.html', 'utf8');
  ok('no inline on* handlers', !/\son(click|change|input)=/i.test(html));
  const remoteRefs = [...d.querySelectorAll('link[href], script[src]')]
    .map(e => e.getAttribute('href') || e.getAttribute('src'))
    .filter(u => /^https?:/.test(u))
    .filter(u => !/fonts\.(googleapis|gstatic)\.com/.test(u));
  ok('no external CDN dependency beyond fonts', remoteRefs.length === 0, remoteRefs.join(','));
  ok('no <span onclick> quick tags — they are buttons',
     d.querySelectorAll('#quick-row button').length === 10);

  /* The thing AM asked for. */
  const details = d.getElementById('builder-details');
  ['#preset-row', '#quick-row', '#interval-list'].forEach(sel => {
    ok(`${sel} is outside the collapsible box`, !details.contains(d.querySelector(sel)));
  });
  ok('only the custom-add form is collapsed',
     details.contains(d.getElementById('interval-num')));
}

/* ---------- Escaping ---------- */
{
  const { w, d } = boot();
  const NASTY = '<img src=x onerror=alert(1)>"\'&';
  d.getElementById('start-date').value = '2026-09-14';
  d.getElementById('interval-num').value = '4';
  d.getElementById('interval-label').value = NASTY;
  d.getElementById('add-btn').click();

  ok('interval list has no injected element',
     d.querySelectorAll('#interval-list img').length === 0);
  ok('interval list shows the label as text',
     d.getElementById('interval-list').textContent.includes('<img src=x'));
  ok('results table has no injected element',
     d.querySelectorAll('#results-inner img').length === 0);

  d.getElementById('schedule-label').value = NASTY;
  d.getElementById('schedule-label').dispatchEvent(new w.Event('input', { bubbles: true }));
  ok('schedule label is escaped in results',
     d.querySelectorAll('#results-inner img').length === 0 &&
     d.querySelector('.start-ref').textContent.includes('<img'));
}

/* ---------- CSV and ICS ---------- */
{
  const { w, d } = boot();
  let copied = null, downloaded = null;
  w.navigator.clipboard = { writeText: t => { copied = t; return Promise.resolve(); } };
  w.URL.createObjectURL = () => 'blob:x';
  w.URL.revokeObjectURL = () => {};
  const origBlob = w.Blob;
  w.Blob = function (parts, opts) { downloaded = parts.join(''); return new origBlob(parts, opts); };
  w.HTMLAnchorElement.prototype.click = function () {};

  d.getElementById('start-date').value = '2026-09-14';
  d.getElementById('interval-num').value = '4';
  d.getElementById('interval-label').value = 'Say "hello", then; go\\stop';
  d.getElementById('add-btn').click();

  d.getElementById('csv-btn').click();
  ok('CSV doubles inner quotes', /""hello""/.test(copied), copied && copied.split('\r\n')[1]);
  const parseCSVRow = (row) => {
    const out = []; let cur = '', inQ = false;
    for (let i = 0; i < row.length; i++) {
      const c = row[i];
      if (inQ) {
        if (c === '"' && row[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') inQ = false;
        else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur); return out;
  };
  const row = parseCSVRow(copied.split('\r\n')[1]);
  ok('CSV row parses back to 7 fields', row.length === 7, 'got ' + row.length);
  ok('CSV round-trips the label exactly',
     row[1] === 'Say "hello", then; go\\stop', JSON.stringify(row[1]));

  d.getElementById('ics-btn').click();
  const unfolded = downloaded.replace(/\r\n /g, '');
  ok('ICS escapes comma and semicolon',
     unfolded.includes('SUMMARY:Say "hello"\\, then\\; go'),
     (unfolded.match(/SUMMARY:.*/) || [''])[0]);
  ok('ICS escapes backslash', unfolded.includes('go\\\\stop'));
  ok('ICS lines all within 75 octets',
     downloaded.split('\r\n').every(l => l.length <= 75),
     'longest ' + Math.max(...downloaded.split('\r\n').map(l => l.length)));
  ok('ICS has matching VEVENT begin/end',
     (downloaded.match(/BEGIN:VEVENT/g) || []).length ===
     (downloaded.match(/END:VEVENT/g) || []).length);
  ok('ICS carries no COMMENT property', !/^COMMENT:/m.test(downloaded));

  /* Folding must survive a very long label. */
  d.getElementById('interval-label').value = 'X'.repeat(300);
  d.getElementById('interval-num').value = '8';
  d.getElementById('add-btn').click();
  d.getElementById('ics-btn').click();
  ok('ICS folds a 300-char label',
     downloaded.split('\r\n').every(l => l.length <= 75));
  ok('ICS unfolds back to the original label',
     downloaded.replace(/\r\n /g, '').includes('SUMMARY:' + 'X'.repeat(300)));
}

/* ---------- Non-working day handling ---------- */
{
  const { w, d } = boot();
  // 2026-08-31 is the summer bank holiday (Monday) in the fallback table.
  // Start 2026-08-24, +1 week lands exactly on it.
  const setup = (action) => {
    d.getElementById('nonwork-action').value = action;
    d.getElementById('start-date').value = '2026-08-24';
    d.getElementById('clear-btn').click();
    d.getElementById('interval-num').value = '1';
    d.getElementById('interval-unit').value = 'w';
    d.getElementById('interval-label').value = '';
    d.getElementById('add-btn').click();
    return d.querySelector('.result-date-main').textContent;
  };
  ok('bank holiday flagged when "flag only"', setup('flag') === '31 Aug 2026',
     'got ' + setup('flag'));
  ok('bank holiday moved forward to Tue 1 Sept', setup('next') === '1 Sept 2026',
     'got ' + setup('next'));
  ok('bank holiday moved back to Fri 28 Aug', setup('prev') === '28 Aug 2026',
     'got ' + setup('prev'));

  // Weekend: 2026-09-14 is a Monday; +5 days = Saturday 19 Sep.
  const wk = (action) => {
    d.getElementById('nonwork-action').value = action;
    d.getElementById('start-date').value = '2026-09-14';
    d.getElementById('clear-btn').click();
    d.getElementById('interval-num').value = '5';
    d.getElementById('interval-unit').value = 'd';
    d.getElementById('add-btn').click();
    return d.querySelector('.result-date-main').textContent;
  };
  ok('weekend flagged when "flag only"', wk('flag') === '19 Sept 2026', 'got ' + wk('flag'));
  ok('weekend now moves forward to Mon 21 Sept (was left on Saturday)',
     wk('next') === '21 Sept 2026', 'got ' + wk('next'));
  ok('weekend moves back to Fri 18 Sept', wk('prev') === '18 Sept 2026', 'got ' + wk('prev'));
}

/* ---------- Table and exports agree ---------- */
{
  const { w, d } = boot();
  let copied = null;
  w.navigator.clipboard = { writeText: t => { copied = t; return Promise.resolve(); } };
  d.getElementById('start-date').value = '2026-09-14';
  d.getElementById('nonwork-action').value = 'next';
  d.getElementById('pref-day').value = '3';
  d.querySelector('[data-preset="anal1"]').click();

  const tableDates = [...d.querySelectorAll('.result-date-main')].map(e => e.textContent);
  d.getElementById('copy-btn').click();
  const missing = tableDates.filter(x => !copied.includes(x));
  ok('every table date appears in the text export', missing.length === 0, missing.join(','));
  ok('preset produced 23 rows', tableDates.length === 23, 'got ' + tableDates.length);
  ok('no date lands on a weekend under "move to next"',
     [...d.querySelectorAll('.result-day-name')]
       .every(e => !/Saturday|Sunday/.test(e.textContent)));
}

/* ---------- Persistence ---------- */
{
  const { w, d } = boot();
  d.getElementById('start-date').value = '2026-09-14';
  d.getElementById('schedule-label').value = 'SECRET REF';
  d.getElementById('schedule-label').dispatchEvent(new w.Event('input', { bubbles: true }));
  d.querySelector('[data-preset="rectal"]').click();
  const saved = w._store['cot-followup'];
  ok('state is persisted', !!saved);
  ok('schedule label is NOT persisted', !/SECRET REF/.test(saved));
  ok('intervals are persisted', JSON.parse(saved).intervals.length === 4);

  // Legacy v2 key migrates.
  const legacy = JSON.stringify({
    v: 2, startDate: '2026-01-05', prefDay: '2', bhAction: 'prev',
    intervals: [{ n: 6, u: 'w', label: 'old', prefDay: 0 }]
  });
  const b2 = boot({ cxb_schedule: legacy });
  ok('legacy cxb_schedule migrates', b2.d.getElementById('start-date').value === '2026-01-05');
  ok('legacy bhAction maps to nonWork',
     b2.d.getElementById('nonwork-action').value === 'prev');
  ok('legacy key is removed after migration', !b2.w._store['cxb_schedule']);
}

/* ---------- Robustness ---------- */
{
  const { d } = boot();
  d.getElementById('start-date').value = '';
  d.getElementById('interval-num').value = '0';
  d.getElementById('add-btn').click();
  ok('n=0 is rejected by the custom builder',
     d.getElementById('interval-count').textContent === 'none set');
  ok('empty state shown with no start date',
     /Add a start date/.test(d.getElementById('results-inner').textContent));
  d.getElementById('interval-num').value = '-5';
  d.getElementById('add-btn').click();
  ok('negative interval rejected',
     d.getElementById('interval-count').textContent === 'none set');
  setTimeout(() => {
    ok('bank holiday fallback reported',
       /built-in bank holidays/.test(d.getElementById('bh-status-text').textContent));
    console.log('\n' + (fail ? fail + ' FAILURE(S)' : 'all checks passed'));
    process.exit(fail ? 1 : 0);
  }, 50);
}
