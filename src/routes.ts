/**
 * API 路由。
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { PORT, TYPE_MAP } from './config.js';
import { checkUrl, proxyFetch } from './proxy.js';
import { processPlaylist } from './adfilter.js';
import { getMarker, setMarker } from './store.js';
import { listLocal, localRoot, safePath, scanLibrary, serveLocalFile } from './localmedia.js';
import { checkMedia, coverFile, ffmpegCapabilities, ffmpegPath, ffprobePath, hasFfmpeg, pickHardwareEncoder, probeMedia, resetFfmpegCache } from './covers.js';
import { planPlayback } from './playplan.js';
import { ensureReaper, brokenEncoders, resetTranscode, startTranscode, transcodeActive, transcodeDiskUsage, transcodeFile, transcodeProgress, transcodeStatus } from './transcode.js';
import { addLocalDir, findLocalDir, listLocalDirs, removeLocalDir } from './localdirs.js';
import {
  CDN_BASE,
  DEFAULT_LINE,
  checkLine,
  fetchCdnPlaylist,
  fetchDirectPlaylist,
  fetchSegment,
  fetchSegmentUrl,
  fetchSuper,
  hoistPlayableVariants,
  listLines,
  looksLikePlaceholder,
  pickFastestLine,
  resolveMain,
  rewriteDyrsPlaylist,
} from './dyrs.js';
import { channelGroups, coversByIds, detailAggregated, detailAny, detailByName, enrichCategoryCounts, healthAll, listAny, mergedCategories, searchAll } from './sources/index.js';
import { buildMacFacets, MAC_FACET_GROUPS } from './facets.js';
import {
  bindRepo,
  checkUpdate,
  jobStatus,
  publicConfig,
  readConfig,
  readState,
  runUpdate,
  runtimeInfo,
  saveConfig,
  scheduleRestart,
} from './updater.js';
import {
  addFavorite,
  clearHistory,
  getHistory,
  isFavorite,
  listFavorites,
  listHistory,
  removeFavorite,
  saveHistory,
} from './store.js';

export const router = Router();

/** 统一错误包装，别把内部堆栈漏给前端 */
function fail(res: Response, status: number, message: string): void {
  res.status(status).json({ ok: false, error: message });
}

/**
 * 上游返回非 200 时的文案。
 *
 * 429 单独说清楚：dyrs 上游（wzzycc 模板）的 429 不是限流，而是
 * 「正在检测」反爬挑战页的 HTTP 状态码。挑战已在 dyrssite 里自动解过并重放，
 * 走到这里说明重试完仍没过 —— 给用户一句看得懂的提示，别只甩个状态码。
 */
function upstreamMsg(status: number): string {
  return status === 429
    ? '上游反爬校验未通过（HTTP 429），已自动重试仍失败，请稍后再试'
    : `上游返回 HTTP ${status}`;
}

/** 取查询参数里的字符串 */
function q(req: Request, key: string): string {
  const v = req.query[key];
  return typeof v === 'string' ? v : '';
}

/* ---------------- 元数据 ---------------- */

router.get('/health', async (_req, res) => {
  try {
    const sources = await healthAll();
    res.json({ ok: true, sources, ready: sources.some((s) => s.ok) });
  } catch (e) {
    fail(res, 500, e instanceof Error ? e.message : '健康检查失败');
  }
});

router.get('/search', async (req, res) => {
  const wd = q(req, 'wd').trim();
  if (!wd) return fail(res, 400, '缺少搜索关键词 wd');
  try {
    const { items, okSources, failed } = await searchAll(wd);
    res.json({ ok: true, items, okSources, failed, total: items.length });
  } catch (e) {
    fail(res, 502, e instanceof Error ? e.message : '搜索失败');
  }
});

/**
 * 分类列表（主库）。
 *
 * 除分类（type_id）外，支持**服务端**地区 / 年份 / 语言筛选：
 * 实测 macCMS 的 `ac=list` 认 `area` / `year` / `lang`，传了就是真过滤（含分页）。
 * 取值先经 src/facets.ts 归一（`中国大陆` 必须写成 `大陆` 才生效）。
 */
router.get('/list', async (req, res) => {
  const typeId = q(req, 'type') || undefined;
  const sourceId = q(req, 'source') || undefined;
  const page = Math.max(1, Number(q(req, 'page')) || 1);

  const applied = buildMacFacets({
    area: q(req, 'area'),
    year: q(req, 'year'),
    lang: q(req, 'lang'),
  });

  try {
    const result = await listAny(typeId, page, sourceId, applied);
    res.json({ ok: true, ...result, applied, typeMap: TYPE_MAP });
  } catch (e) {
    fail(res, 502, e instanceof Error ? e.message : '获取列表失败');
  }
});

/**
 * 主库可用的筛选维度（地区 / 年份 / 语言）。
 *
 * 词表在 `src/facets.ts` 里维护，前端直接按这个渲染，避免前后端各写一份。
 * 注意：不同采集站支持程度不同（实测 hongniu 完全不认 area/year），
 * 不支持的源会在 `/api/list` 里回 `facetsIgnored: true`，由前端提示。
 */
router.get('/facets', (_req, res) => {
  res.json({ ok: true, groups: MAC_FACET_GROUPS });
});

/**
 * 分类清单。
 * 各源分类 id 完全不通用，所以这里探测后返回「分类名 → 各源 id」的映射。
 * force=1 可强制重新探测。
 */
router.get('/categories', async (req, res) => {
  try {
    const cats = await mergedCategories(q(req, 'force') === '1');
    res.json({ ok: true, categories: cats });
  } catch (e) {
    fail(res, 502, e instanceof Error ? e.message : '获取分类失败');
  }
});

/**
 * 按频道分组的分类。
 * 前端顶栏与分类行用这个，避免把全部分类一次平铺出来。
 *
 * `?counts=1` 会额外去补每个分类的条数（8 源 × 约 16 分类 ≈ 128 次上游请求），
 * 默认不补 —— 不补时首屏 <1s，补了要十几秒。
 */
router.get('/channels', async (req, res) => {
  try {
    const force = q(req, 'force') === '1';
    if (q(req, 'counts') === '1') await enrichCategoryCounts();
    const channels = await channelGroups(force);
    res.json({ ok: true, channels });
  } catch (e) {
    fail(res, 502, e instanceof Error ? e.message : '获取频道失败');
  }
});

/**
 * 批量取封面（渐进式加载）。
 * 列表接口只返回名字，前端渲染出骨架后再调这个补图和年份。
 * ids 用逗号分隔，例如 /api/covers?ids=123,456&source=lziapi
 */
router.get('/covers', async (req, res) => {
  const raw = q(req, 'ids');
  if (!raw) return fail(res, 400, '缺少 ids 参数');

  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 100); // 一次最多 100 个，防止滥用

  if (ids.length === 0) return fail(res, 400, 'ids 为空');

  try {
    const covers = await coversByIds(ids, q(req, 'source') || undefined);
    res.json({ ok: true, covers });
  } catch (e) {
    fail(res, 502, e instanceof Error ? e.message : '取封面失败');
  }
});

