/* ============================================================
   nav.js — shared chrome for every tool page.

   Usage, in <head> of any tool page:
     <script src="../assets/js/nav.js" data-tool="followup" defer></script>

   It injects the sticky header (back link + title + theme toggle),
   restores the saved theme, and sets --accent from tools.json.
   The tool page itself never hard-codes its own name or colour.
   ============================================================ */
(function () {
  'use strict';

  var script = document.currentScript ||
    document.querySelector('script[src*="nav.js"]');
  var toolId = script && script.dataset.tool;
  var root = script && script.dataset.root || '../';

  /* --- Theme: applied before first paint to avoid a flash --- */
  try {
    var saved = localStorage.getItem('cot-theme');
    if (saved === 'dark' || saved === 'light') {
      document.documentElement.dataset.theme = saved;
    } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      document.documentElement.dataset.theme = 'dark';
    }
  } catch (e) { /* private browsing — fall back to light */ }

  function toggleTheme() {
    var el = document.documentElement;
    el.dataset.theme = el.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('cot-theme', el.dataset.theme); } catch (e) {}
    paintThemeBtn();
  }

  function paintThemeBtn() {
    var btn = document.getElementById('theme-btn');
    if (!btn) return;
    var dark = document.documentElement.dataset.theme === 'dark';
    btn.textContent = dark ? 'Light' : 'Dark';
    btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  }

  function build(tool) {
    var header = document.createElement('header');
    header.className = 'site-header';
    header.innerHTML =
      '<div class="site-header-inner">' +
        '<a class="back-link" href="' + root + 'index.html">' +
          '<span aria-hidden="true">&larr;</span> All tools' +
        '</a>' +
        '<div class="site-title">' +
          '<span id="nav-tool-name"></span>' +
          '<small>Clinical Oncology Tools</small>' +
        '</div>' +
        '<div class="header-spacer"></div>' +
        '<button class="theme-btn" id="theme-btn" type="button"></button>' +
      '</div>';
    document.body.insertBefore(header, document.body.firstChild);

    var name = tool ? tool.name : (document.title.split('|')[0].trim() || 'Tool');
    document.getElementById('nav-tool-name').textContent = name;
    if (tool && tool.accent) {
      document.documentElement.style.setProperty('--accent', tool.accent);
    }

    document.getElementById('theme-btn').addEventListener('click', toggleTheme);
    paintThemeBtn();
  }

  function start() {
    if (!toolId) { build(null); return; }
    fetch(root + 'tools.json')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var found = null;
        data.sections.forEach(function (s) {
          s.tools.forEach(function (t) { if (t.id === toolId) found = t; });
        });
        build(found);
      })
      .catch(function () { build(null); });   // offline / file:// — degrade quietly
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
