// Shared helpers for the weekly consent-form updater.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const USER_AGENT =
  'Mozilla/5.0 (compatible; am-oncology-consent-updater/1.0; ' +
  '+https://am-oncology.github.io/consent.html)';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function slugify(s, max = 70) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\+/g, ' plus ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}

export function cleanText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* fetch with a polite UA, a timeout and a few retries. Throws an Error whose
   message carries the HTTP status so the run report says *why* a source failed
   (403 from bot protection reads very differently from a 404). */
export async function fetchWithRetry(url, { as = 'text', retries = 3, timeoutMs = 45000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-GB,en;q=0.9' },
        redirect: 'follow',
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      if (as === 'buffer') return Buffer.from(await res.arrayBuffer());
      return await res.text();
    } catch (e) {
      lastErr = e;
      if (/HTTP 4\d\d/.test(e.message) && !/HTTP 429/.test(e.message)) break; // no point retrying
      await sleep(1500 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

export async function readJSON(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

export async function writeJSON(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2) + '\n');
}

export async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

export function absUrl(href, base) {
  try { return new URL(href, base).toString(); } catch { return null; }
}

/* Make ids unique within one run without depending on list order more than
   necessary: the first holder of a slug keeps it. */
export function uniqueId(base, taken) {
  let id = base, n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  taken.add(id);
  return id;
}
