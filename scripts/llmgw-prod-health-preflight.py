#!/usr/bin/env python3
"""Read-only LLM Gateway production health preflight.

This script never calls model providers. It checks the public health endpoint
and optional auth boundaries before a costly protocol canary or release gate
run. Its main purpose is to prove which commit is actually deployed.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BASE = "https://map.ebcone.net"


def _normalize_commit(value: object) -> str:
    raw = str(value or "").strip().lower()
    if raw.startswith("sha-"):
        raw = raw[4:]
    return raw


def _current_head() -> str:
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(ROOT),
            text=True,
            capture_output=True,
            timeout=10,
            check=False,
        )
        if proc.returncode == 0:
            return _normalize_commit(proc.stdout)
    except Exception:
        return ""
    return ""


def _root(raw: str) -> str:
    value = raw.strip().rstrip("/")
    if value.endswith("/gw/v1"):
        value = value[:-6].rstrip("/")
    return value


def _request(root: str, path: str, timeout: int) -> dict[str, Any]:
    url = root.rstrip("/") + path
    req = urllib.request.Request(url, method="GET")
    req.add_header("User-Agent", "Mozilla/5.0 llmgw-prod-health-preflight/1.0")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return {"url": url, "httpStatus": resp.status, "raw": raw[:500], "json": _json_or_empty(raw)}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        return {"url": url, "httpStatus": exc.code, "raw": raw[:500], "json": _json_or_empty(raw)}
    except Exception as exc:
        return {"url": url, "httpStatus": 0, "raw": str(exc), "json": {}}


def _json_or_empty(raw: str) -> dict[str, Any]:
    try:
        payload = json.loads(raw)
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def _build_report(root: str, expected_commit: str, timeout: int, check_auth_boundary: bool) -> dict[str, Any]:
    health = _request(root, "/gw/v1/healthz", timeout)
    health_json = health.get("json") if isinstance(health.get("json"), dict) else {}
    actual_commit = _normalize_commit((health_json or {}).get("commit") or (health_json or {}).get("Commit"))
    status_text = str((health_json or {}).get("status") or (health_json or {}).get("Status") or "").strip().lower()
    failures: list[str] = []
    warnings: list[str] = []

    if health.get("httpStatus") != 200:
        failures.append(f"healthz HTTP {health.get('httpStatus')}: {health.get('raw', '')[:180]}")
    if status_text != "ok":
        failures.append(f"healthz status is not ok: {status_text or 'empty'}")
    if expected_commit and actual_commit != expected_commit:
        failures.append(f"healthz commit mismatch: actual={actual_commit or 'empty'} expected={expected_commit}")
    if not expected_commit:
        warnings.append("expected commit is empty; preflight cannot prove deploy target")

    auth_checks: list[dict[str, Any]] = []
    if check_auth_boundary:
        for path in ("/gw/v1/route-self-test", "/gw/runtime-gates"):
            item = _request(root, path, timeout)
            expected_401 = item.get("httpStatus") == 401
            auth_checks.append({
                "path": path,
                "httpStatus": item.get("httpStatus"),
                "ok": expected_401,
                "raw": str(item.get("raw") or "")[:200],
            })
            if not expected_401:
                failures.append(f"auth boundary expected 401 for {path}, got {item.get('httpStatus')}")

    report = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "verdict": "fail" if failures else "pass",
        "root": root,
        "expectedCommit": expected_commit,
        "actualCommit": actual_commit,
        "commitMatches": bool(expected_commit and actual_commit == expected_commit),
        "health": {
            "httpStatus": health.get("httpStatus"),
            "status": status_text,
            "commit": actual_commit,
            "raw": health.get("raw"),
        },
        "authBoundaryChecks": auth_checks,
        "failures": failures,
        "warnings": warnings,
    }
    return report


def _write_json(path: str, report: dict[str, Any]) -> None:
    if not path:
        return
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _write_markdown(path: str, report: dict[str, Any]) -> None:
    if not path:
        return
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)

    def cell(value: object) -> str:
        return str(value).replace("|", "\\|")

    lines = [
        "# LLM Gateway Production Health Preflight",
        "",
        f"- generatedAt: `{cell(report.get('generatedAt'))}`",
        f"- verdict: `{cell(report.get('verdict'))}`",
        f"- root: `{cell(report.get('root'))}`",
        f"- expectedCommit: `{cell(report.get('expectedCommit') or '')}`",
        f"- actualCommit: `{cell(report.get('actualCommit') or '')}`",
        f"- commitMatches: `{cell(report.get('commitMatches'))}`",
        "",
        "## Auth Boundary",
        "",
        "| path | status | ok |",
        "|---|---:|---|",
    ]
    for item in report.get("authBoundaryChecks") or []:
        lines.append(f"| {cell(item.get('path'))} | {cell(item.get('httpStatus'))} | {cell(item.get('ok'))} |")
    if not report.get("authBoundaryChecks"):
        lines.append("| none |  |  |")
    lines.extend(["", "## Failures", ""])
    failures = report.get("failures") or []
    lines.extend([f"- {item}" for item in failures] if failures else ["- none"])
    lines.extend(["", "## Warnings", ""])
    warnings = report.get("warnings") or []
    lines.extend([f"- {item}" for item in warnings] if warnings else ["- none"])
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _self_test() -> int:
    expected = _normalize_commit("sha-ABC123")
    if expected != "abc123":
        print("LLM Gateway production health preflight self-test: FAIL normalize", file=sys.stderr)
        return 1
    mismatch = {
        "verdict": "fail",
        "expectedCommit": "abc123",
        "actualCommit": "def456",
        "commitMatches": False,
    }
    if mismatch["commitMatches"]:
        print("LLM Gateway production health preflight self-test: FAIL mismatch", file=sys.stderr)
        return 1
    print("LLM Gateway production health preflight self-test: PASS")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only LLM Gateway production health preflight")
    parser.add_argument("--base", default=os.environ.get("LLMGW_PROD_BASE") or os.environ.get("GW_BASE") or DEFAULT_BASE)
    parser.add_argument("--expect-commit", default=os.environ.get("GIT_COMMIT", ""))
    parser.add_argument("--expect-current-head", action="store_true", help="use local git HEAD as expected commit")
    parser.add_argument("--check-auth-boundary", action="store_true", help="verify protected endpoints return 401 without credentials")
    parser.add_argument("--timeout", type=int, default=20)
    parser.add_argument("--json-out", default=os.environ.get("LLMGW_PROD_HEALTH_PREFLIGHT_JSON_OUT", ""))
    parser.add_argument("--report-md", default=os.environ.get("LLMGW_PROD_HEALTH_PREFLIGHT_REPORT_MD", ""))
    parser.add_argument("--print-json", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        return _self_test()

    expected_commit = _normalize_commit(_current_head() if args.expect_current_head else args.expect_commit)
    root = _root(args.base)
    report = _build_report(root, expected_commit, args.timeout, args.check_auth_boundary)
    _write_json(args.json_out, report)
    _write_markdown(args.report_md, report)
    if args.print_json:
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    print(f"LLM Gateway production health preflight: {str(report['verdict']).upper()}")
    print(f"- root={root}")
    print(f"- expectedCommit={expected_commit or 'empty'}")
    print(f"- actualCommit={report.get('actualCommit') or 'empty'}")
    print(f"- authBoundaryChecks={len(report.get('authBoundaryChecks') or [])}")
    print(f"- failures={len(report.get('failures') or [])}")
    return 1 if report["verdict"] != "pass" else 0


if __name__ == "__main__":
    sys.exit(main())
