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
ROLLBACK_REHEARSAL_STAGE = "rollback-rehearsal"
ROLLOUT_SEQUENCE = [
    "shadow-start",
    ROLLBACK_REHEARSAL_STAGE,
    "canary-intent-text",
    "canary-chat",
    "canary-streaming",
    "canary-vision",
    "canary-image",
    "canary-video-asr",
    "http-full",
]


def _stage_requires_rehearsal(stage: str) -> bool:
    return stage not in {"shadow-start", ROLLBACK_REHEARSAL_STAGE}


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


def _normalize_commit(value: object) -> str:
    raw = str(value or "").strip()
    if raw.lower().startswith("sha-"):
        raw = raw[4:]
    return raw.lower()


def _require_pass_json(path: str, label: str) -> dict:
    payload = _load_json_file(path, label)
    verdict = str(payload.get("verdict") or payload.get("Verdict") or "").lower()
    if verdict != "pass":
        raise SystemExit(f"ERROR: {label} verdict is not pass: {path} verdict={verdict or 'empty'}")
    return payload


def _require_stage_evidence_for_commit(path: str, label: str, commit: str) -> None:
    payload = _require_pass_json(path, label)
    expected = _normalize_commit(commit)
    actual = _normalize_commit(payload.get("commit") or payload.get("Commit"))
    if not expected:
        raise SystemExit(f"ERROR: {label} cannot validate commit because ledger commit is empty: {path}")
    if actual != expected:
        raise SystemExit(f"ERROR: {label} commit mismatch: {path} actual={actual or 'empty'} expected={expected}")


def _require_serving_probe_for_commit(path: str, label: str, commit: str) -> None:
    payload = _require_pass_json(path, label)
    expected = _normalize_commit(commit)
    if not expected:
        raise SystemExit(f"ERROR: {label} cannot validate commit because ledger commit is empty: {path}")

    expected_commit = _normalize_commit(payload.get("expectedCommit") or payload.get("ExpectedCommit"))
    if expected_commit and expected_commit != expected:
        raise SystemExit(f"ERROR: {label} expectedCommit mismatch: {path} actual={expected_commit} expected={expected}")

    samples = payload.get("healthSamples") or payload.get("HealthSamples") or []
    sample_commits = sorted({
        _normalize_commit(sample.get("commit") or sample.get("Commit"))
        for sample in samples
        if isinstance(sample, dict) and _normalize_commit(sample.get("commit") or sample.get("Commit"))
    })
    if sample_commits and sample_commits != [expected]:
        raise SystemExit(
            f"ERROR: {label} health sample commit mismatch: {path} actual={','.join(sample_commits)} expected={expected}"
        )


def _require_smoke_for_commit(path: str, label: str, commit: str) -> None:
    payload = _require_pass_json(path, label)
    expected = _normalize_commit(commit)
    if not expected:
        raise SystemExit(f"ERROR: {label} cannot validate commit because ledger commit is empty: {path}")

    expected_commit = _normalize_commit(payload.get("expectedCommit") or payload.get("ExpectedCommit"))
    if expected_commit and expected_commit != expected:
        raise SystemExit(f"ERROR: {label} expectedCommit mismatch: {path} actual={expected_commit} expected={expected}")

    health_commit = _normalize_commit(payload.get("healthCommit") or payload.get("HealthCommit"))
    if not health_commit:
        raise SystemExit(f"ERROR: {label} missing healthCommit for same-commit evidence: {path}")
    if health_commit != expected:
        raise SystemExit(f"ERROR: {label} D-layer smoke healthCommit mismatch: {path} actual={health_commit} expected={expected}")


