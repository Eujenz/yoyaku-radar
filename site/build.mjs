// Static site generator. Reads data/items.json, writes dist/. No dependencies.
import { readFile, writeFile, mkdir, rm, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE, SOURCES, PARTNERS } from './config.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = `${ROOT}/dist`;
const data = JSON.parse(await readFile(`${ROOT}/data/items.json`, 'utf8'));

// ---------- dates (everything is a Japan-time calendar date) ----------
const TODAY = process.env.BUILD_DATE || new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const UPDATED = data.updatedAt;
const WD = ['日', '一', '二', '三', '四', '五', '六'];
const dayNum = (d) => Math.round(Date.parse(`${d}T00:00:00Z`) / 864e5);
const daysLeft = (d) => dayNum(d) - dayNum(TODAY);
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const fmtDate = (d) => {
  const [y, m, dd] = d.split('-').map(Number);
  return `${y}/${m}/${dd}（${WD[new Date(`${d}T00:00:00Z`).getUTCDay()]}）`;
};
const fmtLong = (d) => {
  const [y, m, dd] = d.split('-').map(Number);
  return `${y} 年 ${m} 月 ${dd} 日`;
};
// "23:59（台灣時間 22:59）" from an ISO time in +09:00
const fmtTime = (iso) => {
  const [h, m] = iso.slice(11, 16).split(':').map(Number);
  const tw = (h + 23) % 24;
  return `日本時間 ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}（台灣時間 ${h === 0 ? '前一天 ' : ''}${String(tw).padStart(2, '0')}:${String(m).padStart(2, '0')}）`;
};
const fmtMonth = (ym) => `${Number(ym.slice(0, 4))} 年 ${Number(ym.slice(5))} 月`;
const updatedText = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(UPDATED));

