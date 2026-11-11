// Health check run before every deploy. Exits non-zero (and so blocks the deploy) when the
// data or the built site looks wrong. Usage: node scripts/check.mjs [data|site]
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE } from '../site/config.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const mode = process.argv[2] || 'all';
const errors = [];
const warn = [];

if (mode === 'data' || mode === 'all') {
  const { items, updatedAt } = JSON.parse(await readFile(`${ROOT}/data/items.json`, 'utf8'));
  const open = items.filter((i) => i.status === 'open');
  if (open.length < 20) errors.push(`only ${open.length} open items`);
  const ageH = (Date.now() - Date.parse(updatedAt)) / 36e5;
  if (ageH > 36) errors.push(`data is ${ageH.toFixed(0)} hours old`);
  const ids = new Set();
  for (const i of items) {
    if (ids.has(i.id)) errors.push(`duplicate id ${i.id}`);
    ids.add(i.id);
    if (!i.name || !i.url || !i.fetchedAt) errors.push(`${i.id}: missing name, url or fetchedAt`);
    for (const k of ['preorderStart', 'preorderEnd'])
      if (i[k] && Number.isNaN(Date.parse(i[k]))) errors.push(`${i.id}: bad ${k} ${i[k]}`);
    if (i.preorderStart && i.preorderEnd && i.preorderEnd < i.preorderStart) warn.push(`${i.id}: ends before it starts`);
  }
  const rate = (k) => open.filter((i) => i[k]).length / Math.max(open.length, 1);
  if (rate('preorderEnd') < 0.35) errors.push(`only ${(rate('preorderEnd') * 100).toFixed(0)}% of open items have a deadline`);
  if (rate('priceJpy') < 0.6) errors.push(`only ${(rate('priceJpy') * 100).toFixed(0)}% of open items have a price`);
  if (rate('series') < 0.5) warn.push(`only ${(rate('series') * 100).toFixed(0)}% of open items have a series`);
  console.log(`data: ${items.length} items, ${open.length} open, deadline ${(rate('preorderEnd') * 100).toFixed(0)}%, price ${(rate('priceJpy') * 100).toFixed(0)}%, series ${(rate('series') * 100).toFixed(0)}%`);
}

if (mode === 'site' || mode === 'all') {
  const dist = `${ROOT}/dist`;
  const walk = async (dir) =>
    (await Promise.all((await readdir(dir, { withFileTypes: true })).map((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])))).flat();
  const all = await walk(dist);
  const exists = async (p) => stat(p).then((s) => s.isFile(), () => false);
  let links = 0;
  for (const file of all.filter((f) => f.endsWith('.html'))) {
    const html = await readFile(file, 'utf8');
    if (!/<title>[^<]+<\/title>/.test(html) || !/<meta name="description" content="[^"]+/.test(html)) errors.push(`${file}: missing title or description`);
    for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      try {
        JSON.parse(m[1]);
      } catch {
        errors.push(`${file}: invalid JSON-LD`);
      }
    }
    for (const m of html.matchAll(/href="([^"]+)"/g)) {
      const h = m[1].replace(/&amp;/g, '&');
      const local = h.startsWith(SITE.url) ? h.slice(SITE.url.length) : h.startsWith('/') && !h.startsWith('//') ? h.slice(SITE.base.length) : null;
      if (local === null) continue;
      links++;
      let p = decodeURI(local.split(/[?#]/)[0]) || '/';
      if (p.endsWith('/')) p += 'index.html';
      if (!(await exists(dist + p))) errors.push(`${file.slice(dist.length)}: broken link ${h}`);
    }
  }
  for (const f of ['api/preorders.json', 'api/closing-soon.json', 'api/openapi.json']) JSON.parse(await readFile(`${dist}/${f}`, 'utf8'));
  for (const f of ['llms.txt', 'llms-full.txt', 'robots.txt', 'sitemap.xml', 'feed.xml', 'closing.xml', 'calendar.ics'])
    if (!(await exists(`${dist}/${f}`))) errors.push(`missing ${f}`);
  console.log(`site: ${all.length} files, ${links} internal links checked`);
}

for (const w of warn.slice(0, 20)) console.warn(`warning: ${w}`);
if (errors.length) {
  for (const e of errors.slice(0, 40)) console.error(`ERROR: ${e}`);
  console.error(`${errors.length} error(s)`);
  process.exit(1);
}
console.log('checks passed');
