/**
 * 播放器逻辑。
 *
 * 播放策略：优先让浏览器直连 CDN（这些 CDN 都返回 Access-Control-Allow-Origin: *），
 * 直连失败时自动回落到本机代理。
 */

const params = new URLSearchParams(location.search);
const videoId = params.get('id') || '';
const source = params.get('source') || '';
const name = params.get('name') || '';
const pic = params.get('pic') || '';
const year = params.get('year') || '';

let lineIndex = Number(params.get('line') || 0);
let epIndex = Number(params.get('ep') || 0);
/**
 * 线路的「名字 + 源」。
 *
 * 主库线路是跨源聚合的（同一部片在 lziapi / ffzy / dytt 各有一条），
 * 而某个源某次超时缺席时，聚合后的线路条数会变 —— 只按 `line` 下标定位，
 * 刷新或换设备后就会指到别的线路上。所以优先按名字+源定位，下标只作兜底。
 */
const wantLineName = params.get('ln') || '';
const wantLineSource = params.get('ls') || '';

/* ---------------- 影视仓（dyrs）分支 ---------------- */

/**
 * source=dyrs 时走一条**完全独立**的取流链路，macCMS 那套一点不动：
 *
 *   详情 / 全部线路的选集 ← GET /api/dyrs/site/detail?id=&kind=&ep=1
 *                           （服务端逐条线路抓镜像站，按「真实 m3u8 优先」排好序）
 *   选集地址              ← 详情里直接带好（本站同源：/api/proxy?url=… 或
 *                           /api/dyrs/m3u8?proxy=1&…），失败时可回落 302 跳板
 *                           /api/dyrs/src?kind=&id=&seq=&origin=&p= 重新解析一次
 *
 * 这条链路**整条都是同源的**，所以：
 *   1. 不再包 /api/hls —— 那是把「上游地址」抓回来的通道，拿本站地址过去只会多一跳；
 *   2. 不做「直连失败回落本机代理」—— 同源没有跨域/防盗链问题，回落纯属帮倒忙；
 *   3. 分片超时放宽到 45s（1080p 单分片约 2MB，hls.js 默认 20s 会先超时）。
 */
const isDyrs = source === 'dyrs';
const dyrsKind = params.get('kind') || 'tv';
const dyrsOrigin = params.get('origin') || '';
const dyrsP = params.get('p') || '';
/** 影视仓取流失败的原始报错，展示到弹层上 */
let dyrsError = '';
/** 选集块编号（同一部片固定），回落跳板要用 */
let dyrsSeq = '1';
/** 本集是否已经试过「用 302 跳板重新解析」 */
let dyrsFallbackTried = false;
/** 影视仓：已尝试过的档位切换次数（上游 master 常给多条 CDN，vip1 会间歇性失败） */
let dyrsLevelTries = 0;

let detail = null;      // 完整详情
let hls = null;         // hls.js 实例
let usingProxy = false; // 当前是否走代理
let lastSaved = 0;      // 上次保存进度的时间戳
let pendingSeek = 0;    // 待恢复的播放位置
let ui = null;          // 自绘播放器 UI 句柄

/**
 * 采集站的 CDN 常校验 Referer、或压根不开 CORS，浏览器直连分片就是取不到。
 * 一旦确认必须走代理，就在本次会话里记住，后面换集直接走代理，
 * 不再每集都重试直连、也不再反复弹「直连失败」的提示。
 *
 * 键名带 v2：旧版默认走 /api/hls，曾经把 mpProxySticky 记成 1；
 * 现在默认改为客户端直连，必须让旧记忆失效，否则用户会一直卡在代理链路上。
 */
let proxySticky = false;
try { proxySticky = sessionStorage.getItem('mpProxyStickyV2') === '1'; } catch { /* 隐私模式 */ }
function setProxySticky(v) {
  proxySticky = v;
  try { sessionStorage.setItem('mpProxyStickyV2', v ? '1' : '0'); } catch { /* ignore */ }
}
/** 本集「媒体错误原地恢复」已用次数：换代理解决不了解码/缓冲问题，先 recover 再说 */
let mediaRecoverTries = 0;

/* ---------------- 播放设置（开关 + 片头片尾标记） ---------------- */

let marker = null;          // { intro, outro } 同剧通用，服务端记忆
let introSkipped = false;   // 本集片头是否已自动跳过（只跳一次）
let outroSkipped = false;   // 本集片尾是否已自动跳过

const skipToggle = document.getElementById('skipToggle');
const autoNextToggle = document.getElementById('autoNextToggle');
skipToggle.checked = localStorage.getItem('set_skipIntro') !== '0';
autoNextToggle.checked = localStorage.getItem('set_autoNext') !== '0';
skipToggle.onchange = () => {
  localStorage.setItem('set_skipIntro', skipToggle.checked ? '1' : '0');
  toast(skipToggle.checked ? '已开启跳过片头片尾' : '已关闭跳过片头片尾');
};
autoNextToggle.onchange = () => {
  localStorage.setItem('set_autoNext', autoNextToggle.checked ? '1' : '0');
  toast(autoNextToggle.checked ? '已开启自动连播' : '已关闭自动连播');
};

