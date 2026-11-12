// Good Smile Company (goodsmile.com) preorder scraper.
// Reads only facts the site publishes as schema.org structured data (name, JAN, price,
// preorder window) plus the series / maker rows of the spec table. No images, no descriptions.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_FILE = `${ROOT}/data/items.json`;
const BASE = 'https://www.goodsmile.com';
const UA = `YoyakuBot/0.2 (preorder deadline calendar; ${process.env.SITE_URL || 'contact via site'})`;
const DELAY_MS = Number(process.env.SCRAPE_DELAY_MS || 1200);
const REFRESH_DAYS = Number(process.env.REFRESH_DAYS || 2);
const MAX_FETCH = Number(process.env.MAX_FETCH || 500);
const KEEP_CLOSED_DAYS = 60;
const PAGE = 60;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); // JST date

let lastRequest = 0;
async function get(url) {
  for (let attempt = 1; ; attempt++) {
    const wait = lastRequest + DELAY_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'text/html', 'accept-language': 'ja' },
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (attempt >= 3) throw new Error(`GET ${url} failed: ${err.message}`);
      await sleep(3000 * attempt);
    }
  }
}

const decode = (s) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
const text = (html) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

export async function listPreorderIds() {
  const ids = new Set();
  const listing = new Map(); // id -> { thumb, bonus } as shown on the listing card
  let total = null;
  for (let offset = 0; offset < 3000; offset += PAGE) {
    const qs = new URLSearchParams({
      filter: JSON.stringify({ search_status: '1' }),
      orderBy: '1',
      limit: String(PAGE),
      offset: String(offset),
      couponId: 'null',
      searchIndex: '-1',
    });
    const html = await get(`${BASE}/ja/search/list?${qs}`);
    if (!html) break;
    const t = html.match(/search_result_total_count[^>]*>\s*(\d+)/);
    if (t) total = Number(t[1]);
    const before = ids.size;
    for (const block of html.split('<div class="p-product-list__item">').slice(1)) {
      const id = (block.match(/\/ja\/product\/(\d+)/) || [])[1];
      if (!id) continue;
      ids.add(id);
      const img = (block.match(/<img src="(\/[^"]*\/product\/image\/[^"]+)"/) || [])[1];
      listing.set(id, { thumb: img ? BASE + decode(img) : null, bonus: /特典付き/.test(block) });
    }
    if (ids.size === before) break;
    if (total !== null && offset + PAGE >= total) break;
  }
  return { ids: [...ids], total, listing };
}

export function parseProduct(html, sourceId) {
  const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((m) => {
      try {
        return JSON.parse(m[1]);
      } catch {
        return null;
      }
    })
    .find((j) => j && j['@type'] === 'Product');
  if (!ld || !ld.name) return null;
  const offer = Array.isArray(ld.offers) ? ld.offers[0] : ld.offers || {};
  const spec = {};
  for (const m of html.matchAll(
    /<dt class="b-outline-table__term">([\s\S]*?)<\/dt>\s*<dd class="b-outline-table__desc">([\s\S]*?)<\/dd>/g,
  )) {
    spec[text(m[1])] = text(m[2]);
  }
  const shops = [];
  const seen = new Set();
  for (const m of html.matchAll(/href="(https?:\/\/[^"]+)"/g)) {
    const url = decode(m[1]);
    const shop = /^https?:\/\/(www\.)?amiami\.jp\/top\/detail/.test(url)
      ? 'あみあみ'
      : /^https?:\/\/www\.animate-onlineshop\.jp\/pd\//.test(url)
        ? 'アニメイト'
        : /^https?:\/\/item\.rakuten\.co\.jp\/goodsmilestore\//.test(url)
          ? 'GOOD SMILE STORE 楽天市場店'
          : null;
    if (shop && !seen.has(shop)) {
      seen.add(shop);
      shops.push({ name: shop, url });
    }
  }
  const isDate = (d) => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null);
  const price = Number(offer.price);
  const name = decode(String(ld.name)).trim();
  const preorderEnd = isDate(offer.availabilityEnds);
  // The page also carries the exact closing time. It is stale on old rereleases, so only
  // trust it when it falls on the same day as the structured-data end date.
  const exact = [...html.matchAll(/"reservation_deadline":"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00)"/g)]
    .map((m) => m[1])
    .find((d) => preorderEnd && d.startsWith(preorderEnd));
  // e.g. 【販売：2019年02月】【再販：2027年02月】
  const releaseText = (html.match(/const releaseDate = "([^"]*)"/) || [])[1] || '';
  const months = [...releaseText.matchAll(/(販売|発売|再販)[:：]\s*(\d{4})年(\d{1,2})月/g)];
  const lastMonth = months.at(-1);
  return {
    id: `gsc-${sourceId}`,
    source: 'gsc',
    sourceId: String(sourceId),
    name,
    series: spec['作品名'] && spec['作品名'] !== 'なし' ? spec['作品名'] : null, // なし = no series
    maker: spec['メーカー'] || (ld.brand ? decode(String(ld.brand)) : null),
    seller: spec['販売元'] || null,
    category: ld.category ? decode(String(ld.category)) : null,
    spec: spec['仕様'] || null,
    jan: /^\d{8,14}$/.test(String(ld.gtin || '')) ? String(ld.gtin) : null,
    priceJpy: Number.isFinite(price) && price > 0 ? price : null,
    preorderStart: isDate(offer.availabilityStarts),
    preorderEnd,
    preorderEndAt: exact || null,
    releaseMonth: lastMonth ? `${lastMonth[2]}-${lastMonth[3].padStart(2, '0')}` : null,
    availability: String(offer.availability || '').split('/').pop() || null,
    image: typeof ld.image === 'string' && ld.image.startsWith('/') ? BASE + ld.image : null,
    isRerelease: /再販/.test(name) || months.some((m) => m[1] === '再販'),
    url: `${BASE}/ja/product/${sourceId}`,
    shops,
  };
}

