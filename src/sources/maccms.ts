/**
 * macCMS（苹果CMS）采集站适配器。
 *
 * 标准接口：GET {base}?ac={动作}&{参数}
 *   ac=list    列表（不含播放地址）
 *   ac=detail  详情（含 vod_play_url）
 *   wd=        关键词搜索
 *   t=         分类 id
 *   pg=        页码
 */

import {
  COVER_FETCH_TIMEOUT,
  FETCH_RETRIES,
  FETCH_TIMEOUT,
  ID_BATCH_SIZE,
  MIN_CATEGORY_TOTAL,
  TYPE_MAP,
} from '../config.js';
import { buildPlayLines } from '../parser.js';
import type { SourceConfig } from '../config.js';
import type {
  DetailResult,
  Item,
  ItemDetail,
  ListResult,
  PlayLine,
  RawResponse,
  RawVod,
} from './types.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class SourceError extends Error {
  constructor(
    message: string,
    readonly sourceId: string,
  ) {
    super(message);
    this.name = 'SourceError';
  }
}

/**
 * macCMS XML 格式解析。
 *
 * 部分老牌源（如 yzzy 优质资源）只提供 XML 输出：
 *   <rss><list page="1" pagecount="..." recordcount="...">
 *     <video><id>..</id><name>..</name><type>..</type><dt>简介</dt>
 *     <dl><dd flag="线路名">第01集$url#第02集$url</dd></dl>
 *   </video></list></rss>
 * 这里不引 XML 库，按标签结构化提取，映射回和 JSON 相同的 RawResponse。
 */

function decodeXmlEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

function tagText(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? decodeXmlEntities(m[1]).trim() : '';
}

export function parseMaccmsXml(text: string): RawResponse {
  const listAttr = text.match(/<list\b([^>]*)>/);
  const attr = (s: string | undefined, k: string): number => {
    const m = s?.match(new RegExp(`${k}="(\\d+)"`));
    return m ? Number(m[1]) : 0;
  };

  const videos = [...text.matchAll(/<video>([\s\S]*?)<\/video>/g)].map((m) => m[1]);
  const list: RawVod[] = videos.map((v) => {
    // 播放线路：<dl><dd flag="xxx">...</dd><dd flag="yyy">...</dd></dl>
    const dl = v.match(/<dl>([\s\S]*?)<\/dl>/)?.[1] ?? '';
    const dds = [...dl.matchAll(/<dd\s+flag="([^"]*)">([\s\S]*?)<\/dd>/g)];
    const playFrom = dds.map((d) => decodeXmlEntities(d[1]).trim()).join('$$$');
    const playUrl = dds.map((d) => decodeXmlEntities(d[2]).trim()).join('$$$');

    return {
      vod_id: tagText(v, 'id'),
      vod_name: tagText(v, 'name'),
      vod_year: tagText(v, 'year') || undefined,
      vod_area: tagText(v, 'area') || undefined,
      vod_lang: tagText(v, 'lang') || undefined,
      vod_actor: tagText(v, 'actor') || undefined,
      vod_director: tagText(v, 'director') || undefined,
      vod_pic: tagText(v, 'pic') || undefined,
      vod_content: tagText(v, 'dt') || undefined,
      vod_remarks: tagText(v, 'note') || undefined,
      type_name: tagText(v, 'type') || undefined,
      ...(playFrom ? { vod_play_from: playFrom, vod_play_url: playUrl } : {}),
    };
  });

  return {
    code: 1,
    page: attr(listAttr?.[1], 'page') || 1,
    pagecount: attr(listAttr?.[1], 'pagecount') || 1,
    total: attr(listAttr?.[1], 'recordcount') || list.length,
    list,
  };
}

