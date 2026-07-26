/* ============================================================
   nav.js — shared chrome for every tool page.

   Usage, in <head> of any tool page:
     <script src="assets/js/nav.js" data-tool="followup" defer></script>

   It injects the sticky header (back link + title + theme toggle),
   restores the saved theme, and sets --accent from tools.json.
   The tool page itself never hard-codes its own name or colour.
   ============================================================ */
(function () {
  'use strict';

  var script = document.currentScript ||
    document.querySelector('script[src*="nav.js"]');
  var toolId = script && script.dataset.tool;

  /* Work out where the site root is from this script's own URL rather than
     assuming how deep the page is. nav.js always lives at assets/js/nav.js,
     so stripping that suffix gives the root — which means pages can sit at
     the root or in a subfolder without any path edits. */
  var root = '';
  if (script && script.src) {
    root = script.src.replace(/assets\/js\/nav\.js(\?.*)?$/, '');
  }
  if (script && script.dataset.root) { root = script.dataset.root; }

  var CONFIG_PATH = root + 'assets/json/tools.json';

  /* --- Theme: applied before first paint to avoid a flash ---
     Dark is the default identity now (the :root tokens ARE dark), so the
     only case needing an explicit attribute is an explicit choice of light. */
  try {
    var saved = localStorage.getItem('cot-theme');
    if (saved === 'light') { document.documentElement.dataset.theme = 'light'; }
    else if (saved === 'dark') { document.documentElement.dataset.theme = 'dark'; }
  } catch (e) { /* private browsing — default (dark) applies */ }

  function setTheme(mode) {
    document.documentElement.dataset.theme = mode;
    try { localStorage.setItem('cot-theme', mode); } catch (e) {}
    paintThemeToggle();
  }

  function currentTheme() {
    return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  }

  function paintThemeToggle() {
    var light = document.getElementById('theme-light');
    var dark  = document.getElementById('theme-dark');
    if (!light || !dark) return;
    var isDark = currentTheme() === 'dark';
    light.setAttribute('aria-pressed', String(!isDark));
    dark.setAttribute('aria-pressed', String(isDark));
  }

  var SUN_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4' +
    'M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  var MOON_ICON =
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<path d="M20.7 15.3A8.4 8.4 0 0 1 8.7 3.3a8.4 8.4 0 1 0 12 12Z"/></svg>';

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
        '<div class="theme-toggle" role="group" aria-label="Theme">' +
          '<button id="theme-light" type="button" aria-pressed="false" aria-label="Light theme">' + SUN_ICON + '</button>' +
          '<button id="theme-dark"  type="button" aria-pressed="true"  aria-label="Dark theme">'  + MOON_ICON + '</button>' +
        '</div>' +
      '</div>';
    document.body.insertBefore(header, document.body.firstChild);

    var name = tool ? tool.name : (document.title.split('|')[0].trim() || 'Tool');
    document.getElementById('nav-tool-name').textContent = name;
    if (tool && tool.accent) {
      document.documentElement.style.setProperty('--accent', tool.accent);
    }

    document.getElementById('theme-light').addEventListener('click', function () { setTheme('light'); });
    document.getElementById('theme-dark').addEventListener('click', function () { setTheme('dark'); });
    paintThemeToggle();
  }

  /* --- Smooth open/close for every <details> on the page -------------
     Native details snap open/closed with no way to transition height via
     CSS alone (the UA toggles display, not a value CSS can animate). This
     measures and animates it in JS instead, and is a no-op under
     prefers-reduced-motion because the global stylesheet forces all
     transition durations to ~0 for that media query. */
  function enhanceDetails() {
    Array.prototype.forEach.call(document.querySelectorAll('details'), function (det) {
      if (det.dataset.navEnhanced) return;
      det.dataset.navEnhanced = '1';
      var summary = det.querySelector(':scope > summary');
      if (!summary) return;

      summary.addEventListener('click', function (e) {
        e.preventDefault();
        if (det.dataset.animating === '1') return;
        det.dataset.animating = '1';
        det.style.overflow = 'hidden';
        det.style.transition = 'height 0.28s var(--ease, ease)';

        if (!det.open) {
          var startH = det.offsetHeight;
          det.open = true;
          var endH = det.scrollHeight;
          det.style.height = startH + 'px';
          requestAnimationFrame(function () {
            requestAnimationFrame(function () { det.style.height = endH + 'px'; });
          });
          onEnd(function () { cleanup(); });
        } else {
          var fromH = det.scrollHeight;
          det.style.height = fromH + 'px';
          requestAnimationFrame(function () {
            requestAnimationFrame(function () {
              det.style.height = summary.offsetHeight + 'px';
            });
          });
          onEnd(function () { det.open = false; cleanup(); });
        }
      });

      function cleanup() {
        det.style.height = '';
        det.style.overflow = '';
        det.style.transition = '';
        det.dataset.animating = '0';
      }
      function onEnd(fn) {
        det.addEventListener('transitionend', function handler(ev) {
          if (ev.propertyName !== 'height') return;
          det.removeEventListener('transitionend', handler);
          fn();
        });
      }
    });
  }

  function start() {
    enhanceDetails();
    if (!toolId) { build(null); return; }
    fetch(CONFIG_PATH)
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
