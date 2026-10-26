"""详情页布局回归：把「封面空洞 / 触控目标 / 横向溢出」这些硬指标量出来。

为什么需要它：
  详情页的「封面大小不对」其实是 flex 默认 `align-items: stretch` 把封面容器拉高，
  图片按自身比例排完后空出一大截（实测 1280 下空 131px、768 下空 196px）。
  这种问题肉眼看截图不一定看得出，但量 `posterBoxH - imgH` 一眼就露馅。

用法:
  python scripts/layout-check.py --id 161963 --source lziapi --name 嫁金钗
  python scripts/layout-check.py --base http://127.0.0.1:8848 --pages detail,dyrs-detail

判定（任何一条不满足，退出码 1）:
  1. 封面空洞 poster-empty = 0（四档宽度、两个页面）
  2. 无横向溢出
  3. 手机端（390）可点元素全部 >= 44px
  4. 手机端 头部高度 <= 400px（原来 735）、线路条 <= 60px（原来 172）
  5. 手机端集数列数 >= 5
"""

import argparse
import json
import sys
from urllib.parse import urlencode

from playwright.sync_api import sync_playwright

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

MEASURE = """() => {
  const poster = document.querySelector('.poster-lg');
  const img = poster && poster.querySelector('img');
  const head = document.querySelector('.detail-head');
  const lines = document.querySelector('.lines');
  const epBox = document.getElementById('epBox');
  const btns = [...document.querySelectorAll('.actions button, .line-chips button, #epBox .ep')];
  const small = btns
    .filter((b) => b.getBoundingClientRect().height < 44)
    .map((b) => b.innerText.trim().slice(0, 12));
  return {
    overflowX: document.body.scrollWidth > document.documentElement.clientWidth,
    headH: head ? Math.round(head.getBoundingClientRect().height) : null,
    posterEmpty:
      poster && img
        ? Math.round(poster.getBoundingClientRect().height - img.getBoundingClientRect().height)
        : null,
    linesH: lines ? Math.round(lines.getBoundingClientRect().height) : null,
    epCols: epBox ? getComputedStyle(epBox).gridTemplateColumns.split(' ').length : 0,
    btnTotal: btns.length,
    btnSmall: small,
  };
}"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", default="161963")
    ap.add_argument("--source", default="lziapi")
    ap.add_argument("--name", default="嫁金钗")
    ap.add_argument("--dyrs-id", default="6ad1f86cbcddaeccf86dd81e", help="影视仓片目 id")
    ap.add_argument("--base", default="http://127.0.0.1:8848")
    ap.add_argument("--pages", default="detail,dyrs-detail")
    ap.add_argument("--sizes", default="390x844,768x1024,1280x900,1440x900")
    ap.add_argument("--wait", type=int, default=12000)
    args = ap.parse_args()

    targets = []
    if "detail" in args.pages:
        q = urlencode({"id": args.id, "source": args.source, "name": args.name})
        targets.append(("detail", f"{args.base}/detail.html?{q}"))
    if "dyrs-detail" in args.pages:
        q = urlencode({"id": args.dyrs_id, "kind": "tv", "ep": "1", "name": args.name})
        targets.append(("dyrs-detail", f"{args.base}/dyrs-detail.html?{q}"))

    fails = []
    rows = []

    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path=CHROME, headless=True, args=["--no-sandbox"]
        )
        for label, url in targets:
            for size in args.sizes.split(","):
                w, h = [int(x) for x in size.split("x")]
                ctx = browser.new_context(viewport={"width": w, "height": h})
                page = ctx.new_page()
                page.goto(url, wait_until="domcontentloaded", timeout=60000)
                page.wait_for_timeout(args.wait)
                d = page.evaluate(MEASURE)
                mobile = w <= 700

                if d["posterEmpty"] not in (0, None):
                    fails.append(f"{label}@{size} 封面空洞 {d['posterEmpty']}px")
                if d["overflowX"]:
                    fails.append(f"{label}@{size} 出现横向溢出")
                if mobile:
                    if d["btnSmall"]:
                        fails.append(f"{label}@{size} 有 {len(d['btnSmall'])} 个按钮 <44px: {d['btnSmall'][:4]}")
                    if d["headH"] and d["headH"] > 400:
                        fails.append(f"{label}@{size} 头部高度 {d['headH']}px > 400")
                    if d["linesH"] and d["linesH"] > 60:
                        fails.append(f"{label}@{size} 线路条高度 {d['linesH']}px > 60")
                    if d["epCols"] < 5:
                        fails.append(f"{label}@{size} 集数只有 {d['epCols']} 列")
                else:
                    if d["headH"] and d["headH"] > 430:
                        fails.append(f"{label}@{size} 头部高度 {d['headH']}px > 430")

                rows.append((label, size, d))
                ctx.close()
        browser.close()

    print(f"{'页面':<13}{'宽度':<11}{'头部高':>7}{'封面空洞':>9}{'线路条':>7}{'集数列':>7}{'小按钮':>8}{'横向溢出':>9}")
    for label, size, d in rows:
        print(
            f"{label:<13}{size:<11}{d['headH'] or '-':>7}{d['posterEmpty'] if d['posterEmpty'] is not None else '-':>9}"
            f"{d['linesH'] or '-':>7}{d['epCols']:>7}{len(d['btnSmall']):>5}/{d['btnTotal']:<2}"
            f"{('是' if d['overflowX'] else '否'):>9}"
        )

    print()
    if fails:
        print(f"❌ {len(fails)} 项不达标：")
        for f in fails:
            print("  -", f)
        return 1
    print("✅ 全部达标")
    return 0


if __name__ == "__main__":
    sys.exit(main())
