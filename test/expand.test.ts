import { describe, expect, it } from 'vitest';
import { absolutize, extractM3u8 } from '../src/expand.js';
import { isSharePage, looksLikeHls } from '../src/parser.js';

/**
 * 分享页 / 播放页解析。
 *
 * 背景：采集站大量线路给的是一条网页（`…/share/<hash>`、`…/play/<id>`），
 * 页面里写着带 `sign` 的真 m3u8。以前我们只按 URL 里有没有 `.m3u8` 判定「不可播」，
 * 界面因此挂满 ⚠ —— 实测《嫁金钗》5 条这样的线路全部能解析出来，分片是标准 TS。
 */
describe('isSharePage', () => {
  it('识别 /share/ 与 /play/ 页面', () => {
    expect(isSharePage('https://v.lzcdn27.com/share/42a35b21c91691fb5cd8724fa1a105ec')).toBe(true);
    expect(isSharePage('https://hn.bfvvs.com/play/bW6w8XXa')).toBe(true);
    expect(isSharePage('https://hd.kuktxu.com/play/eZ6wWNEe')).toBe(true);
  });

  it('真 m3u8 和其他地址不算分享页', () => {
    expect(isSharePage('https://v.lzcdn27.com/20261016/x/index.m3u8')).toBe(false);
    expect(isSharePage('/api/proxy?url=https%3A%2F%2Fv.lzcdn27.com%2Fx.m3u8')).toBe(false);
    expect(isSharePage('https://cdn.example.com/movie.mp4')).toBe(false);
    expect(isSharePage('')).toBe(false);
  });

  it('looksLikeHls 和 isSharePage 互补（不会同时为真）', () => {
    const share = 'https://v.lzcdn27.com/share/abc';
    expect(looksLikeHls(share)).toBe(false);
    expect(isSharePage(share)).toBe(true);
  });
});

describe('extractM3u8', () => {
  const page = 'https://v.lzcdn27.com/share/42a35b21c91691fb5cd8724fa1a105ec';

  it('形状 1：var main = "/path/index.m3u8?sign=…"', () => {
    const html = '<script>var main = "/20261016/19360_5c14cbf9/index.m3u8?sign=5f9e2dbd";</script>';
    const r = extractM3u8(html, page);
    expect(r?.from).toBe('main');
    expect(r?.url).toBe('https://v.lzcdn27.com/20261016/19360_5c14cbf9/index.m3u8?sign=5f9e2dbd');
  });

  it('形状 2：const url = "/path/index.m3u8?sign=…"', () => {
    const html = '<script>const url = "/20261016/43456_26a9c7ab/index.m3u8?sign=0d512c96";</script>';
    const r = extractM3u8(html, 'https://super.ffzy-online6.com/share/26a9c7ab');
    expect(r?.url).toBe('https://super.ffzy-online6.com/20261016/43456_26a9c7ab/index.m3u8?sign=0d512c96');
  });

  it('形状 3：const vid = 绝对地址', () => {
    const html = "<script>const vid = 'https://hd.kuktxu.com/play/eZ6wWNEe/index.m3u8';</script>";
    const r = extractM3u8(html, 'https://hd.kuktxu.com/play/eZ6wWNEe');
    expect(r?.url).toBe('https://hd.kuktxu.com/play/eZ6wWNEe/index.m3u8');
  });

  it('塞在 JSON 里的 m3u8 也能抓到（标记为 inline）', () => {
    const plain = '{"code":1,"data":{"play":"https://cdn.x.com/a/index.m3u8"}}';
    expect(extractM3u8(plain, page)?.from).toBe('inline');

    // JSON 里常见的转义斜杠（`https:\/\/…`）要还原成正常地址，而不是留着反斜杠
    const escaped = '{"code":1,"data":{"play":"https:\\/\\/cdn.x.com\\/a\\/index.m3u8"}}';
    expect(extractM3u8(escaped, page)?.url).toBe('https://cdn.x.com/a/index.m3u8');
  });

  it('页面里没有 m3u8 就返回 null（不要瞎猜）', () => {
    expect(extractM3u8('<html><body>广告位</body></html>', page)).toBeNull();
    expect(extractM3u8('', page)).toBeNull();
  });
});

describe('absolutize', () => {
  const base = 'https://v.lzcdn27.com/share/abc';

  it('绝对地址原样返回', () => {
    expect(absolutize('https://cdn.x.com/a.m3u8', base)).toBe('https://cdn.x.com/a.m3u8');
  });

  it('根路径按 host 拼接', () => {
    expect(absolutize('/20261016/x/index.m3u8', base)).toBe('https://v.lzcdn27.com/20261016/x/index.m3u8');
  });

  it('协议相对地址（//host/path）补 https', () => {
    expect(absolutize('//cdn.x.com/a.m3u8', base)).toBe('https://cdn.x.com/a.m3u8');
  });

  it('空值 / 非法值返回空串', () => {
    expect(absolutize('', base)).toBe('');
    expect(absolutize('   ', base)).toBe('');
  });
});
