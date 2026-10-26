/**
 * 分享页 / 播放页 → 真 m3u8。
 *
 * 采集站大量线路给的不是直链，而是一个网页：
 *   https://v.lzcdn27.com/share/42a35b21c91691fb5cd8724fa1a105ec
 *   https://hn.bfvvs.com/play/bW6w8XXa
 *
 * 这些页面里其实写着真正的播放列表（带 `sign` 的 m3u8），以前我们只看 URL 里有没有
 * `.m3u8` 就判定「不可播」，界面挂满 ⚠ —— 实测《嫁金钗》5 条这样的线路全部能解析出来，
 * 拉到的分片是标准 TS（`47 40 11 10`，536KB）。
 *
 * 三种页面形状（实测）：
 *   1. `var main = "/20261016/19360_5c14cbf9/index.m3u8?sign=…";`      ← lzcdn27 系
 *   2. `const url = "/20261016/43456_26a9c7ab/index.m3u8?sign=…";`     ← ffzy / dytt-tvs 系
 *   3. `const vid = 'https://host/play/xxx/index.m3u8';` 或同路径 + /index.m3u8 ← bfvvs / kuktxu 系
 *
 * `sign` 有有效期，所以结果只缓存 10 分钟，播放前还会再解析一次兜底。
 */

import { checkUrl } from './proxy.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CACHE_TTL = 10 * 60 * 1000;
const cache = new Map<string, { at: number; url: string; from: ExpandFrom }>();

export type ExpandFrom = 'main' | 'inline' | 'guess';

export interface ExpandResult {
  url: string;
  from: ExpandFrom;
}

/** 清空缓存（测试 / 排查用） */
export function resetExpandCache(): void {
  cache.clear();
}

/**
 * 从页面 HTML 里抠出 m3u8 地址（含相对地址解析）。
 *
 * 导出给单测用：三种形状各一条用例，避免以后改正则时静默退化。
 */
export function extractM3u8(html: string, pageUrl: string): ExpandResult | null {
  if (!html) return null;

  // 1) 赋值语句里的 m3u8（三种页面形状都在这里覆盖）
  const assigned =
    /(?:var\s+main|const\s+url|const\s+vid|let\s+url|let\s+main|var\s+url)\s*=\s*['"]([^'"]*\.m3u8[^'"]*)['"]/i.exec(
      html,
    );
  if (assigned?.[1]) return { url: absolutize(assigned[1], pageUrl), from: 'main' };

  // 2) 随便哪儿出现的 m3u8 字面量（有些站塞在 JSON 里）
  const inline = /['"]([^'"\s]*\.m3u8[^'"\s]*)['"]/i.exec(html);
  if (inline?.[1]) return { url: absolutize(inline[1], pageUrl), from: 'inline' };

  return null;
}

/** 把页面里的相对地址补成绝对地址；`//host/path` 这种协议相对地址也要处理 */
export function absolutize(raw: string, pageUrl: string): string {
  // JSON 里的地址常被写成 `https:\/\/host\/path`，先把转义斜杠还原
  const u = (raw ?? '').replace(/\\\//g, '/').trim();
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  try {
    return new URL(u.startsWith('//') ? `https:${u}` : u, pageUrl).toString();
  } catch {
    return '';
  }
}

/**
 * 解析一条分享页 / 播放页。
 *
 * 返回 null 表示解析不出来（页面改版、被墙、节点挂了），调用方应保持「不可播」而不是静默失败。
 */
export async function resolveSharePage(url: string, timeoutMs = 5000): Promise<ExpandResult | null> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL) return { url: hit.url, from: hit.from };

  const deny = await checkUrl(url);
  if (deny) return null;

  const html = await fetchText(url, timeoutMs);
  if (!html) return null;

  const found = extractM3u8(html, url);
  if (found) {
    cache.set(url, { at: Date.now(), url: found.url, from: found.from });
    return found;
  }

  // 3) 兜底：`/play/<id>` 这类页面通常就是「同路径 + /index.m3u8」
  const guessed = `${url.replace(/[?#].*$/, '').replace(/\/+$/, '')}/index.m3u8`;
  if (await looksLikePlaylist(guessed, timeoutMs)) {
    cache.set(url, { at: Date.now(), url: guessed, from: 'guess' });
    return { url: guessed, from: 'guess' };
  }

  return null;
}

async function fetchText(url: string, timeoutMs: number): Promise<string | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA },
    });
    // 有的站直接 302 到 m3u8，这时 res.url 已经不是页面了，交给上层按内容判断
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 拉一小段确认「这确实是播放列表」 */
async function looksLikePlaylist(url: string, timeoutMs: number): Promise<boolean> {
  const deny = await checkUrl(url);
  if (deny) return false;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'follow', headers: { 'User-Agent': UA } });
    if (!res.ok) return false;
    const text = await res.text();
    return text.slice(0, 64).includes('#EXTM3U');
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
