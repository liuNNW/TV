/**
 * dyrs 站点（wzzycc 模板）HTML 抓取与解析。
 *
 * 背景：dyrs 的列表/搜索/详情页是**服务端渲染的 HTML**，没有 JSON 采集接口。
 * 要在新 UI 里用它的数据，只能抓 HTML 再解析。本模块负责：
 *   - 选线路（复用 dyrs.ts 的线路发现，探活挑最快的）
 *   - 抓页面（带 UA/Referer，跟随重定向，带缓存）
 *   - 解析：卡片（列表/搜索）、筛选栏+分页（分类页）、详情（JSON-LD+选集）、首页 banner
 *
 * 解析全部用正则（页面结构是模板生成的，标记非常规整；引 DOM 库反而重）。
 */

import { DEFAULT_LINE, listLines } from './dyrs.js';
import { createHash } from 'node:crypto';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * 站点页面抓取超时。
 * 上游镜像偏慢（实测首页 3~6s、播放页 1.5~6s，冷启动偶发 10s+），
 * 12s 会把「只是慢」误报成失败（前端看到的是 "This operation was aborted"）。
 */
const FETCH_TIMEOUT = 18_000;

/* ---------------- 线路池（多镜像 + 失败自动切换） ---------------- */

/**
 * 打头的三条优先线路。
 *
 * 34 条镜像指向**同一份内容库**（2026-10-25 实测：viprs3.cc / dyrsok.cc / tvcang.com /
 * viprs1.cc 的 `/dianying.html` 前 6 个视频 id 完全一致，只有站名不同：
 * 美剧天堂 / 电影人生 / TV仓），所以这里挑的是**延迟与稳定性**，不是内容增量。
 * 这三条实测响应最快、也最少被反爬拦下。
 */
const PREFERRED_LINES = ['https://viprs3.cc', 'https://tvcang.com', 'https://dyrsok.cc'];

/**
 * 一次请求最多试几条线路。
 * 再多没有边际收益，只会把「上游真的挂了」这件事拖成几十秒的等待。
 */
const POOL_TRY_MAX = 3;

let activePool: { lines: string[]; at: number } | null = null;
const POOL_TTL_MS = 10 * 60_000;

/** 构建线路池：优先线路 → 兜底线路 → 线路发现接口给的其余镜像 */
async function linePool(force = false): Promise<string[]> {
  if (!force && activePool && Date.now() - activePool.at < POOL_TTL_MS) {
    return activePool.lines;
  }
  let lines: string[] = [];
  try {
    lines = await listLines();
  } catch {
    // 线路发现接口本身挂了就用本地兜底，不影响站点可用
  }

  const seen = new Set<string>();
  const pool: string[] = [];
  for (const raw of [...PREFERRED_LINES, DEFAULT_LINE, ...lines]) {
    const v = String(raw || '').trim().replace(/\/+$/, '');
    if (!v || seen.has(v)) continue;
    seen.add(v);
    pool.push(v);
  }
  activePool = { lines: pool, at: Date.now() };
  return pool;
}

/** 挑一条可用线路：池首。探活与换线交给 fetchWithPool。 */
export async function pickLine(force = false): Promise<string> {
  const pool = await linePool(force);
  return pool[0] ?? DEFAULT_LINE;
}

export function resetSiteLineCache(): void {
  activePool = null;
}

/** 成功过的线路提到池首，后续 10 分钟直接用，不再从头上试 */
function promoteLine(base: string): void {
  if (!activePool) return;
  const i = activePool.lines.indexOf(base);
  if (i > 0) {
    activePool.lines.splice(i, 1);
    activePool.lines.unshift(base);
  }
}

/* ---------------- 反爬挑战（按线路全局共用一个 attack_key） ---------------- */

/**
 * 上游（wzzycc 模板）对**所有页面**都挂了同一套 SHA1 工作量证明反爬：
 * 命中时返回一个约 6.6KB 的「正在检测」页，HTTP 状态是 **429**。
 * 页里给出 hash / target，要求算出 i 使 `sha1(hash + i) === target`，
 * 再把 `attack_key=<i>` 加到**当前 URL** 上重放。
 *
 * 实测结论（2026-10-12，tvcang.com）：
 *   - 不带 attack_key：同页连打 8 次，8 次全被挑战（通过率 0/8）。
 *   - 带上同一个 attack_key：同页 8/8 通过，**且换到列表页也照样通过**。
 *   => key 是「按线路（站点）全局有效」的，不是按 URL 绑定的，每条线路存一个即可。
 *   - 站点响应会下发 `sion_id` Cookie，一并保存更稳。
 *
 * **这就是「取流失败：上游返回 HTTP 429」的根因**：之前只有搜索接口
 * （`fetchSearchPage`）处理了这道挑战，首页 / 分类 / 详情 / **播放页**都没处理。
 * 上游一旦开始挑战，整站取流就全 429 —— 前端表现就是「所有信息播放失败」，
 * 而且和电脑/手机无关（取流都在服务端）。
 */
interface SiteSession {
  /** SHA1 挑战的答案，带上即可通过 */
  key?: string;
  /** 站点下发的 sion_id Cookie */
  cookie?: string;
  /** 最近一次使用时间（用于过期回收） */
  at: number;
}

const sessions = new Map<string, SiteSession>();
/** key 实测长期稳定，给 6 小时；真的失效了下一轮会重新解题 */
const SESSION_TTL_MS = 6 * 60 * 60_000;

