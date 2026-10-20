/**
 * 浏览器解不了的本地视频（H.265 的 MP4 / HEVC 的 TS / AC3 音轨 / AVI / RMVB…）
 * 实时转码成 H.264 + AAC 的 HLS，前端用 hls.js 播 —— 和影视站在线播放同一套引擎。
 *
 * 为什么必须服务端转码：
 *   网页能播什么完全由浏览器决定，而浏览器的安全沙箱 + 解码器只认 H.264 + AAC/MP3 这一小撮组合。
 *   飞牛影视这类原生 App 之所以“什么都能播”，是因为它在 NAS 上转码（还常用 QSV/VAAPI 硬编），
 *   我们做的正是同一件事，只不过输出给网页而不是自家播放器。
 *
 * 资源控制：
 *   - 同一个文件只起一个转码进程（按「路径+mtime+目标高度」做键）；
 *   - 转完的任务目录保留可复播；空闲超过 IDLE_MS 的整目录清理；
 *   - 最多同时 2 个转码进程；转码卡死（120 秒没有新分片）自动判失败；
 *   - 硬件编码器起不来时自动回退到 CPU 软编。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';
import { ffmpegPath, pickHardwareEncoder } from './covers.js';

const TRANS_DIR = join(DATA_DIR, 'transcode');
/** 任务空闲多久后杀进程并清理目录 */
const IDLE_MS = 10 * 60_000;
const MAX_CONCURRENT = 2;
/** 单个转码段时长（秒） */
const SEGMENT_SEC = 4;
/** 假定的输出帧率：用来算关键帧间隔（GOP）。转码输出统一按 30fps 走，
 *  真实源若是 24/25fps，最多也就是关键帧密一点，不会出问题。 */
const FPS = 30;
/** 多久没有产出新分片就认为卡死（毫秒） */
const STALL_MS = 120_000;

export type TransState = 'starting' | 'running' | 'done' | 'failed' | 'stalled' | 'unknown';

export interface TransResult {
  state: TransState;
  seconds: number;
  encoder?: string;
  error?: string;
  /** 服务端已经转了多久（秒），用来判断“到底有没有在动” */
  elapsed?: number;
}

function exist(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir) as string[];
  } catch {
    return [];
  }
}

function rmSafe(p: string): void {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function keyFor(file: string, mtimeMs: number, height: number): string {
  return createHash('sha1').update(`${file}|${Math.floor(mtimeMs)}|h${height}`).digest('hex').slice(0, 20);
}

/* ---------------- 并发闸门 ---------------- */

let running = 0;
const waiters: Array<() => void> = [];

function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running += 1;
    return Promise.resolve();
  }
  return new Promise((res) =>
    waiters.push(() => {
      running += 1;
      res();
    }),
  );
}

function release(): void {
  running = Math.max(0, running - 1);
  const next = waiters.shift();
  if (next) next();
}

/* ---------------- 编码档位（硬件优先，软编兜底） ---------------- */

interface EncodeProfile {
  encoder: string;
  /** 放在 -i 之前 */
  beforeInput: string[];
  /** 输出参数 */
  args: string[];
  /** 滤镜链 */
  vf: string;
}

/**
 * 试过但起不来的编码器。硬件编码器探测得到 ≠ 真能用（驱动缺失、没有对应 GPU 都很常见），
 * 一旦发现它连一个分片都产不出来，就记下来，后面的文件直接跳过它，不用每个文件都白等一次。
 */
const BAD_ENCODERS = new Set<string>();

/** 某个编码器起不来：拉黑它（libx264 是最后的兜底，永远不拉黑） */
function markEncoderBroken(name: string): void {
  if (name && name !== 'libx264') BAD_ENCODERS.add(name);
}

/** 诊断用：已被拉黑的编码器 */
export function brokenEncoders(): string[] {
  return [...BAD_ENCODERS];
}

