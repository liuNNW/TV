#!/usr/bin/env node
/**
 * 片源探测：一条命令判断「这个源还能不能用、能给多少内容」。
 *
 * 为什么要有这个脚本：
 *   加源以前是手工 `curl` 一个个试，试完还要肉眼比 total，很容易把死源留在
 *   `src/config.ts` 里（2026-10-25 实测 11 个配置源里 3 个已经超时不可达）。
 *   把这件事做成脚本，以后「加一个源」「复测一批源」都是粘地址就跑。
 *
 * 支持两类上游：
 *   1. macCMS 采集接口（`api.php/provide/vod/`）—— 本站主库用，看 ac=list 是否 200 + total
 *   2. wzzycc 模板站（dyrs / tvcang / viprs 那一族）—— 本站影视仓用，看镜像数与卡片数
 *
 * 用法：
 *   node scripts/source-probe.mjs --maccms https://cj.lziapi.com/api.php/provide/vod/
 *   node scripts/source-probe.mjs --wzzycc https://viprs3.cc https://tvcang.com
 *   node scripts/source-probe.mjs --maccms <url1> <url2> --wzzycc <url3> --timeout 20
 *
 * 退出码：全活 0，有任何一个失败 1（方便塞进 CI / 部署前检查）。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/* ---------------- 参数解析 ---------------- */

function parseArgs(argv) {
  const out = { maccms: [], wzzycc: [], timeout: 15 };
  let bucket = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--maccms') { bucket = 'maccms'; continue; }
    if (a === '--wzzycc') { bucket = 'wzzycc'; continue; }
    if (a === '--timeout') { out.timeout = Math.max(1, Number(argv[++i]) || 15); bucket = null; continue; }
    if (a === '-h' || a === '--help') { out.help = true; continue; }
    if (a.startsWith('--')) { bucket = null; continue; }
    if (bucket) out[bucket].push(a);
  }
  return out;
}

/* ---------------- 抓取 ---------------- */

async function get(url, timeoutSec, accept = 'text/html,*/*') {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutSec * 1000);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: accept },
      signal: ac.signal,
      redirect: 'follow',
    });
    const body = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      ms: Date.now() - started,
      bytes: Buffer.byteLength(body, 'utf8'),
      body,
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      ms: Date.now() - started,
      bytes: 0,
      body: '',
      error: e?.name === 'AbortError' ? `超时 ${timeoutSec}s` : String(e?.message || e),
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- macCMS 探测 ---------------- */

/** 补上 `?ac=list`（已经有查询串就只补 ac） */
function maccmsListUrl(base) {
  const u = new URL(base);
  if (!u.searchParams.has('ac')) u.searchParams.set('ac', 'list');
  return u.toString();
}

/**
 * 从 ac=list 的返回体里读条数与总量。
 * 兼容 JSON（多数）和 XML（少数站点）—— 不追求完整解析，只要拿到「有没有内容」。
 */
function readMacCms(body) {
  const trimmed = body.trim();

  if (trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(trimmed);
      const list = Array.isArray(j?.list) ? j.list : [];
      return { format: 'json', count: list.length, total: Number(j?.total) || 0 };
    } catch {
      // 落到下面的按标签数
    }
  }

  // XML：数 <video> 节点
  const count = (body.match(/<video>/g) || []).length;
  const totalMatch = body.match(/<total>(\d+)<\/total>/);
  return { format: 'xml', count, total: totalMatch ? Number(totalMatch[1]) : 0 };
}

async function probeMacCms(base, timeoutSec) {
  const url = maccmsListUrl(base);
  const r = await get(url, timeoutSec, 'application/json,text/xml,*/*');
  if (!r.ok) {
    return { kind: 'maccms', base, ok: false, status: r.status, ms: r.ms, error: r.error || `HTTP ${r.status}` };
  }
  const info = readMacCms(r.body);
  return {
    kind: 'maccms',
    base,
    ok: info.count > 0,
    status: r.status,
    ms: r.ms,
    bytes: r.bytes,
    format: info.format,
    count: info.count,
    total: info.total,
    error: info.count > 0 ? '' : '返回体里没有可用条目（可能是空库或挑战页）',
  };
}

/* ---------------- wzzycc 模板探测 ---------------- */

/** 上游反爬：命中时是 6627B 的「正在检测」页，HTTP 429 */
function isChallenge(body) {
  return body.length < 40_000 && /正在检测/.test(body) && /sha1\(hash\s*\+\s*i\)/.test(body);
}

const CARD_HREF_RE = /href="\/(movie|tv|zongyi|duanju)\/[0-9a-f]+-\d+\.html"/g;

