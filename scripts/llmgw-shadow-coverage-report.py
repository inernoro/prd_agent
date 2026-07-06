#!/usr/bin/env python3
"""LLM Gateway shadow coverage report.

This is a read-only evidence collector for S5/S6 rollout. It queries
/gw/v1/shadow-comparisons and renders an appCaller x kind coverage matrix
without printing the gateway key.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone


def _default_base() -> str:
    raw = os.environ.get("GW_BASE", "").strip().rstrip("/")
    if raw:
        return raw
    try:
        proc = subprocess.run(
            ["python3", ".claude/skills/cds/cli/cdscli.py", "--human", "preview-url"],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        root = next((line.strip() for line in proc.stdout.splitlines() if line.startswith("http")), "")
        if root:
            return root.rstrip("/") + "/gw/v1"
    except Exception:
        return ""
    return ""


def _split_csv(raw: str) -> list[str]:
    out: list[str] = []
    for item in raw.replace(";", ",").split(","):
        value = item.strip()
        if value:
            out.append(value)
    return out


def _request(base: str, key: str, query: dict[str, str]) -> tuple[int, str]:
    encoded = urllib.parse.urlencode(query)
    suffix = f"?{encoded}" if encoded else ""
    req = urllib.request.Request(base + "/shadow-comparisons" + suffix, method="GET")
    req.add_header("User-Agent", "Mozilla/5.0 llmgw-shadow-coverage/1.0")
    req.add_header("X-Gateway-Key", key)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")
    except Exception as exc:
        return 0, f"ERR {exc}"


def _summary_from_payload(raw: str) -> dict:
    payload = json.loads(raw)
    summary = payload.get("summary") or payload.get("Summary") or {}
    return {
        "total": int(summary.get("total") or summary.get("Total") or 0),
        "allMatch": int(summary.get("allMatch") or summary.get("AllMatch") or 0),
        "critical": int(summary.get("critical") or summary.get("Critical") or 0),
        "httpFail": int(summary.get("httpFail") or summary.get("HttpFail") or 0),
        "firstComparedAt": summary.get("firstComparedAt") or summary.get("FirstComparedAt"),
        "lastComparedAt": summary.get("lastComparedAt") or summary.get("LastComparedAt"),
        "coverageHours": float(summary.get("coverageHours") or summary.get("CoverageHours") or 0),
    }


def _cell(
    base: str,
    key: str,
    app: str | None,
    kind: str | None,
    min_total: int,
    since_hours: float,
    min_coverage_hours: float,
) -> dict:
    query: dict[str, str] = {}
    label = "global"
    if app:
        query["appCallerCode"] = app
        label = app
    if kind:
        query["kind"] = kind
        label = f"{label}/{kind}"
    if since_hours > 0:
        query["sinceHours"] = f"{since_hours:g}"

    code, raw = _request(base, key, query)
    result = {
        "label": label,
        "appCallerCode": app,
        "kind": kind,
        "requiredTotal": min_total,
        "sinceHours": since_hours,
        "minCoverageHours": min_coverage_hours,
        "httpStatus": code,
        "total": 0,
        "allMatch": 0,
        "critical": 0,
        "httpFail": 0,
        "firstComparedAt": None,
        "lastComparedAt": None,
        "coverageHours": 0.0,
        "ok": False,
        "failures": [],
    }
    if code != 200:
        result["failures"].append(f"HTTP {code}: {raw[:200]}")
        return result

    try:
        result.update(_summary_from_payload(raw))
    except Exception as exc:
        result["failures"].append(f"invalid JSON: {exc}")
        return result

    if result["total"] < min_total:
        result["failures"].append(f"样本不足 total={result['total']}, required={min_total}")
    if min_coverage_hours > 0 and result["coverageHours"] < min_coverage_hours:
        result["failures"].append(
            f"覆盖时长不足 coverageHours={result['coverageHours']:.2f}, required={min_coverage_hours:g}"
        )
    if result["critical"] != 0:
        result["failures"].append(f"critical mismatch 未清零: {result['critical']}")
    if result["httpFail"] != 0:
        result["failures"].append(f"httpFail 未清零: {result['httpFail']}")
    result["ok"] = not result["failures"]
    return result


def _write_json(path: str, report: dict) -> None:
    if not path:
        return
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2, sort_keys=True)
        fh.write("\n")


def _write_markdown(path: str, report: dict) -> None:
    if not path:
        return
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)

    def cell(value: object) -> str:
        return str(value).replace("|", "\\|")

    with open(path, "w", encoding="utf-8") as fh:
        fh.write("# LLM Gateway Shadow Coverage Report\n\n")
        fh.write(f"- generatedAt: `{cell(report['generatedAt'])}`\n")
        fh.write(f"- verdict: `{cell(report['verdict'])}`\n")
        fh.write(f"- base: `{cell(report['base'])}`\n")
        fh.write(f"- sinceHours: `{cell(report['sinceHours'])}`\n")
        fh.write(f"- minPerCell: `{cell(report['minPerCell'])}`\n\n")
        fh.write(f"- minCoverageHours: `{cell(report['minCoverageHours'])}`\n\n")
        fh.write("| label | required | minCoverageHours | total | coverageHours | allMatch | critical | httpFail | status | failures |\n")
        fh.write("|---|---:|---:|---:|---:|---:|---:|---:|---|---|\n")
        for item in report["cells"]:
            status = "pass" if item.get("ok") else "fail"
            failures = "; ".join(item.get("failures") or [])
            fh.write(
                f"| {cell(item.get('label'))} | {cell(item.get('requiredTotal'))} | "
                f"{cell(item.get('minCoverageHours'))} | "
                f"{cell(item.get('total'))} | {cell(round(float(item.get('coverageHours') or 0), 2))} | "
                f"{cell(item.get('allMatch'))} | "
                f"{cell(item.get('critical'))} | {cell(item.get('httpFail'))} | "
                f"{status} | {cell(failures)} |\n"
            )


def main() -> int:
    parser = argparse.ArgumentParser(description="LLM Gateway shadow coverage matrix report")
    parser.add_argument("--base", default=_default_base(), help="serving base URL, e.g. https://host/gw/v1")
    parser.add_argument("--key", default=os.environ.get("GW_KEY", ""), help="X-Gateway-Key")
    parser.add_argument("--app-caller", action="append", default=[], help="appCallerCode to include; repeatable")
    parser.add_argument("--kind", action="append", default=[], help="shadow kind to include; repeatable, default send+stream")
    parser.add_argument("--min-per-cell", type=int, default=int(os.environ.get("LLMGW_GATE_MIN_PER_APP", "30")))
    parser.add_argument("--since-hours", type=float, default=float(os.environ.get("LLMGW_GATE_SHADOW_SINCE_HOURS", "24")))
    parser.add_argument("--min-coverage-hours", type=float, default=float(os.environ.get("LLMGW_GATE_MIN_COVERAGE_HOURS", "0")))
    parser.add_argument("--json-out", default=os.environ.get("LLMGW_SHADOW_COVERAGE_JSON_OUT", ""))
    parser.add_argument("--report-md", default=os.environ.get("LLMGW_SHADOW_COVERAGE_REPORT_MD", ""))
    parser.add_argument("--print-json", action="store_true")
    args = parser.parse_args()

    base = (args.base or "").strip().rstrip("/")
    key = args.key.strip()
    app_callers = list(dict.fromkeys(args.app_caller + _split_csv(os.environ.get("LLMGW_HTTP_APP_CALLER_ALLOWLIST", ""))))
    kinds = list(dict.fromkeys(args.kind or ["send", "stream"]))

    report = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "verdict": "fail",
        "base": base,
        "sinceHours": max(0, args.since_hours),
        "minPerCell": args.min_per_cell,
        "minCoverageHours": max(0, args.min_coverage_hours),
        "appCallers": app_callers,
        "kinds": kinds,
        "cells": [],
        "failures": [],
    }

    if not base:
        report["failures"].append("missing --base/GW_BASE")
    if not key:
        report["failures"].append("missing --key/GW_KEY")

    if not report["failures"]:
        min_coverage_hours = max(0, args.min_coverage_hours)
        report["cells"].append(_cell(base, key, None, None, args.min_per_cell, max(0, args.since_hours), min_coverage_hours))
        for kind in kinds:
            report["cells"].append(_cell(base, key, None, kind, args.min_per_cell, max(0, args.since_hours), min_coverage_hours))
        for app in app_callers:
            for kind in kinds:
                report["cells"].append(_cell(base, key, app, kind, args.min_per_cell, max(0, args.since_hours), min_coverage_hours))
        for item in report["cells"]:
            for failure in item.get("failures") or []:
                report["failures"].append(f"{item['label']}: {failure}")

    report["verdict"] = "fail" if report["failures"] else "pass"
    _write_json(args.json_out, report)
    _write_markdown(args.report_md, report)
    if args.print_json:
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))

    print(f"LLM Gateway shadow coverage: {report['verdict'].upper()}")
    print(f"- cells={len(report['cells'])}")
    print(f"- failures={len(report['failures'])}")
    return 1 if report["failures"] else 0


if __name__ == "__main__":
    sys.exit(main())
