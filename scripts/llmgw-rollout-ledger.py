#!/usr/bin/env python3
"""LLM Gateway rollout ledger.

The production stage runner uses this helper to keep an append-only rollout
ledger. The ledger is intentionally JSONL and secret-free so an operator can
attach it to a release ticket without exposing gateway keys.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone

STAGES = [
    "shadow-start",
    "canary-intent-text",
    "canary-chat",
    "canary-streaming",
    "canary-vision",
    "canary-image",
    "canary-video-asr",
    "http-full",
]


def _load(path: str) -> list[dict]:
    if not path or not os.path.exists(path):
        return []
    entries: list[dict] = []
    with open(path, "r", encoding="utf-8") as fh:
        for line_no, line in enumerate(fh, start=1):
            raw = line.strip()
            if not raw:
                continue
            try:
                value = json.loads(raw)
            except json.JSONDecodeError as exc:
                raise SystemExit(f"ERROR: invalid rollout ledger JSON at {path}:{line_no}: {exc}") from exc
            if isinstance(value, dict):
                entries.append(value)
    return entries


def _load_json_file(path: str, label: str) -> dict:
    if not path:
        raise SystemExit(f"ERROR: missing {label} path")
    if not os.path.exists(path):
        raise SystemExit(f"ERROR: missing {label}: {path}")
    with open(path, "r", encoding="utf-8") as fh:
        try:
            payload = json.load(fh)
        except json.JSONDecodeError as exc:
            raise SystemExit(f"ERROR: invalid {label} JSON: {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise SystemExit(f"ERROR: {label} is not a JSON object: {path}")
    return payload


def _require_pass_json(path: str, label: str) -> None:
    payload = _load_json_file(path, label)
    verdict = str(payload.get("verdict") or payload.get("Verdict") or "").lower()
    if verdict != "pass":
        raise SystemExit(f"ERROR: {label} verdict is not pass: {path} verdict={verdict or 'empty'}")


def _bool_flag(value: str) -> bool:
    return str(value).strip().lower() in {"1", "true", "yes", "y", "on"}


def _parse_recorded_at(value: object) -> datetime | None:
    raw = str(value or "").strip()
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


def _successful_stages(entries: list[dict], commit: str) -> set[str]:
    return {
        str(item.get("stage") or "")
        for item in entries
        if str(item.get("commit") or "").lower() == commit.lower()
        and str(item.get("status") or "") == "success"
    }


def validate(args: argparse.Namespace) -> int:
    stage = args.stage
    commit = args.commit.lower()
    if stage == "rollback-inproc":
        print("LLM Gateway rollout ledger: rollback does not require prior stages")
        return 0
    if stage not in STAGES:
        print(f"ERROR: unknown rollout stage: {stage}", file=sys.stderr)
        return 2
    if not commit:
        print("ERROR: rollout ledger validation requires --commit", file=sys.stderr)
        return 2

    if args.allow_out_of_order:
        print("WARN: rollout ledger order check skipped by --allow-out-of-order", file=sys.stderr)
        return 0

    entries = _load(args.ledger)
    required = STAGES[: STAGES.index(stage)]
    if not required:
        print("LLM Gateway rollout ledger: no prior stage required")
        return 0

    successful = _successful_stages(entries, commit)
    missing = [item for item in required if item not in successful]
    if missing:
        print(
            "ERROR: rollout stage order violation. "
            f"stage={stage} commit={commit} missing_success={','.join(missing)} ledger={args.ledger}",
            file=sys.stderr,
        )
        return 1

    try:
        min_observation_hours = max(0.0, float(args.min_observation_hours or 0))
    except (TypeError, ValueError):
        print(f"ERROR: --min-observation-hours must be a non-negative number: {args.min_observation_hours}", file=sys.stderr)
        return 2
    if min_observation_hours > 0 and required:
        previous_stage = required[-1]
        previous_successes = [
            item
            for item in entries
            if str(item.get("commit") or "").lower() == commit
            and str(item.get("status") or "") == "success"
            and str(item.get("stage") or "") == previous_stage
        ]
        previous_times = [parsed for parsed in (_parse_recorded_at(item.get("recordedAt")) for item in previous_successes) if parsed]
        if not previous_times:
            print(
                "ERROR: rollout stage observation gate cannot read previous stage success time. "
                f"stage={stage} previous_stage={previous_stage} ledger={args.ledger}",
                file=sys.stderr,
            )
            return 1
        latest_previous_success = max(previous_times)
        observed_hours = (datetime.now(timezone.utc) - latest_previous_success).total_seconds() / 3600.0
        if observed_hours < min_observation_hours:
            print(
                "ERROR: rollout stage observation window not satisfied. "
                f"stage={stage} previous_stage={previous_stage} observed_hours={observed_hours:.2f} "
                f"required_hours={min_observation_hours:g} ledger={args.ledger}",
                file=sys.stderr,
            )
            return 1

    print(f"LLM Gateway rollout ledger: prior stages satisfied for {stage}")
    return 0


def append(args: argparse.Namespace) -> int:
    if not args.ledger:
        print("ERROR: append requires --ledger", file=sys.stderr)
        return 2
    parent = os.path.dirname(args.ledger)
    if parent:
        os.makedirs(parent, exist_ok=True)
    if args.status == "success":
        _require_pass_json(args.evidence_json, "stage evidence")
        _require_pass_json(args.serving_probe_json, "serving probe evidence")
        _require_pass_json(args.smoke_json, "D-layer smoke evidence")
        if _bool_flag(args.release_gate_required):
            _require_pass_json(args.release_gate_json, "release gate evidence")

    entry = {
        "recordedAt": datetime.now(timezone.utc).isoformat(),
        "stage": args.stage,
        "status": args.status,
        "commit": args.commit.lower(),
        "mode": args.mode,
        "canaryStage": args.canary_stage,
        "allowlist": args.allowlist,
        "shadowFullSamplePercent": args.shadow_full_sample_percent,
        "gateBase": args.gate_base,
        "evidenceJson": args.evidence_json,
        "evidenceMarkdown": args.evidence_md,
        "releaseGateJson": args.release_gate_json,
        "releaseGateRequired": _bool_flag(args.release_gate_required),
        "servingProbeJson": args.serving_probe_json,
        "smokeJson": args.smoke_json,
        "minStageObservationHours": args.min_stage_observation_hours,
    }
    with open(args.ledger, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False, sort_keys=True))
        fh.write("\n")
    print(f"LLM Gateway rollout ledger: appended {args.status} for {args.stage}")
    return 0


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
        fh.write("# LLM Gateway Rollout Stage Report\n\n")
        fh.write(f"- generatedAt: `{cell(report['generatedAt'])}`\n")
        fh.write(f"- verdict: `{cell(report['verdict'])}`\n")
        fh.write(f"- stage: `{cell(report['stage'])}`\n")
        fh.write(f"- commit: `{cell(report['commit'])}`\n")
        fh.write(f"- mode: `{cell(report['mode'])}`\n")
        fh.write(f"- canaryStage: `{cell(report['canaryStage'])}`\n")
        fh.write(f"- allowlist: `{cell(report['allowlist'])}`\n")
        fh.write(f"- releaseGateRequired: `{cell(report['releaseGateRequired'])}`\n")
        fh.write(f"- minStageObservationHours: `{cell(report['minStageObservationHours'])}`\n")
        fh.write(f"- releaseGateJson: `{cell(report['releaseGateJson'])}`\n")
        fh.write(f"- servingProbeJson: `{cell(report['servingProbeJson'])}`\n")
        fh.write(f"- smokeJson: `{cell(report['smokeJson'])}`\n\n")
        fh.write("## Failures\n\n")
        failures = report.get("failures") or []
        if failures:
            for failure in failures:
                fh.write(f"- {failure}\n")
        else:
            fh.write("- none\n")


def stage_report(args: argparse.Namespace) -> int:
    failures: list[str] = []
    checks = [
        ("servingProbeJson", args.serving_probe_json, True),
        ("smokeJson", args.smoke_json, True),
        ("releaseGateJson", args.release_gate_json, _bool_flag(args.release_gate_required)),
    ]
    for label, path, required in checks:
        if not required:
            continue
        try:
            _require_pass_json(path, label)
        except SystemExit as exc:
            failures.append(str(exc))

    report = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "verdict": "fail" if failures else "pass",
        "stage": args.stage,
        "status": args.status,
        "commit": args.commit.lower(),
        "mode": args.mode,
        "canaryStage": args.canary_stage,
        "allowlist": args.allowlist,
        "shadowFullSamplePercent": args.shadow_full_sample_percent,
        "gateBase": args.gate_base,
        "releaseGateRequired": _bool_flag(args.release_gate_required),
        "minStageObservationHours": args.min_stage_observation_hours,
        "releaseGateJson": args.release_gate_json,
        "servingProbeJson": args.serving_probe_json,
        "smokeJson": args.smoke_json,
        "failures": failures,
    }
    _write_json(args.json_out, report)
    _write_markdown(args.report_md, report)
    if failures:
        for failure in failures:
            print(failure, file=sys.stderr)
        return 1
    print(f"LLM Gateway rollout stage report: PASS for {args.stage}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="LLM Gateway rollout ledger")
    sub = parser.add_subparsers(dest="cmd", required=True)

    validate_parser = sub.add_parser("validate", help="validate stage order")
    validate_parser.add_argument("--ledger", required=True)
    validate_parser.add_argument("--stage", required=True)
    validate_parser.add_argument("--commit", default="")
    validate_parser.add_argument("--min-observation-hours", default="0")
    validate_parser.add_argument("--allow-out-of-order", action="store_true")
    validate_parser.set_defaults(func=validate)

    append_parser = sub.add_parser("append", help="append a rollout ledger entry")
    append_parser.add_argument("--ledger", required=True)
    append_parser.add_argument("--stage", required=True)
    append_parser.add_argument("--status", required=True, choices=["success", "failed", "rollback"])
    append_parser.add_argument("--commit", default="")
    append_parser.add_argument("--mode", default="")
    append_parser.add_argument("--canary-stage", default="")
    append_parser.add_argument("--allowlist", default="")
    append_parser.add_argument("--shadow-full-sample-percent", default="")
    append_parser.add_argument("--gate-base", default="")
    append_parser.add_argument("--evidence-json", default="")
    append_parser.add_argument("--evidence-md", default="")
    append_parser.add_argument("--release-gate-json", default="")
    append_parser.add_argument("--release-gate-required", default="0")
    append_parser.add_argument("--serving-probe-json", default="")
    append_parser.add_argument("--smoke-json", default="")
    append_parser.add_argument("--min-stage-observation-hours", default="")
    append_parser.set_defaults(func=append)

    report_parser = sub.add_parser("stage-report", help="write and validate stage evidence")
    report_parser.add_argument("--json-out", required=True)
    report_parser.add_argument("--report-md", default="")
    report_parser.add_argument("--stage", required=True)
    report_parser.add_argument("--status", required=True)
    report_parser.add_argument("--commit", default="")
    report_parser.add_argument("--mode", default="")
    report_parser.add_argument("--canary-stage", default="")
    report_parser.add_argument("--allowlist", default="")
    report_parser.add_argument("--shadow-full-sample-percent", default="")
    report_parser.add_argument("--gate-base", default="")
    report_parser.add_argument("--release-gate-json", default="")
    report_parser.add_argument("--release-gate-required", default="0")
    report_parser.add_argument("--serving-probe-json", default="")
    report_parser.add_argument("--smoke-json", default="")
    report_parser.add_argument("--min-stage-observation-hours", default="")
    report_parser.set_defaults(func=stage_report)

    args = parser.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