async function probeWzzycc(base, timeoutSec) {
  const root = base.replace(/\/+$/, '');

  const least = await get(`${root}/api/videox/least`, timeoutSec, 'application/json,*/*');
  let lines = 0;
  if (least.ok) {
    try {
      const j = JSON.parse(least.body);
      lines = Array.isArray(j?.urls) ? j.urls.length : 0;
    } catch {
      // 保持 0
    }
  }

  const page = await get(`${root}/dianying.html`, timeoutSec);
  const cards = page.ok ? (page.body.match(CARD_HREF_RE) || []).length : 0;
  const challenged = page.ok && isChallenge(page.body);
  const maxPageMatch = [...page.body.matchAll(/[?&]page=(\d+)/g)].map((m) => Number(m[1]));
  const maxPage = maxPageMatch.length ? Math.max(...maxPageMatch) : 0;

  return {
    kind: 'wzzycc',
    base: root,
    ok: !challenged && cards > 0,
    status: page.status,
    ms: page.ms,
    bytes: page.bytes,
    lines,
    cards,
    maxPage,
    error: challenged
      ? '被反爬挑战（429 正在检测页）—— 本站服务端会自动解题，脚本不模拟'
      : page.error || (cards > 0 ? '' : `HTTP ${page.status}`),
  };
}

/* ---------------- 输出 ---------------- */

function pad(s, n) {
  const str = String(s ?? '');
  // 中文按两格宽估算，够对齐就行
  const width = [...str].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return str + ' '.repeat(Math.max(0, n - width));
}

function printTable(rows) {
  const head = ['状态', '上游', '耗时', '体积', '内容', '说明'];
  console.log(
    pad(head[0], 6) + pad(head[1], 44) + pad(head[2], 9) + pad(head[3], 10) + pad(head[4], 22) + head[5],
  );
  console.log('-'.repeat(120));
  for (const r of rows) {
    const state = r.ok ? '✅' : '❌';
    const content =
      r.kind === 'maccms'
        ? `${r.count ?? 0} 条 / total ${r.total ?? 0}`
        : `${r.lines ?? 0} 镜像 / ${r.cards ?? 0} 卡 / ${r.maxPage ?? 0} 页`;
    console.log(
      pad(state, 6) +
        pad(r.base, 44) +
        pad(`${r.ms}ms`, 9) +
        pad(r.bytes != null ? `${Math.round(r.bytes / 1024)}KB` : '-', 10) +
        pad(content, 22) +
        (r.error || ''),
    );
  }
}

/**
 * 从域名推一个好读的短 id。
 * 去掉 `www` / `cj` / `api` / `caiji` 这类通用前缀，取第一个实义标签：
 *   cj.lziapi.com → lziapi · caiji.dyttzyapi.com → dyttzyapi · 360zy.com → 360zy
 */
function brandOf(host) {
  const generic = new Set(['www', 'cj', 'api', 'caiji', 'collect', 'm3u8', 'v', 'www1', 'www2']);
  const labels = host.split('.').filter(Boolean);
  const hit = labels.find((l) => !generic.has(l.toLowerCase()) && !/^\d+$/.test(l));
  const raw = hit ?? labels[0] ?? host;
  return raw.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'source';
}

/** 输出可直接粘进 src/config.ts 的片段（只列活着的 macCMS 源） */
function printSourcesSnippet(rows) {
  const live = rows.filter((r) => r.kind === 'maccms' && r.ok);
  if (!live.length) return;

  const used = new Set();
  console.log('\n可粘进 src/config.ts 的 SOURCES 片段（name 是域名占位，改成中文站名再提交）：');
  console.log('export const SOURCES: SourceConfig[] = [');
  for (const r of live) {
    const host = new URL(r.base).hostname;
    let id = brandOf(host);
    // id 撞了就加后缀，别让两行生成同一个 key
    let n = 2;
    while (used.has(id)) id = `${brandOf(host)}${n++}`;
    used.add(id);
    console.log(`  {`);
    console.log(`    id: '${id}',`);
    console.log(`    name: '${host}', // TODO 改成中文站名`);
    console.log(`    base: '${r.base.endsWith('/') ? r.base : `${r.base}/`}',`);
    console.log(`  },`);
  }
  console.log('];');
}

/* ---------------- 主流程 ---------------- */

const args = parseArgs(process.argv.slice(2));

if (args.help || (args.maccms.length === 0 && args.wzzycc.length === 0)) {
  console.log(`用法：
  node scripts/source-probe.mjs --maccms <采集接口地址...>
  node scripts/source-probe.mjs --wzzycc <模板站根地址...>
  node scripts/source-probe.mjs --maccms <url> --wzzycc <url> --timeout 20

两类上游可以混着测；--timeout 单位是秒，默认 15。`);
  process.exit(args.help ? 0 : 2);
}

const jobs = [
  ...args.maccms.map((b) => () => probeMacCms(b, args.timeout)),
  ...args.wzzycc.map((b) => () => probeWzzycc(b, args.timeout)),
];

console.log(`探测 ${jobs.length} 个上游（超时 ${args.timeout}s，并发执行）…\n`);

const rows = await Promise.all(jobs.map((run) => run()));

printTable(rows);
printSourcesSnippet(rows);

const failed = rows.filter((r) => !r.ok);
console.log(`\n合计 ${rows.length} 个：可用 ${rows.length - failed.length}，不可用 ${failed.length}`);
process.exit(failed.length === 0 ? 0 : 1);
