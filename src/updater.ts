/**
 * 一键更新：NAS 上从远程 git 仓库拉取最新版本并自动重启。
 *
 * 流程（POST /api/update/run）：
 *   git fetch origin
 *   → git reset --hard origin/<branch>   （覆盖所有被跟踪的代码文件）
 *   → npm install --omit=dev             （便携 node 自带的 npm，只装运行依赖）
 *   → 自愈重启：派生独立进程等待后 kill 当前进程，再拉起新的 server.js
 *
 * 安全边界：
 *   - 只动 APP_DIR（app 代码目录），data/ videos/ node_modules run.log 都不在 git
 *     跟踪范围里（仓库 .gitignore 已排除），覆盖更新不会碰用户数据
 *   - 可设环境变量 UPDATE_TOKEN，设置后所有更新接口必须带 ?token= 或 x-update-token
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { appendFile, readFile, writeFile, rename, chmod, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.js';

const _here = dirname(fileURLToPath(import.meta.url));
/** 代码根目录：编译态是 dist 的上一级（NAS 上即 nas-pack/app），tsx 源码态是项目根 */
export const APP_DIR = resolve(_here, '..');
/** NAS 运行包根目录（nas-pack），本地开发时是 APP_DIR 的上一级 */
export const NAS_ROOT = dirname(APP_DIR);

const CONFIG_FILE = join(DATA_DIR, 'update-config.json');
const STATE_FILE = join(DATA_DIR, 'update-state.json');
const PID_FILE = join(APP_DIR, 'movie-player.pid');
const RUN_LOG = join(NAS_ROOT, 'run.log');

/** 单步命令超时：npm install 在 NAS 上可能很慢，单独放宽 */
const GIT_TIMEOUT = 120_000;
const NPM_TIMEOUT = 600_000;

/** npm 缓存放项目内：默认 ~/.npm 一旦被 root 属主占用（errno -13）整个更新就卡死 */
const NPM_CACHE_DIR = join(APP_DIR, '.npm-cache');

/**
 * 依赖清单指纹：package.json + package-lock.json 的内容哈希。
 * 两者都没变 → node_modules 不用重装，直接跳过 npm install。
 * 绝大多数版本更新只改代码，这一步能把「更新被 npm 卡死」的概率降到接近零。
 */
async function depSnapshot(): Promise<string> {
  const hash = createHash('sha1');
  for (const f of ['package.json', 'package-lock.json']) {
    try {
      hash.update(f);
      hash.update(await readFile(join(APP_DIR, f)));
    } catch {
      // 文件不存在也是一种状态（比如换成了别的锁文件），照常参与对比
    }
  }
  return hash.digest('hex');
}

/**
 * 运行依赖健康检查：逐个 require.resolve package.json 的 dependencies。
 * 自动重启后服务是从磁盘重新加载这些模块的 —— node_modules 若被之前中断的
 * 安装弄坏（哪怕依赖清单没变），也必须重装一次，否则「跳过安装 + 自动重启」
 * 会把服务带崩（表现为重启后网站直接打不开）。
 */
async function depsHealthy(): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(join(APP_DIR, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const req = createRequire(join(APP_DIR, 'package.json'));
    for (const name of Object.keys(pkg.dependencies ?? {})) req.resolve(name);
    return true;
  } catch {
    return false;
  }
}

/* ---------------- 配置 ---------------- */

export interface UpdateConfig {
  /** 仓库地址（https 或 ssh），不含 Token */
  repoUrl: string;
  /** 分支名，默认 main */
  branch: string;
  /** GitHub/GitLab 私有仓库访问令牌；只存 data/update-config.json，不回显给前端 */
  token: string;
}

/** 给前端看的配置（绝不包含 Token 明文） */
export interface PublicUpdateConfig {
  repoUrl: string;
  branch: string;
  hasToken: boolean;
}

