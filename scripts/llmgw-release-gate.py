#!/usr/bin/env python3
"""LLM Gateway 发布前证据门。

这个脚本只读 serving 网关：
  - /gw/v1/healthz 必须 200
  - /gw/v1/shadow-comparisons 必须可读
  - critical mismatch 必须为 0
  - httpFail 必须为 0
  - total 样本数必须达到阈值
  - 可选：只统计最近 N 小时 shadow 样本，避免旧证据误放行
  - 可选：要求 shadow 样本覆盖至少 N 小时，避免短时间突刺样本误放行灰度/全量
  - 可选：指定 kind/appCaller+kind 的真实样本数必须达到阈值，避免只靠 resolve-only 放行

用法：
  GW_BASE=https://<preview>-llmgw-serve.miduo.org/gw/v1 \
  GW_KEY=<X-Gateway-Key> \
  python3 scripts/llmgw-release-gate.py --min-total 30 \
    --app-caller report-agent.generate::chat --min-per-app 30 \
    --since-hours 24 \
    --require-kind send:30 \
    --require-app-kind report-agent.generate::chat:send:30
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
from time import sleep


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


def _request(method: str, base: str, path: str, key: str | None) -> tuple[int, str]:
    req = urllib.request.Request(base + path, method=method)
    req.add_header("User-Agent", "Mozilla/5.0 llmgw-release-gate/1.0")
    if key:
        req.add_header("X-Gateway-Key", key)

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")
    except Exception as exc:
        return 0, f"ERR {exc}"


def _json(raw: str) -> dict:
    try:
        value = json.loads(raw)
    except Exception as exc:
        raise ValueError(f"响应不是 JSON: {raw[:200]}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"响应不是 JSON object: {raw[:200]}")
    return value


def _parse_utc(value: object) -> datetime | None:
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    try:
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        parsed = datetime.fromisoformat(raw)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except ValueError:
        return None


def _shadow_check(
    base: str,
    key: str,
    app: str | None,
    min_total: int,
    kind: str | None = None,
    since_hours: float = 0,
    min_coverage_hours: float = 0,
) -> dict:
    label = "global"
    query_items: dict[str, str] = {}
    if app:
        query_items["appCallerCode"] = app
        label = app
    if kind:
        query_items["kind"] = kind
        label = f"{label}/{kind}"
    if since_hours > 0:
        query_items["sinceHours"] = f"{since_hours:g}"
    query = ("?" + urllib.parse.urlencode(query_items)) if query_items else ""

    code, raw = _request("GET", base, "/shadow-comparisons" + query, key)
    result = {
        "label": label,
        "appCallerCode": app,
        "kind": kind,
        "requiredTotal": min_total,
        "httpStatus": code,
        "total": 0,
        "allMatch": 0,
        "critical": 0,
        "httpFail": 0,
        "sinceHours": since_hours,
        "minCoverageHours": min_coverage_hours,
        "firstComparedAt": None,
        "lastComparedAt": None,
        "coverageHours": 0.0,
        "ok": False,
        "failures": [],
        "query": query_items,
    }
    if code != 200:
        result["failures"].append(f"shadow[{label}] HTTP {code}: {raw[:200]}")
        return result

    payload = _json(raw)
    summary = payload.get("summary") or payload.get("Summary") or {}
    total = int(summary.get("total") or summary.get("Total") or 0)
    all_match = int(summary.get("allMatch") or summary.get("AllMatch") or 0)
    critical = int(summary.get("critical") or summary.get("Critical") or 0)
    http_fail = int(summary.get("httpFail") or summary.get("HttpFail") or 0)
    first_raw = summary.get("firstComparedAt") or summary.get("FirstComparedAt")
    last_raw = summary.get("lastComparedAt") or summary.get("LastComparedAt")
    coverage_raw = summary.get("coverageHours") or summary.get("CoverageHours")
    first = _parse_utc(first_raw)
    last = _parse_utc(last_raw)
    try:
        coverage_hours = float(coverage_raw) if coverage_raw is not None else 0.0
    except (TypeError, ValueError):
        coverage_hours = 0.0
    if coverage_hours <= 0 and first is not None and last is not None:
        coverage_hours = max(0.0, (last - first).total_seconds() / 3600.0)
    result["total"] = total
    result["allMatch"] = all_match
    result["critical"] = critical
    result["httpFail"] = http_fail
    result["firstComparedAt"] = first.isoformat() if first is not None else None
    result["lastComparedAt"] = last.isoformat() if last is not None else None
    result["coverageHours"] = coverage_hours

    failures: list[str] = []
    if total < min_total:
        failures.append(f"shadow[{label}] 样本不足: total={total}, required={min_total}")
    if min_coverage_hours > 0 and coverage_hours < min_coverage_hours:
        failures.append(
            f"shadow[{label}] 观察时长不足: coverageHours={coverage_hours:.2f}, required={min_coverage_hours:g}"
        )
    if critical != 0:
        failures.append(f"shadow[{label}] critical mismatch 未清零: {critical}")
    if http_fail != 0:
        failures.append(f"shadow[{label}] httpFail 未清零: {http_fail}")
    result["failures"] = failures
    result["ok"] = not failures
    return result


def _check_shadow(base: str, key: str, app: str | None, min_total: int, kind: str | None = None) -> list[str]:
    return list(_shadow_check(base, key, app, min_total, kind).get("failures") or [])


def _health_check(base: str, expected_commit: str, samples: int, interval_seconds: float) -> dict:
    sample_count = max(1, samples)
    result = {
        "ok": False,
        "httpStatus": 0,
        "commit": "",
        "stable": False,
        "sampleCount": sample_count,
        "intervalSeconds": interval_seconds,
        "samples": [],
        "failures": [],
    }

    commits: list[str] = []
    failures: list[str] = []
    for idx in range(sample_count):
        code, raw = _request("GET", base, "/healthz", None)
        sample = {"index": idx + 1, "httpStatus": code, "commit": "", "raw": raw[:200]}
        if code != 200:
            failures.append(f"healthz sample {idx + 1}/{sample_count} HTTP {code}: {raw[:200]}")
        else:
            try:
                health = _json(raw)
                commit = str(health.get("commit") or health.get("Commit") or "")
                sample["commit"] = commit
                if commit:
                    commits.append(commit)
                if expected_commit and commit and commit != expected_commit:
                    failures.append(f"healthz sample {idx + 1}/{sample_count} commit 不匹配: actual={commit}, expected={expected_commit}")
            except ValueError as exc:
                failures.append(str(exc))
        result["samples"].append(sample)
        if idx < sample_count - 1 and interval_seconds > 0:
            sleep(interval_seconds)

    distinct_commits = sorted(set(commits))
    if len(distinct_commits) > 1:
        failures.append(f"healthz commit 漂移: {', '.join(distinct_commits)}")

    last_sample = result["samples"][-1] if result["samples"] else {}
    result["httpStatus"] = int(last_sample.get("httpStatus") or 0)
    result["commit"] = str(last_sample.get("commit") or "")
    result["stable"] = len(failures) == 0 and len(distinct_commits) <= 1
    result["failures"] = failures
    result["ok"] = not failures
    return result


def _parse_kind_requirement(raw: str, default_min: int) -> tuple[str, int]:
    value = raw.strip()
    if not value:
        raise ValueError("空 kind requirement")
    if ":" not in value:
        return value, default_min
    kind, min_raw = value.rsplit(":", 1)
    if not kind.strip() or not min_raw.strip().isdigit():
        raise ValueError(f"kind requirement 格式应为 kind 或 kind:min: {raw}")
    return kind.strip(), int(min_raw.strip())


def _parse_app_kind_requirement(raw: str) -> tuple[str, str, int]:
    parts = raw.strip().rsplit(":", 2)
    if len(parts) != 3 or not parts[0].strip() or not parts[1].strip() or not parts[2].strip().isdigit():
        raise ValueError(f"app kind requirement 格式应为 appCallerCode:kind:min: {raw}")
    return parts[0].strip(), parts[1].strip(), int(parts[2].strip())


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

    health = report.get("health") or {}
    checks = report.get("shadowChecks") or []
    failures = report.get("failures") or []
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("# LLM Gateway Release Gate Report\n\n")
        fh.write(f"- generatedAt: `{cell(report.get('generatedAt'))}`\n")
        fh.write(f"- verdict: `{cell(report.get('verdict'))}`\n")
        fh.write(f"- base: `{cell(report.get('base'))}`\n")
        fh.write(f"- healthStatus: `{cell(health.get('httpStatus'))}`\n")
        fh.write(f"- healthCommit: `{cell(health.get('commit') or '')}`\n")
        fh.write(f"- healthStable: `{cell(health.get('stable'))}`\n")
        fh.write(f"- healthSamples: `{cell(health.get('sampleCount'))}`\n")
        fh.write(f"- expectedCommit: `{cell(report.get('expectedCommit') or '')}`\n\n")
        fh.write(f"- shadowSinceHours: `{cell((report.get('thresholds') or {}).get('shadowSinceHours'))}`\n")
        fh.write(f"- minCoverageHours: `{cell((report.get('thresholds') or {}).get('minCoverageHours'))}`\n\n")
        fh.write("| label | sinceHours | minCoverageHours | coverageHours | required | total | allMatch | critical | httpFail | status |\n")
        fh.write("|---|---:|---:|---:|---:|---:|---:|---:|---:|---|\n")
        for item in checks:
            status = "pass" if item.get("ok") else "fail"
            fh.write(
                f"| {cell(item.get('label'))} | {cell(item.get('sinceHours'))} | "
                f"{cell(item.get('minCoverageHours'))} | {cell(round(float(item.get('coverageHours') or 0), 2))} | "
                f"{cell(item.get('requiredTotal'))} | {cell(item.get('total'))} | {cell(item.get('allMatch'))} | "
                f"{cell(item.get('critical'))} | {cell(item.get('httpFail'))} | {status} |\n"
            )
        fh.write("\n")
        if failures:
            fh.write("## Failures\n\n")
            for item in failures:
                fh.write(f"- {item}\n")
        else:
            fh.write("## Failures\n\n- none\n")


def _finalize(report: dict, failures: list[str], json_out: str, report_md: str, print_json: bool) -> int:
    report["failures"] = failures
    report["verdict"] = "fail" if failures else "pass"
    _write_json(json_out, report)
    _write_markdown(report_md, report)
    if print_json:
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 1 if failures else 0


def main() -> int:
    parser = argparse.ArgumentParser(description="LLM Gateway 发布前证据门")
    parser.add_argument("--base", default="", help="serving base URL, e.g. https://host/gw/v1")
    parser.add_argument("--key", default=os.environ.get("GW_KEY", ""), help="X-Gateway-Key")
    parser.add_argument("--min-total", type=int, default=30, help="全局 shadow 最小样本数")
    parser.add_argument("--min-per-app", type=int, default=30, help="每个 --app-caller 的最小样本数")
    parser.add_argument("--app-caller", action="append", default=[], help="需要逐个 gate 的 appCallerCode，可重复")
    parser.add_argument("--require-kind", action="append", default=[],
                        help="要求某类 shadow Kind 达到最小样本数，格式 kind 或 kind:min，可重复")
    parser.add_argument("--require-app-kind", action="append", default=[],
                        help="要求某个 appCallerCode 的某类 Kind 达到最小样本数，格式 appCallerCode:kind:min，可重复")
    parser.add_argument("--since-hours", type=float, default=float(os.environ.get("LLMGW_GATE_SHADOW_SINCE_HOURS", "0")),
                        help="只统计最近 N 小时 shadow 样本；0 表示不限制。生产 http/canary 发布建议 >=24")
    parser.add_argument("--min-coverage-hours", type=float, default=float(os.environ.get("LLMGW_GATE_MIN_COVERAGE_HOURS", "0")),
                        help="要求每个 shadow 检查覆盖至少 N 小时；0 表示不限制。S5/S6 发布建议 >=24")
    parser.add_argument("--expect-commit", default=os.environ.get("GIT_COMMIT", ""), help="可选：healthz commit 必须匹配")
    parser.add_argument("--health-samples", type=int, default=int(os.environ.get("LLMGW_GATE_HEALTH_SAMPLES", "1")),
                        help="healthz 连续采样次数，默认 1；正式全量 http 建议 >=3")
    parser.add_argument("--health-interval", type=float, default=float(os.environ.get("LLMGW_GATE_HEALTH_INTERVAL_SECONDS", "0")),
                        help="healthz 多次采样间隔秒数，默认 0")
    parser.add_argument("--json-out", default=os.environ.get("LLMGW_GATE_JSON_OUT", ""),
                        help="可选：把 gate 证据写成 JSON 文件，内容不包含密钥")
    parser.add_argument("--report-md", default=os.environ.get("LLMGW_GATE_REPORT_MD", ""),
                        help="可选：把 gate 证据写成 Markdown 报告，内容不包含密钥")
    parser.add_argument("--print-json", action="store_true", help="可选：向 stdout 打印完整 JSON 证据")
    args = parser.parse_args()

    base = (args.base or _default_base()).rstrip("/")
    report: dict = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "base": base,
        "expectedCommit": args.expect_commit,
        "thresholds": {
            "minTotal": args.min_total,
            "minPerApp": args.min_per_app,
            "shadowSinceHours": max(0, args.since_hours),
            "minCoverageHours": max(0, args.min_coverage_hours),
            "healthSamples": max(1, args.health_samples),
            "healthIntervalSeconds": args.health_interval,
        },
        "health": {
            "httpStatus": 0,
            "commit": "",
            "stable": False,
            "sampleCount": max(1, args.health_samples),
            "intervalSeconds": args.health_interval,
            "samples": [],
            "failures": [],
        },
        "shadowChecks": [],
        "failures": [],
        "verdict": "fail",
    }

    if not base:
        print("FAIL: 缺少 GW_BASE/--base，且 cdscli preview-url 未取到根域名")
        _finalize(
            report,
            ["缺少 GW_BASE/--base，且 cdscli preview-url 未取到根域名"],
            args.json_out,
            args.report_md,
            args.print_json,
        )
        return 2
    if not args.key:
        print("FAIL: 缺少 GW_KEY/--key，无法读取受保护 shadow-comparisons")
        _finalize(
            report,
            ["缺少 GW_KEY/--key，无法读取受保护 shadow-comparisons"],
            args.json_out,
            args.report_md,
            args.print_json,
        )
        return 2

    failures: list[str] = []

    health = _health_check(base, args.expect_commit, args.health_samples, args.health_interval)
    report["health"] = health
    failures.extend(health.get("failures") or [])

    shadow_checks: list[dict] = []
    since_hours = max(0, args.since_hours)
    min_coverage_hours = max(0, args.min_coverage_hours)
    shadow_checks.append(_shadow_check(base, args.key, None, args.min_total, since_hours=since_hours, min_coverage_hours=min_coverage_hours))
    for app in args.app_caller:
        shadow_checks.append(_shadow_check(base, args.key, app, args.min_per_app, since_hours=since_hours, min_coverage_hours=min_coverage_hours))
    for raw in args.require_kind:
        try:
            kind, min_total = _parse_kind_requirement(raw, args.min_per_app)
        except ValueError as exc:
            failures.append(str(exc))
            continue
        shadow_checks.append(_shadow_check(base, args.key, None, min_total, kind=kind, since_hours=since_hours, min_coverage_hours=min_coverage_hours))
    for raw in args.require_app_kind:
        try:
            app, kind, min_total = _parse_app_kind_requirement(raw)
        except ValueError as exc:
            failures.append(str(exc))
            continue
        shadow_checks.append(_shadow_check(base, args.key, app, min_total, kind=kind, since_hours=since_hours, min_coverage_hours=min_coverage_hours))

    report["shadowChecks"] = shadow_checks
    for item in shadow_checks:
        failures.extend(item.get("failures") or [])

    if failures:
        _finalize(report, failures, args.json_out, args.report_md, args.print_json)
        print("LLM Gateway release gate: FAIL")
        for item in failures:
            print(f"- {item}")
        return 1

    _finalize(report, failures, args.json_out, args.report_md, args.print_json)
    print("LLM Gateway release gate: PASS")
    print(f"- base={base}")
    print(f"- global_min_total={args.min_total}")
    if since_hours > 0:
        print(f"- shadow_since_hours={since_hours:g}")
    if min_coverage_hours > 0:
        print(f"- min_coverage_hours={min_coverage_hours:g}")
    if args.app_caller:
        print(f"- app_callers={len(args.app_caller)} min_per_app={args.min_per_app}")
    if args.require_kind:
        print(f"- required_kinds={len(args.require_kind)}")
    if args.require_app_kind:
        print(f"- required_app_kinds={len(args.require_app_kind)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
