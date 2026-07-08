#!/usr/bin/env python3
"""Read-only LLM Gateway rollout status board.

This helper composes existing read-only evidence tools:
  - /gw/v1/healthz
  - scripts/llmgw-shadow-coverage-report.py
  - scripts/llmgw-shadow-sample-plan.py

It never calls MAP seed endpoints and never calls model providers.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REQUIRE_APP_KIND = ["report-agent.generate::chat:send:30"]


def _normalize_commit(value: object) -> str:
    raw = str(value or "").strip()
    if raw.lower().startswith("sha-"):
        raw = raw[4:]
    return raw.lower()


def _read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise SystemExit(f"JSON root must be an object: {path}")
    return data


def _write_json(path: str, payload: dict[str, Any]) -> None:
    if not path:
        return
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _request_json(url: str) -> dict[str, Any]:
    req = urllib.request.Request(url, method="GET")
    req.add_header("User-Agent", "Mozilla/5.0 llmgw-rollout-status/1.0")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return {"ok": resp.status == 200, "httpStatus": resp.status, "json": json.loads(raw), "raw": raw[:500]}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        return {"ok": False, "httpStatus": exc.code, "json": {}, "raw": raw[:500]}
    except Exception as exc:
        return {"ok": False, "httpStatus": 0, "json": {}, "raw": str(exc)}


def _run(cmd: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=str(ROOT),
        text=True,
        capture_output=True,
        check=False,
        timeout=120,
    )


def _coverage_from_tool(args: argparse.Namespace, release_commit: str, tmp: Path) -> tuple[dict[str, Any], Path]:
    coverage_path = tmp / "coverage.json"
    cmd = [
        "python3",
        "scripts/llmgw-shadow-coverage-report.py",
        "--base",
        args.base,
        "--key",
        args.key,
        "--since-hours",
        str(args.since_hours),
        "--min-coverage-hours",
        str(args.min_coverage_hours),
        "--failure-sample-limit",
        str(args.failure_sample_limit),
        "--json-out",
        str(coverage_path),
    ]
    if release_commit:
        cmd.extend(["--release-commit", release_commit])
    if args.skip_global_cells:
        cmd.append("--skip-global-cells")
    for item in args.require_app_kind:
        cmd.extend(["--require-app-kind", item])
    for item in args.require_kind:
        cmd.extend(["--require-kind", item])

    proc = _run(cmd)
    if not coverage_path.exists():
        raise SystemExit(
            "coverage report did not write JSON\n"
            + proc.stdout[-2000:]
            + proc.stderr[-2000:]
        )
    return _read_json(coverage_path), coverage_path


def _plan_from_tool(args: argparse.Namespace, coverage_path: Path, tmp: Path) -> tuple[dict[str, Any], Path]:
    plan_path = tmp / "plan.json"
    cmd = [
        "python3",
        "scripts/llmgw-shadow-sample-plan.py",
        "--coverage-json",
        str(coverage_path),
        "--batch-yield",
        str(args.batch_yield),
        "--max-batches",
        str(args.max_batches),
        "--json-out",
        str(plan_path),
    ]
    if args.allow_window_extension:
        cmd.append("--allow-window-extension")

    proc = _run(cmd)
    if not plan_path.exists():
        raise SystemExit(
            "sample planner did not write JSON\n"
            + proc.stdout[-2000:]
            + proc.stderr[-2000:]
        )
    return _read_json(plan_path), plan_path


def _pct(done: float, total: float) -> int:
    if total <= 0:
        return 100 if done > 0 else 0
    return max(0, min(100, round(done * 100 / total)))


def _coverage_cells(coverage: dict[str, Any]) -> list[dict[str, Any]]:
    cells = coverage.get("cells") or []
    return [item for item in cells if isinstance(item, dict)]


def _item(name: str, progress: int, status: str, detail: str) -> dict[str, Any]:
    return {"name": name, "progress": progress, "status": status, "detail": detail}


def _cell_summary(cells: list[dict[str, Any]]) -> dict[str, Any]:
    if not cells:
        return {
            "count": 0,
            "samplePass": 0,
            "qualityPass": 0,
            "coveragePass": 0,
            "sampleProgress": 0,
            "coverageProgress": 0,
            "critical": 0,
            "httpFail": 0,
            "sampleDetail": "cells=0",
            "qualityDetail": "cells=0 critical=0 httpFail=0",
            "coverageDetail": "cells=0",
            "samplesOk": False,
            "qualityOk": False,
            "coverageOk": False,
        }

    sample_progress_values: list[int] = []
    coverage_progress_values: list[int] = []
    sample_pass = 0
    coverage_pass = 0
    quality_pass = 0
    critical_total = 0
    http_fail_total = 0
    sample_worst: dict[str, Any] | None = None
    coverage_worst: dict[str, Any] | None = None

    for cell in cells:
        total = int(cell.get("total") or 0)
        required = int(cell.get("requiredTotal") or 0)
        critical = int(cell.get("critical") or 0)
        http_fail = int(cell.get("httpFail") or 0)
        coverage_hours = float(cell.get("coverageHours") or 0)
        min_coverage_hours = float(cell.get("minCoverageHours") or 0)
        sample_progress = _pct(total, required)
        coverage_progress = _pct(coverage_hours, min_coverage_hours)
        sample_progress_values.append(sample_progress)
        coverage_progress_values.append(coverage_progress)
        critical_total += critical
        http_fail_total += http_fail
        if required > 0 and total >= required:
            sample_pass += 1
        if min_coverage_hours > 0 and coverage_hours >= min_coverage_hours:
            coverage_pass += 1
        if critical == 0 and http_fail == 0:
            quality_pass += 1
        if sample_worst is None or sample_progress < int(sample_worst["progress"]):
            sample_worst = {"progress": sample_progress, "cell": cell}
        if coverage_worst is None or coverage_progress < int(coverage_worst["progress"]):
            coverage_worst = {"progress": coverage_progress, "cell": cell}

    count = len(cells)
    sample_worst_cell = (sample_worst or {}).get("cell") or {}
    coverage_worst_cell = (coverage_worst or {}).get("cell") or {}
    return {
        "count": count,
        "samplePass": sample_pass,
        "qualityPass": quality_pass,
        "coveragePass": coverage_pass,
        "sampleProgress": min(sample_progress_values) if sample_progress_values else 0,
        "coverageProgress": min(coverage_progress_values) if coverage_progress_values else 0,
        "critical": critical_total,
        "httpFail": http_fail_total,
        "sampleDetail": (
            f"{sample_pass}/{count} cells pass; worst={sample_worst_cell.get('label') or '<unknown>'} "
            f"total={int(sample_worst_cell.get('total') or 0)}/{int(sample_worst_cell.get('requiredTotal') or 0)}"
        ),
        "qualityDetail": f"{quality_pass}/{count} cells pass; critical={critical_total} httpFail={http_fail_total}",
        "coverageDetail": (
            f"{coverage_pass}/{count} cells pass; worst={coverage_worst_cell.get('label') or '<unknown>'} "
            f"coverageHours={float(coverage_worst_cell.get('coverageHours') or 0):.3f}/"
            f"{float(coverage_worst_cell.get('minCoverageHours') or 0):g}"
        ),
        "samplesOk": sample_pass == count,
        "qualityOk": quality_pass == count,
        "coverageOk": coverage_pass == count,
    }


def _decision(plan: dict[str, Any]) -> tuple[str, str]:
    reason = str(plan.get("reason") or "")
    recommended = int(plan.get("recommendedBatches") or 0)
    can_run = bool(plan.get("canRunRecommendedBatches"))
    if reason == "already-ready":
        return "ready-for-release-gate", "样本、质量、覆盖窗口均已达标；下一步跑 release gate 和阶段 dry-run。"
    if reason == "window-extension-top-up" and can_run and recommended == 1:
        return "run-one-window-extension", "允许补 1 条低成本窗口延展样本，之后再跑 release gate。"
    if reason == "bounded-top-up" and can_run and recommended > 0:
        return "run-bounded-top-up", f"允许按 planner 推荐补样，最多 {recommended} batch。"
    if reason == "wait-coverage-window":
        return "wait-coverage-window", "样本和质量已满足或无需补样；当前只等待覆盖窗口，不应继续 seed。"
    if reason == "quality-failure":
        return "stop-quality-failure", "存在 critical/httpFail，必须先归因修复，不得补样或灰度。"
    if reason == "coverage-read-failure":
        return "stop-coverage-read-failure", "coverage 读取或失败类型不可信，必须先修证据链。"
    return reason or "unknown", f"planner reason={reason or 'unknown'} recommendedBatches={recommended}"


def build_status(args: argparse.Namespace) -> dict[str, Any]:
    tmp = Path(tempfile.mkdtemp(prefix="llmgw-rollout-status-"))
    generated_at = datetime.now(timezone.utc).isoformat()

    health: dict[str, Any] = {"ok": False, "httpStatus": 0, "json": {}, "raw": "not requested", "skipped": args.skip_health}
    release_commit = _normalize_commit(args.release_commit)
    if args.base and not args.skip_health:
        health = _request_json(args.base.rstrip("/") + "/healthz")
        health_commit = _normalize_commit((health.get("json") or {}).get("commit"))
        if not release_commit:
            release_commit = health_commit

    if args.coverage_json:
        coverage_path = Path(args.coverage_json)
        coverage = _read_json(coverage_path)
    else:
        if not args.base or not args.key:
            raise SystemExit("missing --base/--key when --coverage-json is not provided")
        coverage, coverage_path = _coverage_from_tool(args, release_commit, tmp)

    plan, plan_path = _plan_from_tool(args, coverage_path, tmp)
    cells = _coverage_cells(coverage)
    cell_summary = _cell_summary(cells)
    action, action_detail = _decision(plan)

    health_commit = _normalize_commit((health.get("json") or {}).get("commit"))
    health_ok = bool(health.get("skipped")) or (
        bool(health.get("ok")) and (not release_commit or not health_commit or health_commit == release_commit)
    )
    release_ready = bool(health_ok and cell_summary["coverageOk"] and action == "ready-for-release-gate")
    release_detail = (
        "health、shadow coverage、planner 均已满足；仍需人工确认全迁移完成后才能切 LLMGW_MODE=http。"
        if release_ready
        else "未完成全量迁移前不得切 LLMGW_MODE=http。"
    )
    items = [
        _item(
            "生产 healthz",
            100 if health_ok else 0,
            "skipped" if health.get("skipped") else ("pass" if health_ok else "fail"),
            "离线输入 coverage JSON，未请求 healthz。"
            if health.get("skipped")
            else f"http={health.get('httpStatus')} commit={health_commit or '<unknown>'} expected={release_commit or '<unset>'}",
        ),
        _item(
            "shadow 样本数",
            int(cell_summary["sampleProgress"]),
            "pass" if cell_summary["samplesOk"] else "pending",
            str(cell_summary["sampleDetail"]),
        ),
        _item(
            "shadow 质量",
            100 if cell_summary["qualityOk"] else 0,
            "pass" if cell_summary["qualityOk"] else "fail",
            str(cell_summary["qualityDetail"]),
        ),
        _item(
            "覆盖窗口",
            int(cell_summary["coverageProgress"]),
            "pass" if cell_summary["coverageOk"] else "pending",
            str(cell_summary["coverageDetail"]),
        ),
        _item(
            "planner 下一步",
            100 if action in {"ready-for-release-gate", "run-one-window-extension", "run-bounded-top-up"} else 0,
            action,
            action_detail,
        ),
        _item(
            "全量 HTTP 发布",
            100 if release_ready else 0,
            "gate-ready" if release_ready else "not-ready",
            release_detail,
        ),
    ]

    return {
        "generatedAt": generated_at,
        "base": args.base,
        "releaseCommit": release_commit,
        "coverageJson": str(coverage_path),
        "planJson": str(plan_path),
        "coverageVerdict": coverage.get("verdict"),
        "plannerReason": plan.get("reason"),
        "recommendedBatches": plan.get("recommendedBatches"),
        "canRunRecommendedBatches": plan.get("canRunRecommendedBatches"),
        "action": action,
        "actionDetail": action_detail,
        "health": {
            "ok": health_ok,
            "httpStatus": health.get("httpStatus"),
            "commit": health_commit,
        },
        "primaryCell": cells[0] if cells else {},
        "cellSummary": cell_summary,
        "items": items,
    }


def _write_markdown(path: str, report: dict[str, Any]) -> None:
    if not path:
        return
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)

    def cell(value: object) -> str:
        return str(value).replace("|", "\\|")

    lines = [
        "# LLM Gateway Rollout Status",
        "",
        f"- generatedAt: `{cell(report.get('generatedAt'))}`",
        f"- releaseCommit: `{cell(report.get('releaseCommit'))}`",
        f"- action: `{cell(report.get('action'))}`",
        f"- actionDetail: {cell(report.get('actionDetail'))}",
        "",
        "| item | progress | status | detail |",
        "|---|---:|---|---|",
    ]
    for item in report["items"]:
        lines.append(
            f"| {cell(item['name'])} | {item['progress']}% | {cell(item['status'])} | {cell(item['detail'])} |"
        )
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _print_table(report: dict[str, Any]) -> None:
    print("LLM Gateway rollout status")
    print(f"- releaseCommit={report.get('releaseCommit') or ''}")
    print(f"- action={report.get('action')}")
    print("")
    print("| item | progress | status | detail |")
    print("|---|---:|---|---|")
    for item in report["items"]:
        print(f"| {item['name']} | {item['progress']}% | {item['status']} | {item['detail']} |")


def _fake_coverage(first_compared_at: str) -> dict[str, Any]:
    return {
        "verdict": "fail",
        "releaseCommit": "abc123",
        "failures": ["覆盖时长不足 coverageHours=0.72, required=24"],
        "cells": [
            {
                "label": "report-agent.generate::chat/send",
                "appCallerCode": "report-agent.generate::chat",
                "kind": "send",
                "requiredTotal": 30,
                "total": 30,
                "critical": 0,
                "httpFail": 0,
                "coverageHours": 0.72,
                "minCoverageHours": 24,
                "firstComparedAt": first_compared_at,
                "lastComparedAt": "2026-01-01T00:43:00+00:00",
                "failures": ["覆盖时长不足 coverageHours=0.72, required=24"],
            }
        ],
    }


def _fake_ready_coverage() -> dict[str, Any]:
    coverage = _fake_coverage("2026-01-01T00:00:00+00:00")
    coverage["verdict"] = "pass"
    coverage["failures"] = []
    cell = coverage["cells"][0]
    cell["coverageHours"] = 24
    cell["failures"] = []
    return coverage


def _self_test() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="llmgw-rollout-status-self-test-"))

    def run_case(name: str, first_compared_at: str, expected_action: str, expected_batches: int) -> None:
        coverage_path = tmp / f"{name}.coverage.json"
        coverage_path.write_text(
            json.dumps(_fake_coverage(first_compared_at), ensure_ascii=False),
            encoding="utf-8",
        )
        args = argparse.Namespace(
            base="",
            key="",
            release_commit="abc123",
            coverage_json=str(coverage_path),
            require_app_kind=DEFAULT_REQUIRE_APP_KIND,
            require_kind=[],
            since_hours=48.0,
            min_coverage_hours=24.0,
            failure_sample_limit=0,
            batch_yield=1,
            max_batches=1,
            allow_window_extension=True,
            skip_global_cells=True,
            skip_health=True,
            json_out="",
            report_md="",
            print_json=False,
            self_test=False,
        )
        report = build_status(args)
        action = str(report.get("action") or "")
        batches = int(report.get("recommendedBatches") or 0)
        if action != expected_action or batches != expected_batches:
            raise AssertionError(
                f"{name}: action={action} batches={batches}, "
                f"expected action={expected_action} batches={expected_batches}"
            )

    run_case(
        "wait-window",
        "2099-01-01T00:00:00+00:00",
        "wait-coverage-window",
        0,
    )
    run_case(
        "extend-window",
        "2026-01-01T00:00:00+00:00",
        "run-one-window-extension",
        1,
    )

    multi_coverage_path = tmp / "multi-cell.coverage.json"
    multi_coverage = _fake_coverage("2026-01-01T00:00:00+00:00")
    multi_coverage["failures"] = ["样本不足 total=3, required=6"]
    multi_coverage["cells"].append({
        "label": "custom.app::chat/send",
        "appCallerCode": "custom.app::chat",
        "kind": "send",
        "requiredTotal": 6,
        "total": 3,
        "critical": 0,
        "httpFail": 0,
        "coverageHours": 0.1,
        "minCoverageHours": 24,
        "firstComparedAt": "2026-01-01T00:00:00+00:00",
        "lastComparedAt": "2026-01-01T00:06:00+00:00",
        "failures": ["样本不足 total=3, required=6", "覆盖时长不足 coverageHours=0.1, required=24"],
    })
    multi_coverage_path.write_text(
        json.dumps(multi_coverage, ensure_ascii=False),
        encoding="utf-8",
    )
    args = argparse.Namespace(
        base="",
        key="",
        release_commit="abc123",
        coverage_json=str(multi_coverage_path),
        require_app_kind=DEFAULT_REQUIRE_APP_KIND,
        require_kind=[],
        since_hours=48.0,
        min_coverage_hours=24.0,
        failure_sample_limit=0,
        batch_yield=1,
        max_batches=1,
        allow_window_extension=True,
        skip_global_cells=True,
        skip_health=True,
        json_out="",
        report_md="",
        print_json=False,
        self_test=False,
    )
    report = build_status(args)
    if int(report["cellSummary"]["sampleProgress"]) != 50:
        raise AssertionError(f"multi-cell sample progress must use worst cell: {report['cellSummary']}")
    if "1/2 cells pass" not in str(report["cellSummary"]["sampleDetail"]):
        raise AssertionError(f"multi-cell sample detail must include pass count: {report['cellSummary']}")

    health_fail_coverage_path = tmp / "health-fail-ready.coverage.json"
    health_fail_coverage_path.write_text(
        json.dumps(_fake_ready_coverage(), ensure_ascii=False),
        encoding="utf-8",
    )
    args = argparse.Namespace(
        base="http://127.0.0.1:1",
        key="",
        release_commit="abc123",
        coverage_json=str(health_fail_coverage_path),
        require_app_kind=DEFAULT_REQUIRE_APP_KIND,
        require_kind=[],
        since_hours=48.0,
        min_coverage_hours=24.0,
        failure_sample_limit=0,
        batch_yield=1,
        max_batches=1,
        allow_window_extension=True,
        skip_global_cells=True,
        skip_health=False,
        json_out="",
        report_md="",
        print_json=False,
        self_test=False,
    )
    report = build_status(args)
    release_item = next(item for item in report["items"] if item["name"] == "全量 HTTP 发布")
    if report["action"] != "ready-for-release-gate":
        raise AssertionError(f"health-fail case must keep planner ready: {report['action']}")
    if report["health"]["ok"]:
        raise AssertionError(f"health-fail case must record health failure: {report['health']}")
    if release_item["status"] != "not-ready" or release_item["progress"] != 0:
        raise AssertionError(f"health failure must block release gate-ready status: {release_item}")
    print("LLM Gateway rollout status self-test: PASS")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only LLM Gateway rollout status board")
    parser.add_argument("--base", default=os.environ.get("LLMGW_STATUS_BASE", os.environ.get("GW_BASE", "")).strip().rstrip("/"))
    parser.add_argument("--key", default=os.environ.get("LLMGW_STATUS_KEY", os.environ.get("GW_KEY", "")).strip())
    parser.add_argument("--release-commit", default=os.environ.get("LLMGW_STATUS_RELEASE_COMMIT", "").strip())
    parser.add_argument("--coverage-json", default="")
    parser.add_argument("--require-app-kind", action="append", default=[])
    parser.add_argument("--require-kind", action="append", default=[])
    parser.add_argument("--since-hours", type=float, default=float(os.environ.get("LLMGW_STATUS_SINCE_HOURS", "48")))
    parser.add_argument("--min-coverage-hours", type=float, default=float(os.environ.get("LLMGW_STATUS_MIN_COVERAGE_HOURS", "24")))
    parser.add_argument("--failure-sample-limit", type=int, default=3)
    parser.add_argument("--batch-yield", type=int, default=1)
    parser.add_argument("--max-batches", type=int, default=1)
    parser.add_argument("--allow-window-extension", action="store_true")
    parser.add_argument("--skip-global-cells", action="store_true", default=True)
    parser.add_argument("--include-global-cells", action="store_false", dest="skip_global_cells")
    parser.add_argument("--skip-health", action="store_true")
    parser.add_argument("--json-out", default="")
    parser.add_argument("--report-md", default="")
    parser.add_argument("--print-json", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        return _self_test()
    if not args.require_app_kind:
        args.require_app_kind = list(DEFAULT_REQUIRE_APP_KIND)

    report = build_status(args)
    _write_json(args.json_out, report)
    _write_markdown(args.report_md, report)
    if args.print_json:
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        _print_table(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
