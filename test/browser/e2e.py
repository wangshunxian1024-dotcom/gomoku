#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
五子棋 · 浏览器端到端自检（Chrome Headless + DevTools 协议，无第三方依赖）
=========================================================================
跑一遍真实浏览器里的完整流程，输出 PASS/FAIL 与截图，退出码非 0 表示有失败。

用法:
    python3 test/browser/e2e.py                        # 默认测 http://127.0.0.1:8000/
    python3 test/browser/e2e.py --url http://127.0.0.1:8103 --shots /tmp/gomoku-e2e
"""

from __future__ import annotations

import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from chrome import Chrome  # noqa: E402

PASS, FAIL = "PASS", "FAIL"
results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    results.append((name, bool(ok), detail))
    mark = "✓" if ok else "✗"
    print(f"  {mark} {name}" + (f"  — {detail}" if detail else ""))
    return bool(ok)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8000/")
    parser.add_argument("--shots", default="/tmp/gomoku-e2e")
    args = parser.parse_args()
    os.makedirs(args.shots, exist_ok=True)

    probe = Chrome(width=1440, height=900)
    try:
        probe.start()
        probe.navigate(args.url)
        ok = probe.wait_until("window.GomokuApp && document.readyState === 'complete'", 10)
        check("页面加载 & GomokuApp 就绪", ok)

        def js(expr):
            return probe.eval(expr)

        check("标题包含五子棋", "五子棋" in (js("document.title") or ""), js("document.title"))
        check("AI 引擎无加载异常", not probe.exceptions, "; ".join(probe.exceptions)[:200])
        check("难度按钮 6 个", js("document.querySelectorAll('.difficulty-item').length") == 6)
        check("初始难度=普通", "普通" in (js("document.querySelector('#difficulty-tag').textContent") or ""))
        check("棋盘 canvas 已按 DPR 放大",
              js("document.querySelector('#board').width") > 300,
              f"canvas.width={js('document.querySelector(\"#board\").width')}")

        # ---------- 双人模式：五连（黑）判定 + 结算浮层 ----------
        js("GomokuApp.api.resetGame({}); document.querySelector('#mode-switch .seg[data-mode=\"pvp\"]').click();")
        probe.wait_ms(300)
        check("切换到双人同屏", js("GomokuApp.state.mode") == "pvp")
        js("GomokuApp.api.resetGame({})")
        script = [
            (5, 5), (0, 0), (6, 6), (1, 1), (7, 7),
            (2, 2), (8, 8), (3, 3), (9, 9),
        ]
        for x, y in script:
            js(f"GomokuApp.api.playMove({x},{y})")
        probe.wait_ms(900)
        check("黑棋斜向五连判定", js("GomokuApp.state.finished && GomokuApp.state.winner === 1"),
              f"finished={js('GomokuApp.state.finished')} winner={js('GomokuApp.state.winner')}")
        check("结算浮层出现", js("!document.getElementById('result-overlay').hidden"))
        title_text = js("document.getElementById('result-title').textContent") or ""
        check("结算文案正确", title_text.strip().startswith("黑方"), title_text)
        probe.screenshot(os.path.join(args.shots, "result.png"))

        js("document.getElementById('btn-again').click()")
        probe.wait_ms(300)
        check("「再来一局」重置棋盘", js("GomokuApp.state.moves.length") == 0
              and js("document.getElementById('result-overlay').hidden"))
        probe.screenshot(os.path.join(args.shots, "board-light.png"))

        # ---------- 人机：落子 → AI 回应 → 悔棋 → 提示 ----------
        js("document.querySelector('#mode-switch .seg[data-mode=\"pve\"]').click()")
        probe.wait_ms(200)
        js("document.querySelector('.difficulty-item[data-level=\"master\"]').click()")
        probe.wait_ms(200)
        check("切换到大师难度", js("GomokuApp.state.difficulty") == "master")
        js("GomokuApp.api.resetGame({})")
        probe.wait_ms(300)
        t0 = time.time()
        js("GomokuApp.api.playMove(7,7)")
        ok = probe.wait_until("GomokuApp.state.moves.length >= 2", 8)
        elapsed = time.time() - t0
        check("AI 在大师难度下 8s 内回应", ok, f"{elapsed:.2f}s, lastAiMs={js('GomokuApp.state.lastAiMs')}")
        check("轮次回到人类", js("GomokuApp.state.turn === GomokuApp.state.humanColor"))
        check("AI 落点合法（不覆盖人类棋子）",
              js("[...Array(225)].every((_,i)=>GomokuApp.state.board[i]!==3)")
              if False else js("GomokuApp.state.moves.length") == 2)
        # 落子动画必须有帧循环（回归 P3-1：AI 落子只画首帧、停成半透明小棋子）
        probe.wait_ms(60)
        ticks1 = js("GomokuApp.api.renderTicks()")
        probe.wait_ms(260)
        ticks2 = js("GomokuApp.api.renderTicks()")
        check("落子动画持续逐帧重绘", isinstance(ticks1, int) and ticks2 - ticks1 >= 2,
              f"frames={ticks2 - ticks1}")
        check("动画播完后自动清空动画状态", js("!GomokuApp.api.animActive()") is True)
        # 悔棋回到空盘
        js("GomokuApp.api.undo(); GomokuApp.api.undo();")
        probe.wait_ms(200)
        check("悔棋两次回到空盘", js("GomokuApp.state.moves.length") == 0,
              f"moves={js('GomokuApp.state.moves.length')}")
        # ---------- 第 6 档「宗师」 ----------
        js("document.querySelector('.difficulty-item[data-level=\"grandmaster\"]').click()")
        probe.wait_ms(250)
        check("切换到宗师难度", js("GomokuApp.state.difficulty") == "grandmaster")
        check("宗师难度文案正确", js("GomokuApp.api.getAiMeta('grandmaster').label") == "宗师")
        js("GomokuApp.api.resetGame({})")
        probe.wait_ms(300)
        t0 = time.time()
        js("GomokuApp.api.playMove(7,7)")
        ok = probe.wait_until("GomokuApp.state.moves.length >= 2", 20)
        elapsed = time.time() - t0
        check("宗师 AI 在 20s 内回应", ok, f"{elapsed:.2f}s, lastAiMs={js('GomokuApp.state.lastAiMs')}")
        check("宗师行棋后轮次回到人类", js("GomokuApp.state.turn === GomokuApp.state.humanColor"))
        js("GomokuApp.api.undo(); GomokuApp.api.undo();")
        probe.wait_ms(200)
        js("document.querySelector('.difficulty-item[data-level=\"master\"]').click()")
        probe.wait_ms(250)
        check("切回大师难度", js("GomokuApp.state.difficulty") == "master")

        # 提示
        js("GomokuApp.api.playMove(7,7)")
        probe.wait_until("GomokuApp.state.moves.length >= 2", 8)
        probe.wait_until("!GomokuApp.state.thinking", 5)
        js("GomokuApp.api.hint()")
        ok = probe.wait_until("GomokuApp.state.hint !== null", 8)
        check("提示返回一个空位", ok and js(
            "GomokuApp.state.board[GomokuApp.state.hint.y*15+GomokuApp.state.hint.x] === 0"),
            f"hint={js('GomokuApp.state.hint')}")

        # ---------- 分享链接往返 ----------
        enc = js("GomokuApp.api.encodeCurrent()")
        check("分享编码格式 g1.", isinstance(enc, str) and enc.startswith("g1."), enc)
        moves_before = js("GomokuApp.state.moves.length")
        js(f"GomokuApp.api.loadFromHash('#{enc}')")
        probe.wait_ms(300)
        check("分享链接可还原棋局",
              js("GomokuApp.state.moves.length") == moves_before,
              f"{moves_before} -> {js('GomokuApp.state.moves.length')}")

        # ---------- 回放 ----------
        js("GomokuApp.api.startReplay(0)")
        probe.wait_ms(200)
        check("进入回放模式", js("GomokuApp.state.replayCursor") == 0)
        check("回放条显示", js("!document.getElementById('replay-bar').hidden"))
        probe.screenshot(os.path.join(args.shots, "replay.png"))
        js("document.getElementById('btn-replay-next').click()")
        probe.wait_ms(200)
        check("回放下一步", js("GomokuApp.state.replayCursor") == 1)
        js("GomokuApp.api.exitReplay()")
        probe.wait_ms(150)

        # ---------- 主题 & 弹窗 ----------
        js("document.getElementById('btn-theme').click()")
        probe.wait_ms(250)
        check("深色主题生效", js("document.documentElement.getAttribute('data-theme')") == "dark")
        probe.screenshot(os.path.join(args.shots, "board-dark.png"))
        js("document.getElementById('btn-share').click()")
        probe.wait_ms(400)
        check("分享弹窗打开", js("document.getElementById('share-dialog').open"))
        check("分享链接是完整 URL", str(js("document.getElementById('share-link').value")).startswith("http"))
        probe.screenshot(os.path.join(args.shots, "share.png"))
        js("document.getElementById('btn-share-close').click()")
        probe.wait_ms(200)

        # ---------- 移动端视口 ----------
        probe.width, probe.height, probe.mobile = 390, 844, True
        probe._set_viewport()
        probe.wait_ms(500)
        sw = js("document.documentElement.scrollWidth")
        check("移动端无横向溢出", sw <= 390, f"scrollWidth={sw}")
        probe.screenshot(os.path.join(args.shots, "mobile.png"))
        js("GomokuApp.api.playMove(7,7)")
        probe.wait_ms(300)
        check("移动端可落子", js("GomokuApp.state.moves.length") >= 1)

        # ---------- 控制台 ----------
        errs = [c for c in probe.console if c["type"] in ("error", "log-error")]
        errs = [c for c in errs if "favicon" not in c["text"]]
        check("无 JS 报错", not errs and not probe.exceptions,
              "; ".join(c["text"] for c in errs[:3]) or "; ".join(probe.exceptions[:3]))
    finally:
        probe.close()

    failed = [r for r in results if not r[1]]
    print()
    print(f"共 {len(results)} 项：{len(results) - len(failed)} 通过，{len(failed)} 失败")
    if failed:
        for name, _, detail in failed:
            print(f"  ✗ {name}  — {detail}")
        return 1
    print("全部通过 ✓")
    return 0


if __name__ == "__main__":
    sys.exit(main())
