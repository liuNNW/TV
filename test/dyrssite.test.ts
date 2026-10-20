import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  parseBanner,
  parseBoxData,
  parseCards,
  parseDetail,
  parseDriveItems,
  parseFilters,
  parseMaxPage,
  parseSeqId,
  toPlaySrc,
} from '../src/dyrssite.js';

/**
 * 用真实页面快照做解析回归。
 * 快照在 test/fixtures/ 下（从 tvcang.com 抓的原始 HTML，体积大所以只提交精简片段也行，
 * 这里直接提交完整文件，方便以后页面结构变了能立刻发现）。
 */
const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function load(name: string): string {
  return readFileSync(join(dir, name), 'utf8');
}

describe('dyrs 站点 HTML 解析', () => {
  it('分类页：卡片解析（id/名称/封面/角标/年份）', () => {
    const cards = parseCards(load('dyrs-cat.html'));
    expect(cards.length).toBeGreaterThan(10);
    const first = cards[0];
    expect(first.id).toMatch(/^[0-9a-f]{24}$/);
    expect(first.name.length).toBeGreaterThan(0);
    expect(first.pic).toContain('/img/id/');
    expect(first.year).toMatch(/^\d{4}$/);
  });

  it('分类页：筛选行解析（频道/分类/地区/年份）', () => {
    const rows = parseFilters(load('dyrs-cat.html'));
    const labels = rows.map((r) => r.label);
    expect(labels).toContain('频道');
    expect(labels).toContain('分类');
    for (const r of rows) {
      expect(r.options.length).toBeGreaterThan(0);
      expect(r.options[0].href).toMatch(/^\//);
    }
  });

  it('分类页：分页解析', () => {
    expect(parseMaxPage(load('dyrs-cat.html'))).toBeGreaterThan(3);
  });

  it('搜索页：卡片解析与列表页同构', () => {
    const cards = parseCards(load('dyrs-search.html'));
    expect(cards.length).toBeGreaterThan(0);
    expect(cards[0].name).toBeTruthy();
  });

  it('搜索页：真实关键词结果确实被过滤（/s.html 带 attack_key）', () => {
    const cards = parseCards(load('dyrs-search2.html'));
    expect(cards.length).toBeGreaterThan(5);
    // 关键词「庆余年」的命中率应显著高于随机片单
    const hit = cards.filter((c) => c.name.includes('庆余年'));
    expect(hit.length).toBeGreaterThanOrEqual(3);
  });

  it('详情页：JSON-LD + 元信息 + 线路 + 选集', () => {
    const d = parseDetail(load('dyrs-detail.html'), '6a9b9cdc2dbbc2bdc9cda2c3', 'tv');
    expect(d.name).toContain('现在就出发');
    expect(d.actors).toContain('沈腾');
    expect(d.year).toBe('2026');
    expect(d.description.length).toBeGreaterThan(5);
    expect(d.pic).toContain('/img/id/');
    // 至少一条线路有选集
    const withEps = d.origins.filter((o) => o.episodes.length > 0);
    expect(withEps.length).toBeGreaterThan(0);
    // seqlist 编号：选集地址是 /{kind}/{id}/{seq}.html?origin=..&p=..
    expect(d.seq).toBe('6039');
    const sup = d.origins.find((o) => o.origin === '超级线路');
    expect(sup).toBeTruthy();
    expect(sup!.count).toBeGreaterThan(0);
    if (sup!.episodes.length) {
      expect(sup!.episodes[0].title).toBeTruthy();
      expect(sup!.episodes[0].p).toBe(0);
    }
  });

  it('parseSeqId：优先取线路 tab 的 -{seq}.html，不能误命中 -1.html?ep_list=title', () => {
    expect(parseSeqId(load('dyrs-detail.html'))).toBe('6039');
    // 只有选集链接（单线路的片子没有 tab）时走 /{id}/{seq}.html 兜底
    expect(parseSeqId('<a href="/tv/aa/12345.html?origin=x&amp;p=0">第01集</a>')).toBe('12345');
    // 详情页里那个「标题模式」链接不能被当成 seq
    expect(parseSeqId('<a href="/tv/aa-1.html?ep_list=title">标题</a>')).toBe('');
    expect(parseSeqId('')).toBe('');
  });

  it('详情页：线路 tab 计数（seqlist 只渲染当前线路，count 用 tab 补齐）', () => {
    const d = parseDetail(load('dyrs-detail.html'));
    expect(d.origins.length).toBeGreaterThan(3);
    for (const o of d.origins) {
      expect(o.count).toBeGreaterThan(0);
    }
  });

  it('详情页：box_data（云盘查询用的片名/IMDb/CDN）', () => {
    const d = parseDetail(load('dyrs-detail.html'));
    expect(d.boxName).toBe('现在就出发');
    expect(d.imdbId).toBe('');
    expect(d.cdnBase).toBe('https://box.dyrs.com.de');
  });

  it('首页：banner 解析', () => {
    const b = parseBanner(load('dyrs-home.html'));
    expect(b.length).toBeGreaterThan(2);
    expect(b[0].name).toBeTruthy();
    expect(b[0].pic).toContain('/img/id/');
    expect(b[0].desc.length).toBeGreaterThan(5);
  });
});

describe('取流地址换算（上游两种 url 形态）', () => {
  const BASE = 'https://tvcang.com';

  it('站内代理形态 → 换成本站 dyrs 代理链', () => {
    const src = toPlaySrc(
      '/api/m3u8?origin=%E8%B6%85%E7%BA%A7%E7%BA%BF%E8%B7%AF&url=6acbdfd744c32b7c7a412a64',
      undefined,
      BASE,
    );
    expect(src).toMatch(/^\/api\/dyrs\/m3u8\?/);
    const q = new URLSearchParams(src.split('?')[1]);
    expect(q.get('proxy')).toBe('1');
    expect(q.get('url')).toBe('6acbdfd744c32b7c7a412a64');
    expect(q.get('origin')).toBe('超级线路');
  });

  it('直链形态（bfzym3u8 这类）→ 走通用透传代理，不能再报「没有可用地址」', () => {
    const direct = 'https://fengbao13.com/video/qilongzhuchaobilusi/784360b1ff55/index.m3u8';
    const src = toPlaySrc(direct, 'bfzym3u8', BASE);
    expect(src).toMatch(/^\/api\/proxy\?url=/);
    expect(decodeURIComponent(src.replace('/api/proxy?url=', ''))).toBe(direct);
  });

  it('相对路径直链 → 用站点线路补成绝对地址', () => {
    const src = toPlaySrc('/video/abc/index.m3u8', 'lzm3u8', BASE);
    expect(decodeURIComponent(src.replace('/api/proxy?url=', ''))).toBe('https://tvcang.com/video/abc/index.m3u8');
  });

  it('空 url → 空串（由调用方回 502）', () => {
    expect(toPlaySrc('', undefined, BASE)).toBe('');
  });
});

describe('云盘分享源（/api/drive/list）', () => {
  it('解析并排序：百度优先；url 缺失时回退 share_url；无 filename 的条目丢掉', () => {
    const items = parseDriveItems(JSON.stringify([
      { origin: 'ali', share_url: 'https://www.aliyundrive.com/s/abc', pwd: '', filename: '阿里资源.mkv' },
      { origin: 'baidu', share_url: 'https://pan.baidu.com/s/x', pwd: 'dyrs', filename: '百度资源.mp4', url: 'https://pan.baidu.com/s/x?pwd=dyrs' },
      { origin: 'baidu', pwd: 'dyrs' },
    ]));
    expect(items).toHaveLength(2);
    expect(items[0].origin).toBe('baidu');
    expect(items[0].url).toBe('https://pan.baidu.com/s/x?pwd=dyrs');
    expect(items[0].pwd).toBe('dyrs');
    expect(items[1].url).toBe('https://www.aliyundrive.com/s/abc');
  });

  it('上游无结果返回 null / 坏 JSON / 非数组 → 空数组', () => {
    expect(parseDriveItems('null')).toEqual([]);
    expect(parseDriveItems('<html>检测页</html>')).toEqual([]);
    expect(parseDriveItems('{"foo":1}')).toEqual([]);
  });

  it('parseBoxData：片名去掉季/集后缀，imdb 与 CDN 一并带出', () => {
    const box = parseBoxData('<script>var box_data={ url:"https://box.dyrs.com.de", name:"中国尘封罪案实录", category:"dianying", imdb_id:"tt1234567", };</script>');
    expect(box.boxName).toBe('中国尘封罪案实录');
    expect(box.imdbId).toBe('tt1234567');
    expect(box.cdnBase).toBe('https://box.dyrs.com.de');
    expect(parseBoxData('<html></html>')).toEqual({ boxName: '', imdbId: '', cdnBase: '' });
  });
});
