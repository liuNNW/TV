"""验证「代理兜底」路径在真实浏览器里也能播。

做法：用一个自签的本地 HTTP 服务扮演「无 CORS 的 CDN」——
从本机代理该测试源会失败（SSRF 防护不允许本机地址），
所以这里改为直接构造代理地址，验证 hls.js 能通过 /api/proxy 拉到并播放。

更贴近真实的做法：拿一个真实 CDN 地址，强制走代理播放。
"""

import sys
import time

from playwright.sync_api import sync_playwright

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = "http://127.0.0.1:8848"
# 兰香如故 lzm3u8 线路首集
TEST_URL = "https://v.lzcdn27.com/20260911/16824_7311a09b/index.m3u8"


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path=r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            headless=True,
            args=[
                "--autoplay-policy=no-user-gesture-required",
                "--no-sandbox",
                "--use-gl=swiftshader",
                "--enable-unsafe-swiftshader",
            ],
        )
        page = browser.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        # 造一个最小页面，直接通过 hls.js + 本机代理播放
        page.goto(BASE + "/", wait_until="domcontentloaded", timeout=60_000)

        page.set_content(f"""
        <!doctype html><html><body>
        <video id="v" muted playsinline></video>
        <script src="{BASE}/vendor/hls.min.js"></script>
        <script>
          window.__state = {{ events: [], err: null }};
          const v = document.getElementById('v');
          const proxy = '{BASE}/api/proxy?url=' + encodeURIComponent('{TEST_URL}');
          window.__proxied = proxy;
          const h = new Hls();
          h.on(Hls.Events.MANIFEST_PARSED, () => {{ window.__state.events.push('manifest'); v.play().catch(()=>{{}}); }});
          h.on(Hls.Events.FRAG_LOADED, () => {{ window.__state.events.push('frag'); }});
          h.on(Hls.Events.LEVEL_LOADED, () => {{ window.__state.events.push('level'); }});
          h.on(Hls.Events.ERROR, (e, d) => {{ if (d.fatal) window.__state.err = d.details; }});
          h.loadSource(proxy);
          h.attachMedia(v);
        </script>
        </body></html>
        """)

        print("[代理兜底] 等待通过本机代理播放…")
        played = False
        last = 0.0
        for _ in range(60):
            time.sleep(1)
            st = page.evaluate("""() => {
                const v = document.getElementById('v');
                return { t: v.currentTime, rs: v.readyState, w: v.videoWidth,
                         err: window.__state.err, ev: window.__state.events.slice(-6) };
            }""")
            if st["err"]:
                print(f"    ✗ hls 致命错误: {st['err']}")
                break
            if st["t"] > 1.0 and st["t"] > last:
                played = True
                last = st["t"]
                if st["t"] > 4:
                    break

        st = page.evaluate("""() => {
            const v = document.getElementById('v');
            return { t: v.currentTime, rs: v.readyState, w: v.videoWidth, h: v.videoHeight,
                     ev: window.__state.events.slice(-6), err: window.__state.err };
        }""")
        print(f"    currentTime = {st['t']:.2f}s")
        print(f"    readyState  = {st['rs']}")
        print(f"    分辨率       = {st['w']}x{st['h']}")
        print(f"    事件         = {st['ev']}")

        browser.close()

    if played and st["rs"] >= 2:
        print("    ✓ 代理兜底路径可以正常播放")
        return 0
    print("    ✗ 代理兜底路径未能播放")
    return 1


if __name__ == "__main__":
    sys.exit(main())
