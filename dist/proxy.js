/**
 * 媒体代理：兜底播放路径。
 *
 * 正常情况下浏览器直连 CDN（那些 CDN 都带 Access-Control-Allow-Origin: *），
 * 只有直连失败（CORS / Referer 校验 / 网络）时才回落到这里。
 *
 * 媒体代理是典型的 SSRF 入口，所以安全校验是重点：
 *   - 只允许 http/https
 *   - 解析主机名后拒绝私有网段 / 回环 / 链路本地地址
 *   - 限制并发与速率
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { PROXY_MAX_CONCURRENCY, PROXY_RATE_PER_SEC, } from './config.js';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
/** 判断 IPv4 是否属于私有/保留网段 */
function isPrivateIPv4(ip) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
        return true;
    }
    const [a, b] = parts;
    if (a === 10)
        return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31)
        return true; // 172.16.0.0/12
    if (a === 192 && b === 168)
        return true; // 192.168.0.0/16
    if (a === 127)
        return true; // 回环
    if (a === 169 && b === 254)
        return true; // 链路本地（云元数据接口）
    if (a === 0)
        return true;
    if (a >= 224)
        return true; // 组播/保留
    return false;
}
/** 判断 IPv6 是否属于私有/回环 */
function isPrivateIPv6(ip) {
    const s = ip.toLowerCase();
    if (s === '::1' || s === '::')
        return true;
    if (s.startsWith('fe80'))
        return true; // 链路本地
    if (s.startsWith('fc') || s.startsWith('fd'))
        return true; // 唯一本地
    if (s.startsWith('::ffff:')) {
        // IPv4 映射地址，按 IPv4 规则再查一次
        const v4 = s.slice(7);
        return isPrivateIPv4(v4);
    }
    return false;
}
function isPrivateAddress(ip) {
    const v = isIP(ip);
    if (v === 4)
        return isPrivateIPv4(ip);
    if (v === 6)
        return isPrivateIPv6(ip);
    return true; // 无法识别一律拒绝
}
/**
 * 校验目标 URL 是否允许代理。
 * 返回 null 表示通过，否则返回拒绝原因。
 */
export async function checkUrl(raw) {
    let u;
    try {
        u = new URL(raw);
    }
    catch {
        return '地址格式非法';
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return `不支持的协议: ${u.protocol}`;
    }
    const host = u.hostname;
    // 直接是 IP 的情况
    if (isIP(host)) {
        if (isPrivateAddress(host))
            return '拒绝对私有/回环地址的访问';
        return null;
    }
    // 明显的内网主机名
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
        return '拒绝内网主机名';
    }
    // 域名解析后逐一检查（防 DNS 指向内网）
    try {
        const addrs = await lookup(host, { all: true });
        if (addrs.length === 0)
            return '域名无法解析';
        for (const a of addrs) {
            if (isPrivateAddress(a.address)) {
                return '域名解析到私有/回环地址';
            }
        }
    }
    catch {
        return '域名解析失败';
    }
    return null;
}
/** 简单令牌桶限流 */
class RateLimiter {
    rate;
    burst;
    tokens;
    last = Date.now();
    constructor(rate, burst) {
        this.rate = rate;
        this.burst = burst;
        this.tokens = burst;
    }
    tryAcquire() {
        const now = Date.now();
        this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
        this.last = now;
        if (this.tokens < 1)
            return false;
        this.tokens -= 1;
        return true;
    }
}
const limiter = new RateLimiter(PROXY_RATE_PER_SEC, PROXY_RATE_PER_SEC);
let active = 0;
/**
 * 代理一次上游请求。
 *
 * @param target 上游地址
 * @param referer 需要伪造的 Referer（有些 CDN 校验来源）
 * @param rewritePlaylist 是否把 m3u8 内的地址重写回本代理
 * @param selfBase 本机代理前缀，如 http://127.0.0.1:8848/api/proxy?url=
 */
export async function proxyFetch(target, opts = {}) {
    const deny = await checkUrl(target);
    if (deny) {
        return { status: 403, contentType: 'text/plain; charset=utf-8', body: Buffer.from(deny, 'utf8') };
    }
    if (!limiter.tryAcquire()) {
        return {
            status: 429,
            contentType: 'text/plain; charset=utf-8',
            body: Buffer.from('请求过于频繁，请稍后重试', 'utf8'),
        };
    }
    if (active >= PROXY_MAX_CONCURRENCY) {
        return {
            status: 503,
            contentType: 'text/plain; charset=utf-8',
            body: Buffer.from('代理并发已满，请稍后重试', 'utf8'),
        };
    }
    active++;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20_000);
    try {
        const headers = {
            'User-Agent': UA,
            Accept: '*/*',
        };
        if (opts.referer) {
            headers.Referer = opts.referer;
            // Origin 也用上，部分 CDN 两者都看
            try {
                headers.Origin = new URL(opts.referer).origin;
            }
            catch {
                // referer 不是合法 URL 就忽略 Origin
            }
        }
        const upstream = await fetch(target, { headers, signal: ac.signal, redirect: 'follow' });
        const buf = Buffer.from(await upstream.arrayBuffer());
        let contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
        // m3u8 需要重写内部地址，否则分片仍会直连（可能同样失败）
        const isPlaylist = contentType.includes('mpegurl') ||
            contentType.includes('m3u') ||
            target.toLowerCase().includes('.m3u8');
        if (isPlaylist && opts.rewritePlaylist && opts.selfBase) {
            const text = buf.toString('utf8');
            const rewritten = rewriteM3u8(text, upstream.url || target, opts.selfBase);
            return {
                status: upstream.status,
                contentType: 'application/vnd.apple.mpegurl',
                body: Buffer.from(rewritten, 'utf8'),
                finalUrl: upstream.url || target,
            };
        }
        // 分片是二进制，不能当文本处理
        if (target.toLowerCase().includes('.html') && buf.length > 0 && buf[0] === 0x47) {
            contentType = 'video/mp2t';
        }
        return { status: upstream.status, contentType, body: buf, finalUrl: upstream.url || target };
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
            status: 502,
            contentType: 'text/plain; charset=utf-8',
            body: Buffer.from(`上游请求失败: ${msg}`, 'utf8'),
        };
    }
    finally {
        clearTimeout(timer);
        active--;
    }
}
/**
 * 把 m3u8 里的分片/子播放列表地址重写回代理。
 *
 * 规则：
 *   - 以 # 开头的行原样保留（标签）
 *   - 空行保留
 *   - 其余行是地址，按 playlist 自身地址解析成绝对地址，再包一层代理
 */
export function rewriteM3u8(text, baseUrl, selfBase) {
    const out = [];
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine;
        if (!line.trim()) {
            out.push(line);
            continue;
        }
        if (line.startsWith('#')) {
            // URI="..." 属性（如 EXT-X-KEY / EXT-X-MAP）也要重写，否则解密/初始化分片会直连
            out.push(line.replace(/URI="([^"]+)"/g, (_m, uri) => {
                const abs = resolveUrl(uri, baseUrl);
                return `URI="${selfBase}${encodeURIComponent(abs)}"`;
            }));
            continue;
        }
        const abs = resolveUrl(line.trim(), baseUrl);
        out.push(`${selfBase}${encodeURIComponent(abs)}`);
    }
    return out.join('\n');
}
/** 相对地址 → 绝对地址 */
export function resolveUrl(target, base) {
    try {
        return new URL(target, base).toString();
    }
    catch {
        return target;
    }
}
