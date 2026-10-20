import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchSitePage, resetSitePageCache, resetSiteSessions } from '../src/dyrssite.js';

/**
 * 「正在检测」反爬挑战的自愈回归。
 *
 * 背景：上游（wzzycc 模板）会给页面返回一个 HTTP **429** 的挑战页，
 * 要求算出 i 使 `sha1(hash + i) === target`，再把 `attack_key=i` 加到 URL 上重放。
 * 早先只有搜索接口处理了它，首页/分类/详情/播放页都没处理 ——
 * 于是上游一挑战，整站取流就全 429（前端：「取流失败：上游返回 HTTP 429」）。
 *
 * 这里把 fetch 换成假的，验证：
 *   ① 命中挑战页时会自动解题并带 attack_key 重放，最终拿到真页面；
 *   ② 解出的 key 会被记住，后续请求（含别的路径）直接带上，不再被挑战。
 */

const BASE = 'https://fake-mirror.test';
/** 40 位 hex，符合上游挑战页的格式 */
const HASH = '0123456789abcdef0123456789abcdef01234567';
/** 答案故意选个小的，让解题循环立刻命中 */
const ANSWER = 7;
const TARGET = createHash('sha1').update(HASH + String(ANSWER)).digest('hex');

function challengePage(): string {
  // 关键特征与真实页面一致：标题「正在检测」+ 解题脚本 sha1(hash + i)
  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN"><head><title>正在检测</title></head>',
    '<body><div class="loading-text">TV仓</div>',
    '<script>',
    'function passChallenge() {',
    `  var hash = '${HASH}';`,
    `  var target = '${TARGET}';`,
    '  for (var i = 0; i < 1000000; i++) {',
    '    if (sha1(hash + i) === target) { window.location.href = window.location.href + "&attack_key=" + i; break; }',
    '  }',
    '}',
    '</script></body></html>',
  ].join('\n');
}

function realPage(title: string): string {
  // 体积必须 > 1000 才会被 pageCache 缓存，也更接近真实页面
  const filler = '<div class="group relative flex flex-col h-full">占位</div>'.repeat(40);
  return `<!DOCTYPE html><html><head><title>${title}</title></head><body>${filler}</body></html>`;
}

let calls: string[] = [];

beforeEach(() => {
  resetSiteSessions();
  resetSitePageCache();
  calls = [];
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    if (url.includes(`attack_key=${ANSWER}`)) {
      return new Response(realPage('真页面'), { status: 200, headers: { 'content-type': 'text/html' } });
    }
    return new Response(challengePage(), { status: 429, headers: { 'content-type': 'text/html' } });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('dyrs 反爬挑战自愈', () => {
  it('命中 429 挑战页时自动解题并重放，最终拿到真页面', async () => {
    const r = await fetchSitePage('/movie/0123456789abcdef01234567/1.html', BASE);
    expect(r.status).toBe(200);
    expect(r.html).toContain('真页面');
    // 第一次是被挑战，第二次才带上 attack_key
    expect(calls).toHaveLength(2);
    expect(calls[0]).not.toContain('attack_key=');
    expect(calls[1]).toContain(`attack_key=${ANSWER}`);
  });

  it('解出的 attack_key 会记住，后续请求（别的路径）直接带上，不再被挑战', async () => {
    await fetchSitePage('/movie/0123456789abcdef01234567/1.html', BASE);
    calls = [];
    const r2 = await fetchSitePage('/dianying.html', BASE);
    expect(r2.status).toBe(200);
    expect(r2.html).toContain('真页面');
    // 只打一次，且第一次就带 key —— 不需要再经历一次挑战
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`attack_key=${ANSWER}`);
  });

  it('已有查询参数的地址会正确追加 attack_key（不是拼成两个 ?）', async () => {
    await fetchSitePage('/movie/0123456789abcdef01234567/1.html?origin=x', BASE);
    expect(calls[1]).toContain('origin=x');
    expect(calls[1]).toContain(`attack_key=${ANSWER}`);
    expect(calls[1].indexOf('?')).toBe(calls[1].lastIndexOf('?'));
  });

  it('挑战页不会被写进页面缓存（否则会把「正在检测」当数据用 5 分钟）', async () => {
    // 让解题也失败：挑战页里没有 target → solveChallenge 返回 null → 原样返回 429
    resetSiteSessions();
    resetSitePageCache();
    vi.stubGlobal('fetch', async () => new Response(challengePage().replace(/var target[^\n]*\n/, ''), { status: 429 }));
    const r = await fetchSitePage('/movie/0123456789abcdef01234567/1.html', BASE);
    expect(r.status).toBe(429);
    expect(r.html).toContain('正在检测');
    // 没有缓存 → 再请求还会真的再打一次上游
    const before = r.html;
    const r2 = await fetchSitePage('/movie/0123456789abcdef01234567/1.html', BASE);
    expect(r2.html).toBe(before);
    expect(r2.status).toBe(429);
  });
});
