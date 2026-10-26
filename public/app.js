/* 公共工具：请求、渲染卡片、顶栏、提示 */

const API = '/api';

/**
 * 设置了 UPDATE_TOKEN 时，更新接口要带令牌。
 * 用户打开 settings.html?token=xxx 后，这里自动把令牌带到所有 /api/update/* 请求。
 */
function withUpdateToken(path) {
  if (!path.startsWith('/update/')) return path;
  const t = new URLSearchParams(location.search).get('token');
  if (!t) return path;
  return `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(t)}`;
}

/** 带错误处理的 JSON 请求 */
async function api(path, options) {
  const res = await fetch(API + withUpdateToken(path), options);
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`接口返回异常 (HTTP ${res.status})`);
  }
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `请求失败 (HTTP ${res.status})`);
  }
  return data;
}

/** 转义，防止采集站返回的内容注入 HTML */
function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 渐进式补封面。
 *
 * 采集站的列表接口（ac=list）不带封面，补封面要再打一次上游接口，
 * 而那个接口实测会抖动（4~8s+）。所以流程是：
 *   1. 列表先渲染出来（只有片名，无图）
 *   2. 再异步请求 /api/covers 补图和年份
 *
 * 这样页面不会为了等封面而白屏。
 *
 * @param {Array} items 列表数据（会被就地修改）
 * @param {string} source 默认片源 id（列表页用；搜索结果里每条自带 source）
 * @param {Function} rerender 补完之后重新渲染的回调
 */
async function enrichCovers(items, source, rerender) {
  const need = items.filter((it) => !it.pic && it.id);
  if (need.length === 0) return;

  // 搜索结果可能来自多个源，按 source 分组请求
  const bySource = new Map();
  for (const it of need) {
    const s = it.source || source || '';
    if (!bySource.has(s)) bySource.set(s, []);
    bySource.get(s).push(it);
  }

  let changed = false;

  for (const [src, group] of bySource) {
    const ids = group.slice(0, 100).map((it) => it.id).join(',');
    try {
      const r = await api(`/covers?ids=${encodeURIComponent(ids)}&source=${encodeURIComponent(src)}`);
      const covers = r.covers || {};
      for (const it of group) {
        const c = covers[it.id];
        if (!c) continue;
        if (!it.pic && c.pic) { it.pic = c.pic; changed = true; }
        if (!it.year && c.year) { it.year = c.year; changed = true; }
        if (!it.area && c.area) { it.area = c.area; changed = true; }
        if (!it.remarks && c.remarks) { it.remarks = c.remarks; changed = true; }
      }
    } catch {
      // 某个源失败无所谓，其他源继续补
    }
  }

  if (changed && typeof rerender === 'function') rerender(items);
}

/** 封面：直连优先；直连失败（被墙/防盗链）时回退本机代理 */
function imgAttrs(url) {
  if (!url) return '';
  const direct = esc(url);
  const proxied = esc(`${API}/proxy?url=${encodeURIComponent(url)}`);
  // onerror 里把 src 换成代理，并清掉 onerror 防止无限循环
  return `src="${direct}" data-direct="${direct}" data-proxied="${proxied}" onerror="if(this.dataset.proxied&&this.src!==this.dataset.proxied){this.src=this.dataset.proxied}else{this.onerror=null}"`;
}

/** 兼容旧调用（详情页等处直接取代理地址） */
function imgSrc(url) {
  if (!url) return '';
  return `${API}/proxy?url=${encodeURIComponent(url)}`;
}

/**
 * 详情页封面：占位底 + 图片。
 *
 * 占位块（片名首字）垫在图片下面：没有封面、或者图 404 被 onerror 移除之后，
 * 露出的是占位而不是一块空灰 —— 原来 `onerror` 直接 `display:none`，留下 200×300 的空白。
 * 外层 `.poster-lg` 已固定 2:3 比例，所以这里不需要再管尺寸。
 */
function posterHTML(pic, name) {
  const ini = esc((name || '?').trim().slice(0, 1) || '?');
  if (!pic) return `<div class="poster-ph">${ini}</div>`;
  // 影视仓那边给的是本站地址（/api/dyrs/site/img?id=…），别再包一层代理
  const src = pic.startsWith('/') ? pic : imgSrc(pic);
  return `<div class="poster-ph">${ini}</div><img src="${esc(src)}" alt="" loading="lazy" onerror="this.remove()">`;
}

/**
 * 展开 / 收起一段被 clamp 的文本（主演、简介共用）。
 *
 * 依赖 CSS：`.clamp-2`（主演 2 行）与 `.plot`（简介 3 行）默认折叠，
 * 加上 `.expanded` 就展开。两个详情页共用这个函数，所以放在 app.js。
 */