router.get('/detail', async (req, res) => {
  const id = q(req, 'id').trim();
  if (!id) return fail(res, 400, '缺少片目 id');

  const source = q(req, 'source') || undefined;
  // 带上片名用于校验，防止跨源 id 撞车返回错片子
  const expectedName = q(req, 'name').trim() || undefined;
  // 跨源聚合线路：默认开（搜索去重后只剩一张卡，不聚合就只有 1 个源的 1~2 条线路）
  const merge = q(req, 'merge') !== '0';
  const force = q(req, 'force') === '1';

  try {
    const agg = await detailAggregated(id, source, expectedName, { merge, force });
    if (!agg.detail) return fail(res, 404, '未找到该片目');
    res.json({
      ok: true,
      detail: agg.detail,
      source: agg.source,
      mergedFrom: agg.mergedFrom,
      mergedCount: agg.mergedCount,
      skipped: agg.skipped,
    });
  } catch (e) {
    fail(res, 502, e instanceof Error ? e.message : '获取详情失败');
  }
});

/** 换源：按片名去另一个源找同一部片（各源 vod_id 不通用） */
router.get('/detail-by-name', async (req, res) => {
  const name = q(req, 'name').trim();
  const source = q(req, 'source').trim();
  const year = q(req, 'year').trim() || undefined;
  if (!name || !source) return fail(res, 400, '缺少 name 或 source');

  try {
    const detail = await detailByName(name, source, year);
    if (!detail) return fail(res, 404, '该片源下未找到此片');
    res.json({ ok: true, detail, source });
  } catch (e) {
    fail(res, 502, e instanceof Error ? e.message : '换源失败');
  }
});

/* ---------------- 媒体代理（兜底） ---------------- */

/** 响应体是不是 m3u8 文本（有些源把播放列表标成 text/plain） */
function isPlaylistBody(body: Buffer): boolean {
  return body.length >= 7 && body.subarray(0, 7).toString('utf8') === '#EXTM3U';
}

/**
 * 代理兜底。
 *
 * 直连取流失败（CDN 校验 Referer / 不开 CORS）时播放器会回落到这里。
 * 这里复用与 /api/hls 同一套 processPlaylist，只是分片也包一层代理
 * （rewriteSegments = true）—— 早期版本走 rewriteM3u8 直接转发，绕过了广告过滤，
 * 结果「直连失败回落代理」之后剧中的广告就全回来了。
 */
router.get('/proxy', async (req, res) => {
  const target = q(req, 'url');
  if (!target) return fail(res, 400, '缺少 url 参数');

  // 先原样拉取，重写交给 adfilter，好顺手做广告剔除
  const result = await proxyFetch(target, {
    referer: q(req, 'ref') || undefined,
    rewritePlaylist: false,
  });

  let body = result.body;
  let contentType = result.contentType;
  let removed = 0;

  const looksLikeM3u8 =
    /mpegurl|m3u/i.test(contentType) ||
    /\.m3u8(\?|$)/i.test(target) ||
    isPlaylistBody(result.body);

  if (looksLikeM3u8 && result.status === 200) {
    // selfBase 用相对路径！NAS 部署时服务器和浏览器不在同一台机器，
    // 写死 127.0.0.1 会让局域网设备的浏览器把分片请求发给自己，播放必挂。
    const r = processPlaylist(
      result.body.toString('utf8'),
      result.finalUrl || target,
      '/api/proxy?url=',
      true,
    );
    body = Buffer.from(r.playlist, 'utf8');
    contentType = 'application/vnd.apple.mpegurl';
    removed = r.removed;
  }

  res.status(result.status);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-store');
  // 允许本地页面跨端口访问（其实同源，但保险）
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (removed > 0) {
    res.setHeader('X-Ads-Removed', String(removed));
    console.log(`[adfilter·proxy] ${target.slice(0, 80)}… 剔除 ${removed} 个广告分片`);
  }
  res.send(body);
});

/**
 * 广告过滤播放列表。
 * 拉取片源 m3u8 → 剔除广告分片（异域名/广告特征）→ 重写后交给播放器。
 * 正片分片保持直连 CDN 原地址；失败时播放器会自动回落 /api/proxy。
 */
router.get('/hls', async (req, res) => {
  const target = q(req, 'url');
  if (!target) return fail(res, 400, '缺少 url 参数');

  const deny = await checkUrl(target);
  if (deny) return fail(res, 403, deny);

  // 用 proxyFetch 拿原始文本（不做重写）， referer 伪造同 proxy
  const result = await proxyFetch(target, {
    referer: q(req, 'ref') || undefined,
    rewritePlaylist: false,
  });
  if (result.status !== 200) {
    return fail(res, result.status, '拉取播放列表失败');
  }

  const text = result.body.toString('utf8');
  const selfBase = `/api/hls?url=`;
  const { playlist, removed } = processPlaylist(text, result.finalUrl || target, selfBase);

  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (removed > 0) {
    res.setHeader('X-Ads-Removed', String(removed));
    console.log(`[adfilter] ${target.slice(0, 80)}… 剔除 ${removed} 个广告分片`);
  }
  res.send(playlist);
});

/* ---------------- 片头片尾标记 ---------------- */

router.get('/markers', async (req, res) => {
  const name = q(req, 'name').trim();
  if (!name) return fail(res, 400, '缺少 name');
  res.json({ ok: true, marker: await getMarker(name) });
});

router.post('/markers', async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const name = String(b.name ?? '').trim();
  if (!name) return fail(res, 400, '缺少 name');
  const patch: { intro?: number; outro?: number } = {};
  if (b.intro !== undefined) patch.intro = Number(b.intro) || 0;
  if (b.outro !== undefined) patch.outro = Number(b.outro) || 0;
  const marker = await setMarker(name, patch);
  res.json({ ok: true, marker });
});

/* ---------------- 本地媒体 ---------------- */

/**
 * 解析请求要浏览哪个根目录。
 * - 不传 root 或 root=auto → 自动探测到的目录（videos 文件夹 / LOCAL_MEDIA_DIR）
 * - root=<自定义目录 id> → 网页里添加的目录
 */
async function resolveLocalRoot(req: Request): Promise<string | null> {
  const root = q(req, 'root').trim();
  if (!root || root === 'auto') return localRoot();
  const dir = await findLocalDir(root);
  return dir ? dir.path : null;
}

router.get('/local', async (req, res) => {
  const root = await resolveLocalRoot(req);
  if (!root) {
    const hasCustom = (await listLocalDirs()).length > 0;
    if (q(req, 'root').trim() && hasCustom) return fail(res, 404, '这个目录不存在或已被移除');
    return fail(
      res,
      404,
      '还没有视频目录：把视频拷进播放站目录下的 videos 文件夹，或在下面添加自定义路径',
    );
  }
  const result = await listLocal(root, q(req, 'path'));
  if (!result) return fail(res, 403, '路径非法或目录不存在');
  res.json({ ok: true, ...result });
});

/**
 * 媒体库：递归扫描整棵目录树，一次返回所有视频/音频。
 * 供前端「媒体库海报墙」使用，带扫描上限防止扫爆超大目录。
 */
router.get('/local/library', async (req, res) => {
  const root = await resolveLocalRoot(req);
  if (!root) {
    const hasCustom = (await listLocalDirs()).length > 0;
    if (q(req, 'root').trim() && hasCustom) return fail(res, 404, '这个目录不存在或已被移除');
    return fail(
      res,
      404,
      '还没有视频目录：把视频拷进播放站目录下的 videos 文件夹，或在下面添加自定义路径',
    );
  }
  const result = await scanLibrary(root, q(req, 'path'));
  if (!result) return fail(res, 403, '路径非法或目录不存在');
  const ff = await hasFfmpeg();
  res.json({
    ok: true,
    ...result,
    total: result.entries.length,
    ffmpeg: ff,
    ffmpegPath: ff ? await ffmpegPath() : null,
    hardwareEncoder: ff ? ((await pickHardwareEncoder()) || 'libx264') : null,
  });
});