/** 生成候选档位：硬件编码器在前，libx264 永远排最后兜底 */
async function buildProfiles(height: number): Promise<EncodeProfile[]> {
  const scale = `scale=-2:'min(${height},ih)'`;
  const list: EncodeProfile[] = [];
  let hw = await pickHardwareEncoder();
  if (hw && BAD_ENCODERS.has(hw)) hw = null;
  if (hw === 'h264_qsv') {
    list.push({
      encoder: hw,
      beforeInput: ['-init_hw_device', 'qsv=hw', '-filter_hw_device', 'hw'],
      args: ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '24'],
      vf: scale,
    });
  } else if (hw === 'h264_nvenc') {
    list.push({
      encoder: hw,
      beforeInput: [],
      args: ['-c:v', 'h264_nvenc', '-cq', '24', '-b:v', '0'],
      vf: scale,
    });
  } else if (hw === 'h264_vaapi') {
    const dev = (process.env.VAAPI_DEVICE || '').trim() || '/dev/dri/renderD128';
    list.push({
      encoder: hw,
      beforeInput: ['-vaapi_device', dev],
      args: ['-c:v', 'h264_vaapi', '-qp', '24'],
      vf: `format=nv12,hwupload,scale_vaapi=w=-2:h='min(${height},ih)'`,
    });
  } else if (hw === 'h264_v4l2m2m') {
    list.push({ encoder: hw, beforeInput: [], args: ['-c:v', 'h264_v4l2m2m', '-b:v', '4000k'], vf: scale });
  } else if (hw === 'h264_videotoolbox') {
    list.push({
      encoder: hw,
      beforeInput: [],
      args: ['-c:v', 'h264_videotoolbox', '-b:v', '4500k', '-allow_sw', '1'],
      vf: scale,
    });
  } else if (hw === 'h264_amf') {
    list.push({ encoder: hw, beforeInput: [], args: ['-c:v', 'h264_amf', '-quality', 'speed', '-b:v', '4500k'], vf: scale });
  } else if (hw && hw !== 'libx264') {
    list.push({ encoder: hw, beforeInput: [], args: ['-c:v', hw], vf: scale });
  }

  // CPU 软编：veryfast + crf23 是「能看」和「跑得动」的平衡点
  list.push({
    encoder: 'libx264',
    beforeInput: [],
    args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-tune', 'fastdecode'],
    vf: scale,
  });
  return list;
}

/** 拼一条完整的 ffmpeg HLS 转码命令 */
function buildArgs(profile: EncodeProfile, file: string, dir: string, m3u8: string): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    // 让 ffmpeg 提前读一点输入再开工，机械盘/网络盘上能少一次「转一下就卡住」
    '-fflags', '+genpts+igndts',
    '-analyzeduration', '10M',
    '-probesize', '10M',
    ...profile.beforeInput,
    '-i', file,
    // 只取第一条视频 + 第一条音频。多音轨、内封字幕（PGS/ASS）装不进 MPEG-TS，
    // 不加这两个限制，很多电影 MKV 会让 ffmpeg 直接报错退出 —— 表现就是「一直转却没画面」。
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-sn', '-dn',
    ...profile.args,
    '-vf', profile.vf,
    // 强制关键帧间隔 = 分片时长：每片都以 IDR 开头，hls.js 切段/拖进度条才不会花屏或重新起播
    '-g', String(SEGMENT_SEC * FPS),
    '-keyint_min', String(SEGMENT_SEC * FPS),
    '-sc_threshold', '0',
    '-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SEC})`,
    // 交给 ffmpeg 自己做音频重采样，避免音画不同步导致的「一顿一顿」
    '-af', 'aresample=async=1:first_pts=0',
    '-c:a', 'aac', '-ac', '2', '-b:a', '128k', '-ar', '48000',
    '-f', 'hls',
    '-hls_time', String(SEGMENT_SEC),
    '-hls_list_size', '0',
    '-hls_playlist_type', 'vod',
    '-hls_flags', 'independent_segments',
    '-hls_segment_filename', join(dir, 'seg%05d.ts'),
    '-max_muxing_queue_size', '2048',
    '-y', m3u8,
  ];
}

/* ---------------- 转码任务 ---------------- */

class TransJob {
  key: string;
  dir: string;
  file: string;
  bin: string;
  m3u8: string;
  profiles: EncodeProfile[];
  proc: ChildProcess | null = null;
  exitCode: number | null = null;
  lastUsed = Date.now();
  startedAt = Date.now();
  lastGrow = Date.now();
  lastSize = 0;
  error?: string;
  tried: string[] = [];
  encoder = '';
  stalled = false;
  /** 被回收器主动杀掉的，不要再触发重试 */
  stopped = false;

  constructor(key: string, dir: string, file: string, bin: string, profiles: EncodeProfile[]) {
    this.key = key;
    this.dir = dir;
    this.file = file;
    this.bin = bin;
    this.m3u8 = join(dir, 'index.m3u8');
    this.profiles = profiles;
  }

  /** 用指定档位起一个进程 */
  start(profile: EncodeProfile): void {
    const proc = spawn(this.bin, buildArgs(profile, this.file, this.dir, this.m3u8), {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    proc.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + String(d)).slice(-4000);
    });

    this.proc = proc;
    this.encoder = profile.encoder;
    this.tried.push(profile.encoder);
    this.lastGrow = Date.now();
    this.lastSize = 0;
    this.stalled = false;

