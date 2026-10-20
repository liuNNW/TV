#!/usr/bin/env node
/**
 * 一条命令发布更新（电脑端）：
 *
 *   npm run ship               # 构建并提交推送，自动生成提交说明
 *   npm run ship -- "修了xx"   # 构建并提交推送，用自定义说明
 *
 * 步骤：npm run build → git add -A → 有变化才 commit → push。
 * dist/ 会一并提交（NAS 上的一键更新靠它，不用装 TypeScript）。
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts }).trim();
}

function step(msg) {
  console.log(`\n==> ${msg}`);
}

try {
  // 0. 前置检查
  try {
    run('git rev-parse --is-inside-work-tree');
  } catch {
    console.error('✗ 这里还不是 git 仓库。先执行：');
    console.error('    git init');
    console.error('    git remote add origin <你的仓库地址>');
    process.exit(1);
  }
  let remote = '';
  try { remote = run('git remote get-url origin'); } catch { /* 稍后提示 */ }
  if (!remote) {
    console.error('✗ 还没配置远程仓库。先执行：git remote add origin <你的仓库地址>');
    process.exit(1);
  }

  // 1. 构建
  step('构建（tsc）');
  run('npm run build', { stdio: 'inherit' });

  // 2. 提交
  step('git add -A');
  run('git add -A');
  const hasChanges = (() => {
    try { run('git diff --cached --quiet'); return false; } catch { return true; }
  })();

  const msg = process.argv.slice(2).join(' ') ||
    `更新 ${new Date().toLocaleString('zh-CN', { hour12: false })}`;

  if (hasChanges) {
    run(`git commit -m ${JSON.stringify(msg)}`, { stdio: 'inherit' });
  } else {
    console.log('没有需要提交的改动');
  }

  // 3. 推送
  step('git push');
  try {
    run('git push');
  } catch {
    console.log('首推设置上游分支…');
    run('git push -u origin HEAD');
  }

  console.log(`\n✅ 已推送到 ${remote}`);
  console.log('   现在到 NAS 播放站「设置」页点「一键更新并重启」即可。');
} catch (e) {
  console.error(`\n✗ 发布失败：${e.stderr || e.message}`);
  process.exit(1);
}
