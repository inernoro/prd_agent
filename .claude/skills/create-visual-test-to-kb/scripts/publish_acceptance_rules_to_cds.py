#!/usr/bin/env python3
"""Publish repository acceptance-rule Markdown documents to CDS reports.

The repository `doc/` files are the SSOT. CDS reports are an online Markdown
view of those files, not an independently styled document copy.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[4]

DOCS = {
    "enterprise": {
        "sourceId": "acceptance.rule.enterprise",
        "title": "MAP 企业级自动化验收规范",
        "path": "doc/rule.acceptance.map-enterprise.md",
        "reportIds": [
            "0efbef7c40fc4d94a8b14e60113524a9",
            "2f497f6aabc84974bd8c76bff8c6439a",
            "f10edd7d10fd4ed999c936d733980382",
            "6bca595f70fb4d26b644490471d33680",
            "bd3c43a70b44419bbd25dc57ffa18cc3",
        ],
    },
    "daily-sop": {
        "sourceId": "acceptance.guide.daily-sop",
        "title": "MAP 每日自动化验收 SOP",
        "path": "doc/guide.acceptance.daily-sop.md",
        "reportIds": ["cf097d19b4b649ad92b15546bf13d996"],
    },
    "ssot": {
        "sourceId": "acceptance.rule.ssot",
        "title": "MAP 验收规范 SSOT",
        "path": "doc/rule.acceptance.ssot.md",
        "reportIds": ["3992cb728a9c4a23958b4ec92933f59b"],
    },
    "governance": {
        "sourceId": "acceptance.design.knowledge-governance",
        "title": "MAP 自动化验收知识库治理设计",
        "path": "doc/design.acceptance.knowledge-governance.md",
        "reportIds": ["c67d7301c52d41359fc691978d923426"],
    },
    "report-evidence": {
        "sourceId": "acceptance.guide.report-evidence",
        "title": "MAP 验收报告与证据交互规范",
        "path": "doc/guide.acceptance.report-evidence.md",
        "reportIds": ["7bcc189776354b7db1600dcb91c97e17"],
    },
}


def git_commit() -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
        ).strip()
    except Exception:
        return "unknown"


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def cds_base() -> str:
    host = os.environ.get("CDS_HOST", "").strip()
    if not host:
        raise SystemExit("CDS_HOST 未设置")
    if not host.startswith("http"):
        host = "http://" + host if host.startswith(("localhost", "127.", "0.0.0.0")) else "https://" + host
    return host.rstrip("/")


def headers() -> dict[str, str]:
    h = {"User-Agent": "acceptance-rule-publisher/1.0"}
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
        raise SystemExit(f"HTTP {exc.code} {method} {path}: {raw[:500]}")


def load_sources() -> list[dict[str, Any]]:
    source_commit = git_commit()
    loaded: list[dict[str, Any]] = []
    for source_id, spec in DOCS.items():
        path = ROOT / str(spec["path"])
        if not path.is_file():
            raise SystemExit(f"missing source doc: {spec['path']}")
        content = path.read_text(encoding="utf-8").rstrip() + "\n"
        loaded.append({
            "sourceId": spec["sourceId"],
            "title": spec["title"],
            "sourcePath": spec["path"],
            "sourceCommit": source_commit,
            "contentHash": "sha256:" + sha256_text(content),
            "content": content,
            "reportIds": list(spec["reportIds"]),
        })
    return loaded


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    results: list[dict[str, Any]] = []
    published_at = datetime.now(timezone.utc).isoformat()
    for source in load_sources():
        for report_id in source["reportIds"]:
            payload = {
                "title": source["title"],
                "format": "md",
                "content": source["content"],
                "tier": "acceptance-rule-ssot",
                "commitSha": source["sourceCommit"],
                "deployMode": "repo-doc-markdown",
                "sourceId": source["sourceId"],
                "sourcePath": source["sourcePath"],
                "contentHash": source["contentHash"],
                "publishedAt": published_at,
            }
            if not args.dry_run:
                updated = call("PATCH", f"/api/reports/{urllib.parse.quote(report_id)}", payload)
                report = updated.get("report", {}) if isinstance(updated, dict) else {}
                if report.get("format") != "md":
                    raise SystemExit(f"{report_id} format verify failed: {report.get('format')}")
                raw = call("GET", f"/api/reports/{urllib.parse.quote(report_id)}/raw")
                if raw != source["content"]:
                    raise SystemExit(f"{report_id} content verify failed")
            results.append({
                "reportId": report_id,
                "title": source["title"],
                "sourcePath": source["sourcePath"],
                "sourceCommit": source["sourceCommit"],
                "contentHash": source["contentHash"],
                "format": "md",
                "changed": not args.dry_run,
            })
    print(json.dumps({"dryRun": args.dry_run, "results": results}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