def _require_release_gate_for_commit(path: str, label: str, commit: str) -> None:
    payload = _require_pass_json(path, label)
    expected = _normalize_commit(commit)
    if not expected:
        raise SystemExit(f"ERROR: {label} cannot validate commit because ledger commit is empty: {path}")

    shadow_commit = _normalize_commit(payload.get("shadowReleaseCommit") or payload.get("ShadowReleaseCommit"))
    if shadow_commit != expected:
        raise SystemExit(f"ERROR: {label} shadowReleaseCommit mismatch: {path} actual={shadow_commit or 'empty'} expected={expected}")

    checks = payload.get("shadowChecks") or payload.get("ShadowChecks") or []
    if not isinstance(checks, list) or not checks:
        raise SystemExit(f"ERROR: {label} missing shadowChecks for same-commit evidence: {path}")
    for index, item in enumerate(checks, start=1):
        if not isinstance(item, dict):
            raise SystemExit(f"ERROR: {label} shadowChecks[{index}] is not an object: {path}")
        item_commit = _normalize_commit(item.get("releaseCommit") or item.get("ReleaseCommit"))
        if item_commit != expected:
            item_label = item.get("label") or item.get("Label") or index
            raise SystemExit(
                f"ERROR: {label} shadowChecks[{item_label}] releaseCommit mismatch: "
                f"{path} actual={item_commit or 'empty'} expected={expected}"
            )


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


def _successful_entries(entries: list[dict], commit: str, stage: str) -> list[dict]:
    return [
        item
        for item in entries
        if str(item.get("commit") or "").lower() == commit.lower()
        and str(item.get("status") or "") == "success"
        and str(item.get("stage") or "") == stage
    ]


def _latest_success(entries: list[dict], commit: str, stage: str) -> dict | None:
    candidates = _successful_entries(entries, commit, stage)
    if not candidates:
        return None

    def key(item: dict) -> datetime:
        return _parse_recorded_at(item.get("recordedAt")) or datetime.min.replace(tzinfo=timezone.utc)

    return max(candidates, key=key)


def _required_rollout_stages(target_stage: str, require_target_success: bool) -> list[str]:
    if target_stage == "rollback-inproc":
        return []
    if target_stage not in ROLLOUT_SEQUENCE:
        raise SystemExit(f"ERROR: unknown rollout target stage: {target_stage}")
    end = ROLLOUT_SEQUENCE.index(target_stage)
    if require_target_success:
        end += 1
    return ROLLOUT_SEQUENCE[:end]


def _entry_evidence_failures(entry: dict) -> list[str]:
    stage = str(entry.get("stage") or "")
    commit = _normalize_commit(entry.get("commit"))
    failures: list[str] = []
    release_main_ref = str(entry.get("releaseMainRef") or "").strip()
    release_main_sha = str(entry.get("releaseMainSha") or "").strip().lower()
    if not release_main_ref:
        failures.append(f"ERROR: {stage} missing releaseMainRef")
    if not release_main_sha:
        failures.append(f"ERROR: {stage} missing releaseMainSha")
    elif len(release_main_sha) != 40 or any(ch not in "0123456789abcdef" for ch in release_main_sha):
        failures.append(f"ERROR: {stage} invalid releaseMainSha: {release_main_sha}")
    if _bool_flag(str(entry.get("allowOutOfOrder") or "0")) and not str(entry.get("allowOutOfOrderReason") or "").strip():
        failures.append(f"ERROR: {stage} allowOutOfOrder missing reason")
    evidence_json = str(entry.get("evidenceJson") or "")
    try:
        _require_stage_evidence_for_commit(evidence_json, f"{stage} stage evidence", commit)
    except SystemExit as exc:
        failures.append(str(exc))

    if stage == ROLLBACK_REHEARSAL_STAGE:
        return failures

    for key, label in [
        ("servingProbeJson", "serving probe evidence"),
        ("smokeJson", "D-layer smoke evidence"),
    ]:
        try:
            if key == "servingProbeJson":
                _require_serving_probe_for_commit(str(entry.get(key) or ""), f"{stage} {label}", commit)
            else:
                _require_smoke_for_commit(str(entry.get(key) or ""), f"{stage} {label}", commit)
        except SystemExit as exc:
            failures.append(str(exc))
    if _bool_flag(str(entry.get("releaseGateRequired") or "0")):
        try:
            _require_release_gate_for_commit(str(entry.get("releaseGateJson") or ""), f"{stage} release gate evidence", commit)
        except SystemExit as exc:
            failures.append(str(exc))
    return failures