function sessionOf(base: string): SiteSession {
  const s = sessions.get(base);
  if (s && Date.now() - s.at < SESSION_TTL_MS) return s;
  const fresh: SiteSession = { at: Date.now() };
  sessions.set(base, fresh);
  return fresh;
}

export function resetSiteSessions(): void {
  sessions.clear();
}

/** 把 attack_key 合进地址（已有就替换，避免重复参数） */
function withAttackKey(url: string, key: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set('attack_key', key);
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * 是不是「正在检测」挑战页。
 *
 * 三重判定，避免把正常页面误判：
 *   1. 体积小（真页面都是 100KB+，挑战页 6.6KB）；
 *   2. 标题/正文含「正在检测」；
 *   3. 含解题脚本特征 `sha1(hash + i)`。
 */
function isChallengePage(html: string): boolean {
  if (!html || html.length > 40_000) return false;
  return /正在检测/.test(html) && /sha1\(hash\s*\+\s*i\)/.test(html);
}

/** 抓取的原始结果（页面和图片共用） */
interface RawResult {
  status: number;
  contentType: string;
  body: Buffer;
  finalUrl: string;
}

/**
 * 带「挑战自愈」的抓取内核。页面与图片都走这里。
 *
 * 流程：带上已知 key（没有就不带）→ 命中挑战页就解题、存 key → 带新 key 重放。
 * 最多重放 3 轮；仍失败就把最后一次结果原样返回（上层报 429，不会假装成功）。
 */
async function fetchRaw(url: string, base: string, accept: string, timeoutMs = FETCH_TIMEOUT): Promise<RawResult> {
  const ses = sessionOf(base);
  let target = ses.key ? withAttackKey(url, ses.key) : url;
  let last: RawResult = { status: 0, contentType: '', body: Buffer.alloc(0), finalUrl: target };

  for (let attempt = 0; attempt < 3; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(target, {
        headers: {
          'User-Agent': UA,
          Referer: `${base}/`,
          Accept: accept,
          ...(ses.cookie ? { Cookie: ses.cookie } : {}),
        },
        signal: ac.signal,
        redirect: 'follow',
      });
      const body = Buffer.from(await res.arrayBuffer());
      const sc = res.headers.get('set-cookie') || '';
      const m = sc.match(/sion_id=([^;]+)/);
      if (m) ses.cookie = `sion_id=${m[1]}`;
      ses.at = Date.now();

      last = {
        status: res.status,
        contentType: res.headers.get('content-type') ?? 'application/octet-stream',
        body,
        finalUrl: res.url || target,
      };
    } finally {
      clearTimeout(timer);
    }

    // 挑战页只有 6.6KB，先按体积排除大响应；再按文本特征判定。
    // 必须用 utf8 解码 —— 页里有中文「正在检测」，latin1 会解成乱码匹配不上。
    const maybeChallenge = last.body.length > 0 && last.body.length < 40_000;
    if (!maybeChallenge || !isChallengePage(last.body.toString('utf8'))) return last;

    const key = solveChallenge(last.body.toString('utf8'));
    if (!key) return last;
    ses.key = key;
    target = withAttackKey(url, key);
  }
  return last;
}

/* ---------------- 页面抓取（带缓存） ---------------- */

export interface HtmlResult {
  status: number;
  html: string;
  finalUrl: string;
}

/**
 * 带线路池的抓取：沿着池顺序试，第一条真正拿到「非挑战页的 200」就用它，
 * 并把它提到池首。三条都失败才返回最后一次结果（上层照旧按状态码报错）。
 *
 * 之前是「单条全局线路」：一旦挑中一条抽风的镜像，整个影视仓在 10 分钟内
 * 全站变慢/报错，没有任何兜底。34 条镜像本来就是为了冗余存在的。
 */
async function fetchWithPool(
  path: string,
  accept: string,
  timeoutMs = FETCH_TIMEOUT,
): Promise<{ raw: RawResult; base: string }> {
  const pool = await linePool();
  const tries = pool.slice(0, POOL_TRY_MAX);
  let last: { raw: RawResult; base: string } | null = null;

  for (const base of tries) {
    const url = path.startsWith('http') ? path : `${base}${path}`;
    try {
      const raw = await fetchRaw(url, base, accept, timeoutMs);
      const ok = raw.status === 200 && !isChallengePage(raw.body.toString('utf8'));
      if (ok) {
        promoteLine(base);
        return { raw, base };
      }
      last = { raw, base };
    } catch {
      // 这条不通，换下一条
    }
  }

  if (last) return last;
  const base = tries[0] ?? DEFAULT_LINE;
  const url = path.startsWith('http') ? path : `${base}${path}`;
  return { raw: { status: 0, contentType: '', body: Buffer.alloc(0), finalUrl: url }, base };
}

const pageCache = new Map<string, { at: number; data: HtmlResult }>();
const PAGE_TTL_MS = 5 * 60_000;
const PAGE_CACHE_MAX = 120;

/**
 * 写页面缓存（只缓存真正拿到的正常页面）。
 *
 * 键用**路径**而不是完整地址：34 条镜像内容一致，按路径缓存才能在
 * 「这次走 A 镜像、下次走 B 镜像」时仍然命中，不至于换条线路就全 miss。
 */
