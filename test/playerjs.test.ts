import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * public/player.js 是浏览器脚本（顶层就摸 DOM），不能直接 import。
 * 这里把它里面的纯函数 `looksLikePlayable` 抠出来，在给定 isDyrs 的情况下跑，
 * 用来锁死一个真实踩过的坑：
 *
 *   影视仓（source=dyrs）的选集地址**一律是本站同源地址**，既可能是绝对地址
 *   （`${location.origin}/api/dyrs/src?…` 302 跳板），也可能是**相对路径**
 *   （后端 toPlaySrc 给出的 `/api/proxy?url=…` / `/api/dyrs/m3u8?…`）。
 *   早期实现先做 `^https?://` 判断、再做 isDyrs 提前返回，相对地址直接判死，
 *   结果整站影视仓点播全部弹「这个线路给的是网页分享地址」，一部都播不了。
 */
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'public', 'player.js'), 'utf8');

function extractFn(name: string): string {
  const m = source.match(new RegExp(`function ${name}\\(url\\)\\s*\\{[\\s\\S]*?\\n\\}`));
  if (!m) throw new Error(`public/player.js 里找不到函数 ${name}()`);
  return m[0];
}

/** 以指定 isDyrs 值构造一个 looksLikePlayable */
function makeLooksLikePlayable(isDyrs: boolean): (url: string) => boolean {
  // eslint-disable-next-line no-new-func
  return new Function('isDyrs', `${extractFn('looksLikePlayable')}; return looksLikePlayable;`)(
    isDyrs,
  ) as (url: string) => boolean;
}

describe('player.js looksLikePlayable', () => {
  const dyrs = makeLooksLikePlayable(true);
  const mac = makeLooksLikePlayable(false);

  it('影视仓：同源相对地址也算可播（这是整站影视仓点播的命门）', () => {
    expect(dyrs('/api/proxy?url=https%3A%2F%2Fv.lzcdn28.com%2Fx%2Findex.m3u8')).toBe(true);
    expect(dyrs('/api/dyrs/m3u8?proxy=1&origin=%E8%B6%85%E7%BA%A7%E7%BA%BF%E8%B7%AF&url=abc')).toBe(
      true,
    );
  });

  it('影视仓：绝对地址 / 302 跳板也可播', () => {
    expect(dyrs('http://127.0.0.1:8849/api/dyrs/src?kind=tv&id=x&seq=1&p=0')).toBe(true);
  });

  it('影视仓：空值仍判不可播', () => {
    expect(dyrs('')).toBe(false);
  });

  it('macCMS：相对地址不可播（采集站的网页分享地址就是这类）', () => {
    expect(mac('/api/proxy?url=x')).toBe(false);
    expect(mac('https://v.lzcdn31.com/share/aa49af1072b367b0a3342314401297a9')).toBe(false);
  });

  it('macCMS：只有 .m3u8 绝对地址才放行', () => {
    expect(mac('https://v.lzcdn31.com/20261005/12386_63a89eb2/index.m3u8')).toBe(true);
    expect(mac('')).toBe(false);
  });
});
