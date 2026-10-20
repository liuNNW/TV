import { describe, expect, it } from 'vitest';
import {
  hoistPlayableVariants,
  isPlaylistType,
  looksLikePlaceholder,
  rewriteDyrsPlaylist,
} from '../src/dyrs.js';

/**
 * dyrs（wzzycc 模板）接口复刻的纯函数回归测试。
 *
 * 这些函数是「把上游 m3u8 变成本站可播列表」的关键一环，出错的症状都很隐蔽：
 *   - 相对地址没重写 → 浏览器按本站域名解析 → 404，表现为「列表拿到了但播不出」
 *   - uuid 与列表不配对 → 上游静默返回 PNG → 播放器花屏 / 黑屏
 * 所以这里把两种分片形态和占位图识别都钉死。
 */

const CDN = 'https://box.dyrs.com.de';

describe('rewriteDyrsPlaylist', () => {
  it('把 CDN 的 /api/ts 相对地址重写成结构化的分片代理（保留 id/index/uuid）', () => {
    const src = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXTINF:3.000,',
      '/api/ts?m3u8_id=abc123&index=0&uuid=deadbeef',
      '#EXTINF:3.000,',
      '/api/ts?m3u8_id=abc123&index=1&uuid=deadbeef',
    ].join('\n');

    const out = rewriteDyrsPlaylist(src, CDN);
    expect(out).toContain('/api/dyrs/cdn/ts?m3u8_id=abc123&index=0&uuid=deadbeef');
    expect(out).toContain('/api/dyrs/cdn/ts?m3u8_id=abc123&index=1&uuid=deadbeef');
    // 不能再有裸的 /api/ts
    expect(out).not.toMatch(/(^|\n)\/api\/ts\?/);
    // 标签行要原样保留
    expect(out).toContain('#EXT-X-VERSION:3');
  });

  it('把真实 TS CDN 直链包成通用透传代理 /seg?u=', () => {
    const src = [
      '#EXTM3U',
      '#EXTINF:3.000,',
      'https://v.lzcdn28.com/2024/xxx/1000.ts',
    ].join('\n');

    const out = rewriteDyrsPlaylist(src, CDN);
    expect(out).toContain('/api/dyrs/seg?u=' + encodeURIComponent('https://v.lzcdn28.com/2024/xxx/1000.ts'));
  });

  it('把协议相对地址（//host/path）也补全成绝对地址再包', () => {
    const src = '#EXTM3U\n//cdn.example.com/a/1.ts\n';
    const out = rewriteDyrsPlaylist(src, CDN);
    expect(out).toContain('/api/dyrs/seg?u=' + encodeURIComponent('https://cdn.example.com/a/1.ts'));
  });

  it('EXT-X-KEY / EXT-X-MAP 的 URI="..." 也要重写', () => {
    const src = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128,URI="/api/ts?m3u8_id=k1&index=0&uuid=ff"',
      '#EXT-X-MAP:URI="https://v.lzcdn28.com/init.mp4"',
      '#EXTINF:3.000,',
      '/api/ts?m3u8_id=k1&index=1&uuid=ff',
    ].join('\n');

    const out = rewriteDyrsPlaylist(src, CDN);
    expect(out).toContain('URI="/api/dyrs/cdn/ts?m3u8_id=k1&index=0&uuid=ff"');
    expect(out).toContain('URI="/api/dyrs/seg?u=' + encodeURIComponent('https://v.lzcdn28.com/init.mp4') + '"');
  });

  it('master 列表里的二级 /api/m3u8?id= 走 /cdn/m3u8 并保留 raw', () => {
    const src = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000000',
      '/api/m3u8?id=media-1',
      '#EXT-X-STREAM-INF:BANDWIDTH=2000000',
      '/api/m3u8?id=media-2&raw=1',
    ].join('\n');

    const out = rewriteDyrsPlaylist(src, CDN);
    expect(out).toContain('/api/dyrs/cdn/m3u8?id=media-1');
    expect(out).toContain('/api/dyrs/cdn/m3u8?id=media-2&raw=1');
  });

  it('自定义 self 前缀生效，且保留 CRLF 之外的空行结构', () => {
    const src = '#EXTM3U\n\n/api/ts?m3u8_id=x&index=9&uuid=y\n';
    const out = rewriteDyrsPlaylist(src, CDN, '/api/custom');
    expect(out).toContain('/api/custom/cdn/ts?m3u8_id=x&index=9&uuid=y');
    expect(out.split('\n')[1]).toBe('');
  });

  it('空列表 / 只有标签时不会抛', () => {
    expect(() => rewriteDyrsPlaylist('', CDN)).not.toThrow();
    expect(rewriteDyrsPlaylist('#EXTM3U\n#EXT-X-ENDLIST\n', CDN)).toContain('#EXT-X-ENDLIST');
  });

  it('master 里的 /api/direct 走专用 /direct 代理（保留 id/origin）', () => {
    const src = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000000',
      '/api/m3u8?id=media-1',
      '#EXT-X-STREAM-INF:BANDWIDTH=900000',
      '/api/direct?id=vid-1&origin=vip1',
    ].join('\n');

    const out = rewriteDyrsPlaylist(src, CDN);
    expect(out).toContain('/api/dyrs/direct?id=vid-1&origin=vip1');
    expect(out).toContain('/api/dyrs/cdn/m3u8?id=media-1');
  });

  it('相对分片名按「列表文件自身地址」解析（/api/direct 返回的 000.html 场景）', () => {
    // 上游 /api/direct 302 到真实 TS 主机后，media 列表里分片就是裸文件名
    const src = ['#EXTM3U', '#EXTINF:13.333333,', '000.html', '#EXTINF:12.750000,', '001.html'].join('\n');
    const base = 'https://vip1.wzzym3u8.cc/m3u8/6aad3f49.t1080p%7Btm1423191%7D/1.m3u8';

    const out = rewriteDyrsPlaylist(src, base);
    expect(out).toContain(
      '/api/dyrs/seg?u=' +
        encodeURIComponent('https://vip1.wzzym3u8.cc/m3u8/6aad3f49.t1080p%7Btm1423191%7D/000.html'),
    );
    expect(out).toContain(
      '/api/dyrs/seg?u=' +
        encodeURIComponent('https://vip1.wzzym3u8.cc/m3u8/6aad3f49.t1080p%7Btm1423191%7D/001.html'),
    );
  });
});

