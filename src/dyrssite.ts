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

/* ---------------- 线路选择（探活缓存） ---------------- */

let activeLine: { line: string; at: number } | null = null;
const LINE_TTL_MS = 10 * 60_000;

/** 挑一条可用线路：优先缓存，其次探活，最后兜底 */
export async function pickLine(force = false): Promise<string> {
  if (!force && activeLine && Date.now() - activeLine.at < LINE_TTL_MS) {
    return activeLine.line;
  }
  let lines: string[] = [];
  try {
    lines = await listLines();
  } catch {
    // 忽略，走兜底
  }
  const candidates = [DEFAULT_LINE, ...lines.filter((l) => l !== DEFAULT_LINE)];

  // 并发探前 6 条，选第一条真正能取到页面的。
  // 注意：必须走 fetchRaw 而不是裸 fetch —— 上游会给「正在检测」挑战页（HTTP 429），
  // 裸 fetch 会把「线路是活的但被挑战」误判成不可用，于是永远退回第一条。
  const probe = await Promise.all(
    candidates.slice(0, 6).map(async (line) => {
      try {
        const r = await fetchRaw(`${line}/dianying.html`, line, 'text/html,*/*', 6000);
        const ok = r.status === 200 && r.body.length > 10_000 && !isChallengePage(r.body.toString('utf8'));
        return { line, ok };
      } catch {
        return { line, ok: false };
      }
    }),
  );
  const ok = probe.find((p) => p.ok);
  const chosen = ok?.line ?? candidates[0];
  activeLine = { line: chosen, at: Date.now() };
  return chosen;
}

export function resetSiteLineCache(): void {
  activeLine = null;
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

const pageCache = new Map<string, { at: number; data: HtmlResult }>();
const PAGE_TTL_MS = 5 * 60_000;
const PAGE_CACHE_MAX = 120;

/** 抓一个站点路径（以 / 开头），带 5 分钟缓存 */
export async function fetchSitePage(path: string, line?: string): Promise<HtmlResult> {
  const base = line ?? (await pickLine());
  const url = path.startsWith('http') ? path : `${base}${path}`;
  const hit = pageCache.get(url);
  if (hit && Date.now() - hit.at < PAGE_TTL_MS) return hit.data;

  const r = await fetchRaw(url, base, 'text/html,*/*');
  const data: HtmlResult = { status: r.status, html: r.body.toString('utf8'), finalUrl: r.finalUrl };

  if (r.status === 200 && data.html.length > 1000 && !isChallengePage(data.html)) {
    if (pageCache.size >= PAGE_CACHE_MAX) {
      // 淘汰最老的一条
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
    pageCache.set(url, { at: Date.now(), data });
  }
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
  const base = line ?? (await pickLine());
  const url = `${base}/s.html?encode=off&name=${encodeURIComponent(wd)}`;
  const r = await fetchRaw(url, base, 'text/html,*/*');
  return { status: r.status, html: r.body.toString('utf8'), finalUrl: r.finalUrl };
}

/** @deprecated 保留旧名字，等价于 resetSiteSessions() */
export function resetChallengeCache(): void {
  resetSiteSessions();
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