/** 带超时 + 重试的 JSON 请求（兼容 XML 输出的源） */
async function fetchJson(
  url: string,
  sourceId: string,
  retries = FETCH_RETRIES,
  timeoutMs = FETCH_TIMEOUT,
): Promise<RawResponse> {
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        headers: {
          'User-Agent': UA,
          Accept: 'application/json,text/plain,*/*',
        },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const text = await res.text();
      if (!text.trim()) throw new Error('响应为空');

      // 采集站偶发返回被截断的 JSON（HTTP 200 但 body 不完整），
      // 必须解析成功且看起来完整才算数，否则重试。
      let data: RawResponse;
      if (/^\s*<\?xml/i.test(text) || /^\s*<rss/i.test(text)) {
        data = parseMaccmsXml(text);
      } else {
        try {
          data = JSON.parse(text) as RawResponse;
        } catch {
          throw new Error('响应 JSON 不完整（可能被截断）');
        }
      }
      if (typeof data.code !== 'number' || !Array.isArray(data.list)) {
        throw new Error('响应结构异常');
      }
      return data;
    } catch (e) {
      lastErr = e;
      // 指数退避后再试
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new SourceError(`请求失败: ${msg}`, sourceId);
}

/** 采集站原始条目 → 归一化 Item */
function toItem(v: RawVod, src: SourceConfig): Item {
  return {
    id: String(v.vod_id ?? ''),
    name: (v.vod_name ?? '').trim(),
    sub: v.vod_sub?.trim() || undefined,
    year: v.vod_year?.trim() || undefined,
    area: v.vod_area?.trim() || undefined,
    lang: v.vod_lang?.trim() || undefined,
    actor: v.vod_actor?.trim() || undefined,
    director: v.vod_director?.trim() || undefined,
    pic: v.vod_pic?.trim() || undefined,
    content: stripHtml(v.vod_content ?? '') || undefined,
    remarks: v.vod_remarks?.trim() || undefined,
    score: v.vod_score?.trim() || undefined,
    typeName: v.type_name?.trim() || undefined,
    source: src.id,
    sourceName: src.name,
  };
}

/** 简介里常带 HTML 标签，粗清理一下 */
function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .trim();
}

/** 构造请求地址 */
function buildUrl(base: string, params: Record<string, string | number | undefined>): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/** 搜索 */
/**
 * 搜索（只关心片子列表）。
 *
 * 区分「源不支持搜索」和「源这次挂了」是本模块的重点：
 * 实测 `tyyszy` / `sdzy` 的 `wd=` 一律返回 6 字节纯文本「暂不支持搜索」，
 * 以前被当成故障 → 前端报「部分片源暂时不可用」，还会累计熔断计数把它们从**列表**里踢掉。
 * 现在这种情况返回 `unsupported: true`，上层既不会弹错误，也不会记失败。
 */
export interface SearchOutcome {
  items: Item[];
  /** 源不支持按名字搜（不是故障） */
  unsupported: boolean;
}

export async function searchEx(src: SourceConfig, wd: string): Promise<SearchOutcome> {
  const payload = await searchPayload(src, wd);
  if (payload === 'unsupported') return { items: [], unsupported: true };
  const list = payload.list ?? [];
  return {
    items: list.filter((v) => v && v.vod_name).map((v) => toItem(v, src)),
    unsupported: false,
  };
}

/** 老接口：只要列表。不支持搜索时返回空数组 */
export async function search(src: SourceConfig, wd: string): Promise<Item[]> {
  return (await searchEx(src, wd)).items;
}

/**
 * 取搜索响应（原样 JSON / XML）。
 *
 * 只有「明确的纯文本提示」才会被判定为 unsupported；
 * 网络错误、被截断的 JSON 仍然抛错，避免把真故障伪装成「不支持搜索」。
 */
async function searchPayload(src: SourceConfig, wd: string): Promise<RawResponse | 'unsupported'> {
  const url = buildUrl(src.base, { ac: 'detail', wd });
  const text = await fetchTextRaw(url);
  const t = text.trim();

  if (/暂不支持/.test(t)) return 'unsupported';
  if (!t) throw new SourceError('搜索响应为空', src.id);

  const looksJson = t.startsWith('{') || t.startsWith('[');
  const looksXml = /^<\?xml/i.test(t) || /^<rss/i.test(t);
  if (!looksJson && !looksXml) {
    // 「暂不支持搜索」这类纯文本：短、没有结构，是能力问题不是故障
    if (t.length <= 300) return 'unsupported';
    throw new SourceError('搜索响应不是 JSON', src.id);
  }

  const data = looksXml ? parseMaccmsXml(t) : (JSON.parse(t) as RawResponse);
  if (typeof data.code !== 'number' || !Array.isArray(data.list)) {
    throw new SourceError('搜索响应结构异常', src.id);
  }
  return data;
}