const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const overlayInner = document.getElementById('overlayInner');

/* ---------------- 影视仓详情适配 ---------------- */

/** 影视仓的取流跳板地址：按 origin + 集序号现解析一次（取流地址可能带时效，重试时用它） */
function dyrsJumpUrl(ep) {
  const p = new URLSearchParams({ kind: dyrsKind, id: videoId, seq: dyrsSeq || '1', p: String(ep.p ?? 0) });
  if (ep.origin) p.set('origin', ep.origin);
  return `${location.origin}/api/dyrs/src?${p.toString()}`;
}

/**
 * 把影视仓详情折成播放器认识的那套 detail 结构
 * （lines[].episodes[].url 就是 macCMS 里「这一集的 m3u8 地址」那个位置）。
 *
 * 服务器已经做了两件重活：
 *   1. 逐条线路抓齐选集（上游是按 ?origin= 服务端渲染的，不抓就只有线路名）；
 *   2. 把「上游直接给真实 m3u8」的线路排到前面（dyrs 自家 CDN 那条要绕 raw=1，慢且易抽）。
 */
async function fetchDyrsDetail() {
  const p = new URLSearchParams({ id: videoId, kind: dyrsKind, ep: '1' });
  const r = await api(`/dyrs/site/detail?${p.toString()}`);
  const d = r.detail;
  if (!d) throw new Error('影视仓没有返回详情');
  dyrsSeq = d.seq || '1';

  const lines = [];
  for (const o of (d.origins || [])) {
    if (!o.episodes || o.episodes.length === 0) continue;
    const idx = lines.length + 1;
    lines.push({
      name: `线路 ${idx} · ${o.origin}`,
      playable: true,
      origin: o.origin,
      originKind: o.kind || 'dyrs',
      episodes: o.episodes.map((e) => ({
        name: e.title || `第 ${e.p + 1} 集`,
        p: Number(e.p) || 0,
        origin: e.origin || o.origin,
        url: e.src || dyrsJumpUrl({ p: e.p, origin: o.origin }),
      })),
    });
  }
  if (lines.length === 0) throw new Error('这一部还没有可用的片源线路');

  return {
    id: d.id || videoId,
    source: 'dyrs',
    sourceName: '影视仓',
    name: d.name || name,
    // 封面走站内图片代理，存进历史/收藏后也能正常显示
    pic: d.id ? `${API}/dyrs/site/img?id=${encodeURIComponent(d.id)}` : '',
    year: d.year || year,
    area: d.area || '',
    lang: d.language || '',
    typeName: (d.genre || []).join(' / '),
    remarks: '',
    score: d.score || '',
    sub: d.alias || '',
    director: d.director || '',
    actor: (d.actors || []).join(' / '),
    content: d.description || '',
    lines,
  };
}

/* ---------------- 启动 ---------------- */