function cachePage(path: string, status: number, data: HtmlResult): void {
  if (!(status === 200 && data.html.length > 1000) || isChallengePage(data.html)) return;
  if (pageCache.size >= PAGE_CACHE_MAX) {
    let oldestKey = '';
    let oldest = Infinity;
    for (const [k, v] of pageCache) {
      if (v.at < oldest) {
        oldest = v.at;
        oldestKey = k;
      }
    }
    if (oldestKey) pageCache.delete(oldestKey);
  }
  pageCache.set(path, { at: Date.now(), data });
}

/**
 * 抓一个站点路径（以 / 开头），带 5 分钟缓存。
 *
 * 不传 line 时走线路池（失败自动换镜像）；传了 line 就固定用那条
 * （详情页复用同一线路抓 N 次选集时，避免每次都在池里重新探）。
 */
export async function fetchSitePage(path: string, line?: string): Promise<HtmlResult> {
  const hit = pageCache.get(path);
  if (hit && Date.now() - hit.at < PAGE_TTL_MS) return hit.data;

  if (line) {
    const url = path.startsWith('http') ? path : `${line}${path}`;
    const r = await fetchRaw(url, line, 'text/html,*/*');
    const data: HtmlResult = { status: r.status, html: r.body.toString('utf8'), finalUrl: r.finalUrl };
    cachePage(path, r.status, data);
    return data;
  }

  const { raw } = await fetchWithPool(path, 'text/html,*/*');
  const data: HtmlResult = {
    status: raw.status,
    html: raw.body.toString('utf8'),
    finalUrl: raw.finalUrl,
  };
  cachePage(path, raw.status, data);
  return data;
}

export function resetSitePageCache(): void {
  pageCache.clear();
}


/* ---------------- 搜索 ---------------- */

function sha1hex(s: string): string {
  return createHash('sha1').update(s, 'utf8').digest('hex');
}

/** 从挑战页里解出 attack_key；解不出返回 null */
function solveChallenge(html: string): string | null {
  const mHash = html.match(/var\s+hash\s*=\s*'([0-9a-f]{40})'/);
  const mTarget = html.match(/var\s+target\s*=\s*'([0-9a-f]{40})'/);
  if (!mHash || !mTarget) return null;
  const hash = mHash[1];
  const target = mTarget[1];
  // 实测答案一般在几万以内；上限放宽到 2e6 兜底（Node 单线程约 1e5/秒）
  for (let i = 0; i < 2_000_000; i++) {
    if (sha1hex(hash + String(i)) === target) return String(i);
  }
  return null;
}

/**
 * 抓搜索结果页。上游 `/search.html?wd=` 是个空壳（服务端不按关键词过滤，返回首页片单），
 * 真正的搜索是 `/s?encode=off&name=`（会 301 到 `/s.html?encode=off&name=`）。
 *
 * 挑战处理已下沉到 `fetchRaw`，这里不用再单独解一遍（早先只有这里解，
 * 别的页面没解，才出现「一被挑战整站 429」）。
 */
export async function fetchSearchPage(wd: string, line?: string): Promise<HtmlResult> {
  const path = `/s.html?encode=off&name=${encodeURIComponent(wd)}`;
  if (line) {
    const r = await fetchRaw(`${line}${path}`, line, 'text/html,*/*');
    return { status: r.status, html: r.body.toString('utf8'), finalUrl: r.finalUrl };
  }
  const { raw } = await fetchWithPool(path, 'text/html,*/*');
  return { status: raw.status, html: raw.body.toString('utf8'), finalUrl: raw.finalUrl };
}

/** @deprecated 保留旧名字，等价于 resetSiteSessions() */
export function resetChallengeCache(): void {
  resetSiteSessions();
}

/* ---------------- 线路可用性预检 ---------------- */

/**
 * 探一条线路到底能不能出流。
 *
 * 只做「能不能拿到播放列表」这一层的判断（前 512 字节里有没有 `#EXTM3U`）：
 *   - 足够识别「详情里解析出了地址、但 CDN 已经挂了」的线路
 *     （实测 xiguam3u8 的 svip.xgplay20.com 会整段 502，而 1080zyk 某个 CDN 也会这样）；
 *   - 不判分片，避免把探活做成一次完整播放（那会把详情页拖到十几秒）。
 *
 * `deep`（默认开）：master 里如果还有 `#EXT-X-STREAM-INF`，就**再跟一层**去要真正的
 * 媒体列表。只判 master 会说谎 —— 实测某部片的「超级线路」master 正常返回，
 * 但它下面两条 CDN（vip1 / cf1）里第一条间歇性 fetch failed，用户点进去照样黑屏。
 *
 * 传进来的 url 允许是**本站同源地址**（`/api/proxy?url=…` / `/api/dyrs/m3u8?…`），
 * 这样探活走的正是浏览器要走的那条链路，探到的结果不会和实际播放不一致。
 */
export type PlaylistProbe = 'ok' | 'weak' | 'dead';

