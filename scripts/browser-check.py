"""真实浏览器验收：打开页面，确认 hls.js 实际把视频播起来。

检查点：
  1. 首页能渲染出卡片
  2. 详情页线路/选集能渲染
  3. 播放页 video.currentTime 真的在推进（不是只加载了 playlist）
  4. 无致命 JS 错误

用法: python scripts/browser-check.py
"""

import json
import sys
import time

from playwright.sync_api import sync_playwright

# Windows 控制台默认 GBK，直接输出 ✓/✗ 会抛 UnicodeEncodeError
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = "http://127.0.0.1:8848"


def main() -> int:
    errors: list[str] = []
    console_errors: list[str] = []

    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path=r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            headless=True,
            args=[
                "--autoplay-policy=no-user-gesture-required",
                "--no-sandbox",
                "--disable-dev-shm-usage",
                # 无 GPU 环境用软渲染，保证视频真能出帧；
                # 同时关掉不需要的后台服务，避免 headless 偶发崩溃
                "--use-gl=swiftshader",
                "--enable-unsafe-swiftshader",
                "--disable-gpu-sandbox",
                "--disable-extensions",
                "--disable-background-networking",
                "--disable-sync",
                "--no-first-run",
                "--mute-audio",
            ],
        )
        ctx = browser.new_context(viewport={"width": 1366, "height": 900})
        page = ctx.new_page()

        page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))

        # ---- 1. 首页 ----
        print("[1] 首页渲染")
        page.goto(BASE + "/", wait_until="domcontentloaded", timeout=90_000)
        page.wait_for_selector(".card", timeout=90_000)
        cards = page.locator(".card").count()
        print(f"    卡片数 = {cards}")
        if cards == 0:
            print("    ✗ 首页没有渲染出卡片")
            return 1
        print("    ✓ 首页正常")

        # ---- 1b. 封面与分类数量（本次优化的重点）----
        print("\n[1b] 封面与分类分层")
        # 等封面异步补齐（后端要再打一次上游接口，可能几秒）
        try:
            page.wait_for_selector("img.poster", timeout=60_000)
        except Exception:
            pass
        time.sleep(2)
        posters = page.locator("img.poster").count()
        placeholders = page.locator(".poster-ph").count()
        print(f"    真实封面 = {posters}   文字占位 = {placeholders}")

        if posters > 0:
            print("    ✓ 封面已渲染")
        else:
            print("    ✗ 没有任何封面渲染出来")

        cats = page.locator("#catBox button").count()
        print(f"    分类按钮 = {cats}（优化前是 31 个平铺）")
        if 0 < cats <= 14:
            print("    ✓ 分类已按频道收敛")
        else:
            print(f"    ✗ 分类数量异常: {cats}")

        # 分类归属：电影频道的分类不应出现「剧」结尾的
        try:
            film_cats = page.locator("#catBox button").all_inner_texts()
            wrong = [c for c in film_cats if c.strip().endswith("剧")]
            if wrong:
                print(f"    ✗ 电影频道混入了剧类: {wrong}")
            else:
                print(f"    ✓ 电影频道分类归属正确: {[c.split()[0] for c in film_cats[:4]]}")
        except Exception:
            pass

        # 频道切换：点顶栏「电视剧」，分类行应该换掉
        try:
            before = page.locator("#catBox button").all_inner_texts()
            page.locator('nav.main a', has_text="电视剧").first.click()
            page.wait_for_timeout(3000)
            after = page.locator("#catBox button").all_inner_texts()
            if before != after and len(after) > 0:
                print(f"    ✓ 频道切换生效: {after[:3]}")
            else:
                print(f"    ✗ 频道切换后分类没变化: {after[:3]}")
        except Exception as e:
            print(f"    ! 频道切换检查跳过: {str(e)[:80]}")

        # 回到首页继续后面的流程
        page.goto(BASE + "/", wait_until="domcontentloaded", timeout=90_000)
        page.wait_for_selector(".card", timeout=90_000)

        # ---- 2. 搜索 ----
        # 注意：不能用 networkidle —— 补封面是异步持续的，网络永远不会 idle
        print("\n[2] 搜索「兰香如故」")
        page.goto(BASE + "/index.html?wd=%E5%85%B0%E9%A6%99%E5%A6%82%E6%95%85",
                  wait_until="domcontentloaded", timeout=90_000)
        page.wait_for_selector(".card", timeout=90_000)
        title = page.locator(".card .title").first.inner_text()
        print(f"    首个结果 = {title}")
        if "兰香" not in title:
            print(f"    ✗ 搜索结果不对: {title}")
            return 1
        print("    ✓ 搜索正常")

        # 搜索结果也应有封面
        try:
            page.wait_for_selector("img.poster", timeout=60_000)
            print(f"    ✓ 搜索结果封面 = {page.locator('img.poster').count()}")
        except Exception:
            print("    ! 搜索结果封面未在 60s 内出现")

        # ---- 3. 详情页 ----
        print("\n[3] 详情页线路/选集")
        page.locator(".card").first.click()
        page.wait_for_selector(".ep", timeout=90_000)
        page.wait_for_selector("#lineBox button", timeout=30_000)
        n_lines = page.locator("#lineBox button").count()
        n_eps = page.locator(".ep").count()
        print(f"    线路 = {n_lines}, 选集 = {n_eps}")
        if n_lines == 0 or n_eps == 0:
            print("    ✗ 详情页没有线路或选集")
            return 1
        print("    ✓ 详情页正常")

        # ---- 4. 播放页：真正播放 ----
        print("\n[4] 播放页实际播放（关键）")
        # 选第一个可播线路（不带 ⚠ 的）
        btns = page.locator("#lineBox button")
        picked = 0
        for i in range(btns.count()):
            t = btns.nth(i).inner_text()
            if "⚠" not in t:
                picked = i
                break
        page.locator("#lineBox button").nth(picked).click()
        time.sleep(1)
        page.locator(".ep").first.click()

        page.wait_for_selector("video", timeout=30_000)

        # 等 video 真的开始推进
        played = False
        last_t = 0.0
        stalled = 0
        for _ in range(60):
            time.sleep(1)
            st = page.evaluate("""() => {
                const v = document.querySelector('video');
                return { t: v.currentTime, rs: v.readyState, paused: v.paused,
                         err: v.error ? v.error.code : null, src: v.currentSrc };
            }""")
            if st["err"]:
                print(f"    video 报错 code={st['err']}")
                break
            if st["t"] > 0.5 and st["t"] > last_t:
                played = True
                last_t = st["t"]
                stalled = 0
                if st["t"] > 4:
                    break
            else:
                stalled += 1
                if stalled > 25:
                    break

        st = page.evaluate("""() => {
            const v = document.querySelector('video');
            return { t: v.currentTime, d: v.duration, rs: v.readyState,
                     paused: v.paused, w: v.videoWidth, h: v.videoHeight,
                     src: v.currentSrc.slice(0, 120) };
        }""")
        print(f"    currentTime = {st['t']:.2f}s")
        print(f"    duration    = {st['d']:.2f}s" if st["d"] else "    duration    = 未知")
        print(f"    readyState  = {st['rs']}")
        print(f"    分辨率       = {st['w']}x{st['h']}")
        print(f"    src         = {st['src']}")

        if played and st["rs"] >= 2:
            print("    ✓ 视频真的在播放")
        else:
            print("    ✗ 视频没有推进")
            screenshot = "scripts/_play-fail.png"
            page.screenshot(path=screenshot, full_page=True)
            print(f"    截图: {screenshot}")

        # ---- 5. 续播 ----
        print("\n[5] 续播（重新打开同一集）")
        cur_url = page.url
        page.goto(BASE + "/history.html", wait_until="domcontentloaded", timeout=60_000)
        page.wait_for_selector(".card", timeout=60_000)
        hcards = page.locator(".card").count()
        print(f"    历史页卡片 = {hcards}")
        if hcards > 0:
            print("    ✓ 历史记录已写入")
        else:
            print("    ✗ 历史页为空")

        browser.close()

    # ---- 汇总 ----
    print("\n=== JS 错误 ===")
    if errors:
        for e in errors[:10]:
            print(f"    pageerror: {e}")
    else:
        print("    无 pageerror")

    real_console = [e for e in console_errors if "favicon" not in e.lower()]
    if real_console:
        for e in real_console[:10]:
            print(f"    console: {e[:200]}")
    else:
        print("    无 console 错误")

    ok = played and not errors
    print(f"\n=== 浏览器验收: {'通过' if ok else '未通过'} ===\n")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
