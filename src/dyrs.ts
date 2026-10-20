/**
 * dyrs 体系（wzzycc 模板）CDN 接口复刻。
 *
 * 背景：dyrs.me 及其 30+ 个镜像站用的是一套自研接口，不是 macCMS。
 * 它的「列表/搜索/详情」是服务端渲染的 HTML，只有**播放链路**是 JSON + m3u8。
 * 这个模块就是把这套播放链路搬过来，让本站对外提供一模一样的能力：
 *
 *   GET /api/videox/least                       线路发现（34 条镜像）
 *   GET /api/dyrs/ip?line=                     线路探活
 *   GET /api/dyrs/m3u8?origin=&url=            主接口（原站 302 → CDN，这里默认 302）
 *   GET /api/dyrs/super?id=&origin=            CDN 主列表（master m3u8）
 *   GET /api/dyrs/cdn/m3u8?id=&raw=            CDN 二级列表（raw=1 直链 / 默认代理）
 *   GET /api/dyrs/cdn/ts?m3u8_id=&index=&uuid= 分片代理
 *
 * 设计取舍：
 *   - 对外**做代理**而不是把上游地址直接吐给播放器：上游 CDN 校验 Referer、
 *     且部分分片是相对路径，直连必失败。代理后本站地址就是唯一入口。
 *   - m3u8 文本要做**相对路径重写**：上游给的是 `/api/ts?...`，
 *     不重写的话浏览器会拿本站域名去解析，直接 404。
 *   - 线路表带缓存（10 分钟），避免每次播放都打一次上游。
 */

import { FETCH_TIMEOUT } from './config.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 默认镜像（用户如果没传 line，就用它） */
export const DEFAULT_LINE = 'https://tvcang.com';

/** CDN 主机：原站 detail 页里的 `box_data.url`；实测是独立域名 */
export const CDN_BASE = process.env.DYRS_CDN || 'https://box.dyrs.com.de';

/** 兜底线路表：拿不到 /api/videox/least 时用（来自 2026-10 实测） */
const FALLBACK_LINES = [
  'https://tvcang.com',
  'https://dyrsvip.cc',
  'https://dyrshd.com',
  'https://dyrs1.vip',
  'https://dyrs2.vip',
  'https://dyrs3.vip',
  'https://pianlai.cc',
  'https://wztvyzz.com',
  'https://huahaiyy.com',
  'https://dyrshd.cc',
  'https://laifu8.com',
  'https://dyrsok.cc',
  'https://godyrs.cc',
  'https://dyrsgo.cc',
  'https://dyrs5.vip',
  'https://viprs1.cc',
  'https://gddyrs.cc',
  'https://dyrs1080.cc',
  'https://dyrs720.cc',
  'https://dyvip1.cc',
];

/* ---------------- 线路发现 ---------------- */

let linesCache: { at: number; urls: string[] } | null = null;
const LINES_TTL_MS = 10 * 60_000;

/** 归一化线路地址：去重、去尾斜杠、只留 http/https */
function normLine(u: string): string {
  return String(u || '').trim().replace(/\/+$/, '');
}

/**
 * 取线路表。
 * 优先走上游 /api/videox/least（动态、最准），失败退回内置兜底表。
 */
export async function listLines(force = false): Promise<string[]> {
  if (!force && linesCache && Date.now() - linesCache.at < LINES_TTL_MS) {
    return linesCache.urls;
  }

  for (const host of [DEFAULT_LINE, ...FALLBACK_LINES.slice(1, 4)]) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT);
    try {
      const res = await fetch(`${host}/api/videox/least`, {
        signal: ac.signal,
        headers: { 'User-Agent': UA, Accept: 'application/json,*/*' },
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { urls?: unknown };
      const urls = Array.isArray(data?.urls)
        ? (data.urls as unknown[]).map((u) => normLine(String(u))).filter(Boolean)
        : [];
      if (urls.length) {
        const uniq = [...new Set(urls)];
        linesCache = { at: Date.now(), urls: uniq };
        return uniq;
      }
    } catch {
      // 换下一个候选
    } finally {
      clearTimeout(timer);
    }
  }

  linesCache = { at: Date.now(), urls: FALLBACK_LINES };
  return FALLBACK_LINES;
}

