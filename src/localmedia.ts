/**
 * 本地媒体浏览与播放。
 *
 * 零配置设计：不用设任何环境变量，把视频丢进下列任一文件夹就自动生效——
 *   1. 环境变量 LOCAL_MEDIA_DIR 指定的目录（高级用法，优先级最高）
 *   2. 程序运行目录（或它的上一级）下的 videos / media / movies / 影片 / 视频 文件夹
 * 检测结果缓存 5 秒，所以新拷进去的视频**刷新网页即可看到**，无需重启服务。
 *
 * 安全是重点：
 *   - 一个都找不到时功能整体关闭
 *   - 所有路径必须落在根目录内（防 ../ 穿越）
 *   - 只列出 / 只播放常见视频扩展名
 *
 * 媒体库能力：
 *   - 封面识别：优先用同名图片（xxx.jpg / xxx-poster.png）或同目录的
 *     poster / folder / cover 图；都没有则交由前端抓帧生成
 *   - scanLibrary()：递归扫描整棵目录树，供「媒体库海报墙」使用
 */

import { createReadStream, statSync, type Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, extname, join, normalize, resolve, sep } from 'node:path';

/** 自动探测的候选文件夹名（按顺序取第一个存在的） */
const AUTO_DIRS = ['videos', 'media', 'movies', '影片', '视频', '电影'];

let cachedRoot: { at: number; dir: string | null } | null = null;
const ROOT_TTL_MS = 5000;

/** 解析当前生效的本地媒体根目录；没有则返回 null（功能关闭） */
export function localRoot(): string | null {
  if (cachedRoot && Date.now() - cachedRoot.at < ROOT_TTL_MS) return cachedRoot.dir;

  let dir: string | null = null;
  const env = process.env.LOCAL_MEDIA_DIR;
  if (env) {
    dir = resolve(env);
  } else {
    // 运行目录（NAS运行包/，start.sh 会 cd 到这里）+ 它的上一级（源码方式跑 dist 时）
    const bases = [process.cwd(), resolve(process.cwd(), '..')];
    outer: for (const base of bases) {
      for (const name of AUTO_DIRS) {
        const p = join(base, name);
        try {
          if (statSync(p).isDirectory()) {
            dir = p;
            break outer;
          }
        } catch {
          // 不存在就试下一个
        }
      }
    }
  }

  cachedRoot = { at: Date.now(), dir };
  return dir;
}

/** 手动失效缓存（测试用） */
export function resetLocalRootCache(): void {
  cachedRoot = null;
}

/**
 * 视频后缀白名单。
 * 注意：能「列出」≠ 浏览器能「解码」。TS/FLV 等由前端 mpegts.js 软解，
 * AVI/WMV/RMVB 等浏览器确实无解，仍会列出但在播放页给出明确提示。
 */
const VIDEO_EXTS = new Set([
  // 原生可播 / MSE 库可解
  '.mp4', '.m4v', '.webm', '.mov', '.m3u8',
  '.ts', '.mts', '.m2ts', '.m2s', '.flv', '.f4v',
  '.mkv',
  // 仅列出（浏览器基本解不了，播放页会提示转码）
  '.avi', '.divx', '.wmv', '.asf', '.mpg', '.mpeg', '.mpe', '.m1v', '.m2v',
  '.vob', '.3gp', '.3g2', '.ogv', '.rm', '.rmvb', '.mxf', '.dv', '.tod', '.tp', '.trp',
  // 音频（顺手支持）
  '.mp3', '.m4a', '.flac', '.wav', '.ogg', '.aac', '.opus',
]);

/** 音频后缀（媒体库里按「音频」分类展示） */
const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.flac', '.wav', '.ogg', '.aac', '.opus']);