/**
 * master 清晰度重排。
 *
 * 背景（2026-10 实测）：master 里 `BANDWIDTH=1000000` 那条的 `/api/dyrs/cdn/m3u8?id=X`
 * 分片走 CDN 的 `/api/ts`，**未登录时静默返回一张 PNG 占位图**（624KB，magic 89504e47），
 * 而 hls.js 默认按码率挑第一条 → 永远挑到它 → 「列表能加载、一个画面都出不来」。
 * 真正能拿到分片的是带 `&raw=1` 的兄弟清晰度（真 TS 直链，magic 47401110）。
 * 所以这里钉死三件事：排序、删除、结构不明时不动手。
 */
describe('hoistPlayableVariants', () => {
  it('raw=1 排到最前，并且把同 id 的「无 raw」占位版本删掉', () => {
    const src = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000000',
      '/api/dyrs/cdn/m3u8?id=media-1',
      '#EXT-X-STREAM-INF:BANDWIDTH=900000',
      '/api/dyrs/cdn/m3u8?id=media-1&raw=1',
    ].join('\n');

    const out = hoistPlayableVariants(src);
    const lines = out.split('\n');
    const iRaw = lines.findIndex((l) => l.includes('raw=1'));
    const iPlain = lines.findIndex((l) => l.endsWith('cdn/m3u8?id=media-1'));
    expect(iRaw).toBeGreaterThan(-1);
    expect(iPlain).toBe(-1); // 占位版本被删掉
    expect(lines.filter((l) => l.startsWith('#EXT-X-STREAM-INF')).length).toBe(1);
    expect(lines[0]).toBe('#EXTM3U'); // 全局标签还在最前
  });

  it('direct 系仍然优先于 raw=1', () => {
    const src = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000000',
      '/api/dyrs/cdn/m3u8?id=media-1',
      '#EXT-X-STREAM-INF:BANDWIDTH=900000',
      '/api/dyrs/cdn/m3u8?id=media-1&raw=1',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000',
      '/api/dyrs/direct?id=vid-1&origin=vip1',
    ].join('\n');

    const lines = hoistPlayableVariants(src).split('\n');
    const iDirect = lines.findIndex((l) => l.includes('/api/dyrs/direct?'));
    const iRaw = lines.findIndex((l) => l.includes('raw=1'));
    expect(iDirect).toBeGreaterThan(-1);
    expect(iDirect).toBeLessThan(iRaw);
    expect(lines.filter((l) => l.startsWith('#EXT-X-STREAM-INF')).length).toBe(2);
  });

  it('不同 id 互不影响：raw=1 只删自己那条的兄弟，但 raw 那条要提到前面', () => {
    const src = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000000',
      '/api/dyrs/cdn/m3u8?id=media-A',
      '#EXT-X-STREAM-INF:BANDWIDTH=900000',
      '/api/dyrs/cdn/m3u8?id=media-B&raw=1',
    ].join('\n');

    const out = hoistPlayableVariants(src);
    expect(out).toContain('cdn/m3u8?id=media-A');
    expect(out).toContain('cdn/m3u8?id=media-B&raw=1');
    expect(out.indexOf('raw=1')).toBeLessThan(out.indexOf('id=media-A'));
  });

  it('没有 raw / direct 系就原样返回（不动手）', () => {
    const src = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n/api/dyrs/cdn/m3u8?id=x\n';
    expect(hoistPlayableVariants(src)).toBe(src);
  });

  it('media 列表（没有 STREAM-INF）原样返回', () => {
    const src = '#EXTM3U\n#EXTINF:3,\n/api/dyrs/cdn/ts?m3u8_id=a&index=0&uuid=b\n';
    expect(hoistPlayableVariants(src)).toBe(src);
  });

  it('变体区间里夹着别的行就保守放弃（不乱动结构）', () => {
    const src = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000000',
      '/api/dyrs/cdn/m3u8?id=media-1',
      '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1',
      '#EXT-X-STREAM-INF:BANDWIDTH=900000',
      '/api/dyrs/cdn/m3u8?id=media-1&raw=1',
    ].join('\n');
    expect(hoistPlayableVariants(src)).toBe(src);
  });
});