    proc.on('exit', (code) => {
      this.proc = null;
      const ec = code === null ? 1 : code;
      const produced = exist(join(this.dir, 'seg00000.ts'));
      if (ec === 0) {
        this.exitCode = 0;
        release();
        return;
      }
      // 硬件编码器起不来（驱动/设备不可用）→ 拉黑它并换下一档重试
      if (!produced && !this.stopped) {
        markEncoderBroken(profile.encoder);
        if (this.retry()) return;
      }
      this.exitCode = ec;
      this.error = stderr.trim().split('\n').filter(Boolean).slice(-3).join(' / ') || `ffmpeg 退出码 ${ec}`;
      release();
    });
    proc.on('error', (e) => {
      this.proc = null;
      markEncoderBroken(profile.encoder);
      if (!this.stopped && this.retry()) return;
      this.exitCode = 1;
      this.error = `无法启动 ffmpeg：${e.message}`;
      release();
    });
  }

  /** 换下一个档位；已经没有可试的返回 false */
  retry(): boolean {
    const next = this.profiles.find((p) => !this.tried.includes(p.encoder));
    if (!next) return false;
    // 清掉上一档的残片，别让播放列表里混进不完整的分片
    for (const f of readdirSafe(this.dir)) {
      if (f !== 'index.m3u8') rmSafe(join(this.dir, f));
    }
    this.start(next);
    return true;
  }

  kill(): void {
    this.stopped = true;
    if (this.proc) {
      try {
        this.proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }

  /** 刷新「还在动」的时间戳 */
  touch(size: number): void {
    if (size !== this.lastSize) {
      this.lastSize = size;
      this.lastGrow = Date.now();
      this.stalled = false;
    }
  }
}

const jobs = new Map<string, TransJob>();

/* ---------------- 启动 ---------------- */

export interface StartResult {
  url: string;
  key: string;
  encoder: string;
}

/**
 * 启动（或复用）一个转码任务。
 * 返回 { url }：HLS 播放列表的站点内地址；返回 { error } 表示起不来。
 */
export async function startTranscode(
  file: string,
  mtimeMs: number,
  height = 720,
): Promise<StartResult | { error: string }> {
  const bin = await ffmpegPath();
  if (!bin) {
    return {
      error:
        'NAS 上找不到 ffmpeg，无法转码。可以打开「本地媒体 → 诊断」看探测结果；'
        + '装上 ffmpeg（sudo apt install -y ffmpeg）后刷新页面即可。',
    };
  }
  ensureReaper();

  const key = keyFor(file, mtimeMs, height);
  const dir = join(TRANS_DIR, key);
  const url = `/api/local/transcode/${key}/index.m3u8`;

  const prev = jobs.get(key);
  if (prev) {
    prev.lastUsed = Date.now();
    if (prev.exitCode !== null && prev.exitCode !== 0) {
      // 上一次失败了：清掉重来一次
      prev.kill();
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      jobs.delete(key);
    } else {
      return { url, key, encoder: prev.encoder };
    }
  }

  await mkdir(dir, { recursive: true }).catch(() => undefined);

  // 磁盘上已经有播放列表（转过的，或上次进程遗留）：直接复用，不重新转
  if (exist(join(dir, 'index.m3u8'))) {
    const cached = new TransJob(key, dir, file, bin, []);
    cached.exitCode = 0;
    cached.encoder = 'cached';
    cached.tried = ['cached'];
    jobs.set(key, cached);
    return { url, key, encoder: 'cached' };
  }

  const profiles = await buildProfiles(height);
  const job = new TransJob(key, dir, file, bin, profiles);

  await acquire();
  job.start(profiles[0]);
  jobs.set(key, job);

  return { url, key, encoder: job.encoder };
}

/**
 * 强制重来：把已有产物清掉，再用（可能是另一套）编码参数重新转。
 * 前端「🔁 重新转码」按钮用这个——比如默认选了硬件编码但驱动有问题时。
 */
export async function resetTranscode(
  file: string,
  mtimeMs: number,
  height = 720,
): Promise<StartResult | { error: string }> {
  const key = keyFor(file, mtimeMs, height);
  const dir = join(TRANS_DIR, key);
  const job = jobs.get(key);
  if (job) {
    job.kill();
    jobs.delete(key);
  }
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  return startTranscode(file, mtimeMs, height);
}

/* ---------------- 查询 ---------------- */

/** 任务目录：不管进程还在不在，只要磁盘上还有就认（服务重启后照样能播） */
function dirOf(key: string): string | null {
  const job = jobs.get(key);
  if (job) return job.dir;
  const d = join(TRANS_DIR, key);
  return exist(d) ? d : null;
}

/** 转码进度：已转出的总秒数（解析播放列表里的 EXTINF），前端拿去展示 */
export function transcodeProgress(key: string): TransResult {
  if (!/^[A-Za-z0-9_-]+$/.test(key)) return { state: 'unknown', seconds: 0 };
  const job = jobs.get(key);
  if (job) job.lastUsed = Date.now();
  const dir = dirOf(key);
  if (!dir) return { state: 'unknown', seconds: 0 };

  const m3u8 = join(dir, 'index.m3u8');
  if (!exist(m3u8)) {
    if (job?.proc) return { state: 'starting', seconds: 0, encoder: job.encoder };
    return { state: 'failed', seconds: 0, error: job?.error || '转码没有产出播放列表' };
  }

  let txt = '';
  try {
    txt = readFileSync(m3u8, 'utf8');
  } catch {
    return { state: 'running', seconds: 0, encoder: job?.encoder };
  }

  let seconds = 0;
  for (const m of txt.matchAll(/#EXTINF:([0-9.]+)/g)) seconds += Number.parseFloat(m[1]);
  const done = txt.includes('#EXT-X-ENDLIST');
  const elapsed = job ? Math.round((Date.now() - job.startedAt) / 1000) : 0;

  if (job) {
    job.touch(txt.length);
    if (job.proc && Date.now() - job.lastGrow > STALL_MS) {
      job.stalled = true;
      job.error = job.error || '转码卡住了（长时间没有新分片）';
    }
  }

  const base = { seconds, encoder: job?.encoder || 'cached', elapsed };
  if (job?.stalled) return { state: 'stalled', ...base };
  if (done) return { state: 'done', ...base };
  if (job && job.exitCode !== null && job.exitCode !== 0) {
    return { state: 'failed', ...base, error: job.error };
  }
  if (job?.proc) return { state: done ? 'done' : 'running', ...base };
  // 没有进程但播放列表没 ENDLIST：多半是重启前的残留，当作可播
  return { state: 'done', ...base };
}

/** 任务状态 */
export function transcodeStatus(key: string): TransState {
  return transcodeProgress(key).state;
}

/** 供路由读文件：返回任务目录里存在的文件绝对路径，非法名一律拒绝 */
export function transcodeFile(key: string, name: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(key)) return null;
  if (!/^[A-Za-z0-9_-]+\.(m3u8|ts)$/.test(name)) return null;
  const dir = dirOf(key);
  if (!dir) return null;
  const full = join(dir, name);
  if (!exist(full)) return null;
  let job = jobs.get(key);
  if (!job) {
    // 重新认领目录，别被回收器当垃圾清掉
    job = new TransJob(key, dir, '', '', []);
    job.exitCode = 0;
    job.encoder = 'cached';
    job.tried = ['cached'];
    jobs.set(key, job);
  }
  job.lastUsed = Date.now();
  return full;
}

/** 正在转码的任务数（诊断用） */
export function transcodeActive(): number {
  let n = 0;
  for (const j of jobs.values()) if (j.proc) n += 1;
  return n;
}

/** 诊断用：磁盘上转码目录占了多大 */
export function transcodeDiskUsage(): number {
  let total = 0;
  for (const e of readdirSafe(TRANS_DIR)) {
    const d = join(TRANS_DIR, e);
    for (const f of readdirSafe(d)) {
      try {
        const st = statSync(join(d, f));
        if (st.isFile()) total += st.size;
      } catch {
        /* ignore */
      }
    }
  }
  return total;
}

/* ---------------- 回收 ---------------- */

/** 清掉空闲太久的任务（进程 + 目录），并干掉卡死的转码 */
export async function reapTranscodes(): Promise<void> {
  const now = Date.now();
  for (const [key, job] of jobs) {
    if (job.proc && now - job.lastGrow > STALL_MS) {
      job.kill();
      job.proc = null;
      job.exitCode = 1;
      job.stalled = true;
      job.error = job.error || '转码卡住了（长时间没有新分片），已自动停止';
      release();
    }
    if (now - job.lastUsed < IDLE_MS) continue;
    job.kill();
    if (job.proc) {
      job.proc = null;
      job.exitCode = 1;
      release();
    }
    await rm(job.dir, { recursive: true, force: true }).catch(() => undefined);
    jobs.delete(key);
  }
}

// 定时回收，进程内常驻
let reaper: ReturnType<typeof setInterval> | null = null;
export function ensureReaper(): void {
  if (reaper) return;
  reaper = setInterval(() => {
    reapTranscodes().catch(() => undefined);
  }, 60_000);
  // 不阻止进程退出
  if (typeof reaper === 'object' && reaper && 'unref' in reaper) (reaper as { unref: () => void }).unref();
}

/** 诊断用：转码目录 */
export { TRANS_DIR };
