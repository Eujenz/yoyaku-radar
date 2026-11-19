// MegaHouse (megahobby.jp) new-product calendar scraper.
// Reads the public "新作カレンダー" listing only: name, release month, list price, thumbnail, link.
// No descriptions and no images are stored. The site gives no preorder window, so items are 'announced'.
import { fileURLToPath } from 'node:url';
import { makeFetcher, decode, text, today, parseReleaseMonth, parsePrice, loadData, saveSource, announcedItem } from './lib.mjs';

const BASE = 'https://www.megahobby.jp';

export function parseListing(html, now = today()) {
  const out = [];
  for (const block of html.split('<div class="products').slice(1)) {
    const id = (block.match(/href="\/products\/item\/(\d+)\/?"/) || [])[1];
    const name = (block.match(/<dd class="p_name">([\s\S]*?)<\/dd>/) || [])[1];
    if (!id || !name) continue;
    const release = parseReleaseMonth((block.match(/発売日[：:]\s*<span>([^<]*)<\/span>/) || [])[1]);
    const price = parsePrice((block.match(/希望小売価格[：:]\s*<span>([^<]*)<\/span>/) || [])[1]);
    const thumb = (block.match(/<dt><img src="(\/images\/item\/[^"]+)"/) || [])[1];
    const cleanName = text(name);
    out.push(
      announcedItem({
        id: `mh-${id}`,
        source: 'mh',
        sourceId: id,
        name: cleanName,
        maker: 'メガハウス',
        seller: 'メガハウス',
        priceJpy: price,
        releaseMonth: release.month,
        releaseText: release.text,
        thumb: thumb ? BASE + decode(thumb) : null,
        image: thumb ? BASE + decode(thumb) : null,
        isRerelease: /再販/.test(cleanName),
        url: `${BASE}/products/item/${id}/`,
        firstSeen: now,
        fetchedAt: now,
      }),
    );
  }
  return out;
}

async function main() {
  const get = makeFetcher();
  const html = await get(`${BASE}/products/order_calender/`);
  if (!html) throw new Error('order_calender returned 404');
  const fresh = parseListing(html);
  if (fresh.length === 0) throw new Error('No products parsed; the page layout may have changed.');
  const prev = new Map((await loadData()).map((i) => [i.id, i]));
  for (const i of fresh) if (prev.get(i.id)?.firstSeen) i.firstSeen = prev.get(i.id).firstSeen;
  const noPrice = fresh.filter((i) => !i.priceJpy).length;
  if (fresh.length >= 10 && noPrice > fresh.length * 0.5) throw new Error(`${noPrice}/${fresh.length} items have no price; layout may have changed.`);
  await saveSource('mh', fresh);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`SCRAPE FAILED (megahouse): ${err.message}`);
    process.exit(1);
  });
}
