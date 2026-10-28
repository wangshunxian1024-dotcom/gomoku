#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
无依赖浏览器自动化小工具（Chrome Headless + DevTools 协议）
==============================================================
本机没有 bsk / playwright / node，所以用 Chrome headless + 手写 WebSocket
直接讲 DevTools 协议，做视觉截图与 DOM/JS 自检。纯 Python 标准库。

示例:
    # 桌面截图
    python3 test/browser/chrome.py --url http://127.0.0.1:8000/ --viewport 1440x900 \
        --screenshot /tmp/desk.png --console

    # 手机尺寸截图（iPhone 14 逻辑分辨率 390x844）
    python3 test/browser/chrome.py --url http://127.0.0.1:8000/ --mobile --viewport 390x844 \
        --screenshot /tmp/mobile.png

    # 执行 JS 并读取结果（点击按钮后观察状态）
    python3 test/browser/chrome.py --url http://127.0.0.1:8000/ \
        --step "until:window.__gomoku" \
        --step "click:#btn-new" \
        --step "eval:window.__gomoku.state().phase" \
        --step "eval:document.documentElement.scrollWidth"

    # 把执行结果以 JSON 输出，便于脚本断言
    python3 test/browser/chrome.py ... --json --quiet
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request

CHROME_CANDIDATES = [
    os.environ.get("CHROME_BIN", ""),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    shutil.which("google-chrome") or "",
    shutil.which("chromium") or "",
    shutil.which("chromium-browser") or "",
]


def find_chrome() -> str:
    for path in CHROME_CANDIDATES:
        if path and os.path.exists(path):
            return path
    raise SystemExit("找不到 Chrome，请设置环境变量 CHROME_BIN 指向 Chrome 可执行文件")


# ---------------------------------------------------------------- WebSocket