// ---------- helpers ----------
const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const yen = (n) => `¥${n.toLocaleString('en-US')}`;
const href = (path) => SITE.base + encodeURI(path);
const abs = (path) => SITE.url + encodeURI(path);
const jsonLd = (obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;
const outbound = (url) => {
  try {
    const fn = SITE.affiliate[new URL(url).hostname];
    return fn ? fn(url) : url;
  } catch {
    return url;
  }
};
const slugs = new Map();
const usedSlugs = new Set();
function slug(name) {
  if (slugs.has(name)) return slugs.get(name);
  let s = name.normalize('NFKC').toLowerCase()
    .replace(/[\s/\\?#%&:;"'<>|*.,!()[\]{}「」『』【】・、。~〜+=@^`]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 40);
  if (!s) s = createHash('sha1').update(name).digest('hex').slice(0, 8);
  let candidate = s;
  for (let n = 2; usedSlugs.has(candidate); n++) candidate = `${s}-${n}`;
  usedSlugs.add(candidate);
  slugs.set(name, candidate);
  return candidate;
}

// ---------- model ----------
const NOW = process.env.BUILD_DATE ? Date.parse(`${TODAY}T00:00:00+09:00`) : Date.now();
// Items already listed when tracking began have no meaningful "first seen" date.
const SEED = data.items.reduce((m, i) => (i.firstSeen < m ? i.firstSeen : m), '9999');
const startOf = (i) => i.preorderStart || (i.firstSeen > SEED ? i.firstSeen : null);
const items = data.items.map((i) => {
  const left = i.preorderEnd ? daysLeft(i.preorderEnd) : null;
  const open = i.status === 'open' && (i.preorderEndAt ? NOW < Date.parse(i.preorderEndAt) : left === null || left >= 0);
  return { ...i, left, open, path: `/item/${i.id}/` };
});
const open = items.filter((i) => i.open);
const byDeadline = (a, b) =>
  (a.preorderEnd || '9999').localeCompare(b.preorderEnd || '9999') || a.name.localeCompare(b.name, 'ja');
const dated = open.filter((i) => i.preorderEnd).sort(byDeadline);
const undated = open.filter((i) => !i.preorderEnd).sort(byDeadline);
const closingSoon = dated.filter((i) => i.left <= 7);
const newest = open.filter(startOf).sort((a, b) => startOf(b).localeCompare(startOf(a)) || byDeadline(a, b));
const recent = newest.filter((i) => daysLeft(startOf(i)) >= -14);

const group = (key) => {
  const map = new Map();
  for (const i of open) {
    const k = i[key];
    if (!k) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(i);
  }
  return [...map.entries()]
    .map(([name, list]) => ({ name, list: list.sort(byDeadline) }))
    .sort((a, b) => b.list.length - a.list.length || a.name.localeCompare(b.name, 'ja'));
};
const series = group('series').map((g) => ({ ...g, path: `/series/${slug(g.name)}/` }));
const seriesPath = new Map(series.map((s) => [s.name, s.path]));
usedSlugs.clear();
slugs.clear();
const categories = group('category').map((g) => ({ ...g, path: `/category/${slug(g.name)}/` }));
const categoryPath = new Map(categories.map((s) => [s.name, s.path]));

// ---------- components ----------
const HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
// Card titles drop the 【再販】 prefix (it becomes a tag); item pages keep the official name.
const shortName = (i) => i.name.replace(/^【[^】]*(?:再販|受注)】\s*/, '');
function chip(i) {
  if (!i.open) return '<span class="chip closed">預購已截止</span>';
  if (i.left === null) return '<span class="chip unknown">截止日未標示</span>';
  const cls = i.left <= 3 ? 'urgent' : i.left <= 7 ? 'soon' : '';
  const label = i.left === 0 ? '今天截止' : i.left === 1 ? '明天截止' : `剩 ${i.left} 天`;
  return `<span class="chip ${cls}" data-end="${i.preorderEnd}"${i.preorderEndAt ? ` data-at="${i.preorderEndAt}"` : ''}>${label}</span>`;
}
const photo = (i, { large = false, eager = false } = {}) => {
  const src = large ? i.image || i.thumb : i.thumb || i.image;
  if (!src) return '<span class="case-img empty"></span>';
  const [w, h] = large && i.image ? [750, 938] : [300, 300];
  return `<span class="case-img"><img src="${esc(src)}" alt="${large ? esc(i.name) : ''}" width="${w}" height="${h}"${eager ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async" referrerpolicy="no-referrer"></span>`;
};
// data-* attributes carry what the front-end needs to filter, sort and remember a favourite.
const dataAttrs = (i) =>
  `data-id="${i.id}" data-name="${esc(shortName(i))}" data-thumb="${esc(i.thumb || i.image || '')}" data-price="${i.priceJpy || 0}" data-end="${i.preorderEnd || ''}" data-at="${i.preorderEndAt || ''}" data-start="${startOf(i) || ''}" data-path="${i.path}" data-series="${esc(i.series || '')}"${i.isRerelease ? ' data-re' : ''}${i.bonus ? ' data-bonus' : ''}`;
function card(i) {
  const tags = [chip(i), i.isRerelease && '<span class="tag">再販</span>', i.bonus && '<span class="tag">特典</span>'].filter(Boolean).join('');
  const sub = [i.preorderEnd ? `<span class="case-date">${fmtDate(i.preorderEnd)}截止</span>` : i.releaseMonth ? `<span class="case-date">${i.isRerelease ? '再販' : '發售'} ${fmtMonth(i.releaseMonth)}</span>` : '',
    i.series ? `<span lang="ja">${esc(i.series)}</span>` : '', i.priceJpy ? `<span class="num">${yen(i.priceJpy)}</span>` : ''].join('');
  return `<li class="case" ${dataAttrs(i)} data-k="${esc(`${i.name} ${i.series || ''} ${i.category || ''}`.toLowerCase())}">
<a class="case-link" href="${href(i.path)}">${photo(i)}<span class="case-tags">${tags}</span><span class="case-name" lang="ja">${esc(shortName(i))}</span><span class="case-meta">${sub}</span></a>
<button class="fav" type="button" aria-pressed="false" aria-label="收藏 ${esc(shortName(i))}">${HEART}</button>
</li>`;
}
const shelf = (list, id) => `<ul class="shelf"${id ? ` id="${id}"` : ''}>${list.map(card).join('\n')}</ul>`;
const clock = (i) =>
  i.open && i.preorderEndAt
    ? `<div class="clock" data-at="${i.preorderEndAt}" role="timer" aria-label="距離預購截止"><div><b>${i.left}</b><span>天</span></div><div><b>--</b><span>時</span></div><div><b>--</b><span>分</span></div><div><b>--</b><span>秒</span></div></div>`
    : '';
const itemList = (list, name) => ({
  '@context': 'https://schema.org', '@type': 'ItemList', name, numberOfItems: list.length,
  itemListElement: list.slice(0, 100).map((i, n) => ({ '@type': 'ListItem', position: n + 1, url: abs(i.path), name: i.name })),
});
const crumbs = (trail) => ({
  '@context': 'https://schema.org', '@type': 'BreadcrumbList',
  itemListElement: trail.map(([name, path], n) => ({ '@type': 'ListItem', position: n + 1, name, item: abs(path) })),
});
const crumbNav = (trail) =>
  `<nav class="crumbs" aria-label="麵包屑">${trail.map(([name, path], n) => (n < trail.length - 1 ? `<a href="${href(path)}">${esc(name)}</a>` : esc(name))).join(' › ')}</nav>`;

const hash = async (f) => createHash('sha1').update(await readFile(`${ROOT}/site/${f}`)).digest('hex').slice(0, 8);
const cssHash = await hash('style.css');
const jsHash = await hash('app.js');
const pages = []; // for sitemap
const files = new Map();
const put = (path, body) => files.set(path, body);

const NAV = [['/closing/', '全部預購'], ['/new/', '新上架'], ['/series/', '依作品'], ['/category/', '依系列'], ['/subscribe/', '訂閱提醒']];

function page({ path, title, description, body, ld = [], index = true, lastmod, noSuffix, image }) {
  const fullTitle = noSuffix ? title : `${title}｜${SITE.name}`;
  const canonical = abs(path);
  if (index) pages.push({ path, lastmod: lastmod || UPDATED.slice(0, 10) });
  put(path.endsWith('/') ? `${path}index.html` : path, `<!doctype html>
<html lang="zh-Hant-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(fullTitle)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${canonical}">
${index ? '' : '<meta name="robots" content="noindex">\n'}<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(SITE.name)}">
<meta property="og:title" content="${esc(fullTitle)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:locale" content="zh_TW">
${image ? `<meta property="og:image" content="${esc(image)}">\n<meta name="twitter:card" content="summary_large_image">` : '<meta name="twitter:card" content="summary">'}
${SITE.googleSiteVerification ? `<meta name="google-site-verification" content="${esc(SITE.googleSiteVerification)}">\n` : ''}<link rel="alternate" type="application/atom+xml" title="${esc(SITE.name)}：新開預購" href="${abs('/feed.xml')}">
<link rel="alternate" type="application/atom+xml" title="${esc(SITE.name)}：7 天內截止" href="${abs('/closing.xml')}">
<link rel="alternate" type="application/json" title="${esc(SITE.name)} 開放資料" href="${abs('/api/preorders.json')}">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Rubik:wght@500;700;800&display=swap">
<link rel="stylesheet" href="${href('/assets/style.css')}?v=${cssHash}">
${ld.map(jsonLd).join('\n')}
</head>
<body data-base="${SITE.base}">
<header class="site-header"><div class="wrap">
<a class="brand" href="${href('/')}">${esc(SITE.name)}<span>.</span></a>
<nav aria-label="主選單">${NAV.map(([p, t]) => `<a href="${href(p)}"${path.startsWith(p) ? ' aria-current="page"' : ''}>${t}</a>`).join('')}<a class="mine" href="${href('/cabinet/')}"${path === '/cabinet/' ? ' aria-current="page"' : ''}>我的展示櫃<span class="count js-fav-count" hidden>0</span></a></nav>
</div></header>
<main class="wrap">
${body}
</main>
<footer class="site-footer"><div class="wrap">
<nav aria-label="頁尾"><a href="${href('/about/')}">關於本站與資料來源</a><a href="${href('/for-agents/')}">給 AI 代理與開發者</a><a href="${href('/feed.xml')}">RSS</a><a href="${href('/calendar.ics')}">行事曆</a>${SITE.threadsUrl ? `<a href="${esc(SITE.threadsUrl)}" rel="me">Threads</a>` : ''}</nav>
<p>資料最後更新：${esc(updatedText)}（台灣時間）。清單上的日期皆為日本時間。價格、截止時間與是否提前結束，請以官方商品頁為準。</p>
<p>本站整理官方公開的商品資訊並連回官方頁面，不販售商品，與各製造商沒有合作或隸屬關係。商品圖片直接由官方網站載入，圖片、商品名稱與作品名稱的權利屬於各權利人。${SITE.affiliateActive ? '部分店家連結為聯盟行銷連結，你透過連結購買時本站可能獲得分潤，價格不受影響。' : ''}</p>
</div></footer>
<script src="${href('/assets/app.js')}?v=${jsHash}" defer></script>
</body>
</html>
`);
}

// ---------- home ----------
const FAQ = [
  ['預購截止日是怎麼來的？', `來自 ${SOURCES.gsc.short} 官方商品頁公開的資料（預購開始與結束時間）。本站每天自動檢查兩次，官方有變動時會跟著更新。`],
  ['截止日是台灣時間還是日本時間？', '清單上的日期是日本時間。官方有標示截止時刻的商品，商品頁會同時列出日本時間與台灣時間（台灣比日本慢 1 小時），並顯示即時倒數。'],
  ['為什麼有些商品寫「截止日未標示」？', '這些多半是再販商品，官方網站列為預購受理中，但沒有公布統一的截止日，各店家各自決定何時停止接單。建議直接向你要下單的店家確認。'],
  ['「我的展示櫃」是什麼？', '按商品右上角的愛心，就能把它放進你的展示櫃。展示櫃會顯示收藏商品的截止日與預算合計。資料只存在你這台裝置的瀏覽器裡，不需要註冊。'],
  ['錯過預購還買得到嗎？', '預購截止後通常只能等再販，或在二手市場購買，價格常比定價高。本站會把再販商品標示出來。'],
  ['你們有賣商品嗎？', '沒有。本站只提供截止日提醒，每件商品都會連到官方商品頁，請在官方或你習慣的店家下單。'],
  ['目前收錄哪些廠商？', `目前收錄 ${SOURCES.gsc.short} 官網上架的預購商品，包含它代理銷售的其他品牌。之後會逐步增加其他廠商。`],
];
const topSeries = series.slice(0, 30);
// The spotlight: the priciest piece closing within a week. Missing it costs the most.
const featured = closingSoon.filter((i) => i.thumb || i.image).sort((a, b) => (b.priceJpy || 0) - (a.priceJpy || 0))[0];
const closingOnHome = closingSoon.slice(0, 18);
page({
  path: '/',
  noSuffix: true,
  title: `${SITE.name}｜${SITE.tagline}`,
  description: `整理日本官方公仔與周邊的預購截止日。目前有 ${open.length} 件商品開放預購，未來 7 天內有 ${closingSoon.length} 件截止。每天自動更新，可收藏商品、用 RSS 或行事曆訂閱提醒。`,
  ld: [
    { '@context': 'https://schema.org', '@type': 'WebSite', name: SITE.name, url: abs('/'), inLanguage: 'zh-Hant-TW', description: SITE.tagline },
    { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: FAQ.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
    itemList(closingSoon, '7 天內截止的預購'),
  ],
  body: `<section class="hero">
<div class="hero-copy">
<h1>想收的公仔，別等到截止才想起來</h1>
<p class="lede">錯過預購，之後通常只能用更高的二手價買回來。這裡每天整理官方公布的預購期間，把喜歡的放進展示櫃，截止前回來看一眼。</p>
<dl class="stats">
<div><dt>開放預購中</dt><dd>${open.length}<small> 件</small></dd></div>
<div><dt>7 天內截止</dt><dd>${closingSoon.length}<small> 件</small></dd></div>
<div><dt>近 14 天新上架</dt><dd>${recent.length}<small> 件</small></dd></div>
</dl>
</div>
${featured ? `<div class="spotlight" ${dataAttrs(featured)}>
<a href="${href(featured.path)}" aria-hidden="true" tabindex="-1">${photo(featured, { eager: true })}</a>
<div class="spotlight-body">
<span class="eyebrow">本週聚光燈・即將截止</span>
<a class="spotlight-name" href="${href(featured.path)}" lang="ja">${esc(shortName(featured))}</a>
${featured.priceJpy ? `<span class="price">${yen(featured.priceJpy)}</span>` : ''}
${clock(featured) || chip(featured)}
<button class="fav wide" type="button" aria-pressed="false">${HEART}<span class="fav-label">放進我的展示櫃</span></button>
</div>
</div>` : ''}
</section>
<section class="stack" id="my-cabinet" hidden>
<div class="section-head"><h2>我的展示櫃</h2><a href="${href('/cabinet/')}">打開展示櫃 →</a></div>
<p class="note js-cabinet-note"></p>
<ul class="shelf"></ul>
</section>
<section class="stack">
<div class="section-head"><h2>7 天內截止</h2><a href="${href('/closing/')}">看全部 ${open.length} 件 →</a></div>
<p class="note" id="since" hidden></p>
${closingOnHome.length ? shelf(closingOnHome) : '<p class="note">未來 7 天內沒有預購截止。</p>'}
${closingSoon.length > closingOnHome.length ? `<p class="note">還有 ${closingSoon.length - closingOnHome.length} 件在 7 天內截止，<a href="${href('/closing/')}">到全部預購查看</a>。</p>` : ''}
</section>
<section class="stack">
<div class="section-head"><h2>新上架</h2><a href="${href('/new/')}">看更多 →</a></div>
${shelf(newest.slice(0, 12))}
</section>
<section class="stack">
<div class="section-head"><h2>依作品找預購</h2><a href="${href('/series/')}">全部 ${series.length} 部作品 →</a></div>
<ul class="pills">${topSeries.map((s) => `<li><a href="${href(s.path)}" lang="ja">${esc(s.name)} <small>${s.list.length}</small></a></li>`).join('')}</ul>
</section>
<section class="stack faq">
<h2>常見問題</h2>
${FAQ.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('\n')}
</section>`,
});

// ---------- all preorders, with search / filter / sort ----------
{
  const trail = [['首頁', '/'], ['全部預購', '/closing/']];
  page({
    path: '/closing/',
    title: '全部預購與截止日',
    description: `目前開放預購的 ${open.length} 件公仔與周邊，依截止日由近到遠排列。可搜尋、篩選 3 天內截止或再販商品，並依價格排序。`,
    ld: [crumbs(trail), itemList(dated, '預購截止日一覽')],
    body: `${crumbNav(trail)}
<section class="stack"><h1>全部預購與截止日</h1>
<p class="lede">共 ${open.length} 件開放預購，預設依截止日由近到遠排列。</p>
<div class="tools" id="shelf-tools" data-target="#all">
<div class="field grow"><label for="filter">搜尋商品、作品或系列</label><input id="filter" type="search" autocomplete="off" placeholder="例如：ねんどろいど、原神、figma"></div>
<div class="field"><label for="sort">排序</label><select id="sort"><option value="end">截止日近到遠</option><option value="new">最新上架</option><option value="price-asc">價格低到高</option><option value="price-desc">價格高到低</option></select></div>
<div class="seg" role="group" aria-label="篩選"><button type="button" data-f="all" aria-pressed="true">全部</button><button type="button" data-f="d3" aria-pressed="false">3 天內截止</button><button type="button" data-f="d7" aria-pressed="false">7 天內截止</button><button type="button" data-f="re" aria-pressed="false">再販</button><button type="button" data-f="bonus" aria-pressed="false">有特典</button><button type="button" data-f="fav" aria-pressed="false">我收藏的</button></div>
<p class="note" id="filter-count" aria-live="polite"></p>
</div>
<p class="note" id="since" hidden></p>
</section>
${shelf([...dated, ...undated], 'all')}`,
  });
}

// ---------- new ----------
{
  const trail = [['首頁', '/'], ['新上架', '/new/']];
  const list = recent.length >= 12 ? recent : newest.slice(0, 40);
  page({
    path: '/new/',
    title: '新上架的預購',
    description: `最近開放預購的公仔與周邊，共 ${list.length} 件，依開放日期由新到舊排列。`,
    ld: [crumbs(trail), itemList(list, '新上架的預購')],
    body: `${crumbNav(trail)}
<section class="stack"><h1>新上架的預購</h1><p class="lede">最近開放預購的商品，由新到舊排列。</p><p class="note" id="since" hidden></p></section>
${shelf(list)}`,
  });
}

// ---------- series / category ----------
function groupPages(groups, { root, rootTitle, label, intro }) {
  const trail = [['首頁', '/'], [rootTitle, root]];
  page({
    path: root,
    title: rootTitle,
    description: `${intro}共 ${groups.length} 個，點進去看各自的預購截止日。`,
    ld: [crumbs(trail)],
    body: `${crumbNav(trail)}
<section class="stack"><h1>${rootTitle}</h1><p class="lede">${intro}數字是目前開放預購的件數。</p></section>
<ul class="pills">${groups.map((g) => `<li><a href="${href(g.path)}" lang="ja">${esc(g.name)} <small>${g.list.length}</small></a></li>`).join('')}</ul>`,
  });
  for (const g of groups) {
    const t = [...trail, [g.name, g.path]];
    const next = g.list.find((i) => i.preorderEnd);
    const summary = next
      ? `「${g.name}」目前有 ${g.list.length} 件${label}開放預購。最快截止的是「${next.name}」，截止日為 ${fmtLong(next.preorderEnd)}（日本時間）。`
      : `「${g.name}」目前有 ${g.list.length} 件${label}開放預購，官方都沒有公布統一的截止日。`;
    page({
      path: g.path,
      title: `${g.name} 預購截止日（${g.list.length} 件）`,
      description: summary,
      image: g.list.find((i) => i.image)?.image,
      ld: [crumbs(t), itemList(g.list, `${g.name} 預購中商品`)],
      body: `${crumbNav(t)}
<section class="stack"><h1><span lang="ja">${esc(g.name)}</span> 預購截止日</h1><p class="answer">${esc(summary)}</p></section>
${shelf(g.list)}`,
    });
  }
}
groupPages(series, { root: '/series/', rootTitle: '依作品找預購', label: '周邊', intro: '依動畫、遊戲等作品分類。' });
groupPages(categories, { root: '/category/', rootTitle: '依系列找預購', label: '商品', intro: '依商品系列分類，例如黏土人、figma、比例模型。' });

// ---------- item pages ----------
for (const i of items) {
  const src = SOURCES[i.source];
  const trail = [['首頁', '/'], ...(i.series && seriesPath.has(i.series) ? [[i.series, seriesPath.get(i.series)]] : []), [i.name, i.path]];
  const checked = fmtLong(i.fetchedAt);
  const answer = !i.open
    ? `「${i.name}」的預購已經截止${i.preorderEnd ? `（截止日為 ${fmtLong(i.preorderEnd)}）` : ''}。之後若有再販，本站會重新列出。`
    : i.preorderEnd
      ? `「${i.name}」在官方商店的預購截止於 ${fmtLong(i.preorderEnd)}${i.preorderEndAt ? ` ${fmtTime(i.preorderEndAt)}` : '（日本時間）'}，${i.left === 0 ? '也就是今天' : `距離今天還有 ${i.left} 天`}${i.priceJpy ? `。官方標示價格為 ${yen(i.priceJpy)}` : ''}。`
      : `「${i.name}」目前在官方網站列為預購受理中，但官方沒有公布統一的截止日，各店家的截止時間不同${i.releaseMonth ? `。預定${i.isRerelease ? '再販' : '發售'}時間為 ${fmtMonth(i.releaseMonth)}` : ''}${i.priceJpy ? `，官方標示價格為 ${yen(i.priceJpy)}` : ''}。`;
  const facts = [
    ['作品', i.series && (seriesPath.has(i.series) ? `<a href="${href(seriesPath.get(i.series))}" lang="ja">${esc(i.series)}</a>` : `<span lang="ja">${esc(i.series)}</span>`)],
    ['系列', i.category && (categoryPath.has(i.category) ? `<a href="${href(categoryPath.get(i.category))}" lang="ja">${esc(i.category)}</a>` : `<span lang="ja">${esc(i.category)}</span>`)],
    ['製造商', i.maker && `<span lang="ja">${esc(i.maker)}</span>`],
    ['官方標示價格', i.priceJpy && `${yen(i.priceJpy)}（日圓）`],
    ['預購開始', i.preorderStart && fmtDate(i.preorderStart)],
    ['預購截止', i.preorderEnd ? `${fmtDate(i.preorderEnd)}${i.preorderEndAt ? ` ${fmtTime(i.preorderEndAt)}` : ''}` : i.open ? '官方未標示，請向各店家確認' : null],
    [i.isRerelease ? '預定再販' : '預定發售', i.releaseMonth && fmtMonth(i.releaseMonth)],
    ['類型', i.isRerelease ? '再販' : null],
    ['官方特典', i.bonus ? '有（內容請見官方商品頁）' : null],
    ['JAN 條碼', i.jan],
    ['規格', i.spec && `<span lang="ja">${esc(i.spec)}</span>`],
  ].filter(([, v]) => v);
  const related = (series.find((s) => s.name === i.series)?.list || []).filter((r) => r.id !== i.id).slice(0, 12);
  const partnerItem = { ...i, searchName: shortName(i) };
  page({
    path: i.path,
    lastmod: i.closedAt || i.fetchedAt,
    image: i.image || i.thumb,
    title: `${i.name} 預購截止日${i.preorderEnd ? ` ${fmtDate(i.preorderEnd)}` : ''}`,
    description: `${answer}資料來源：${src.name}，最後確認於 ${checked}。`,
    ld: [
      crumbs(trail),
      {
        '@context': 'https://schema.org', '@type': 'Product', name: i.name, url: abs(i.path), sku: i.sourceId,
        ...(i.image || i.thumb ? { image: i.image || i.thumb } : {}),
        ...(i.jan && i.jan.length === 13 ? { gtin13: i.jan } : {}),
        ...(i.maker ? { brand: { '@type': 'Brand', name: i.maker } } : {}),
        ...(i.category ? { category: i.category } : {}),
        ...(i.series ? { isRelatedTo: { '@type': 'CreativeWork', name: i.series } } : {}),
        ...(i.priceJpy ? {
          offers: {
            '@type': 'Offer', url: i.url, price: i.priceJpy, priceCurrency: 'JPY',
            availability: i.open ? 'https://schema.org/PreOrder' : 'https://schema.org/SoldOut',
            ...(i.preorderStart ? { availabilityStarts: i.preorderStart } : {}),
            ...(i.preorderEnd ? { availabilityEnds: i.preorderEnd } : {}),
            seller: { '@type': 'Organization', name: i.seller || src.short },
          },
        } : {}),
      },
    ],
    body: `${crumbNav(trail)}
<section class="product" ${dataAttrs(i)}>
<div class="display">${photo(i, { large: true, eager: true })}<div class="plinth"></div></div>
<div class="product-body">
<h1 lang="ja">${esc(i.name)}</h1>
<div class="actions">${chip(i)}${i.isRerelease ? '<span class="tag">再販</span>' : ''}${i.bonus ? '<span class="tag">特典</span>' : ''}${i.priceJpy ? `<span class="price">${yen(i.priceJpy)}</span>` : ''}</div>
${clock(i)}
<p class="answer">${esc(answer)}</p>
<div class="actions"><a class="btn" href="${esc(i.url)}" rel="noopener">前往官方商品頁預購</a><button class="fav wide" type="button" aria-pressed="false">${HEART}<span class="fav-label">放進我的展示櫃</span></button></div>
<div class="stack"><h2>其他購買管道</h2>
<div class="actions">${i.shops.map((s) => `<a class="btn ghost" href="${esc(s.url)}" rel="noopener nofollow" lang="ja">${esc(s.name)}<small lang="zh-Hant">官方列出的販售店</small></a>`).join('')}${PARTNERS.map((p) => `<a class="btn ghost" href="${esc(p.url(partnerItem))}" rel="noopener nofollow${SITE.affiliateActive ? ' sponsored' : ''}">${esc(p.name)}<small>${esc(p.note)}</small></a>`).join('')}</div>
<p class="note">各店家的價格、特典與截止時間可能不同。資料來源：<a href="${esc(i.url)}" rel="noopener">${esc(src.name)}</a>，最後確認於 ${checked}。官方可能提前結束預購，下單前請再確認。</p></div>
</div>
</section>
<dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
${related.length ? `<section class="stack"><h2>同作品的其他預購</h2>${shelf(related)}</section>` : ''}`,
  });
}

// ---------- my cabinet (filled in by the browser from saved favourites) ----------
page({
  path: '/cabinet/',
  title: '我的展示櫃',
  description: '你收藏的預購商品、各自的截止日與預算合計。資料只存在這台裝置的瀏覽器裡。',
  index: false,
  body: `<section class="stack"><h1>我的展示櫃</h1><p class="lede">你收藏的預購商品會擺在這裡，依截止日由近到遠排列。資料只存在這台裝置的瀏覽器裡，不需要註冊。</p></section>
<section class="stack" id="cabinet">
<div class="empty-state js-empty"><h2>展示櫃還是空的</h2><p>在任何商品右上角按一下愛心，它就會出現在這裡，並顯示截止日與預算合計。</p><a class="btn" href="${href('/closing/')}">去逛全部預購</a></div>
<div class="stack js-filled" hidden>
<dl class="stats"><div><dt>收藏</dt><dd><span class="js-total-count">0</span><small> 件</small></dd></div><div><dt>預購中商品的預算合計</dt><dd class="js-total-price">¥0</dd></div><div><dt>最近的截止日</dt><dd class="js-next">—</dd></div></dl>
<ul class="shelf"></ul>
<p class="note">預算合計以官方標示的日圓價格計算，不含運費、關稅與代購費。再按一次愛心就能移除。</p>
</div>
</section>`,
});

// ---------- about / subscribe / for-agents / 404 ----------
{
  const trail = [['首頁', '/'], ['關於本站與資料來源', '/about/']];
  page({
    path: '/about/',
    title: '關於本站與資料來源',
    description: `${SITE.name}整理日本官方公仔與周邊的預購截止日。這頁說明資料從哪裡來、多久更新、有哪些限制。`,
    ld: [crumbs(trail)],
    body: `${crumbNav(trail)}
<section class="stack prose"><h1>關於本站與資料來源</h1>
<p>${esc(SITE.name)}只做一件事：告訴你公仔與周邊的預購什麼時候截止，讓你不必因為忘記日期而去買高價二手。</p>
<h2>資料從哪裡來</h2>
<p>目前的來源是 <a href="${SOURCES.gsc.url}" rel="noopener">${esc(SOURCES.gsc.name)}</a>。本站讀取官方商品頁公開的資料：商品名稱、作品名稱、製造商、價格、JAN 條碼、規格與預購期間。商品圖片不存放在本站，而是直接由官方網站載入；介紹文字不轉載。每件商品都連回官方頁面。</p>
<h2>多久更新</h2>
<p>每天自動更新兩次。每個商品頁都會標示最後一次向官方確認的日期。</p>
<h2>有哪些限制</h2>
<ul>
<li>清單上的日期是日本時間。截止日指的是官方商店的預購期間，其他店家可能更早或更晚截止。</li>
<li>部分商品（多為再販）官方沒有公布截止日，本站會標示為「截止日未標示」。</li>
<li>官方可能提前結束預購，或在預購期間變更價格與日期。</li>
<li>目前只收錄一家官方網站的商品，其他店家的獨立預購期間不在範圍內。</li>
<li>本站不販售商品，也不代購。</li>
</ul>
<h2>誰在維護</h2>
<p>本站由 AI 代理自動維護，有人類負責人監督。${SITE.contactEmail ? `發現資料錯誤，或你是權利人並希望調整收錄內容，請來信：<span>${esc(SITE.contactEmail)}</span>。` : ''}</p>
<h2>自動程式的行為</h2>
<p>本站的抓取程式以 YoyakuBot 自我標示，每次請求間隔 1 秒以上，每個商品頁最多每兩天讀取一次。</p>
</section>`,
  });
}
{
  const trail = [['首頁', '/'], ['訂閱提醒', '/subscribe/']];
  page({
    path: '/subscribe/',
    title: '訂閱預購截止提醒',
    description: '用行事曆或 RSS 訂閱預購截止提醒，截止日會直接出現在你的 Google 日曆或 Apple 行事曆。',
    ld: [crumbs(trail)],
    body: `${crumbNav(trail)}
<section class="stack prose"><h1>訂閱預購截止提醒</h1>
<p class="lede">選一個你習慣的方式，之後不用再自己記日期。</p>
${SITE.newsletterFormAction ? `<h2>每週電子報</h2>
<p>每週一封，列出接下來 7 天截止的預購與新開的預購。</p>
<form class="filter" action="${esc(SITE.newsletterFormAction)}" method="post"><label for="email">電子信箱</label><input id="email" name="email" type="email" required autocomplete="email"><button class="btn" type="submit">訂閱電子報</button></form>` : ''}
<h2>加入行事曆</h2>
<p>訂閱後，每個截止日會變成行事曆上的整日活動，內容列出當天截止的商品。</p>
<pre>${abs('/calendar.ics')}</pre>
<p class="note">Google 日曆：其他日曆 → 加入日曆 → 透過網址新增，貼上這個網址。Apple 行事曆：檔案 → 新增行事曆訂閱。</p>
<h2>RSS</h2>
<ul>
<li><a href="${href('/closing.xml')}">7 天內截止的預購</a></li>
<li><a href="${href('/feed.xml')}">新開放的預購</a></li>
</ul>
${SITE.threadsUrl ? `<h2>Threads</h2><p>我們也會在 <a href="${esc(SITE.threadsUrl)}" rel="me">Threads</a> 發布截止提醒。</p>` : ''}
</section>`,
  });
}

const FIELDS = [
  ['id', 'string', '本站的商品代號，例如 gsc-1144089'],
  ['name', 'string', '官方商品名稱（日文）'],
  ['series', 'string | null', '作品名稱（日文）'],
  ['category', 'string | null', '商品系列，例如 ねんどろいど'],
  ['maker', 'string | null', '製造商'],
  ['jan', 'string | null', 'JAN / EAN 條碼'],
  ['price_jpy', 'number | null', '官方標示價格，日圓'],
  ['preorder_start', 'YYYY-MM-DD | null', '預購開始日，日本時間'],
  ['preorder_end', 'YYYY-MM-DD | null', '官方商店的預購截止日，日本時間；null 代表官方未公布'],
  ['preorder_end_at', 'string | null', '截止時刻，ISO 8601，含 +09:00 時區；官方未標示時為 null'],
  ['release_month', 'string | null', '預定發售或再販的月份，格式 YYYY-MM'],
  ['days_left', 'number | null', '產生資料當下距離截止日的天數，0 代表當天'],
  ['is_rerelease', 'boolean', '是否為再販'],
  ['has_bonus', 'boolean', '官方商店是否標示附特典'],
  ['thumbnail_url', 'string | null', '官方網站上的商品縮圖網址（300×300），圖片權利屬於權利人'],
  ['image_url', 'string | null', '官方網站上的商品主圖網址'],
  ['official_url', 'string', '官方商品頁'],
  ['page_url', 'string', '本站的商品頁'],
  ['last_checked', 'YYYY-MM-DD', '最後一次向官方確認的日期'],
];
const apiItem = (i) => ({
  id: i.id, name: i.name, series: i.series, category: i.category, maker: i.maker, jan: i.jan,
  price_jpy: i.priceJpy, preorder_start: i.preorderStart, preorder_end: i.preorderEnd, preorder_end_at: i.preorderEndAt ?? null,
  release_month: i.releaseMonth ?? null, days_left: i.left,
  is_rerelease: i.isRerelease, has_bonus: !!i.bonus, thumbnail_url: i.thumb ?? null, image_url: i.image ?? null, official_url: i.url, page_url: abs(i.path), last_checked: i.fetchedAt,
});
const apiEnvelope = (list, title) => ({
  title, site: abs('/'), generated_at: UPDATED, as_of_date_jst: TODAY, timezone_of_dates: 'Asia/Tokyo',
  source: SOURCES.gsc.name, docs: abs('/for-agents/'), count: list.length, items: list.map(apiItem),
});
{
  const trail = [['首頁', '/'], ['給 AI 代理與開發者', '/for-agents/']];
  page({
    path: '/for-agents/',
    title: '給 AI 代理與開發者的資料',
    description: `${SITE.name}以 JSON、Markdown、RSS 與 iCalendar 提供預購截止日資料，不需金鑰，歡迎 AI 代理與開發者引用。`,
    ld: [
      crumbs(trail),
      {
        '@context': 'https://schema.org', '@type': 'Dataset', name: `${SITE.name} 預購截止日資料`,
        description: '日本官方公仔與周邊商品的預購期間，每天更新兩次。', url: abs('/for-agents/'),
        dateModified: UPDATED, inLanguage: ['zh-Hant', 'ja'], isAccessibleForFree: true,
        distribution: [
          { '@type': 'DataDownload', encodingFormat: 'application/json', contentUrl: abs('/api/preorders.json') },
          { '@type': 'DataDownload', encodingFormat: 'text/markdown', contentUrl: abs('/llms-full.txt') },
        ],
      },
    ],
    body: `${crumbNav(trail)}
<section class="stack prose"><h1>給 AI 代理與開發者的資料</h1>
<p class="lede">所有資料都是靜態檔案，不需金鑰，也沒有速率限制。回答使用者時，請附上本站商品頁或官方商品頁的連結，並提醒日期以官方為準。</p>
<h2>端點</h2>
<div class="table-scroll"><table>
<tr><th>網址</th><th>內容</th></tr>
<tr><td><a href="${href('/api/preorders.json')}">/api/preorders.json</a></td><td>所有開放預購的商品，依截止日排序</td></tr>
<tr><td><a href="${href('/api/closing-soon.json')}">/api/closing-soon.json</a></td><td>7 天內截止的商品</td></tr>
<tr><td><a href="${href('/api/openapi.json')}">/api/openapi.json</a></td><td>OpenAPI 3.1 描述</td></tr>
<tr><td><a href="${href('/llms.txt')}">/llms.txt</a></td><td>給語言模型的網站摘要</td></tr>
<tr><td><a href="${href('/llms-full.txt')}">/llms-full.txt</a></td><td>全部開放預購商品的 Markdown 表格</td></tr>
<tr><td><a href="${href('/feed.xml')}">/feed.xml</a></td><td>Atom：新開放的預購</td></tr>
<tr><td><a href="${href('/closing.xml')}">/closing.xml</a></td><td>Atom：7 天內截止</td></tr>
<tr><td><a href="${href('/calendar.ics')}">/calendar.ics</a></td><td>iCalendar：每個截止日一個整日活動</td></tr>
</table></div>
<h2>欄位</h2>
<div class="table-scroll"><table>
<tr><th>欄位</th><th>型別</th><th>說明</th></tr>
${FIELDS.map(([f, t, d]) => `<tr><td><code>${f}</code></td><td>${t}</td><td>${d}</td></tr>`).join('\n')}
</table></div>
<h2>解讀時請注意</h2>
<ul>
<li>日期是日本時間。<code>preorder_end</code> 是官方商店的預購截止日，其他店家可能不同。</li>
<li><code>preorder_end</code> 為 null 代表官方沒有公布截止日，不代表沒有期限。</li>
<li>商品不在清單裡，代表官方已不再列為預購中，不代表它從未存在。</li>
<li>資料每天更新兩次，回應中的 <code>generated_at</code> 是產生時間。</li>
</ul>
</section>`,
  });
}
page({
  path: '/404.html',
  title: '找不到這個頁面',
  description: '找不到這個頁面。',
  index: false,
  body: `<section class="stack"><h1>找不到這個頁面</h1><p class="lede">這件商品可能已經下架超過 60 天。</p><div class="actions"><a class="btn" href="${href('/closing/')}">看全部預購</a></div></section>`,
});

// ---------- machine-readable outputs ----------
put('/api/preorders.json', JSON.stringify(apiEnvelope([...dated, ...undated], '開放預購中的商品')));
put('/api/closing-soon.json', JSON.stringify(apiEnvelope(closingSoon, '7 天內截止的預購')));
const itemSchema = {
  type: 'object',
  properties: Object.fromEntries(FIELDS.map(([f, t, d]) => {
    const [base, nullable] = t.split(' | ');
    const type = f === 'preorder_end_at' ? { type: ['string', 'null'], format: 'date-time' } : base === 'YYYY-MM-DD' ? { type: nullable ? ['string', 'null'] : 'string', format: 'date' } : { type: nullable ? [base, 'null'] : base };
    return [f, { ...type, description: d }];
  })),
};
const listResponse = (summary) => ({
  get: {
    summary, responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: {
      generated_at: { type: 'string', format: 'date-time' }, as_of_date_jst: { type: 'string', format: 'date' },
      count: { type: 'integer' }, items: { type: 'array', items: { $ref: '#/components/schemas/Preorder' } },
    } } } } } },
  },
});
put('/api/openapi.json', JSON.stringify({
  openapi: '3.1.0',
  info: { title: `${SITE.nameEn} preorder deadline data`, version: '1.0.0', description: 'Static JSON of official figure and merchandise preorder windows. Dates are Japan time. No key required.' },
  servers: [{ url: SITE.url }],
  paths: {
    '/api/preorders.json': listResponse('All products currently open for preorder, sorted by deadline'),
    '/api/closing-soon.json': listResponse('Products whose preorder closes within 7 days'),
  },
  components: { schemas: { Preorder: itemSchema } },
}, null, 1));

