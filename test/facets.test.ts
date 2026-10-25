import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AREA_ALIAS,
  buildMacFacets,
  facetChips,
  MAC_YEAR,
  normalizeArea,
  normalizeFacetValue,
  toggleFacet,
} from '../src/facets.js';
import { list } from '../src/sources/maccms.js';
import type { SourceConfig } from '../src/config.js';

/**
 * 多维筛选（facet）的回归测试。
 *
 * 锁两件事：
 *   1. 后端词表归一 —— macCMS 只认 `大陆/香港/台湾`，`中国大陆` 传过去会被
 *      上游**静默忽略并返回全量**（实测 4978 vs 1233），所以必须映射。
 *   2. 前端组合逻辑 —— 上游筛选链接只带一个参数，照抄就会「点地区丢分类」，
 *      这里把「只换这一轴、其它轴继承」钉死。
 */

/* ---------------- 后端：词表与归一 ---------------- */

describe('facets 词表归一', () => {
  it('长写法映射到 macCMS 短写法', () => {
    expect(normalizeArea('中国大陆')).toBe('大陆');
    expect(normalizeArea('中国香港')).toBe('香港');
    expect(normalizeArea('中国台湾')).toBe('台湾');
    expect(normalizeArea('其他')).toBe('其它');
    expect(normalizeArea('美国')).toBe('美国');
    expect(normalizeArea('')).toBe('');
  });

  it('AREA_ALIAS 覆盖上游那套「中国XX」写法', () => {
    expect(AREA_ALIAS['中国大陆']).toBe('大陆');
    expect(AREA_ALIAS['中国香港']).toBe('香港');
    expect(AREA_ALIAS['中国台湾']).toBe('台湾');
  });

  it('不在词表里的值一律丢弃（不能把用户输入原样丢给上游）', () => {
    expect(normalizeFacetValue('area', '火星')).toBe('');
    expect(normalizeFacetValue('lang', '火星语')).toBe('');
    expect(normalizeFacetValue('year', '2024')).toBe('2024');
    expect(normalizeFacetValue('year', '90年代')).toBe('90年代');
    expect(normalizeFacetValue('year', 'abc')).toBe('');
    // 词表口径与上游一致：2000 以前只给年代档，单年不收（上游页面也是这么给的）
    expect(normalizeFacetValue('year', '1994')).toBe('');
    // 空 = 全部，也是空串
    expect(normalizeFacetValue('area', '')).toBe('');
    expect(normalizeFacetValue('area', undefined)).toBe('');
  });

  it('buildMacFacets 只输出生效的维度', () => {
    expect(buildMacFacets({})).toEqual({});
    expect(buildMacFacets({ area: '美国', year: '2024' })).toEqual({ area: '美国', year: '2024' });
    // 非法的被剔除，合法的保留
    expect(buildMacFacets({ area: '火星', lang: '国语' })).toEqual({ lang: '国语' });
    // 长写法先归一
    expect(buildMacFacets({ area: '中国香港' })).toEqual({ area: '香港' });
  });

  it('年份词表从今年开始，且含年代档', () => {
    const thisYear = String(new Date().getFullYear());
    expect(MAC_YEAR[1]!.value).toBe(thisYear);
    expect(MAC_YEAR.some((v) => v.value === '90年代')).toBe(true);
    expect(MAC_YEAR[0]!.value).toBe(''); // 「全部」
  });

  it('toggleFacet：同轴替换、点已选取消、其它轴保留', () => {
    const a = { class: '悬疑', area: '日本' };
    expect(toggleFacet(a, 'year', '2025')).toEqual({ class: '悬疑', area: '日本', year: '2025' });
    expect(toggleFacet(a, 'area', '日本')).toEqual({ class: '悬疑' });
    expect(toggleFacet(a, 'area', '美国')).toEqual({ class: '悬疑', area: '美国' });
    // 传空值 = 取消该轴
    expect(toggleFacet(a, 'class', '')).toEqual({ area: '日本' });
    // 不修改入参
    expect(a).toEqual({ class: '悬疑', area: '日本' });
  });

  it('facetChips 给人看的文案', () => {
    const chips = facetChips({ area: '美国', year: '2024' });
    expect(chips.map((c) => `${c.groupLabel}:${c.label}`)).toEqual(['地区:美国', '年份:2024']);
    expect(facetChips({})).toEqual([]);
  });
});

/* ---------------- 后端：/api/list 把 facets 传进上游 URL ---------------- */

describe('maccms.list 透传筛选参数', () => {
  const src: SourceConfig = { id: 'test', name: '测试源', base: 'https://example.com/api.php/provide/vod/' };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(): string[] {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(String(url));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 1, page: 1, pagecount: 1, total: 0, list: [] }),
      };
    });
    return urls;
  }

  it('不带 facets 时不出现 area/year/lang', async () => {
    const urls = stubFetch();
    await list(src, '6', 1);
    expect(urls).toHaveLength(1);
    const u = new URL(urls[0]!);
    expect(u.searchParams.get('ac')).toBe('list');
    expect(u.searchParams.get('t')).toBe('6');
    expect(u.searchParams.has('area')).toBe(false);
    expect(u.searchParams.has('year')).toBe(false);
    expect(u.searchParams.has('lang')).toBe(false);
  });

  it('带 facets 时三轴都进 query 且正确编码', async () => {
    const urls = stubFetch();
    await list(src, '6', 2, { area: '美国', year: '2024', lang: '国语' });
    const u = new URL(urls[0]!);
    expect(u.searchParams.get('area')).toBe('美国');
    expect(u.searchParams.get('year')).toBe('2024');
    expect(u.searchParams.get('lang')).toBe('国语');
    expect(u.searchParams.get('pg')).toBe('2');
  });
});