/**
 * 视频封面：用 ffmpeg 抽一帧（MKV / HEVC / RMVB 这些浏览器解不了的格式也能出图）。
 * 结果落盘缓存（data/covers），所以同一部片只会抽一次。
 * 找不到 ffmpeg / 抽帧失败 → 404，前端自动回退到浏览器抓帧。
 */
router.get('/local/cover', async (req, res) => {
  const root = await resolveLocalRoot(req);
  if (!root) return fail(res, 404, '未找到视频目录');
  const full = safePath(root, q(req, 'path'));
  if (!full) return fail(res, 400, '路径非法');

  let mtimeMs: number;
  try {
    const st = await stat(full);
    if (!st.isFile()) return fail(res, 404, '不是文件');
    mtimeMs = st.mtimeMs;
  } catch {
    return fail(res, 404, '文件不存在');
  }

  const cover = await coverFile(full, mtimeMs, q(req, 'force') === '1');
  if (!cover) return fail(res, 404, '无法生成封面');

  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=604800');
  res.setHeader('X-Cover-Source', 'ffmpeg');
  createReadStream(cover).pipe(res);
});

/**
 * 文件体检：让 ffmpeg 真解码前 15 秒，判断是「文件损坏」还是「浏览器不支持」。
 */
router.get('/local/check', async (req, res) => {
  const root = await resolveLocalRoot(req);
  if (!root) return fail(res, 404, '未找到视频目录');
  const full = safePath(root, q(req, 'path'));
  if (!full) return fail(res, 400, '路径非法');
  try {
    const st = await stat(full);
    if (!st.isFile()) return fail(res, 404, '不是文件');
  } catch {
    return fail(res, 404, '文件不存在');
  }
  const r = await checkMedia(full);
  if (!r) return fail(res, 404, 'NAS 上没有 ffmpeg，做不了体检（SSH 执行 sudo apt install -y ffmpeg）');
  res.json({ ok: true, ...r });
});

/**
 * 读取视频的编码信息（H.265 / HEVC / AC3 之类），播放失败时给用户看真实原因。
 */
router.get('/local/info', async (req, res) => {
  const root = await resolveLocalRoot(req);
  if (!root) return fail(res, 404, '未找到视频目录');
  const full = safePath(root, q(req, 'path'));
  if (!full) return fail(res, 400, '路径非法');
  try {
    const st = await stat(full);
    if (!st.isFile()) return fail(res, 404, '不是文件');
  } catch {
    return fail(res, 404, '文件不存在');
  }
  const info = await probeMedia(full);
  if (!info) return fail(res, 404, '读不到编码信息：NAS 上可能没有 ffprobe，或这个文件的文件头已损坏');
  res.json({ ok: true, ...info });
});

/**
 * 播放方案：先探编码，再决定「浏览器直接播」还是「NAS 转码」。
 * 抢先判断，不让用户对着黑屏干等一个注定失败的播放。
 */
router.get('/local/playplan', async (req, res) => {
  const root = await resolveLocalRoot(req);
  if (!root) return fail(res, 404, '未找到视频目录');
  const full = safePath(root, q(req, 'path'));
  if (!full) return fail(res, 400, '路径非法');
  try {
    const st = await stat(full);
    if (!st.isFile()) return fail(res, 404, '不是文件');
  } catch {
    return fail(res, 404, '文件不存在');
  }
  const plan = await planPlayback(full);
  const ffmpeg = await hasFfmpeg();
  res.json({ ok: true, ...plan, ffmpeg });
});

/**
 * 诊断：ffmpeg 到底在哪、有没有硬件编码器。
 * 「为什么飞牛影视能播、这个站播不了」的答案基本都在这一页里。
 */
router.get('/local/diag', async (req, res) => {
  if (q(req, 'rescan') === '1') resetFfmpegCache();
  const ffmpeg = await ffmpegPath();
  const caps = await ffmpegCapabilities();
  const encoder = await pickHardwareEncoder();
  res.json({
    ok: true,
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    ffmpeg,
    ffmpegFound: !!ffmpeg,
    ffprobe: await ffprobePath(),
    version: caps.version,
    hwEncoders: caps.encoders.filter((e) => /^(h264|hevc)_(qsv|nvenc|vaapi|v4l2m2m|videotoolbox|amf)$/.test(e)),
    brokenEncoders: brokenEncoders(),
    pickedEncoder: encoder || 'libx264（CPU 软编）',
    activeTranscodes: transcodeActive(),
    transcodeDiskMB: Math.round(transcodeDiskUsage() / 1048576),
    path: String(process.env.PATH || '').slice(0, 240),
  });
});

/**
 * 实时转码播放：把浏览器解不了的文件（H.265 等）用 NAS 的 ffmpeg 转成 H.264 HLS。
 * 前端拿到 url 后用 hls.js 播。同时最多 2 路转码，空闲 10 分钟自动清理。
 */
router.get('/local/transcode/start', async (req, res) => {
  const root = await resolveLocalRoot(req);
  if (!root) return fail(res, 404, '未找到视频目录');
  const full = safePath(root, q(req, 'path'));
  if (!full) return fail(res, 400, '路径非法');
  let mtimeMs: number;
  try {
    const st = await stat(full);
    if (!st.isFile()) return fail(res, 404, '不是文件');
    mtimeMs = st.mtimeMs;
  } catch {
    return fail(res, 404, '文件不存在');
  }
  const h = Math.min(Math.max(Number(q(req, 'h')) || 720, 360), 1080);
  const r = q(req, 'force') === '1'
    ? await resetTranscode(full, mtimeMs, h)
    : await startTranscode(full, mtimeMs, h);
  if ('error' in r) return fail(res, 500, r.error);
  res.json({ ok: true, url: r.url, key: r.key, encoder: r.encoder });
});

/** 转码进度：已转出多少秒（前端轮询展示，让用户知道 NAS 在干活） */
router.get('/local/transcode/status', async (req, res) => {
  const p = transcodeProgress(String(q(req, 'key') ?? ''));
  res.json({ ok: true, ...p });
});

/** 转码产物：index.m3u8 与分片 ts */
router.get('/local/transcode/:key/:file', async (req, res) => {
  ensureReaper();
  const key = String(req.params.key ?? '');
  const name = String(req.params.file ?? '');
  const full = transcodeFile(key, name);
  if (!full) {
    // 播放列表还没生成（转码刚起步）：让 hls.js 稍后重试而不是直接报错
    if (name === 'index.m3u8' && transcodeStatus(key) === 'running') {
      res.status(503);
      res.setHeader('Retry-After', '2');
      return res.json({ ok: false, error: '转码启动中，请稍候' });
    }
    return fail(res, 404, '转码文件不存在或已回收');
  }

  // 分片要按 HTTP 缓存规矩来：hls.js 会重试拉同一段，
  // 没有缓存头就会一次次重读磁盘（机械盘上就是明显的卡顿来源）。
  // m3u8 必须 no-store（转码中它会不断增长），ts 分片一旦写出就不再变，可以长缓存 + ETag。
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(full);
    if (!st.isFile()) return fail(res, 404, '转码文件不存在或已回收');
  } catch {
    return fail(res, 404, '转码文件不存在或已回收');
  }

  const etag = `"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`;
  if (name.endsWith('.m3u8')) {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-store');
  } else {
    res.setHeader('Content-Type', 'video/mp2t');
    // 分片写完后内容不再变化，可长缓存；用 ETag 让重复请求走 304
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
  }
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Length', st.size);

  // 关键：给分片流加高水位缓冲 + 预读，避免边转码边读取时出现「读到一半空转」。
  // Express 底层是 socket，highWaterMark 拉大能让内核一次多读一些，
  // 机械盘/网络盘上对卡顿改善很明显。
  const stream = createReadStream(full, { highWaterMark: 1 << 20 }); // 1MB
  let aborted = false;
  res.on('close', () => { aborted = true; stream.destroy(); });
  stream.on('error', () => { if (!aborted) res.destroy(); });
  stream.pipe(res);
});

