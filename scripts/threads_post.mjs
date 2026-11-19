// Threads poster (PLAN 6). Run by .github/workflows/threads.yml; never needs an agent session.
//
//   node scripts/threads_post.mjs            post the approved queue entry due in the current slot, if any
//   node scripts/threads_post.mjs --refresh  refresh the long-lived token (valid 60 days, refreshable after 24 h)
//   DRY_RUN=1 node scripts/threads_post.mjs  print what would be posted, call nothing
//
// API (checked against developers.facebook.com/docs/threads on 2026-11-19):
//   1. POST /v1.0/{user-id}/threads          media_type=TEXT, text  -> { id }   (container)
//   2. wait ~30 s, POST /v1.0/{user-id}/threads_publish  creation_id -> { id }
//   GET /refresh_access_token?grant_type=th_refresh_token&access_token=...
//   Text posts: at most 500 characters, emojis count as their UTF-8 byte length. 250 API posts per 24 h.
//
// Queue entries (social/queue.json), posted only when approved is true:
//   { "id": "2026-12-01-am", "date": "2026-12-01", "slot": "am" | "pm", "type": "closing", "approved": true,
//     "text": "明後天截止的幾件：\n{{list}}", "live": "closing" | "new" | "rerelease" (optional), "link": true (optional) }
// {{list}} is filled from data/items.json at posting time; dates and prices are never written by hand.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const QUEUE = `${ROOT}/social/queue.json`;
const POSTED = `${ROOT}/social/posted.json`;
const API = 'https://graph.threads.net';
const SITE = (process.env.SITE_URL || 'https://yoyaku.fans').replace(/\/+$/, '');
const { THREADS_TOKEN: token, THREADS_USER_ID: userId } = process.env;
const DRY = process.env.DRY_RUN === '1';
const MAX_CHARS = 500;

const tw = () => new Date(Date.now() + 8 * 3600e3); // Taiwan time, as a UTC-shaped Date
const twDate = () => tw().toISOString().slice(0, 10);
const currentSlot = () => (tw().getUTCHours() < 16 ? 'am' : 'pm');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = async (f, fallback) => JSON.parse(await readFile(f, 'utf8').catch(() => JSON.stringify(fallback)));

// Threads counts an emoji as its UTF-8 byte length; everything else as one character.
export function threadsLength(text) {
  let n = 0;
  for (const ch of text) n += /\p{Extended_Pictographic}|\p{Regional_Indicator}|️|‍/u.test(ch) ? Buffer.byteLength(ch) : 1;
  return n;
}

// ---------- live data ----------
const shortName = (name) => name.replace(/^【[^】]*(?:再販|受注)】\s*/, '');
const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const yen = (n) => `¥${n.toLocaleString('en-US')}`;
const daysFrom = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

export function liveList(kind, items, today) {
  const jst = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const open = items.filter(
    (i) => i.status === 'open' && i.stage !== 'announced' && (!i.preorderEnd || i.preorderEnd >= jst) && (!i.preorderEndAt || Date.parse(i.preorderEndAt) > Date.now()),
  );
  const byPrice = (a, b) => (b.priceJpy || 0) - (a.priceJpy || 0);
  let list = [];
  if (kind === 'closing') list = open.filter((i) => i.preorderEnd && daysFrom(today, i.preorderEnd) <= 2).sort(byPrice);
  if (kind === 'new') list = open.filter((i) => i.preorderStart && daysFrom(i.preorderStart, today) <= 7).sort(byPrice);
  if (kind === 'rerelease') list = open.filter((i) => i.isRerelease && i.preorderEnd && daysFrom(today, i.preorderEnd) <= 10).sort(byPrice);
  return list.slice(0, 5).map((i) => `・${shortName(i.name)}${i.preorderEnd ? `（${md(i.preorderEnd)} 截止` : '（'}${i.priceJpy ? `，${yen(i.priceJpy)}` : ''}）`);
}