async function boot() {
  if (!videoId) {
    showOverlay('缺少片目参数', true);
    return;
  }

  showOverlay('<span class="spinner"></span> 正在加载…');

  if (isDyrs) {
    try {
      detail = await fetchDyrsDetail();
    } catch (e) {
      detail = null;
      dyrsError = e instanceof Error ? e.message : String(e);
    }
  } else {
    try {
      // 带上 name 让后端校验，避免各源 vod_id 撞车取到别的片
      const res = await api(`/detail?id=${encodeURIComponent(videoId)}&source=${encodeURIComponent(source)}&name=${encodeURIComponent(name)}`);
      detail = res.detail;
    } catch {
      detail = null;
    }

    // 换源失败时按名字再找一次
    if ((!detail || !detail.lines || detail.lines.length === 0) && name) {
      try {
        const r2 = await api(`/detail-by-name?name=${encodeURIComponent(name)}&source=${encodeURIComponent(source)}${year ? `&year=${encodeURIComponent(year)}` : ''}`);
        if (r2.detail && r2.detail.lines && r2.detail.lines.length > 0) detail = r2.detail;
      } catch {
        // 保留原结果
      }
    }
  }

  if (!detail || !detail.lines || detail.lines.length === 0) {
    showOverlay(
      isDyrs
        ? `影视仓取流失败${dyrsError ? '：' + esc(dyrsError) : ''}<br>回影视仓换一条线路或换一部片试试。`
        : '这个片源没有可用的播放地址，试试在详情页切换其他线路。',
      true,
    );
    return;
  }

  // 校正索引，避免 URL 里的越界值
  lineIndex = Math.min(Math.max(0, lineIndex), detail.lines.length - 1);

  // 主库：URL 里带了线路名（+源）就按它定位，别信下标 —— 聚合结果会随源可用性变化
  if (!isDyrs && wantLineName) {
    const hit = detail.lines.findIndex(
      (l) => l.name === wantLineName && (!wantLineSource || l.source === wantLineSource),
    );
    if (hit >= 0) lineIndex = hit;
  }
  // 定位变了就把正确的下标写回 URL（分享出去的链接才准）
  updateUrl();

  // 影视仓：URL 里带的是线路**名字**和集序号，优先按它们定位（刷新/分享链接都不怕索引错位）
  if (isDyrs && dyrsOrigin) {
    const byOrigin = detail.lines.findIndex((l) => l.origin === dyrsOrigin);
    if (byOrigin >= 0) {
      lineIndex = byOrigin;
      const byP = dyrsP !== '' ? detail.lines[byOrigin].episodes.findIndex((e) => String(e.p) === dyrsP) : -1;
      epIndex = byP >= 0 ? byP : 0;
    }
  }

  // 如果落在不可播放的线路上（采集站给的是网页分享页），自动跳到能播的线路
  if (!detail.lines[lineIndex].playable) {
    const good = detail.lines.findIndex((l) => l.playable);
    if (good >= 0 && good !== lineIndex) {
      toast(`「${detail.lines[lineIndex].name}」是网页分享线路，已自动切换到「${detail.lines[good].name}」`);
      lineIndex = good;
      epIndex = 0;
    }
  }

  const epCount = detail.lines[lineIndex].episodes.length;
  epIndex = Math.min(Math.max(0, epIndex), Math.max(0, epCount - 1));

  // 自绘控制栏（优酷 / 腾讯视频风格）：播放/暂停、进度、上下集、倍速、音量、画中画、全屏
  // 注意要在 renderInfo 之前初始化，这样标题能直接写进播放器顶栏
  if (window.initPlayerUI) {
    ui = window.initPlayerUI(video, {
      hasEpisodes: detail.lines.some((l) => l.episodes.length > 1),
      onPrev: () => gotoOffset(-1),
      onNext: () => gotoOffset(1),
    });
  }

  renderInfo();
  renderLines();
  renderEpisodes();

  await restoreProgress();
  await restoreMarker();
  loadEpisode();

  // 定时保存进度
  setInterval(saveProgress, 5000);
}

/* ---------------- 渲染 ---------------- */

function renderInfo() {
  if (!detail || !detail.lines) return;
  document.title = `${name} - 播放`;

  const line = detail.lines[lineIndex];
  if (!line) return;
  const ep = line.episodes[epIndex];

  const titleText = `${detail.name}${ep && ep.name ? ' · ' + ep.name : ''}`;
  document.getElementById('topTitle').textContent = titleText;
  if (ui) ui.setTitle(titleText);
  document.getElementById('nowTitle').innerHTML =
    `${esc(detail.name)} <span class="dim">${esc(ep ? ep.name : '')}</span>`;

  const bits = [];
  if (detail.year) bits.push(esc(detail.year));
  if (detail.area) bits.push(esc(detail.area));
  if (detail.typeName) bits.push(esc(detail.typeName));
  bits.push(`片源: ${esc(detail.sourceName)}`);
  document.getElementById('nowMeta').innerHTML = bits.join(' · ');

  // 收藏按钮状态
  refreshFavoriteBtn();
}

function renderLines() {
  const box = document.getElementById('lineBox');
  if (!detail || !detail.lines) return;
  box.innerHTML = detail.lines
    .map((l, i) => {
      const active = i === lineIndex ? ' active' : '';
      const warn = l.playable ? '' : '<span class="warn">⚠ 网页线路</span>';
      // 主库的线路是跨源聚合来的（同名电影在多个采集站都有），带上源名才知道在切什么；
      // 影视仓的线路没有 sourceName，这里自然不显示。
      const from = l.sourceName ? `<span class="src">${esc(l.sourceName)}</span>` : '';
      return `<button class="line-item${active}" data-i="${i}" title="${esc(l.name)}${l.sourceName ? ' · ' + esc(l.sourceName) : ''}">
        <span>${esc(l.name)}${from}</span>
        <span class="cnt">${warn || l.episodes.length + ' 集'}</span>
      </button>`;
    })
    .join('');

  box.querySelectorAll('.line-item').forEach((b) => {
    b.onclick = () => {
      lineIndex = Number(b.dataset.i);
      epIndex = 0;
      // 换线路 = 换 CDN，直连说不定就通了，清掉「必须走代理」的记忆重新试一次
      setProxySticky(false);
      renderLines();
      renderEpisodes();
      renderInfo();
      updateUrl();
      loadEpisode();
      // 切线路后回到选集 tab
      switchTab('ep');
    };
  });
}

