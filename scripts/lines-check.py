"""逐线路播放回归：把一部片/剧的**每一条线路**都在真实浏览器里放一遍。

为什么需要它：
  线路「解析出来了」不等于「能播」。实测《嫁金钗》12 条线路里，
  有 3 条（超级线路 / 王者TV加速 / wztv）在桌面 Chrome 上直接 video.error=4，
  换一部片挂的又是另外几条 —— 只有真的起播放器才能发现。

用法:
  python scripts/lines-check.py --id 6ad1f86cbcddaeccf86dd81e --kind tv
  python scripts/lines-check.py --id 6acf8fef7ca30ed838a28dfb --kind movie --base http://127.0.0.1:8848

判定:
  PLAY   currentTime 真的在推进（>0.5s）
  FRAME  readyState>=2 但 currentTime 不动（有画面 / 卡住）
  FAIL   起不来
任何一条不是 PLAY，退出码为 1。
"""

import argparse
import json
import sys
import urllib.request
from urllib.parse import urlencode

from playwright.sync_api import sync_playwright

# Windows 控制台默认 GBK，直接输出 ✅ 会 UnicodeEncodeError
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"


def fetch_detail(base: str, vid: str, kind: str) -> dict:
    url = f"{base}/api/dyrs/site/detail?{urlencode({'id': vid, 'kind': kind, 'ep': 1})}"
    with urllib.request.urlopen(url, timeout=180) as r:
        return json.load(r)["detail"]


def play_url(base: str, vid: str, kind: str, detail: dict, idx: int) -> str:
    o = detail["origins"][idx]
    e = o["episodes"][0]
    q = urlencode(
        {
            "id": vid,
            "source": "dyrs",
            "kind": kind,
            "seq": detail["seq"],
            "name": detail["name"],
            "origin": e.get("origin") or o["origin"],
            "p": str(e.get("p", 0)),
            "line": str(idx),
            "ep": "0",
        }
    )
    return f"{base}/play.html?{q}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", required=True, help="视频 id（影视仓的 24 位 id）")
    ap.add_argument("--kind", default="tv", choices=["tv", "movie"], help="tv / movie")
    ap.add_argument("--base", default="http://127.0.0.1:8848", help="本站地址")
    ap.add_argument("--wait", type=int, default=7000, help="每条线路等待毫秒数")
    args = ap.parse_args()

    detail = fetch_detail(args.base, args.id, args.kind)
    origins = detail.get("origins") or []
    print(f"片名: {detail['name']}  线路: {len(origins)}  预检标记: ", end="")
    print("".join("●" if o.get("alive") is not False else "○" for o in origins))
    print()

    bad = 0
    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path=CHROME,
            headless=True,
            args=["--autoplay-policy=no-user-gesture-required", "--mute-audio", "--no-sandbox"],
        )
        print(f"{'线路':<14}{'kind':<8}{'rs':<4}{'t1':>7}{'t2':>7}{'时长':>9}  {'判定'}")
        for idx, o in enumerate(origins):
            ctx = browser.new_context()
            page = ctx.new_page()
            try:
                page.goto(play_url(args.base, args.id, args.kind, detail, idx), timeout=45000)
                page.wait_for_timeout(args.wait)
                s1 = page.evaluate(
                    "()=>{const v=document.querySelector('video');"
                    "return v?{rs:v.readyState,ct:v.currentTime,dur:v.duration||0,err:v.error?v.error.code:0}:null}"
                )
                page.wait_for_timeout(3000)
                s2 = page.evaluate(
                    "()=>{const v=document.querySelector('video');return v?{ct:v.currentTime}:null}"
                )
            except Exception as e:  # noqa: BLE001
                s1, s2 = None, None
                print(f"{o['origin']:<14}{o['kind']:<8}打开播放页失败: {str(e)[:60]}")
                bad += 1
                ctx.close()
                continue

            if not s1:
                verdict = "FAIL(无 video)"
                bad += 1
                print(f"{o['origin']:<14}{o['kind']:<8}{'-':<4}{'-':>7}{'-':>7}{'-':>9}  {verdict}")
            else:
                adv = (s2["ct"] - s1["ct"]) if s2 else 0
                if adv > 0.5:
                    verdict = "PLAY"
                elif s1["rs"] >= 2:
                    verdict = f"FRAME(err={s1['err']})"
                    bad += 1
                else:
                    verdict = f"FAIL(err={s1['err']})"
                    bad += 1
                print(
                    f"{o['origin']:<14}{o['kind']:<8}{s1['rs']:<4}"
                    f"{s1['ct']:>7.2f}{s2['ct'] if s2 else 0:>7.2f}{s1['dur']:>9.1f}  {verdict}"
                )
            ctx.close()
        browser.close()

    print()
    print(f"结果: {len(origins) - bad}/{len(origins)} 条线路可播")
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