/** 扩展名 → HTTP Content-Type（按 RFC 官方注册名，别一律给 mp4） */
const MIME_MAP: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.ts': 'video/mp2t',
  '.mts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.m2s': 'video/mp2t',
  '.tp': 'video/mp2t',
  '.trp': 'video/mp2t',
  '.flv': 'video/x-flv',
  '.f4v': 'video/mp4',
  '.avi': 'video/x-msvideo',
  '.divx': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.asf': 'video/x-ms-asf',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.mpe': 'video/mpeg',
  '.m1v': 'video/mpeg',
  '.m2v': 'video/mpeg',
  '.vob': 'video/mpeg',
  '.3gp': 'video/3gpp',
  '.3g2': 'video/3gpp2',
  '.ogv': 'video/ogg',
  '.rm': 'application/vnd.rn-realmedia',
  '.rmvb': 'application/vnd.rn-realmedia-vbr',
  '.mxf': 'application/mxf',
  '.dv': 'video/x-dv',
  '.tod': 'video/mp2t',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.aac': 'audio/aac',
  '.opus': 'audio/ogg',
  // 封面图（同名海报 / 目录海报）：给对 MIME，浏览器才知道这是图片而不是媒体流
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
};

/** 封面图片扩展名 */
const IMG_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.avif', '.bmp', '.gif'];

/** 目录级海报的候选文件名（不含扩展名） */
const POSTER_STEMS = ['poster', 'folder', 'cover', 'fanart', 'thumb', 'default', '海报', '封面'];

export function extMime(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
  return MIME_MAP[ext] || 'application/octet-stream';
}

/** 是否是可列出/可播放的媒体扩展名 */
export function isMediaExt(ext: string): boolean {
  return VIDEO_EXTS.has(ext.toLowerCase());
}

/** 媒体类型：视频 or 音频 */
export function mediaKind(ext: string): 'video' | 'audio' {
  return AUDIO_EXTS.has(ext.toLowerCase()) ? 'audio' : 'video';
}

export function localEnabled(): boolean {
  return localRoot() !== null;
}

/** 解析用户传入的相对路径，拒绝越出指定根目录 */
export function safePath(root: string, sub: string): string | null {
  if (!root) return null;
  const cleaned = normalize(sub || '');
  if (cleaned.includes('..')) return null; // 任何形式的上级引用一律拒绝
  const full = resolve(root, cleaned);
  if (full !== root && !full.startsWith(root + sep)) return null;
  return full;
}

/** 取小写扩展名（含点） */
function extOf(name: string): string {
  return extname(name).toLowerCase();
}

/** 以 posix 风格拼相对路径（前端当 key 用） */
function toRel(dir: string, name: string): string {
  const base = dir ? dir.replace(/[\\/]+$/, '') : '';
  return base ? `${base}/${name}` : name;
}

export interface LocalEntry {
  name: string;
  /** 目录 or 文件 */
  dir: boolean;
  /** 相对根目录的路径（回传给 API 用） */
  path: string;
  size?: number;
  ext?: string;
  /** video / audio */
  kind?: 'video' | 'audio';
  /** 同目录下的封面图相对路径（若有） */
  cover?: string;
  /** 修改时间（毫秒，前端抓帧缓存的 key 之一） */
  mtime?: number;
}

/**
 * 在给定目录的文件名集合里找封面图。
 * @param names 小写文件名集合（同目录下所有文件）
 * @param dirRel 该目录的相对路径
 */
function findCover(names: Set<string>, videoName: string, dirRel: string): string | undefined {
  const stem = basename(videoName, extname(videoName)).toLowerCase();

  // 1) 同名 / 同名 + 后缀
  const candidates = [stem, `${stem}-poster`, `${stem}.poster`, `${stem}_poster`, `${stem}-cover`];
  for (const c of candidates) {
    for (const ie of IMG_EXTS) {
      if (names.has(c + ie)) return toRel(dirRel, c + ie);
    }
  }

  // 2) 目录级海报
  for (const p of POSTER_STEMS) {
    for (const ie of IMG_EXTS) {
      if (names.has(p + ie)) return toRel(dirRel, p + ie);
    }
  }
  return undefined;
}

/** 把封面路径的最后一段换成磁盘上的真实大小写 */
function fixCase(cover: string, realName: Map<string, string>): string {
  const seg = cover.split('/');
  const last = seg.pop() as string;
  seg.push(realName.get(last.toLowerCase()) || last);
  return seg.filter(Boolean).join('/');
}

