/**
 * m3u8 广告过滤（服务端播放列表清洗）。
 *
 * 采集站的 m3u8 里经常插广告分片，常见特征是广告分片来自与正片不同的 CDN 域名，
 * 且前后有 #EXT-X-DISCONTINUITY 分隔。这里在服务端把播放列表拉回来：
 *   1. master 播放列表：只重写子播放列表地址，指回本机接口继续清洗
 *   2. media 播放列表：按分片域名聚类，少数派域名（以及命中广告特征的分片）整组剔除
 *
 * 分片地址支持两种输出模式（见 rebuildPlaylist）：
 *   - 直连模式：分片保持上游 CDN 原地址，不占服务器带宽（/api/hls 默认）
 *   - 代理模式：分片包一层本机代理（/api/proxy）——CDN 校验 Referer 或不开 CORS 时用
 * 两种模式都会走同一套广告剔除，所以「回落到代理」不会再让广告冒出来。
 *
 * 判定策略偏保守：只有当「少数派域名」确实存在且广告特征明显时才剔除，
 * 判不出来就原样放行——宁可放过广告，不可误杀正片。
 */
import { resolveUrl } from './proxy.js';
/** 已知广告分片的 URL 特征（小写匹配）。注意避免会误伤正片的宽泛词 */
const AD_URL_PATTERNS = [
    '/ad/',
    '/ads/',
    '/adv/',
    'adcreative',
    'adplayer',
    '/adservice',
    '/adimg',
    '/adgg',
    'guanggao',
    '/guangg',
    'doubleclick',
    'tracking',
    '/promo/',
];
function isMasterPlaylist(text) {
    return text.includes('#EXT-X-STREAM-INF');
}
/**
 * media playlist 里「属于整份列表」的标签，按 hls 规范顺序排列。
 * 重建时必须原样搬回去 —— 早期版本把这些全丢了（只硬写 VERSION + PLAYLIST-TYPE），
 * 少了 #EXT-X-TARGETDURATION 这种必填项，部分播放器会判为非法列表。
 */
const GLOBAL_TAGS = [
    '#EXT-X-VERSION',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXT-X-START',
    '#EXT-X-TARGETDURATION',
    '#EXT-X-MEDIA-SEQUENCE',
    '#EXT-X-DISCONTINUITY-SEQUENCE',
    '#EXT-X-PLAYLIST-TYPE',
];
/**
 * 解析 media playlist。
 * 每个分片带着它前面累积的标签（EXTINF / DISCONTINUITY / KEY 等），
 * 这样剔除某个分片时，它专属的标签一起走，不会留下孤儿 EXTINF；
 * 全局标签单独收集，重建时原样放回。
 */