async function main() {
  const now = today();
  let prev = [];
  try {
    prev = JSON.parse(await readFile(DATA_FILE, 'utf8')).items;
  } catch {}
  const byId = new Map(prev.map((i) => [i.id, i]));
  const prevActive = prev.filter((i) => i.status === 'open').length;

  const { ids, total, listing } = await listPreorderIds();
  console.log(`listing: ${ids.length} ids (site reports ${total})`);
  if (ids.length === 0) throw new Error('Listing returned no products; source layout may have changed.');
  if (prevActive >= 20 && ids.length < prevActive * 0.5)
    throw new Error(`Listing shrank from ${prevActive} to ${ids.length}; refusing to update.`);

  const listed = new Set(ids.map((id) => `gsc-${id}`));
  const ageDays = (d) => (Date.parse(now) - Date.parse(d)) / 864e5;
  const queue = ids
    .filter((id) => {
      const old = byId.get(`gsc-${id}`);
      return !old || !old.fetchedAt || ageDays(old.fetchedAt) >= REFRESH_DAYS;
    })
    .slice(0, MAX_FETCH);
  console.log(`fetching ${queue.length} product pages`);

  let ok = 0;
  let failed = 0;
  for (const sourceId of queue) {
    try {
      const html = await get(`${BASE}/ja/product/${sourceId}`);
      const item = html && parseProduct(html, sourceId);
      if (!item) {
        failed++;
        console.warn(`no structured data: ${sourceId}`);
        continue;
      }
      const old = byId.get(item.id);
      byId.set(item.id, { ...item, firstSeen: old?.firstSeen || now, fetchedAt: now });
      ok++;
    } catch (err) {
      failed++;
      console.warn(err.message);
    }
  }
  if (queue.length >= 10 && failed > queue.length * 0.3)
    throw new Error(`${failed}/${queue.length} product pages failed to parse; refusing to update.`);

  const items = [];
  for (const item of byId.values()) {
    if (item.source !== 'gsc') {
      items.push(item);
      continue;
    }
    if (listed.has(item.id)) {
      item.status = 'open';
      delete item.closedAt;
      Object.assign(item, listing.get(item.sourceId));
    } else if (item.status !== 'closed') {
      item.status = 'closed';
      item.closedAt = now;
    }
    if (item.status === 'closed' && ageDays(item.closedAt) > KEEP_CLOSED_DAYS) continue;
    items.push(item);
  }
  items.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  await mkdir(dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), items }, null, 1) + '\n');
  const open = items.filter((i) => i.status === 'open').length;
  console.log(`done: fetched ${ok}, failed ${failed}, open ${open}, total kept ${items.length}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`SCRAPE FAILED: ${err.message}`);
    process.exit(1);
  });
}
