/**
 * 服务端视频封面抽帧（ffmpeg）。
 *
 * 为什么不能只靠浏览器抓帧：
 *   Chrome / Firefox 解不了 MKV、HEVC(H.265)、RMVB、AVI 这些 NAS 上最常见的电影格式，
 *   <video> 加载直接报错 → 一张封面都抓不到。这正是「本地媒体没有封面」的原因。
 *   桌面播放器能看到封面，是因为它们底下就是 ffmpeg。
 *
 * 所以这里让 NAS 上的 ffmpeg 抽一帧（默认片头过去约 15% 处），落盘缓存；
 * 找不到 ffmpeg 时返回 null，前端会自动回退到浏览器抓帧（mp4/webm 仍可用）。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.js';

const _here = dirname(fileURLToPath(import.meta.url));
/** 代码根目录：编译态是 dist 的上一级（NAS 上即 nas-pack/app） */
const APP_DIR = resolve(_here, '..');

/** 抽帧结果缓存目录（DATA_DIR 是持久化目录，更新代码不会被清掉） */
const COVER_DIR = join(DATA_DIR, 'covers');
const FFMPEG_TIMEOUT = 30_000;
/** 同时最多跑几个 ffmpeg，避免把 NAS 的 CPU 拉满 */
const MAX_CONCURRENT = 2;

