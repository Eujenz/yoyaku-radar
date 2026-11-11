// Local preview: serves dist/ under the same base path the site is built for.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE } from '../site/config.mjs';

const DIST = `${dirname(dirname(fileURLToPath(import.meta.url)))}/dist`;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8', '.ics': 'text/calendar; charset=utf-8' };
const port = Number(process.env.PORT || 4173);
createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (SITE.base && p.startsWith(SITE.base)) p = p.slice(SITE.base.length) || '/';
  if (p.endsWith('/')) p += 'index.html';
  try {
    const body = await readFile(DIST + normalize(p));
    res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404, { 'content-type': TYPES['.html'] }).end(await readFile(`${DIST}/404.html`));
  }
}).listen(port, () => console.log(`http://localhost:${port}${SITE.base}/`));