router.get('/local/dirs', async (_req, res) => {
  try {
    res.json({ ok: true, dirs: await listLocalDirs(), auto: localRoot() });
  } catch (e) {
    fail(res, 500, e instanceof Error ? e.message : '读取目录列表失败');
  }
});

router.post('/local/dirs', async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const path = String(b.path ?? '').trim();
  const name = String(b.name ?? '').trim();
  if (!path) return fail(res, 400, '请填写目录路径');
  try {
    const { dir, dirs } = await addLocalDir(path, name);
    res.json({ ok: true, dir, dirs });
  } catch (e) {
    fail(res, 400, e instanceof Error ? e.message : '添加失败');
  }
});

router.delete('/local/dirs', async (req, res) => {
  const id = q(req, 'id').trim();
  if (!id) return fail(res, 400, '缺少 id');
  try {
    res.json({ ok: true, dirs: await removeLocalDir(id) });
  } catch (e) {
    fail(res, 500, e instanceof Error ? e.message : '删除失败');
  }
});

router.get('/local/file', async (req, res) => {
  const root = await resolveLocalRoot(req);
  if (!root) return fail(res, 404, '未找到视频目录');
  const ok = await serveLocalFile(
    root,
    q(req, 'path'),
    req.headers.range as string | undefined,
    {
      setHeader: (k, v) => res.setHeader(k, v),
      status: (n) => res.status(n),
    },
    (stream) => {
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    },
  );
  if (!ok) return fail(res, 403, '路径非法或文件不存在');
});

/* ---------------- 一键更新 ---------------- */

/**
 * 更新接口的可选防护：设置了环境变量 UPDATE_TOKEN 后，
 * 所有 /api/update/* 必须带 ?token= 或请求头 x-update-token。
 * 个人局域网用可以不设；暴露到公网务必设。
 */
function updateGuard(req: Request, res: Response): boolean {
  const token = process.env.UPDATE_TOKEN;
  if (!token) return true;
  const given = q(req, 'token') || String(req.headers['x-update-token'] ?? '');
  if (given === token) return true;
  fail(res, 403, '更新令牌不正确（设置过 UPDATE_TOKEN 环境变量）');
  return false;
}

router.get('/update/config', async (req, res) => {
  if (!updateGuard(req, res)) return;
  const [cfg, state] = await Promise.all([readConfig(), readState()]);
  res.json({ ok: true, config: publicConfig(cfg), state, runtime: runtimeInfo(), job: jobStatus() });
});

router.post('/update/config', async (req, res) => {
  if (!updateGuard(req, res)) return;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const repoUrl = String(b.repoUrl ?? '').trim();
  const branch = String(b.branch ?? '').trim() || 'main';
  // 不传 token 表示保留原值，传空字符串表示清除
  const token = 'token' in b ? String(b.token ?? '') : undefined;
  try {
    await saveConfig(repoUrl, branch, token);
    res.json({ ok: true, config: publicConfig(await readConfig()) });
  } catch (e) {
    fail(res, 400, e instanceof Error ? e.message : '保存失败');
  }
});

/** 首次绑定：git init + remote + fetch + reset --hard（会覆盖被跟踪的代码文件） */
router.post('/update/init', async (req, res) => {
  if (!updateGuard(req, res)) return;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const token = 'token' in b ? String(b.token ?? '') : undefined;
  try {
    await bindRepo(String(b.repoUrl ?? ''), String(b.branch ?? ''), token);
    res.json({ ok: true, job: jobStatus() });
  } catch (e) {
    fail(res, 400, e instanceof Error ? e.message : '绑定失败');
  }
});

/** 检查更新：落后多少个提交 */
router.post('/update/check', async (req, res) => {
  if (!updateGuard(req, res)) return;
  try {
    res.json({ ok: true, ...(await checkUpdate()) });
  } catch (e) {
    fail(res, 400, e instanceof Error ? e.message : '检查更新失败');
  }
});

/** 一键更新：拉取 → 覆盖 → 装依赖 → 自动重启（异步执行，用 /api/update/status 看进度） */
router.post('/update/run', async (req, res) => {
  if (!updateGuard(req, res)) return;
  // 异步跑：更新过程可能几分钟，不能让 HTTP 请求一直挂着
  runUpdate()
    .then(() => scheduleRestart())
    .catch(() => undefined);
  res.json({ ok: true, job: jobStatus() });
});

/** 更新进度（前端每秒轮询） */
router.get('/update/status', async (req, res) => {
  if (!updateGuard(req, res)) return;
  res.json({ ok: true, job: jobStatus(), runtime: runtimeInfo() });
});

/* ---------------- dyrs 体系接口复刻（wzzycc 模板） ---------------- */

/**
 * 线路发现：和原站一样，一次给出全部镜像域名。
 * 原站返回 { urls:[...], least:"...", sion_id:"" }，这里保持一致。
 */
router.get('/videox/least', async (req, res) => {
  try {
    const urls = await listLines(q(req, 'refresh') === '1');
    res.json({ urls, least: urls[0] ?? '', sion_id: '' });
  } catch (e) {
    fail(res, 502, e instanceof Error ? e.message : '线路获取失败');
  }
});

/** 线路探活：GET /api/dyrs/ip?line=https://tvcang.com */
router.get('/dyrs/ip', async (req, res) => {
  const line = q(req, 'line');
  if (!line) return fail(res, 400, '缺少 line 参数');
  const h = await checkLine(line);
  if (!h.ok && h.error) return fail(res, 502, h.error);
  res.json({
    user: true,
    flush: false,
    ok: true,
    expire_time: 86400,
    ip_id: '',
    Client: {},
    AllOkTime: {},
    ip: h.ip ?? '',
    ms: h.ms,
  });
});

/** 批量探活，挑最快的线路（原站前端就是干这个） */
router.get('/dyrs/fastest', async (req, res) => {
  try {
    const best = await pickFastestLine(undefined, Math.min(Math.max(Number(q(req, 'n')) || 8, 1), 20));
    const urls = await listLines();
    res.json({ ok: true, urls, best: best?.line ?? '', ip: best?.ip ?? '', ms: best?.ms ?? 0 });
  } catch (e) {
    fail(res, 502, e instanceof Error ? e.message : '探活失败');
  }
});

/**
 * 主接口复刻：GET /api/dyrs/m3u8?origin=线路名&url=视频id
 *
 * 原站行为：302 到 CDN 的 /api/super。这里默认也 302（方便别人按原站规范对接）；
 * 加 &proxy=1 则本站自己抓回来再吐（避免暴露上游 CDN、也能过 Referer 校验）。
 */
