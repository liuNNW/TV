/**
 * 并发压测脚本：测服务器在我们这种使用强度下的 CPU / 内存 / 吞吐。
 *
 * 用法: node scripts/loadtest.mjs [并发数] [持续秒数]
 */

const BASE = process.env.BASE || 'http://127.0.0.1:8848';
const CONC = Number(process.argv[2] || 20);
const SECONDS = Number(process.argv[3] || 30);

// 覆盖各类接口，模拟真实使用
const PATHS = [
  () => `/api/list?type=11&source=lziapi&page=${1 + Math.floor(Math.random() * 200)}`,
  () => `/api/list?type=6&source=lziapi&page=${1 + Math.floor(Math.random() * 200)}`,
  () => `/api/channels`,
  () => `/api/search?wd=${encodeURIComponent('动作')}`,
];

let ok = 0;
let fail = 0;
let bytes = 0;
let latSum = 0;
let latMax = 0;

const deadline = Date.now() + SECONDS * 1000;

async function worker(id) {
  while (Date.now() < deadline) {
    const path = PATHS[(id + ok) % PATHS.length]();
    const t0 = Date.now();
    try {
      const r = await fetch(BASE + path);
      const buf = await r.arrayBuffer();
      const dt = Date.now() - t0;
      if (r.ok) {
        ok++;
        bytes += buf.byteLength;
        latSum += dt;
        if (dt > latMax) latMax = dt;
      } else {
        fail++;
      }
    } catch {
      fail++;
    }
  }
}

const t0 = Date.now();
await Promise.all(Array.from({ length: CONC }, (_, i) => worker(i)));
const elapsed = (Date.now() - t0) / 1000;

console.log(`并发 ${CONC}，持续 ${elapsed.toFixed(1)}s`);
console.log(`  成功 ${ok}  失败 ${fail}`);
console.log(`  吞吐 ≈ ${(ok / elapsed).toFixed(1)} req/s`);
console.log(`  平均延迟 ${ok ? (latSum / ok).toFixed(0) : 0} ms，最大 ${latMax} ms`);
console.log(`  服务器出流量 ≈ ${(bytes / 1024 / 1024).toFixed(2)} MB`);
