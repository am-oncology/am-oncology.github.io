// Macmillan treatment and drug pages, rendered to printable PDFs.
// Used with Macmillan's written permission for this tool (see README). Every PDF
// keeps Macmillan's copyright line and says it is reproduced with permission.
//
// The A–Z listing is built by JavaScript, so a real browser (Playwright) is
// needed. The sitemap is read as well and the two lists are merged, so a change
// to either one does not silently empty the leaflet library.
import { fetchWithRetry, cleanText, sha256 } from './util.mjs';

export const MAC_INDEX = 'https://www.macmillan.org.uk/cancer-information-and-support/treatments-and-drugs';
const PAGE_RE = /^https:\/\/www\.macmillan\.org\.uk\/cancer-information-and-support\/treatments-and-drugs\/[a-z0-9-]+\/?$/i;

const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 ' +
  'am-oncology-consent-updater/1.0';

export async function openBrowser() {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ userAgent: BROWSER_UA, locale: 'en-GB', viewport: { width: 1200, height: 1600 } });
  return { browser, ctx };
}

async function dismissCookies(page) {
  for (const sel of ['#onetrust-reject-all-handler', '#onetrust-accept-btn-handler',
    'button:has-text("Reject all")', 'button:has-text("Accept all")', 'button:has-text("Accept")']) {
    const b = page.locator(sel).first();
    if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); await page.waitForTimeout(400); return; }
  }
}

const norm = (u) => u.replace(/\/+$/, '').replace(/^http:/, 'https:').toLowerCase();

async function fromSitemap() {
  const urls = new Set();
  const queue = ['https://www.macmillan.org.uk/sitemap.xml'];
  let fetched = 0;
  while (queue.length && fetched < 40) {
    const sm = queue.shift();
    let xml;
    try { xml = await fetchWithRetry(sm); } catch { continue; }
    fetched++;
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
    if (/<sitemapindex/i.test(xml)) {
      // only descend into child sitemaps that could hold these pages
      for (const l of locs) if (!/fundrais|event|shop|volunteer|community|donat|news/i.test(l)) queue.push(l);
    } else {
      for (const l of locs) if (PAGE_RE.test(l)) urls.add(norm(l));
    }
  }
  return urls;
}