router.get('/dyrs/m3u8', async (req, res) => {
  const id = q(req, 'url') || q(req, 'id');
  const origin = q(req, 'origin');
  if (!id) return fail(res, 400, '缺少 url（视频 id）参数');

  const line = q(req, 'line') || (await listLines())[0] || DEFAULT_LINE;
  try {
    const r = await resolveMain(line, id, origin);

    if (r.kind === 'redirect' && q(req, 'proxy') !== '1') {
      if (!r.location) return fail(res, 502, '上游未返回跳转地址');
      res.setHeader('Cache-Control', 'no-store');
      res.redirect(302, r.location);
      return;
    }

    // proxy=1：把 CDN 主列表抓回来重写后返回，播放器只跟本站打交道
    const superRes =
      r.kind === 'content'
        ? r.result
        : await fetchSuper(id, origin, origin ? `${line}/` : `${line}/`);

    if (superRes.status !== 200) {
      return fail(res, superRes.status, `上游返回 HTTP ${superRes.status}`);
    }
    const text = superRes.body.toString('utf8');
    // 把「真能拿到分片」的清晰度排到最前（CDN 的 /api/ts 会返回占位图）
    const rewritten = hoistPlayableVariants(rewriteDyrsPlaylist(text, CDN_BASE));
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    res.send(rewritten);
  } catch (e) {
    fail(res, 502, e instanceof Error ? e.message : '上游请求失败');
  }
});

/** CDN 主列表：GET /api/dyrs/super?id=&origin= */
router.get('/dyrs/super', async (req, res) => {
  const id = q(req, 'id');
  const origin = q(req, 'origin');
  if (!id) return fail(res, 400, '缺少 id 参数');
  const referer = q(req, 'line') ? `${q(req, 'line')}/` : `${(await listLines())[0] || DEFAULT_LINE}/`;
  try {
    const r = await fetchSuper(id, origin, referer);
    if (r.status !== 200) return fail(res, r.status, `上游返回 HTTP ${r.status}`);
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    res.send(hoistPlayableVariants(rewriteDyrsPlaylist(r.body.toString('utf8'), CDN_BASE)));
  } catch (e) {
    fail(res, 502, e instanceof Error ? e.message : '上游请求失败');
  }
});

/**
 * 直链型播放列表：GET /api/dyrs/direct?id=&origin=
 *
 * 上游 /api/direct 会 302 到真实 TS 主机（如 vip1.wzzym3u8.cc），返回的 media 列表里
 * 分片是相对名（000.html）。这里跟随跳转拿到列表，按**最终地址**把相对名补成绝对地址，
 * 再包一层 /api/dyrs/seg —— 整条链路同源，无 CORS/Referer 问题。
 *
 * 这是目前唯一稳定能播出分片的路径：CDN 的 /api/ts 对未登录请求会返回微信二维码占位图。
 */
router.get('/dyrs/direct', async (req, res) => {
  const id = q(req, 'id');
  const origin = q(req, 'origin');
  if (!id) return fail(res, 400, '缺少 id 参数');
  const referer = `${(await listLines())[0] || DEFAULT_LINE}/`;
  try {
    const r = await fetchDirectPlaylist(id, origin || undefined, referer);
    if (r.status !== 200) return fail(res, r.status, `上游返回 HTTP ${r.status}`);
    if (!isPlaylistBody(r.body)) return fail(res, 502, '上游返回的不是播放列表');
    // base 用最终地址（含目录），才能把 000.html 解析到正确位置
    const rewritten = rewriteDyrsPlaylist(r.body.toString('utf8'), r.finalUrl);
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    res.send(rewritten);
  } catch (e) {
    fail(res, 502, e instanceof Error ? e.message : '上游请求失败');
  }
});

/** CDN 二级列表：GET /api/dyrs/cdn/m3u8?id=&raw= */
router.get('/dyrs/cdn/m3u8', async (req, res) => {
  const id = q(req, 'id');
  if (!id) return fail(res, 400, '缺少 id 参数');
  const raw = q(req, 'raw') === '1';
  const referer = `${(await listLines())[0] || DEFAULT_LINE}/`;
  try {
    const r = await fetchCdnPlaylist(id, raw, referer);
    if (r.status !== 200) return fail(res, r.status, `上游返回 HTTP ${r.status}`);
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    res.send(rewriteDyrsPlaylist(r.body.toString('utf8'), CDN_BASE));
  } catch (e) {
    fail(res, 502, e instanceof Error ? e.message : '上游请求失败');
  }
});

/** CDN 分片代理：GET /api/dyrs/cdn/ts?m3u8_id=&index=&uuid= */
router.get('/dyrs/cdn/ts', async (req, res) => {
  const id = q(req, 'm3u8_id') || q(req, 'id');
  const index = q(req, 'index');
  const uuid = q(req, 'uuid');
  if (!id || index === '') return fail(res, 400, '缺少 m3u8_id / index 参数');
  const referer = `${(await listLines())[0] || DEFAULT_LINE}/`;
  try {
    const r = await fetchSegment(id, Number(index) || 0, uuid, referer);
    if (r.status !== 200) return fail(res, r.status, `上游返回 HTTP ${r.status}`);
    // uuid 与列表不配对时上游会静默返回 PNG 占位图，识别出来给个明确的错
    if (looksLikePlaceholder(r.body)) {
      return fail(res, 502, '上游返回的不是视频分片（uuid 可能已失效，请重新获取播放列表）');
    }
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Access-Control-Allow-Origin', '*');
    // 分片内容不变，可长缓存
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(r.body);
  } catch (e) {
    fail(res, 502, e instanceof Error ? e.message : '分片获取失败');
  }
});

/**
 * 通用分片透传：GET /api/dyrs/seg?u=<绝对地址>
 *
 * 二级列表里指向真实 TS CDN（如 v.lzcdn28.com）的那些直链走这里。
 * 必须做 SSRF 校验：只允许 http/https，拒绝内网地址。
 */
router.get('/dyrs/seg', async (req, res) => {
  const target = q(req, 'u');
  if (!target) return fail(res, 400, '缺少 u 参数');
  const deny = await checkUrl(target);
  if (deny) return fail(res, 403, deny);
  try {
    const r = await fetchSegmentUrl(target);
    if (r.status !== 200) return fail(res, r.status, `上游返回 HTTP ${r.status}`);
    // 上游把分片标成 text/html（文件名就是 000.html，内容是 TS），不能透传 content-type，
    // 否则 hls.js 会因类型不对拒绝喂给 MSE
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(r.body);
  } catch (e) {
    fail(res, 502, e instanceof Error ? e.message : '分片获取失败');
  }
});

/* ---------------- dyrs 站点数据（新 UI 用，抓镜像站 HTML 解析） ---------------- */

import {
  buildSiteListPath,
  fetchDriveList,
  fetchSearchPage,
  fetchSiteImage,
  fetchSitePage,
  findPreset,
  isSiteChannel,
  isValidLineFilter,
  parseBanner,
  parseCards,
  parseDetail,
  parseFilters,
  parseMaxPage,
  parsePlayPage,
  pickLine,
  probePlaylistUrl,
  resetSitePageCache,
  SITE_CHANNELS,
  SITE_PRESETS,
  toPlaySrc,
} from './dyrssite.js';

/** 上游真实频道（与 dyrssite.ts 的 SITE_CHANNELS 同源，避免两处各写一份） */
const DYRS_CHANNELS = SITE_CHANNELS;
const DYRS_KINDS = ['movie', 'tv', 'zongyi', 'duanju'] as const;
const DYRS_CHANNEL_NAMES: Record<string, string> = {
  dianying: '电影',
  dianshiju: '电视剧',
  zongyi: '综艺',
  dongman: '动漫',
  duanju: '短剧',
};