/** 清缓存（诊断/测试用） */
export function resetLinesCache(): void {
  linesCache = null;
}

/* ---------------- 通用抓取 ---------------- */

export interface FetchResult {
  status: number;
  contentType: string;
  body: Buffer;
  /** 跟随重定向后的最终地址 */
  finalUrl: string;
  /** 重定向目标（仅 redirect:'manual' 时有值） */
  location?: string;
}

/** 带超时、带 Referer、跟随重定向的抓取（upstream 需要 Referer 才给数据） */
async function fetchUpstream(
  url: string,
  opts: { referer?: string; timeoutMs?: number; accept?: string; redirect?: 'follow' | 'manual' } = {},
): Promise<FetchResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? FETCH_TIMEOUT);
  try {
    const headers: Record<string, string> = {
      'User-Agent': UA,
      Accept: opts.accept ?? '*/*',
    };
    if (opts.referer) headers.Referer = opts.referer;

    const res = await fetch(url, {
      headers,
      signal: ac.signal,
      redirect: opts.redirect ?? 'follow',
    });

    const location = res.headers.get('location') ?? undefined;
    return {
      status: res.status,
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
      body: Buffer.from(await res.arrayBuffer()),
      finalUrl: res.url || url,
      ...(location ? { location } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 探活 ---------------- */

export interface LineHealth {
  line: string;
  ok: boolean;
  ip?: string;
  ms: number;
  error?: string;
}

/** 线路探活：GET {line}/api/ip */
export async function checkLine(line: string, timeoutMs = 4000): Promise<LineHealth> {
  const base = normLine(line);
  const started = Date.now();
  try {
    const r = await fetchUpstream(`${base}/api/ip`, {
      referer: base + '/',
      timeoutMs,
      accept: 'application/json,*/*',
    });
    if (r.status !== 200) {
      return { line: base, ok: false, ms: Date.now() - started, error: `HTTP ${r.status}` };
    }
    const data = JSON.parse(r.body.toString('utf8')) as { ip?: string };
    const ok = !!data?.ip;
    return { line: base, ok, ip: data?.ip, ms: Date.now() - started, ...(ok ? {} : { error: '无 ip 字段' }) };
  } catch (e) {
    return {
      line: base,
      ok: false,
      ms: Date.now() - started,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** 并发探活，返回可用的线路（按响应快慢排序） */
export async function pickFastestLine(candidates?: string[], limit = 8): Promise<LineHealth | null> {
  const list = (candidates?.length ? candidates : await listLines()).slice(0, limit);
  const results = await Promise.all(list.map((l) => checkLine(l)));
  const ok = results.filter((r) => r.ok).sort((a, b) => a.ms - b.ms);
  return ok[0] ?? null;
}

/* ---------------- m3u8 链路 ---------------- */

/** 原站主接口地址（本站复刻的就是这个） */
export function upstreamMainUrl(line: string, id: string, origin: string): string {
  const u = new URL(`${normLine(line)}/api/m3u8`);
  u.searchParams.set('origin', origin);
  u.searchParams.set('url', id);
  return u.toString();
}

/** CDN 主列表地址 */
export function cdnSuperUrl(id: string, origin: string): string {
  const u = new URL(`${CDN_BASE}/api/super`);
  u.searchParams.set('id', id);
  if (origin) u.searchParams.set('origin', origin);
  return u.toString();
}

/**
 * 解析上游主接口的 302 Location（指向 CDN 的 /api/super）。
 * 上游可能返回 302 也可能直接 200 给内容，两种都认。
 */
export async function resolveMain(
  line: string,
  id: string,
  origin: string,
): Promise<{ kind: 'redirect'; location: string } | { kind: 'content'; result: FetchResult }> {
  const base = normLine(line);
  const url = upstreamMainUrl(base, id, origin);

  const r = await fetchUpstream(url, {
    referer: base + '/',
    redirect: 'manual',
    accept: '*/*',
  });

  if (r.status >= 300 && r.status < 400) {
    return { kind: 'redirect', location: r.location || '' };
  }
  return { kind: 'content', result: r };
}

/** 直接抓 CDN 主列表（master m3u8） */
export async function fetchSuper(id: string, origin: string, referer: string): Promise<FetchResult> {
  return fetchUpstream(cdnSuperUrl(id, origin), {
    referer,
    accept: 'application/vnd.apple.mpegurl,*/*',
  });
}

/** 抓 CDN 二级列表（media m3u8） */
export async function fetchCdnPlaylist(
  id: string,
  raw: boolean,
  referer: string,
): Promise<FetchResult> {
  const u = new URL(`${CDN_BASE}/api/m3u8`);
  u.searchParams.set('id', id);
  if (raw) u.searchParams.set('raw', '1');
  return fetchUpstream(u.toString(), { referer, accept: 'application/vnd.apple.mpegurl,*/*' });
}

/**
 * 抓直链型播放列表（上游 /api/direct）。
 *
 * 这个接口会 302 到真实 TS 主机（如 vip1.wzzym3u8.cc/m3u8/{片id}.t1080p{tm令牌}/1.m3u8），
 * 返回的 media 列表里分片是**相对名**（000.html / 001.html…）。
 * 必须开 redirect:'follow'，并拿 finalUrl 当基准去把相对名补成绝对地址。
 *
 * 为什么单开它：CDN 的 /api/ts 分片接口对未登录请求会悄悄返回一张微信二维码占位图
 * （不是真分片），所以 master 里那条 /api/m3u8 清晰度在服务端代理场景下选不得。
 */
export async function fetchDirectPlaylist(
  id: string,
  origin: string | undefined,
  referer: string,
): Promise<FetchResult> {
  const u = new URL(`${CDN_BASE}/api/direct`);
  u.searchParams.set('id', id);
  if (origin) u.searchParams.set('origin', origin);
  return fetchUpstream(u.toString(), {
    referer,
    accept: 'application/vnd.apple.mpegurl,*/*',
    timeoutMs: 20_000,
  });
}

/** 抓分片 */
export async function fetchSegment(
  id: string,
  index: number,
  uuid: string,
  referer: string,
): Promise<FetchResult> {
  const u = new URL(`${CDN_BASE}/api/ts`);
  u.searchParams.set('m3u8_id', id);
  u.searchParams.set('index', String(index));
  if (uuid) u.searchParams.set('uuid', uuid);
  return fetchUpstream(u.toString(), { referer, accept: '*/*', timeoutMs: 20_000 });
}

/**
 * 分片是不是「伪装成视频」的占位图/错误页。
 *
 * 实测踩坑：uuid 与二级列表不配对时，上游不会报错，而是**悄悄返回一张 PNG**
 * （89 50 4E 47 开头）。不识别的话播放器会把它当 TS 喂给 MSE，表现就是花屏 / 直接黑。
 * 这里认出来就报错，让前端走「重新取列表」的兜底。
 */
export function looksLikePlaceholder(buf: Buffer): boolean {
  if (buf.length < 4) return true;
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  // GIF / JPEG
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true;
  if (buf[0] === 0xff && buf[1] === 0xd8) return true;
  // HTML（302 没跟随时会拿到）
  if (buf[0] === 0x3c) return true;
  return false;
}

/**
 * 通用分片抓取（直链型 m3u8 里的真实 TS 地址）。
 * 注意：调用方必须先做 SSRF 校验（checkUrl），这里只负责抓。
 *
 * 超时放宽到 45s：dyrs 的真实 TS 主机（vip1.wzzym3u8.cc）单个 1080p 分片约 2MB，
 * 链路稍差时 20s 根本下不完，会表现成「取流失败 / 一直转圈」，而这不是地址错了。
 * 播放器侧需同步放宽 fragLoadingTimeOut，否则浏览器先超时、服务端白等。
 */
export async function fetchSegmentUrl(target: string, timeoutMs = 45_000): Promise<FetchResult> {
  return fetchUpstream(target, { accept: '*/*', timeoutMs });
}

/* ---------------- m3u8 重写 ---------------- */

/**
 * 重排 master，把「真能拿到分片」的清晰度提到最前，并丢掉必然拿占位图的那条。
 *
 * 实测 master 长这样：
 *   #EXT-X-STREAM-INF:BANDWIDTH=1000000
 *   /api/dyrs/cdn/m3u8?id=xxx            ← 分片走 CDN /api/ts，未登录时**静默返回 PNG 占位图** ✗
 *   #EXT-X-STREAM-INF:BANDWIDTH=900000
 *   /api/dyrs/cdn/m3u8?id=xxx&raw=1      ← 真 TS 直链（https://v.lzcdn27.com/…/xxx.ts）✓
 *   #EXT-X-STREAM-INF:BANDWIDTH=…
 *   /api/dyrs/direct?id=xxx&origin=vip1  ← 也能拿真分片（302 到真实 TS 主机）✓
 *
 * hls.js 默认按码率挑第一条，于是永远挑到那条占位图 —— 表现就是「列表能加载、
 * 分片全挂、一个画面都出不来」。这里做两件事：
 *   1. 按可用性排序：direct(0) → raw=1(1) → 其余(2)，同档保持原顺序（稳定排序）；
 *   2. 只要同一个 id 已经有 raw=1 的兄弟清晰度，就把没带 raw 的那条**直接删掉**，
 *      否则 hls.js 后续 ABR 切换时还会踩回占位图。
 *
 * 播放器侧再用 startLevel:0 固定第一条，两层保险。
 * 结构不认识就原样返回，绝不乱动。
 */
export function hoistPlayableVariants(text: string, self = '/api/dyrs'): string {
  const lines = text.split('\n');
  if (!lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) return text;

  const pairs: { key: string; at: number; tag: string; uri: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    const uri = lines[i + 1] ?? '';
    if (!uri || uri.startsWith('#')) continue;

    let key = '2';
    if (uri.includes(`${self}/direct?`)) key = '0';
    else if (uri.includes(`${self}/cdn/m3u8?`) && /[?&]raw=1(?:&|$)/.test(uri)) key = '1';
    pairs.push({ key, at: i, tag: lines[i], uri });
  }
  if (pairs.length <= 1) return text;

  // 有 raw=1 的话，同 id 的「无 raw」兄弟只会返回占位图，直接不要了
  const rawIds = new Set<string>();
  for (const p of pairs) {
    if (p.key !== '1') continue;
    const id = /[?&]id=([^&]+)/.exec(p.uri)?.[1];
    if (id) rawIds.add(id);
  }
  const kept = pairs.filter((p) => {
    if (p.key !== '2' || !p.uri.includes(`${self}/cdn/m3u8?`)) return true;
    const id = /[?&]id=([^&]+)/.exec(p.uri)?.[1];
    return !(id && rawIds.has(id));
  });
  if (!kept.length) return text;

  const sorted = kept
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (a.p.key === b.p.key ? a.i - b.i : a.p.key < b.p.key ? -1 : 1))
    .map((x) => x.p);

  // 顺序没变、也没删掉东西 → 原样返回
  const unchanged = kept.length === pairs.length && sorted.every((p, i) => p === kept[i]);
  if (unchanged) return text;

  // 只重建「变体区间」这一段，区间外的全局标签（#EXTM3U / #EXT-X-VERSION…）原样保留
  const from = pairs[0].at;
  const to = pairs[pairs.length - 1].at + 1; // 含 uri 行
  const isPairLine = (abs: number) => pairs.some((p) => p.at === abs || p.at + 1 === abs);
  for (let i = from; i <= to; i++) {
    if (!isPairLine(i) && lines[i].trim() !== '') return text; // 结构不认识，放弃
  }

  const rebuilt = sorted.flatMap((p) => [p.tag, p.uri]);
  return [...lines.slice(0, from), ...rebuilt, ...lines.slice(to + 1)].join('\n');
}

/**
 * 把上游 m3u8 里的地址重写成本站代理地址。
 *
 * 上游分片有两种形态：
 *   1. 绝对地址  https://v.lzcdn28.com/....ts        → 包一层 /api/dyrs/seg?u=
 *   2. 相对地址  /api/ts?m3u8_id=..&index=..&uuid=..  → 包一层 /api/dyrs/cdn/ts?...
 *
 * 不重写的话，相对地址会被浏览器按**本站域名**解析，直接 404。
 *
 * @param text    上游 m3u8 文本
 * @param cdnBase CDN 主机（相对地址的基准）
 * @param self    本站前缀，如 `/api/dyrs`
 */
export function rewriteDyrsPlaylist(text: string, cdnBase: string, self = '/api/dyrs'): string {
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();

    if (!line.trim()) {
      out.push(line);
      continue;
    }

    if (line.startsWith('#')) {
      // URI="..." 属性（KEY / MAP）也要重写，否则初始化分片会直连上游
      out.push(
        line.replace(/URI="([^"]+)"/g, (_m, uri: string) => {
          return `URI="${proxyUrlFor(uri, cdnBase, self)}"`;
        }),
      );
      continue;
    }

    out.push(proxyUrlFor(line.trim(), cdnBase, self));
  }
  return out.join('\n');
}

/** 单条地址 → 本站代理地址 */
function proxyUrlFor(target: string, cdnBase: string, self: string): string {
  // 相对地址：按 base 补全。
  // 注意 base 既可以是「主机」（https://box.dyrs.com.de），也可以是「列表文件自身地址」
  // （https://vip1.wzzym3u8.cc/m3u8/xxx/1.m3u8）—— 后者才能把 000.html 这种相对分片名
  // 解析到正确的目录下，所以这里不能再画蛇添足补一个 '/'。
  let abs = target;
  if (!/^https?:\/\//i.test(target)) {
    try {
      abs = new URL(target, cdnBase).toString();
    } catch {
      abs = target;
    }
  }

  // CDN 自己的 /api/ts 分片接口：走结构化的分片代理（保留 id/index/uuid 语义）
  try {
    const u = new URL(abs);
    if (u.pathname.endsWith('/api/ts')) {
      const id = u.searchParams.get('m3u8_id') ?? '';
      const index = u.searchParams.get('index') ?? '';
      const uuid = u.searchParams.get('uuid') ?? '';
      const p = new URLSearchParams();
      if (id) p.set('m3u8_id', id);
      if (index !== '') p.set('index', index);
      if (uuid) p.set('uuid', uuid);
      return `${self}/cdn/ts?${p.toString()}`;
    }
    // CDN 的二级列表（master 里的 /api/m3u8?id=..）
    if (u.pathname.endsWith('/api/m3u8')) {
      const id = u.searchParams.get('id') ?? '';
      const raw = u.searchParams.get('raw');
      const p = new URLSearchParams();
      if (id) p.set('id', id);
      if (raw) p.set('raw', raw);
      return `${self}/cdn/m3u8?${p.toString()}`;
    }
    // 直链型列表（master 里的 /api/direct?id=..&origin=..）：302 到真实 TS 主机，
    // 返回的 media 列表里分片是相对名，必须由 /api/dyrs/direct 跟着跳转、按最终地址
    // 把相对名补成绝对地址再代理，否则浏览器会按本站域名解析 → 404。
    if (u.pathname.endsWith('/api/direct')) {
      const id = u.searchParams.get('id') ?? '';
      const origin = u.searchParams.get('origin') ?? '';
      const p = new URLSearchParams();
      if (id) p.set('id', id);
      if (origin) p.set('origin', origin);
      return `${self}/direct?${p.toString()}`;
    }
  } catch {
    // 解析失败就走通用透传
  }

  // 其余（真实 TS CDN 直链）走通用透传代理
  return `${self}/seg?u=${encodeURIComponent(abs)}`;
}

/** 从 m3u8 文本里推断 content-type */
export function isPlaylistType(ct: string, body: string): boolean {
  if (/mpegurl|m3u/i.test(ct)) return true;
  return /^\s*#EXTM3U/i.test(body.slice(0, 64));
}