export async function readConfig(): Promise<UpdateConfig> {
  try {
    const raw = JSON.parse(await readFile(CONFIG_FILE, 'utf8')) as Partial<UpdateConfig>;
    return {
      repoUrl: String(raw.repoUrl ?? '').trim(),
      branch: String(raw.branch ?? '').trim() || 'main',
      token: String(raw.token ?? '').trim(),
    };
  } catch {
    return { repoUrl: '', branch: 'main', token: '' };
  }
}

/** 去掉 URL 里的账号密码，用于展示 / 日志 */
export function maskRepoUrl(raw: string): string {
  return String(raw ?? '').trim().replace(/^(https?:\/\/)[^/@]+@/i, '$1***@');
}

export function publicConfig(cfg: UpdateConfig): PublicUpdateConfig {
  return { repoUrl: maskRepoUrl(cfg.repoUrl), branch: cfg.branch, hasToken: Boolean(cfg.token) };
}

/**
 * 把 Token 注入 HTTPS 仓库地址：
 *   https://github.com/u/r.git
 *   → https://x-access-token:<token>@github.com/u/r.git
 *
 * 已有账号密码、或非 HTTPS（SSH / file）的地址原样返回。
 */
export function buildAuthUrl(repoUrl: string, token: string): string {
  const url = String(repoUrl ?? '').trim();
  const t = String(token ?? '').trim();
  if (!url || !t || !/^https:\/\//i.test(url)) return url;
  if (/^https:\/\/[^/]*@/i.test(url)) return url;
  return url.replace(/^https:\/\//i, `https://x-access-token:${encodeURIComponent(t)}@`);
}

async function writeConfig(cfg: UpdateConfig): Promise<void> {
  await mkdir(dirname(CONFIG_FILE), { recursive: true });
  const tmp = `${CONFIG_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  try {
    await rename(tmp, CONFIG_FILE);
  } catch {
    try { await chmod(CONFIG_FILE, 0o666); await rename(tmp, CONFIG_FILE); } catch { /* 尽力而为 */ }
  }
}

/**
 * 只保存仓库配置（不触发绑定/拉取）。
 * token 传 undefined 表示保留原值，传空字符串表示清除。
 */
export async function saveConfig(repoUrl: string, branch: string, token?: string): Promise<void> {
  const v = validateRepoUrl(repoUrl);
  if (!v.ok) throw new Error(v.reason);
  const prev = await readConfig();
  const nextToken = token === undefined ? prev.token : String(token).trim();
  await writeConfig({
    repoUrl: repoUrl.trim(),
    branch: (branch || '').trim() || 'main',
    token: nextToken,
  });
}

/** 仓库地址合法性（不碰网络，纯校验）。file:// 仅用于本机测试 / 离线场景 */
export function validateRepoUrl(raw: string): { ok: true } | { ok: false; reason: string } {
  const url = String(raw ?? '').trim();
  if (!url) return { ok: false, reason: '请填写仓库地址' };
  if (url.includes('..')) return { ok: false, reason: '仓库地址不合法' };
  const ok = /^https?:\/\/\S+$/i.test(url) || /^git@[\w.-]+:\S+$/.test(url)
    || /^ssh:\/\/\S+$/i.test(url) || /^file:\/\/\S+$/i.test(url);
  if (!ok) return { ok: false, reason: '支持 https:// 或 git@ 形式的仓库地址' };
  return { ok: true };
}

/* ---------------- 执行器 ---------------- */

interface ExecResult { code: number; output: string }

function exec(cmd: string, args: string[], opts: { cwd: string; timeout: number }): Promise<ExecResult> {
  return new Promise((res) => {
    execFile(
      cmd, args,
      {
        cwd: opts.cwd,
        timeout: opts.timeout,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
        // 私有仓库没凭证时直接失败并返回错误，绝不卡在交互式账号密码提示上
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (err, stdout, stderr) => {
        // git 往 stderr 写正常输出（progress / 提示），所以两个都收
        res({ code: err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : (err ? 1 : 0), output: `${stdout}${stderr}`.trim() });
      },
    );
  });
}

/** 找到 npm-cli.js（便携 node 的 npm 位置各平台不同），找不到回退 npm 命令 */
export function findNpmCli(): { file: string; args: string[] } {
  const binDir = dirname(process.execPath);
  const candidates = [
    join(binDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), // Windows 安装版
    join(binDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), // Linux 便携包
    join(binDir, '..', 'lib64', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return { file: process.execPath, args: [c] };
  }
  return { file: 'npm', args: [] };
}

/* ---------------- 任务状态（单例：同一时间只允许一个更新任务） ---------------- */

export interface UpdateJob {
  running: boolean;
  step: string;
  log: string[];
  error: string | null;
  restarting: boolean;
  startedAt: number | null;
  finishedAt: number | null;
}

const job: UpdateJob = {
  running: false, step: '', log: [], error: null, restarting: false,
  startedAt: null, finishedAt: null,
};

export function jobStatus(): Readonly<UpdateJob> {
  return job;
}

function log(line: string): void {
  job.log.push(line);
  if (job.log.length > 300) job.log.splice(0, job.log.length - 300);
  console.log(`[update] ${line}`);
}

/* ---------------- git 工具 ---------------- */

async function gitInRepo(args: string[]): Promise<ExecResult> {
  return exec('git', args, { cwd: APP_DIR, timeout: GIT_TIMEOUT });
}

/** 当前 origin 地址（没有则返回空串） */
async function originUrl(): Promise<string> {
  const r = await gitInRepo(['remote', 'get-url', 'origin']);
  return r.code === 0 ? r.output.trim() : '';
}

/**
 * 拉取时临时把 Token 注入 origin，拉完立刻恢复干净地址。
 * 这样 Token 不会长期留在 .git/config 里，也不会写进仓库配置的 repoUrl。
 */
async function withOriginAuth<T>(cfg: UpdateConfig, fn: () => Promise<T>): Promise<T> {
  if (!cfg.token) return fn();
  const clean = await originUrl();
  if (!clean) return fn();
  const auth = buildAuthUrl(clean, cfg.token);
  if (auth === clean) return fn();

  await gitInRepo(['remote', 'set-url', 'origin', auth]);
  try {
    return await fn();
  } finally {
    await gitInRepo(['remote', 'set-url', 'origin', clean]).catch(() => undefined);
  }
}

async function fetchOrigin(cfg: UpdateConfig): Promise<ExecResult> {
  return withOriginAuth(cfg, () => gitInRepo(['fetch', 'origin', cfg.branch]));
}

/** 把 git 的原始报错翻译成用户能行动的提示 */
function gitError(prefix: string, output: string): string {
  const text = String(output ?? '');
  if (/401|403|Authentication failed|Permission denied|could not read Username|terminal prompts disabled/i.test(text)) {
    return `${prefix}：私有仓库鉴权失败。请在设置页填写有效 Token，或改用 SSH 地址（git@github.com:…）`;
  }
  if (/could not resolve host|Could not resolve|Connection timed out|unable to access/i.test(text)) {
    return `${prefix}：无法连接仓库。检查服务器网络、仓库地址是否正确\n${text}`;
  }
  return `${prefix}：\n${text}`;
}

/** 解析 `git log --pretty=format:%h%x09%s` 的输出 */
export function parseCommitLog(raw: string): { hash: string; subject: string }[] {
  return String(raw ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf('\t');
      return i >= 0
        ? { hash: line.slice(0, i), subject: line.slice(i + 1) }
        : { hash: '', subject: line };
    });
}

/** 当前进程的运行环境（设置页展示用） */
export function runtimeInfo(): {
  pm2: boolean;
  pmId: string | null;
  appName: string;
  pid: number;
  node: string;
  cwd: string;
} {
  return {
    pm2: process.env.pm_id !== undefined,
    pmId: process.env.pm_id ?? null,
    appName: process.env.PM2_APP_NAME || 'movie-player',
    pid: process.pid,
    node: process.version,
    cwd: APP_DIR,
  };
}

async function isGitRepo(): Promise<boolean> {
  const r = await gitInRepo(['rev-parse', '--is-inside-work-tree']);
  return r.code === 0 && r.output.includes('true');
}

async function gitAvailable(): Promise<string | null> {
  const r = await exec('git', ['--version'], { cwd: APP_DIR, timeout: 10_000 });
  return r.code === 0 ? null : 'NAS 上没有 git 命令。fnOS 可 SSH 执行 sudo apt install git 安装后重试';
}

async function headInfo(): Promise<{ commit: string; subject: string }> {
  const r = await gitInRepo(['log', '-1', '--pretty=format:%h %s']);
  return r.code === 0
    ? { commit: r.output.split(' ')[0] || '', subject: r.output }
    : { commit: '', subject: '' };
}

/* ---------------- 绑定仓库（首次） ---------------- */

export async function bindRepo(repoUrl: string, branch: string, token?: string): Promise<void> {
  if (job.running) throw new Error('已有更新任务在进行中');
  const v = validateRepoUrl(repoUrl);
  if (!v.ok) throw new Error(v.reason);
  const prev = await readConfig();
  const cfg: UpdateConfig = {
    repoUrl: repoUrl.trim(),
    branch: (branch || '').trim() || 'main',
    token: token === undefined ? prev.token : String(token).trim(),
  };

  job.running = true; job.error = null; job.restarting = false;
  job.log = []; job.startedAt = Date.now(); job.finishedAt = null;
  try {
    job.step = '检查 git';
    const noGit = await gitAvailable();
    if (noGit) throw new Error(noGit);

    if (await isGitRepo()) {
      log('当前目录已是 git 仓库，更新远程地址');
      job.step = '更新远程地址';
      await gitInRepo(['remote', 'remove', 'origin']).catch(() => undefined);
      const add = await gitInRepo(['remote', 'add', 'origin', cfg.repoUrl]);
      if (add.code !== 0) throw new Error(`设置远程仓库失败：\n${add.output}`);
    } else {
      log(`在 ${APP_DIR} 初始化 git 仓库`);
      job.step = '初始化仓库';
      const init = await gitInRepo(['init']);
      if (init.code !== 0) throw new Error(`git init 失败：\n${init.output}`);
      const add = await gitInRepo(['remote', 'add', 'origin', cfg.repoUrl]);
      if (add.code !== 0) throw new Error(`设置远程仓库失败：\n${add.output}`);
    }

    job.step = '拉取仓库';
    log(`git fetch origin（分支 ${cfg.branch}，第一次可能较慢）`);
    const fetch = await fetchOrigin(cfg);
    if (fetch.code !== 0) {
      throw new Error(gitError('拉取仓库失败', fetch.output));
    }

    job.step = '覆盖更新文件';
    log(`git reset --hard origin/${cfg.branch}（data/ videos/ node_modules 不受影响）`);
    const reset = await gitInRepo(['reset', '--hard', `origin/${cfg.branch}`]);
    if (reset.code !== 0) throw new Error(`覆盖更新失败：\n${reset.output}`);

    await writeState();
    log('✅ 绑定完成，当前已是仓库最新版本');
  } catch (e) {
    job.error = e instanceof Error ? e.message : String(e);
    log(`✗ 失败：${job.error}`);
    throw e;
  } finally {
    job.running = false;
    job.step = '';
    job.finishedAt = Date.now();
    await writeConfig(cfg).catch(() => undefined);
  }
}

/* ---------------- 检查更新 ---------------- */

export interface CheckResult {
  bound: boolean;
  behind: number;
  ahead: number;
  local: string;
  remote: string;
  remoteMsg: string;
  commits: { hash: string; subject: string }[];
}

function emptyCheck(): CheckResult {
  return { bound: false, behind: 0, ahead: 0, local: '', remote: '', remoteMsg: '', commits: [] };
}

export async function checkUpdate(): Promise<CheckResult> {
  const cfg = await readConfig();
  if (!cfg.repoUrl) return emptyCheck();
  const noGit = await gitAvailable();
  if (noGit) throw new Error(noGit);
  if (!(await isGitRepo())) return emptyCheck();

  const fetch = await fetchOrigin(cfg);
  if (fetch.code !== 0) throw new Error(gitError('拉取仓库信息失败', fetch.output));

  const [behind, ahead, local, remote, commits] = await Promise.all([
    gitInRepo(['rev-list', '--count', `HEAD..origin/${cfg.branch}`]),
    gitInRepo(['rev-list', '--count', `origin/${cfg.branch}..HEAD`]),
    headInfo(),
    gitInRepo(['log', '-1', '--pretty=format:%h %s', `origin/${cfg.branch}`]),
    gitInRepo(['log', '--pretty=format:%h%x09%s', '-n', '20', `HEAD..origin/${cfg.branch}`]),
  ]);
  return {
    bound: true,
    behind: Number(behind.output) || 0,
    ahead: Number(ahead.output) || 0,
    local: local.subject,
    remote: remote.output.split(' ').slice(0, 1).join(''),
    remoteMsg: remote.output,
    commits: parseCommitLog(commits.output),
  };
}

/* ---------------- 一键更新 ---------------- */

async function writeState(): Promise<void> {
  const info = await headInfo();
  await mkdir(DATA_DIR, { recursive: true }).catch(() => undefined);
  await writeFile(STATE_FILE, JSON.stringify({ ...info, at: Date.now() }, null, 2), 'utf8').catch(() => undefined);
}

export async function readState(): Promise<{ commit: string; subject: string; at: number }> {
  try {
    const s = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    return { commit: String(s.commit ?? ''), subject: String(s.subject ?? ''), at: Number(s.at ?? 0) };
  } catch {
    return { commit: '', subject: '', at: 0 };
  }
}

export async function runUpdate(): Promise<void> {
  if (job.running) throw new Error('已有更新任务在进行中，请稍后');
  const cfg = await readConfig();
  if (!cfg.repoUrl) throw new Error('还没有绑定仓库，先在上方填写仓库地址并绑定');
  const noGit = await gitAvailable();
  if (noGit) throw new Error(noGit);

  job.running = true; job.error = null; job.restarting = false;
  job.log = []; job.startedAt = Date.now(); job.finishedAt = null;

  try {
    if (!(await isGitRepo())) {
      log('还没绑定仓库，先自动完成绑定…');
      // bindRepo 会重置 job 状态，这里先放行标志位再调用
      job.running = false;
      await bindRepo(cfg.repoUrl, cfg.branch, cfg.token);
      job.running = true;
    }

    job.step = '拉取最新版本';
    log(`git fetch origin ${cfg.branch}`);
    const fetch = await fetchOrigin(cfg);
    if (fetch.code !== 0) throw new Error(gitError('git fetch 失败', fetch.output));

    job.step = '覆盖更新文件';
    const depsBefore = await depSnapshot();
    const reset = await gitInRepo(['reset', '--hard', `origin/${cfg.branch}`]);
    if (reset.code !== 0) throw new Error(`git reset 失败：\n${reset.output}`);
    log(reset.output || '已是最新代码');
    const depsAfter = await depSnapshot();

    // 清单没变也不代表能跳过：node_modules 可能已被之前中断的安装弄坏，
    // 这时跳过 + 重启会把服务带崩，必须借这次更新把它修好。
    if (depsBefore === depsAfter && (await depsHealthy())) {
      log('依赖清单（package.json / package-lock.json）没有变化，跳过 npm install');
    } else {
      job.step = '安装依赖（npm install，可能要几分钟）';
      const npm = findNpmCli();
      // 缓存放项目内：默认 ~/.npm 一旦被 root 属主占用就会 EACCES（errno -13），
      // 用户还得 sudo chown 才能继续，这里直接绕开
      await mkdir(NPM_CACHE_DIR, { recursive: true }).catch(() => undefined);
      // 注意：项目根 .npmrc 里写了 dry-run=true（为了兼容 NAS 上仍在跑的旧版 updater），
      // 所以这里必须显式 --no-dry-run 覆盖回来，否则依赖只会“空转”不落盘。
      const installArgs = [
        ...npm.args,
        'install',
        '--omit=dev',
        '--no-audit',
        '--no-fund',
        '--no-dry-run',
        `--cache=${NPM_CACHE_DIR}`,
      ];
      let inst = await exec(npm.file, installArgs, { cwd: APP_DIR, timeout: NPM_TIMEOUT });
      if (inst.code !== 0) {
        // NAS 常见：上一次中断的安装残留了 node_modules/.<pkg>-<hash> 临时目录，
        // 再装时会 rename 到同名目录而报 ENOTEMPTY（errno -39）。直接清掉 node_modules 重装一次自愈。
        log('首次安装依赖失败，清理 node_modules 后重试一次…');
        log(inst.output.split('\n').slice(-6).join('\n'));
        await rm(join(APP_DIR, 'node_modules'), { recursive: true, force: true }).catch(() => undefined);
        inst = await exec(npm.file, installArgs, { cwd: APP_DIR, timeout: NPM_TIMEOUT });
      }
      if (inst.code !== 0) throw new Error(`npm install 失败：\n${inst.output.slice(-2000)}`);
      log(inst.output.split('\n').slice(-3).join('\n'));
    }

    await writeState();
    log('✅ 更新完成，服务即将自动重启，页面会自动刷新');
  } catch (e) {
    job.error = e instanceof Error ? e.message : String(e);
    log(`✗ 失败：${job.error}`);
    throw e;
  } finally {
    job.running = false;
    job.step = '';
    job.finishedAt = Date.now();
  }
}

/* ---------------- 自愈重启 ---------------- */

/**
 * 派生一个独立进程：等当前响应发完 → kill 当前进程 → 用同样的入口/环境拉起新进程。
 * 不依赖 start.sh（systemd / nohup / 手跑都适用），run.log 存在时继续追加写。
 * 调用方需保证 HTTP 响应已经发出。
 */
export function scheduleRestart(): void {
  if (job.restarting) return;
  job.restarting = true;

  // PM2 托管：自己退出，由 PM2 按 autorestart 重新拉起。
  // 绝不能再 spawn 第二个 node —— 那样会和 PM2 抢 8848 端口（EADDRINUSE）。
  if (process.env.pm_id !== undefined) {
    console.log('[update] PM2 托管模式：进程即将退出，由 PM2 重新拉起');
    setTimeout(() => process.exit(0), 800);
    return;
  }

  const args = JSON.stringify({
    ppid: process.pid,
    entry: process.argv[1] || join(APP_DIR, 'dist', 'server.js'),
    cwd: process.cwd(),
    pidFile: existsSync(PID_FILE) ? PID_FILE : '',
    logFile: existsSync(RUN_LOG) ? RUN_LOG : '',
  });

  const helper = `
    const { spawn } = require('child_process');
    const fs = require('fs');
    const a = ${args};
    setTimeout(() => {
      try { process.kill(a.ppid); } catch (e) {}
      setTimeout(() => {
        // run.log 若因属主/权限问题打不开，绝不能让重启进程直接崩掉（否则服务就没了）
        let out = 'ignore';
        if (a.logFile) { try { out = fs.openSync(a.logFile, 'a'); } catch (e) { out = 'ignore'; } }
        const c = spawn(process.execPath, [a.entry], {
          cwd: a.cwd, detached: true, stdio: ['ignore', out, out], env: process.env,
        });
        c.unref();
        try { if (a.pidFile) fs.writeFileSync(a.pidFile, String(c.pid)); } catch (e) {}
        process.exit(0);
      }, 1500);
    }, 800);
  `;

  const child = spawn(process.execPath, ['-e', helper], {
    detached: true, stdio: 'ignore', env: process.env, windowsHide: true,
  });
  child.unref();
  console.log('[update] 已安排自愈重启');
}

/** 把本次更新动作记进 run.log，方便 SSH 排查 */
export function auditLog(msg: string): void {
  if (existsSync(RUN_LOG)) {
    appendFile(RUN_LOG, `[${new Date().toISOString()}] [update] ${msg}\n`).catch(() => undefined);
  }
}