/** 前端频道条：5 个真实频道 + 3 个预设筛选入口 */
function channelBar(): { key: string; name: string; preset: boolean }[] {
  return [
    ...DYRS_CHANNELS.map((c) => ({ key: c as string, name: DYRS_CHANNEL_NAMES[c] ?? c, preset: false })),
    ...SITE_PRESETS.map((p) => ({ key: p.key, name: p.name, preset: true })),
  ];
}

/* ---------------- 影视仓：线路 → 选集（一次抓够） ---------------- */

interface DyrsEpisode {
  /** 播放页的 ?p= 序号（0 基），也是 /api/dyrs/src 要的 p */
  p: number;
  title: string;
  origin: string;
  /** 本站取流地址（详情时就算好，播放器直接用，省一次跳转） */
  src: string;
}

interface DyrsOriginRow {
  origin: string;
  count: number;
  /**
   * direct = 上游直接给真实 m3u8（v.lzcdn27.com / ffzy-plays / jisuzyv…）→ 走 /api/proxy
   * dyrs   = 上游给的是 /api/m3u8?origin=&url=（超级线路 / 王者TV加速 / wztv）
   *          → 必须靠 CDN 那条 raw=1 清晰度才拿得到真分片
   */
  kind: 'direct' | 'dyrs';
  episodes: DyrsEpisode[];
}

/** 小并发 map：一次朝镜像站甩十几个请求容易被反爬拦下 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/**
 * 取一条线路的完整选集。
 *
 * 上游是按 `?origin=` 服务端渲染选集的，所以必须逐条线路抓。好消息是**一次就够**：
 * 播放页里的 `xg_video_player_doc` 除了当前集，还带 next[]（后续全部剧集），
 * 抓 p=0 就能拿到这条线路的完整片单 —— 实测 10 条线路全部吻合 tab 上的集数。
 * 长剧若 next 被截断，再按已拿到的集数往后补抓（最多 3 轮）。
 *
 * @param want tab 上标注的集数（0 表示未知），只用来判断要不要补抓
 */
async function loadDyrsOrigin(
  kind: string,
  id: string,
  seq: string,
  origin: string,
  base: string,
  want = 0,
): Promise<DyrsOriginRow | null> {
  const fetchAt = async (p: number) => {
    const r = await fetchSitePage(`/${kind}/${id}/${seq}.html?origin=${encodeURIComponent(origin)}&p=${p}`);
    if (r.status !== 200) return null;
    return parsePlayPage(r.html);
  };

  try {
    const first = await fetchAt(0);
    if (!first) return null;

    // 上游 url 有两种形态：绝对 m3u8（真实 CDN）和 /api/m3u8?origin=&url=（dyrs 自家 CDN）
    const isDirect = /^https?:/i.test(String(first.url || '')) && String(first.url).includes('.m3u8');

    const raw: { title: string; url: string }[] = [{ title: first.title, url: first.url }];
    for (const n of first.next || []) raw.push({ title: n.title, url: n.url });

    for (let round = 0; round < 3 && want > 0 && raw.length < want; round++) {
      const more = await fetchAt(raw.length);
      if (!more) break;
      const add = [{ title: more.title, url: more.url }, ...(more.next || []).map((n) => ({ title: n.title, url: n.url }))];
      // 第一次补抓时第一条就是已拿过的下一集，正常；若完全没新增就停，防止死循环
      if (add.length <= 1 && !add[0]?.url) break;
      raw.push(...add);
      if (add.length <= 1) break;
    }

    const episodes: DyrsEpisode[] = [];
    raw.forEach((e, i) => {
      const src = toPlaySrc(e.url, origin, base);
      if (!src) return;
      episodes.push({ p: i, title: e.title || `第 ${i + 1} 集`, origin, src });
    });
    if (episodes.length === 0) return null;

    return { origin, count: episodes.length, kind: isDirect ? 'direct' : 'dyrs', episodes };
  } catch {
    return null;
  }
}

/** 影视仓详情缓存：一部片 10 分钟内不重复打上游（逐条线路抓选集是十几次请求） */
const dyrsDetailCache = new Map<string, { at: number; data: unknown }>();
const DYRS_DETAIL_TTL_MS = 10 * 60_000;

/** 首页：banner + 各频道推荐条 + 频道条（供前端数据驱动渲染） */
router.get('/dyrs/site/home', async (_req, res) => {
  try {
    const home = await fetchSitePage('/');
    if (home.status !== 200) return fail(res, home.status, upstreamMsg(home.status));
    const banner = parseBanner(home.html);

    // 各频道取第一页前 12 部（fetchSitePage 自带缓存，之后不再打上游）
    const strips = await Promise.all([
      ...DYRS_CHANNELS.map(async (ch) => {
        try {
          const r = await fetchSitePage(`/${ch}.html`);
          return { channel: ch, name: DYRS_CHANNEL_NAMES[ch], cards: parseCards(r.html).slice(0, 12) };
        } catch {
          return { channel: ch, name: DYRS_CHANNEL_NAMES[ch], cards: [] };
        }
      }),
      // 预设入口也出一条推荐条：它们就是「白捡的内容面」，藏起来太浪费
      ...SITE_PRESETS.map(async (p) => {
        try {
          const r = await fetchSitePage(buildSiteListPath({ ch: p.ch, ...p.params }));
          return { channel: p.key, name: p.name, cards: parseCards(r.html).slice(0, 12) };
        } catch {
          return { channel: p.key, name: p.name, cards: [] };
        }
      }),
    ]);
    // 抓不到内容的条目不展示，避免首页出现一整排空行
    res.json({ ok: true, banner, channels: channelBar(), strips: strips.filter((s) => s.cards.length > 0) });
  } catch (e) {
    fail(res, 502, e instanceof Error ? e.message : '上游请求失败');
  }
});

/**
 * 分类列表：`/dianying.html` 等 + 全套筛选参数。
 *
 * `ch` 既接受 5 个真实频道（dianying/…），也接受 3 个预设 key（doc/bluray/us）。
 * 筛选参数：class / area / year / sort_field / line(→上游 origin) / ban / exclude。
 */
router.get('/dyrs/site/list', async (req, res) => {
  const rawCh = (q(req, 'ch') || 'dianying').trim();
  const preset = findPreset(rawCh);

  if (!preset && !isSiteChannel(rawCh)) {
    return fail(res, 400, `频道必须是 ${[...DYRS_CHANNELS, ...SITE_PRESETS.map((p) => p.key)].join('/')}`);
  }

  // 预设入口是「精选首页」，不参与翻页（上游对带筛选的翻页会丢掉筛选）
  const page = preset ? 0 : Math.max(0, Number(q(req, 'page')) || 0);
  const ch = preset ? preset.ch : rawCh;
  const presetParams = preset ? preset.params : {};

  // 线路筛选值不合法就丢弃（当作没传），不透传上游
  const rawLine = q(req, 'line')?.trim() ?? '';
  const line = rawLine && isValidLineFilter(rawLine) ? rawLine : undefined;
  if (rawLine && !line) return fail(res, 400, 'line 参数只允许中英文/数字/空格/点/横线，长度 1~32');

  const rawExclude = q(req, 'exclude')?.trim() ?? '';
  const exclude = rawExclude === 'his' || rawExclude === 'unlike' ? rawExclude : undefined;
  if (rawExclude && !exclude) return fail(res, 400, 'exclude 只能是 his 或 unlike');

  const path = buildSiteListPath({
    ch,
    page,
    // 预设的固定筛选先铺底，用户显式传的同名参数可以覆盖它
    class: q(req, 'class') ?? presetParams.class,
    area: q(req, 'area') ?? presetParams.area,
    year: q(req, 'year') ?? presetParams.year,
    sortField: q(req, 'sort_field') ?? presetParams.sortField,
    line: line ?? presetParams.line,
    ban: q(req, 'ban') === 'true' || (presetParams.ban ?? false),
    exclude: exclude ?? presetParams.exclude,
  });

  try {
    const r = await fetchSitePage(path);
    if (r.status !== 200) return fail(res, r.status, upstreamMsg(r.status));
    const cards = parseCards(r.html);
    res.json({
      ok: true,
      channel: rawCh,
      preset: preset ? preset.key : null,
      page,
      cards,
      filters: parseFilters(r.html),
      /**
       * 预设入口一律不给分页。
       *
       * 实测：上游对「带 class/area 的筛选结果」并不会真的分页 —— 它返回的
       * page 链接来自全库（纪录片显示 3868 页），真翻到第 2 页时筛选被丢掉，
       * 结果又变回默认列表。与其给一个点了就「变味」的翻页条，不如只给精选首页。
       */
      maxPage: preset ? 0 : parseMaxPage(r.html),
      // 空结果不是错误：预设频道（纪录片/蓝光）本身内容就少，前端给一句提示即可
      empty: cards.length === 0,
    });
  } catch (e) {
    fail(res, 502, e instanceof Error ? e.message : '上游请求失败');
  }
});