async function fromIndex(ctx) {
  const found = new Map();
  const page = await ctx.newPage();
  try {
    await page.goto(MAC_INDEX, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await dismissCookies(page);
    for (let round = 0; round < 60; round++) {
      const links = await page.$$eval('a[href]', (as) => as.map((a) => ({ href: a.href, text: a.textContent || '' })));
      for (const l of links) if (/treatments-and-drugs\/[a-z0-9-]+\/?$/i.test(l.href)) found.set(l.href.replace(/\/+$/, '').toLowerCase(), l.text.replace(/\s+/g, ' ').trim());
      const more = page.locator('button:has-text("Load more"), button:has-text("Show more"), a:has-text("Load more"), a[rel="next"], [aria-label*="next page" i]').first();
      if (!(await more.isVisible().catch(() => false))) break;
      await more.click().catch(() => {});
      await page.waitForTimeout(1500);
    }
  } finally { await page.close(); }
  return found;
}

export async function listMacmillan(ctx) {
  const [sm, idx] = await Promise.all([fromSitemap().catch(() => new Set()), fromIndex(ctx).catch(() => new Map())]);
  const all = new Map();
  for (const u of sm) all.set(u, '');
  for (const [u, t] of idx) if (PAGE_RE.test(u)) all.set(norm(u), t || all.get(norm(u)) || '');
  const out = [...all].map(([url, title]) => ({ url, title }));
  if (out.length < 30) throw new Error(`Found only ${out.length} Macmillan treatment pages (sitemap ${sm.size}, A–Z ${idx.size}) — site may be blocking automated access or has changed`);
  return out;
}

const PRINT_CSS = `
  @page { size: A4; }
  html, body { background: #fff !important; color: #000 !important; font-size: 11pt !important; }
  img, picture, video, iframe, form, input, select, textarea, nav, aside,
  [role="dialog"], [id*="onetrust" i], [class*="cookie" i], [class*="donat" i],
  [class*="share" i], [class*="feedback" i], [class*="newsletter" i], [class*="breadcrumb" i],
  [class*="chat" i] { display: none !important; }
  main [class*="accordion" i] [class*="content" i], main [class*="accordion" i] [class*="panel" i],
  main [class*="accordion" i] [class*="body" i], main .collapse, main [class*="collapsible" i] {
    display: block !important; height: auto !important; max-height: none !important;
    visibility: visible !important; opacity: 1 !important; overflow: visible !important; }
  a { color: #000 !important; text-decoration: none !important; }
  h1, h2, h3 { break-after: avoid; }
  p, li { orphans: 3; widows: 3; }
`;

function footer(url, retrieved) {
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<div style="font-family:Arial,sans-serif;font-size:7px;color:#333;width:100%;padding:0 14mm;display:flex;justify-content:space-between;gap:8px">
    <span>&copy; Macmillan Cancer Support. Reproduced with permission. Source: ${esc(url)} &middot; retrieved ${esc(retrieved)}</span>
    <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;
}

/* Load one page; return its text fingerprint, and a PDF when asked for one. */
export async function renderMacmillan(ctx, url, { skipIfHash = null } = {}) {
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (!resp || resp.status() >= 400) throw new Error(`HTTP ${resp ? resp.status() : 'no response'}`);
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await dismissCookies(page);
    await page.evaluate(() => {
      const main = document.querySelector('main') || document.querySelector('#content') || document.querySelector('article') || document.body;
      main.querySelectorAll('details').forEach((d) => { d.open = true; });
      main.querySelectorAll('[aria-expanded="false"]').forEach((b) => { try { b.click(); } catch (e) { /* ignore */ } });
      main.querySelectorAll('[hidden]').forEach((e) => e.removeAttribute('hidden'));
    });
    await page.waitForTimeout(600);
    const info = await page.evaluate(() => {
      const main = document.querySelector('main') || document.querySelector('#content') || document.querySelector('article') || document.body;
      const h1 = (document.querySelector('h1')?.textContent || document.title || '').trim();
      return { h1, text: main.innerText || '' };
    });
    const text = cleanText(info.text);
    if (text.length < 400) throw new Error('page content too short — possibly blocked or not a content page');
    const title = cleanText(info.h1).replace(/\s*\|\s*Macmillan.*$/i, '');
    const review = (text.match(/(?:content last reviewed|page last reviewed|last reviewed|reviewed)[:\s]*(\d{1,2}\s+[A-Za-z]+\s+\d{4}|[A-Za-z]+\s+\d{4})/i) || [])[1] || null;
    const nextReview = (text.match(/next review(?: due)?[:\s]*(\d{1,2}\s+[A-Za-z]+\s+\d{4}|[A-Za-z]+\s+\d{4})/i) || [])[1] || null;
    const result = { title, textHash: sha256(text), review, nextReview };
    if (skipIfHash && skipIfHash === result.textHash) return result; // unchanged: no new PDF

    await page.evaluate(() => {
      const main = document.querySelector('main') || document.querySelector('#content') || document.querySelector('article');
      if (main) document.body.replaceChildren(main);
    });
    await page.addStyleTag({ content: PRINT_CSS });
    await page.emulateMedia({ media: 'print' });
    const retrieved = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    result.pdf = await page.pdf({
      format: 'A4', printBackground: false, displayHeaderFooter: true,
      headerTemplate: '<span></span>', footerTemplate: footer(url, retrieved),
      margin: { top: '14mm', bottom: '18mm', left: '14mm', right: '14mm' },
    });
    return result;
  } finally { await page.close(); }
}
