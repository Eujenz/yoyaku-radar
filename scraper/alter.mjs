// ALTER (alter-web.jp) new-product scraper.
// Reads the public product list (grouped by release month) and each upcoming product's spec table:
// series, release month, list price, size. No descriptions and no images are stored.
// The site gives no preorder window, so items are 'announced'.
import { fileURLToPath } from 'node:url';
import { makeFetcher, decode, text, today, thisMonth, parseReleaseMonth, parsePrice, loadData, saveSource, announcedItem } from './lib.mjs';

const BASE = 'https://alter-web.jp';
const REFRESH_DAYS = 7;

// The list is a sequence of <h2>year</h2>, <h1>month</h1>, then that month's <figure> cards.
export function parseListing(html) {
  const out = [];
  let year = null;
  let month = null;
  const re = /<h2 class="hl05[^"]*">(\d{4})<\/h2>|<h1 class="hl01[^"]*">(\d{1,2})<small>|<figure><a href="\/products\/(\d+)\/"><img[^>]*src="([^"]+)">([\s\S]*?)<figcaption>([\s\S]*?)<\/figcaption>/g;
  for (const m of html.matchAll(re)) {
    if (m[1]) year = Number(m[1]);
    else if (m[2]) month = Number(m[2]);
    else if (m[3] && year && month) {
      out.push({ id: m[3], thumb: BASE + decode(m[4]), name: text(m[6]), isRerelease: /再販/.test(m[5]), month: `${year}-${String(month).padStart(2, '0')}` });
    }
  }
  return out;
}

export function parseDetail(html) {
  const spec = {};
  for (const m of html.matchAll(/<th>([\s\S]*?)<\/th>\s*<td>([\s\S]*?)<\/td>/g)) spec[text(m[1]).replace(/\s+/g, '')] = text(m[2].replace(/<br\s*\/?>/g, ' / '));
  const image = (html.match(/<div class="item-mainimg">[\s\S]*?<img[^>]*src="(\/uploads\/[^"]+)"/) || [])[1];
  const release = parseReleaseMonth(spec['発売月']);
  return {
    series: spec['作品名'] && spec['作品名'] !== 'なし' ? spec['作品名'] : null,
    releaseMonth: release.month,
    releaseText: release.text,
    priceJpy: parsePrice(spec['価格']),
    spec: spec['サイズ'] || null,
    image: image ? BASE + decode(image) : null,
  };
}

async function main() {
  const get = makeFetcher();
  const now = today();
  const year = Number(now.slice(0, 4));
  const listed = new Map();
  // The default view shows the newest year; the current year is a separate view when it differs.
  for (const url of [`${BASE}/products/`, `${BASE}/products/?yy=${year}`]) {
    const html = await get(url);
    if (!html) continue;
    for (const it of parseListing(html)) if (it.month >= thisMonth()) listed.set(it.id, it);
  }
  if (listed.size === 0) throw new Error('No upcoming products parsed; the page layout may have changed.');

  const prev = new Map((await loadData()).map((i) => [i.id, i]));
  const ageDays = (d) => (Date.parse(now) - Date.parse(d)) / 864e5;
  const fresh = [];
  let failed = 0;
  for (const it of listed.values()) {
    const old = prev.get(`alter-${it.id}`);
    let detail = null;
    if (old?.fetchedAt && ageDays(old.fetchedAt) < REFRESH_DAYS) {
      detail = { series: old.series, releaseMonth: old.releaseMonth, releaseText: old.releaseText, priceJpy: old.priceJpy, spec: old.spec, image: old.image };
    } else {
      try {
        const html = await get(`${BASE}/products/${it.id}/`);
        if (html) detail = parseDetail(html);
      } catch (err) {
        console.warn(err.message);
      }
    }
    if (!detail) failed++;
    fresh.push(
      announcedItem({
        id: `alter-${it.id}`,
        source: 'alter',
        sourceId: it.id,
        name: it.name,
        maker: 'アルター',
        seller: 'アルター',
        series: detail?.series ?? null,
        spec: detail?.spec ?? null,
        priceJpy: detail?.priceJpy ?? null,
        releaseMonth: detail?.releaseMonth || it.month, // the list's month heading is the fallback
        releaseText: detail?.releaseText || null,
        thumb: it.thumb,
        image: detail?.image || it.thumb,
        isRerelease: it.isRerelease || /再販/.test(it.name),
        url: `${BASE}/products/${it.id}/`,
        firstSeen: old?.firstSeen || now,
        fetchedAt: detail && !(old?.fetchedAt && ageDays(old.fetchedAt) < REFRESH_DAYS) ? now : old?.fetchedAt || now,
      }),
    );
  }
  if (listed.size >= 10 && failed > listed.size * 0.3) throw new Error(`${failed}/${listed.size} detail pages failed; refusing to update.`);
  await saveSource('alter', fresh);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`SCRAPE FAILED (alter): ${err.message}`);
    process.exit(1);
  });
}