describe('looksLikePlaceholder', () => {
  it('认得出 PNG 占位图（uuid 不配对时上游的典型行为）', () => {
    expect(looksLikePlaceholder(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe(true);
  });

  it('认得出 GIF / JPEG', () => {
    expect(looksLikePlaceholder(Buffer.from('GIF89a......'))).toBe(true);
    expect(looksLikePlaceholder(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
  });

  it('认得出 HTML 错误页', () => {
    expect(looksLikePlaceholder(Buffer.from('<!DOCTYPE html><html>'))).toBe(true);
  });

  it('正常的 TS 分片不能被误判（0x47 同步字节）', () => {
    // MPEG-TS：每 188 字节以 0x47 开头
    const ts = Buffer.alloc(376, 0x00);
    ts[0] = 0x47;
    ts[188] = 0x47;
    expect(looksLikePlaceholder(ts)).toBe(false);
  });

  it('太短的响应视为无效', () => {
    expect(looksLikePlaceholder(Buffer.from([0x47]))).toBe(true);
    expect(looksLikePlaceholder(Buffer.alloc(0))).toBe(true);
  });
});

describe('isPlaylistType', () => {
  it('按 content-type 判断', () => {
    expect(isPlaylistType('application/vnd.apple.mpegurl', '')).toBe(true);
    expect(isPlaylistType('application/x-mpegURL', '')).toBe(true);
    expect(isPlaylistType('video/mp2t', '...')).toBe(false);
  });

  it('content-type 缺失时按正文首行兜底', () => {
    expect(isPlaylistType('', '#EXTM3U\n#EXTINF:3,')).toBe(true);
    expect(isPlaylistType('application/octet-stream', '#EXTM3U')).toBe(true);
    expect(isPlaylistType('', '\x47binary')).toBe(false);
  });
});
