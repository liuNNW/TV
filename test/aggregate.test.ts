import { describe, expect, it } from 'vitest';
import { SOURCES } from '../src/config.js';
import { mergeLines, pickSameTitle } from '../src/sources/index.js';
import type { Item, PlayLine } from '../src/sources/types.js';

/**
 * 跨源聚合线路。
 *
 * 背景：搜索页按 `name|year` 去重，同一部片只留一张卡（这是对的），但详情只按单源取，
 * 于是用户看到的线路只有那一个源的 1~2 条 —— 实测《嫁金钗》lziapi 只有 2 条
 * （其中一条还是放不了的网页分享地址），而 5 个源一共 9 条。
 */

function mk(name: string, playable = true, eps = 2): PlayLine {
  return {
    name,
    playable,
    episodes: Array.from({ length: eps }, (_, i) => ({ name: `第${i + 1}集`, url: `https://x/${name}/${i}.m3u8` })),
  };
}

describe('mergeLines', () => {
  it('把各源线路合并，并标出来源', () => {
    const out = mergeLines([
      { source: 'lziapi', sourceName: '量子资源', lines: [mk('liangzi', false), mk('lzm3u8')] },
      { source: 'ffzy', sourceName: '非凡资源', lines: [mk('feifan', false), mk('ffm3u8')] },
    ]);
    expect(out).toHaveLength(4);
    expect(out.every((l) => !!l.source && !!l.sourceName)).toBe(true);
    expect(out.map((l) => l.name)).toContain('lzm3u8');
    expect(out.map((l) => l.source)).toContain('ffzy');
  });

  it('可播线路排前面（网页分享线路沉底）', () => {
    const out = mergeLines([
      { source: 'lziapi', sourceName: 'A', lines: [mk('share', false), mk('real')] },
    ]);
    expect(out[0]!.name).toBe('real');
    expect(out[1]!.name).toBe('share');
  });

  it('同一个源里同名线路只留一条', () => {
    const out = mergeLines([
      { source: 'ffzy', sourceName: 'A', lines: [mk('dup'), mk('dup'), mk('other')] },
    ]);
    expect(out.map((l) => l.name).sort()).toEqual(['dup', 'other']);
  });

  it('不同源可以同线名（去重键是 源|线名）', () => {
    const out = mergeLines([
      { source: 'a', sourceName: 'A', lines: [mk('lzm3u8')] },
      { source: 'b', sourceName: 'B', lines: [mk('lzm3u8')] },
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((l) => l.source).sort()).toEqual(['a', 'b']);
  });

  it('排序稳定：同等条件下按源顺序、再按原有线序', () => {
    // 取两个真实源 id，保证 SOURCES 里的先后顺序确定
    const first = SOURCES[0]!.id;
    const last = SOURCES[SOURCES.length - 1]!.id;
    const out = mergeLines([
      { source: last, sourceName: 'L', lines: [mk('z1'), mk('z2')] },
      { source: first, sourceName: 'F', lines: [mk('a1'), mk('a2')] },
    ]);
    expect(out.map((l) => l.source)).toEqual([first, first, last, last]);
    expect(out.map((l) => l.name)).toEqual(['a1', 'a2', 'z1', 'z2']);
  });

  it('空输入返回空数组', () => {
    expect(mergeLines([])).toEqual([]);
  });
});

describe('pickSameTitle（防串片）', () => {
  const hit = (name: string, year?: string) => ({ item: { name, year } as Item });

  it('片名不完全相等就不合并', () => {
    expect(pickSameTitle([hit('嫁金钗之替嫁'), hit('嫁金钗传')], '嫁金钗')).toBeNull();
  });

  it('片名相等且年份相同 → 合并', () => {
    const a = hit('嫁金钗', '2026');
    expect(pickSameTitle([hit('别的'), a], '嫁金钗', '2026')).toBe(a);
  });

  it('年份冲突 → 不合并（同名不同片）', () => {
    expect(pickSameTitle([hit('嫁金钗', '2019')], '嫁金钗', '2026')).toBeNull();
  });

  it('对面没给年份 → 按片名完全相等就接受', () => {
    const a = hit('嫁金钗');
    expect(pickSameTitle([a], '嫁金钗', '2026')).toBe(a);
  });

  it('本片没有年份 → 取第一个完全同名的', () => {
    const a = hit('嫁金钗', '2019');
    expect(pickSameTitle([a], '嫁金钗')).toBe(a);
  });

  it('空列表返回 null', () => {
    expect(pickSameTitle([], '嫁金钗')).toBeNull();
  });
});
