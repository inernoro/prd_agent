"""Run a private draft in the same restrictive iframe as a CDS design artifact."""
from __future__ import annotations

import html
import json
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, urlsplit

from typing import Any

FILE_LIMIT = 4 * 1024 * 1024
VIEWPORTS = {"desktop": (1280, 800), "phone": (375, 812)}
FAILURES = {
    "control-unavailable": "找不到设定的入口控件",
    "readiness-timeout": "等待画面就绪超时",
    "prototype-error": "原型脚本出错",
    "no-response": "原型未返回就绪信息",
}


def read_package_file(root: Path, path: str) -> str:
    if not isinstance(path, str) or re.search(r"[\\:\x00-\x1f]", path):
        raise ValueError("原型须是稿件目录内的相对路径")
    candidate = root
    for part in path.split("/"):
        if part in ("", ".", ".."):
            raise ValueError("原型须是稿件目录内的相对路径")
        candidate = candidate / part
        if candidate.is_symlink():
            raise ValueError("本机预览不读取符号链接")
    if not candidate.is_file():
        raise ValueError("找不到 design.json 或其中声明的原型")
    with candidate.open("rb") as stream:
        raw = stream.read(FILE_LIMIT + 1)
    if len(raw) > FILE_LIMIT:
        raise ValueError("原型文件超过 4 MiB")
    return raw.decode("utf-8")


def decorate(prototype: str, contract: dict) -> str:
    bridge = "\n".join(contract["bridge"])
    script = f'<script data-entry-timeout="{contract["entryTimeoutMs"]}">\n{bridge}\n</script>'
    head = re.search(r"<head(?:\s[^>]*)?>", prototype, re.I)
    start = head or re.match(r"^(?:<!doctype[^>]+>\s*)?", prototype, re.I)
    index = start.end() if start else 0
    return prototype[:index] + script + prototype[index:]


def preview_summary(status: str, diagnostics: dict, reason: str = "") -> str:
    def count(key: str) -> int:
        value = diagnostics.get(key)
        return value if type(value) is int and 0 <= value <= 99 else 0

    parts = [FAILURES.get(reason, "原型未返回就绪信息") if status == "failed" else "画面已就绪" if status == "ready" else "正在等待画面"]
    if errors := count("runtime") + count("console"):
        parts.append(f"原型报错 {errors} 条")
    if blocked := count("blocked"):
        parts.append(f"安全策略拦截 {blocked} 次")
    return "。".join(parts) + "。"


HOST_SCRIPT = """
(() => {
  const options = JSON.parse(document.getElementById('preview-options').textContent);
  const status = document.getElementById('preview-status');
  const iframe = document.createElement('iframe');
  iframe.title = options.title;
  iframe.width = options.width;
  iframe.height = options.height;
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.referrerPolicy = 'no-referrer';

  let timeout;
  let requestId;
  let report = { state: 'loading', diagnostics: {}, reason: '' };
  const count = value => Number.isInteger(value) && value >= 0 && value <= 99 ? value : 0;
  const render = () => {
    const { state, reason, diagnostics } = report;
    const errors = count(diagnostics.runtime) + count(diagnostics.console);
    const blocked = count(diagnostics.blocked);
    const messages = [state === 'ready' ? '画面已就绪' : state === 'failed' ? options.failures[reason] : '正在等待画面'];
    if (errors) messages.push('原型报错 ' + errors + ' 条');
    if (blocked) messages.push('安全策略拦截 ' + blocked + ' 次');
    const summary = messages.join('。') + '。';
    status.dataset.state = state;
    if (status.textContent === summary) return;
    status.textContent = summary;
    fetch('/diagnostics', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, reason, diagnostics: { runtime: count(diagnostics.runtime),
        console: count(diagnostics.console), blocked } }) }).catch(() => {});
  };

  window.addEventListener('message', event => {
    if (event.source !== iframe.contentWindow || event.origin !== 'null') return;
    const data = event.data;
    if (data?.type === 'cds-design-diagnostics') {
      report.diagnostics = data.diagnostics || {};
      render();
    }
    if (data?.type === 'cds-design-entry-result' && data.requestId === requestId && typeof data.reached === 'boolean') {
      clearTimeout(timeout);
      report = { state: data.reached ? 'ready' : 'failed', diagnostics: data.diagnostics || {},
        reason: Object.hasOwn(options.failures, data.reason) ? data.reason : 'no-response' };
      render();
    }
  });
  iframe.addEventListener('load', () => {
    clearTimeout(timeout);
    requestId = String(performance.now());
    iframe.contentWindow.postMessage({ type: 'cds-design-entry', requestId, timeoutMs: options.timeout,
      actions: options.actions, ready: options.ready, legacyLabel: options.legacy }, '*');
    timeout = setTimeout(() => {
      report = { ...report, state: 'failed', reason: 'no-response' };
      render();
    }, options.timeout + 600);
  });
  iframe.src = options.src;
  document.getElementById('preview-canvas').append(iframe);
})();
"""


