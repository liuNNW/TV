/**
 * 端到端验收脚本。
 *
 * 逐条核对计划里的 7 条成功标准，全部通过才打印 PASS。
 * 用法: node scripts/acceptance.mjs
 */

const B = process.env.BASE || 'http://127.0.0.1:8848';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0';

let pass = 0;
let fail = 0;

function ok(label, detail = '') {
  pass++;
  console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? '  ' + detail : ''}`);
}
function bad(label, detail = '') {
  fail++;
  console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? '  ' + detail : ''}`);
}

async function getJson(path, timeoutMs = 60000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(B + path, { signal: ac.signal });
    const j = await r.json();
    return { status: r.status, json: j };
  } finally {
    clearTimeout(t);
  }
}

async function head(url, timeoutMs = 30000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: { 'User-Agent': UA, Range: 'bytes=0-1023' },
    });
    return { status: r.status, ct: r.headers.get('content-type'), cors: r.headers.get('access-control-allow-origin') };
  } catch (e) {
    return { status: 0, error: e.message };
  } finally {
    clearTimeout(t);
  }
}

console.log('\n=== 影视播放站 端到端验收 ===\n');

/* ---- 1. 服务启动 ---- */
console.log('[1] 服务启动与首页');
try {
  const r = await fetch(B + '/');
  const html = await r.text();
  if (r.status === 200 && html.includes('影视播放站')) ok('首页可访问', `HTTP ${r.status}, ${html.length} 字节`);
  else bad('首页异常', `HTTP ${r.status}`);
} catch (e) {
  bad('首页无法访问', e.message);
}

/* ---- 2. 搜索 ---- */
console.log('\n[2] 搜索「兰香如故」');
let searched = null;
try {
  const r = await getJson(`/api/search?wd=${encodeURIComponent('兰香如故')}`);
  const items = r.json.items || [];
  searched = items[0] || null;
  if (r.json.ok && items.length > 0) {
    ok('搜索命中', `${items.length} 条, 首条=${searched.name} (${searched.year}/${searched.area}) 源=${searched.sourceName}`);
  } else {
    bad('搜索无结果', JSON.stringify(r.json).slice(0, 120));
  }
  if (r.json.failed?.length) console.log(`      注: 失效源 ${r.json.failed.join(',')}（故障转移已生效）`);
} catch (e) {
  bad('搜索请求失败', e.message);
}

/* ---- 3. 详情 + 线路 + 集数 ---- */
console.log('\n[3] 详情 / 线路 / 选集');
let detail = null;
if (searched) {
  try {
    const r = await getJson(
      `/api/detail?id=${searched.id}&source=${searched.source}&name=${encodeURIComponent(searched.name)}`,
    );
    detail = r.json.detail;
    if (detail && detail.name === searched.name) {
      const lines = detail.lines || [];
      const playable = lines.filter((l) => l.playable);
      const totalEps = lines.reduce((n, l) => n + l.episodes.length, 0);
      ok('详情正确', `${detail.name} | 线路 ${lines.length} 条（可播 ${playable.length}）| 合计 ${totalEps} 集`);
      for (const l of lines) {
        console.log(`      ${l.playable ? '可播' : '分享页'} ${l.name}: ${l.episodes.length} 集`);
      }
      if (lines.length === 0) bad('详情没有任何线路');
    } else {
      bad('详情片名不匹配（跨源 id 撞车保护）', `期望=${searched.name} 实际=${detail?.name}`);
    }
  } catch (e) {
    bad('详情请求失败', e.message);
  }
} else {
  bad('跳过详情：没有搜索结果');
}

/* ---- 4. 播放地址可直连 ---- */
console.log('\n[4] 播放链路（直连 CDN）');
let playUrl = null;
if (detail?.lines?.length) {
  const line = detail.lines.find((l) => l.playable) || detail.lines[0];
  playUrl = line.episodes[0]?.url;
  if (playUrl) {
    const h = await head(playUrl);
    // 带了 Range 头，CDN 回 206 Partial Content 是正常且正确的
    const statusOk = h.status === 200 || h.status === 206;
    if (statusOk && (h.ct || '').includes('mpegurl')) {
      ok('首集 m3u8 可取', `HTTP ${h.status}, ${h.ct}, CORS=${h.cors || '无'}`);
    } else {
      bad('首集 m3u8 取不到', `HTTP ${h.status} ct=${h.ct} err=${h.error || ''}`);
    }
  } else {
    bad('没有播放地址');
  }
} else {
  bad('跳过播放：没有详情');
}