/** 搜索 */
router.get('/dyrs/site/search', async (req, res) => {
  const wd = q(req, 'wd')?.trim();
  if (!wd) return fail(res, 400, '缺少 wd 参数');
  try {
    const r = await fetchSearchPage(wd);
    if (r.status !== 200) return fail(res, r.status, upstreamMsg(r.status));
    res.json({ ok: true, wd, cards: parseCards(r.html) });
  } catch (e) {
    fail(res, 502, e instanceof Error ? e.message : '上游请求失败');
  }
});

/**
 * 详情：meta + **所有线路的选集**。
 *
 * 上游是按 `?origin=` 服务端渲染选集的，不指定线路时就只有 tab 上有线路名和集数、
 * 一条选集都拿不到（线路切换直接没法做）。所以这里：
 *   - 不传 origin：逐条线路抓一遍（并发 3），拿到完整选集矩阵 → 整体缓存 10 分钟；
 *   - 传 origin：只要这一条，快路径。
 * 返回的 origins 已按「direct（真实 m3u8）优先」排好，播放器默认落在线路 1 就能直接开播。
 */
router.get('/dyrs/site/detail', async (req, res) => {
  const id = q(req, 'id');
  const kind = q(req, 'kind') || 'tv';
  const ep = q(req, 'ep') || '1';
  const origin = q(req, 'origin');
  if (!id || !/^[0-9a-f]{24}$/.test(id)) return fail(res, 400, 'id 格式不对（24 位 hex）');
  if (!(DYRS_KINDS as readonly string[]).includes(kind)) return fail(res, 400, `kind 必须是 ${DYRS_KINDS.join('/')}`);

  const path = (ori?: string) => `/${kind}/${id}-${ep}.html${ori ? `?origin=${encodeURIComponent(ori)}` : ''}`;

  try {
    // 快路径：只要指定线路
    if (origin) {
      const r = await fetchSitePage(path(origin));
      if (r.status !== 200) return fail(res, r.status, upstreamMsg(r.status));
      return res.json({ ok: true, detail: parseDetail(r.html, id, kind) });
    }

    const cacheKey = `${kind}:${id}:${ep}`;
    const hit = dyrsDetailCache.get(cacheKey);
    if (hit && Date.now() - hit.at < DYRS_DETAIL_TTL_MS) {
      res.setHeader('X-Cache', 'hit');
      return res.json({ ok: true, detail: hit.data });
    }

    const first = await fetchSitePage(path());
    if (first.status !== 200) return fail(res, first.status, upstreamMsg(first.status));
    const base = parseDetail(first.html, id, kind);
    const seq = base.seq;
    if (!base.origins.length) return fail(res, 502, '详情页里没有解析到任何线路');
    if (!seq) return fail(res, 502, '详情页里没有解析到选集编号（seq）');

    const line = await pickLine();
    const rows = await mapLimit(base.origins, 3, (o) =>
      loadDyrsOrigin(kind, id, seq, o.origin, line, o.count),
    );

    // 抓不到选集的线路直接不展示（选了也没东西可播）
    const origins = rows.filter((r): r is DyrsOriginRow => !!r);
    if (!origins.length) return fail(res, 502, '这部片的线路都没能解析出选集，稍后再试');

    // 线路可用性预检：
    // 「解析出选集」不等于「真能出流」—— 实测有线路的 CDN 会整段 502（xiguam3u8 的
    // svip.xgplay20.com），也有线路的 master 直接超时。用户点进去才发现播不了最难受，
    // 所以在详情里就探一次（3 层判断见 probePlaylistUrl，2.5s 超时、并发 6）。
    //
    //   ok   → alive: true   正常
    //   weak → alive: null   能拿到 master 但变体这会儿拉不动（hls.js 会重试，多数还能播）
    //   dead → alive: false  连 master 都拿不到，界面上置灰
    const probeBase = `http://127.0.0.1:${PORT}`;
    const checked = await mapLimit(origins, 6, async (o) => {
      const t0 = Date.now();
      const first = o.episodes[0];
      const state = first ? await probePlaylistUrl(probeBase + first.src, 2500) : 'dead';
      return { ...o, alive: state === 'ok' ? true : state === 'dead' ? false : null, aliveState: state, probeMs: Date.now() - t0 };
    });

    // 能确认出流的排前面，其次「待确认」，最后才是判死的；同等条件下 direct（真 m3u8）
    // 优先于 dyrs 自家 CDN（后者要绕一层 raw=1，慢且更容易抽）
    const rank = (s: string) => (s === 'ok' ? 0 : s === 'weak' ? 1 : 2);
    checked.sort((a, b) => {
      const d = rank(a.aliveState) - rank(b.aliveState);
      if (d !== 0) return d;
      if (a.kind === b.kind) return 0;
      return a.kind === 'direct' ? -1 : 1;
    });

    const data = { ...base, origins: checked };
    if (dyrsDetailCache.size > 60) dyrsDetailCache.clear();
    dyrsDetailCache.set(cacheKey, { at: Date.now(), data });
    res.setHeader('X-Cache', 'miss');
    res.json({ ok: true, detail: data });
  } catch (e) {
    fail(res, 502, e instanceof Error ? e.message : '上游请求失败');
  }
});

/** 清空影视仓详情缓存：GET /api/dyrs/site/flush */
router.get('/dyrs/site/flush', (_req, res) => {
  dyrsDetailCache.clear();
  resetSitePageCache();
  res.json({ ok: true });
});

/**
 * 封面图代理：/api/dyrs/site/img?id={24hex} 或 &u={绝对地址}
 * 上游要 Referer 才给图，浏览器直连会 403，所以统一走这里。
 */