function renderEpisodes() {
  const box = document.getElementById('epBox');
  if (!detail || !detail.lines) return;
  const line = detail.lines[lineIndex];
  if (!line) return;

  box.innerHTML = line.episodes
    .map((e, i) => {
      const playing = i === epIndex ? ' playing' : '';
      return `<div class="ep${playing}" data-i="${i}" title="${esc(e.name)}">${esc(e.name)}</div>`;
    })
    .join('');

  box.querySelectorAll('.ep').forEach((el) => {
    el.onclick = () => {
      epIndex = Number(el.dataset.i);
      renderEpisodes();
      renderInfo();
      updateUrl();
      loadEpisode();
    };
  });

  // 当前集滚动到可见位置
  const cur = box.querySelector('.ep.playing');
  if (cur) cur.scrollIntoView({ block: 'nearest' });
}

/** 侧栏 tab 切换 */
function switchTab(tab) {
  document.querySelectorAll('.side-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });
  document.getElementById('epPanel').classList.toggle('hidden', tab !== 'ep');
  document.getElementById('linePanel').classList.toggle('hidden', tab !== 'line');
}

function updateUrl() {
  const p = new URLSearchParams({
    id: videoId, source, name, line: String(lineIndex), ep: String(epIndex),
  });
  // 主库线路是跨源聚合的：某个源某次超时缺席，线路列表长度就会变，
  // 只靠 line 下标刷新后可能指到别的线路上。这里把「线路名 + 源」也记进 URL。
  const curLine = detail && detail.lines ? detail.lines[lineIndex] : null;
  if (!isDyrs && curLine) {
    p.set('ln', curLine.name);
    if (curLine.source) p.set('ls', curLine.source);
  }
  // 影视仓：kind / seq 是重取详情必需的参数，origin / p 用「值」记一份，
  // 刷新或分享出去的链接就不依赖索引了
  if (isDyrs) {
    p.set('kind', dyrsKind);
    p.set('seq', dyrsSeq);
    const line = detail && detail.lines ? detail.lines[lineIndex] : null;
    if (line && line.origin) p.set('origin', line.origin);
    const ep = line && line.episodes ? line.episodes[epIndex] : null;
    if (ep) p.set('p', String(ep.p));
  }
  if (pic) p.set('pic', pic);
  if (year) p.set('year', year);
  history.replaceState(null, '', `play.html?${p.toString()}`);
}

/* ---------------- 播放 ---------------- */

function currentUrl() {
  if (!detail || !detail.lines) return '';
  const line = detail.lines[lineIndex];
  if (!line) return '';
  const ep = line.episodes[epIndex];
  return ep ? ep.url : '';
}

/** 构建实际给播放器的地址 */
function buildSrc(url, viaProxy) {
  // 影视仓：url 本身就是本站同源地址（302 跳板 → /api/dyrs/m3u8），
  // 内部已经做完了上游代理、广告剔除、占位图识别。
  // 再包一层 /api/hls 会被后端当成「上游地址」反过来抓自己，多一跳还容易出错。
  if (isDyrs) return url;

  if (viaProxy) {
    const ref = refererFor(url);
    return `${API}/proxy?url=${encodeURIComponent(url)}${ref ? `&ref=${encodeURIComponent(ref)}` : ''}`;
  }

  // 客户端直连：采集站 CDN 本身返回 Access-Control-Allow-Origin: *，
  // 让浏览器直接向 CDN 取 master/media 列表与分片，完全不经过服务器。
  // 这样不会再因为「服务器出口 IP 被 CDN 拒绝 / 服务器到 CDN 不通」而 404。
  //
  // HTTP 源不能直连：本站是 HTTPS 页面，浏览器会按混合内容拦截，
  // 这类地址仍然交给服务端 /api/hls 取回后以 HTTPS 同源输出。
  if (/^https:\/\//i.test(url)) return url;

  // 兜底：HTTP 源走服务端广告过滤播放列表
  const ref = refererFor(url);
  return `${API}/hls?url=${encodeURIComponent(url)}${ref ? `&ref=${encodeURIComponent(ref)}` : ''}`;
}

/** 是否能直接当视频源播（m3u8 才算） */
function looksLikePlayable(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  // 影视仓的选集地址一律是**本站同源地址**（/api/proxy?… 、/api/dyrs/m3u8?… 或是 302 跳板），
  // 既可能是相对路径也可能是绝对地址，地址里不一定带 .m3u8，但后端保证返回播放列表。
  // ⚠️ 这条必须放在下面的 http(s) 判断之前：相对地址（/api/…）过不了那个正则。
  if (isDyrs) return true;
  if (!/^https?:\/\//.test(lower)) return false;
  return lower.includes('.m3u8');
}

/** 按地址猜一个 Referer，绕过部分 CDN 的来源校验 */
function refererFor(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}/`;
  } catch {
    return '';
  }
}

function loadEpisode() {
  const url = currentUrl();
  if (!url) {
    showOverlay('该集没有播放地址', true);
    return;
  }

  // 采集站有些线路给的是网页分享页，播放器拿到的会是 HTML 而不是视频
  if (!looksLikePlayable(url)) {
    const alt = detail.lines.findIndex((l) => l.playable);
    if (alt >= 0 && alt !== lineIndex) {
      lineIndex = alt;
      epIndex = Math.min(epIndex, detail.lines[alt].episodes.length - 1);
      renderLines();
      renderEpisodes();
      renderInfo();
      updateUrl();
      return loadEpisode();
    }
    showOverlay('这个线路给的是网页分享地址，网页播放器无法直接播放。请返回详情页换其他线路。', true);
    return;
  }

  destroyHls();
  // 上一集已经确认过必须走代理，这一集就不必再白试一次直连
  usingProxy = proxySticky;
  mediaRecoverTries = 0;
  dyrsFallbackTried = false;
  dyrsLevelTries = 0;
  showOverlay('<span class="spinner"></span> 正在连接片源…');

  const engine = pickHlsEngine(video);
  if (engine === 'none') {
    showOverlay('当前浏览器不支持 HLS 播放，建议使用 Chrome / Edge。', true);
    return;
  }
  if (engine === 'native') {
    // 只有 Safari / iOS 会走到这里（那边没有 MSE，hls.js 用不了）
    video.src = buildSrc(url, proxySticky);
    video.load();
    video.play().catch(() => {});
    hideOverlay();
    return;
  }

  attachHls(url, proxySticky);
}

/**
 * 选播放引擎。
 *
 * ⚠️ 顺序不能反：**桌面 Chrome / Edge 的 `canPlayType('application/vnd.apple.mpegurl')`
 * 返回的是 `'maybe'`**（不是空串），照抄「先判 canPlayType」的写法就会一直走原生 HLS，
 * hls.js 永远用不上。而 Chrome 原生 HLS（Windows 走 Media Foundation）只覆盖最简形态：
 *
 *   - 简单直链 master 能放；
 *   - `/api/dyrs/*` 那条链（master → cdn/m3u8?raw=1 → 每片带 #EXT-X-DISCONTINUITY）
 *     直接 `video.error = 4`（MEDIA_ERR_SRC_NOT_SUPPORTED）。
 *
 * 实测《嫁金钗》12 条线路：走原生时 8 条能播 / 1 条有画面不推进 / 3 条全挂
 * （超级线路、王者TV加速、wztv），而且换一部片子挂的又是另外几条 —— 每次靠运气。
 * 强制 hls.js 接管后 12 条全部 readyState=4、error=0、时长正确，currentTime 真实推进。
 *
 * 所以：**hls.js 优先，原生只在 hls.js 不支持时兜底**（Safari / iOS）。
 */
function pickHlsEngine(video) {
  if (typeof window !== 'undefined' && window.Hls && window.Hls.isSupported()) return 'hlsjs';
  try {
    if (video && video.canPlayType('application/vnd.apple.mpegurl')) return 'native';
  } catch {
    /* 老浏览器没有 canPlayType，当不支持处理 */
  }
  return 'none';
}

function attachHls(url, viaProxy) {
  destroyHls();
  usingProxy = viaProxy;

  const cfg = {
    enableWorker: true,
    lowLatencyMode: false,
    // 直连给 2 次机会，再不行就换代理，别让用户干等
    manifestLoadingMaxRetry: viaProxy ? 4 : 2,
    manifestLoadingRetryDelay: 800,
    levelLoadingMaxRetry: 4,
    levelLoadingRetryDelay: 800,
    fragLoadingMaxRetry: 6,
    fragLoadingRetryDelay: 600,
  };

  if (isDyrs) {
    // 服务端已把「直链型」（唯一能稳定拿到真分片的那条）排到最前，
    // 固定选第一条；否则 hls.js 按码率又会挑回 CDN 那条，而那条的分片接口返回占位图。
    // 超时放宽到同一个量级（1080p 单分片约 2MB，默认 20s 会先超时）。
    Object.assign(cfg, {
      startLevel: 0,
      fragLoadingTimeOut: 45000,
      levelLoadingTimeOut: 30000,
      maxBufferLength: 60,
      maxMaxBufferLength: 120,
    });
  }

  // 服务端广告过滤结果通过 X-Ads-Removed 响应头回传，播放器内提示用户。
  // 直连（/api/hls）和回落代理（/api/proxy）两条链路都会带上这个头。
  cfg.xhrSetup = (xhr, reqUrl) => {
    if (!/\/api\/(hls|proxy)\?/.test(reqUrl)) return;
    xhr.addEventListener('loadend', () => {
      try {
        const n = Number(xhr.getResponseHeader('X-Ads-Removed') || 0);
        if (n > 0) {
          if (ui) ui.notice(`已自动跳过 ${n} 个广告片段`);
          else toast(`已自动跳过 ${n} 个广告片段`);
        }
      } catch { /* 拿不到响应头就算了 */ }
    });
  };

  hls = new window.Hls(cfg);

  hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
    hideOverlay();
    if (pendingSeek > 0) {
      try { video.currentTime = pendingSeek; } catch { /* 等 metadata */ }
    }
    video.play().catch(() => {
      // 浏览器可能拦截自动播放，提示用户点一下
      showOverlay('已就绪，点击开始播放', false, true);
    });
  });

  hls.on(window.Hls.Events.ERROR, (_evt, data) => {
    if (!data) return;

    const T = window.Hls.ErrorTypes;
    const type = data.type || '';
    // 注意别叫 detail：模块级的 `detail` 是详情数据（lines/episodes），
    // 这里一旦同名，下面第 4 段的 `detail.lines[...]` 就会静默变成对字符串取属性，
    // 导致「重新解析」跳板拿不到 origin / p，兜底直接失效。
    const errText = String(data.details || type) || '未知错误';
    const lineName = (detail && detail.lines && detail.lines[lineIndex] && detail.lines[lineIndex].origin) || '';
    const withLine = (msg) => (lineName ? `${msg}（线路：${lineName}）` : msg);

    /**
     * 影视仓换档：把已经确认坏掉的档位跳过。
     *
     * 上游 master 常给两条 CDN（vip1 / cf1），实测 vip1 会间歇性 fetch failed，
     * 而 attachHls 为了避开「返回占位图的那条」把 startLevel 钉死在 0 —— 一旦那条抽风，
     * hls.js 会一路重试到致命错误才认输，实测要等 15 秒才出画面。
     * 所以这里**非致命的分片/列表错误也换档**，别让用户干等。
     */
    const tryNextDyrsLevel = () => {
      if (!isDyrs) return false;
      const retryable = type === T.NETWORK_ERROR || /LoadError|LoadTimeOut|TimeOut|Timeout/i.test(errText);
      if (!retryable) return false;
      const levelCount = (hls.levels && hls.levels.length) || 0;
      if (levelCount < 2 || dyrsLevelTries >= levelCount - 1) return false;
      dyrsLevelTries++;
      const next = (Math.max(0, hls.currentLevel) + dyrsLevelTries) % levelCount;
      console.warn(`[hls] 影视仓换档重试：level ${hls.currentLevel} → ${next}（${errText}）`);
      try {
        hls.nextLevel = next;
        hls.startLoad();
        return true;
      } catch {
        return false;
      }
    };

    // 非致命错误：只做换档，不弹报错
    if (!data.fatal) {
      tryNextDyrsLevel();
      return;
    }

    // 1) 解码 / 缓冲类错误：换代理解决不了，先按 hls.js 的标准姿势原地恢复一次
    if (type === T.MEDIA_ERROR) {
      if (mediaRecoverTries < 1) {
        mediaRecoverTries++;
        console.warn('[hls] 媒体错误，尝试原地恢复:', errText);
        try { hls.recoverMediaError(); return; } catch { /* 恢复不了就往下报错 */ }
      }
      showOverlay(withLine(`播放失败：${errText}`), true);
      return;
    }

    // 2) 解析类错误：片源自己格式有问题，代理也救不了，直接说清楚
    if (/parsing/i.test(errText)) {
      showOverlay(withLine(`片源播放列表无法解析（${errText}），请返回详情页换一条线路。`), true);
      return;
    }

    // 3) 网络类错误：分片 / 子列表在浏览器侧取不到（CORS、Referer 校验、被墙），
    //    这才是代理真能解决的问题。
    //    其它致命错误（解析、密钥、复用器等）不再被当成「直连失败」——
    //    以前只要有一个致命错误就弹「直连失败，转为代理」，误报太多。
    //    影视仓本来就全程同源，没有「换代理」这个选项。
    if (type === T.NETWORK_ERROR && !usingProxy && !isDyrs) {
      const firstTime = !proxySticky;
      console.warn('[hls] 直连取流失败，改用本机代理重试:', errText);
      setProxySticky(true);
      if (firstTime) toast('片源不支持直连，已自动改用本机代理');
      attachHls(url, true);
      return;
    }

    // 4) 影视仓：先换档，再换地址。
    if (isDyrs) {
      if (tryNextDyrsLevel()) return;

      // 档位都试过了，再让后端按 origin + 集序号重新解析一次
      if (type === T.NETWORK_ERROR && !dyrsFallbackTried) {
        const cur = (detail && detail.lines[lineIndex] && detail.lines[lineIndex].episodes[epIndex]) || {};
        const jump = dyrsJumpUrl(cur);
        dyrsFallbackTried = true;
        if (jump !== url) {
          console.warn('[hls] 影视仓取流失败，改用 302 跳板重新解析:', errText);
          toast('这条线路取流失败，正在重新解析…');
          attachHls(jump, false);
          return;
        }
      }
    }

    showOverlay(withLine(`播放失败：${errText}${isDyrs ? '。这条线路取不到分片，换一条线路试试。' : ''}`), true);
  });

  hls.loadSource(buildSrc(url, viaProxy));
  hls.attachMedia(video);
}

function destroyHls() {
  if (hls) {
    try { hls.destroy(); } catch { /* ignore */ }
    hls = null;
  }
}

/* ---------------- 弹层 ---------------- */

function showOverlay(html, isError, clickToPlay) {
  overlayInner.innerHTML = `<div style="font-size:15px;line-height:1.8">${html}</div>`;
  overlay.classList.remove('hidden');
  overlay.onclick = clickToPlay ? () => { hideOverlay(); video.play().catch(() => {}); } : null;
  if (isError) {
    // 已经在代理上还失败，「改用代理重试」就没意义了，改叫「重新加载」；
    // 影视仓全程同源，没有代理这一说，同样是「重新加载」
    const retryLabel = (usingProxy || isDyrs) ? '重新加载' : '改用代理重试';
    overlayInner.innerHTML += `<div style="margin-top:14px;display:flex;gap:8px;justify-content:center">
      <button class="primary" onclick="retryWithProxy()">${retryLabel}</button>
      <button onclick="location.reload()">刷新页面</button>
    </div>`;
  }
}

function hideOverlay() {
  overlay.classList.add('hidden');
  overlay.onclick = null;
}

function retryWithProxy() {
  const url = currentUrl();
  if (!url) return;
  mediaRecoverTries = 0;
  // 影视仓本来就同源，重试就是重新取一次流
  if (isDyrs) {
    showOverlay('<span class="spinner"></span> 正在重新加载…');
    loadEpisode();
    return;
  }
  const loading = usingProxy ? '正在重新加载…' : '正在通过代理重试…';
  showOverlay(`<span class="spinner"></span> ${loading}`);
  attachHls(url, true);
}

/* ---------------- 片头片尾标记 ---------------- */

/** 拉取本剧的片头片尾标记（按剧名记忆，换集不重设） */
async function restoreMarker() {
  if (!detail || !detail.name) return;
  try {
    const r = await api(`/markers?name=${encodeURIComponent(detail.name)}`);
    marker = r.marker;
  } catch {
    marker = null;
  }
  introSkipped = false;
  outroSkipped = false;
}

async function saveMarker(patch) {
  try {
    const r = await api('/markers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: detail.name, ...patch }),
    });
    marker = r.marker;
    // 立即生效：重新武装跳过
    introSkipped = false;
    outroSkipped = false;
  } catch (e) {
    toast(e.message);
  }
}

