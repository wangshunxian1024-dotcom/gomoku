#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
五子棋 · 单文件打包
====================
把 index.html、css/style.css、js/*.js 全部内联，生成一个完全独立、
可以双击直接打开、也可以直接发给别人的 HTML 文件（无需服务器、无外链）。

用法:
    python3 build.py              # 输出 dist/gomoku-standalone.html
"""

from __future__ import annotations

import os
import re
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
ENTRY = os.path.join(ROOT, "index.html")
OUT_DIR = os.path.join(ROOT, "dist")
OUT_FILE = os.path.join(OUT_DIR, "gomoku-standalone.html")

REMOTE = re.compile(r"^(https?:|//|data:|mailto:)")


def read(path: str) -> str:
    with open(path, "r", encoding="utf-8") as fh:
        return fh.read()


def inline_css(css_path: str) -> str:
    css = re.sub(r"@import[^;]+;", "", read(css_path))
    return f"<style>\n/* ==== {os.path.relpath(css_path, ROOT)} ==== */\n{css}\n</style>"


def inline_js(js_path: str) -> str:
    # 防止脚本内容里的 </script> 提前闭合标签
    js = read(js_path).replace("</script", "<\\/script")
    return f"<script>\n/* ==== {os.path.relpath(js_path, ROOT)} ==== */\n{js}\n</script>"


def main() -> int:
    if not os.path.exists(ENTRY):
        print("错误：找不到 index.html")
        return 1

    html = read(ENTRY)
    used: list[str] = []
    missing: list[str] = []

    def resolve(url: str) -> str | None:
        path = os.path.normpath(os.path.join(ROOT, url.split("?")[0].split("#")[0]))
        return path if os.path.exists(path) else None

    def css_tag(m: re.Match) -> str:
        href = m.group(1)
        if REMOTE.match(href):
            return m.group(0)
        path = resolve(href)
        if not path:
            missing.append(href)
            return m.group(0)
        used.append(href)
        return inline_css(path)

    def js_tag(m: re.Match) -> str:
        src = m.group(1)
        if REMOTE.match(src):
            return m.group(0)
        path = resolve(src)
        if not path:
            missing.append(src)
            return m.group(0)
        used.append(src)
        return inline_js(path)

    html = re.sub(
        r'<link\b[^>]*?href=["\']([^"\']+\.css[^"\']*)["\'][^>]*?>',
        css_tag,
        html,
    )
    html = re.sub(
        r'<script\b[^>]*?\bsrc=["\']([^"\']+)["\'][^>]*>\s*</script>',
        js_tag,
        html,
    )

    for item in missing:
        print(f"警告：缺少文件 {item}，已跳过（页面可能不完整）")

    leftovers = [
        p
        for p in re.findall(r'(?:src|href)=["\'](?!https?:|//|data:|#)([^"\']+)["\']', html)
        if not p.startswith("mailto:")
    ]
    if leftovers:
        print("警告：仍有未内联的本地资源引用：", ", ".join(sorted(set(leftovers))))

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(OUT_FILE, "w", encoding="utf-8") as fh:
        fh.write(html)

    size_kb = len(html.encode("utf-8")) / 1024
    print(f"已生成 {os.path.relpath(OUT_FILE, ROOT)}（{size_kb:.1f} KB，内联 {len(used)} 个文件）")
    for item in used:
        print(f"  · {item}")
    print("\n这个文件可以：双击直接打开 / 直接发给别人 / 上传到任意静态托管。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