function exist(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

/* ---------------- 定位 ffmpeg ---------------- */

let probeCache: Promise<string | null> | null = null;
/** 上次探测「没找到」的时间：允许过一会儿重探，装上 ffmpeg 后刷新页面即可生效 */
let probeMissAt = 0;

/** 候选路径：环境变量 > 随包安装的静态 ffmpeg > 系统 / NAS 常见位置 > PATH */
function candidates(): string[] {
  const list: string[] = [];
  const env = (process.env.FFMPEG_PATH || '').trim();
  if (env) list.push(env);
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  // 随 npm 一起装下来的静态 ffmpeg（optionalDependencies）
  list.push(join(APP_DIR, 'node_modules', '@ffmpeg-installer', `${process.platform}-${process.arch}`, exe));
  list.push(join(APP_DIR, 'node_modules', 'ffmpeg-static', exe));
  // 有些环境会把解压好的二进制放在 app 根目录
  list.push(join(APP_DIR, exe));
  if (process.platform !== 'win32') {
    list.push(
      '/usr/bin/ffmpeg',
      '/usr/local/bin/ffmpeg',
      '/bin/ffmpeg',
      '/snap/bin/ffmpeg',
      '/opt/bin/ffmpeg',
      '/opt/ffmpeg/bin/ffmpeg',
      '/usr/local/ffmpeg/bin/ffmpeg',
      '/usr/lib/ffmpeg/ffmpeg',
      // 飞牛 fnOS / 群晖 / 威联通 / 极空间 的应用目录
      '/usr/trim/bin/ffmpeg',
      '/var/apps/ffmpeg/bin/ffmpeg',
      '/vol1/@appstore/ffmpeg/bin/ffmpeg',
      '/vol1/@appcenter/ffmpeg/bin/ffmpeg',
      '/volume1/@appstore/ffmpeg/bin/ffmpeg',
      '/share/CACHEDEV1_DATA/.qpkg/ffmpeg/bin/ffmpeg',
    );
  }
  list.push('ffmpeg'); // 交给 PATH 解析
  return list;
}

/** 跑一条命令并把 stdout 拿回来（超时就放弃，绝不卡住主流程） */
function runCapture(bin: string, args: string[], timeout = 8000): Promise<{ ok: boolean; out: string }> {
  return new Promise((done) => {
    let settled = false;
    const finish = (v: { ok: boolean; out: string }) => {
      if (!settled) {
        settled = true;
        done(v);
      }
    };
    try {
      const child = execFile(
        bin,
        args,
        { timeout, maxBuffer: 2 * 1024 * 1024 },
        (err, stdout) => finish({ ok: !err, out: String(stdout || '') }),
      );
      child.on('error', () => finish({ ok: false, out: '' }));
    } catch {
      finish({ ok: false, out: '' });
    }
  });
}

/** 同上，但连 stderr 一起收（ffmpeg 把流信息打在 stderr 上） */
function runCaptureErr(bin: string, args: string[], timeout = 8000): Promise<{ ok: boolean; out: string }> {
  return new Promise((done) => {
    let settled = false;
    const finish = (v: { ok: boolean; out: string }) => {
      if (!settled) {
        settled = true;
        done(v);
      }
    };
    try {
      const child = execFile(
        bin,
        args,
        { timeout, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => finish({ ok: !err, out: `${String(stdout || '')}\n${String(stderr || '')}` }),
      );
      child.on('error', () => finish({ ok: false, out: '' }));
    } catch {
      finish({ ok: false, out: '' });
    }
  });
}

/**
 * 快速候选都找不到时，用 find 在 NAS 的应用目录里捞一遍。
 *
 * 为什么需要：能播片的「飞牛影视」这类原生 App 自己就带一个 ffmpeg，
 * 但它不会放到 /usr/bin。只查固定路径永远查不到，转码就永远起不来。
 *
 * 两个保护：
 *   - 带 -maxdepth 限制范围，并且限制**总预算**（最多 8 秒），绝不把首个页面请求拖死；
 *   - **整个进程只扫一次**，后面没找到就直接跳过（否则探测失败每轮都重扫，页面反复卡）。
 */
let scanDone = false;
let scanHits: string[] = [];

async function scanForFfmpeg(): Promise<string[]> {
  if (process.platform === 'win32' || scanDone) return scanHits;
  scanDone = true;
  const roots = ['/vol1', '/vol2', '/volume1', '/usr/trim', '/var/apps', '/opt', '/usr/local'];
  const found: string[] = [];
  const t0 = Date.now();
  for (const root of roots) {
    if (Date.now() - t0 > 8000) break;
    if (!exist(root)) continue;
    const { ok, out } = await runCapture(
      'find',
      [root, '-maxdepth', '6', '-type', 'f', '-name', 'ffmpeg', '-print'],
      4000,
    );
    if (!ok && !out) continue;
    for (const line of out.split('\n')) {
      const p = line.trim();
      if (p && !found.includes(p)) found.push(p);
    }
    if (found.length >= 8) break;
  }
  scanHits = found;
  return found;
}

/**
 * 让登录 shell 帮忙解析 ffmpeg。
 *
 * 服务多半是被开机脚本/守护进程拉起来的，PATH 常常只有 /usr/bin:/bin，
 * 用户 SSH 里能跑 ffmpeg 但服务里找不到——这一步专门补这个坑。
 */
async function viaLoginShell(): Promise<string | null> {
  if (process.platform === 'win32') return null;
  for (const shell of ['/bin/sh', '/bin/bash']) {
    if (!exist(shell)) continue;
    const { ok, out } = await runCapture(shell, ['-lc', 'command -v ffmpeg'], 6000);
    const p = out.trim().split('\n').pop()?.trim() ?? '';
    if (ok && p.startsWith('/') && exist(p)) return p;
  }
  return null;
}

function runOk(bin: string, args: string[], timeout = 8000): Promise<boolean> {
  return new Promise((done) => {
    let settled = false;
    const finish = (v: boolean) => {
      if (!settled) {
        settled = true;
        done(v);
      }
    };
    try {
      const child = execFile(bin, args, { timeout }, (err) => finish(!err));
      child.on('error', () => finish(false));
    } catch {
      finish(false);
    }
  });
}

/** 返回可用的 ffmpeg 可执行文件；找不到返回 null（找到就永久缓存，没找到则 60 秒后重探） */
export function ffmpegPath(): Promise<string | null> {
  const stale = !!probeCache && probeMissAt !== 0 && Date.now() - probeMissAt > 60_000;
  if (!probeCache || stale) {
    probeMissAt = 0;
    probeCache = (async () => {
      // 第一轮：固定候选路径（毫秒级）
      for (const p of candidates()) {
        const looksLikePath = p.includes('/') || p.includes('\\');
        if (looksLikePath && !exist(p)) continue;
        if (await runOk(p, ['-version'])) return p;
      }
      // 第二轮：登录 shell 的 PATH（服务 PATH 被裁剪时能救回来）
      const shellHit = await viaLoginShell();
      if (shellHit && (await runOk(shellHit, ['-version']))) return shellHit;
      // 第三轮：扫 NAS 应用目录（有点慢，但只做一次）
      for (const p of await scanForFfmpeg()) {
        if (await runOk(p, ['-version'])) return p;
      }
      probeMissAt = Date.now();
      return null;
    })();
  }
  return probeCache;
}

/** 手动清掉探测缓存（装完 ffmpeg 想立刻生效时用；「⚙ 诊断 → 重新检测」会调它） */
export function resetFfmpegCache(): void {
  probeCache = null;
  probeMissAt = 0;
  ffprobeCache = null;
  encCache = null;
  scanDone = false;
  scanHits = [];
}

/* ---------------- ffmpeg 能力探测 ---------------- */

let encCache: Promise<{ version: string; encoders: string[]; hwaccels: string[] }> | null = null;

/**
 * 读 ffmpeg 的版本、可用编码器、可用硬件加速方式。
 *
 * 作用：决定转码用「NAS 的硬件编码器」还是「CPU 软编」。
 * 飞牛影视之所以能流畅转码，很大一部分就是它在用 QSV / VAAPI 硬编；
 * 我们只跑 libx264 的话，一部 1080p 电影可能只有 0.3 倍速。
 */
export function ffmpegCapabilities(): Promise<{ version: string; encoders: string[]; hwaccels: string[] }> {
  if (!encCache) {
    encCache = (async () => {
      const bin = await ffmpegPath();
      if (!bin) return { version: '', encoders: [], hwaccels: [] };
      const [ver, enc, hw] = await Promise.all([
        runCapture(bin, ['-hide_banner', '-version'], 8000),
        runCapture(bin, ['-hide_banner', '-encoders'], 8000),
        runCapture(bin, ['-hide_banner', '-hwaccels'], 8000),
      ]);
      const version = (ver.out.split('\n')[0] || '').trim();
      const encoders = [...enc.out.matchAll(/^\s*[A-Z.]{6}\s+(\S+)/gm)].map((m) => m[1]);
      const hwaccels = hw.out
        .split('\n')
        .slice(1)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('Hardware acceleration'));
      return { version, encoders, hwaccels };
    })();
  }
  return encCache;
}

/** 按优先级挑一个可用的 H.264 硬件编码器；都没有则返回 null（用 CPU 软编） */
export async function pickHardwareEncoder(): Promise<string | null> {
  const allow = (process.env.TRANSCODE_ENCODER || '').trim();
  if (allow) return allow === 'libx264' || allow === 'none' ? (allow === 'none' ? null : 'libx264') : allow;
  const { encoders } = await ffmpegCapabilities();
  const has = (n: string) => encoders.includes(n);
  if (process.platform === 'linux') {
    if (has('h264_qsv')) return 'h264_qsv';
    if (has('h264_nvenc')) return 'h264_nvenc';
    if (has('h264_vaapi')) return 'h264_vaapi';
    if (has('h264_v4l2m2m')) return 'h264_v4l2m2m';
  }
  if (process.platform === 'darwin' && has('h264_videotoolbox')) return 'h264_videotoolbox';
  if (process.platform === 'win32') {
    if (has('h264_qsv')) return 'h264_qsv';
    if (has('h264_nvenc')) return 'h264_nvenc';
    if (has('h264_amf')) return 'h264_amf';
  }
  return null;
}

/* ---------------- 并发闸门 ---------------- */

let running = 0;
const waiters: Array<() => void> = [];

function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running += 1;
    return Promise.resolve();
  }
  return new Promise((res) => waiters.push(() => {
    running += 1;
    res();
  }));
}

