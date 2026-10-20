import { describe, expect, it } from 'vitest';
import {
  buildPlayLines,
  firstPlayableLineIndex,
  looksLikeHls,
  parseEpisodeSegment,
  parsePlayFrom,
} from '../src/parser.js';
import { resolveUrl, rewriteM3u8, checkUrl } from '../src/proxy.js';

describe('parsePlayFrom', () => {
  it('单线路', () => {
    expect(parsePlayFrom('lzm3u8')).toEqual(['lzm3u8']);
  });

  it('多线路用 $$$ 分隔', () => {
    expect(parsePlayFrom('liangzi$$$lzm3u8')).toEqual(['liangzi', 'lzm3u8']);
  });

  it('空值返回空数组', () => {
    expect(parsePlayFrom('')).toEqual([]);
    expect(parsePlayFrom(null)).toEqual([]);
    expect(parsePlayFrom(undefined)).toEqual([]);
    expect(parsePlayFrom('   ')).toEqual([]);
  });

  it('忽略空段与多余空白', () => {
    expect(parsePlayFrom('a$$$$$$b')).toEqual(['a', 'b']);
    expect(parsePlayFrom(' a $$$ b ')).toEqual(['a', 'b']);
  });
});

describe('parseEpisodeSegment', () => {
  it('标准格式：集名$地址 用 # 分隔', () => {
    const r = parseEpisodeSegment('第01集$https://a.com/1.m3u8#第02集$https://a.com/2.m3u8');
    expect(r).toEqual([
      { name: '第01集', url: 'https://a.com/1.m3u8' },
      { name: '第02集', url: 'https://a.com/2.m3u8' },
    ]);
  });

  it('只切第一个 $ —— URL 里含 $ 也不会被切坏', () => {
    const r = parseEpisodeSegment('第01集$https://a.com/x$y/1.m3u8');
    expect(r).toEqual([{ name: '第01集', url: 'https://a.com/x$y/1.m3u8' }]);
  });

  it('地址里含 # 时不会被当成分隔符（因为先按 # 切分，这里验证单段行为）', () => {
    const r = parseEpisodeSegment('第01集$https://a.com/1.m3u8?t=1');
    expect(r[0]!.url).toBe('https://a.com/1.m3u8?t=1');
  });

  it('没有集名时自动编号', () => {
    const r = parseEpisodeSegment('https://a.com/1.m3u8#https://a.com/2.m3u8');
    expect(r).toEqual([
      { name: '第1集', url: 'https://a.com/1.m3u8' },
      { name: '第2集', url: 'https://a.com/2.m3u8' },
    ]);
  });

  it('处理空段与行尾多余 #', () => {
    const r = parseEpisodeSegment('第01集$https://a.com/1.m3u8##');
    expect(r).toHaveLength(1);
  });

  it('空输入', () => {
    expect(parseEpisodeSegment('')).toEqual([]);
    expect(parseEpisodeSegment('   ')).toEqual([]);
  });

  it('集名为空但有地址时补齐编号', () => {
    const r = parseEpisodeSegment('$https://a.com/1.m3u8');
    expect(r).toEqual([{ name: '第1集', url: 'https://a.com/1.m3u8' }]);
  });

  it('丢弃只有集名没有地址的项', () => {
    const r = parseEpisodeSegment('第01集$#第02集$https://a.com/2.m3u8');
    expect(r).toHaveLength(1);
    expect(r[0]!.url).toBe('https://a.com/2.m3u8');
  });
});

describe('buildPlayLines', () => {
  it('正常多线路组装', () => {
    const lines = buildPlayLines(
      'lzm3u8$$$ffm3u8',
      '第01集$https://a.com/1.m3u8#第02集$https://a.com/2.m3u8$$$第01集$https://b.com/1.m3u8',
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]!.name).toBe('lzm3u8');
    expect(lines[0]!.episodes).toHaveLength(2);
    expect(lines[1]!.name).toBe('ffm3u8');
    expect(lines[1]!.episodes).toHaveLength(1);
  });

  it('线路名比地址段少时补默认名', () => {
    const lines = buildPlayLines('lzm3u8', 'a$https://a.com/1.m3u8$$$b$https://b.com/1.m3u8');
    expect(lines).toHaveLength(2);
    expect(lines[1]!.name).toBe('线路2');
  });

  it('vod_play_url 为空 → 空数组（详情页应显示暂无播放地址）', () => {
    expect(buildPlayLines('lzm3u8', '')).toEqual([]);
    expect(buildPlayLines('lzm3u8', null)).toEqual([]);
    expect(buildPlayLines('lzm3u8', undefined)).toEqual([]);
  });

  it('丢弃没有有效集的空线路', () => {
    const lines = buildPlayLines('a$$$b', '$$$第01集$https://b.com/1.m3u8');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.name).toBe('b');
  });

  it('标记可播放线路（m3u8）与不可播放线路（分享页）', () => {
    const lines = buildPlayLines(
      'liangzi$$$lzm3u8',
      '第01集$https://v.lzcdn27.com/share/abc123$$$第01集$https://v.lzcdn27.com/20260911/16824/index.m3u8',
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]!.playable).toBe(false);
    expect(lines[1]!.playable).toBe(true);
  });
});