/**
 * 每次播放位置变化时检查是否需要跳。
 * 片头：进度还在片头区间内 → 直接 seek 到片头结束位置；
 * 片尾：进度进入片尾区间 → 切下一集（无论连播开关，片尾跳过本身就是切集动作）。
 */
function checkSkip() {
  if (!skipToggle.checked || !marker || !detail) return;
  const t = video.currentTime;
  const dur = video.duration || 0;

  if (marker.intro > 3 && !introSkipped && t > 1 && t < marker.intro - 0.5) {
    introSkipped = true;
    video.currentTime = marker.intro;
    toast(`已跳过片头（${fmtTime(marker.intro)}）`);
    return;
  }

  if (marker.outro > 3 && dur > 0 && !outroSkipped && t >= marker.outro && t < dur - 2) {
    outroSkipped = true;
    toast('已跳过片尾，播放下一集');
    gotoOffset(1);
  }
}

/* ---------------- 进度 ---------------- */

async function restoreProgress() {
  try {
    const r = await api(`/progress?id=${encodeURIComponent(videoId)}&source=${encodeURIComponent(source)}`);
    const h = r.entry;
    if (!h) return;

    // 若上次看的不是当前这一集，就不动（用户可能特意点了别的集）
    if (h.lineIndex === lineIndex && h.episodeIndex === epIndex && h.position > 5) {
      pendingSeek = h.position;
      // 等视频能 seek 了再设置
      video.addEventListener('loadedmetadata', () => {
        try {
          video.currentTime = pendingSeek;
          toast(`已续播到 ${fmtTime(pendingSeek)}`);
        } catch { /* ignore */ }
      }, { once: true });
    }
  } catch {
    // 进度读不到不影响播放
  }
}