function release(): void {
  running -= 1;
  const next = waiters.shift();
  if (next) next();
}

/* ---------------- ffprobe / 媒体信息 ---------------- */

let ffprobeCache: Promise<string | null> | null = null;

/** 返回与 ffmpeg 同目录的 ffprobe；没有则 null（结果缓存） */
export function ffprobePath(): Promise<string | null> {
  if (!ffprobeCache) {
    ffprobeCache = ffmpegPath().then(async (ff) => {
      if (!ff) return null;
      const dir = dirname(ff);
      const name = basename(ff).replace(/^ffmpeg/i, 'ffprobe');
      const probe = dir && dir !== '.' ? join(dir, name) : name;
      const looksLikePath = probe.includes('/') || probe.includes('\\');
      if (looksLikePath && !exist(probe)) return null;
      return (await runOk(probe, ['-version'])) ? probe : null;
    });
  }
  return ffprobeCache;
}

export interface MediaInfo {
  codec: string;
  audio: string;
  width: number;
  height: number;
  duration: number;
  /** 像素格式，例如 yuv420p / yuv420p10le —— 10bit/4:4:4 的 H.264 网页播不了 */
  pixFmt?: string;
  /** 编码档次，例如 High / High 10 / Main */
  profile?: string;
  /** 容器名，例如 mov,mp4,m4a,3gp,3g2,mj2 或 matroska,webm */
  format?: string;
}