router.get('/dyrs/site/img', async (req, res) => {
  const id = q(req, 'id');
  const u = q(req, 'u');
  if (!id && !u) return fail(res, 400, '缺少 id 或 u 参数');
  let target: string;
  if (u) {
    const deny = await checkUrl(u);
    if (deny) return fail(res, 403, deny);
    target = u;
  } else {
    if (!/^[0-9a-f]{24}$/.test(id!)) return fail(res, 400, 'id 格式不对');
    target = `/img/id/${id}.jpg`;
  }
  try {
    const r = await fetchSiteImage(target);
    if (r.status !== 200) return fail(res, r.status, upstreamMsg(r.status));
    res.setHeader('Content-Type', r.contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(r.body);
  } catch (e) {
    fail(res, 502, e instanceof Error ? e.message : '图片获取失败');
  }
});

/**
 * 云盘分享源：GET /api/dyrs/site/drive?name=&imdb=
 *
 * 上游 /api/drive/list?name= 返回该片的网盘分享（百度/阿里，带提取码）。
 * 它按 **box_data.name**（去掉「第X季」等后缀的片名）或 imdb_id 查，
 * 所以前端把详情接口返回的 boxName / imdbId 一并带上；优先 imdb，
 * 没结果再按片名回退（和上游前端的逻辑一致）。
 */
router.get('/dyrs/site/drive', async (req, res) => {
  const name = q(req, 'name').trim();
  const imdb = q(req, 'imdb').trim();
  if (!name && !imdb) return fail(res, 400, '缺少 name 或 imdb 参数');
  try {
    let items = imdb.startsWith('tt') ? await fetchDriveList(imdb) : [];
    if (items.length === 0 && name) items = await fetchDriveList(name);
    res.json({ ok: true, items });
  } catch (e) {
    fail(res, 502, e instanceof Error ? e.message : '云盘资源获取失败');
  }
});

/**
 * 解析「选集块 seq 里的第 p 集」的真实取流地址。
 *
 * 上游的选集地址是 `/{kind}/{id}/{seq}.html?origin=线路&p=集序号`：
 *   - seq 是 seqlist 编号（parseDetail 会给），同一部片固定；
 *   - p 是**0 基**集序号，实测 p=0 → 第01集、p=1 → 第02集（顺序和集标题都稳）。
 * 别用 `/{kind}/{id}/{N}.html` 那个 path 形式：实测 N 和集数对不上，只会一直返回第一集。
 */
async function resolveDyrsEpisode(
  kind: string,
  id: string,
  seq: string,
  p: string,
  origin?: string,
): Promise<{ status: number; src?: string; error?: string; info?: ReturnType<typeof parsePlayPage> }> {
  const qs = new URLSearchParams();
  if (origin) qs.set('origin', origin);
  qs.set('p', p);
  const r = await fetchSitePage(`/${kind}/${id}/${seq}.html?${qs.toString()}`);
  if (r.status !== 200) return { status: r.status, error: upstreamMsg(r.status) };
  const info = parsePlayPage(r.html);
  if (!info) return { status: 502, error: '播放页里没有找到取流参数（可能这一集还没有片源）' };
  const src = toPlaySrc(info.url, origin, await pickLine());
  if (!src) return { status: 502, error: '这一集没有可用的播放地址' };
  return { status: 200, src, info };
}

/**
 * 播放信息：GET /api/dyrs/site/play?id=&kind=&seq=&p=&origin=
 * 返回 JSON（`src` 就是本站的取流地址），适合前端自己接。
 */
router.get('/dyrs/site/play', async (req, res) => {
  const id = q(req, 'id');
  const kind = q(req, 'kind') || 'tv';
  const seq = q(req, 'seq') || q(req, 'ep') || '1';
  const p = q(req, 'p') || '0';
  const origin = q(req, 'origin');
  if (!id || !/^[0-9a-f]{24}$/.test(id)) return fail(res, 400, 'id 格式不对');
  try {
    const r = await resolveDyrsEpisode(kind, id, seq, p, origin || undefined);
    if (!r.src) return fail(res, r.status, r.error || '取流失败');
    res.json({
      ok: true,
      src: r.src,
      origin: r.info?.origin ?? origin ?? '',
      title: r.info?.title ?? '',
      next: r.info?.next ?? [],
    });
  } catch (e) {
    fail(res, 502, e instanceof Error ? e.message : '上游请求失败');
  }
});

/**
 * 影视仓取流跳板：GET /api/dyrs/src?kind=&id=&seq=&p=&origin=
 *
 * 老播放器（`public/player.js`）拿到的选集地址必须**能直接喂给 hls.js**，
 * 而「这一集」要先解析播放页才知道真实地址。这里做一层 302 跳板：
 *   解析播放页 → 换算出本站取流地址 → 302 过去。
 *
 * 跳转目标仍是**本站同源**地址（`/api/proxy?url=…` 或 `/api/dyrs/m3u8?proxy=1&…`），
 * 浏览器/hls.js 自动跟跳，不暴露上游 CDN，也照样享受占位图识别与清晰度重排。
 */
router.get('/dyrs/src', async (req, res) => {
  const id = q(req, 'id');
  const kind = q(req, 'kind') || 'tv';
  const seq = q(req, 'seq') || q(req, 'ep') || '1';
  const p = q(req, 'p') || '0';
  const origin = q(req, 'origin');
  if (!id || !/^[0-9a-f]{24}$/.test(id)) return fail(res, 400, 'id 格式不对');
  try {
    const r = await resolveDyrsEpisode(kind, id, seq, p, origin || undefined);
    if (!r.src) return fail(res, r.status, r.error || '取流失败');
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, r.src);
  } catch (e) {
    fail(res, 502, e instanceof Error ? e.message : '上游请求失败');
  }
});

/* ---------------- 收藏 ---------------- */

router.get('/favorites', async (_req, res) => {
  res.json({ ok: true, items: await listFavorites() });
});

router.post('/favorites', async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const id = String(b.id ?? '').trim();
  const name = String(b.name ?? '').trim();
  const source = String(b.source ?? '').trim();
  if (!id || !name || !source) return fail(res, 400, '缺少 id / name / source');

  const items = await addFavorite({
    id,
    name,
    source,
    pic: b.pic ? String(b.pic) : undefined,
    year: b.year ? String(b.year) : undefined,
  });
  res.json({ ok: true, items });
});

router.delete('/favorites', async (req, res) => {
  const id = q(req, 'id').trim();
  if (!id) return fail(res, 400, '缺少 id');
  const source = q(req, 'source') || undefined;
  res.json({ ok: true, items: await removeFavorite(id, source) });
});

/* ---------------- 历史 / 续播 ---------------- */

router.get('/history', async (_req, res) => {
  res.json({ ok: true, items: await listHistory() });
});

router.get('/progress', async (req, res) => {
  const id = q(req, 'id').trim();
  const source = q(req, 'source').trim();
  if (!id || !source) return fail(res, 400, '缺少 id 或 source');
  res.json({ ok: true, entry: await getHistory(id, source) });
});

router.post('/progress', async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const id = String(b.id ?? '').trim();
  const name = String(b.name ?? '').trim();
  const source = String(b.source ?? '').trim();
  if (!id || !name || !source) return fail(res, 400, '缺少 id / name / source');

  await saveHistory({
    id,
    name,
    source,
    pic: b.pic ? String(b.pic) : undefined,
    lineIndex: Number(b.lineIndex) || 0,
    episodeIndex: Number(b.episodeIndex) || 0,
    episodeName: b.episodeName ? String(b.episodeName) : undefined,
    position: Number(b.position) || 0,
    duration: Number(b.duration) || 0,
  });
  res.json({ ok: true });
});

router.delete('/history', async (_req, res) => {
  await clearHistory();
  res.json({ ok: true });
});

/* ---------------- 收藏状态 ---------------- */

router.get('/favorite-status', async (req, res) => {
  const id = q(req, 'id').trim();
  const source = q(req, 'source').trim();
  if (!id || !source) return fail(res, 400, '缺少 id 或 source');
  res.json({ ok: true, favorite: await isFavorite(id, source) });
});