class WS:
    """最小可用的 WebSocket 客户端（仅文本帧，够 DevTools 协议用）。"""

    def __init__(self, url: str, timeout: float = 30.0):
        assert url.startswith("ws://"), url
        rest = url[5:]
        host_port, _, path = rest.partition("/")
        host, _, port = host_port.partition(":")
        self.sock = socket.create_connection((host, int(port or 80)), timeout=timeout)
        self.sock.settimeout(timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET /{path} HTTP/1.1\r\n"
            f"Host: {host_port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode())
        header = b""
        while b"\r\n\r\n" not in header:
            chunk = self.sock.recv(1)
            if not chunk:
                raise ConnectionError("WebSocket 握手失败")
            header += chunk
        if b"101" not in header.split(b"\r\n")[0]:
            raise ConnectionError("WebSocket 握手被拒绝: " + header.decode(errors="replace"))
        self.buf = b""

    def _recv_exact(self, n: int) -> bytes:
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("连接已关闭")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _recv_frame(self):
        b1, b2 = self._recv_exact(2)
        fin = b1 & 0x80
        opcode = b1 & 0x0F
        masked = b2 & 0x80
        length = b2 & 0x7F
        if length == 126:
            length = struct.unpack(">H", self._recv_exact(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", self._recv_exact(8))[0]
        mask = self._recv_exact(4) if masked else b""
        payload = self._recv_exact(length)
        if masked:
            payload = bytes(p ^ mask[i % 4] for i, p in enumerate(payload))
        return bool(fin), opcode, payload

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        header = bytes([0x80 | opcode])
        n = len(payload)
        if n < 126:
            header += bytes([0x80 | n])
        elif n < 65536:
            header += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            header += bytes([0x80 | 127]) + struct.pack(">Q", n)
        mask = os.urandom(4)
        masked = bytes(p ^ mask[i % 4] for i, p in enumerate(payload))
        self.sock.sendall(header + mask + masked)

    def send_text(self, text: str) -> None:
        self._send_frame(0x1, text.encode())

    def recv_message(self) -> str:
        fragments = b""
        while True:
            fin, opcode, payload = self._recv_frame()
            if opcode == 0x9:  # ping
                self._send_frame(0xA, payload)
                continue
            if opcode == 0xA:  # pong
                continue
            if opcode == 0x8:  # close
                raise ConnectionError("WebSocket 关闭")
            fragments += payload
            if fin:
                return fragments.decode("utf-8", "replace")

    def close(self) -> None:
        try:
            self._send_frame(0x8, b"")
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass


# ---------------------------------------------------------------- DevTools


class Chrome:
    def __init__(self, width: int = 1440, height: int = 900, mobile: bool = False,
                 dpr: float = 1.0, verbose: bool = False):
        self.width, self.height, self.mobile, self.dpr = width, height, mobile, dpr
        self.verbose = verbose
        self.events: list[dict] = []
        self.console: list[dict] = []
        self.exceptions: list[str] = []
        self.accept_dialogs = False   # 自动处理 confirm/alert 弹框（True=确定，False=取消）
        self.dialogs: list[dict] = []  # 出现过的 JS 弹框
        self.proc: subprocess.Popen | None = None
        self.ws: WS | None = None
        self.tmp = tempfile.mkdtemp(prefix="chrome-probe-")
        self.next_id = 0

    # -- 生命周期 --------------------------------------------------
    def start(self) -> None:
        chrome = find_chrome()
        flags_base = [
            chrome,
            "--headless=new",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-background-networking",
            "--disable-component-update",
            "--disable-sync",
            "--disable-extensions",
            "--disable-default-apps",
            "--disable-search-engine-choice-screen",
            "--hide-scrollbars",
            "--mute-audio",
            "--remote-debugging-port=0",
            f"--user-data-dir={self.tmp}",
        ]
        last_err = ""
        for headless in ("--headless=new", "--headless"):
            flags = [f if f != "--headless=new" else headless for f in flags_base]
            flags.append("about:blank")
            self.proc = subprocess.Popen(
                flags, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )
            port = self._wait_port()
            if port:
                self._connect(port)
                return
            last_err = "Chrome 启动超时"
            try:
                self.proc.kill()
            except Exception:
                pass
        raise SystemExit(f"无法启动 Chrome: {last_err}")

    def _wait_port(self) -> int | None:
        port_file = os.path.join(self.tmp, "DevToolsActivePort")
        deadline = time.time() + 15
        while time.time() < deadline:
            if os.path.exists(port_file):
                try:
                    content = open(port_file, encoding="utf-8").read().splitlines()
                    return int(content[0])
                except (ValueError, IndexError):
                    pass
            if self.proc and self.proc.poll() is not None:
                return None
            time.sleep(0.05)
        return None

    def _connect(self, port: int) -> None:
        self.port = port
        deadline = time.time() + 10
        target = None
        while time.time() < deadline and target is None:
            try:
                data = json.loads(
                    urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=2).read()
                )
                for item in data:
                    if item.get("type") == "page":
                        target = item
                        break
            except Exception:
                time.sleep(0.1)
        if not target:
            raise SystemExit("DevTools 里找不到 page target")
        self.ws = WS(target["webSocketDebuggerUrl"])
        self.call("Page.enable")
        self.call("Runtime.enable")
        self.call("Log.enable")
        self._set_viewport()

    def _set_viewport(self) -> None:
        self.call(
            "Emulation.setDeviceMetricsOverride",
            {
                "width": self.width,
                "height": self.height,
                "deviceScaleFactor": self.dpr,
                "mobile": self.mobile,
            },
        )
        self.call("Emulation.setTouchEmulationEnabled", {"enabled": self.mobile})

    def close(self) -> None:
        if self.ws:
            self.ws.close()
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        shutil.rmtree(self.tmp, ignore_errors=True)

    # -- RPC ------------------------------------------------------
    def call(self, method: str, params: dict | None = None, timeout: float = 40.0):
        assert self.ws is not None
        self.next_id += 1
        msg_id = self.next_id
        self.ws.send_text(json.dumps({"id": msg_id, "method": method, "params": params or {}}))
        deadline = time.time() + timeout
        while time.time() < deadline:
            raw = self.ws.recv_message()
            msg = json.loads(raw)
            if msg.get("id") == msg_id:
                if "error" in msg:
                    raise RuntimeError(f"{method} 出错: {msg['error']}")
                return msg.get("result", {})
            self._handle_event(msg)
        raise TimeoutError(f"{method} 超时")

    def _handle_event(self, msg: dict) -> None:
        method = msg.get("method", "")
        params = msg.get("params", {})
        if method == "Runtime.consoleAPICalled":
            args = []
            for arg in params.get("args", []):
                if "value" in arg:
                    args.append(arg["value"])
                else:
                    args.append(arg.get("description") or arg.get("type"))
            self.console.append({"type": params.get("type"), "text": " ".join(map(str, args))})
        elif method == "Runtime.exceptionThrown":
            details = params.get("exceptionDetails", {})
            desc = (details.get("exception") or {}).get("description") or details.get("text", "")
            self.exceptions.append(desc)
        elif method == "Log.entryAdded":
            entry = params.get("entry", {})
            if entry.get("level") in ("error", "warning"):
                self.console.append(
                    {
                        "type": "log-" + entry["level"],
                        "text": f"[{entry.get('source')}] {entry.get('text')}",
                    }
                )
        elif method == "Page.javascriptDialogOpening":
            self.dialogs.append({"type": params.get("type"), "message": params.get("message")})
            try:
                self.call("Page.handleJavaScriptDialog", {"accept": self.accept_dialogs})
            except Exception:
                pass
        elif method in ("Page.loadEventFired", "Page.domContentEventFired"):
            self.events.append({"method": method, "params": params})

    # -- 便捷操作 --------------------------------------------------
    def navigate(self, url: str, timeout: float = 30.0) -> None:
        self.events.clear()
        self.call("Page.navigate", {"url": url})
        deadline = time.time() + timeout
        while time.time() < deadline:
            if any(e["method"] == "Page.loadEventFired" for e in self.events):
                return
            raw = self._try_recv(0.1)
            if raw:
                self._handle_event(raw)
            else:
                time.sleep(0.02)
        # 超时也继续，后续用 readyState 兜底

    def eval(self, expr: str, await_promise: bool = True):
        res = self.call(
            "Runtime.evaluate",
            {
                "expression": expr,
                "awaitPromise": await_promise,
                "returnByValue": True,
                "userGesture": True,
            },
        )
        if "exceptionDetails" in res:
            detail = res["exceptionDetails"]
            desc = (detail.get("exception") or {}).get("description") or detail.get("text")
            raise RuntimeError(f"表达式出错: {desc}")
        remote = res.get("result", {})
        return remote.get("value") if "value" in remote else remote.get("unserializableValue")

    def wait_until(self, expr: str, timeout: float = 8.0) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                if self.eval(expr, await_promise=False):
                    return True
            except RuntimeError:
                pass
            time.sleep(0.1)
        return False

    def screenshot(self, path: str, full_page: bool = False) -> str:
        params = {"format": "png", "fromSurface": True}
        if full_page:
            params["captureBeyondViewport"] = True
        res = self.call("Page.captureScreenshot", params)
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(base64.b64decode(res["data"]))
        return path

    def _try_recv(self, timeout: float) -> dict | None:
        """非阻塞地收一条 DevTools 消息（用于边等边收集事件）。"""
        assert self.ws is not None
        self.ws.sock.settimeout(timeout)
        try:
            raw = self.ws.recv_message()
        except (socket.timeout, TimeoutError, ConnectionError):
            return None
        finally:
            self.ws.sock.settimeout(30.0)
        return json.loads(raw)

    def wait_ms(self, ms: int) -> None:
        end = time.time() + ms / 1000
        while time.time() < end:
            msg = self._try_recv(0.05)
            if msg:
                self._handle_event(msg)


# ---------------------------------------------------------------- CLI


def parse_viewport(value: str) -> tuple[int, int]:
    w, _, h = value.lower().partition("x")
    return int(w), int(h)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Chrome Headless 页面自检工具")
    parser.add_argument("--url", required=True, help="要打开的页面")
    parser.add_argument("--viewport", default="1440x900", help="视口，如 1440x900 / 390x844")
    parser.add_argument("--mobile", action="store_true", help="移动端模拟（触摸 + mobile 标记）")
    parser.add_argument("--dpr", type=float, default=1.0, help="devicePixelRatio")
    parser.add_argument("--screenshot", default=None, help="最后截图保存路径")
    parser.add_argument("--full-page", action="store_true", help="整页截图")
    parser.add_argument("--step", action="append", default=[], help="按顺序执行的步骤，见文件头注释")
    parser.add_argument("--settle-ms", type=int, default=600, help="页面加载后再等多久（毫秒）")
    parser.add_argument("--accept-dialogs", action="store_true", help="自动点击确认框/提示框的「确定」")
    parser.add_argument("--json", action="store_true", help="以 JSON 输出全部结果")
    parser.add_argument("--quiet", action="store_true", help="不打印调试日志")
    args = parser.parse_args(argv)

    width, height = parse_viewport(args.viewport)
    probe = Chrome(width=width, height=height, mobile=args.mobile, dpr=args.dpr,
                   verbose=not args.quiet)
    probe.accept_dialogs = args.accept_dialogs
    results: list[dict] = []
    try:
        probe.start()
        probe.navigate(args.url)
        probe.wait_ms(args.settle_ms)
        for step in args.step:
            kind, _, value = step.partition(":")
            if kind == "click":
                probe.eval(f"document.querySelector({json.dumps(value)}).click()")
                results.append({"step": step, "ok": True})
                probe.wait_ms(120)
            elif kind == "eval":
                value_out = probe.eval(value)
                results.append({"step": step, "value": value_out})
                if not args.quiet:
                    print(f"eval {value} => {json.dumps(value_out, ensure_ascii=False)}")
            elif kind == "wait":
                probe.wait_ms(int(value))
                results.append({"step": step, "ok": True})
            elif kind == "until":
                ok = probe.wait_until(value)
                results.append({"step": step, "ok": ok})
                if not args.quiet:
                    print(f"until {value} => {ok}")
            elif kind == "screenshot":
                probe.screenshot(value, full_page=args.full_page)
                results.append({"step": step, "path": os.path.abspath(value)})
            elif kind == "viewport":
                w, h = parse_viewport(value)
                probe.width, probe.height = w, h
                probe._set_viewport()
                probe.wait_ms(250)
                results.append({"step": step, "ok": True})
            elif kind == "mobile":
                probe.mobile = value in ("1", "on", "true", "yes")
                probe._set_viewport()
                results.append({"step": step, "ok": True})
            else:
                raise SystemExit(f"未知步骤: {step}")
        if args.screenshot:
            probe.screenshot(args.screenshot, full_page=args.full_page)
        title = probe.eval("document.title")
        url = probe.eval("location.href")
        size = probe.eval("({w: innerWidth, h: innerHeight, sw: document.documentElement.scrollWidth, "
                          "sh: document.documentElement.scrollHeight})")
        payload = {
            "title": title,
            "url": url,
            "viewport": size,
            "results": results,
            "console": probe.console,
            "exceptions": probe.exceptions,
            "dialogs": probe.dialogs,
            "screenshot": os.path.abspath(args.screenshot) if args.screenshot else None,
        }
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0
    finally:
        probe.close()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