describe('firstPlayableLineIndex', () => {
  it('跳过不可播放的线路', () => {
    const lines = buildPlayLines(
      'a$$$b',
      '第01集$https://x.com/share/1$$$第01集$https://y.com/1.m3u8',
    );
    expect(firstPlayableLineIndex(lines)).toBe(1);
  });

  it('全部不可播放时返回 0', () => {
    const lines = buildPlayLines('a', '第01集$https://x.com/share/1');
    expect(firstPlayableLineIndex(lines)).toBe(0);
  });
});

describe('looksLikeHls', () => {
  it('识别 m3u8', () => {
    expect(looksLikeHls('https://a.com/x/index.m3u8')).toBe(true);
    expect(looksLikeHls('https://a.com/x/index.M3U8')).toBe(true);
  });

  it('非 m3u8 返回 false', () => {
    expect(looksLikeHls('https://a.com/x/index.mp4')).toBe(false);
    expect(looksLikeHls('')).toBe(false);
  });
});

describe('resolveUrl', () => {
  it('相对路径按 base 解析', () => {
    expect(resolveUrl('000.html', 'https://c.com/a/b/index.m3u8')).toBe(
      'https://c.com/a/b/000.html',
    );
  });

  it('根相对路径', () => {
    expect(resolveUrl('/api/ts?id=1', 'https://c.com/a/b/index.m3u8')).toBe(
      'https://c.com/api/ts?id=1',
    );
  });

  it('绝对地址原样返回', () => {
    expect(resolveUrl('https://d.com/x.ts', 'https://c.com/a/index.m3u8')).toBe(
      'https://d.com/x.ts',
    );
  });
});

describe('rewriteM3u8', () => {
  const base = 'https://cdn.com/a/b/index.m3u8';
  const self = 'http://127.0.0.1:8848/api/proxy?url=';

  it('保留标签行，重写分片地址', () => {
    const input = ['#EXTM3U', '#EXTINF:10.0,', '000.html', '#EXT-X-ENDLIST'].join('\n');
    const out = rewriteM3u8(input, base, self).split('\n');
    expect(out[0]).toBe('#EXTM3U');
    expect(out[1]).toBe('#EXTINF:10.0,');
    expect(out[2]).toBe(self + encodeURIComponent('https://cdn.com/a/b/000.html'));
    expect(out[3]).toBe('#EXT-X-ENDLIST');
  });

  it('master playlist 的子列表地址也被重写', () => {
    const input = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000000',
      '2000k/hls/mixed.m3u8',
    ].join('\n');
    const out = rewriteM3u8(input, base, self).split('\n');
    expect(out[2]).toBe(self + encodeURIComponent('https://cdn.com/a/b/2000k/hls/mixed.m3u8'));
  });

  it('重写 URI="..." 属性（EXT-X-KEY）', () => {
    const input = '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"';
    const out = rewriteM3u8(input, base, self);
    expect(out).toContain(self + encodeURIComponent('https://cdn.com/a/b/key.bin'));
  });

  it('绝对地址保持不变（只包一层代理）', () => {
    const input = 'https://other.com/x/000.ts';
    const out = rewriteM3u8(input, base, self);
    expect(out).toBe(self + encodeURIComponent('https://other.com/x/000.ts'));
  });

  it('空行保留', () => {
    const out = rewriteM3u8('#EXTM3U\n\n000.html', base, self).split('\n');
    expect(out[1]).toBe('');
  });
});

describe('checkUrl（SSRF 防护）', () => {
  it('拒绝非 http/https 协议', async () => {
    expect(await checkUrl('file:///etc/passwd')).toMatch(/不支持的协议/);
    expect(await checkUrl('gopher://x/')).toMatch(/不支持的协议/);
  });

  it('拒绝非法地址', async () => {
    expect(await checkUrl('not a url')).toBe('地址格式非法');
  });

  it('拒绝回环地址', async () => {
    expect(await checkUrl('http://127.0.0.1:8848/api/health')).toMatch(/私有|回环/);
    expect(await checkUrl('http://[::1]/x')).toMatch(/私有|回环/);
  });

  it('拒绝私有网段', async () => {
    expect(await checkUrl('http://10.0.0.5/x')).toMatch(/私有|回环/);
    expect(await checkUrl('http://192.168.1.1/x')).toMatch(/私有|回环/);
    expect(await checkUrl('http://172.16.0.1/x')).toMatch(/私有|回环/);
  });

  it('拒绝云元数据地址', async () => {
    expect(await checkUrl('http://169.254.169.254/latest/meta-data/')).toMatch(/私有|回环/);
  });

  it('拒绝 localhost 主机名', async () => {
    expect(await checkUrl('http://localhost/x')).toMatch(/内网主机名/);
  });
});
