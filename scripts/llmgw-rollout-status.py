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


def _first_cell(coverage: dict[str, Any]) -> dict[str, Any]:
    cells = coverage.get("cells") or []
    return cells[0] if cells and isinstance(cells[0], dict) else {}


def _item(name: str, progress: int, status: str, detail: str) -> dict[str, Any]:
    return {"name": name, "progress": progress, "status": status, "detail": detail}


def _decision(plan: dict[str, Any], cell: dict[str, Any]) -> tuple[str, str]:
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
    cell = _first_cell(coverage)
    total = int(cell.get("total") or 0)
    required = int(cell.get("requiredTotal") or 0)
    critical = int(cell.get("critical") or 0)
    http_fail = int(cell.get("httpFail") or 0)
    coverage_hours = float(cell.get("coverageHours") or 0)
    min_coverage_hours = float(cell.get("minCoverageHours") or 0)
    action, action_detail = _decision(plan, cell)

    health_commit = _normalize_commit((health.get("json") or {}).get("commit"))
    health_ok = bool(health.get("skipped")) or (
        bool(health.get("ok")) and (not release_commit or not health_commit or health_commit == release_commit)
    )
    samples_ok = required > 0 and total >= required
    quality_ok = critical == 0 and http_fail == 0
    coverage_ok = min_coverage_hours > 0 and coverage_hours >= min_coverage_hours

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
            _pct(total, required),
            "pass" if samples_ok else "pending",
            f"{cell.get('label') or '<no-cell>'} total={total}/{required}",
        ),
        _item(
            "shadow 质量",
            100 if quality_ok else 0,
            "pass" if quality_ok else "fail",
            f"critical={critical} httpFail={http_fail}",
        ),
        _item(
            "覆盖窗口",
            _pct(coverage_hours, min_coverage_hours),
            "pass" if coverage_ok else "pending",
            f"coverageHours={coverage_hours:.3f}/{min_coverage_hours:g}",
        ),
        _item(
            "planner 下一步",
            100 if action in {"ready-for-release-gate", "run-one-window-extension", "run-bounded-top-up"} else 0,
            action,
            action_detail,
        ),
        _item(
            "全量 HTTP 发布",
            100 if action == "ready-for-release-gate" and coverage_ok else 0,
            "not-ready" if action != "ready-for-release-gate" else "gate-ready",
            "未完成全量迁移前不得切 LLMGW_MODE=http。",
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
        "primaryCell": cell,
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


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only LLM Gateway rollout status board")
    parser.add_argument("--base", default=os.environ.get("LLMGW_STATUS_BASE", os.environ.get("GW_BASE", "")).strip().rstrip("/"))
    parser.add_argument("--key", default=os.environ.get("LLMGW_STATUS_KEY", os.environ.get("GW_KEY", "")).strip())
    parser.add_argument("--release-commit", default=os.environ.get("LLMGW_STATUS_RELEASE_COMMIT", "").strip())
    parser.add_argument("--coverage-json", default="")
    parser.add_argument("--require-app-kind", action="append", default=["report-agent.generate::chat:send:30"])
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
    args = parser.parse_args()

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
