#!/usr/bin/env python3
"""Plan bounded LLM Gateway shadow sample top-up batches from a coverage JSON.

This script is read-only. It never calls MAP, llmgw, or model providers. It only
loads a JSON report produced by scripts/llmgw-shadow-coverage-report.py and
computes how many low-cost seed batches are still missing.
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path


def _load_json(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise SystemExit(f"coverage JSON root must be an object: {path}")
    return data


def _positive_int(value: str, name: str) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"{name} must be an integer") from exc
    if parsed < 0:
        raise argparse.ArgumentTypeError(f"{name} must be >= 0")
    return parsed


def _cell_gap(cell: dict, batch_yield: int) -> dict:
    label = str(cell.get("label") or "")
    total = int(cell.get("total") or 0)
    required = int(cell.get("requiredTotal") or 0)
    critical = int(cell.get("critical") or 0)
    http_fail = int(cell.get("httpFail") or 0)
    coverage_hours = float(cell.get("coverageHours") or 0)
    min_coverage_hours = float(cell.get("minCoverageHours") or 0)
    missing = max(0, required - total)
    batches_needed = 0 if missing == 0 else (missing + max(1, batch_yield) - 1) // max(1, batch_yield)
    return {
        "label": label,
        "total": total,
        "requiredTotal": required,
        "missingSamples": missing,
        "batchesNeeded": batches_needed,
        "coverageHours": coverage_hours,
        "minCoverageHours": min_coverage_hours,
        "coverageReady": coverage_hours >= min_coverage_hours,
        "critical": critical,
        "httpFail": http_fail,
        "qualityReady": critical == 0 and http_fail == 0,
    }


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
        fh.write("# LLM Gateway Shadow Sample Plan\n\n")
        for key in (
            "generatedAt",
            "coverageJson",
            "coverageVerdict",
            "releaseCommit",
            "batchYield",
            "maxBatches",
            "remainingBatchesNeeded",
            "recommendedBatches",
            "canRunRecommendedBatches",
            "reason",
        ):
            fh.write(f"- {key}: `{cell(report.get(key))}`\n")
        fh.write("\n| cell | total | required | missing | batchesNeeded | coverageHours | minCoverageHours | critical | httpFail |\n")
        fh.write("|---|---:|---:|---:|---:|---:|---:|---:|---:|\n")
        for item in report["cells"]:
            fh.write(
                f"| {cell(item['label'])} | {item['total']} | {item['requiredTotal']} | "
                f"{item['missingSamples']} | {item['batchesNeeded']} | "
                f"{round(float(item['coverageHours']), 2)} | {round(float(item['minCoverageHours']), 2)} | "
                f"{item['critical']} | {item['httpFail']} |\n"
            )


def build_report(args: argparse.Namespace) -> dict:
    coverage = _load_json(args.coverage_json)
    cells = coverage.get("cells") or []
    if not isinstance(cells, list):
        raise SystemExit("coverage JSON field 'cells' must be a list")

    cell_reports = [_cell_gap(cell, args.batch_yield) for cell in cells if isinstance(cell, dict)]
    remaining_batches_needed = max((item["batchesNeeded"] for item in cell_reports), default=0)
    has_quality_failure = any(not item["qualityReady"] for item in cell_reports)
    coverage_ready = all(item["coverageReady"] for item in cell_reports) if cell_reports else False
    samples_ready = remaining_batches_needed == 0
    recommended_batches = min(args.max_batches, remaining_batches_needed)

    if has_quality_failure:
        reason = "quality-failure"
        can_run = False
    elif samples_ready and coverage_ready:
        reason = "already-ready"
        can_run = False
        recommended_batches = 0
    elif remaining_batches_needed <= 0:
        reason = "wait-coverage-window"
        can_run = False
        recommended_batches = 0
    elif args.max_batches <= 0:
        reason = "max-batches-zero"
        can_run = False
    else:
        reason = "bounded-top-up"
        can_run = recommended_batches > 0

    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "coverageJson": args.coverage_json,
        "coverageVerdict": coverage.get("verdict"),
        "releaseCommit": coverage.get("releaseCommit") or "",
        "batchYield": args.batch_yield,
        "maxBatches": args.max_batches,
        "remainingBatchesNeeded": remaining_batches_needed,
        "recommendedBatches": recommended_batches,
        "canRunRecommendedBatches": can_run,
        "reason": reason,
        "cells": cell_reports,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Plan bounded shadow sample top-up batches from coverage JSON")
    parser.add_argument("--coverage-json", required=True, help="Path to llmgw-shadow-coverage-report.py JSON output")
    parser.add_argument("--batch-yield", type=lambda v: _positive_int(v, "batch-yield"), default=1,
                        help="Expected sample increment per batch for the target cell, default 1")
    parser.add_argument("--max-batches", type=lambda v: _positive_int(v, "max-batches"),
                        default=int(os.environ.get("LLMGW_SHADOW_SAMPLE_PLAN_MAX_BATCHES", "3")),
                        help="Maximum batches to recommend in this run, default 3")
    parser.add_argument("--json-out", default="")
    parser.add_argument("--report-md", default="")
    parser.add_argument("--print-json", action="store_true")
    args = parser.parse_args()

    report = build_report(args)
    _write_json(args.json_out, report)
    _write_markdown(args.report_md, report)
    if args.print_json:
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))

    print("LLM Gateway shadow sample plan")
    print(f"- remainingBatchesNeeded={report['remainingBatchesNeeded']}")
    print(f"- recommendedBatches={report['recommendedBatches']}")
    print(f"- canRunRecommendedBatches={str(report['canRunRecommendedBatches']).lower()}")
    print(f"- reason={report['reason']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