async function saveProgress() {
  // detail 为空说明加载失败，此时没有任何进度可存
  if (!detail || !detail.lines) return;
  const line = detail.lines[lineIndex];
  if (!line) return;
  const ep = line.episodes[epIndex];
  const now = Date.now();
  // 太频繁没意义，且会打满磁盘
  if (now - lastSaved < 4000) return;
  lastSaved = now;

  try {
    await api('/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: videoId,
        name: detail.name,
        source,
        pic: detail.pic || pic || undefined,
        lineIndex,
        episodeIndex: epIndex,
        episodeName: ep ? ep.name : undefined,
        position: Math.floor(video.currentTime || 0),
        duration: Math.floor(video.duration || 0),
      }),
    });
  } catch {
    // 保存失败不打扰用户
  }
}

/* ---------------- 收藏 ---------------- */

async function refreshFavoriteBtn() {
  const btn = document.getElementById('favBtn');
  try {
    const r = await api(`/favorite-status?id=${encodeURIComponent(videoId)}&source=${encodeURIComponent(source)}`);
    btn.textContent = r.favorite ? '★ 已收藏' : '☆ 收藏';
    btn.classList.toggle('active', r.favorite);
  } catch {
    btn.textContent = '☆ 收藏';
  }
}

async function toggleFavorite() {
  const btn = document.getElementById('favBtn');
  try {
    const r = await api(`/favorite-status?id=${encodeURIComponent(videoId)}&source=${encodeURIComponent(source)}`);
    if (r.favorite) {
      await api(`/favorites?id=${encodeURIComponent(videoId)}&source=${encodeURIComponent(source)}`, { method: 'DELETE' });
      toast('已取消收藏');
    } else {
      await api('/favorites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: videoId, name: detail.name, source, pic: detail.pic || pic, year: detail.year || year }),
      });
      toast('已加入收藏');
    }
    await refreshFavoriteBtn();
  } catch (e) {
    toast(e.message);
  }
}