export async function probePlaylistUrl(
  url: string,
  timeoutMs = 2500,
): Promise<PlaylistProbe> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const text = await fetchPlaylistText(url, ac.signal);
    if (text === null) return 'dead';

    // master → 挨个试 STREAM-INF 变体，只要有一条能出媒体列表就算这条线路活着。
    // 不能只试第一条：上游 master 常给两条 CDN（vip1 / cf1），实测 vip1 会间歇性
    // fetch failed，只试第一条会把「其实能播」的线路误判成不可用。
    const lines = text.split(/\r?\n/);
    const variants: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]!.startsWith('#EXT-X-STREAM-INF')) continue;
      for (let j = i + 1; j < lines.length; j++) {
        const l = (lines[j] ?? '').trim();
        if (!l) continue;
        if (l.startsWith('#')) continue;
        variants.push(l);
        break;
      }
    }
    if (variants.length === 0) return 'ok'; // 已经是媒体列表，master 这层就算过了

    for (const variant of variants.slice(0, 3)) {
      // 变体地址可能是绝对地址，也可能是 `/api/...` 相对路径，一律按 base 解析成绝对地址
      const abs = /^https?:\/\//i.test(variant) ? variant : new URL(variant, url).toString();
      const ac2 = new AbortController();
      const t2 = setTimeout(() => ac2.abort(), timeoutMs);
      try {
        if ((await fetchPlaylistText(abs, ac2.signal)) !== null) return 'ok';
      } finally {
        clearTimeout(t2);
      }
    }
    // master 正常、变体全挂：这是「弱」而不是「死」——
    // 浏览器里的 hls.js 会重试多次，往往还能拉起来（实测王者TV蓝光就是这样），
    // 判死会把人从能看的线路上赶走，所以只降级不判死。
    return 'weak';
  } catch {
    return 'dead';
  } finally {
    clearTimeout(timer);
  }
}

/** 取播放列表文本；拿不到或不是 m3u8 就返回 null */
async function fetchPlaylistText(url: string, signal: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch(url, { signal, redirect: 'follow' });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const head = buf.subarray(0, 512).toString('utf8');
    if (!head.includes('#EXTM3U')) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

/* ---------------- 取流地址换算 ---------------- */

export interface PlayUrlInfo {
  origin?: string;
  url?: string;
  title?: string;
}

/**
 * 把播放页给出的 url 换算成本站的取流地址。上游有两种形态，都要支持：
 *   ① 站内代理形态（多数）：`/api/m3u8?origin=线路&url={视频id}`
 *      → 换成本站复刻链路 `/api/dyrs/m3u8?proxy=1&origin=&url=`（同源，带分片占位图识别）
 *   ② 直链形态（部分片源，如 bfzym3u8）：`https://xxx/video/xxx/index.m3u8`
 *      → 走通用透传 `/api/proxy?url=`（同源、补 Referer、自动重写 m3u8 里的分片地址）
 *
 * 之前只处理了 ①，导致直链片源一律报「这一集没有可用的播放地址」（实测 30 部里 29 部挂）。
 *
 * @param base 站点线路地址，用于把相对路径补成绝对地址
 * @returns 本站取流路径；无法解析时返回空串
 */
export function toPlaySrc(rawUrl: string, origin: string | undefined, base: string): string {
  const raw = String(rawUrl || '').trim();
  if (!raw) return '';

  let parsed: URL | null = null;
  try {
    parsed = new URL(raw, 'https://placeholder.local');
  } catch {
    return '';
  }

  const vid = parsed.searchParams.get('url') || '';
  const looksDyrsProxy = /\/api\/m3u8/.test(parsed.pathname) || (!!vid && !!parsed.searchParams.get('origin'));
  if (looksDyrsProxy && vid) {
    const ori = origin || parsed.searchParams.get('origin') || '';
    const p = new URLSearchParams({ proxy: '1', origin: ori, url: vid });
    return `/api/dyrs/m3u8?${p.toString()}`;
  }

  // 直链：补成绝对地址再交给通用代理
  try {
    const abs = new URL(raw, base).href;
    return `/api/proxy?url=${encodeURIComponent(abs)}`;
  } catch {
    return raw;
  }
}

/* ---------------- 图片抓取（封面/banner 代理用） ---------------- */

export interface ImgResult {
  status: number;
  contentType: string;
  body: Buffer;
}

/** 抓站点图片（封面统一是 /img/id/{id}.jpg；banner 可能是外部图床绝对地址） */
export async function fetchSiteImage(url: string, line?: string): Promise<ImgResult> {
  const base = line ?? (await pickLine());
  const target = url.startsWith('http') ? url : `${base}${url}`;
  // 走同一个抓取内核：挑战是全站生效的，图片也可能被拦下换成检测页
  const r = await fetchRaw(target, base, 'image/*,*/*');
  return {
    status: r.status,
    contentType: r.contentType || 'image/jpeg',
    body: r.body,
  };
}

/* ---------------- 卡片解析（列表/搜索/首页网格通用） ---------------- */

export interface SiteCard {
  /** 视频 id（24 位 hex） */
  id: string;
  /** 栏目：tv / movie / zongyi / duanju */
  kind: string;
  /** 详情页集数参数（详情链接里的 -N.html 的 N） */
  ep: string;
  name: string;
  pic: string;
  /** 清晰度/更新状态角标（如 1080p、全集、正片） */
  remark: string;
  /** 评分角标（如 7.3，可能为空） */
  score: string;
  year: string;
  /** 分类角标（如 电影） */
  cat: string;
}

const CARD_BLOCK_RE = /<div class="group relative flex flex-col h-full">([\s\S]*?)(?=<div class="group relative flex flex-col h-full">|<\/div>\s*<\/section>|<section|<\/main>)/g;
const A_HREF_RE = /href="\/(movie|tv|zongyi|duanju)\/([0-9a-f]+)-(\d+)\.html"/;
const IMG_RE = /data-src="([^"]+)"/;
const BADGE_RE = /<div class="absolute top-2 (right|left)-2[^"]*"[^>]*>\s*([^<]+?)\s*<\/div>/g;
const TITLE_H3_RE = /<h3[^>]*>\s*([\s\S]*?)\s*<\/h3>/;
const FOOTER_SPANS_RE = /<div class="flex items-center justify-between text-xs text-gray-400 mt-auto w-full pt-2">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/;

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/** 解析一页里的全部影片卡片 */
export function parseCards(html: string): SiteCard[] {
  const cards: SiteCard[] = [];
  for (const m of html.matchAll(CARD_BLOCK_RE)) {
    const block = m[1];
    const a = block.match(A_HREF_RE);
    if (!a) continue;
    const img = block.match(IMG_RE);
    const h3 = block.match(TITLE_H3_RE);

    let remark = '';
    let score = '';
    for (const b of block.matchAll(BADGE_RE)) {
      if (b[1] === 'right') remark = decodeEntities(b[2]);
      else score = decodeEntities(b[2]);
    }

    let year = '';
    let cat = '';
    const foot = block.match(FOOTER_SPANS_RE);
    if (foot) {
      const spans = [...foot[1].matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)].map((x) => decodeEntities(x[1]));
      if (spans.length >= 1) year = spans[0];
      if (spans.length >= 2) cat = spans[spans.length - 1];
    }

    cards.push({
      id: a[2],
      kind: a[1],
      ep: a[3],
      name: decodeEntities(h3?.[1] ?? ''),
      pic: img?.[1] ?? '',
      remark,
      score,
      year,
      cat,
    });
  }
  return cards;
}