def serve(folder: str, screen: str | None, theme: str, port: int) -> None:
    root = Path(folder).resolve(strict=True)
    contract = json.loads(Path(__file__).with_name("design-preview-contract.json").read_text(encoding="utf-8"))
    manifest = json.loads(read_package_file(root, "design.json"))
    if not isinstance(manifest, dict):
        raise ValueError("design.json 须为对象")
    prototype = read_package_file(root, manifest.get("prototype", "dist/index.html"))
    scenes = manifest.get("screens", [])
    if not isinstance(scenes, list) or len(scenes) > 80 or any(not isinstance(row, dict) for row in scenes):
        raise ValueError("画面清单无效")
    scene = next((row for row in scenes if row.get("id") == screen), None) if screen else next(iter(scenes), {})
    if scene is None:
        raise ValueError("所选画面不在 design.json 中")
    if scene.get("viewport", "desktop") not in VIEWPORTS or theme not in scene.get("themes", ["light", "dark"]):
        raise ValueError("所选画面没有此视口或主题")
    route = scene.get("route", "#")
    if not isinstance(route, str) or not route.startswith(("#", "/")) or len(route) > 1200:
        raise ValueError("画面入口须为原型内路径")
    peers = [row for row in scenes if row.get("route") == route and row.get("viewport") == scene.get("viewport")]
    timeout = scene.get("entryTimeoutMs", contract["entryTimeoutMs"])
    if type(timeout) is not int or not contract["minTimeoutMs"] <= timeout <= contract["maxTimeoutMs"]:
        raise ValueError("画面进入超时须在 500–15000 毫秒之间")
    width, height = VIEWPORTS[scene.get("viewport", "desktop")]
    title = str(scene.get("name", "设计原型"))
    data = {"title": title, "width": width, "height": height,
            "src": "/prototype?theme=" + theme + "#" + quote(route.removeprefix("#"), safe="/#?=&!,:+@%$"),
            "actions": scene.get("entryActions"), "ready": scene.get("entryReadySelector"), "timeout": timeout,
            "legacy": title if peers and peers[0].get("id") != scene.get("id") else None, "failures": FAILURES}
    config = json.dumps(data, ensure_ascii=False).replace("<", r"\u003c")
    page = f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>{html.escape(title)} · CDS 本机预览</title>
<style>body{{font: 14px system-ui; margin:16px; color-scheme:{theme}; background:Canvas; color:CanvasText}}
h1{{font-size:1.25rem}} iframe{{border:1px solid GrayText;display:block}}</style></head>
<body><h1>{html.escape(title)}</h1><p id="preview-status" role="status" data-state="loading">正在等待画面。</p>
<main id="preview-canvas"></main><script type="application/json" id="preview-options">{config}</script>
<script>{HOST_SCRIPT}</script></body></html>""".encode()
    prototype_content = decorate(prototype, contract).encode()
    policy = "; ".join(contract["csp"])

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, _format: str, *_args: Any) -> None:
            pass

        def trusted_host(self) -> bool:
            return self.headers.get("Host") == f"127.0.0.1:{self.server.server_port}"

        def send_html(self, body: bytes, csp: str) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Content-Security-Policy", csp)
            self.send_header("X-Frame-Options", "SAMEORIGIN")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Cross-Origin-Resource-Policy", "same-origin")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Cache-Control", "private, no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            path = urlsplit(self.path).path
            if not self.trusted_host():
                self.send_error(403)
            elif path == "/prototype":
                self.send_html(prototype_content, policy)
            elif path == "/":
                self.send_html(page, "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
                                     "frame-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
            else:
                self.send_error(404)

        def do_POST(self) -> None:
            origin = f"http://127.0.0.1:{self.server.server_port}"
            if not self.trusted_host() or self.headers.get("Origin") != origin or self.path != "/diagnostics":
                self.send_error(403)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 1024 or self.headers.get("Content-Type") != "application/json":
                    raise ValueError
                report = json.loads(self.rfile.read(length))
                state, diagnostics, reason = report["state"], report["diagnostics"], report["reason"]
                if state not in ("loading", "ready", "failed") or not isinstance(diagnostics, dict) or not isinstance(reason, str):
                    raise ValueError
            except (KeyError, TypeError, ValueError):
                self.send_error(400)
                return
            print(preview_summary(state, diagnostics, reason), file=sys.stderr, flush=True)
            self.send_response(204)
            self.end_headers()

    with ThreadingHTTPServer(("127.0.0.1", port), Handler) as server:
        print(f"http://127.0.0.1:{server.server_port}/", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
