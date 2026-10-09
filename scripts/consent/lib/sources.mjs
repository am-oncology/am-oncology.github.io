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

/* Walk headings and links in document order. A heading *inside* a link is the
   link's own title (the RCR page styles each download as a card with an <h4>),
   so it must not start a new group — that is how Welsh titles became groups. */
function walk($, onHeading, onLink, headingSel = HEADING_SEL) {
  $(`${headingSel}, a`).each((_, el) => {
    const $el = $(el);
    if (el.tagName === 'a') { onLink($el); return; }
    if ($el.closest('a').length || $el.find('a[href$=".pdf"]').length) return;
    const text = cleanText($el.text());
    if (!text || text.length > 90 || /^(show|hide|open|close|skip|menu|back|faqs?|supporting documents|consent form downloads|project acknowledgements|our services)\b/i.test(text)) return;
    onHeading(text);
  });
}

const WELSH = /welsh|cymraeg|ffurflen|caniat[aâ]d/i;

/* "RCR Anal Cancer Radiotherapy Consent Form" → "Anal cancer";
   "RCR Radiotherapy Consent for Brain Tumours" → "Brain tumours". */
export function cleanRcrTitle(raw) {
  let t = cleanText(raw)
    .replace(/^RCR\s+/i, '')
    .replace(/\bradiotherapy\s+consent\s+form\s*(for\s+|[:\u2013\u2014-]\s*)?/i, ' ')
    .replace(/\bradiotherapy\s+consent\s+(for\s+)?/i, ' ')
    .replace(/\s*\bconsent\s+form\b\s*/i, ' ')
    .replace(/\bradiotherapy\s+(?=cancer\b)/i, '')
    .replace(/\s+radiotherapy\s*$/i, '')
    .trim()
    .replace(/^benign skin cancer$/i, 'Benign skin conditions')
    .replace(/\s+-\s+/g, ' \u2013 ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!t) t = cleanText(raw);
  // sentence case, keeping abbreviations (SRS, SABR, EBRT) and proper nouns as printed
  t = t.split(' ').map((w, k) => {
    if (/^[A-Z0-9()\/–-]{2,}$/.test(w) || /[A-Z].*[A-Z]/.test(w.slice(1))) return w;
    return k === 0 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase();
  }).join(' ');
  return t;
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
    const sourceTitle = stripSize($a.text());
    if (!url || seen.has(url) || !sourceTitle) return;
    if (WELSH.test(sourceTitle) || WELSH.test(href) || WELSH.test(group || '')) return; // English only
    if (!/consent/i.test(sourceTitle)) return;                                         // forms, not guidance
    if (/implementation|development of|summary letter|acknowledg/i.test(sourceTitle)) return;
    seen.add(url);
    out.push({ title: cleanRcrTitle(sourceTitle), sourceTitle, group: cleanGroup(group) || 'Radiotherapy', url });
  }, 'h2, h3');
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
    if (group && (CRUK_EXCLUDE_GROUP.test(group) || /\?\s*$/.test(group))) return; // FAQ answers link to guidance
    if (WELSH.test(title) || WELSH.test(href)) return;
    if (/guidance|faq|electronic consent|remote consent|healthcare improvement|this document|^here$|download/i.test(title)) return;
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