function toggleClamp(id, btn, moreText, lessText) {
  const el = document.getElementById(id);
  if (!el) return;
  const open = !el.classList.contains('expanded');
  el.classList.toggle('expanded', open);
  if (btn) btn.textContent = open ? lessText : moreText;
}

/** 详情页地址 */
function detailHref(item) {
  return `detail.html?id=${encodeURIComponent(item.id)}&source=${encodeURIComponent(item.source)}&name=${encodeURIComponent(item.name)}`;
}

/** 播放页地址 */
function playHref(item, lineIndex, epIndex, line) {
  const p = new URLSearchParams({
    id: item.id,
    source: item.source,
    name: item.name,
    line: String(lineIndex),
    ep: String(epIndex),
  });
  // 线路是跨源聚合来的，条数会随源可用性变化；把线路名+源一起带上，
  // 播放页就能按「名字」定位而不是靠下标（否则会指到别的线路）
  if (line) {
    p.set('ln', line.name);
    if (line.source) p.set('ls', line.source);
  }
  if (item.pic) p.set('pic', item.pic);
  if (item.year) p.set('year', item.year);
  return `play.html?${p.toString()}`;
}

/** 渲染一部片的卡片（样式保持不变，只补封面与年份） */
function renderCard(item) {
  const poster = item.pic
    ? `<img class="poster" ${imgAttrs(item.pic)} alt="${esc(item.name)}" loading="lazy">`
    : `<div class="poster-ph">${esc(item.name)}</div>`;

  const bits = [];
  if (item.year) bits.push(esc(item.year));
  if (item.area) bits.push(esc(item.area));
  if (item.remarks) bits.push(esc(item.remarks));

  const score = item.score && Number(item.score) > 0
    ? `<span class="badge score">${esc(item.score)}</span>`
    : '';

  return `
    <div class="card" onclick="location.href='${detailHref(item)}'">
      ${poster}
      <div class="meta">
        <div class="title" title="${esc(item.name)}">${esc(item.name)}</div>
        <div class="sub">${score}${bits.join(' · ')}</div>
      </div>
    </div>`;
}

/**
 * 顶栏。
 *
 * 频道顺序与后端 CHANNEL_ORDER 一致，只显示实际有内容的频道。
 * 分类不再放在顶栏，而是首页的频道内分类行。
 */
function renderTopbar(active) {
  const links = [
    ['index.html', '首页'],
    ['dyrs.html', '影视仓'],
    ['index.html?ch=电影', '电影'],
    ['index.html?ch=电视剧', '电视剧'],
    ['index.html?ch=综艺', '综艺'],
    ['index.html?ch=动漫', '动漫'],
    ['index.html?ch=体育', '体育'],
    ['favorites.html', '收藏'],
    ['history.html', '历史'],
    ['local.html', '本地媒体'],
    ['settings.html', '设置'],
  ];

  const nav = links
    .map(([href, label]) => {
      const isActive = active && href === active ? ' class="active"' : '';
      return `<a href="${href}"${isActive}>${label}</a>`;
    })
    .join('');

  const wd = new URLSearchParams(location.search).get('wd') || '';

  return `
    <header class="topbar">
      <div class="logo">影视播放站</div>
      <nav class="main">${nav}</nav>
      <form class="searchbox" onsubmit="doSearch(event)">
        <input id="q" type="search" placeholder="搜索片名 / 演员…" value="${esc(wd)}" autocomplete="off">
        <button class="primary" type="submit">搜索</button>
      </form>
    </header>`;
}

/**
 * 顶栏搜索。
 *
 * 默认搜的是本站主库（macCMS 那批源）；影视仓页面会先把 `window.__searchBase`
 * 设成 `dyrs.html?wd=`，这样在影视仓里搜索就只搜影视仓，不会跳回主库。
 */
function doSearch(e) {
  e.preventDefault();
  const wd = document.getElementById('q').value.trim();
  if (!wd) return;
  const base = window.__searchBase || 'index.html';
  const sep = base.includes('?') ? '&' : '?';
  location.href = `${base}${sep}wd=${encodeURIComponent(wd)}`;
}

/** 轻提示 */
let toastTimer;
function toast(msg, ms = 2000) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/** 秒 → 时间文本 */
function fmtTime(sec) {
  if (!sec || !isFinite(sec) || sec < 0) return '00:00';
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 挂载顶栏 */
function mountTopbar(active) {
  document.body.insertAdjacentHTML('afterbegin', renderTopbar(active));
}