/* ---------------- 筛选栏 + 分页（分类页） ---------------- */

export interface FilterRow {
  label: string;
  options: { text: string; href: string }[];
}

/** 解析分类页顶部的筛选行（频道/分类/地区/年份/排序） */
export function parseFilters(html: string): FilterRow[] {
  const rows: FilterRow[] = [];
  // 每行：<span class="...">LABEL</span> 后跟一堆 <a href="...">TEXT</a>
  const rowRe = /<span class="text-gray-400 font-bold min-w-\[3rem\] shrink-0">([^<]+)<\/span>([\s\S]*?)(?=<div class="flex items-center py-1\.5|<\/div>\s*<\/section>|<\/section>)/g;
  for (const m of html.matchAll(rowRe)) {
    const label = decodeEntities(m[1]);
    const options: { text: string; href: string }[] = [];
    for (const a of m[2].matchAll(/<a href="([^"]+)"[^>]*>\s*([^<]+?)\s*<\/a>/g)) {
      options.push({ href: a[1], text: decodeEntities(a[2]) });
    }
    if (options.length) rows.push({ label, options });
  }
  return rows;
}

/** 解析分页：返回最大页码（page 从 0 开始） */
export function parseMaxPage(html: string): number {
  let max = 0;
  for (const m of html.matchAll(/[?&]page=(\d+)/g)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

/* ---------------- 列表查询参数（渠道打通） ---------------- */

/** 上游真实存在的 5 个频道（对应 `/{ch}.html` 页面） */
export const SITE_CHANNELS = ['dianying', 'dianshiju', 'zongyi', 'dongman', 'duanju'] as const;
export type SiteChannel = (typeof SITE_CHANNELS)[number];

export function isSiteChannel(v: string): v is SiteChannel {
  return (SITE_CHANNELS as readonly string[]).includes(v);
}

/**
 * 上游列表页支持的筛选参数。
 *
 * 2026-10-25 实测（viprs3.cc /dianshiju.html 的 7 行筛选栏）上游一共给这些轴：
 *   分类 `class`（25 项）· 地区 `area`（25 项）· 年份 `year`（37 项）
 *   排序 `sort_field`（`play_hot`）· 高级：`origin`（王者TV蓝光）/ `ban`（文艺片）/ `class`（纪录片）
 *   排除：`exclude_his` / `exclude_unlike`
 *
 * 之前只透传了前四个，其余四类被丢掉 —— 这也是「内容其实有、界面点不到」的根因。
 */
export interface SiteListQuery {
  ch: string;
  page?: number;
  class?: string;
  area?: string;
  year?: string;
  sortField?: string;
  /** 线路筛选（上游参数名是 `origin`）：只显示这条线路上有资源的片子 */
  line?: string;
  /** 文艺片 */
  ban?: boolean;
  /** 排除已观看 / 不想看 */
  exclude?: 'his' | 'unlike';
}

/**
 * 线路筛选值白名单校验。
 *
 * 上游 `origin` 是自由文本（实测有 `王者TV蓝光` `超级线路` `bfzym3u8` 这类），
 * 但它会被原样拼进上游 URL，所以只放行中英文/数字/空格/点/横线，长度 1~32。
 * 不合法的值直接丢弃（当作没传），不报错也不透传。
 */
export function isValidLineFilter(v: string): boolean {
  return /^[\u4e00-\u9fa5A-Za-z0-9._\- ]{1,32}$/.test(v);
}

/** 拼上游列表页路径（只接受已知频道，避免把用户输入拼进 URL 路径） */
export function buildSiteListPath(q: SiteListQuery): string {
  const u = new URL(`/${q.ch}.html`, 'https://placeholder.local');
  if (q.class) u.searchParams.set('class', q.class);
  if (q.area) u.searchParams.set('area', q.area);
  if (q.year) u.searchParams.set('year', q.year);
  if (q.sortField) u.searchParams.set('sort_field', q.sortField);
  if (q.line && isValidLineFilter(q.line)) u.searchParams.set('origin', q.line);
  if (q.ban) u.searchParams.set('ban', 'true');
  if (q.exclude === 'his') u.searchParams.set('exclude_his', 'true');
  if (q.exclude === 'unlike') u.searchParams.set('exclude_unlike', 'true');
  const page = Number(q.page);
  if (Number.isFinite(page) && page > 0) u.searchParams.set('page', String(page));
  return `${u.pathname}${u.search}`;
}

/**
 * 预设频道：把上游的「筛选组合」提升成一级入口。
 *
 * 上游只有 5 个真实频道，但纪录片 / 蓝光 / 美剧都是稳定可用的筛选组合，
 * 埋在两行筛选里基本没人点得到。做成预设入口 = 零新增上游、纯白捡的内容面。
 *
 * 注意：`key` 与真实频道 key 不能重名，`ch` 必须落在 SITE_CHANNELS 内。
 */
export interface SitePreset {
  key: string;
  name: string;
  ch: SiteChannel;
  /** 叠加在上游频道页上的固定筛选 */
  params: Omit<Partial<SiteListQuery>, 'ch' | 'page'>;
}

export const SITE_PRESETS: SitePreset[] = [
  // 纪录片：上游「高级」行里就是 `class=纪录片`
  { key: 'doc', name: '纪录片', ch: 'dianying', params: { class: '纪录片' } },
  // 蓝光：上游首页导航「蓝光电影」= `?origin=王者TV蓝光`，实测单页 24 部、无分页
  { key: 'bluray', name: '蓝光', ch: 'dianying', params: { line: '王者TV蓝光' } },
  // 美剧：上游没有独立频道，用「电视剧 + 地区=美国」这个组合
  { key: 'us', name: '美剧', ch: 'dianshiju', params: { area: '美国' } },
];

export function findPreset(key: string): SitePreset | undefined {
  return SITE_PRESETS.find((p) => p.key === key);
}

/* ---------------- 云盘分享源（/api/drive/list） ---------------- */

/**
 * 站点详情页里的 `box_data`。
 * 云盘分享接口是按 box_data.name（去掉季/集后缀的片名）或 imdb_id 查的，
 * 不是按页面上显示的完整标题，所以解析详情时必须一起带出来。
 */
export interface BoxData {
  /** 用于云盘查询的片名（如「中国尘封罪案实录」） */
  boxName: string;
  /** IMDb 编号（tt 开头时上游优先用它查） */
  imdbId: string;
  /** 上游 CDN 主机（详情页里会给，默认 box.dyrs.com.de） */
  cdnBase: string;
}

/** 从详情页里抠 `var box_data={...}` */
export function parseBoxData(html: string): BoxData {
  const block = html.match(/box_data\s*=\s*\{([\s\S]*?)\}/);
  const empty: BoxData = { boxName: '', imdbId: '', cdnBase: '' };
  if (!block) return empty;
  const field = (key: string): string => {
    const m = block[1].match(new RegExp(`${key}\\s*:\\s*["']([^"']*)["']`));
    return m ? decodeEntities(m[1]) : '';
  };
  return { boxName: field('name'), imdbId: field('imdb_id'), cdnBase: field('url') };
}

/** 一条云盘分享资源 */
export interface DriveItem {
  /** 网盘：baidu / ali … */
  origin: string;
  filename: string;
  /** 带提取码的完整链接 */
  url: string;
  /** 提取码（可能为空） */
  pwd: string;
}

/**
 * 解析 /api/drive/list 的 JSON。
 *
 * 上游无结果时返回 `null`（不是空数组），这里统一成空数组。
 * 字段做防御性读取：只保留有 filename 的条目，url 缺失时退回 share_url。
 */
export function parseDriveItems(text: string): DriveItem[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];

  const items: DriveItem[] = [];
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const filename = String(o.filename ?? '').trim();
    if (!filename) continue;
    const url = String(o.url ?? o.share_url ?? '').trim();
    if (!url) continue;
    items.push({
      origin: String(o.origin ?? '').trim() || '未知网盘',
      filename,
      url,
      pwd: String(o.pwd ?? '').trim(),
    });
  }

  // 上游前端也是百度优先、阿里其次
  const weight: Record<string, number> = { baidu: 100, ali: 90, aliyundrive: 90 };
  return items.sort((a, b) => (weight[b.origin] ?? 0) - (weight[a.origin] ?? 0));
}

