#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
五子棋 · 本地分享服务器
========================
零依赖，只用 Python 标准库，把整个 gomoku/ 目录以静态站点方式跑起来，
并打印一个局域网地址（手机连同一个 Wi-Fi 即可打开，体验真正的"分享"）。

用法:
    python3 serve.py                 # 默认 0.0.0.0:8000
    python3 serve.py --port 8080     # 换端口
    python3 serve.py --open          # 启动后自动用默认浏览器打开

按 Ctrl+C 停止。
"""

from __future__ import annotations

import argparse
import functools
import http.server
import os
import socket
import sys
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))

EXTRA_TYPES = {
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".wasm": "application/wasm",
    ".webmanifest": "application/manifest+json",
    ".woff2": "font/woff2",
}


def lan_ip() -> str:
    """尽力探测本机在局域网中的 IPv4 地址（不产生真实流量）。"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 53))
            return s.getsockname()[0]
        finally:
            s.close()
    except OSError:
        return "127.0.0.1"


def host_name() -> str:
    return socket.gethostname().split(".")[0]


class Server(http.server.ThreadingHTTPServer):
    """跳过 TCPServer.server_bind 里的 socket.getfqdn() 反向解析。
    某些网络环境下 getfqdn('0.0.0.0') 会卡住，自己 bind 更稳。"""

    allow_reuse_address = True

    def server_bind(self) -> None:
        self.socket.bind(self.server_address)
        host, port = self.socket.getsockname()[:2]
        self.server_name = host
        self.server_port = port


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        **EXTRA_TYPES,
    }

    def end_headers(self) -> None:
        # 本地反复迭代时避免旧缓存
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def list_directory(self, path):  # noqa: N802 (禁用目录列表)
        self.send_error(404, "Not Found")
        return None

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("[gomoku] %s %s\n" % (self.client_address[0], fmt % args))


def main() -> int:
    parser = argparse.ArgumentParser(description="五子棋本地分享服务器")
    parser.add_argument("--port", type=int, default=8000, help="端口（默认 8000）")
    parser.add_argument("--bind", default="0.0.0.0", help="监听地址（默认 0.0.0.0）")
    parser.add_argument("--open", action="store_true", help="启动后自动打开浏览器")
    args = parser.parse_args()

    if not os.path.exists(os.path.join(ROOT, "index.html")):
        print("错误：当前目录没有 index.html，请把 serve.py 放在 gomoku/ 目录下运行。")
        return 1

    port = args.port
    try:
        server = Server(
            (args.bind, port),
            functools.partial(Handler, directory=ROOT),
        )
    except OSError as exc:
        print(f"端口 {port} 启动失败：{exc}\n可以换一个端口，例如 --port 8001")
        return 1

    ip = lan_ip()
    local_url = f"http://127.0.0.1:{port}/"
    lan_url = f"http://{ip}:{port}/"
    host_url = f"http://{host_name()}.local:{port}/"

    print()
    print("  ● ●  五子棋 · Gomoku  (Ctrl+C 停止)")
    print("  ═══════════════════════════════════════")
    print(f"  本机访问   {local_url}")
    if ip != "127.0.0.1":
        print(f"  局域网访问 {lan_url}")
        print(f"  Bonjour    {host_url}   (iPhone/iPad/Mac 上可用)")
        print()
        print("  分享给同一 Wi-Fi 下的朋友：直接发上面的局域网地址即可；")
        print("  网址里的 #g1.xxx 片段就是当前棋局，复制分享对话框里的链接就能复原棋局。")
    else:
        print("  未检测到局域网地址，仅本机可访问。")
    print()

    if args.open:
        webbrowser.open(local_url)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止服务器。")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