/* ---- 5. 代理兜底 ---- */
console.log('\n[5] 本机代理（兜底路径）');
if (playUrl) {
  try {
    const r = await getJson(`/api/proxy?url=${encodeURIComponent(playUrl)}`);
    console.log('      注: 代理返回的是 m3u8 文本，这里只验证 HTTP 层');
  } catch { /* 非 JSON 正常 */ }

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 30000);
  try {
    const r = await fetch(`${B}/api/proxy?url=${encodeURIComponent(playUrl)}`, { signal: ac.signal });
    const text = await r.text();
    const rewritten = text.includes('/api/proxy?url=');
    if (r.status === 200 && (rewritten || text.startsWith('#EXTM3U'))) {
      ok('代理可取 m3u8 且内部地址已重写', `HTTP 200, 重写=${rewritten}`);
    } else {
      bad('代理返回异常', `HTTP ${r.status}, 前 80 字: ${text.slice(0, 80)}`);
    }
  } catch (e) {
    bad('代理请求失败', e.message);
  } finally {
    clearTimeout(t);
  }
} else {
  bad('跳过代理：没有播放地址');
}

/* ---- 6. SSRF 防护 ---- */
console.log('\n[6] SSRF 防护（必须全部拒绝）');
const ssrfCases = [
  ['回环', 'http://127.0.0.1:8848/api/health'],
  ['localhost', 'http://localhost:8848/api/health'],
  ['file 协议', 'file:///C:/Windows/win.ini'],
  ['私有网段', 'http://192.168.1.1/'],
  ['云元数据', 'http://169.254.169.254/latest/meta-data/'],
  ['gopher', 'gopher://127.0.0.1:6379/_PING'],
];
for (const [label, target] of ssrfCases) {
  try {
    const r = await fetch(`${B}/api/proxy?url=${encodeURIComponent(target)}`);
    if (r.status === 403) ok(`拒绝 ${label}`, 'HTTP 403');
    else bad(`放行了 ${label}`, `HTTP ${r.status}`);
  } catch (e) {
    bad(`${label} 请求异常`, e.message);
  }
}

/* ---- 7. 收藏 / 历史 / 续播 ---- */
console.log('\n[7] 收藏与续播持久化');
if (searched) {
  try {
    // 收藏
    await fetch(B + '/api/favorites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: searched.id, name: searched.name, source: searched.source, year: searched.year }),
    });
    const favs = await getJson('/api/favorites');
    const hasFav = favs.json.items.some((f) => f.id === searched.id && f.source === searched.source);
    hasFav ? ok('收藏写入并读回', `${favs.json.items.length} 条`) : bad('收藏未生效');

    // 进度
    await fetch(B + '/api/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: searched.id, name: searched.name, source: searched.source,
        lineIndex: 0, episodeIndex: 2, episodeName: '第03集', position: 631, duration: 2400,
      }),
    });
    const prog = await getJson(`/api/progress?id=${searched.id}&source=${searched.source}`);
    const e = prog.json.entry;
    if (e && e.position === 631 && e.episodeName === '第03集') {
      ok('续播进度读回', `${e.episodeName} @ ${e.position}s / ${e.duration}s`);
    } else {
      bad('续播进度不正确', JSON.stringify(e));
    }
  } catch (e) {
    bad('收藏/进度测试异常', e.message);
  }
}

/* ---- 附加：分类 / 列表 / 只绑本机 ---- */
console.log('\n[附加] 分类探测 / 列表 / 监听地址');
try {
  const c = await getJson('/api/categories?force=1', 180000);
  const n = c.json.categories?.length || 0;
  n > 5 ? ok('分类探测', `${n} 个分类, 首位=${c.json.categories[0].name}(${c.json.categories[0].total})`) : bad('分类探测结果过少', `${n}`);
} catch (e) {
  bad('分类探测失败', e.message);
}

