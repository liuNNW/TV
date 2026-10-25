import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverCategories, fetchClassTree } from '../src/sources/maccms.js';
import type { SourceConfig } from '../src/config.js';

/**
 * 分类来源改造后的回归测试。
 *
 * 背景：以前靠 `ac=list&t=1..40` 逐个探测（8 源 320 次请求 / 57.8 秒），
 * 而且 **id > 40 的分类直接漏掉** —— lziapi 的「短剧」(46) 和「AI漫剧」(52) 就是这么丢的。
 * 现在改成读 `ac=list` 响应里自带的 `class` 字段：1 次请求拿到整棵树。
 */

const src: SourceConfig = {
  id: 'test',
  name: '测试源',
  base: 'https://example.com/api.php/provide/vod/',
};

/** 造一个只会返回固定 JSON 的 fetch，并记录被请求的 URL */
function stubJson(payload: unknown): string[] {
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    urls.push(String(url));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
    };
  });
  return urls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchClassTree', () => {
  it('解析 type_id / type_name / type_pid，并把 pid 换成父分类名', async () => {
    stubJson({
      code: 1,
      list: [],
      class: [
        { type_id: 1, type_name: '电影片', type_pid: 0 },
        { type_id: 6, type_name: '动作片', type_pid: 1 },
        { type_id: 46, type_name: '短剧', type_pid: 0 },
        { type_id: 52, type_name: 'AI漫剧', type_pid: 0 },
      ],
    });

    const nodes = await fetchClassTree(src);
    expect(nodes).toEqual([
      { id: '1', name: '电影片', parent: null },
      { id: '6', name: '动作片', parent: '电影片' },
      { id: '46', name: '短剧', parent: null },
      { id: '52', name: 'AI漫剧', parent: null },
    ]);
  });

  it('pid 缺失 / 指向自己 / 指向不存在的父 → 都当顶层', async () => {
    stubJson({
      code: 1,
      list: [],
      class: [
        { type_id: 1, type_name: '电影' }, // 没有 type_pid 字段
        { type_id: 2, type_name: '连续剧', type_pid: 2 }, // 指向自己
        { type_id: 3, type_name: '动作片', type_pid: 999 }, // 父不存在
      ],
    });

    const nodes = await fetchClassTree(src);
    expect(nodes.map((n) => n.parent)).toEqual([null, null, null]);
  });

  it('重复 type_id 只保留一条，缺字段的条目跳过', async () => {
    stubJson({
      code: 1,
      list: [],
      class: [
        { type_id: 1, type_name: '电影' },
        { type_id: 1, type_name: '电影（重复）' },
        { type_id: 2, type_name: '' },
        { type_name: '没有 id' },
      ],
    });

    const nodes = await fetchClassTree(src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.name).toBe('电影');
  });

  it('源不给 class 时返回空数组（上层会退回逐个探测）', async () => {
    stubJson({ code: 1, list: [] });
    expect(await fetchClassTree(src)).toEqual([]);
  });
});

describe('discoverCategories 走 class 树', () => {
  it('只发 1 次请求就能拿到全部分类（含 id>40 的）', async () => {
    const urls = stubJson({
      code: 1,
      list: [],
      class: [
        { type_id: 1, type_name: '电影片', type_pid: 0 },
        { type_id: 6, type_name: '动作片', type_pid: 1 },
        { type_id: 46, type_name: '短剧', type_pid: 0 },
        { type_id: 52, type_name: 'AI漫剧', type_pid: 0 },
        { type_id: 75, type_name: '4K电影', type_pid: 0 },
      ],
    });

    const cats = await discoverCategories(src);

    // 旧实现要打 40 次；现在 1 次
    expect(urls).toHaveLength(1);
    // 关键：id > 40 的分类不再丢
    expect(cats.map((c) => c.id)).toEqual(['1', '6', '46', '52', '75']);
    expect(cats.find((c) => c.id === '6')!.parent).toBe('电影片');
    // 条数默认不采集
    expect(cats.every((c) => c.total === null)).toBe(true);
  });
});