/** 取原始文本（不重试；搜索专用，需要看到「暂不支持搜索」这种非 JSON 正文） */
async function fetchTextRaw(url: string, timeoutMs = 8000): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json,text/plain,*/*' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 分类分页列表。
 *
 * 用 ac=list：又快又小（5.6KB），但它的 vod_pic / vod_year **是空的**。
 * 封面不在这一步取，交给 fetchCovers() 由前端渐进式补齐——
 * 因为补封面那一步实测会抖动（同一请求 4.2s ~ 8s+），
 * 阻塞在这里会让整页等十几秒。
 *
 * `facets` 是**服务端筛选**（不是前端过滤）：实测 macCMS 的 ac=list 认
 * `area` / `year` / `lang` 三个参数，传了就是真过滤（含分页）。
 * 取值必须先经 `src/facets.ts` 归一（`中国大陆` 要写成 `大陆` 才生效）。
 */
export async function list(
  src: SourceConfig,
  typeId: string | undefined,
  page: number,
  facets?: Record<string, string>,
): Promise<ListResult> {
  const url = buildUrl(src.base, { ac: 'list', t: typeId, pg: page, ...(facets ?? {}) });
  const data = await fetchJson(url, src.id);

  const items = Array.isArray(data.list)
    ? data.list.filter((v) => v && v.vod_name).map((v) => toItem(v, src))
    : [];

  return {
    items,
    page: Number(data.page ?? page) || page,
    pageCount: Number(data.pagecount ?? 1) || 1,
    total: Number(data.total ?? items.length) || items.length,
    source: src.id,
  };
}

/**
 * 只取总数（不解析条目），给「一致性守卫」当基线用。
 *
 * 为什么需要它：实测上游会偶发**忽略筛选参数**、直接返回全量
 * （`area=美国` 本该 1454，有一次返回了 4978）。判定依据就是
 * 「带筛选的 total == 不带筛选的 total」，所以要能单独拿基线。
 */