def _write_audit_markdown(path: str, report: dict) -> None:
    if not path:
        return
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)

    def cell(value: object) -> str:
        return str(value).replace("|", "\\|")

    with open(path, "w", encoding="utf-8") as fh:
        fh.write("# LLM Gateway Rollout Ledger Audit\n\n")
        fh.write(f"- generatedAt: `{cell(report['generatedAt'])}`\n")
        fh.write(f"- verdict: `{cell(report['verdict'])}`\n")
        fh.write(f"- ledger: `{cell(report['ledger'])}`\n")
        fh.write(f"- commit: `{cell(report['commit'])}`\n")
        fh.write(f"- targetStage: `{cell(report['targetStage'])}`\n")
        fh.write(f"- requireTargetSuccess: `{cell(report['requireTargetSuccess'])}`\n")
        fh.write(f"- minObservationHours: `{cell(report['minObservationHours'])}`\n\n")
        fh.write("## Required Stages\n\n")
        for item in report.get("stageResults") or []:
            fh.write(
                f"- {cell(item['stage'])}: status=`{cell(item['status'])}` "
                f"recordedAt=`{cell(item.get('recordedAt') or '')}`\n"
            )
        fh.write("\n## Failures\n\n")
        failures = report.get("failures") or []
        if failures:
            for failure in failures:
                fh.write(f"- {failure}\n")
        else:
            fh.write("- none\n")


def validate(args: argparse.Namespace) -> int:
    stage = args.stage
    commit = args.commit.lower()
    if stage == "rollback-inproc":
        print("LLM Gateway rollout ledger: rollback does not require prior stages")
        return 0
    if stage not in STAGES and stage != ROLLBACK_REHEARSAL_STAGE:
        print(f"ERROR: unknown rollout stage: {stage}", file=sys.stderr)
        return 2
    if not commit:
        print("ERROR: rollout ledger validation requires --commit", file=sys.stderr)
        return 2
    if args.allow_out_of_order and not str(args.allow_out_of_order_reason or "").strip():
        print(
            "ERROR: --allow-out-of-order requires --allow-out-of-order-reason so the release record explains the override.",
            file=sys.stderr,
        )
        return 2

    entries = _load(args.ledger)
    successful = _successful_stages(entries, commit)
    if _stage_requires_rehearsal(stage) and ROLLBACK_REHEARSAL_STAGE not in successful:
        print(
            "ERROR: rollout stage requires rollback rehearsal success for the same commit. "
            f"stage={stage} commit={commit} missing_success={ROLLBACK_REHEARSAL_STAGE} ledger={args.ledger}",
            file=sys.stderr,
        )
        return 1

    if args.allow_out_of_order:
        reason = str(args.allow_out_of_order_reason or "").strip()
        print(f"WARN: rollout ledger order check skipped by --allow-out-of-order: {reason}", file=sys.stderr)
        return 0

    if stage == ROLLBACK_REHEARSAL_STAGE:
        print("LLM Gateway rollout ledger: rollback rehearsal does not require prior stages")
        return 0

    required = STAGES[: STAGES.index(stage)]
    if not required:
        print("LLM Gateway rollout ledger: no prior stage required")
        return 0

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
        _require_stage_evidence_for_commit(args.evidence_json, "stage evidence", args.commit)
        if args.stage != ROLLBACK_REHEARSAL_STAGE:
            _require_serving_probe_for_commit(args.serving_probe_json, "serving probe evidence", args.commit)
            _require_smoke_for_commit(args.smoke_json, "D-layer smoke evidence", args.commit)
            if _bool_flag(args.release_gate_required):
                _require_release_gate_for_commit(args.release_gate_json, "release gate evidence", args.commit)

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
        "rollbackRehearsal": args.stage == ROLLBACK_REHEARSAL_STAGE,
        "allowOutOfOrder": _bool_flag(args.allow_out_of_order),
        "allowOutOfOrderReason": args.allow_out_of_order_reason.strip(),
        "servingProbeJson": args.serving_probe_json,
        "smokeJson": args.smoke_json,
        "releaseMainRef": args.main_ref,
        "releaseMainSha": args.main_sha.lower(),
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
        fh.write(f"- rollbackRehearsal: `{cell(report['rollbackRehearsal'])}`\n")
        fh.write(f"- allowOutOfOrder: `{cell(report['allowOutOfOrder'])}`\n")
        fh.write(f"- allowOutOfOrderReason: `{cell(report['allowOutOfOrderReason'])}`\n")
        fh.write(f"- minStageObservationHours: `{cell(report['minStageObservationHours'])}`\n")
        fh.write(f"- releaseGateJson: `{cell(report['releaseGateJson'])}`\n")
        fh.write(f"- servingProbeJson: `{cell(report['servingProbeJson'])}`\n")
        fh.write(f"- smokeJson: `{cell(report['smokeJson'])}`\n\n")
        fh.write(f"- releaseMainRef: `{cell(report['releaseMainRef'])}`\n")
        fh.write(f"- releaseMainSha: `{cell(report['releaseMainSha'])}`\n\n")
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
    if args.stage == ROLLBACK_REHEARSAL_STAGE:
        checks = []
    for label, path, required in checks:
        if not required:
            continue
        try:
            if label == "servingProbeJson":
                _require_serving_probe_for_commit(path, label, args.commit)
            elif label == "releaseGateJson":
                _require_release_gate_for_commit(path, label, args.commit)
            else:
                _require_smoke_for_commit(path, label, args.commit)
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
        "rollbackRehearsal": args.stage == ROLLBACK_REHEARSAL_STAGE,
        "allowOutOfOrder": _bool_flag(args.allow_out_of_order),
        "allowOutOfOrderReason": args.allow_out_of_order_reason.strip(),
        "minStageObservationHours": args.min_stage_observation_hours,
        "releaseGateJson": args.release_gate_json,
        "servingProbeJson": args.serving_probe_json,
        "smokeJson": args.smoke_json,
        "releaseMainRef": args.main_ref,
        "releaseMainSha": args.main_sha.lower(),
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


