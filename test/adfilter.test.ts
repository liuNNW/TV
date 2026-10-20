import { describe, expect, it } from 'vitest';
import { processPlaylist } from '../src/adfilter.js';

const base = 'https://cdn.example.com/2026/abc/2000k/hls/mixed.m3u8';

function mediaPlaylist(mainNums: number[], adNums: number[], adAfter = 5): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-PLAYLIST-TYPE:VOD'];
  let n = 0;
  const emit = (nums: number[], prefix: string) => {
    for (const num of nums) {
      lines.push('#EXTINF:4.000,', `${prefix}${String(num).padStart(6, '0')}.ts`);
    }
  };
  for (const num of mainNums) {
    if (n === adAfter) {
      lines.push('#EXT-X-DISCONTINUITY');
      emit(adNums, '52190c42c3f009');
    }
    lines.push('#EXTINF:4.000,', `52190c42c3f00${String(num).padStart(6, '0')}.ts`);
    n++;
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n');
}

describe('adfilter', () => {
  it('剔除编号突兀的广告组，正片保持连续', () => {
    const text = mediaPlaylist(
      Array.from({ length: 30 }, (_, i) => i),
      [94363, 94364, 94365, 94366, 94367, 94368, 94369],
      10,
    );
    const { playlist, removed } = processPlaylist(text, base, '/api/hls?url=');
    expect(removed).toBe(7);
    const segs = playlist.split('\n').filter((l) => l && !l.startsWith('#'));
    const nums = segs.map((s) => Number(s.match(/(\d+)\.ts$/)![1]));
    expect(nums).toEqual(Array.from({ length: 30 }, (_, i) => i));
    // 分片重写为绝对地址
    expect(segs[0]).toMatch(/^https:\/\/cdn\.example\.com\//);
  });

  it('不同域名的广告组被剔除', () => {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
    for (let i = 0; i < 30; i++) {
      if (i === 12) {
        lines.push('#EXT-X-DISCONTINUITY');
        for (let a = 0; a < 4; a++) {
          lines.push('#EXTINF:4.000,', `https://ad-cdn.example.net/ads/${a}.ts`);
        }
      }
      lines.push('#EXTINF:4.000,', `https://cdn.example.com/vod/${i}.ts`);
    }
    lines.push('#EXT-X-ENDLIST');
    const { playlist, removed } = processPlaylist(lines.join('\n'), base, '/api/hls?url=');
    expect(removed).toBe(4);
    expect(playlist).not.toContain('ad-cdn.example.net');
  });

  it('master 播放列表不改分片，只改子列表地址', () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1080x608',
      '2000k/hls/index.m3u8',
    ].join('\n');
    const { playlist, removed } = processPlaylist(master, base, '/api/hls?url=');
    expect(removed).toBe(0);
    expect(playlist).toContain('/api/hls?url=' + encodeURIComponent('https://cdn.example.com/2026/abc/2000k/hls/2000k/hls/index.m3u8'));
  });

  it('全部同域名同编号时原样放行（宁放过不误杀）', () => {
    const text = mediaPlaylist(Array.from({ length: 20 }, (_, i) => i), [], 999);
    const { removed } = processPlaylist(text, base, '/api/hls?url=');
    expect(removed).toBe(0);
  });

  it('无广告也要把相对分片路径绝对化（避免浏览器把路径打到播放站）', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:10',
      '#EXTINF:10.0,',
      '/seg/0001.ts',
      '#EXTINF:10.0,',
      '../other/0002.ts',
      '#EXT-X-ENDLIST',
    ].join('\n');
    // 直连模式：rewriteSegments 默认 false，分片输出上游绝对地址
    const { playlist, removed } = processPlaylist(
      text,
      'https://cdn.example.com/hls/sub/index.m3u8',
      '/api/hls?url=',
    );
    expect(removed).toBe(0);
    const segs = playlist.split('\n').filter((l) => l && !l.startsWith('#'));
    expect(segs).toEqual([
      'https://cdn.example.com/seg/0001.ts',
      'https://cdn.example.com/hls/other/0002.ts',
    ]);
  });

  it('开头的前贴片广告组（小而短、编号接不上）被剔除', () => {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
    // 前贴广告：编号 99 万段，总时长 28 秒
    lines.push('#EXT-X-DISCONTINUITY');
    for (let a = 0; a < 7; a++) {
      lines.push('#EXTINF:4.000,', `9430${String(a).padStart(4, '0')}.ts`);
    }
    // 正片 0..39
    lines.push('#EXT-X-DISCONTINUITY');
    for (let i = 0; i < 40; i++) {
      lines.push('#EXTINF:4.000,', `${String(i).padStart(6, '0')}.ts`);
    }
    lines.push('#EXT-X-ENDLIST');
    const { playlist, removed } = processPlaylist(lines.join('\n'), base, '/api/hls?url=');
    expect(removed).toBe(7);
    const segs = playlist.split('\n').filter((l) => l && !l.startsWith('#'));
    expect(segs.length).toBe(40);
    expect(segs[0]).toMatch(/000000\.ts$/);
  });

  it('结尾的片尾广告组被剔除', () => {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
    for (let i = 0; i < 40; i++) {
      lines.push('#EXTINF:4.000,', `${String(i).padStart(6, '0')}.ts`);
    }
    lines.push('#EXT-X-DISCONTINUITY');
    for (let a = 0; a < 5; a++) {
      lines.push('#EXTINF:4.000,', `77${String(a).padStart(5, '0')}.ts`);
    }
    lines.push('#EXT-X-ENDLIST');
    const { playlist, removed } = processPlaylist(lines.join('\n'), base, '/api/hls?url=');
    expect(removed).toBe(5);
    expect(playlist).not.toContain('77000');
  });

  it('无编号分组无法判定时保守保留（不误杀）', () => {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
    for (let i = 0; i < 10; i++) {
      lines.push('#EXTINF:5.0,', `https://cdn.example.com/vod/part-a-${i}.ts`);
    }
    lines.push('#EXT-X-DISCONTINUITY');
    for (let i = 0; i < 10; i++) {
      lines.push('#EXTINF:5.0,', `https://cdn.example.com/vod/part-b-${i}.ts`);
    }
    lines.push('#EXT-X-ENDLIST');
    const { removed } = processPlaylist(lines.join('\n'), base, '/api/hls?url=');
    expect(removed).toBe(0);
  });

  it('URL 特征兜底：/ad/ 路径分片被剔除', () => {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
    for (let i = 0; i < 20; i++) {
      lines.push('#EXTINF:4.000,', `https://cdn.example.com/vod/${String(i).padStart(6, '0')}.ts`);
    }
    lines.push('#EXTINF:4.000,', 'https://cdn.example.com/ad/insert.ts');
    lines.push('#EXT-X-ENDLIST');
    const { playlist, removed } = processPlaylist(lines.join('\n'), base, '/api/hls?url=');
    expect(removed).toBe(1);
    expect(playlist).not.toContain('/ad/');
  });

  /* ---------- 重建播放列表时的标签保真 ---------- */

  it('保留上游的 VERSION / TARGETDURATION / MEDIA-SEQUENCE', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-VERSION:6',
      '#EXT-X-TARGETDURATION:10',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXTINF:10.0,',
      '000000.ts',
      '#EXTINF:10.0,',
      '000001.ts',
      '#EXT-X-ENDLIST',
    ].join('\n');
    const { playlist } = processPlaylist(text, base, '/api/hls?url=');
    expect(playlist).toContain('#EXT-X-VERSION:6');
    expect(playlist).toContain('#EXT-X-TARGETDURATION:10');
    expect(playlist).toContain('#EXT-X-MEDIA-SEQUENCE:0');
    // TARGETDURATION 是 media playlist 必填项，必须出现在分片之前
    expect(playlist.indexOf('#EXT-X-TARGETDURATION')).toBeLessThan(playlist.indexOf('.ts'));
  });

  it('上游缺 TARGETDURATION 时按最长分片补一个', () => {
    const text = [
      '#EXTM3U',
      '#EXTINF:6.5,',
      '000000.ts',
      '#EXTINF:4.0,',
      '000001.ts',
      '#EXT-X-ENDLIST',
    ].join('\n');
    const { playlist } = processPlaylist(text, base, '/api/hls?url=');
    expect(playlist).toContain('#EXT-X-TARGETDURATION:7'); // ceil(6.5)
  });

  it('直播列表（无 ENDLIST）不硬加 ENDLIST / PLAYLIST-TYPE:VOD', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:4',
      '#EXT-X-MEDIA-SEQUENCE:1200',
      '#EXTINF:4.0,',
      '0.ts',
      '#EXTINF:4.0,',
      '1.ts',
    ].join('\n');
    const { playlist } = processPlaylist(text, base, '/api/hls?url=');
    expect(playlist).not.toContain('#EXT-X-ENDLIST');
    expect(playlist).not.toContain('PLAYLIST-TYPE');
    // 直播列表的分片序号不能丢
    expect(playlist).toContain('#EXT-X-MEDIA-SEQUENCE:1200');
  });

  it('CRLF 源文件也能正常清洗（不把 \\r 带进地址）', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXTINF:4.0,',
      'a.ts',
      '#EXTINF:4.0,',
      'b.ts',
      '#EXT-X-ENDLIST',
    ].join('\r\n');
    const { playlist } = processPlaylist(text, base, '/api/hls?url=');
    expect(playlist).not.toContain('\r');
    const segs = playlist.split('\n').filter((l) => l && !l.startsWith('#'));
    expect(segs).toEqual([
      'https://cdn.example.com/2026/abc/2000k/hls/a.ts',
      'https://cdn.example.com/2026/abc/2000k/hls/b.ts',
    ]);
  });

  /* ---------- 代理模式（回落 /api/proxy 后仍要能过滤广告） ---------- */

  it('代理模式：分片与 URI 属性都包一层本机代理', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
      '#EXTINF:4.0,',
      '0.ts',
      '#EXTINF:4.0,',
      '1.ts',
      '#EXT-X-ENDLIST',
    ].join('\n');
    const { playlist } = processPlaylist(text, base, '/api/proxy?url=', true);
    const segs = playlist.split('\n').filter((l) => l && !l.startsWith('#'));
    expect(segs).toEqual([
      '/api/proxy?url=' + encodeURIComponent('https://cdn.example.com/2026/abc/2000k/hls/0.ts'),
      '/api/proxy?url=' + encodeURIComponent('https://cdn.example.com/2026/abc/2000k/hls/1.ts'),
    ]);
    // 解密密钥也要走代理，否则 key 会直连、被 CDN 拦掉导致全片解不开
    expect(playlist).toContain(
      'URI="/api/proxy?url=' +
        encodeURIComponent('https://cdn.example.com/2026/abc/2000k/hls/key.bin') +
        '"',
    );
  });

  it('代理模式同样剔除广告（这条链路以前完全不过滤）', () => {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
    for (let i = 0; i < 30; i++) {
      if (i === 12) {
        lines.push('#EXT-X-DISCONTINUITY');
        for (let a = 0; a < 4; a++) {
          lines.push('#EXTINF:4.000,', `https://ad-cdn.example.net/ads/${a}.ts`);
        }
      }
      lines.push('#EXTINF:4.000,', `https://cdn.example.com/vod/${i}.ts`);
    }
    lines.push('#EXT-X-ENDLIST');
    const { playlist, removed } = processPlaylist(lines.join('\n'), base, '/api/proxy?url=', true);
    expect(removed).toBe(4);
    expect(playlist).not.toContain('ad-cdn.example.net');
    const segs = playlist.split('\n').filter((l) => l && !l.startsWith('#'));
    expect(segs.length).toBe(30);
    expect(segs.every((s) => s.startsWith('/api/proxy?url='))).toBe(true);
  });

  it('代理模式：master 的子列表也指回代理接口', () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1080x608',
      'index.m3u8',
    ].join('\n');
    const { playlist, removed } = processPlaylist(master, base, '/api/proxy?url=', true);
    expect(removed).toBe(0);
    expect(playlist).toContain(
      '/api/proxy?url=' +
        encodeURIComponent('https://cdn.example.com/2026/abc/2000k/hls/index.m3u8'),
    );
    // 子列表不能再直连 CDN，否则子列表里的广告过滤会断掉
    expect(playlist).not.toMatch(/^https:\/\//m);
  });
});