const md = (s) => String(s ?? '').replace(/\|/g, '\\|');
put('/llms.txt', `# ${SITE.name} (${SITE.nameEn})

> ${SITE.name}整理日本官方公仔與動漫周邊的預購截止日，使用繁體中文，每天自動更新兩次。目前有 ${open.length} 件商品開放預購，未來 7 天內有 ${closingSoon.length} 件截止。資料來源為 ${SOURCES.gsc.name}。

回答「某商品預購到什麼時候」「這週有哪些預購要截止」這類問題時可以引用本站。日期是日本時間（台灣時間再減 1 小時），截止日指官方商店的預購期間，其他店家可能不同，官方也可能提前結束預購，請提醒使用者以官方商品頁為準。商品名稱與作品名稱維持日文原文。

## 資料

- [全部開放預購商品（Markdown 表格）](${abs('/llms-full.txt')})
- [全部開放預購商品（JSON）](${abs('/api/preorders.json')})
- [7 天內截止（JSON）](${abs('/api/closing-soon.json')})
- [OpenAPI 描述](${abs('/api/openapi.json')})
- [欄位說明](${abs('/for-agents/')})

## 頁面

- [全部預購與截止日](${abs('/closing/')})
- [新上架的預購](${abs('/new/')})
- [依作品找預購](${abs('/series/')})
- [依系列找預購](${abs('/category/')})
- [關於本站與資料來源](${abs('/about/')})

## 訂閱

- [Atom：新開放的預購](${abs('/feed.xml')})
- [Atom：7 天內截止](${abs('/closing.xml')})
- [iCalendar：截止日行事曆](${abs('/calendar.ics')})
`);
put('/llms-full.txt', `# ${SITE.name}：開放預購中的商品

資料日期：${TODAY}（日本時間）。產生時間：${UPDATED}。來源：${SOURCES.gsc.name}。
日期是日本時間。截止日指官方商店的預購期間，「未標示」代表官方沒有公布。是否提前結束以官方商品頁為準。

| 預購截止日 | 剩餘天數 | 商品名稱 | 作品 | 系列 | 價格（日圓） | 再販 | 本站頁面 | 官方頁面 |
|---|---|---|---|---|---|---|---|---|
${[...dated, ...undated].map((i) => `| ${i.preorderEnd || '未標示'} | ${i.left ?? ''} | ${md(i.name)} | ${md(i.series)} | ${md(i.category)} | ${i.priceJpy ?? ''} | ${i.isRerelease ? '是' : ''} | ${abs(i.path)} | ${i.url} |`).join('\n')}
`);