/* ---------------- 前端：public/facets.js ---------------- */

/**
 * public/facets.js 是浏览器脚本（IIFE，挂在 window.DSHFacets 上）。
 * 这里用 new Function 塞一个假 window 进去执行，取回 API —— 沿用
 * test/playerjs.test.ts 的思路，不为它单独引入打包步骤。
 */
const here = dirname(fileURLToPath(import.meta.url));
const facetSrc = readFileSync(join(here, '..', 'public', 'facets.js'), 'utf8');
const fakeWindow: Record<string, unknown> = {};
// eslint-disable-next-line no-new-func
new Function('window', facetSrc)(fakeWindow);

interface BrowserFacets {
  readFacets(params: URLSearchParams, keys?: string[]): Record<string, string>;
  toggleFacet(f: Record<string, string>, key: string, value: string): Record<string, string>;
  isActive(f: Record<string, string>, key: string, value: string): boolean;
  composeQuery(f: Record<string, string>, extra?: Record<string, string | number>): string;
  composeHref(base: string, f: Record<string, string>, extra?: Record<string, string | number>): string;
  upstreamOption(href: string, baseUrl?: string): { key: string | null; value: string };
  channelFromHref(href: string, baseUrl?: string): string;
  chips(f: Record<string, string>): { key: string; value: string }[];
}

const F = fakeWindow.DSHFacets as BrowserFacets;

describe('public/facets.js（浏览器侧组合逻辑）', () => {
  it('读出 URL 里的筛选', () => {
    const p = new URLSearchParams('ch=dianying&class=悬疑&area=日本&page=2');
    expect(F.readFacets(p)).toEqual({ class: '悬疑', area: '日本' });
  });

  it('上游链接 → 该轴与值（含 origin→line 的改名）', () => {
    expect(F.upstreamOption('/dianying.html?year=2024', 'https://dyrs.cc')).toEqual({
      key: 'year',
      value: '2024',
    });
    expect(F.upstreamOption('/dianying.html?origin=%E7%8E%8B%E8%80%85TV%E8%93%9D%E5%85%89', 'https://dyrs.cc')).toEqual({
      key: 'line',
      value: '王者TV蓝光',
    });
    expect(F.upstreamOption('/dianying.html?sort_field=play_hot', 'https://dyrs.cc')).toEqual({
      key: 'sort_field',
      value: 'play_hot',
    });
    // 「全部」链接不带参数
    expect(F.upstreamOption('/dianying.html', 'https://dyrs.cc')).toEqual({ key: null, value: '' });
  });

  it('频道名从 href 抠出来', () => {
    expect(F.channelFromHref('/dianshiju.html?area=%E7%BE%8E%E5%9B%BD', 'https://x.cc')).toBe('dianshiju');
    expect(F.channelFromHref('/search.html', 'https://x.cc')).toBe('search');
    expect(F.channelFromHref('', 'https://x.cc')).toBe('');
  });

  it('★ 点地区不能丢掉已选分类（这是上游的单维缺陷）', () => {
    const cur = { class: '悬疑', year: '2025' };
    const opt = F.upstreamOption('/dianying.html?area=%E6%97%A5%E6%9C%AC', 'https://x.cc');
    const next = F.toggleFacet(cur, opt.key!, opt.value);
    expect(next).toEqual({ class: '悬疑', year: '2025', area: '日本' });
    const href = F.composeHref('dyrs.html', next, { ch: 'dianying' });
    expect(href).toContain('class=%E6%82%AC%E7%96%91');
    expect(href).toContain('area=%E6%97%A5%E6%9C%AC');
    expect(href).toContain('ch=dianying');
  });

  it('再点同一个值 = 取消该轴，其它轴还在', () => {
    const cur = { class: '悬疑', area: '日本' };
    expect(F.toggleFacet(cur, 'area', '日本')).toEqual({ class: '悬疑' });
  });

  it('composeQuery：extra 覆盖同名 facet，空值不写入', () => {
    const q = F.composeQuery({ class: '悬疑', area: '' }, { ch: 'tv', page: 0 });
    const p = new URLSearchParams(q);
    expect(p.get('class')).toBe('悬疑');
    expect(p.has('area')).toBe(false);
    expect(p.get('ch')).toBe('tv');
    expect(p.get('page')).toBe('0');
  });

  it('chips 只列有值的轴', () => {
    expect(F.chips({ class: '悬疑', area: '' })).toEqual([{ key: 'class', value: '悬疑' }]);
  });
});