/** 扫一遍目录名，用于封面匹配 */
function indexNames(items: Dirent[]): { lower: Set<string>; real: Map<string, string> } {
  const lower = new Set<string>();
  const real = new Map<string, string>();
  for (const it of items) {
    if (it.name.startsWith('.')) continue;
    lower.add(it.name.toLowerCase());
    real.set(it.name.toLowerCase(), it.name);
  }
  return { lower, real };
}

export async function listLocal(
  root: string,
  sub: string,
): Promise<{ path: string; root: string; entries: LocalEntry[] } | null> {
  const full = safePath(root, sub);
  if (!root || !full) return null;

  try {
    // 只读不建：列目录不应该在磁盘上创建任何东西
    // （早期版本这里 mkdir，非法参数 path=undefined 会在片库里造出垃圾目录）
    const items = await readdir(full, { withFileTypes: true });
    const { lower, real } = indexNames(items);
    const entries: LocalEntry[] = [];

    for (const it of items) {
      if (it.name.startsWith('.')) continue;
      const rel = toRel(sub, it.name);
      if (it.isDirectory()) {
        entries.push({ name: it.name, dir: true, path: rel });
        continue;
      }
      const ext = extOf(it.name);
      if (!isMediaExt(ext)) continue;

      let size: number | undefined;
      let mtime: number | undefined;
      try {
        const st = await stat(join(full, it.name));
        size = st.size;
        mtime = st.mtimeMs;
      } catch {
        // 读不到大小就算了
      }

      const rawCover = findCover(lower, it.name, sub);
      entries.push({
        name: it.name,
        dir: false,
        path: rel,
        size,
        ext,
        kind: mediaKind(ext),
        cover: rawCover ? fixCase(rawCover, real) : undefined,
        mtime,
      });
    }

    // 目录在前、文件在后，各自按名排序
    entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'zh') : a.dir ? -1 : 1));
    return { path: sub, root, entries };
  } catch {
    return null;
  }
}

/* ---------------- 媒体库：递归扫描 ---------------- */

export interface LibEntry extends LocalEntry {
  /** 所属子目录（相对根，'' 表示根目录） */
  folder: string;
  /** 展示标题：去掉扩展名，`.` `_` 转空格 */
  title: string;
}

export interface LibraryResult {
  root: string;
  path: string;
  entries: LibEntry[];
  /** 是否因为超过上限被截断 */
  truncated: boolean;
  /** 扫描过的目录数 */
  dirs: number;
}

/** 媒体库扫描上限，防止把超大目录树扫爆 */
const LIB_MAX_DEPTH = 6;
const LIB_MAX_FILES = 5000;
const LIB_MAX_DIRS = 2000;

function cleanTitle(name: string, ext: string): string {
  let t = name;
  if (ext && t.toLowerCase().endsWith(ext)) t = t.slice(0, -ext.length);
  return t.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim() || name;
}

/**
 * 递归扫描媒体库。
 * @param root 根目录绝对路径
 * @param sub  起始相对子目录（'' 表示整个根）
 */
