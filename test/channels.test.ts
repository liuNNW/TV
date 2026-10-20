import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LruCache, cached } from '../src/cache.js';
import { channelRank, classifyChannel, groupByChannel } from '../src/channels.js';

describe('classifyChannel', () => {
  it('电影类', () => {
    expect(classifyChannel('动作片')).toBe('电影');
    expect(classifyChannel('喜剧片')).toBe('电影');
    expect(classifyChannel('剧情片')).toBe('电影');
    expect(classifyChannel('科幻片')).toBe('电影');
    expect(classifyChannel('记录片')).toBe('电影');
    expect(classifyChannel('伦理片')).toBe('电影');
  });

  it('电视剧类', () => {
    expect(classifyChannel('国产剧')).toBe('电视剧');
    expect(classifyChannel('欧美剧')).toBe('电视剧');
    expect(classifyChannel('韩国剧')).toBe('电视剧');
    expect(classifyChannel('香港剧')).toBe('电视剧');
    expect(classifyChannel('泰国剧')).toBe('电视剧');
  });

  it('综艺类', () => {
    expect(classifyChannel('大陆综艺')).toBe('综艺');
    expect(classifyChannel('欧美综艺')).toBe('综艺');
    expect(classifyChannel('日韩综艺')).toBe('综艺');
  });

  it('动漫类', () => {
    expect(classifyChannel('日韩动漫')).toBe('动漫');
    expect(classifyChannel('国产动漫')).toBe('动漫');
    expect(classifyChannel('海外动漫')).toBe('动漫');
  });

  it('体育类', () => {
    expect(classifyChannel('足球')).toBe('体育');
    expect(classifyChannel('篮球')).toBe('体育');
    expect(classifyChannel('网球')).toBe('体育');
    expect(classifyChannel('斯诺克')).toBe('体育');
  });

  it('解说类', () => {
    expect(classifyChannel('电影解说')).toBe('解说');
  });

  it('含「剧」但以「片」结尾的仍是电影（喜剧片/剧情片 不是电视剧）', () => {
    expect(classifyChannel('喜剧片')).toBe('电影');
    expect(classifyChannel('剧情片')).toBe('电影');
    // 以「剧」结尾的才是电视剧
    expect(classifyChannel('国产剧')).toBe('电视剧');
  });

  it('判不出来归入其他', () => {
    expect(classifyChannel('未知分类abc')).toBe('其他');
    expect(classifyChannel('')).toBe('其他');
  });
});

describe('channelRank', () => {
  it('按 CHANNEL_ORDER 排序', () => {
    expect(channelRank('电影')).toBe(0);
    expect(channelRank('电视剧')).toBe(1);
    expect(channelRank('未知')).toBeGreaterThan(channelRank('体育'));
  });
});

describe('groupByChannel', () => {
  const mk = (name: string, total: number) => ({ name, total, refs: [] });

  it('按频道分组，组内按条数降序', () => {
    const groups = groupByChannel([
      mk('动作片', 4964),
      mk('喜剧片', 7753),
      mk('国产剧', 4538),
      mk('足球', 11411),
    ]);

    const film = groups.find((g) => g.name === '电影');
    expect(film).toBeDefined();
    expect(film!.categories.map((c) => c.name)).toEqual(['喜剧片', '动作片']);

    const tv = groups.find((g) => g.name === '电视剧');
    expect(tv!.categories).toHaveLength(1);

    const sport = groups.find((g) => g.name === '体育');
    expect(sport!.categories[0]!.name).toBe('足球');
  });

  it('频道按 CHANNEL_ORDER 排序', () => {
    const groups = groupByChannel([mk('足球', 100), mk('动作片', 100), mk('国产剧', 100)]);
    expect(groups.map((g) => g.name)).toEqual(['电影', '电视剧', '体育']);
  });

  it('过滤僵尸分类（total < minTotal）', () => {
    const groups = groupByChannel([
      mk('动作片', 4964),
      mk('电影片', 1),
      mk('连续剧', 3),
      mk('综艺片', 1),
    ], 50);

    const all = groups.flatMap((g) => g.categories.map((c) => c.name));
    expect(all).toEqual(['动作片']);
  });

  it('频道 total 是该频道下分类之和', () => {
    const groups = groupByChannel([mk('动作片', 100), mk('喜剧片', 200)]);
    const film = groups.find((g) => g.name === '电影');
    expect(film!.total).toBe(300);
  });

  it('空输入返回空数组', () => {
    expect(groupByChannel([])).toEqual([]);
  });

  it('全部被过滤时返回空数组', () => {
    expect(groupByChannel([mk('电影片', 1)], 50)).toEqual([]);
  });
});

describe('LruCache', () => {
  it('存取', () => {
    const c = new LruCache<number>(3, 10_000);
    c.set('a', 1);
    expect(c.get('a')).toBe(1);
    expect(c.get('missing')).toBeUndefined();
  });

  it('超容量淘汰最久未使用的', () => {
    const c = new LruCache<number>(2, 10_000);
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3); // 淘汰 a
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')).toBe(2);
    expect(c.get('c')).toBe(3);
  });

  it('get 会让条目变成最近使用', () => {
    const c = new LruCache<number>(2, 10_000);
    c.set('a', 1);
    c.set('b', 2);
    c.get('a');      // a 变成最近使用
    c.set('c', 3);   // 应淘汰 b
    expect(c.get('a')).toBe(1);
    expect(c.get('b')).toBeUndefined();
  });

  it('TTL 过期后取不到', () => {
    vi.useFakeTimers();
    try {
      const c = new LruCache<number>(3, 1000);
      c.set('a', 1);
      vi.advanceTimersByTime(1500);
      expect(c.get('a')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('重复 set 同一 key 会更新值且不重复占位', () => {
    const c = new LruCache<number>(2, 10_000);
    c.set('a', 1);
    c.set('a', 2);
    expect(c.size).toBe(1);
    expect(c.get('a')).toBe(2);
  });

  it('prune 清理过期项', () => {
    vi.useFakeTimers();
    try {
      const c = new LruCache<number>(5, 1000);
      c.set('a', 1);
      c.set('b', 2);
      vi.advanceTimersByTime(1500);
      expect(c.prune()).toBe(2);
      expect(c.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('cached', () => {
  it('命中缓存不重复计算', async () => {
    const c = new LruCache<string>(5, 10_000);
    let calls = 0;
    const compute = async () => { calls++; return 'v'; };

    await cached(c, 'k', compute);
    await cached(c, 'k', compute);
    expect(calls).toBe(1);
  });

  it('不同 key 各算一次', async () => {
    const c = new LruCache<string>(5, 10_000);
    let calls = 0;
    const compute = async () => { calls++; return 'v'; };

    await cached(c, 'k1', compute);
    await cached(c, 'k2', compute);
    expect(calls).toBe(2);
  });

  it('计算抛错时不写入缓存', async () => {
    const c = new LruCache<string>(5, 10_000);
    await expect(cached(c, 'k', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(c.get('k')).toBeUndefined();
  });
});
