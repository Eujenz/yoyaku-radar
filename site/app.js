// Yoyaku front-end: favourites ("my cabinet"), live countdowns, shelf filters, since-last-visit badges.
// Everything here is an enhancement; every page is complete without it.
(function () {
  'use strict';
  var BASE = document.body.dataset.base || '';
  var KEY = 'yoyaku:favs';
  var VISIT = 'yoyaku:lastVisit';
  var HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';

  function read(key, fallback) {
    try {
      var v = JSON.parse(localStorage.getItem(key));
      return v === null || v === undefined ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }
  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {}
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function todayJst() {
    var n = new Date(Date.now() + 9 * 36e5);
    return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
  }
  function daysLeft(end, at) {
    if (!end) return null;
    if (at && Date.now() >= Date.parse(at)) return -1;
    return Math.round((Date.parse(end + 'T00:00:00Z') - todayJst()) / 864e5);
  }
  function chipHtml(end, at) {
    var d = daysLeft(end, at);
    if (d === null) return '<span class="chip unknown">截止日未標示</span>';
    var cls = d < 0 ? ' closed' : d <= 3 ? ' urgent' : d <= 7 ? ' soon' : '';
    var label = d < 0 ? '預購已截止' : d === 0 ? '今天截止' : d === 1 ? '明天截止' : '剩 ' + d + ' 天';
    return '<span class="chip' + cls + '">' + label + '</span>';
  }
  function yen(n) {
    return '¥' + Number(n).toLocaleString('en-US');
  }

  // ---- countdown chips stay correct between site rebuilds ----
  document.querySelectorAll('.chip[data-end]').forEach(function (c) {
    var tmp = document.createElement('span');
    tmp.innerHTML = chipHtml(c.dataset.end, c.dataset.at);
    c.className = tmp.firstChild.className;
    c.textContent = tmp.firstChild.textContent;
  });

  // ---- live clock on item pages and the spotlight ----
  var clocks = [].slice.call(document.querySelectorAll('.clock[data-at]'));
  function tick() {
    clocks.forEach(function (el) {
      var ms = Date.parse(el.dataset.at) - Date.now();
      if (ms <= 0) {
        el.outerHTML = '<span class="chip closed">預購已截止</span>';
        return;
      }
      var s = Math.floor(ms / 1000);
      var parts = [Math.floor(s / 86400), Math.floor((s % 86400) / 3600), Math.floor((s % 3600) / 60), s % 60];
      el.querySelectorAll('b').forEach(function (b, i) {
        b.textContent = i === 0 ? parts[i] : String(parts[i]).padStart(2, '0');
      });
    });
    clocks = clocks.filter(function (el) { return el.isConnected; });
  }
  if (clocks.length) {
    tick();
    setInterval(tick, 1000);
  }

  // ---- favourites ----
  var favs = read(KEY, {});
  if (!favs || typeof favs !== 'object' || Array.isArray(favs)) favs = {};
  function snapshot(el) {
    var d = el.dataset;
    return { n: d.name, t: d.thumb || '', p: Number(d.price) || 0, e: d.end || '', a: d.at || '', u: d.path, s: d.series || '' };
  }
  function updateCount() {
    var n = Object.keys(favs).length;
    document.querySelectorAll('.js-fav-count').forEach(function (el) {
      el.textContent = n;
      el.hidden = n === 0;
    });
  }
  function paint(btn) {
    var on = !!favs[btn.closest('[data-id]').dataset.id];
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    var label = btn.querySelector('.fav-label');
    if (label) label.textContent = on ? '已放進我的展示櫃' : '放進我的展示櫃';
  }
  function bindFavs(root) {
    root.querySelectorAll('.fav').forEach(function (btn) {
      var host = btn.closest('[data-id]');
      if (favs[host.dataset.id] && host.dataset.name) favs[host.dataset.id] = snapshot(host); // refresh stored copy
      paint(btn);
      btn.addEventListener('click', function () {
        var id = host.dataset.id;
        if (favs[id]) delete favs[id];
        else favs[id] = snapshot(host);
        write(KEY, favs);
        document.querySelectorAll('[data-id="' + id + '"] .fav').forEach(paint);
        updateCount();
        document.dispatchEvent(new CustomEvent('yoyaku:favs'));
      });
    });
  }
  bindFavs(document);
  write(KEY, favs);
  updateCount();

  function caseHtml(id, f) {
    return '<li class="case" data-id="' + esc(id) + '" data-name="' + esc(f.n) + '" data-thumb="' + esc(f.t) + '" data-price="' + (f.p || 0) + '" data-end="' + esc(f.e) + '" data-at="' + esc(f.a) + '" data-path="' + esc(f.u) + '" data-series="' + esc(f.s) + '">' +
      '<a class="case-link" href="' + esc(BASE + f.u) + '">' +
      '<span class="case-img' + (f.t ? '' : ' empty') + '">' + (f.t ? '<img src="' + esc(f.t) + '" alt="" width="300" height="300" loading="lazy" referrerpolicy="no-referrer">' : '') + '</span>' +
      '<span class="case-tags">' + chipHtml(f.e, f.a) + '</span>' +
      '<span class="case-name" lang="ja">' + esc(f.n) + '</span>' +
      '<span class="case-meta"><span lang="ja">' + esc(f.s) + '</span>' + (f.p ? '<span class="num">' + yen(f.p) + '</span>' : '') + '</span></a>' +
      '<button class="fav" type="button" aria-pressed="true" aria-label="從我的展示櫃移除 ' + esc(f.n) + '">' + HEART + '</button></li>';
  }
  function sortedFavIds() {
    return Object.keys(favs).sort(function (a, b) {
      return (favs[a].e || '9999').localeCompare(favs[b].e || '9999');
    });
  }

  // ---- "my cabinet" strip on the home page and the full cabinet page ----
  function renderCabinet() {
    var strip = document.getElementById('my-cabinet');
    var full = document.getElementById('cabinet');
    var ids = sortedFavIds();
    if (strip) {
      strip.hidden = ids.length === 0;
      if (ids.length) {
        var urgent = ids.filter(function (id) { var d = daysLeft(favs[id].e, favs[id].a); return d !== null && d >= 0 && d <= 7; }).length;
        strip.querySelector('.js-cabinet-note').textContent = urgent ? '你收藏的商品有 ' + urgent + ' 件在 7 天內截止。' : '你收藏了 ' + ids.length + ' 件商品，7 天內沒有要截止的。';
        var ul = strip.querySelector('.shelf');
        ul.innerHTML = ids.slice(0, 6).map(function (id) { return caseHtml(id, favs[id]); }).join('');
        bindFavs(ul);
      }
    }
    if (full) {
      var open = ids.filter(function (id) { var d = daysLeft(favs[id].e, favs[id].a); return d === null || d >= 0; });
      var total = open.reduce(function (sum, id) { return sum + (favs[id].p || 0); }, 0);
      full.querySelector('.js-empty').hidden = ids.length > 0;
      full.querySelector('.js-filled').hidden = ids.length === 0;
      full.querySelector('.js-total-count').textContent = ids.length;
      full.querySelector('.js-total-price').textContent = yen(total);
      var next = open.filter(function (id) { return favs[id].e; })[0];
      full.querySelector('.js-next').textContent = next ? favs[next].e.replace(/-/g, '/') : '—';
      var list = full.querySelector('.shelf');
      list.innerHTML = ids.map(function (id) { return caseHtml(id, favs[id]); }).join('');
      bindFavs(list);
    }
  }
  if (document.getElementById('my-cabinet') || document.getElementById('cabinet')) {
    renderCabinet();
    document.addEventListener('yoyaku:favs', function () {
      if (document.getElementById('cabinet')) renderCabinet();
    });
  }
  // The cabinet page refreshes stored copies from the open data file, so dates never go stale.
  var cab = document.getElementById('cabinet');
  if (cab && Object.keys(favs).length && window.fetch) {
    fetch(BASE + '/api/preorders.json').then(function (r) { return r.json(); }).then(function (data) {
      var byId = {};
      data.items.forEach(function (i) { byId[i.id] = i; });
      Object.keys(favs).forEach(function (id) {
        var i = byId[id];
        if (i) favs[id] = { n: i.name, t: i.thumbnail_url || '', p: i.price_jpy || 0, e: i.preorder_end || '', a: i.preorder_end_at || '', u: '/item/' + id + '/', s: i.series || '' };
        else if (!favs[id].e) favs[id].e = '1970-01-01'; // no longer listed as open
      });
      write(KEY, favs);
      renderCabinet();
    }).catch(function () {});
  }

  // ---- since your last visit ----
  // Stored as { cur: today's date, prev: the day of the visit before }, so badges last the whole return day.
  var now = new Date(Date.now() + 9 * 36e5).toISOString().slice(0, 10);
  var visit = read(VISIT, null);
  if (!visit || typeof visit !== 'object' || !visit.cur) visit = { cur: now, prev: null };
  else if (visit.cur < now) visit = { cur: now, prev: visit.cur };
  write(VISIT, visit);
  if (visit.prev) {
    var fresh = 0;
    document.querySelectorAll('.case[data-start]').forEach(function (li) {
      if (li.dataset.start && li.dataset.start > visit.prev) {
        li.classList.add('is-new');
        fresh++;
      }
    });
    var since = document.getElementById('since');
    if (since && fresh) {
      since.textContent = '你上次來訪之後，這一頁新增了 ' + fresh + ' 件預購，已標上 NEW。';
      since.hidden = false;
    }
  }

  // ---- shelf tools: search, filter, sort ----
  var tools = document.getElementById('shelf-tools');
  if (tools) {
    var shelf = document.querySelector(tools.dataset.target);
    var cases = [].slice.call(shelf.children);
    var input = document.getElementById('filter');
    var sort = document.getElementById('sort');
    var count = document.getElementById('filter-count');
    var mode = 'all';
    var tests = {
      all: function () { return true; },
      d3: function (li) { var d = daysLeft(li.dataset.end, li.dataset.at); return d !== null && d >= 0 && d <= 3; },
      d7: function (li) { var d = daysLeft(li.dataset.end, li.dataset.at); return d !== null && d >= 0 && d <= 7; },
      re: function (li) { return 're' in li.dataset; },
      bonus: function (li) { return 'bonus' in li.dataset; },
      fav: function (li) { return !!favs[li.dataset.id]; },
    };
    var sorters = {
      end: function (a, b) { return (a.dataset.end || '9999').localeCompare(b.dataset.end || '9999'); },
      'new': function (a, b) { return (b.dataset.start || '').localeCompare(a.dataset.start || ''); },
      'price-asc': function (a, b) { return (Number(a.dataset.price) || 1e12) - (Number(b.dataset.price) || 1e12); },
      'price-desc': function (a, b) { return Number(b.dataset.price) - Number(a.dataset.price); },
    };
    var apply = function () {
      var q = input.value.trim().toLowerCase();
      var shown = 0;
      cases.forEach(function (li) {
        var ok = tests[mode](li) && (!q || li.dataset.k.indexOf(q) >= 0);
        li.hidden = !ok;
        if (ok) shown++;
      });
      count.textContent = shown === cases.length ? '共 ' + shown + ' 件' : '符合 ' + shown + ' 件（共 ' + cases.length + ' 件）';
    };
    input.addEventListener('input', apply);
    tools.querySelectorAll('.seg button').forEach(function (b) {
      b.addEventListener('click', function () {
        mode = b.dataset.f;
        tools.querySelectorAll('.seg button').forEach(function (o) { o.setAttribute('aria-pressed', o === b ? 'true' : 'false'); });
        apply();
      });
    });
    sort.addEventListener('change', function () {
      cases.sort(sorters[sort.value]).forEach(function (li) { shelf.appendChild(li); });
    });
    document.addEventListener('yoyaku:favs', function () { if (mode === 'fav') apply(); });
    apply();
  }

  // ---- broken thumbnails fall back to a labelled empty case ----
  document.addEventListener('error', function (e) {
    var img = e.target;
    if (img.tagName === 'IMG' && img.parentNode.classList.contains('case-img')) {
      img.parentNode.classList.add('empty');
      img.remove();
    }
  }, true);
})();