const atom = (path, title, entries) => `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="zh-Hant-TW">
<title>${esc(title)}</title>
<id>${abs(path)}</id>
<link rel="self" href="${abs(path)}"/>
<link rel="alternate" type="text/html" href="${abs('/')}"/>
<updated>${UPDATED}</updated>
<author><name>${esc(SITE.name)}</name></author>
${entries.map((e) => `<entry><title>${esc(e.title)}</title><id>${esc(e.id)}</id><link href="${esc(e.link)}"/><updated>${e.updated}</updated><summary>${esc(e.summary)}</summary></entry>`).join('\n')}
</feed>
`;
const summaryOf = (i) =>
  [i.series && `作品：${i.series}`, i.priceJpy && `價格：${yen(i.priceJpy)}`, i.preorderEnd ? `預購截止：${fmtDate(i.preorderEnd)}（日本時間）` : '官方未標示截止日'].filter(Boolean).join('／');
put('/feed.xml', atom('/feed.xml', `${SITE.name}：新開放的預購`, newest.slice(0, 60).map((i) => ({
  title: `${i.isRerelease ? '【再販】' : ''}${i.name}`, id: abs(i.path), link: abs(i.path),
  updated: `${startOf(i)}T00:00:00+09:00`, summary: summaryOf(i),
}))));
put('/closing.xml', atom('/closing.xml', `${SITE.name}：7 天內截止的預購`, closingSoon.map((i) => ({
  title: `${i.left === 0 ? '今天截止' : i.left === 1 ? '明天截止' : `剩 ${i.left} 天`}：${i.name}`,
  id: `${abs(i.path)}#closing-${i.preorderEnd}`, link: abs(i.path),
  updated: `${addDays(i.preorderEnd, -7)}T00:00:00+09:00`, summary: summaryOf(i),
}))));

