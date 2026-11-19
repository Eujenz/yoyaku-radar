// Probe the live site from the outside. Exit code 1 (with a human-readable report on stdout) when anything is wrong.
// Usage: SITE_URL=https://... [GITHUB_REPOSITORY=owner/repo] [GITHUB_TOKEN=...] node scripts/monitor.mjs
const site = (process.env.SITE_URL || 'https://yoyaku.fans').replace(/\/+$/, '');
const repo = process.env.GITHUB_REPOSITORY || 'Eujenz/yoyaku-radar';
const MAX_AGE_HOURS = Number(process.env.MAX_AGE_HOURS || 24);
const problems = [];

async function get(url, headers = {}) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'YoyakuBot-monitor', ...headers }, signal: AbortSignal.timeout(20000) });
    return { status: res.status, res };
  } catch (e) {
    return { status: 0, error: String(e.cause?.code || e.message) };
  }
}

for (const path of ['/', '/api/preorders.json']) {
  const r = await get(site + path);
  if (r.status !== 200) problems.push(`${site}${path} 回應 ${r.status || '無法連線'}${r.error ? `（${r.error}）` : ''}`);
  else if (path.endsWith('.json')) {
    try {
      const data = await r.res.json();
      const age = (Date.now() - Date.parse(data.generated_at)) / 36e5;
      if (!(age >= 0 && age <= MAX_AGE_HOURS)) problems.push(`api/preorders.json 的 generated_at（${data.generated_at}）距今 ${Number.isFinite(age) ? age.toFixed(1) : '?'} 小時，超過 ${MAX_AGE_HOURS} 小時`);
    } catch {
      problems.push('api/preorders.json 不是有效的 JSON');
    }
  }
}

// has_pages=false is what took the site down on 2026-11-17.
const headers = { accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };
const api = await get(`https://api.github.com/repos/${repo}`, headers);
if (api.status === 200) {
  const info = await api.res.json();
  if (info.has_pages === false) problems.push('repo 的 has_pages 是 false：到 Settings → Pages，把 Source 選成「GitHub Actions」');
} else {
  console.log(`(略過 has_pages 檢查：GitHub API 回應 ${api.status})`);
}

if (problems.length) {
  console.log('網站異常：\n' + problems.map((p) => `- ${p}`).join('\n'));
  process.exit(1);
}
console.log(`OK：${site} 正常`);