/**
 * 探测结果的进程内缓存。
 *
 * 为什么必须缓存：/local/playplan 是「每次点播放都要走一次」的热路径，
 * 而 ffprobe 要起一个子进程、寻道读文件头，机械盘上经常要 200ms~2s。
 * 同一个文件在短时间内会被问很多次（前端 decide() 一次、startTranscode() 又一次、
 * 出错时还要再问），不缓存就是纯浪费，用户感知就是「点一下要等半天才出画面」。
 *
 * 缓存键带上 mtime + size：文件被替换/重新下载后自动失效，不会拿旧数据骗人。
 */
const PROBE_CACHE = new Map<string, { at: number; info: MediaInfo | null }>();
/** 探测结果保鲜期：5 分钟。局域网里同一个文件不会 5 分钟就换一份。 */
const PROBE_TTL_MS = 5 * 60_000;
/** 同时只允许 N 个 ffprobe 子进程，避免一次点开一整个目录把 NAS 打满 */
const PROBE_MAX_CONCURRENT = 3;
let probeRunning = 0;
const probeWaiters: Array<() => void> = [];

async function withProbeSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (probeRunning >= PROBE_MAX_CONCURRENT) {
    await new Promise<void>((res) => probeWaiters.push(res));
  }
  probeRunning++;
  try {
    return await fn();
  } finally {
    probeRunning--;
    const next = probeWaiters.shift();
    if (next) next();
  }
}

