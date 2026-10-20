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
import { COVER_FETCH_TIMEOUT, FETCH_RETRIES, FETCH_TIMEOUT, ID_BATCH_SIZE, MIN_CATEGORY_TOTAL, TYPE_MAP, } from '../config.js';
import { buildPlayLines } from '../parser.js';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
export class SourceError extends Error {
    sourceId;
    constructor(message, sourceId) {
        super(message);
        this.sourceId = sourceId;
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
function decodeXmlEntities(s) {
    return s
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
        .replace(/&amp;/g, '&');
}
function tagText(block, tag) {
    const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    return m ? decodeXmlEntities(m[1]).trim() : '';
}
export function parseMaccmsXml(text) {
    const listAttr = text.match(/<list\b([^>]*)>/);
    const attr = (s, k) => {
        const m = s?.match(new RegExp(`${k}="(\\d+)"`));
        return m ? Number(m[1]) : 0;
    };
    const videos = [...text.matchAll(/<video>([\s\S]*?)<\/video>/g)].map((m) => m[1]);
    const list = videos.map((v) => {
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
async function fetchJson(url, sourceId, retries = FETCH_RETRIES, timeoutMs = FETCH_TIMEOUT) {
    let lastErr;
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
            if (!text.trim())
                throw new Error('响应为空');
            // 采集站偶发返回被截断的 JSON（HTTP 200 但 body 不完整），
            // 必须解析成功且看起来完整才算数，否则重试。
            let data;
            if (/^\s*<\?xml/i.test(text) || /^\s*<rss/i.test(text)) {
                data = parseMaccmsXml(text);
            }
            else {
                try {
                    data = JSON.parse(text);
                }
                catch {
                    throw new Error('响应 JSON 不完整（可能被截断）');
                }
            }
            if (typeof data.code !== 'number' || !Array.isArray(data.list)) {
                throw new Error('响应结构异常');
            }
            return data;
        }
        catch (e) {
            lastErr = e;
            // 指数退避后再试
            if (attempt < retries) {
                await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
            }
        }
        finally {
            clearTimeout(timer);
        }
    }
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new SourceError(`请求失败: ${msg}`, sourceId);
}
/** 采集站原始条目 → 归一化 Item */
function toItem(v, src) {
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
function stripHtml(s) {
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
function buildUrl(base, params) {
    const u = new URL(base);
    for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === '')
            continue;
        u.searchParams.set(k, String(v));
    }
    return u.toString();
}
/** 搜索 */
export async function search(src, wd) {
    const url = buildUrl(src.base, { ac: 'detail', wd });
    const data = await fetchJson(url, src.id);
    if (data.code !== 1 || !Array.isArray(data.list))
        return [];
    return data.list.filter((v) => v && v.vod_name).map((v) => toItem(v, src));
}
/**
 * 分类分页列表。
 *
 * 用 ac=list：又快又小（5.6KB），但它的 vod_pic / vod_year **是空的**。
 * 封面不在这一步取，交给 fetchCovers() 由前端渐进式补齐——
 * 因为补封面那一步实测会抖动（同一请求 4.2s ~ 8s+），
 * 阻塞在这里会让整页等十几秒。
 */
export async function list(src, typeId, page) {
    const url = buildUrl(src.base, { ac: 'list', t: typeId, pg: page });
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
 * 按 vod_id 批量取封面 / 年份 / 地区 / 状态。
 *
 * 用 ac=detail&ids= 一次拿一页（20 条约 42KB），
 * 比 ac=detail&t=（整个分类，剧集类 109KB / 33s）便宜得多。
 *
 * 返回 Map<vod_id, CoverInfo>；失败的批次直接跳过，不抛错。
 */
export async function fetchCovers(src, ids) {
    const out = new Map();
    if (ids.length === 0)
        return out;
    for (let i = 0; i < ids.length; i += ID_BATCH_SIZE) {
        const chunk = ids.slice(i, i + ID_BATCH_SIZE);
        try {
            const url = buildUrl(src.base, { ac: 'detail', ids: chunk.join(',') });
            // 这一步比列表慢且会抖动，给足超时并重试一次
            const data = await fetchJson(url, src.id, 1, COVER_FETCH_TIMEOUT);
            if (data.code !== 1 || !Array.isArray(data.list))
                continue;
            for (const v of data.list) {
                if (!v)
                    continue;
                const id = String(v.vod_id ?? '');
                if (!id)
                    continue;
                out.set(id, {
                    pic: v.vod_pic?.trim() || undefined,
                    year: v.vod_year?.trim() || undefined,
                    area: v.vod_area?.trim() || undefined,
                    remarks: v.vod_remarks?.trim() || undefined,
                });
            }
        }
        catch {
            // 某一批失败就跳过，前端只是少几张图，不影响列表
        }
    }
    return out;
}
/** 详情（含线路与选集） */
export async function detail(src, id) {
    const url = buildUrl(src.base, { ac: 'detail', ids: id });
    const data = await fetchJson(url, src.id);
    if (data.code !== 1 || !Array.isArray(data.list) || data.list.length === 0)
        return null;
    const raw = data.list[0];
    if (!raw || !raw.vod_name)
        return null;
    const base = toItem(raw, src);
    const lines = buildPlayLines(raw.vod_play_from, raw.vod_play_url);
    return { ...base, lines };
}
/** 存活探测：轻量请求，判断源是否可用 */
export async function health(src) {
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
    }
    catch (e) {
        return {
            id: src.id,
            name: src.name,
            ok: false,
            ms: Date.now() - started,
            error: e instanceof Error ? e.message : String(e),
        };
    }
}
/**
 * 探测某个源的分类列表。
 *
 * 各源的分类 id 完全不同（同一个 t=1 在 A 站是只有 1 部的「电影片」，
 * 在 B 站又是别的），所以不能硬编码，必须探测出来。
 *
 * 做法：并发探测候选 id，按返回的 type_name 归并，同名取条数最多的那个 id。
 * 用 ac=list 而不是 ac=detail —— 探测只需要 type_name 和 total，
 * 而 ac=detail 在剧集分类上要 33 秒，探测 40 个分类会慢到不可用。
 */
export async function discoverCategories(src) {
    const candidates = Array.from({ length: 40 }, (_, i) => i + 1);
    // 并发限 6，并留出间隔，避免把采集站打出限流
    const CONCURRENCY = 6;
    const results = [];
    // 死源早退：前两批（12 个 id）全部失败说明这个源基本挂了，
    // 没必要把剩下 28 个超时也傻等完（最坏 8s × 5 批 ≈ 半分钟）
    let leadingFailures = 0;
    for (let i = 0; i < candidates.length; i += CONCURRENCY) {
        const chunk = candidates.slice(i, i + CONCURRENCY);
        const settled = await Promise.allSettled(chunk.map(async (t) => {
            const url = buildUrl(src.base, { ac: 'list', t, pg: 1 });
            // 探测时少重试，避免整体太慢
            const data = await fetchJson(url, src.id, 0);
            const first = data.list?.[0];
            if (!first || !first.type_name)
                return null;
            return {
                id: String(t),
                name: first.type_name,
                total: Number(data.total ?? 0) || 0,
            };
        }));
        let chunkOk = 0;
        for (const r of settled) {
            const ok = r.status === 'fulfilled' && r.value !== null;
            if (ok)
                chunkOk++;
            results.push(r.status === 'fulfilled' ? r.value : null);
        }
        if (i === 0 || i === CONCURRENCY) {
            leadingFailures += chunkOk === 0 ? CONCURRENCY : 0;
            if (leadingFailures >= 12)
                return [];
        }
        if (i + CONCURRENCY < candidates.length) {
            await new Promise((r) => setTimeout(r, 250));
        }
    }
    // 按分类名归并，保留条数最多的 id
    const best = new Map();
    for (const cur of results) {
        if (!cur)
            continue;
        const prev = best.get(cur.name);
        if (!prev || cur.total > prev.total) {
            best.set(cur.name, cur);
        }
    }
    // 过滤僵尸分类：实测有几条只有 1~4 部的占位分类（电影片/连续剧/综艺片/动漫片），
    // 留着会占满界面但点进去没内容
    return [...best.values()]
        .filter((c) => c.total >= MIN_CATEGORY_TOTAL)
        .sort((a, b) => b.total - a.total);
}
export { TYPE_MAP };