export function compose(entry, items, today) {
  let text = entry.text;
  if (entry.live) {
    const lines = liveList(entry.live, items, today);
    if (lines.length < 2) return { skip: `only ${lines.length} live item(s) for "${entry.live}"` };
    // Drop lines from the end until the post fits.
    for (let n = lines.length; n >= 2; n--) {
      text = entry.text.replace('{{list}}', lines.slice(0, n).join('\n'));
      if (threadsLength(text + (entry.link ? `\n${SITE}/week/` : '')) <= MAX_CHARS) break;
    }
  }
  if (entry.link) text += `\n${SITE}/${entry.live === 'rerelease' ? 'rerelease' : 'week'}/`;
  if (text.includes('{{')) return { skip: 'unfilled placeholder' };
  if (threadsLength(text) > MAX_CHARS) return { skip: `too long (${threadsLength(text)} > ${MAX_CHARS})` };
  return { text };
}

// ---------- API ----------
async function call(method, path, params) {
  const url = new URL(API + path);
  const init = { method, signal: AbortSignal.timeout(30000) };
  if (method === 'GET') for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  else init.body = new URLSearchParams(params);
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(`${method} ${path} -> HTTP ${res.status} ${body.error?.message || ''}`.trim());
  return body;
}

async function publish(text) {
  const container = await call('POST', `/v1.0/${userId}/threads`, { media_type: 'TEXT', text, access_token: token });
  await sleep(Number(process.env.PUBLISH_WAIT_MS || 30000)); // the docs ask for ~30 s before publishing
  return (await call('POST', `/v1.0/${userId}/threads_publish`, { creation_id: container.id, access_token: token })).id;
}

async function refresh() {
  if (DRY || !token) return console.log(token ? 'DRY_RUN: would refresh the token' : 'THREADS_TOKEN not set; nothing to refresh');
  const r = await call('GET', '/refresh_access_token', { grant_type: 'th_refresh_token', access_token: token });
  const days = Math.round(r.expires_in / 86400);
  console.log(`token refreshed, valid for ${days} more days`);
  if (r.access_token !== token) {
    // The workflow stores the new token as the THREADS_TOKEN secret, when it has a PAT that may do so.
    console.log(`::add-mask::${r.access_token}`);
    await writeFile(process.env.NEW_TOKEN_FILE || `${ROOT}/.new-threads-token`, r.access_token, { mode: 0o600 });
    console.log('refresh returned a different token; saved for the workflow to store');
  }
}

async function post() {
  const queue = await readJson(QUEUE, []);
  const posted = await readJson(POSTED, []);
  const done = new Set(posted.map((p) => p.id));
  const today = twDate();
  const slot = process.env.SLOT || currentSlot();
  const entry = queue.find((e) => e.date === today && e.slot === slot && !done.has(e.id));
  if (!entry) return console.log(`nothing due for ${today} ${slot}`);
  if (!entry.approved) return console.log(`${entry.id} is not approved yet; skipping`);
  const { items } = await readJson(`${ROOT}/data/items.json`, { items: [] });
  const out = compose(entry, items, today);
  if (out.skip) {
    console.log(`${entry.id} skipped: ${out.skip}`);
    if (!DRY) await writeFile(POSTED, JSON.stringify([...posted, { id: entry.id, skippedAt: new Date().toISOString(), reason: out.skip }], null, 1) + '\n');
    return;
  }
  console.log(`--- ${entry.id} (${threadsLength(out.text)} chars) ---\n${out.text}\n---`);
  if (DRY) return console.log('DRY_RUN: not posting');
  if (!token || !userId) return console.log('THREADS_TOKEN / THREADS_USER_ID not set; not posting');
  const threadsId = await publish(out.text);
  await writeFile(POSTED, JSON.stringify([...posted, { id: entry.id, postedAt: new Date().toISOString(), threadsId, text: out.text }], null, 1) + '\n');
  console.log(`posted ${entry.id} as ${threadsId}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (process.argv.includes('--refresh') ? refresh() : post()).catch((err) => {
    console.error(`THREADS FAILED: ${err.message}`);
    process.exit(1);
  });
}
