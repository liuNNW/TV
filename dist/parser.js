/**
 * macCMS 播放字段解析器。
 *
 * 采集站的两个字段格式：
 *   vod_play_from = "liangzi$$$lzm3u8"                  多线路用 $$$ 分隔
 *   vod_play_url  = "第01集$url1#第02集$url2$$$第01集$url3"
 *                    集与集用 # 分隔
 *                    集名与 URL 用 $ 分隔
 *                    线路与线路用 $$$ 分隔
 *
 * 这里全部写成纯函数，方便单测覆盖各种畸形输入。
 */
/** 线路分隔符 */
const LINE_SEP = '$$$';
/** 集分隔符 */
const EP_SEP = '#';
/** 集名与地址分隔符 */
const NAME_SEP = '$';
/**
 * 解析 vod_play_from → 线路名数组。
 * 空串、纯空白、null 都返回空数组。
 */
export function parsePlayFrom(from) {
    if (!from)
        return [];
    return from
        .split(LINE_SEP)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}
/**
 * 解析单条线路的 vod_play_url 分段 → 集列表。
 *
 * 关键点：集名与 URL 之间只按**第一个** $ 切分，
 * 这样 URL 里若含有 $ 也不会被切坏。
 */
export function parseEpisodeSegment(segment) {
    if (!segment)
        return [];
    const episodes = [];
    for (const raw of segment.split(EP_SEP)) {
        const piece = raw.trim();
        if (!piece)
            continue;
        if (piece.includes(NAME_SEP)) {
            // 只切第一个 $，保留 URL 中可能出现的 $
            const idx = piece.indexOf(NAME_SEP);
            const name = piece.slice(0, idx).trim();
            const url = piece.slice(idx + 1).trim();
            if (!url)
                continue;
            episodes.push({ name: name || `第${episodes.length + 1}集`, url });
        }
        else {
            // 没有集名，整段当作 URL
            episodes.push({ name: `第${episodes.length + 1}集`, url: piece });
        }
    }
    return episodes;
}
/**
 * 把 vod_play_from + vod_play_url 组装成完整线路列表。
 *
 * 两个字段的分段数可能对不上（采集站常见问题），
 * 这里按较短的一方对齐，多出来的线路补默认名「线路N」。
 */
export function buildPlayLines(from, url) {
    const names = parsePlayFrom(from);
    if (!url)
        return [];
    const segments = url.split(LINE_SEP);
    // 以 segments 为准，因为分段里才有真正的播放地址
    const count = segments.length;
    if (count === 0)
        return [];
    const lines = [];
    for (let i = 0; i < count; i++) {
        const episodes = parseEpisodeSegment(segments[i] ?? '');
        // 空线路直接丢弃，避免前端出现点了没反应的 Tab
        if (episodes.length === 0)
            continue;
        const name = names[i]?.trim() || `线路${lines.length + 1}`;
        // 有任意一集是可直接播放的 m3u8，就认为这条线路可用
        const playable = episodes.some((e) => looksLikeHls(e.url));
        // 不是 m3u8，但看着像「分享页 / 播放页」——页面里有真地址，服务端解析一次就能放。
        // 以前这类线路被直接判死（界面一堆 ⚠），实测《嫁金钗》5 条全都能解析出真 m3u8。
        const needsResolve = !playable && episodes.some((e) => isSharePage(e.url));
        lines.push(needsResolve ? { name, episodes, playable, needsResolve: true } : { name, episodes, playable });
    }
    return lines;
}
/**
 * 挑出第一条可播放的线路下标。
 * 全部不可播放时返回 0（让前端仍能展示，只是会提示）。
 */
export function firstPlayableLineIndex(lines) {
    const i = lines.findIndex((l) => l.playable);
    return i >= 0 ? i : 0;
}
/**
 * 判断地址是否像 HLS 播放列表。
 * 采集站的 vod_play_url 绝大多数是 m3u8 直链，
 * 少数是网页地址（需要再解析），这里做一次粗筛。
 */
export function looksLikeHls(url) {
    if (!url)
        return false;
    const lower = url.toLowerCase();
    if (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('/')) {
        return lower.includes('.m3u8');
    }
    return false;
}
/**
 * 是不是「分享页 / 播放页」——地址本身不是 m3u8，但页面里有真地址。
 *
 * 采集站大量线路给的是这种网页（`…/share/<hash>`、`…/play/<id>`），
 * 直接判「不可播」会让整个界面挂满 ⚠。实测《嫁金钗》5 条这样的线路
 * 全部能在页面里找到 `index.m3u8?sign=…`，拉下来的分片是标准 TS。
 */
export function isSharePage(url) {
    if (!url)
        return false;
    const lower = url.toLowerCase();
    if (!(lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('/')))
        return false;
    if (lower.includes('.m3u8'))
        return false;
    return /\/share\/|\/play\//.test(lower);
}
/** 从可能带 query 的地址里取文件名，用于展示 */
export function shortLabel(url, max = 60) {
    try {
        const u = new URL(url);
        const p = u.pathname;
        return p.length > max ? '…' + p.slice(-max) : p;
    }
    catch {
        return url.length > max ? url.slice(0, max) + '…' : url;
    }
}
