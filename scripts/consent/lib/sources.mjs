// Lists the consent forms currently published by the RCR and CRUK.
// Both pages are plain HTML, so a single fetch + cheerio is enough.
import * as cheerio from 'cheerio';
import { fetchWithRetry, cleanText, absUrl } from './util.mjs';

export const RCR_PAGE =
  'https://www.rcr.ac.uk/our-services/management-service-delivery/national-radiotherapy-consent-forms/';
export const CRUK_PAGE =
  'https://www.cancerresearchuk.org/health-professional/treatment-and-other-post-diagnosis-issues/consent-forms-for-sact-systemic-anti-cancer-therapy';

/* Headings on both sites are sometimes real <h2>/<h3>, sometimes accordion
   buttons. Anything heading-like sets the current group; links inherit it. */
const HEADING_SEL = [
  'h1', 'h2', 'h3', 'h4', 'summary',
  '[class*="accordion" i][class*="title" i]', '[class*="accordion" i][class*="header" i]',
  '[class*="accordion" i] button', '[class*="collapsible" i][class*="title" i]',
].join(', ');

function walk($, onHeading, onLink) {
  $(`${HEADING_SEL}, a`).each((_, el) => {
    const $el = $(el);
    if (el.tagName === 'a' && !$el.is(HEADING_SEL)) { onLink($el); return; }
    const text = cleanText($el.text());
    if (!text || text.length > 90 || /^(show|hide|open|close|skip|menu|back)\b/i.test(text)) return;
    onHeading(text);
  });
}

function stripSize(t) {
  return cleanText(String(t).replace(/\((?:pdf|docx?)[^)]*\)/ig, '').replace(/\bpdf\b\s*,?\s*\d+(\.\d+)?\s*[km]b\b/ig, ''));
}

export async function listRcr() {
  const html = await fetchWithRetry(RCR_PAGE);
  const $ = cheerio.load(html);
  const out = [], seen = new Set();
  let group = null;
  walk($, (h) => { group = h; }, ($a) => {
    const href = $a.attr('href') || '';
    if (!/\.pdf(\?|#|$)/i.test(href)) return;
    const url = absUrl(href, RCR_PAGE);
    const title = stripSize($a.text());
    if (!url || seen.has(url) || !title) return;
    if (/welsh/i.test(title) || /welsh/i.test(href)) return;               // English only
    if (!/consent/i.test(title)) return;                                    // forms, not guidance
    if (/implementation|development of|summary letter|acknowledg/i.test(title)) return;
    seen.add(url);
    out.push({ title, group: cleanGroup(group) || 'Radiotherapy', url });
  });
  if (out.length < 10) throw new Error(`RCR page listed only ${out.length} forms — layout may have changed`);
  return out;
}

/* Children and young people, and haematology, are deliberately left out. */
const CRUK_EXCLUDE_GROUP =
  /leuka?emia|lymphoma|hodgkin|myeloma|myeloproliferative|mastocytosis|children|young people|\bcyp\b|guidance|faq|useful links|form updates|what'?s new|you might be interested/i;

export async function listCruk() {
  const html = await fetchWithRetry(CRUK_PAGE);
  const $ = cheerio.load(html);
  const out = [], seen = new Set();
  let group = null;
  walk($, (h) => { group = h; }, ($a) => {
    const href = $a.attr('href') || '';
    if (!/\.pdf(\?|#|$)/i.test(href) && !/\/sites\/default\/files\//i.test(href)) return;
    const url = absUrl(href, CRUK_PAGE);
    const title = stripSize($a.text());
    if (!url || seen.has(url) || !title) return;
    if (group && CRUK_EXCLUDE_GROUP.test(group)) return;
    if (/welsh/i.test(title) || /welsh/i.test(href)) return;
    if (/guidance|faq|electronic consent|remote consent|healthcare improvement/i.test(title)) return;
    seen.add(url);
    out.push({ title, group: cleanGroup(group) || 'SACT', url });
  });
  if (out.length < 50) throw new Error(`CRUK page listed only ${out.length} forms — layout may have changed`);
  return out;
}

function cleanGroup(g) {
  if (!g) return g;
  return cleanText(g.replace(/last updated.*$/i, '').replace(/^consent forms? for\s*/i, ''));
}