/** 云盘列表缓存：key = 查询词（imdb 或片名） */
const driveCache = new Map<string, { at: number; items: DriveItem[] }>();
const DRIVE_TTL_MS = 30 * 60_000;
const DRIVE_CACHE_MAX = 300;

/**
 * 查云盘分享资源。上游没有结果时返回空数组。
 * 走 fetchRaw 是为了吃到「挑战自愈」：这个接口同样会被 429 检测页拦。
 */
export async function fetchDriveList(query: string): Promise<DriveItem[]> {
  const key = query.trim();
  if (!key) return [];

  const hit = driveCache.get(key);
  if (hit && Date.now() - hit.at < DRIVE_TTL_MS) return hit.items;

  const base = await pickLine();
  const url = `${base}/api/drive/list?name=${encodeURIComponent(key)}`;
  const r = await fetchRaw(url, base, 'application/json,*/*', 12_000);
  if (r.status !== 200) return [];

  const items = parseDriveItems(r.body.toString('utf8'));
  if (driveCache.size >= DRIVE_CACHE_MAX) driveCache.clear();
  driveCache.set(key, { at: Date.now(), items });
  return items;
}

/* ---------------- 详情页 ---------------- */

export interface SiteEpisode {
  /** 播放页的集数文件名（{ep}.html 的 ep） */
  ep: string;
  /** 集标题 */
  title: string;
  /** 在线路内的序号 p=N */
  p: number;
  origin: string;
}