export async function scanLibrary(root: string, sub: string): Promise<LibraryResult | null> {
  const start = safePath(root, sub);
  if (!root || !start) return null;

  const entries: LibEntry[] = [];
  let truncated = false;
  let dirCount = 0;

  async function walk(dir: string, rel: string, depth: number): Promise<void> {
    if (truncated) return;
    if (depth > LIB_MAX_DEPTH) return;
    if (dirCount >= LIB_MAX_DIRS) {
      truncated = true;
      return;
    }
    dirCount++;

    let items: Dirent[];
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const { lower, real } = indexNames(items);

    for (const it of items) {
      if (entries.length >= LIB_MAX_FILES) {
        truncated = true;
        return;
      }
      if (it.name.startsWith('.')) continue;

      if (it.isDirectory()) {
        await walk(join(dir, it.name), toRel(rel, it.name), depth + 1);
        continue;
      }

      const ext = extOf(it.name);
      if (!isMediaExt(ext)) continue;

      let size: number | undefined;
      let mtime: number | undefined;
      try {
        const st = await stat(join(dir, it.name));
        size = st.size;
        mtime = st.mtimeMs;
      } catch {
        // 忽略
      }

      const rawCover = findCover(lower, it.name, rel);
      entries.push({
        name: it.name,
        dir: false,
        path: toRel(rel, it.name),
        folder: rel,
        title: cleanTitle(it.name, ext),
        size,
        ext,
        kind: mediaKind(ext),
        cover: rawCover ? fixCase(rawCover, real) : undefined,
        mtime,
      });
    }
  }

  try {
    await walk(start, sub ? sub.replace(/[\\/]+$/, '') : '', 0);
  } catch {
    return null;
  }

  // 按目录 + 文件名排序，让同一部剧的集数挨在一起（S01E02 排在 S01E10 前面）
  entries.sort((a, b) =>
    a.folder === b.folder
      ? a.name.localeCompare(b.name, 'zh', { numeric: true })
      : a.folder.localeCompare(b.folder, 'zh'),
  );

  return { root, path: sub, entries, truncated, dirs: dirCount };
}

/** 解析 Range 头，返回 [start, end]，不支持时返回 null（整文件） */
function parseRange(header: string | undefined, size: number): [number, number] | null {
  if (!header) return null;
  const m = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  let start: number;
  let end: number;
  if (a === '') {
    // bytes=-N：最后 N 字节
    start = Math.max(0, size - Number(b));
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return [start, end];
}

/**
 * 流式发送本地文件（视频 / 音频 / 封面图），支持 Range 拖动进度条。
 * 返回 false 表示路径非法或文件不存在。
 */
export async function serveLocalFile(
  root: string,
  sub: string,
  rangeHeader: string | undefined,
  reply: {
    setHeader: (k: string, v: string | number) => void;
    status: (n: number) => unknown;
  },
  send: (stream: NodeJS.ReadableStream) => void,
): Promise<boolean> {
  const full = safePath(root, sub);
  if (!full) return false;

  let size: number;
  let mtime: Date;
  try {
    const st = await stat(full);
    if (!st.isFile()) return false;
    size = st.size;
    mtime = st.mtime;
  } catch {
    return false;
  }

  // 按真实扩展名给 MIME：早期版本一律 video/mp4，
  // mkv/ts/flv 用错 MIME 会被部分浏览器（Firefox / Safari）直接拒绝解析。
  const mime = extMime(full);
  const isImage = mime.startsWith('image/') || IMG_EXTS.includes(extOf(full));

  // 封面图不需要 Range，整张发完并可长缓存；媒体流走 Range
  const range = isImage ? null : parseRange(rangeHeader, size);
  // 大文件流用 1MB 高水位：默认 64KB 在机械盘/NAS 网络盘上读得太碎，
  // 播放器一边解析一边等下一块，表现出来就是「隔一会儿顿一下」。
  const stream = createReadStream(
    full,
    range
      ? { start: range[0], end: range[1], highWaterMark: 1 << 20 }
      : { highWaterMark: 1 << 20 },
  );

  reply.setHeader('Content-Type', mime);
  reply.setHeader('Accept-Ranges', 'bytes');
  // 媒体流用 no-store：本地文件不该被浏览器缓存膨胀（用户在不断换片看），
  // 但带上 Last-Modified 让播放器能做条件请求，拖进度条时省掉重复解码。
  reply.setHeader('Cache-Control', isImage ? 'public, max-age=86400' : 'no-store');
  reply.setHeader('Last-Modified', mtime.toUTCString());
  if (range) {
    reply.status(206);
    reply.setHeader('Content-Range', `bytes ${range[0]}-${range[1]}/${size}`);
    reply.setHeader('Content-Length', range[1] - range[0] + 1);
  } else {
    reply.setHeader('Content-Length', size);
  }
  send(stream);
  return true;
}
