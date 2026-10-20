import { afterEach, describe, expect, it } from 'vitest';
import {
  buildAuthUrl,
  maskRepoUrl,
  parseCommitLog,
  publicConfig,
  runtimeInfo,
  validateRepoUrl,
} from '../src/updater.js';

describe('buildAuthUrl', () => {
  it('给 HTTPS 地址注入 Token', () => {
    expect(buildAuthUrl('https://github.com/me/repo.git', 'ghp_abc123')).toBe(
      'https://x-access-token:ghp_abc123@github.com/me/repo.git',
    );
  });

  it('Token 中的特殊字符会 URL 编码', () => {
    expect(buildAuthUrl('https://github.com/me/repo.git', 'a/b+c')).toBe(
      'https://x-access-token:a%2Fb%2Bc@github.com/me/repo.git',
    );
  });

  it('已有账号密码的地址不重复注入', () => {
    const url = 'https://user:pass@github.com/me/repo.git';
    expect(buildAuthUrl(url, 'token')).toBe(url);
  });

  it('SSH / file 地址原样返回', () => {
    expect(buildAuthUrl('git@github.com:me/repo.git', 'token')).toBe('git@github.com:me/repo.git');
    expect(buildAuthUrl('file:///tmp/repo', 'token')).toBe('file:///tmp/repo');
  });

  it('没有 Token 时原样返回', () => {
    expect(buildAuthUrl('https://github.com/me/repo.git', '')).toBe('https://github.com/me/repo.git');
  });
});

describe('maskRepoUrl', () => {
  it('隐藏 URL 里的账号密码', () => {
    expect(maskRepoUrl('https://user:pass@github.com/me/repo.git')).toBe(
      'https://***@github.com/me/repo.git',
    );
  });

  it('干净地址保持不变', () => {
    expect(maskRepoUrl('https://github.com/me/repo.git')).toBe('https://github.com/me/repo.git');
  });
});

describe('parseCommitLog', () => {
  it('解析 hash 与提交说明', () => {
    expect(parseCommitLog('abc123\t功能：新增 PM2\ndef456\t修复：Token 鉴权')).toEqual([
      { hash: 'abc123', subject: '功能：新增 PM2' },
      { hash: 'def456', subject: '修复：Token 鉴权' },
    ]);
  });

  it('兼容 CRLF 与空输出', () => {
    expect(parseCommitLog('abc123\t说明\r\n')).toEqual([{ hash: 'abc123', subject: '说明' }]);
    expect(parseCommitLog('')).toEqual([]);
    expect(parseCommitLog('   \n  ')).toEqual([]);
  });

  it('没有制表符时把整行当作说明', () => {
    expect(parseCommitLog('只有说明')).toEqual([{ hash: '', subject: '只有说明' }]);
  });
});

describe('publicConfig', () => {
  it('只暴露 hasToken，不返回 Token 明文', () => {
    const cfg = { repoUrl: 'https://github.com/me/repo.git', branch: 'main', token: 'secret' };
    expect(publicConfig(cfg)).toEqual({
      repoUrl: 'https://github.com/me/repo.git',
      branch: 'main',
      hasToken: true,
    });
    expect(JSON.stringify(publicConfig(cfg))).not.toContain('secret');
  });

  it('没有 Token 时 hasToken=false', () => {
    expect(publicConfig({ repoUrl: '', branch: 'main', token: '' }).hasToken).toBe(false);
  });
});

describe('validateRepoUrl', () => {
  it('接受 https / ssh / file', () => {
    expect(validateRepoUrl('https://github.com/me/repo.git').ok).toBe(true);
    expect(validateRepoUrl('git@github.com:me/repo.git').ok).toBe(true);
    expect(validateRepoUrl('ssh://git@host/me/repo.git').ok).toBe(true);
    expect(validateRepoUrl('file:///tmp/repo').ok).toBe(true);
  });

  it('拒绝空地址和 .. 路径', () => {
    expect(validateRepoUrl('').ok).toBe(false);
    expect(validateRepoUrl('https://github.com/../repo.git').ok).toBe(false);
    expect(validateRepoUrl('not-a-url').ok).toBe(false);
  });
});

describe('runtimeInfo', () => {
  const saved = { pm_id: process.env.pm_id, name: process.env.PM2_APP_NAME };

  afterEach(() => {
    if (saved.pm_id === undefined) delete process.env.pm_id;
    else process.env.pm_id = saved.pm_id;
    if (saved.name === undefined) delete process.env.PM2_APP_NAME;
    else process.env.PM2_APP_NAME = saved.name;
  });

  it('PM2 环境变量存在时标记为 pm2', () => {
    process.env.pm_id = '0';
    process.env.PM2_APP_NAME = 'movie-player';
    const rt = runtimeInfo();
    expect(rt.pm2).toBe(true);
    expect(rt.pmId).toBe('0');
    expect(rt.appName).toBe('movie-player');
  });

  it('普通 node 启动时 pm2=false', () => {
    delete process.env.pm_id;
    expect(runtimeInfo().pm2).toBe(false);
  });
});
