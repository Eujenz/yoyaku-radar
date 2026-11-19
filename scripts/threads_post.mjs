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
//     "text": "...{{list}}..." (optional for live entries), "live": "closing" | "new" | "rerelease" (optional), "link": true (optional) }
// {{list}} is filled from data/items.json at posting time; dates and prices are never written by hand.
// A live entry without text gets an opener, item format and closer picked from a pool, 2 to 4 items, and
// skips items mentioned in the last 3 days. Each post waits a random 0 to MAX_JITTER_MIN (40) minutes.
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
// Live posts are written from a pool of phrasings so they do not read like the same bot every day.
// The choice is seeded by the entry id, so a DRY_RUN preview shows the wording that will be posted.
// No wording claims personal experience ("I bought…"): the account is an openly curated collector account.
const shortName = (name) => name.replace(/^【[^】]*(?:再販|受注)】\s*/, '');
const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const yen = (n) => `¥${n.toLocaleString('en-US')}`;
const daysFrom = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const WD = ['日', '一', '二', '三', '四', '五', '六'];
const weekday = (d) => `週${WD[new Date(`${d}T00:00:00Z`).getUTCDay()]}`;

export function rng(seed) {
  let h = 2166136261;
  for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}
const pick = (r, list) => list[Math.floor(r() * list.length)];

const OPENERS = {
  closing: [
    '提醒一下，這幾件預購快截止了：',
    '有在等這幾件的，預購時間不多了',
    '截止前最後提醒',
    '這兩天要截止的預購，整理給有需要的人',
    '差點忘了，這幾件快收單了',
  ],
  new: [
    '這週新開的預購，挑幾件比較有話題的：',
    '最近新開預購的幾件',
    '這週有不少新品開預購，先整理一部分',
    '新開預購整理',
  ],
  rerelease: [
    '之前錯過的可以看看，這幾件再販快截止了',
    '再販提醒：',
    '當初沒買到的，這次再販別再錯過了',
    '這幾件再販的預購也快結束了',
  ],
};
const CLOSERS = ['', '', '（日期是日本時間，以官方頁面為準）', '日期是日本時間，各店家可能更早收單', '有漏掉的歡迎補充'];

const formatters = [
  (i) => `・${shortName(i.name)}（${i.preorderEnd ? `${md(i.preorderEnd)} 截止` : '截止日未定'}${i.priceJpy ? `，${yen(i.priceJpy)}` : ''}）`,
  (i) => `${i.preorderEnd ? `${md(i.preorderEnd)}（${weekday(i.preorderEnd).slice(1)}）截止` : '截止日未定'}｜${shortName(i.name)}`,
  (i) => `- ${shortName(i.name)}${i.preorderEnd ? `，${md(i.preorderEnd)} 截止` : ''}`,
];

export function liveItems(kind, items, today, avoid = new Set()) {
  const jst = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const open = items.filter(
    (i) => i.status === 'open' && i.stage !== 'announced' && (!i.preorderEnd || i.preorderEnd >= jst) && (!i.preorderEndAt || Date.parse(i.preorderEndAt) > Date.now()),
  );
  const byPrice = (a, b) => (b.priceJpy || 0) - (a.priceJpy || 0);
  let list = [];
  if (kind === 'closing') list = open.filter((i) => i.preorderEnd && daysFrom(today, i.preorderEnd) <= 2);
  if (kind === 'new') list = open.filter((i) => i.preorderStart && daysFrom(i.preorderStart, today) <= 7);
  if (kind === 'rerelease') list = open.filter((i) => i.isRerelease && i.preorderEnd && daysFrom(today, i.preorderEnd) <= 10);
  // Items mentioned in the last few days go last, so consecutive posts do not repeat the same pieces.
  return list.sort((a, b) => avoid.has(a.id) - avoid.has(b.id) || byPrice(a, b));
}

export function compose(entry, items, today, avoid = new Set()) {
  const r = rng(entry.id);
  let text = entry.text;
  let used = [];
  if (entry.live) {
    const pool = liveItems(entry.live, items, today, avoid).filter((i) => !avoid.has(i.id));
    if (pool.length < 2) return { skip: `only ${pool.length} new live item(s) for "${entry.live}"` };
    const fmt = pick(r, formatters);
    const opener = pick(r, OPENERS[entry.live]);
    const closer = pick(r, CLOSERS);
    const want = 2 + Math.floor(r() * 3); // 2 to 4 items
    const template = entry.text || `${opener}\n{{list}}${closer ? `\n${closer}` : ''}`;
    for (let n = Math.min(want, pool.length); n >= 2; n--) {
      used = pool.slice(0, n).sort((x, y) => (x.preorderEnd || '9999').localeCompare(y.preorderEnd || '9999'));
      text = template.replace('{{list}}', used.map(fmt).join('\n'));
      if (threadsLength(text + (entry.link ? `\n${SITE}/week/` : '')) <= MAX_CHARS) break;
    }
  }
  if (entry.link) text += `\n${SITE}/${entry.live === 'rerelease' ? 'rerelease' : 'week'}/`;
  if (!text || text.includes('{{')) return { skip: 'empty text or unfilled placeholder' };
  if (threadsLength(text) > MAX_CHARS) return { skip: `too long (${threadsLength(text)} > ${MAX_CHARS})` };
  return { text, itemIds: used.map((i) => i.id) };
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
  const recent = posted.filter((p) => p.postedAt && Date.now() - Date.parse(p.postedAt) < 3 * 864e5);
  const avoid = new Set(recent.flatMap((p) => p.itemIds || []));
  const out = compose(entry, items, today, avoid);
  if (out.skip) {
    console.log(`${entry.id} skipped: ${out.skip}`);
    if (!DRY) await writeFile(POSTED, JSON.stringify([...posted, { id: entry.id, skippedAt: new Date().toISOString(), reason: out.skip }], null, 1) + '\n');
    return;
  }
  console.log(`--- ${entry.id} (${threadsLength(out.text)} chars) ---\n${out.text}\n---`);
  if (DRY) return console.log('DRY_RUN: not posting');
  if (!token || !userId) return console.log('THREADS_TOKEN / THREADS_USER_ID not set; not posting');
  // Post at a slightly different minute each day instead of exactly on the schedule.
  const jitter = Math.floor(Math.random() * Number(process.env.MAX_JITTER_MIN ?? 40) * 60e3);
  if (jitter) {
    console.log(`waiting ${Math.round(jitter / 60e3)} min before posting`);
    await sleep(jitter);
  }
  const threadsId = await publish(out.text);
  await writeFile(POSTED, JSON.stringify([...posted, { id: entry.id, postedAt: new Date().toISOString(), threadsId, itemIds: out.itemIds, text: out.text }], null, 1) + '\n');
  console.log(`posted ${entry.id} as ${threadsId}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (process.argv.includes('--refresh') ? refresh() : post()).catch((err) => {
    console.error(`THREADS FAILED: ${err.message}`);
    process.exit(1);
  });
}