/* ---------------- 上一集 / 下一集 ---------------- */

function gotoOffset(delta) {
  if (!detail || !detail.lines) return;
  const line = detail.lines[lineIndex];
  if (!line) return;
  let ni = epIndex + delta;

  if (ni < 0) {
    if (lineIndex > 0) {
      lineIndex--;
      ni = detail.lines[lineIndex].episodes.length - 1;
    } else {
      toast('已经是第一集');
      return;
    }
  } else if (ni >= line.episodes.length) {
    if (lineIndex < detail.lines.length - 1) {
      lineIndex++;
      ni = 0;
    } else {
      toast('已经是最后一集');
      return;
    }
  }

  epIndex = ni;
  renderLines();
  renderEpisodes();
  renderInfo();
  updateUrl();
  loadEpisode();
}

/* ---------------- 事件绑定 ---------------- */

video.addEventListener('timeupdate', () => {
  if (video.currentTime > 0) saveProgress();
  checkSkip();
});

video.addEventListener('loadedmetadata', () => {
  // 换集后重新武装跳过；续播位置若已过片头就不再跳
  if (marker && marker.intro > 3 && video.currentTime < marker.intro - 0.5) {
    introSkipped = false;
  } else {
    introSkipped = true;
  }
  outroSkipped = false;
  checkSkip();
});

