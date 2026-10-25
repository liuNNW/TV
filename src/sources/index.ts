/**
 * 多源聚合 + 故障转移。
 *
 * 某个采集站挂掉（比如 api.wujinapi.me 当前就不可达）时自动跳到下一个，
 * 保证只要有一个源活着，站点就能用。
 */

import { CACHE_MAX_PAGES, CACHE_TTL_MS, DATA_DIR, SOURCES } from '../config.js';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LruCache, cached } from '../cache.js';
import { CATEGORY_BLOCK, CONTAINER_NAMES, canonicalName, groupByChannel } from '../channels.js';
import type { ChannelGroup } from '../channels.js';
import type { SourceConfig } from '../config.js';
import * as maccms from './maccms.js';
import type { DetailResult, Item, ItemDetail, ListResult } from './types.js';

/** 列表页缓存（含封面），key = 源:分类:页码 */
const listCache = new LruCache<ListResult>(CACHE_MAX_PAGES, CACHE_TTL_MS);

/** 封面信息缓存，key = 源:covers:ids */
const coverCache = new LruCache<Record<string, maccms.CoverInfo>>(CACHE_MAX_PAGES, CACHE_TTL_MS);

/** 按 id 找源配置 */
export function findSource(id: string | undefined): SourceConfig | undefined {
  if (!id) return undefined;
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

interface SourceState {
  fails: number;
  /** 0 表示没被禁用 */
  disabledUntil: number;
}

const sourceState = new Map<string, SourceState>();

/** 该源当前是否被熔断 */
export function isSourceDisabled(id: string): boolean {
  const s = sourceState.get(id);
  if (!s) return false;
  if (s.disabledUntil > Date.now()) return true;
  if (s.disabledUntil !== 0) {
    // 冷却结束，清零重新计
    s.disabledUntil = 0;
    s.fails = 0;
  }
  return false;
}

function noteOk(id: string): void {
  sourceState.delete(id);
}

function noteFail(id: string): void {
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
function activeSources(): SourceConfig[] {
  const live = SOURCES.filter((s) => !isSourceDisabled(s.id));
  return live.length > 0 ? live : SOURCES;
}

/** 熔断状态快照（诊断用） */
export function sourceHealthSnapshot(): { id: string; disabled: boolean }[] {
  return SOURCES.map((s) => ({ id: s.id, disabled: isSourceDisabled(s.id) }));
}

/** 清空熔断状态（测试与「诊断页重试」用） */
export function resetSourceHealth(): void {
  sourceState.clear();
}

/** 去重：同一部片多个源都有时，按 name+year 合并，保留先返回的 */
function dedupe(items: Item[]): Item[] {
  const seen = new Set<string>();
  const out: Item[] = [];
  for (const it of items) {
    const key = `${it.name}|${it.year ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

/**
 * 搜索所有源，返回合并结果。
 * 每个源单独 try/catch，一个挂了不影响其他。
 */
export async function searchAll(wd: string): Promise<{ items: Item[]; okSources: string[]; failed: string[] }> {
  const targets = activeSources();
  const results = await Promise.allSettled(
    targets.map(async (src) => ({ src, items: await maccms.search(src, wd) })),
  );

  const all: Item[] = [];
  const okSources: string[] = [];
  const failed: string[] = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const src = targets[i]!;
    if (r.status === 'fulfilled') {
      noteOk(src.id);
      okSources.push(src.id);
      all.push(...r.value.items);
    } else {
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
export async function listAny(
  typeId: string | undefined,
  page: number,
  sourceId?: string,
  facets?: Record<string, string>,
): Promise<ListResult & { facetsIgnored?: boolean }> {
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
    let lastErr: unknown;
    for (const src of order) {
      try {
        const r = await listOnce(src, typeId, page, applied, appliedKeys.length > 0);
        noteOk(src.id);
        return r;
      } catch (e) {
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
async function listOnce(
  src: SourceConfig,
  typeId: string | undefined,
  page: number,
  applied: Record<string, string>,
  guarded: boolean,
): Promise<ListResult & { facetsIgnored?: boolean }> {
  const first = await maccms.list(src, typeId, page, applied);
  if (!guarded) return first;

  const baseline = await baselineTotal(src, typeId);
  // 基线拿不到、或是 0，就没法判定，直接认账（宁可少一层保护也别阻塞列表）
  if (baseline === null || baseline <= 0) return first;
  if (first.total !== baseline) return first;

  // 疑似上游把筛选丢了：重试一次
  const second = await maccms.list(src, typeId, page, applied);
  if (second.total !== baseline) return second;
  return { ...second, facetsIgnored: true };
}

/** 无筛选时的总数基线：按 (源, 分类) 缓存 30 分钟 */
const baselineCache = new Map<string, { at: number; total: number | null }>();
const BASELINE_TTL_MS = 30 * 60_000;

async function baselineTotal(src: SourceConfig, typeId: string | undefined): Promise<number | null> {
  const key = `${src.id}:${typeId ?? 'all'}`;
  const hit = baselineCache.get(key);
  if (hit && Date.now() - hit.at < BASELINE_TTL_MS) return hit.total;

  const total = await maccms.countTotal(src, typeId);
  if (baselineCache.size > 500) baselineCache.clear();
  baselineCache.set(key, { at: Date.now(), total });
  return total;
}

/** 清空基线缓存（测试用） */
export function resetBaselineCache(): void {
  baselineCache.clear();
}

/**
 * 详情：优先用指定源；没指定或指定源失败时，依次尝试其他源。
 *
 * 注意 id 是各源自己的 vod_id，换源时 id 不通用，
 * 所以这里只在「指定源」时按 id 精确取；否则需要先按名字搜。
 */
export async function detailAny(
  id: string,
  sourceId?: string,
  expectedName?: string,
): Promise<DetailResult> {
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
    } catch {
      noteFail(preferred.id);
      // 该源失败，走下面的按名回退
    }

    // 该源取不到时，按片名去其他源找同一部片（而不是按 id）
    if (expectedName) {
      for (const src of activeSources()) {
        if (src.id === preferred.id) continue;
        const found = await detailByNameIn(src, expectedName);
        if (found) return { detail: found, source: src.id };
      }
    }

    return { detail: null, source: preferred.id };
  }

  // 没指定源：依次尝试，但必须能用片名校验
  for (const src of activeSources()) {
    try {
      const detail = await maccms.detail(src, id);
      noteOk(src.id);
      if (!detail) continue;
      if (expectedName && detail.name !== expectedName) continue;
      return { detail, source: src.id };
    } catch {
      noteFail(src.id);
      // 下一个
    }
  }

  return { detail: null, source: '' };
}

/** 在指定源里按片名找详情 */
async function detailByNameIn(src: SourceConfig, name: string): Promise<ItemDetail | null> {
  try {
    const items = await maccms.search(src, name);
    if (items.length === 0) return null;
    const exact = items.find((i) => i.name === name) ?? items[0]!;
    const d = await maccms.detail(src, exact.id);
    return d;
  } catch {
    return null;
  }
}

/**
 * 按片名+源找详情。用于「换线路」场景：
 * 同一部片在另一个源里的 vod_id 不同，必须重新搜。
 */
export async function detailByName(
  name: string,
  sourceId: string,
  year?: string,
): Promise<ItemDetail | null> {
  const src = findSource(sourceId);
  if (!src) return null;

  try {
    const items = await maccms.search(src, name);
    if (items.length === 0) return null;

    // 名字精确匹配优先，其次年份匹配，最后取第一条
    const exact = items.filter((i) => i.name === name);
    const pool = exact.length > 0 ? exact : items;
    const withYear = year ? pool.filter((i) => i.year === year) : [];
    const picked = (withYear.length > 0 ? withYear : pool)[0]!;

    const d = await maccms.detail(src, picked.id);
    if (d && d.lines.length > 0) return d;

    // 换源后没线路，把基础信息返回（前端至少能显示）
    return d;
  } catch {
    return null;
  }
}

/** 所有源存活状态（含熔断标记，死源不必反复探） */
export async function healthAll() {
  const results = await Promise.allSettled(SOURCES.map((s) => maccms.health(s)));
  return results.map((r, i) => {
    const src = SOURCES[i]!;
    const base =
      r.status === 'fulfilled'
        ? r.value
        : { id: src.id, name: src.name, ok: false, ms: 0, error: '探测异常' };
    if (base.ok) noteOk(src.id);
    else noteFail(src.id);
    return { ...base, disabled: isSourceDisabled(src.id) };
  });
}

/* ---------------- 分类探测（带缓存） ---------------- */

export type { CategoryInfo } from './maccms.js';

/**
 * 分类缓存结构版本。
 * 2 = 改为读源的 `class` 树（含 parent / total 可空）。
 * 旧版本缓存里的分类没有层级、还可能漏掉 id>40 的分类，直接作废重采（分类是廉价数据）。
 */
const CATEGORY_CACHE_VERSION = 2;

interface CategoryCache {
  version?: number;
  at: number;
  bySource: Record<string, maccms.CategoryInfo[]>;
  /** 有源这次没采到（超时/报错）→ 缩短 TTL，尽快重试，别让它缺席 6 小时 */
  partial?: boolean;
}

/**
 * 收集分类：每源 1 次 `ac=list` 读 `class` 树，秒级完成（旧实现要打 320 次请求 / 57 秒）。
 */
const CATEGORY_TTL = 6 * 60 * 60 * 1000; // 6 小时
let categoryCache: CategoryCache | null = null;
let categoryInflight: Promise<CategoryCache> | null = null;

/**
 * 磁盘持久化：内存缓存重启就没了，落盘后 NAS 重启服务也能秒开首页。
 * 写失败（只读盘等）不影响功能。
 */
const CATEGORY_DISK_FILE = join(DATA_DIR, 'categories-cache.json');

async function loadDiskCategories(): Promise<CategoryCache | null> {
  try {
    const text = await readFile(CATEGORY_DISK_FILE, 'utf8');
    const obj = JSON.parse(text) as CategoryCache;
    if (obj && typeof obj.at === 'number' && obj.bySource && !Array.isArray(obj.bySource)) {
      // 版本不符直接丢（升级后旧分类没有层级，还漏 id>40 的）
      if (obj.version !== CATEGORY_CACHE_VERSION) return null;
      return obj;
    }
  } catch {
    // 没有缓存文件就正常采集
  }
  return null;
}

async function saveDiskCategories(c: CategoryCache): Promise<void> {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    const tmp = `${CATEGORY_DISK_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify(c), 'utf8');
    try {
      await rename(tmp, CATEGORY_DISK_FILE);
    } catch {
      // Windows 上目标带只读属性时 rename 会 EPERM：去掉只读位重试
      try {
        await chmod(CATEGORY_DISK_FILE, 0o666);
        await rename(tmp, CATEGORY_DISK_FILE);
      } catch {
        try { await unlink(CATEGORY_DISK_FILE); } catch { /* 本来就不存在 */ }
        await rename(tmp, CATEGORY_DISK_FILE);
      }
    }
  } catch {
    // 落盘失败只影响下次冷启动速度
  }
}

/**
 * 取各源的分类。
 *
 * 每源 1 次 `ac=list` 读 `class` 树，8 个源并行 ≈ 秒级（旧实现逐个探测要 320 次请求 / 57 秒）。
 * 有源超时会让整批变慢（最坏等它 6s 超时），所以：
 *   - 失败源不进缓存；
 *   - 整批标记 `partial`，TTL 从 6 小时降到 5 分钟，很快会重试补齐。
 */
export async function getCategories(force = false): Promise<CategoryCache> {
  // 缺源的缓存 30 分钟后重试（别 5 分钟一刷 —— 慢源每次都卡满超时，反而更慢）
  const ttlOf = (c: CategoryCache) => (c.partial ? 30 * 60_000 : CATEGORY_TTL);

  if (!force && categoryCache && Date.now() - categoryCache.at < ttlOf(categoryCache)) {
    return categoryCache;
  }
  if (categoryInflight) return categoryInflight;

  // 内存没有 → 先看磁盘（同样受 TTL 约束），命中就不用采集了
  if (!force && !categoryCache) {
    const disk = await loadDiskCategories();
    if (disk && Date.now() - disk.at < ttlOf(disk)) {
      categoryCache = disk;
      return categoryCache;
    }
  }

  categoryInflight = (async () => {
    // 沿用已有结果做底：这次没采到的源保留上一次的数据，不要把整批覆盖成「只有成功的那些」
    const bySource: Record<string, maccms.CategoryInfo[]> = { ...(categoryCache?.bySource ?? {}) };

    const targets = activeSources();
    // 非强制刷新时只补「还没有分类」的源，已经采到的不用再打扰上游
    const pending = force ? targets : targets.filter((s) => !bySource[s.id]);
    const queue = pending.length > 0 ? pending : targets;

    // 全部并行：每个源只发 1 个请求，串行反而把慢源的超时叠加到总时长上
    // （实测分 3 批要 10~16s，并行只要 5s 左右）。
    // 慢源超时后不写缓存，下次只补它一个，几秒就能补上。
    const settled = await Promise.allSettled(
      queue.map(async (src) => ({ id: src.id, cats: await maccms.discoverCategories(src) })),
    );
    for (let k = 0; k < settled.length; k++) {
      const r = settled[k]!;
      if (r.status === 'fulfilled') {
        noteOk(r.value.id);
        bySource[r.value.id] = r.value.cats;
      } else {
        noteFail(queue[k]!.id);
      }
    }

    categoryCache = {
      version: CATEGORY_CACHE_VERSION,
      at: Date.now(),
      bySource,
      // 还有源缺（历史上也没采到过）才算 partial
      partial: targets.some((s) => !bySource[s.id]),
    };
    categoryInflight = null;
    void saveDiskCategories(categoryCache);
    return categoryCache;
  })();

  return categoryInflight;
}

/**
 * 归并后的分类清单：把各源**同义**分类合并成一条，
 * 前端选中后按 source + id 精确请求。
 *
 * 这里做三件事（顺序不能颠倒）：
 *   1. 屏蔽非影视分类（演员/新闻资讯/未分类…）
 *   2. 同义名归一（日剧 + 日本剧 → 日本剧）—— 不做的话「电视剧」频道会平铺 15 个分类，光港剧占 4 个
 *   3. 标出容器分类（电影片/连续剧 这种父节点），展示时跳过
 */
export interface MergedCategory {
  name: string;
  /** 该分类在各源里的 id（同名归并后可能有多个源，取第一个用） */
  refs: { source: string; sourceName: string; id: string; total: number }[];
  total: number;
  parent: string | null;
  container: boolean;
}

export async function mergedCategories(force = false): Promise<MergedCategory[]> {
  const cache = await getCategories(force);

  // 先收集「谁被当成父节点用过」→ 这些分类自己是容器，不该出现在分类行
  const parentNames = new Set<string>();
  for (const src of SOURCES) {
    for (const c of cache.bySource[src.id] ?? []) {
      if (c.parent) parentNames.add(canonicalName(c.parent));
    }
  }

  const byName = new Map<string, MergedCategory>();

  for (const src of SOURCES) {
    const cats = cache.bySource[src.id];
    if (!cats) continue;
    for (const c of cats) {
      const name = canonicalName(c.name);
      if (!name || CATEGORY_BLOCK.has(name)) continue;

      let entry = byName.get(name);
      if (!entry) {
        entry = {
          name,
          refs: [],
          total: 0,
          parent: c.parent ? canonicalName(c.parent) : null,
          // 两道判据：被谁当过父节点（有 type_pid 的源），或本身就是伞形名（没 pid 的源）
          container: parentNames.has(name) || CONTAINER_NAMES.has(name),
        };
        byName.set(name, entry);
      }
      // 同一个源里可能有两条归一到同一名（如 sdzy 的 港剧/台剧）→ 只留第一条，
      // 否则「分类名 → 源 id」会出现一个源两个 id 的歧义
      if (entry.refs.some((r) => r.source === src.id)) continue;

      entry.refs.push({
        source: src.id,
        sourceName: src.name,
        id: c.id,
        total: c.total ?? 0,
      });
      entry.total += c.total ?? 0;
    }
  }

  return [...byName.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
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
export async function coversByIds(
  ids: string[],
  sourceId?: string,
): Promise<Record<string, maccms.CoverInfo>> {
  const src = findSource(sourceId) ?? SOURCES[0];
  if (!src || ids.length === 0) return {};

  const cacheKey = `${src.id}:covers:${ids.join(',')}`;

  const hit = coverCache.get(cacheKey);
  if (hit !== undefined && Object.keys(hit).length > 0) return hit;

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
 *
 * 注意：默认**不按条数过滤**（条数现在默认不采集，见 maccms.discoverCategories）。
 * 僵尸分类/容器分类已经在 mergedCategories 里按「结构 + 屏蔽名单」处理掉了。
 */
export async function channelGroups(force = false): Promise<ChannelGroup<MergedCategory>[]> {
  const cats = await mergedCategories(force);
  return groupByChannel(cats, 0);
}

/**
 * 给分类补条数（只有 `?counts=1` 才调）。
 *
 * 代价明确：每个源的每个分类一次 `ac=list&t=`，8 源 × 约 16 分类 ≈ 128 次请求。
 * 所以默认不采集，只在用户显式要求时跑，结果写回缓存（TTL 6h）。
 */
export async function enrichCategoryCounts(): Promise<void> {
  const cache = await getCategories();
  const results = await Promise.allSettled(
    SOURCES.map(async (src) => {
      const cats = cache.bySource[src.id];
      if (!cats || cats.length === 0) return;
      const counts = await maccms.fetchCategoryCounts(
        src,
        cats.map((c) => c.id),
      );
      for (const c of cats) {
        const n = counts.get(c.id);
        if (n !== undefined) c.total = n;
      }
    }),
  );
  // 有任何一个源成功就算部分成功，落盘免得下次重来
  if (results.some((r) => r.status === 'fulfilled')) {
    cache.version = CATEGORY_CACHE_VERSION;
    cache.at = Date.now();
    void saveDiskCategories(cache);
  }
}
