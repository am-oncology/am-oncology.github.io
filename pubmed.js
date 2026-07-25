/* ============================================================
   pubmed.js — shared NCBI E-utilities client.

   Used by the digest engine and the journal browser so that the
   fetch/parse/cite/export logic exists once rather than four times.

   NCBI allows 3 requests/sec without a key and 10/sec with one.
   requests are queued through a single throttle so that switching
   tabs quickly cannot trip a 429.
   ============================================================ */
window.PubMed = (function () {
  'use strict';

  var BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/';

  /* Put a key here (or set window.NCBI_API_KEY before this loads) to
     lift the rate limit. Note it will be public in a static site, so
     use a key you are willing to expose and can rotate. */
  var API_KEY = window.NCBI_API_KEY || '';
  var MIN_GAP = API_KEY ? 110 : 350;   // ms between requests

  var lastCall = 0;
  var chain = Promise.resolve();

  function throttled(url) {
    chain = chain.then(function () {
      var wait = Math.max(0, MIN_GAP - (Date.now() - lastCall));
      return new Promise(function (r) { setTimeout(r, wait); });
    }).then(function () {
      lastCall = Date.now();
      return fetch(url);
    }).then(function (res) {
      if (!res.ok) throw new Error('NCBI returned ' + res.status);
      return res;
    });
    return chain;
  }

  function auth() { return API_KEY ? '&api_key=' + API_KEY : ''; }

  /* HTML-escape. PubMed titles legitimately contain markup such as
     <i>BRAF</i> and <sub>2</sub>, so this must be applied at every
     point where a record touches innerHTML. */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function daysAgo(n) {
    var d = new Date();
    d.setDate(d.getDate() - Number(n));
    return d.getFullYear() + '/' +
           String(d.getMonth() + 1).padStart(2, '0') + '/' +
           String(d.getDate()).padStart(2, '0');
  }

  /* --- Search + summarise in one call --------------------- */
  /* opts: { query, days, retmax, highImpact:[journal names] }    */
  function search(opts) {
    var retmax = opts.retmax || 30;
    var url = BASE + 'esearch.fcgi?db=pubmed' +
      '&term=' + encodeURIComponent(opts.query) +
      '&sort=pub+date&retmax=' + retmax +
      '&datetype=pdat&mindate=' + daysAgo(opts.days || 90) +
      '&maxdate=3000&retmode=json' + auth();

    return throttled(url)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var ids = (data.esearchresult && data.esearchresult.idlist) || [];
        if (!ids.length) return [];
        var sumUrl = BASE + 'esummary.fcgi?db=pubmed&id=' + ids.join(',') +
                     '&retmode=json' + auth();
        return throttled(sumUrl)
          .then(function (r) { return r.json(); })
          .then(function (sum) {
            return ids.map(function (id) {
              var d = sum.result[id] || {};
              var authors = (d.authors || []).map(function (a) { return a.name; });
              var doi = (d.articleids || []).filter(function (a) { return a.idtype === 'doi'; })[0];
              var journal = d.source || '';
              return {
                pmid: id,
                doi: doi ? doi.value : '',
                title: (d.title || '').replace(/\.$/, ''),
                authorsShort: authors.slice(0, 3).join(', ') + (authors.length > 3 ? ' et al.' : ''),
                authorsFull: authors.join(', '),
                journal: journal,
                highImpact: (opts.highImpact || []).some(function (j) { return journal.indexOf(j) !== -1; }),
                date: d.pubdate || '',
                type: (d.pubtype || []).join('; '),
                abstract: null
              };
            }).filter(function (p) { return p.title; });
          });
      });
  }

  /* --- Abstract, fetched lazily on expand ----------------- */
  function abstract(pmid) {
    var url = BASE + 'efetch.fcgi?db=pubmed&id=' + pmid + '&retmode=xml' + auth();
    return throttled(url)
      .then(function (r) { return r.text(); })
      .then(function (xml) {
        var doc = new DOMParser().parseFromString(xml, 'text/xml');
        var nodes = doc.querySelectorAll('AbstractText');
        var text = Array.prototype.map.call(nodes, function (n) {
          var label = n.getAttribute('Label');
          return label ? label + ': ' + n.textContent : n.textContent;
        }).join('\n\n');
        return text || 'No abstract is included in this PubMed record.';
      });
  }

  /* --- Citation and export -------------------------------- */
  function citation(p) {
    return p.authorsFull + '. ' + p.title + '. ' + p.journal + '. ' +
           p.date + '. PMID: ' + p.pmid + (p.doi ? '. doi:' + p.doi : '') + '.';
  }

  function toCSV(papers) {
    var q = function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; };
    var rows = [['PMID', 'Title', 'Authors', 'Journal', 'Date', 'Type', 'DOI', 'URL']];
    papers.forEach(function (p) {
      rows.push([p.pmid, p.title, p.authorsFull, p.journal, p.date, p.type, p.doi,
                 'https://pubmed.ncbi.nlm.nih.gov/' + p.pmid + '/']);
    });
    return rows.map(function (r) { return r.map(q).join(','); }).join('\r\n');
  }

  function download(filename, text, mime) {
    var blob = new Blob(['\ufeff' + text], { type: (mime || 'text/csv') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  return {
    search: search, abstract: abstract, citation: citation,
    toCSV: toCSV, download: download, esc: esc, daysAgo: daysAgo
  };
})();
