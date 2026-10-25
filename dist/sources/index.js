/**
 * 多源聚合 + 故障转移。
 *
 * 某个采集站挂掉（比如 api.wujinapi.me 当前就不可达）时自动跳到下一个，
 * 保证只要有一个源活着，站点就能用。
 */
import { CACHE_MAX_PAGES, CACHE_TTL_MS, DATA_DIR, MIN_CATEGORY_TOTAL, SOURCES } from '../config.js';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LruCache, cached } from '../cache.js';
import { groupByChannel } from '../channels.js';
import * as maccms from './maccms.js';
/** 列表页缓存（含封面），key = 源:分类:页码 */
const listCache = new LruCache(CACHE_MAX_PAGES, CACHE_TTL_MS);
/** 封面信息缓存，key = 源:covers:ids */
const coverCache = new LruCache(CACHE_MAX_PAGES, CACHE_TTL_MS);
/** 按 id 找源配置 */
export function findSource(id) {
    if (!id)
        return undefined;
    return SOURCES.find((s) => s.id === id);
}
/* ---------------- 源健康熔断 ---------------- */
/**
 * 连续失败就把这个源临时踢出队列。
 *
 * 背景：采集站挂掉是常态（2026-10-25 实测 11 个配置源里 3 个超时）。
 * 死源一直留在 `SOURCES` 里，每次列表/搜索/探测都要白等一轮超时，
 * 用户看到的是「整个站都慢」，而不是「少了一个源」。
 *
 * 策略刻意保守：连续 3 次失败才禁用，10 分钟后自动恢复，重启即清空。
 * 宁可多试一次，也不要因为一次抖动就把一个好源封掉。
 */
const FAIL_THRESHOLD = 3;
const DISABLE_MS = 10 * 60_000;
const sourceState = new Map();
/** 该源当前是否被熔断 */
export function isSourceDisabled(id) {
    const s = sourceState.get(id);
    if (!s)
        return false;
    if (s.disabledUntil > Date.now())
        return true;
    if (s.disabledUntil !== 0) {
        // 冷却结束，清零重新计
        s.disabledUntil = 0;
        s.fails = 0;
    }
    return false;
}
function noteOk(id) {
    sourceState.delete(id);
}
function noteFail(id) {
    const s = sourceState.get(id) ?? { fails: 0, disabledUntil: 0 };
    s.fails += 1;
    if (s.fails >= FAIL_THRESHOLD) {
        s.disabledUntil = Date.now() + DISABLE_MS;
        s.fails = 0;
    }
    sourceState.set(id, s);
}
/**
 * 当前参与轮询的源。
 * 全都被熔断时退回全部 —— 宁可慢，也不要整站返回空。
 */