export interface SiteOrigin {
  origin: string;
  count: number;
  episodes: SiteEpisode[];
}

export interface SiteDetail {
  id: string;
  kind: string;
  name: string;
  alias: string;
  pic: string;
  description: string;
  year: string;
  score: string;
  actors: string[];
  director: string;
  genre: string[];
  area: string;
  language: string;
  /** 首播日期等杂项 */
  extra: Record<string, string>;
  /** 云盘分享查询用的片名（box_data.name） */
  boxName: string;
  /** IMDb 编号（可能为空） */
  imdbId: string;
  /** 上游 CDN 主机（box_data.url，可能为空） */
  cdnBase: string;
  /**
   * seqlist 编号：选集地址是 `/{kind}/{id}/{seq}.html?origin=线路&p=集序号`。
   * 同一部片固定，和线路无关（见 parseSeqId）。
   */
  seq: string;
  origins: SiteOrigin[];
}

/**
 * 从详情页里抠出 seqlist 编号。
 *
 * 线路 tab 是 `/{kind}/{id}-{seq}.html?origin=线路`，选集是 `/{kind}/{id}/{seq}.html?origin=..&p=..`。
 * 注意别随手匹配 `-(\d+)\.html`：详情页里还有个 `/{id}-1.html?ep_list=title` 的
 * 「标题模式」链接会先命中，所以必须要求后面跟 `?origin=`。
 */
export function parseSeqId(html: string): string {
  const tab = html.match(/href="\/(?:movie|tv|zongyi|duanju)\/[0-9a-f]+-(\d+)\.html\?origin=/);
  if (tab) return tab[1];
  const ep = html.match(/href="\/(?:movie|tv|zongyi|duanju)\/[0-9a-f]+\/(\d+)\.html\?/);
  return ep ? ep[1] : '';
}

/** 解析 JSON-LD（TVSeries / Movie） */
function parseJsonLd(html: string): Record<string, unknown> | null {
  const m = html.match(/application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 解析详情页 */
export function parseDetail(html: string, id = '', kind = ''): SiteDetail {
  const ld = parseJsonLd(html);
  const box = parseBoxData(html);

  // og 元信息
  const og = (prop: string): string => {
    const m = html.match(new RegExp(`property="og:${prop}" content="([^"]*)"`));
    return m ? decodeEntities(m[1]) : '';
  };

  // 选集：按 origin 分组。
  // 上游有两种渲染模板：
  //   A. 海报网格：<a ... data-origin="X" data-title="T">
  //   B. 文字按钮：<a ... data-origin="X"> ... <button ...>T</button> </a>
  // 统一按 <a href=...origin=..&p=N" attrs>inner</a> 匹配，标题优先取 data-title，没有再取按钮文本。
  const origins = new Map<string, SiteOrigin>();
  const epRe = /<a href="\/(?:movie|tv|zongyi|duanju)\/[0-9a-f]+\/(\d+)\.html\?origin=([^"]*)&amp;p=(\d+)"([^>]*)>([\s\S]*?)<\/a>/g;
  for (const m of html.matchAll(epRe)) {
    const origin = decodeURIComponent(decodeEntities(m[2])) || '默认';
    const attrs = m[4];
    const inner = m[5];
    let title = '';
    const dt = attrs.match(/data-title="([^"]*)"/);
    if (dt) {
      title = decodeEntities(dt[1]);
    } else {
      const btn = inner.match(/<button[^>]*>\s*([\s\S]*?)\s*<\/button>/);
      title = btn ? decodeEntities(btn[1].replace(/<[^>]+>/g, '')) : '';
    }
    let o = origins.get(origin);
    if (!o) {
      o = { origin, count: 0, episodes: [] };
      origins.set(origin, o);
    }
    o.episodes.push({
      ep: m[1],
      title,
      p: Number(m[3]) || o.episodes.length,
      origin,
    });
  }
  // tab 上的集数徽标更可靠（seqlist 只渲染当前线路），用 tab 数补齐 count
  for (const m of html.matchAll(/<button[^>]*data-origin="([^"]*)"[^>]*>[\s\S]*?<span[^>]*>(\d+)<\/span>\s*<\/button>/g)) {
    const origin = decodeEntities(m[1]);
    const o = origins.get(origin);
    const n = Number(m[2]) || 0;
    if (o) o.count = Math.max(o.count, n);
    else origins.set(origin, { origin, count: n, episodes: [] });
  }
  for (const o of origins.values()) {
    o.count = Math.max(o.count, o.episodes.length);
  }

  // 信息行（地区/语言/类型等，模板里是 <span class="font-medium text-gray-400">地区：</span>中国大陆）
  const extra: Record<string, string> = {};
  for (const m of html.matchAll(/<span class="font-medium text-gray-400">([^<：]+)：?<\/span>\s*([^<]{1,80})</g)) {
    const k = decodeEntities(m[1]).replace(/：$/, '');
    const v = decodeEntities(m[2]);
    if (k && v && !extra[k]) extra[k] = v;
  }

  const actors = Array.isArray(ld?.actor)
    ? (ld.actor as { name?: string }[]).map((x) => x.name ?? '').filter(Boolean)
    : [];
  const director = (ld?.director as { name?: string } | undefined)?.name ?? '';
  const genre = Array.isArray(ld?.genre) ? (ld.genre as string[]) : [];
  const rating = (ld?.aggregateRating as { ratingValue?: number } | undefined)?.ratingValue ?? 0;

  return {
    id: id || (String(ld?.url ?? '').match(/\/([0-9a-f]{24})/) ?? ['', ''])[1],
    kind: kind || (ld?.['@type'] === 'Movie' ? 'movie' : 'tv'),
    name: String(ld?.name ?? og('title') ?? ''),
    alias: String(ld?.alternateName ?? ''),
    pic: og('image'),
    description: og('description'),
    year: String(ld?.year ?? ''),
    score: rating > 0 ? String(rating) : '',
    actors,
    director,
    genre,
    area: String(ld?.countryOfOrigin ?? ''),
    language: String(ld?.inLanguage ?? ''),
    extra,
    boxName: box.boxName,
    imdbId: box.imdbId,
    cdnBase: box.cdnBase,
    seq: parseSeqId(html),
    origins: [...origins.values()],
  };
}

