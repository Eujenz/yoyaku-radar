// Shared helpers for the "announcement" sources (MegaHouse, ALTER).
// These sites publish new-product announcements with a release month and price, but no preorder
// window, so their items are stored with stage: 'announced' and never counted as open preorders.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const DATA_FILE = `${ROOT}/data/items.json`;
export const UA = `YoyakuBot/0.2 (preorder deadline calendar; ${process.env.SITE_URL || 'contact via site'})`;
const DELAY_MS = Number(process.env.SCRAPE_DELAY_MS || 1200);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const jstNow = () => new Date(Date.now() + 9 * 3600e3);
export const today = () => jstNow().toISOString().slice(0, 10);
export const thisMonth = () => today().slice(0, 7);

export const decode = (s) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
export const text = (html) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// One request at a time, at least DELAY_MS apart, retried twice. 404 resolves to null.
export function makeFetcher() {
  let last = 0;
  return async function get(url) {
    for (let attempt = 1; ; attempt++) {
      const wait = last + DELAY_MS - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      try {
        const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html', 'accept-language': 'ja' }, signal: AbortSignal.timeout(30000) });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
      } catch (err) {
        if (attempt >= 3) throw new Error(`GET ${url} failed: ${err.message}`);
        await sleep(3000 * attempt);
      }
    }
  };
}

// "2027年5月下旬" -> { month: '2027-05', text: '2027年5月下旬' }
export function parseReleaseMonth(s) {
  const m = String(s || '').match(/(\d{4})年\s*(\d{1,2})月(上旬|中旬|下旬)?/);
  return m ? { month: `${m[1]}-${m[2].padStart(2, '0')}`, text: `${m[1]}年${Number(m[2])}月${m[3] || ''}` } : { month: null, text: null };
}

// "19,800円(税込)" -> 19800. When both are given ("29,480円（税抜26,800円）") the first number is the tax-included one.
export function parsePrice(s) {
  const m = String(s || '').match(/([\d,]{3,})\s*円/);
  const n = m ? Number(m[1].replace(/,/g, '')) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function loadFile() {
  try {
    return JSON.parse(await readFile(DATA_FILE, 'utf8'));
  } catch {
    return { items: [] };
  }
}
export async function loadData() {
  return (await loadFile()).items;
}

// Replace one source's items with the fresh ones, leaving every other source untouched.
// Announced items stay on the site until their release month is over, even after the
// source's listing has moved on to newer announcements.
export async function saveSource(source, fresh) {
  const file = await loadFile();
  const prev = file.items;
  const now = today();
  const freshIds = new Set(fresh.map((i) => i.id));
  const carried = prev.filter((i) => i.source === source && !freshIds.has(i.id) && i.releaseMonth && i.releaseMonth >= thisMonth());
  const others = prev.filter((i) => i.source !== source);
  const items = [...others, ...fresh, ...carried].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  await mkdir(dirname(DATA_FILE), { recursive: true });
  // updatedAt belongs to the Good Smile scrape (scripts/check.mjs uses it to catch a stalled main source),
  // so this source records its own time instead of touching it.
  const out = { updatedAt: file.updatedAt, sourceUpdatedAt: { ...file.sourceUpdatedAt, [source]: new Date().toISOString() }, items };
  await writeFile(DATA_FILE, JSON.stringify(out, null, 1) + '\n');
  console.log(`${source}: ${fresh.length} listed, ${carried.length} carried over, ${now}`);
}

export function announcedItem(fields) {
  return {
    jan: null, preorderStart: null, preorderEnd: null, preorderEndAt: null, availability: null,
    shops: [], series: null, category: null, spec: null, isRerelease: false,
    ...fields,
    stage: 'announced',
    status: 'open',
  };
}