try {
  const l = await getJson('/api/list?type=6&source=lziapi&page=1');
  const n = l.json.items?.length || 0;
  n > 0 ? ok('分类列表', `${n} 条, 共 ${l.json.pageCount} 页 / ${l.json.total} 部`) : bad('列表为空');
} catch (e) {
  bad('列表失败', e.message);
}

/* ---- 附加 2：频道分层 + 封面 ---- */
console.log('\n[附加2] 频道分层与封面');

try {
  const c = await getJson('/api/channels?force=1', 240000);
  const chans = c.json.channels || [];
  const names = chans.map((x) => x.name);
  if (chans.length > 0 && chans.length <= 8) {
    ok('频道分层', `${chans.length} 个频道: ${names.join('/')}`);
  } else {
    bad('频道数量异常', `${chans.length} 个`);
  }

  // 僵尸分类必须已被过滤
  const small = chans.flatMap((x) => x.categories).filter((x) => x.total < 50);
  small.length === 0
    ? ok('僵尸分类已过滤', '没有 total<50 的分类')
    : bad('仍存在僵尸分类', small.map((x) => `${x.name}(${x.total})`).join(','));

  // 每个频道都要有分类
  const empty = chans.filter((x) => !x.categories || x.categories.length === 0);
  empty.length === 0 ? ok('每个频道都有分类') : bad('有空频道', empty.map((x) => x.name).join(','));

  // 电影频道里不应该混进「剧」结尾的分类
  const film = chans.find((x) => x.name === '电影');
  if (film) {
    const bad2 = film.categories.filter((x) => /(剧|动漫|综艺)$/.test(x.name));
    bad2.length === 0
      ? ok('电影频道分类归属正确', `如 ${film.categories.slice(0, 3).map((x) => x.name).join('/')}`)
      : bad('电影频道混入了其他类型', bad2.map((x) => x.name).join(','));
  }
} catch (e) {
  bad('频道接口失败', e.message);
}

// 封面：列表本身不带图，必须靠 /api/covers 补齐
try {
  const l = await getJson('/api/list?type=6&source=lziapi&page=1');
  const items = l.json.items || [];
  const ids = items.map((x) => x.id).join(',');
  const c = await getJson(`/api/covers?ids=${encodeURIComponent(ids)}&source=lziapi`, 180000);
  const covers = c.json.covers || {};
  const withPic = items.filter((x) => covers[x.id]?.pic).length;
  const withYear = items.filter((x) => covers[x.id]?.year).length;

  withPic === items.length
    ? ok('封面全部补齐', `${withPic}/${items.length}`)
    : bad('封面缺失', `只有 ${withPic}/${items.length}`);
  withYear > 0
    ? ok('年份已补齐', `${withYear}/${items.length}`)
    : bad('年份缺失');
} catch (e) {
  bad('封面接口失败', e.message);
}

// 封面图本身要能取到
try {
  const l = await getJson('/api/list?type=6&source=lziapi&page=1');
  const ids = (l.json.items || []).slice(0, 3).map((x) => x.id).join(',');
  const c = await getJson(`/api/covers?ids=${encodeURIComponent(ids)}&source=lziapi`, 120000);
  const first = Object.values(c.json.covers || {})[0];
  if (first?.pic) {
    const h = await head(first.pic);
    // 带了 Range 头，206 也是正常的
    const okStatus = h.status === 200 || h.status === 206;
    okStatus
      ? ok('封面图可访问', `${h.ct}, ${h.cors ? 'CORS=' + h.cors : '无CORS(将走代理)'}`)
      : bad('封面图取不到', `HTTP ${h.status}`);
  } else {
    bad('没有拿到封面地址');
  }
} catch (e) {
  bad('封面可访问性测试失败', e.message);
}

/* ---- 汇总 ---- */
console.log(`\n=== 结果: ${pass} 通过, ${fail} 失败 ===\n`);
process.exit(fail === 0 ? 0 : 1);