video.addEventListener('ended', () => {
  saveProgress();
  if (autoNextToggle.checked) {
    gotoOffset(1);
  }
});

video.addEventListener('error', () => {
  // hls.js 接管时，错误一律由它自己的 ERROR 回调处理（那里能拿到 details 和恢复手段）。
  // 这个监听只负责「原生 HLS」那条路（Safari / iOS）。
  if (hls) return;

  // 影视仓：原生 HLS（Safari）失败，没有 hls.js 的 ERROR 回调，这里兜底给提示
  if (isDyrs) {
    if (currentUrl()) showOverlay('取流失败，点「重新加载」再试一次；还不行就换一条线路。', true);
    return;
  }
  if (usingProxy) return; // 交给 hls 的错误处理
  const url = currentUrl();
  if (url && !video.canPlayType('application/vnd.apple.mpegurl')) return;
  if (url) {
    const firstTime = !proxySticky;
    setProxySticky(true);
    if (firstTime) toast('片源不支持直连，已自动改用本机代理');
    attachHls(url, true);
  }
});

document.addEventListener('keydown', (e) => {
  // 播放器快捷键（空格 / 方向键 / F / M / P / N）由 player-ui.js 统一处理，
  // 这里只保留页面上额外的按键。
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
  if (e.key === 'Escape' && document.fullscreenElement) document.exitFullscreen();
});

// 离开页面前尽量存一次
window.addEventListener('beforeunload', () => { saveProgress(); });

// 绑定按钮
document.getElementById('prevBtn').onclick = () => gotoOffset(-1);
document.getElementById('nextBtn').onclick = () => gotoOffset(1);
document.getElementById('favBtn').onclick = toggleFavorite;
document.getElementById('retryBtn').onclick = retryWithProxy;
document.getElementById('setIntroBtn').onclick = () => {
  const t = Math.floor(video.currentTime);
  if (t < 3) return toast('当前进度太靠前，先拖到片头结束的位置再点');
  saveMarker({ intro: t });
  toast(`已记录片头结束位置 ${fmtTime(t)}，同剧所有集生效`);
};
document.getElementById('setOutroBtn').onclick = () => {
  const t = Math.floor(video.currentTime);
  if (!video.duration || t > video.duration - 5) return toast('太接近片尾了，先拖到片尾字幕开始的位置再点');
  saveMarker({ outro: t });
  toast(`已记录片尾开始位置 ${fmtTime(t)}，同剧所有集生效`);
};

// 侧栏 tab
document.querySelectorAll('.side-tab').forEach((t) => {
  t.onclick = () => switchTab(t.dataset.tab);
});

// 没有顶部导航条的播放页，mountTopbar 会注入重复导航，跳过
// mountTopbar('play.html');
boot();