/** 读一个视频的编码信息（浏览器不支持时用来给用户看真实原因）；读不到返回 null */
export async function probeMedia(file: string): Promise<MediaInfo | null> {
  const key = await probeCacheKey(file);
  if (key) {
    const hit = PROBE_CACHE.get(key);
    if (hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.info;
  }

  const info = await withProbeSlot(() => probeMediaUncached(file));

  if (key) {
    // 缓存别无限长，超过 500 条就把最老的清掉
    if (PROBE_CACHE.size > 500) {
      const oldest = [...PROBE_CACHE.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 200);
      for (const [k] of oldest) PROBE_CACHE.delete(k);
    }
    PROBE_CACHE.set(key, { at: Date.now(), info });
  }
  return info;
}

/** 缓存键：真实路径 + mtime + size；stat 失败（文件没了）就返回 null，不缓存 */
async function probeCacheKey(file: string): Promise<string | null> {
  try {
    const st = await stat(file);
    return `${file}|${st.mtimeMs}|${st.size}`;
  } catch {
    return null;
  }
}

/** 清空探测缓存（测试 / 诊断用） */
export function resetProbeCache(): void {
  PROBE_CACHE.clear();
}

async function probeMediaUncached(file: string): Promise<MediaInfo | null> {
  const probe = await ffprobePath();
  if (probe) {
    const viaProbe = await probeWithFfprobe(probe, file);
    if (viaProbe) return viaProbe;
  }
  // 没有 ffprobe 的回退：直接让 ffmpeg 打印流信息（NAS 上「有 ffmpeg 没 ffprobe」很常见）
  const bin = await ffmpegPath();
  if (!bin) return null;
  return probeWithFfmpeg(bin, file);
}

async function probeWithFfprobe(probe: string, file: string): Promise<MediaInfo | null> {
  const raw = (
    await runCapture(
      probe,
      [
        '-v', 'error',
        '-show_entries', 'stream=codec_name,codec_type,width,height,profile,pix_fmt',
        '-show_entries', 'format=duration,format_name',
        '-of', 'json',
        file,
      ],
      15_000,
    )
  ).out;
  try {
    const j = JSON.parse(raw) as {
      streams?: Array<{
        codec_name?: string;
        codec_type?: string;
        width?: number;
        height?: number;
        profile?: string;
        pix_fmt?: string;
      }>;
      format?: { duration?: string; format_name?: string };
    };
    const v = (j.streams ?? []).find((s) => s.codec_type === 'video' || (s.width ?? 0) > 0);
    const a = (j.streams ?? []).find((s) => s.codec_type === 'audio');
    const dur = Number.parseFloat(String(j.format?.duration ?? ''));
    if (!v) return null;
    return {
      codec: String(v.codec_name ?? 'unknown'),
      audio: String(a?.codec_name ?? ''),
      width: Number(v.width ?? 0),
      height: Number(v.height ?? 0),
      duration: Number.isFinite(dur) ? dur : 0,
      pixFmt: v.pix_fmt ? String(v.pix_fmt) : '',
      profile: v.profile ? String(v.profile) : '',
      format: j.format?.format_name ? String(j.format.format_name) : '',
    };
  } catch {
    return null;
  }
}

/**
 * 没装 ffprobe 时，让 ffmpeg 把流信息打到 stderr 上再解析。
 *
 * 命令是 `ffmpeg -i 文件`（故意不给输出文件）：ffmpeg 打印完元数据就会报
 * "At least one output file must be specified" 退出，所以是毫秒级、不会解码整片。
 */
export function parseFfmpegHeader(text: string): MediaInfo | null {
  const vline = text.split('\n').find((l) => /Stream #\d+:\d+.*: Video: /.test(l));
  if (!vline) return null;

  const vm = vline.match(/Video: ([A-Za-z0-9_]+)(?: \(([^)]*)\))?([^\n]*)/);
  if (!vm) return null;
  const codec = vm[1];
  const profile = vm[2] || '';
  const rest = vm[3] || '';

  const am = text.match(/Stream #\d+:\d+.*?: Audio: ([A-Za-z0-9_]+)/);

  let width = 0;
  let height = 0;
  const rm = rest.match(/(\d{2,5})x(\d{2,5})/);
  if (rm) {
    width = Number(rm[1]);
    height = Number(rm[2]);
  }

  // 像素格式：在流信息里按逗号切开，找第一个长得像像素格式的词
  let pixFmt = '';
  for (const part of rest.split(',')) {
    const token = part.trim().replace(/[([].*$/, '').trim();
    if (/^(yuv|yuva|yuyv|uyvy|nv1\d|nv2\d|p0\d\d|gbr|rgb|bgr|gray|mono|xyz)/.test(token)) {
      pixFmt = token;
      break;
    }
  }

  let duration = 0;
  const dm = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (dm) duration = Number(dm[1]) * 3600 + Number(dm[2]) * 60 + Number.parseFloat(dm[3]);

  return { codec, audio: am ? am[1] : '', width, height, duration, pixFmt, profile, format: '' };
}

async function probeWithFfmpeg(bin: string, file: string): Promise<MediaInfo | null> {
  const r = await runCaptureErr(bin, ['-hide_banner', '-i', file], 15_000);
  if (!r.out) return null;
  try {
    return parseFfmpegHeader(r.out);
  } catch {
    return null;
  }
}

/* ---------------- 文件体检 ---------------- */

export interface MediaCheck {
  /** 能解码（文件没坏） */
  decodable: boolean;
  /** 两段体检实际解出来的总帧数 */
  frames: number;
  /** 每段尝试解码的秒数 */
  seconds: number;
  /** 真正的错误（只认明确的损坏/解码失败特征） */
  errors: string[];
  /** 无害告警（例如 muxer 抱怨时间戳重复），展示给用户看但不影响结论 */
  warnings: string[];
}

/**
 * 只是输出端（muxer）的抱怨，不代表文件坏了。
 * 典型：手机/录屏文件时间戳有重复，null muxer 会刷
 * "Application provided invalid, non monotonically increasing dts"。
 * 这类告警在能正常解码的文件上同样会出现——早期版本误当成"文件损坏"，已修。
 */
const BENIGN_LOG = [
  /non monotonically increasing dts/i,
  /Application provided invalid/i,
  /Last message repeated/i,
  /Guessed Channel Layout/i,
  /deprecated pixel format/i,
  /co located POCs unavailable/i,
  /mmco: unref short failure/i,
  /Frame num gap/i,
  /non-existing PPS/i,
  /missing picture in access unit/i,
  /Picture timing SEI/i,
  /VBV buffer size not set/i,
];

/** 真正的损坏 / 解码失败特征 */
const HARD_LOG = [
  /Invalid data found/i,
  /moov atom not found/i,
  /Could not find codec parameters/i,
  /Error while decoding/i,
  /corrupt/i,
  /Truncat/i,
  /decode_slice_header error/i,
  /Invalid NAL/i,
  /Error opening input/i,
  /does not contain any stream/i,
  /no frame!/i,
  /Packet corrupt/i,
  /Error splitting the input/i,
  /Could not open file/i,
];

/** 把 ffmpeg 的日志分成「真要命的」和「只是唠叨」。不认识的归到唠叨，避免误报损坏。 */
export function classifyFfmpegLog(lines: string[]): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (HARD_LOG.some((re) => re.test(line))) errors.push(line);
    else warnings.push(line);
  }
  const uniq = (a: string[]) => [...new Set(a)];
  return { errors: uniq(errors).slice(0, 8), warnings: uniq(warnings).slice(0, 4) };
}

interface PassResult {
  frames: number;
  lines: string[];
}

/** 跑一段 ffmpeg 解码，-progress 里取真实解出来的帧数 */
function decodePass(bin: string, file: string, extra: string[], seconds: number): Promise<PassResult> {
  return new Promise((done) => {
    let settled = false;
    const finish = (r: PassResult) => {
      if (!settled) {
        settled = true;
        done(r);
      }
    };
    try {
      execFile(
        bin,
        [
          '-hide_banner', '-v', 'error', '-nostdin',
          ...extra,
          '-i', file,
          '-t', String(seconds),
          '-f', 'null',
          '-progress', 'pipe:1', '-nostats',
          '-',
        ],
        { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
        (_err, stdout, stderr) => {
          const so = String(stdout || '');
          const frames = Number((so.match(/frame=(\d+)/g) || []).map((s) => Number(s.slice(6))).pop() || 0);
          finish({
            frames,
            lines: String(stderr || '').split('\n').map((s) => s.trim()).filter(Boolean),
          });
        },
      ).on('error', () => finish({ frames: 0, lines: [] }));
    } catch {
      finish({ frames: 0, lines: [] });
    }
  });
}

/**
 * 让 ffmpeg 真的解码：开头 N 秒 + 末尾 N 秒。
 * 只看文件头判断不了损坏（mp4 的 moov 完整而 mdat 被截断时，ffprobe 照样报得出编码和时长），
 * 必须真解码；末尾那段专门用来抓「没下载完整」。
 */
export async function checkMedia(file: string, seconds = 15): Promise<MediaCheck | null> {
  const bin = await ffmpegPath();
  if (!bin) return null;

  const head = await decodePass(bin, file, [], seconds);
  const tail = await decodePass(bin, file, ['-sseof', `-${seconds}`], seconds);

  const { errors, warnings } = classifyFfmpegLog([...head.lines, ...tail.lines]);
  const frames = head.frames + tail.frames;
  return { decodable: frames > 0 && errors.length === 0, frames, seconds, errors, warnings };
}

/* ---------------- 抽帧 ---------------- */

function runFfmpeg(bin: string, args: string[], timeout: number): Promise<boolean> {
  return new Promise((done) => {
    let settled = false;
    const finish = (v: boolean) => {
      if (!settled) {
        settled = true;
        done(v);
      }
    };
    try {
      const child = execFile(bin, args, { timeout, killSignal: 'SIGKILL' }, (err) => finish(!err));
      child.on('error', () => finish(false));
    } catch {
      finish(false);
    }
  });
}

/** 用 ffprobe 读时长（没有 ffprobe 就返回 0） */
async function durationOf(ffmpegBin: string, file: string): Promise<number> {
  const dir = dirname(ffmpegBin);
  const probeName = basename(ffmpegBin).replace(/^ffmpeg/i, 'ffprobe');
  const probe = dir && dir !== '.' ? join(dir, probeName) : probeName;
  const out = await new Promise<string>((res) => {
    try {
      execFile(
        probe,
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
        { timeout: 15_000 },
        (_err, stdout) => res(String(stdout || '')),
      ).on('error', () => res(''));
    } catch {
      res('');
    }
  });
  const d = Number.parseFloat(out.trim());
  return Number.isFinite(d) && d > 0 ? d : 0;
}

async function jpgOk(p: string): Promise<boolean> {
  try {
    const st = await stat(p);
    return st.isFile() && st.size > 1024;
  } catch {
    return false;
  }
}

async function extract(ffmpegBin: string, file: string, out: string): Promise<boolean> {
  const dur = await durationOf(ffmpegBin, file);
  // 有时长就跳片头（约 15%，且不超过 15 分钟），没有就依次退到 30s / 5s / 第一帧
  const seeks = dur > 2
    ? [Math.min(Math.max(dur * 0.15, 1), 900).toFixed(2), '0']
    : ['30', '5', '0'];

  for (const ss of seeks) {
    await rm(out, { force: true }).catch(() => undefined);
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-ss', ss,
      '-i', file,
      '-frames:v', '1', '-an', '-sn',
      '-vf', 'scale=480:-2',
      '-q:v', '5',
      '-f', 'image2', '-y', out,
    ];
    await runFfmpeg(ffmpegBin, args, FFMPEG_TIMEOUT);
    if (await jpgOk(out)) return true;
  }
  return false;
}

/**
 * 取（必要时生成）某个视频的封面 JPEG 路径；失败返回 null。
 * @param filePath 视频绝对路径
 * @param mtimeMs  文件修改时间（参与缓存键，文件换了就重新抽）
 */
export async function coverFile(filePath: string, mtimeMs: number, force = false): Promise<string | null> {
  const key = createHash('sha1').update(`${filePath}|${Math.floor(mtimeMs)}`).digest('hex');
  const out = join(COVER_DIR, `${key}.jpg`);
  const miss = join(COVER_DIR, `${key}.none`);

  await mkdir(COVER_DIR, { recursive: true }).catch(() => undefined);
  if (!force) {
    if (exist(out)) return out;
    if (exist(miss)) return null; // 抽过且失败，不再反复折腾 NAS
  }

  const bin = await ffmpegPath();
  if (!bin) return null; // 没装 ffmpeg：不写 miss，装上后立即可用

  await acquire();
  try {
    const ok = await extract(bin, filePath, out);
    if (ok) {
      if (exist(miss)) await rm(miss, { force: true }).catch(() => undefined);
      return out;
    }
    await writeFile(miss, String(Date.now())).catch(() => undefined);
    return null;
  } finally {
    release();
  }
}

/** 供前端/接口展示：这台机器有没有可用的 ffmpeg */
export async function hasFfmpeg(): Promise<boolean> {
  return (await ffmpegPath()) !== null;
}

export { COVER_DIR };