// iCalendar: one all-day event per deadline date.
{
  const fold = (line) => {
    const out = [];
    let cur = '';
    let bytes = 0;
    for (const ch of line) {
      const b = Buffer.byteLength(ch);
      if (bytes + b > 73) {
        out.push(cur);
        cur = ' ';
        bytes = 1;
      }
      cur += ch;
      bytes += b;
    }
    out.push(cur);
    return out.join('\r\n');
  };
  const ics = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  const stamp = UPDATED.replace(/[-:]/g, '').replace(/\.\d+/, '');
  const days = new Map();
  for (const i of dated) {
    if (!days.has(i.preorderEnd)) days.set(i.preorderEnd, []);
    days.get(i.preorderEnd).push(i);
  }
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//${SITE.nameEn}//Preorder deadlines//ZH`, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${ics(SITE.name)} 預購截止日`, 'X-WR-TIMEZONE:Asia/Tokyo', 'REFRESH-INTERVAL;VALUE=DURATION:PT12H', 'X-PUBLISHED-TTL:PT12H'];
  for (const [d, list] of days) {
    const shown = list.slice(0, 40);
    lines.push('BEGIN:VEVENT', `UID:deadline-${d}@${new URL(SITE.url).hostname}`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${d.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${addDays(d, 1).replace(/-/g, '')}`,
      `SUMMARY:${ics(`預購截止 ${list.length} 件：${list[0].name}${list.length > 1 ? ' 等' : ''}`)}`,
      `DESCRIPTION:${ics(`${shown.map((i) => `・${i.name}${i.priceJpy ? ` ${yen(i.priceJpy)}` : ''}\n${abs(i.path)}`).join('\n')}${list.length > shown.length ? `\n…共 ${list.length} 件` : ''}\n\n日期為日本時間，以官方商品頁為準。`)}`,
      `URL:${abs('/closing/')}`, 'TRANSP:TRANSPARENT', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  put('/calendar.ics', lines.map(fold).join('\r\n') + '\r\n');
}

put('/robots.txt', `# ${SITE.name}: search engines and AI agents are welcome.
User-agent: *
Allow: /

Sitemap: ${abs('/sitemap.xml')}
`);
put('/sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map((p) => `<url><loc>${abs(p.path)}</loc><lastmod>${p.lastmod}</lastmod></url>`).join('\n')}
</urlset>
`);
put('/.nojekyll', '');
if (SITE.indexNowKey) put(`/${SITE.indexNowKey}.txt`, SITE.indexNowKey);

// ---------- write ----------
await rm(OUT, { recursive: true, force: true });
for (const [path, body] of files) {
  const file = OUT + path;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, body);
}
await mkdir(`${OUT}/assets`, { recursive: true });
await copyFile(`${ROOT}/site/style.css`, `${OUT}/assets/style.css`);
await copyFile(`${ROOT}/site/app.js`, `${OUT}/assets/app.js`);
await writeFile(`${OUT}/urls.txt`, pages.map((p) => abs(p.path)).join('\n') + '\n');
console.log(`built ${files.size} files: ${open.length} open items, ${closingSoon.length} closing within 7 days, ${series.length} series, ${categories.length} categories`);