function activeSources() {
    const live = SOURCES.filter((s) => !isSourceDisabled(s.id));
    return live.length > 0 ? live : SOURCES;
}
/** 熔断状态快照（诊断用） */
export function sourceHealthSnapshot() {
    return SOURCES.map((s) => ({ id: s.id, disabled: isSourceDisabled(s.id) }));
}
/** 清空熔断状态（测试与「诊断页重试」用） */
export function resetSourceHealth() {
    sourceState.clear();
}
/** 去重：同一部片多个源都有时，按 name+year 合并，保留先返回的 */
function dedupe(items) {
    const seen = new Set();
    const out = [];
    for (const it of items) {
        const key = `${it.name}|${it.year ?? ''}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(it);
    }
    return out;
}
/**
 * 搜索所有源，返回合并结果。
 * 每个源单独 try/catch，一个挂了不影响其他。
 */
export async function searchAll(wd) {
    const targets = activeSources();
    const results = await Promise.allSettled(targets.map(async (src) => ({ src, items: await maccms.search(src, wd) })));
    const all = [];
    const okSources = [];
    const failed = [];
    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const src = targets[i];
        if (r.status === 'fulfilled') {
            noteOk(src.id);
            okSources.push(src.id);
            all.push(...r.value.items);
        }
        else {
            noteFail(src.id);
            failed.push(src.id);
        }
    }
    return { items: dedupe(all), okSources, failed };
}
/**
 * 列表：默认用第一个可用的源（列表类请求没必要合并多源，会重复且慢）。
 * 指定 source 时只用那个源，因为分类 id 各源不通用。
 *
 * 结果按「源:分类:页码:筛选」缓存 30 分钟。
 * 取封面要走两步上游请求，剧集分类第二步实测 4 秒，不缓存翻页会很难受。
 * 缓存键必须带上筛选维度，否则「筛过的列表」会串到「没筛的请求」上。
 */
export async function listAny(typeId, page, sourceId, facets) {
    const preferred = findSource(sourceId);
    // 明确指定源时即使它被熔断也照试（用户是点着这个源来的，别替他决定）
    const order = preferred ? [preferred] : activeSources();
    const applied = facets ?? {};
    const appliedKeys = Object.keys(applied).filter((k) => applied[k]);
    const facetKey = appliedKeys.length
        ? appliedKeys
            .sort()
            .map((k) => `${k}=${applied[k]}`)
            .join('&')
        : '-';
    const cacheKey = `${sourceId ?? 'auto'}:${typeId ?? 'all'}:${page}:${facetKey}`;
    return cached(listCache, cacheKey, async () => {
        let lastErr;
        for (const src of order) {
            try {
                const r = await listOnce(src, typeId, page, applied, appliedKeys.length > 0);
                noteOk(src.id);
                return r;
            }
            catch (e) {
                noteFail(src.id);
                lastErr = e;
            }
        }
        throw lastErr instanceof Error ? lastErr : new Error('所有片源均不可用');
    });
}
/**
 * 带筛选时多一层「一致性守卫」。
 *
 * 实测上游会偶发忽略筛选参数、直接返回全量（`area=美国` 本该 1454，
 * 有一次返回了 4978）。判据：带筛选的 total == 不带筛选的基线 total。
 * 命中就重试一次；仍相同则标记 facetsIgnored，让前端提示「该源不支持此筛选」，
 * 而不是把全量结果伪装成筛选结果。
 */
async function listOnce(src, typeId, page, applied, guarded) {
    const first = await maccms.list(src, typeId, page, applied);
    if (!guarded)
        return first;
    const baseline = await baselineTotal(src, typeId);
    // 基线拿不到、或是 0，就没法判定，直接认账（宁可少一层保护也别阻塞列表）
    if (baseline === null || baseline <= 0)
        return first;
    if (first.total !== baseline)
        return first;
    // 疑似上游把筛选丢了：重试一次
    const second = await maccms.list(src, typeId, page, applied);
    if (second.total !== baseline)
        return second;
    return { ...second, facetsIgnored: true };
}
/** 无筛选时的总数基线：按 (源, 分类) 缓存 30 分钟 */
const baselineCache = new Map();
const BASELINE_TTL_MS = 30 * 60_000;
async function baselineTotal(src, typeId) {
    const key = `${src.id}:${typeId ?? 'all'}`;
    const hit = baselineCache.get(key);
    if (hit && Date.now() - hit.at < BASELINE_TTL_MS)
        return hit.total;
    const total = await maccms.countTotal(src, typeId);
    if (baselineCache.size > 500)
        baselineCache.clear();
    baselineCache.set(key, { at: Date.now(), total });
    return total;
}
/** 清空基线缓存（测试用） */
export function resetBaselineCache() {
    baselineCache.clear();
}
/**
 * 详情：优先用指定源；没指定或指定源失败时，依次尝试其他源。
 *
 * 注意 id 是各源自己的 vod_id，换源时 id 不通用，
 * 所以这里只在「指定源」时按 id 精确取；否则需要先按名字搜。
 */
export async function detailAny(id, sourceId, expectedName) {
    const preferred = findSource(sourceId);
    // 指定了源就只用这个源。
    //
    // 不能跨源按 id 兜底：vod_id 是各源自己的编号，同一个 id
    // 在 A 站可能是《兰香如故》，在 B 站可能是另一部片。
    // 跨源取会静默返回错片子，比取不到更糟。
    if (preferred) {
        try {
            const detail = await maccms.detail(preferred, id);
            noteOk(preferred.id);
            if (detail) {
                // 带上了片名就校验一下，防止 id 对不上导致张冠李戴
                if (expectedName && detail.name !== expectedName) {
                    return { detail: null, source: preferred.id };
                }
                return { detail, source: preferred.id };
            }
        }
        catch {
            noteFail(preferred.id);
            // 该源失败，走下面的按名回退
        }
        // 该源取不到时，按片名去其他源找同一部片（而不是按 id）
        if (expectedName) {
            for (const src of activeSources()) {
                if (src.id === preferred.id)
                    continue;
                const found = await detailByNameIn(src, expectedName);
                if (found)
                    return { detail: found, source: src.id };
            }
        }
        return { detail: null, source: preferred.id };
    }
    // 没指定源：依次尝试，但必须能用片名校验
    for (const src of activeSources()) {
        try {
            const detail = await maccms.detail(src, id);
            noteOk(src.id);
            if (!detail)
                continue;
            if (expectedName && detail.name !== expectedName)
                continue;
            return { detail, source: src.id };
        }
        catch {
            noteFail(src.id);
            // 下一个
        }
    }
    return { detail: null, source: '' };
}
/** 在指定源里按片名找详情 */
async function detailByNameIn(src, name) {
    try {
        const items = await maccms.search(src, name);
        if (items.length === 0)
            return null;
        const exact = items.find((i) => i.name === name) ?? items[0];
        const d = await maccms.detail(src, exact.id);
        return d;
    }
    catch {
        return null;
    }
}
/**
 * 按片名+源找详情。用于「换线路」场景：
 * 同一部片在另一个源里的 vod_id 不同，必须重新搜。
 */
export async function detailByName(name, sourceId, year) {
    const src = findSource(sourceId);
    if (!src)
        return null;
    try {
        const items = await maccms.search(src, name);
        if (items.length === 0)
            return null;
        // 名字精确匹配优先，其次年份匹配，最后取第一条
        const exact = items.filter((i) => i.name === name);
        const pool = exact.length > 0 ? exact : items;
        const withYear = year ? pool.filter((i) => i.year === year) : [];
        const picked = (withYear.length > 0 ? withYear : pool)[0];
        const d = await maccms.detail(src, picked.id);
        if (d && d.lines.length > 0)
            return d;
        // 换源后没线路，把基础信息返回（前端至少能显示）
        return d;
    }
    catch {
        return null;
    }
}
/** 所有源存活状态（含熔断标记，死源不必反复探） */
export async function healthAll() {
    const results = await Promise.allSettled(SOURCES.map((s) => maccms.health(s)));
    return results.map((r, i) => {
        const src = SOURCES[i];
        const base = r.status === 'fulfilled'
            ? r.value
            : { id: src.id, name: src.name, ok: false, ms: 0, error: '探测异常' };
        if (base.ok)
            noteOk(src.id);
        else
            noteFail(src.id);
        return { ...base, disabled: isSourceDisabled(src.id) };
    });
}
/** 分类探测要打 40 个请求，缓存起来，避免每次开首页都探测 */
const CATEGORY_TTL = 6 * 60 * 60 * 1000; // 6 小时
let categoryCache = null;
let categoryInflight = null;
/**
 * 磁盘持久化：内存缓存重启就没了，11 个源冷启动探测要几十秒，
 * 落盘后 NAS 重启服务也能秒开首页。写失败（只读盘等）不影响功能。
 */
const CATEGORY_DISK_FILE = join(DATA_DIR, 'categories-cache.json');
async function loadDiskCategories() {
    try {
        const text = await readFile(CATEGORY_DISK_FILE, 'utf8');
        const obj = JSON.parse(text);
        if (obj && typeof obj.at === 'number' && obj.bySource && !Array.isArray(obj.bySource)) {
            return obj;
        }
    }
    catch {
        // 没有缓存文件就正常探测
    }
    return null;
}
async function saveDiskCategories(c) {
    try {
        await mkdir(DATA_DIR, { recursive: true });
        const tmp = `${CATEGORY_DISK_FILE}.tmp`;
        await writeFile(tmp, JSON.stringify(c), 'utf8');
        try {
            await rename(tmp, CATEGORY_DISK_FILE);
        }
        catch {
            // Windows 上目标带只读属性时 rename 会 EPERM：去掉只读位重试
            try {
                await chmod(CATEGORY_DISK_FILE, 0o666);
                await rename(tmp, CATEGORY_DISK_FILE);
            }
            catch {
                try {
                    await unlink(CATEGORY_DISK_FILE);
                }
                catch { /* 本来就不存在 */ }
                await rename(tmp, CATEGORY_DISK_FILE);
            }
        }
    }
    catch {
        // 落盘失败只影响下次冷启动速度
    }
}
/**
 * 取各源的分类。
 *
 * 各源分类 id 不通用，所以按源分别探测，并在上层做归并
 * （同名分类只保留一个 id，前端用「源:分类」的方式区分）。
 */
export async function getCategories(force = false) {
    if (!force && categoryCache && Date.now() - categoryCache.at < CATEGORY_TTL) {
        return categoryCache;
    }
    if (categoryInflight)
        return categoryInflight;
    // 内存没有 → 先看磁盘（同样受 TTL 约束），命中就不用探测了
    if (!force && !categoryCache) {
        const disk = await loadDiskCategories();
        if (disk && Date.now() - disk.at < CATEGORY_TTL) {
            categoryCache = disk;
            return categoryCache;
        }
    }
    categoryInflight = (async () => {
        const bySource = {};
        const targets = activeSources();
        const results = await Promise.allSettled(targets.map(async (src) => ({ id: src.id, cats: await maccms.discoverCategories(src) })));
        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            if (r.status === 'fulfilled') {
                noteOk(r.value.id);
                bySource[r.value.id] = r.value.cats;
            }
            else {
                noteFail(targets[i].id);
            }
        }
        categoryCache = { at: Date.now(), bySource };
        categoryInflight = null;
        void saveDiskCategories(categoryCache);
        return categoryCache;
    })();
    return categoryInflight;
}
export async function mergedCategories(force = false) {
    const cache = await getCategories(force);
    const byName = new Map();
    for (const src of SOURCES) {
        const cats = cache.bySource[src.id];
        if (!cats)
            continue;
        for (const c of cats) {
            let entry = byName.get(c.name);
            if (!entry) {
                entry = { name: c.name, refs: [], total: 0 };
                byName.set(c.name, entry);
            }
            entry.refs.push({ source: src.id, sourceName: src.name, id: c.id, total: c.total });
            entry.total += c.total;
        }
    }
    return [...byName.values()].sort((a, b) => b.total - a.total);
}
/**
 * 批量取封面信息（渐进式加载用）。
 *
 * 列表接口不阻塞在封面上，前端拿到列表后单独请求这个接口补齐，
 * 这样即使采集站这一步抖动（实测 4~8s+），页面也已经先出来了。
 *
 * 注意：**空结果不写入缓存**。
 * 上游超时/失败时返回空对象，如果缓存了，接下来 30 分钟都会是空，
 * 用户会一直看不到封面。宁可下次重新请求。
 */
export async function coversByIds(ids, sourceId) {
    const src = findSource(sourceId) ?? SOURCES[0];
    if (!src || ids.length === 0)
        return {};
    const cacheKey = `${src.id}:covers:${ids.join(',')}`;
    const hit = coverCache.get(cacheKey);
    if (hit !== undefined && Object.keys(hit).length > 0)
        return hit;
    const map = await maccms.fetchCovers(src, ids);
    const result = Object.fromEntries(map);
    // 只有拿到东西才缓存
    if (Object.keys(result).length > 0) {
        coverCache.set(cacheKey, result);
    }
    return result;
}
/**
 * 按频道分组的分类清单，供前端顶栏 + 分类行使用。
 *
 * 这一层是为了解决「首页把 31 个分类全平铺」的问题：
 * 前端只需要「当前频道下的几个分类」，而不是全部。
 */
export async function channelGroups(force = false) {
    const cats = await mergedCategories(force);
    return groupByChannel(cats, MIN_CATEGORY_TOTAL);
}