/* ---------------- 首页 banner ---------------- */export interface BannerItem {
  id: string;
  kind: string;
  ep: string;
  name: string;
  pic: string;
  remark: string;
  desc: string;
}

/** 解析首页轮播 */
export function parseBanner(html: string): BannerItem[] {
  const items: BannerItem[] = [];
  const slideRe = /<div class="swiper-slide relative">\s*<a href="\/(movie|tv|zongyi|duanju)\/([0-9a-f]+)-(\d+)\.html">[\s\S]*?<img src="([^"]+)" alt="([^"]*)"[\s\S]*?<h2[^>]*>([\s\S]*?)<\/h2>\s*<p[^>]*>([\s\S]*?)<\/p>/g;
  for (const m of html.matchAll(slideRe)) {
    const h2 = m[6].replace(/<span[\s\S]*?<\/span>/g, '').trim();
    items.push({
      kind: m[1],
      id: m[2],
      ep: m[3],
      pic: m[4],
      name: decodeEntities(m[5]),
      remark: decodeEntities(h2.replace(decodeEntities(m[5]), '')).trim(),
      desc: decodeEntities(m[7]),
    });
  }
  return items;
}

/* ---------------- 播放页（每集的真实 m3u8 参数） ---------------- */

export interface PlayInfo {
  origin: string;
  /** 上游的取流地址（/api/m3u8?origin=..&url={视频id}），转成本站代理链路用 */
  url: string;
  title: string;
  /** 后续剧集（含各自的视频 id） */
  next: { origin: string; url: string; title: string }[];
}

/**
 * 按 JS 单引号字符串字面量的规则反转义。
 * 页面里 url 的 & 写成 `\\u0026`（JS 转义后是字面 `\u0026`，再由 JSON.parse 变 &），
 * 所以顺序必须是：先按 JS 规则解一层（\\→\、\uXXXX→字符、\/→/、\'→'），再 JSON.parse。
 */
function unescapeJsLiteral(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      const n = s[i + 1];
      if (n === 'u' && i + 5 < s.length) {
        const code = Number.parseInt(s.slice(i + 2, i + 6), 16);
        if (Number.isFinite(code)) {
          out += String.fromCharCode(code);
          i += 5;
          continue;
        }
      }
      if (n === '\\') { out += '\\'; i++; continue; }
      if (n === '/') { out += '/'; i++; continue; }
      if (n === "'") { out += "'"; i++; continue; }
      if (n === 'n') { out += '\n'; i++; continue; }
    }
    out += c;
  }
  return out;
}

/**
 * 解析播放页里嵌入的 window.xg_video_player_doc。
 * 页面里是 `aa: JSON.parse('...')` 和 `nexturl: JSON.parse('[...]')`，
 * 单引号内是 JS 字符串字面量（内含 \uXXXX 转义），要先按 JS 规则解一层再 JSON.parse。
 */
export function parsePlayPage(html: string): PlayInfo | null {
  const grab = (name: string): unknown | null => {
    const re = new RegExp(`${name}:\\s*JSON\\.parse\\('([\\s\\S]*?)'\\)`);
    const m = html.match(re);
    if (!m) return null;
    try {
      return JSON.parse(unescapeJsLiteral(m[1])) as unknown;
    } catch {
      return null;
    }
  };

  const aa = grab('aa') as { origin?: string; url?: string; title?: string } | null;
  if (!aa || !aa.url) return null;

  const nextRaw = grab('nexturl') as { origin?: string; url?: string; title?: string }[] | null;

  return {
    origin: decodeURIComponent(String(aa.origin ?? '')),
    url: String(aa.url),
    title: String(aa.title ?? ''),
    next: Array.isArray(nextRaw)
      ? nextRaw
          .filter((x) => x && x.url)
          .map((x) => ({
            origin: decodeURIComponent(String(x.origin ?? '')),
            url: String(x.url),
            title: String(x.title ?? ''),
          }))
      : [],
  };
}
