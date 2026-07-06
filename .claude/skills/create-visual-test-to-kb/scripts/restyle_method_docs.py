#!/usr/bin/env python3
"""
Restyle the CDS-hosted MAP automation testing standard articles.

These are not daily acceptance reports. They are long-lived method documents
linked from acceptance reports, so they keep their existing report ids and
share links while this script replaces only the document chrome CSS.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


METHOD_DOCS = [
    ("0efbef7c40fc4d94a8b14e60113524a9", "MAP自动化测试规范总览"),
    ("cf097d19b4b649ad92b15546bf13d996", "广度冒烟与深度验收分级规范"),
    ("3992cb728a9c4a23958b4ec92933f59b", "PR commit 到结果映射与改动断言规范"),
    ("2f497f6aabc84974bd8c76bff8c6439a", "影响面矩阵规范"),
    ("f10edd7d10fd4ed999c936d733980382", "融合测试设计规范"),
    ("6bca595f70fb4d26b644490471d33680", "证明力矩阵规范"),
    ("bd3c43a70b44419bbd25dc57ffa18cc3", "覆盖率与缺口账本规范"),
    ("c67d7301c52d41359fc691978d923426", "页面优先证据规范"),
    ("7bcc189776354b7db1600dcb91c97e17", "截图与视觉证据规范"),
]


AUTHORITATIVE_DOC_CSS = r"""
:root{color-scheme:light;--ink:#111827;--text:#1f2937;--muted:#4b5563;--subtle:#6b7280;--line:#cfd7e3;--line-strong:#9aa7b5;--paper:#fff;--page:#eef2f7;--soft:#f7f9fc;--blue:#005ea8;--blue-soft:#e8f2ff;--red:#b42318;--red-soft:#fff1f0;--orange:#b35c00;--orange-soft:#fff7e8;--green:#00703c;--green-soft:#ecfdf3;--shadow:0 1px 2px rgba(16,24,40,.06)}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:var(--text);background:var(--page);line-height:1.66}
.wrap{width:min(1120px,calc(100% - 48px));margin:0 auto;padding:34px 0 72px}.hero{position:relative;background:var(--paper);color:var(--ink);border:1px solid var(--line);border-top:8px solid var(--ink);border-radius:3px;padding:30px 34px;margin-bottom:18px;box-shadow:var(--shadow)}.hero:before{content:"MAP AUTOMATION TESTING STANDARD";display:block;margin:0 0 12px;color:var(--blue);font-size:12px;line-height:1;font-weight:900;letter-spacing:.08em}.hero h1{font-size:34px;line-height:1.18;margin:0 0 10px;font-weight:900;letter-spacing:0;color:var(--ink)}.hero p{max-width:860px;margin:0;color:var(--muted);font-size:16px}.meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:20px}.pill{display:inline-flex;align-items:center;min-height:26px;border-radius:3px;padding:3px 9px;font-size:13px;font-weight:850;background:var(--blue-soft);color:#0b4a7f;border:1px solid #b6d7f2}.pill.red{background:var(--red-soft);color:var(--red);border-color:#f0b4ae}.pill.orange{background:var(--orange-soft);color:var(--orange);border-color:#f1c27a}.pill.green{background:var(--green-soft);color:var(--green);border-color:#9bd3b0}
.toc{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px;margin:0 0 18px}.toc a{display:block;background:var(--paper);border:1px solid var(--line);border-left:4px solid var(--blue);border-radius:3px;padding:9px 11px;color:var(--blue);font-weight:800;text-decoration:none;box-shadow:var(--shadow)}.toc a:hover{border-color:var(--blue);background:#f8fbff}.toc a:focus-visible,a:focus-visible,button:focus-visible{outline:3px solid var(--blue);outline-offset:2px}
section{background:var(--paper);border:1px solid var(--line);border-radius:3px;padding:24px 26px;margin:18px 0;box-shadow:var(--shadow)}section:target{outline:4px solid #facc15;outline-offset:4px}h2{font-size:24px;line-height:1.28;margin:0 0 14px;padding-bottom:9px;border-bottom:2px solid var(--line);font-weight:900;color:var(--ink);letter-spacing:0}h3{font-size:18px;line-height:1.35;margin:22px 0 10px;color:var(--ink);font-weight:850}p{margin:10px 0}a{color:var(--blue);font-weight:750;text-decoration:underline;text-underline-offset:2px}code{background:#f3f6fa;border:1px solid #d8e0ea;border-radius:3px;padding:1px 5px;font-size:.95em}.small{font-size:13px;color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.rule-card{border:1px solid var(--line);border-left:5px solid var(--blue);border-radius:3px;padding:15px;background:#fbfdff}.rule-card strong{display:block;margin-bottom:6px;color:var(--ink);font-weight:900}.callout{border:1px solid #b6d7f2;border-left:6px solid var(--blue);background:var(--blue-soft);padding:14px 16px;border-radius:3px;margin:14px 0}.warn{border-color:#f0b4ae;border-left-color:var(--red);background:var(--red-soft)}.ok{border-color:#9bd3b0;border-left-color:var(--green);background:var(--green-soft)}
table{width:100%;border-collapse:separate;border-spacing:0;margin:14px 0;background:var(--paper);border:1px solid var(--line);border-radius:3px;overflow:hidden}th,td{border-right:1px solid var(--line);border-bottom:1px solid var(--line);padding:11px 12px;vertical-align:top;text-align:left}th:last-child,td:last-child{border-right:0}tr:last-child td{border-bottom:0}th{background:#eef2f7;color:var(--ink);font-weight:900}tbody tr:hover td{background:#f8fbff}.mark-red{color:var(--red);font-weight:900}.source-list{padding-left:20px}.source-list li{margin:8px 0}
@media(max-width:820px){.wrap{width:min(100% - 28px,1120px);padding:22px 0 56px}.hero{padding:24px 18px}.hero h1{font-size:26px}.grid{grid-template-columns:1fr}section{padding:20px 16px}.toc{grid-template-columns:1fr}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
""".strip()


def cds_base() -> str:
    host = os.environ.get("CDS_HOST", "").strip()
    if not host:
        raise SystemExit("CDS_HOST 未设置")
    if not host.startswith("http"):
        host = "http://" + host if host.startswith(("localhost", "127.", "0.0.0.0")) else "https://" + host
    return host.rstrip("/")


def headers() -> dict[str, str]:
    h = {"User-Agent": "curl/8.5.0"}
    key = os.environ.get("CDS_PROJECT_KEY", "").strip() or os.environ.get("AI_ACCESS_KEY", "").strip()
    if key:
        h["X-AI-Access-Key"] = key
    return h


def call(method: str, path: str, body: Any | None = None) -> Any:
    data = None
    h = headers()
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        h["Content-Type"] = "application/json; charset=utf-8"
    req = urllib.request.Request(cds_base() + path, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode("utf-8", "replace")
            ctype = resp.headers.get("Content-Type", "")
            if "application/json" in ctype:
                return json.loads(raw)
            return raw
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        raise SystemExit(f"HTTP {exc.code} {method} {path}: {raw[:300]}")


def restyle_html(html: str) -> str:
    if "<style>" not in html or "</style>" not in html:
        raise ValueError("HTML 缺少 <style>，拒绝盲改")
    return re.sub(r"<style>.*?</style>", "<style>\n" + AUTHORITATIVE_DOC_CSS + "\n</style>", html, count=1, flags=re.S)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--backup-dir", default=f"/tmp/map-authoritative-doc-backup-{int(time.time())}")
    args = ap.parse_args()

    backup = Path(args.backup_dir)
    backup.mkdir(parents=True, exist_ok=True)
    results = []
    for report_id, title in METHOD_DOCS:
        raw = call("GET", f"/api/reports/{urllib.parse.quote(report_id)}/raw")
        if not isinstance(raw, str):
            raise SystemExit(f"{report_id} raw 不是字符串")
        backup_path = backup / f"{report_id}-{title}.html"
        backup_path.write_text(raw, encoding="utf-8")
        next_html = restyle_html(raw)
        changed = next_html != raw
        if changed and not args.dry_run:
            call("PATCH", f"/api/reports/{urllib.parse.quote(report_id)}", {"content": next_html, "title": title})
        results.append({"id": report_id, "title": title, "changed": changed, "bytes": len(next_html)})
    print(json.dumps({"dryRun": args.dry_run, "backupDir": str(backup), "results": results}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