export async function countTotal(
  src: SourceConfig,
  typeId: string | undefined,
): Promise<number | null> {
  try {
    const url = buildUrl(src.base, { ac: 'list', t: typeId, pg: 1 });
    const data = await fetchJson(url, src.id);
    const n = Number(data.total);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/** 补齐后的卡片信息 */
export interface CoverInfo {
  pic?: string;
  year?: string;
  area?: string;
  remarks?: string;
}

/**
 * 按 vod_id 批量取封面 / 年份 / 地区 / 状态。
 *
 * 用 ac=detail&ids= 一次拿一页（20 条约 42KB），
 * 比 ac=detail&t=（整个分类，剧集类 109KB / 33s）便宜得多。
 *
 * 返回 Map<vod_id, CoverInfo>；失败的批次直接跳过，不抛错。
 */
export async function fetchCovers(
  src: SourceConfig,
  ids: string[],
): Promise<Map<string, CoverInfo>> {
  const out = new Map<string, CoverInfo>();
  if (ids.length === 0) return out;

  for (let i = 0; i < ids.length; i += ID_BATCH_SIZE) {
    const chunk = ids.slice(i, i + ID_BATCH_SIZE);
    try {
      const url = buildUrl(src.base, { ac: 'detail', ids: chunk.join(',') });
      // 这一步比列表慢且会抖动，给足超时并重试一次
      const data = await fetchJson(url, src.id, 1, COVER_FETCH_TIMEOUT);
      if (data.code !== 1 || !Array.isArray(data.list)) continue;

      for (const v of data.list) {
        if (!v) continue;
        const id = String(v.vod_id ?? '');
        if (!id) continue;
        out.set(id, {
          pic: v.vod_pic?.trim() || undefined,
          year: v.vod_year?.trim() || undefined,
          area: v.vod_area?.trim() || undefined,
          remarks: v.vod_remarks?.trim() || undefined,
        });
      }
    } catch {
      // 某一批失败就跳过，前端只是少几张图，不影响列表
    }
  }

  return out;
}

/** 详情（含线路与选集） */
export async function detail(src: SourceConfig, id: string): Promise<ItemDetail | null> {
  const url = buildUrl(src.base, { ac: 'detail', ids: id });
  const data = await fetchJson(url, src.id);
  if (data.code !== 1 || !Array.isArray(data.list) || data.list.length === 0) return null;

  const raw = data.list[0];
  if (!raw || !raw.vod_name) return null;

  const base = toItem(raw, src);
  const lines = buildPlayLines(raw.vod_play_from, raw.vod_play_url);

  return { ...base, lines };
}

/**
 * 带线路的搜索：**和 `search()` 是同一个请求**，只是把线路也解析出来。
 *
 * `ac=detail&wd=` 的响应里本来就带 `vod_play_from` / `vod_play_url`，
 * `search()` 只取了片名/年份把线路丢掉了。跨源聚合线路时如果先 search 再 detail
 * 就是每个源 2 个请求；用这个函数**每个源只要 1 个请求**。
 */
export interface SearchDetailedOutcome {
  hits: { item: Item; lines: PlayLine[] }[];
  unsupported: boolean;
}

export async function searchDetailed(src: SourceConfig, wd: string): Promise<SearchDetailedOutcome> {
  const payload = await searchPayload(src, wd);
  if (payload === 'unsupported') return { hits: [], unsupported: true };

  const list = payload.list ?? [];
  return {
    unsupported: false,
    hits: list
      .filter((v) => v && v.vod_name)
      .map((v) => ({
        item: toItem(v, src),
        lines: buildPlayLines(v.vod_play_from, v.vod_play_url),
      })),
  };
}

/** 存活探测：轻量请求，判断源是否可用 */
export async function health(
  src: SourceConfig,
): Promise<{ id: string; name: string; ok: boolean; ms: number; error?: string }> {
  const started = Date.now();
  try {
    const url = buildUrl(src.base, { ac: 'list', pg: 1 });
    const data = await fetchJson(url, src.id);
    const ok = data.code === 1 && Array.isArray(data.list);
    return {
      id: src.id,
      name: src.name,
      ok,
      ms: Date.now() - started,
      ...(ok ? {} : { error: `code=${data.code}` }),
    };
  } catch (e) {
    return {
      id: src.id,
      name: src.name,
      ok: false,
      ms: Date.now() - started,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export interface CategoryInfo {
  id: string;
  name: string;
  /**
   * 条数。`null` = 尚未采集。
   *
   * `class` 树本身不带条数；要数字就得按 id 逐个 `ac=list&t=` 探（8 源 × 16 分类 = 128 次），
   * 所以默认不查，只在显式 `?counts=1` 时才补。
   */
  total: number | null;
  /** 父分类名（由 `type_pid` 解析而来）；没有层级信息的源为 null */
  parent: string | null;
}

/** `class` 树的一行（已解析 type_pid） */
export interface ClassNode {
  id: string;
  name: string;
  parent: string | null;
}

/**
 * 一次请求拿到源的**完整分类树**。
 *
 * 这是本模块最重要的一步简化：以前靠 `t=1..40` 逐个探测（8 源 320 次请求 / 57.8 秒），
 * 而且 id > 40 的分类直接漏掉 —— lziapi 的「短剧」(46, 2.4 万部)、「AI漫剧」(52, 1.4 万部)
 * 就是这么丢的。`ac=list` 的响应里本来就带 `class` 字段，一次就够。
 *
 * 注意：`type_pid` 不是所有源都有（实测 hongniu / sdzy 只给 id + name），
 * 缺失时 `parent` 为 null，上层退回按名字规则归类。
 */
export async function fetchClassTree(src: SourceConfig): Promise<ClassNode[]> {
  const url = buildUrl(src.base, { ac: 'list' });
  // 0 次重试 + 5s：这一步只是拿元数据。
  // 实测 tyyszy 稳定要 8~10s（它自己能 200，但慢到没法用来浏览分类），
  // 5s 把它挡在外面；超时不会写缓存，下次刷新只补它一个，不再拖累整批。
  const data = await fetchJson(url, src.id, 0, 5000);
  const rows = Array.isArray(data.class) ? data.class : [];
  if (rows.length === 0) return [];

  const byId = new Map<string, string>();
  for (const r of rows) {
    const id = String(r?.type_id ?? '').trim();
    const name = String(r?.type_name ?? '').trim();
    if (id && name) byId.set(id, name);
  }

  const nodes: ClassNode[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const id = String(r?.type_id ?? '').trim();
    const name = String(r?.type_name ?? '').trim();
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    const rawPid = r?.type_pid === undefined || r?.type_pid === null ? '' : String(r.type_pid).trim();
    // pid 指向自己不合法，指向不存在的父也当顶层
    const parent = rawPid && rawPid !== '0' && rawPid !== id ? (byId.get(rawPid) ?? null) : null;
    nodes.push({ id, name, parent });
  }
  return nodes;
}

/** 按 id 批量取条数（并发 6）。只有 `?counts=1` 才会用到。 */
export async function fetchCategoryCounts(
  src: SourceConfig,
  ids: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const CONCURRENCY = 6;
  const queue = [...new Set(ids.filter(Boolean))];

  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= queue.length) return;
      const t = queue[i]!;
      try {
        const url = buildUrl(src.base, { ac: 'list', t, pg: 1 });
        const data = await fetchJson(url, src.id, 0);
        const n = Number(data.total);
        if (Number.isFinite(n) && n >= 0) out.set(t, n);
      } catch {
        // 单个分类取不到就跳过，不影响其它
      }
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 探测某个源的分类列表。
 *
 * 优先用 `class` 树（1 次请求、含层级、不漏 id）。
 * 只有「源正常应答但没给 class」才退回逐个探测（说明它是活的，逐个问是安全的）。
 *
 * **`class` 请求本身失败时直接抛错**（不再吞掉返回空数组）：
 * 上层要据此区分「这个源这次没采到」和「这个源没有分类」，
 * 前者不该被缓存 6 小时 —— 一次抖动就让某个源的分类消失半天。
 */
export async function discoverCategories(src: SourceConfig): Promise<CategoryInfo[]> {
  const nodes = await fetchClassTree(src);
  if (nodes.length > 0) {
    return nodes.map((n) => ({ id: n.id, name: n.name, total: null, parent: n.parent }));
  }
  return probeCategories(src, 80);
}

/**
 * 兜底：逐个 id 探测（只在源不返回 `class` 时使用）。
 *
 * 各源的分类 id 完全不同，所以不能硬编码，只能问。
 * 用 ac=list 而不是 ac=detail —— 探测只需要 type_name 和 total，
 * 而 ac=detail 在剧集分类上要 33 秒。
 */
async function probeCategories(src: SourceConfig, maxId: number): Promise<CategoryInfo[]> {
  const candidates = Array.from({ length: maxId }, (_, i) => i + 1);
  const CONCURRENCY = 8;
  const results: (CategoryInfo | null)[] = [];
  let leadingFailures = 0;
  // 总预算：80 个 id × 6s 超时最坏能拖到一分钟，必须设上限，到点就收摊
  const deadline = Date.now() + 15_000;

  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    if (Date.now() > deadline) break;
    const chunk = candidates.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map(async (t) => {
        const url = buildUrl(src.base, { ac: 'list', t, pg: 1 });
        const data = await fetchJson(url, src.id, 0, 6000);
        const first = data.list?.[0];
        if (!first || !first.type_name) return null;
        return {
          id: String(t),
          name: first.type_name,
          total: Number(data.total ?? 0) || 0,
          parent: null,
        } as CategoryInfo;
      }),
    );

    let chunkOk = 0;
    for (const r of settled) {
      const ok = r.status === 'fulfilled' && r.value !== null;
      if (ok) chunkOk++;
      results.push(r.status === 'fulfilled' ? r.value : null);
    }
    if (i === 0 || i === CONCURRENCY) {
      leadingFailures += chunkOk === 0 ? CONCURRENCY : 0;
      if (leadingFailures >= 12) return [];
    }

    if (i + CONCURRENCY < candidates.length) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const best = new Map<string, CategoryInfo>();
  for (const cur of results) {
    if (!cur) continue;
    const prev = best.get(cur.name);
    if (!prev || (cur.total ?? 0) > (prev.total ?? 0)) {
      best.set(cur.name, cur);
    }
  }

  return [...best.values()].filter((c) => (c.total ?? 0) >= MIN_CATEGORY_TOTAL);
}

export { TYPE_MAP };
export type { DetailResult };