function parsePlaylist(text, baseUrl) {
    const segments = [];
    const globals = new Map();
    let pending = [];
    let hasEndlist = false;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line)
            continue;
        if (line.startsWith('#')) {
            // 这些是全局标签，不属于任何分片，重建时统一放回
            if (line.startsWith('#EXTM3U'))
                continue;
            if (line.startsWith('#EXT-X-ENDLIST')) {
                hasEndlist = true;
                continue;
            }
            const key = GLOBAL_TAGS.find((p) => line.startsWith(p));
            if (key) {
                // 同名标签只保留第一条，避免重复的 TARGETDURATION 之类
                if (!globals.has(key))
                    globals.set(key, line);
                continue;
            }
            pending.push(line);
            continue;
        }
        const abs = resolveUrl(line, baseUrl);
        let host = '';
        try {
            host = new URL(abs).hostname;
        }
        catch {
            host = '';
        }
        segments.push({ tags: pending, url: abs, host });
        pending = [];
    }
    const ordered = GLOBAL_TAGS.filter((k) => globals.has(k)).map((k) => globals.get(k));
    return { segments, globals: ordered, hasEndlist };
}
/** 取分片里最长的 #EXTINF 时长（TARGETDURATION 缺失时用它兜底） */
function maxExtinf(segments) {
    let max = 0;
    for (const s of segments) {
        for (const t of s.tags) {
            // 形如 `#EXTINF:6.560000,`
            const m = t.match(/^#EXTINF:\s*([\d.]+)/);
            if (!m)
                continue;
            const v = Number.parseFloat(m[1]);
            if (Number.isFinite(v) && v > max)
                max = v;
        }
    }
    return max;
}
/** 猜测一个分片是不是广告 */
function looksLikeAd(url) {
    const lower = url.toLowerCase();
    return AD_URL_PATTERNS.some((p) => lower.includes(p));
}
/** 分片 URL 末尾的编号（正片分片编号通常连续递增），没有编号返回 null */
function tailNumber(s) {
    const m = (s.url.split('/').pop() ?? '').match(/(\d+)\.(ts|m4s|mp4)$/i);
    return m ? Number(m[1]) : null;
}
/** 按 DISCONTINUITY / 编号突跳把分片序列切成分组 */
function splitIntoGroups(segments) {
    const groups = [];
    let cur = [];
    let prevNum = null;
    for (const s of segments) {
        const num = tailNumber(s);
        const isDisc = s.tags.some((t) => t.startsWith('#EXT-X-DISCONTINUITY'));
        // 编号突跳（±2 之外）也视为边界——有些源广告结束后不打 DISCONTINUITY 就直接接回正片
        const isJump = prevNum !== null && num !== null && Math.abs(num - prevNum) > 2;
        if ((isDisc || isJump) && cur.length > 0) {
            groups.push(cur);
            cur = [];
        }
        cur.push(s);
        if (num !== null)
            prevNum = num;
    }
    if (cur.length > 0)
        groups.push(cur);
    return groups;
}
/**
 * 剔除广告，返回保留的分片。三重判定，从强到弱：
 *
 * 1. 域名聚类：占少数的 CDN 域名整组剔除
 * 2. 编号连续性（同时覆盖前贴 / 中插 / 片尾广告）：
 *    正片分片编号连续递增，广告组编号突兀跳跃
 *    （实测 ...000073 → 广告 ...0094363 → ...000074）。
 *    以最大的分组为「正片主体」锚点，向两侧只合并编号能接上的组；
 *    接不上的小组（<40%）剔除。前贴片、片尾广告同样接不上，一并覆盖。
 * 3. URL 特征：命中 /ad/ ads. 等已知广告路径的剔除
 *
 * 判不出来就原样放行——宁可放过广告，不可误杀正片。
 */
function filterSegments(segments) {
    if (segments.length < 4)
        return { keep: segments, removed: 0 };
    // 第 1 步：少数派域名剔除
    const hostCount = new Map();
    for (const s of segments) {
        if (s.host)
            hostCount.set(s.host, (hostCount.get(s.host) ?? 0) + 1);
    }
    let mainHost = '';
    let mainHostCount = 0;
    for (const [h, c] of hostCount) {
        if (c > mainHostCount) {
            mainHost = h;
            mainHostCount = c;
        }
    }
    const otherHost = segments.length - mainHostCount;
    let working;
    let removedByHost = 0;
    if (mainHost && otherHost > 0 && otherHost <= segments.length * 0.4) {
        working = segments.filter((s) => s.host === mainHost);
        removedByHost = segments.length - working.length;
    }
    else {
        working = segments;
    }
    const groups = splitIntoGroups(working);
    const total = working.length;
    // 第 2 步：编号连续性，锚定最大的分组（正片主体），向两侧延伸能接上的组
    const kept = [];
    let removedByChain = 0;
    if (groups.length > 0) {
        let anchor = 0;
        for (let i = 1; i < groups.length; i++) {
            if (groups[i].length > groups[anchor].length)
                anchor = i;
        }
        // 从锚点向两侧合并：与「最近的已接受分组」编号能接上（±2）就收下。
        // 无编号的分组判不了，保守保留；大组（>40%）即使断接也当正片。
        const accepted = new Array(groups.length).fill(false);
        accepted[anchor] = true;
        let refStart = tailNumber(groups[anchor][0]);
        for (let i = anchor - 1; i >= 0; i--) {
            const g = groups[i];
            const prevEnd = tailNumber(g[g.length - 1]);
            const unnumbered = prevEnd === null || refStart === null;
            accepted[i] = unnumbered || Math.abs(refStart - prevEnd) <= 2 || g.length > total * 0.4;
            if (accepted[i]) {
                const s = tailNumber(g[0]);
                if (s !== null)
                    refStart = s;
            }
        }
        let refEnd = tailNumber(groups[anchor][groups[anchor].length - 1]);
        for (let i = anchor + 1; i < groups.length; i++) {
            const g = groups[i];
            const nextStart = tailNumber(g[0]);
            const unnumbered = nextStart === null || refEnd === null;
            accepted[i] = unnumbered || Math.abs(nextStart - refEnd) <= 2 || g.length > total * 0.4;
            if (accepted[i]) {
                const e = tailNumber(g[g.length - 1]);
                if (e !== null)
                    refEnd = e;
            }
        }
        for (let i = 0; i < groups.length; i++) {
            if (accepted[i])
                kept.push(...groups[i]);
            else
                removedByChain += groups[i].length;
        }
    }
    // 第 4 步：URL 特征兜底
    const final = kept.filter((s) => !looksLikeAd(s.url));
    const removed = removedByHost + removedByChain + (kept.length - final.length);
    return { keep: final, removed };
}
/**
 * 重建 media playlist。
 *
 * 分片地址有两种模式：
 *   - 直连模式（rewriteSegments = false）：输出「绝对地址」（已由 parsePlaylist 用
 *     resolveUrl 相对 baseUrl 解析过），浏览器直接去上游 CDN 取流，不占服务器带宽。
 *     不能输出上游的相对路径 —— 相对路径会被播放器理解成「播放站自己」的路径，
 *     在 NAS 部署（浏览器与服务器不在同一台机器）时会 404。
 *   - 代理模式（rewriteSegments = true）：分片再包一层 selfBase（/api/proxy?url=），
 *     由本机服务器带 Referer 去取。CDN 校验 Referer / 不开 CORS 时只能这样。
 *
 * 两种模式都保留上游的全局标签（TARGETDURATION / MEDIA-SEQUENCE 等），
 * 标签里的 URI="..."（加密密钥 / 初始化分片）跟随同一种模式。
 */
function rebuildPlaylist(keep, baseUrl, parsed, selfBase, rewriteSegments) {
    const wrap = (u) => (rewriteSegments ? `${selfBase}${encodeURIComponent(u)}` : u);
    const lines = ['#EXTM3U'];
    const find = (k) => parsed.globals.find((g) => g.startsWith(k));
    // VERSION 放最前；上游没写就按 3（HLS 事实标准）
    lines.push(find('#EXT-X-VERSION') ?? '#EXT-X-VERSION:3');
    for (const g of parsed.globals) {
        // 这三个在下面按需补，避免顺序错乱
        if (g.startsWith('#EXT-X-VERSION'))
            continue;
        if (g.startsWith('#EXT-X-TARGETDURATION'))
            continue;
        if (g.startsWith('#EXT-X-PLAYLIST-TYPE'))
            continue;
        lines.push(g);
    }
    // TARGETDURATION 是 media playlist 的必填项，上游缺失时按最长分片补一个
    const td = find('#EXT-X-TARGETDURATION');
    if (td) {
        lines.push(td);
    }
    else {
        const max = maxExtinf(keep);
        if (max > 0)
            lines.push(`#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(max))}`);
    }
    // VOD 列表补一个 PLAYLIST-TYPE；直播/事件列表保持上游原样，不硬加 ENDLIST
    const pt = find('#EXT-X-PLAYLIST-TYPE');
    if (pt)
        lines.push(pt);
    else if (parsed.hasEndlist)
        lines.push('#EXT-X-PLAYLIST-TYPE:VOD');
    for (const s of keep) {
        const tags = s.tags.map((t) => t.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${wrap(resolveUrl(uri, baseUrl))}"`));
        lines.push(...tags);
        lines.push(wrap(s.url));
    }
    if (parsed.hasEndlist)
        lines.push('#EXT-X-ENDLIST');
    return lines.join('\n');
}
/**
 * 清洗 media playlist，返回新文本与剔除数量。
 *
 * @param selfBase        代理前缀（rewriteSegments 为 true 时用），如 `/api/proxy?url=`
 * @param rewriteSegments 分片是否改走本机代理
 */
export function cleanMediaPlaylist(text, baseUrl, selfBase = '', rewriteSegments = false) {
    const parsed = parsePlaylist(text, baseUrl);
    if (parsed.segments.length === 0)
        return { playlist: text, removed: 0 };
    const { keep, removed } = filterSegments(parsed.segments);
    // 即使没有广告要剔除，也要重建一次：把分片相对路径绝对化 / 代理化。
    return { playlist: rebuildPlaylist(keep, baseUrl, parsed, selfBase, rewriteSegments), removed };
}
/**
 * 清洗入口：拿到原始 m3u8 文本后调用。
 *
 * @param selfBase        本机前缀，如 `/api/hls?url=`（直连）或 `/api/proxy?url=`（代理）
 * @param rewriteSegments 分片是否也走 selfBase。false（默认）= 分片直连上游 CDN。
 *                        master 的子列表永远走 selfBase —— 不然子列表里的广告过滤就断了。
 */
export function processPlaylist(text, baseUrl, selfBase, rewriteSegments = false) {
    // 统一成 LF，避免 CRLF 源文件里 `.+` 把 \r 带进替换结果
    const src = text.replace(/\r\n?/g, '\n');
    if (isMasterPlaylist(src)) {
        const wrap = (abs) => `${selfBase}${encodeURIComponent(abs)}`;
        const rewritten = src.replace(/^(?!#)(.+)$/gm, (line) => wrap(resolveUrl(line.trim(), baseUrl)));
        // master 里的 URI 属性（音轨/字幕）也改写
        const withUri = rewritten.replace(/URI="([^"]+)"/g, (_m, uri) => {
            return `URI="${wrap(resolveUrl(uri, baseUrl))}"`;
        });
        return { playlist: withUri, removed: 0 };
    }
    return cleanMediaPlaylist(src, baseUrl, selfBase, rewriteSegments);
}