def audit(args: argparse.Namespace) -> int:
    commit = args.commit.lower().strip()
    if not commit:
        print("ERROR: rollout ledger audit requires --commit", file=sys.stderr)
        return 2
    try:
        min_observation_hours = max(0.0, float(args.min_observation_hours or 0))
    except (TypeError, ValueError):
        print(f"ERROR: --min-observation-hours must be a non-negative number: {args.min_observation_hours}", file=sys.stderr)
        return 2

    entries = _load(args.ledger)
    required_stages = _required_rollout_stages(args.target_stage, bool(args.require_target_success))
    failures: list[str] = []
    stage_results: list[dict] = []
    latest_by_stage: dict[str, dict] = {}

    for stage in required_stages:
        latest = _latest_success(entries, commit, stage)
        if not latest:
            failures.append(f"missing success stage for commit: stage={stage} commit={commit}")
            stage_results.append({"stage": stage, "status": "missing", "recordedAt": ""})
            continue
        latest_by_stage[stage] = latest
        recorded_at = str(latest.get("recordedAt") or "")
        evidence_failures = _entry_evidence_failures(latest)
        failures.extend(evidence_failures)
        stage_results.append(
            {
                "stage": stage,
                "status": "success" if not evidence_failures else "evidence-fail",
                "recordedAt": recorded_at,
                "releaseGateRequired": _bool_flag(str(latest.get("releaseGateRequired") or "0")),
                "evidenceJson": latest.get("evidenceJson") or "",
                "servingProbeJson": latest.get("servingProbeJson") or "",
                "smokeJson": latest.get("smokeJson") or "",
                "releaseGateJson": latest.get("releaseGateJson") or "",
                "releaseMainRef": latest.get("releaseMainRef") or "",
                "releaseMainSha": latest.get("releaseMainSha") or "",
                "allowOutOfOrder": _bool_flag(str(latest.get("allowOutOfOrder") or "0")),
                "allowOutOfOrderReason": latest.get("allowOutOfOrderReason") or "",
            }
        )

    canary_or_http = [
        stage
        for stage in required_stages
        if stage.startswith("canary-") or stage == "http-full"
    ]
    rehearsal = latest_by_stage.get(ROLLBACK_REHEARSAL_STAGE)
    rehearsal_time = _parse_recorded_at(rehearsal.get("recordedAt")) if rehearsal else None
    for stage in canary_or_http:
        stage_entry = latest_by_stage.get(stage)
        stage_time = _parse_recorded_at(stage_entry.get("recordedAt")) if stage_entry else None
        if not rehearsal_time:
            failures.append(f"missing rollback rehearsal time before stage={stage}")
        elif stage_time and rehearsal_time > stage_time:
            failures.append(
                "rollback rehearsal must be recorded before canary/http stage. "
                f"stage={stage} rehearsalAt={rehearsal_time.isoformat()} stageAt={stage_time.isoformat()}"
            )

    ordered_real_stages = [stage for stage in STAGES if stage in required_stages]
    for previous_stage, current_stage in zip(ordered_real_stages, ordered_real_stages[1:]):
        previous = latest_by_stage.get(previous_stage)
        current = latest_by_stage.get(current_stage)
        previous_time = _parse_recorded_at(previous.get("recordedAt")) if previous else None
        current_time = _parse_recorded_at(current.get("recordedAt")) if current else None
        if not previous_time or not current_time:
            continue
        observed_hours = (current_time - previous_time).total_seconds() / 3600.0
        if observed_hours < min_observation_hours:
            failures.append(
                "rollout stage observation window not satisfied. "
                f"previous_stage={previous_stage} current_stage={current_stage} "
                f"observed_hours={observed_hours:.2f} required_hours={min_observation_hours:g}"
            )

    report = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "verdict": "fail" if failures else "pass",
        "ledger": args.ledger,
        "commit": commit,
        "targetStage": args.target_stage,
        "requireTargetSuccess": bool(args.require_target_success),
        "minObservationHours": min_observation_hours,
        "requiredStages": required_stages,
        "stageResults": stage_results,
        "failures": failures,
    }
    _write_json(args.json_out, report)
    _write_audit_markdown(args.report_md, report)
    if failures:
        for failure in failures:
            print(f"ERROR: {failure}", file=sys.stderr)
        return 1
    print(f"LLM Gateway rollout ledger audit: PASS for {args.target_stage}")
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
    validate_parser.add_argument("--allow-out-of-order-reason", default="")
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
    append_parser.add_argument("--main-ref", default="")
    append_parser.add_argument("--main-sha", default="")
    append_parser.add_argument("--allow-out-of-order", default="0")
    append_parser.add_argument("--allow-out-of-order-reason", default="")
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
    report_parser.add_argument("--main-ref", default="")
    report_parser.add_argument("--main-sha", default="")
    report_parser.add_argument("--allow-out-of-order", default="0")
    report_parser.add_argument("--allow-out-of-order-reason", default="")
    report_parser.add_argument("--min-stage-observation-hours", default="")
    report_parser.set_defaults(func=stage_report)

    audit_parser = sub.add_parser("audit", help="audit rollout ledger completion state")
    audit_parser.add_argument("--ledger", required=True)
    audit_parser.add_argument("--commit", required=True)
    audit_parser.add_argument("--target-stage", default="http-full")
    audit_parser.add_argument("--require-target-success", action="store_true")
    audit_parser.add_argument("--min-observation-hours", default="24")
    audit_parser.add_argument("--json-out", default="")
    audit_parser.add_argument("--report-md", default="")
    audit_parser.set_defaults(func=audit)

    args = parser.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
