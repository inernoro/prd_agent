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
    "config-authority",
    "canary-intent-text",
    "canary-chat",
    "canary-streaming",
    "canary-vision",
    "canary-image",
    "canary-asr",
    "canary-video-asr",
    "http-full",
]
ROLLBACK_REHEARSAL_STAGE = "rollback-rehearsal"
CONFIG_AUTHORITY_STAGE = "config-authority"
HTTP_FULL_MAP_FALLBACK_EXIT_ERROR = (
    "http-full success requires --disable-map-config-fallback-for-active-app-callers=true. "
    "Full HTTP acceptance must fail closed for active appCallers and cannot keep MAP config fallback enabled."
)
ROLLOUT_SEQUENCE = [
    "shadow-start",
    ROLLBACK_REHEARSAL_STAGE,
    CONFIG_AUTHORITY_STAGE,
    "canary-intent-text",
    "canary-chat",
    "canary-streaming",
    "canary-vision",
    "canary-image",
    "canary-asr",
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


def _require_stage_evidence_matches_entry(path: str, label: str, entry: dict) -> None:
    payload = _require_pass_json(path, label)
    expected = _normalize_commit(entry.get("commit"))
    actual = _normalize_commit(payload.get("commit") or payload.get("Commit"))
    if not expected:
        raise SystemExit(f"ERROR: {label} cannot validate commit because ledger commit is empty: {path}")
    if actual != expected:
        raise SystemExit(f"ERROR: {label} commit mismatch: {path} actual={actual or 'empty'} expected={expected}")

    expected_main_ref = str(entry.get("releaseMainRef") or "").strip().lower()
    actual_main_ref = str(payload.get("releaseMainRef") or payload.get("ReleaseMainRef") or "").strip().lower()
    if expected_main_ref != actual_main_ref:
        raise SystemExit(
            f"ERROR: {label} releaseMainRef mismatch: {path} actual={actual_main_ref or 'empty'} expected={expected_main_ref or 'empty'}"
        )

    expected_main_sha = str(entry.get("releaseMainSha") or "").strip().lower()
    actual_main_sha = str(payload.get("releaseMainSha") or payload.get("ReleaseMainSha") or "").strip().lower()
    if expected_main_sha != actual_main_sha:
        raise SystemExit(
            f"ERROR: {label} releaseMainSha mismatch: {path} actual={actual_main_sha or 'empty'} expected={expected_main_sha or 'empty'}"
        )

    expected_maintenance_commit = _normalize_commit(entry.get("maintenanceBaselineCommit"))
    actual_maintenance_commit = _normalize_commit(
        payload.get("maintenanceBaselineCommit") or payload.get("MaintenanceBaselineCommit")
    )
    if expected_maintenance_commit != actual_maintenance_commit:
        raise SystemExit(
            f"ERROR: {label} maintenanceBaselineCommit mismatch: {path} "
            f"actual={actual_maintenance_commit or 'empty'} expected={expected_maintenance_commit or 'empty'}"
        )
    expected_maintenance_json = str(entry.get("maintenanceBaselineJson") or "").strip()
    actual_maintenance_json = str(
        payload.get("maintenanceBaselineJson") or payload.get("MaintenanceBaselineJson") or ""
    ).strip()
    if expected_maintenance_json != actual_maintenance_json:
        raise SystemExit(
            f"ERROR: {label} maintenanceBaselineJson mismatch: {path} "
            f"actual={actual_maintenance_json or 'empty'} expected={expected_maintenance_json or 'empty'}"
        )


def _require_serving_probe_for_commit(path: str, label: str, commit: str) -> None:
    payload = _require_pass_json(path, label)
    expected = _normalize_commit(commit)
    if not expected:
        raise SystemExit(f"ERROR: {label} cannot validate commit because ledger commit is empty: {path}")

    expected_commit = _normalize_commit(payload.get("expectedCommit") or payload.get("ExpectedCommit"))
    if not expected_commit:
        raise SystemExit(f"ERROR: {label} missing expectedCommit for same-commit evidence: {path}")
    if expected_commit != expected:
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
    _require_serving_probe_route_self_test(payload, label, path)


def _require_serving_probe_route_self_test(payload: dict, label: str, path: str) -> None:
    route = payload.get("routeSelfTest") or payload.get("RouteSelfTest") or {}
    if not isinstance(route, dict):
        raise SystemExit(f"ERROR: {label} routeSelfTest is not an object: {path}")
    if route.get("ok") is not True and route.get("Ok") is not True:
        raise SystemExit(f"ERROR: {label} routeSelfTest is not ok: {path}")

    required_protocols = {"gw-native", "openai-compatible", "claude-compatible", "gemini-compatible"}
    protocols = {
        str(item).strip()
        for item in (route.get("protocols") or route.get("Protocols") or [])
        if str(item).strip()
    }
    missing_protocols = sorted(required_protocols.difference(protocols))
    status = str(route.get("selfTestStatus") or route.get("SelfTestStatus") or "").strip().lower()
    mode = str(route.get("mode") or route.get("Mode") or "").strip().lower()
    upstream_called = route.get("upstreamCalled") if "upstreamCalled" in route else route.get("UpstreamCalled")
    total = route.get("total") if "total" in route else route.get("Total")
    passed = route.get("passed") if "passed" in route else route.get("Passed")
    if status != "ok" or mode != "dry-run" or upstream_called is not False or not isinstance(total, int) or not isinstance(passed, int) or total != passed or missing_protocols:
        raise SystemExit(
            f"ERROR: {label} routeSelfTest invalid: {path} "
            f"status={status or 'empty'} mode={mode or 'empty'} upstreamCalled={upstream_called} "
            f"total={total} passed={passed} missingProtocols={','.join(missing_protocols) or 'none'}"
        )


def _require_smoke_for_commit(path: str, label: str, commit: str) -> None:
    payload = _require_pass_json(path, label)
    expected = _normalize_commit(commit)
    if not expected:
        raise SystemExit(f"ERROR: {label} cannot validate commit because ledger commit is empty: {path}")

    expected_commit = _normalize_commit(payload.get("expectedCommit") or payload.get("ExpectedCommit"))
    if not expected_commit:
        raise SystemExit(f"ERROR: {label} missing expectedCommit for same-commit evidence: {path}")
    if expected_commit != expected:
        raise SystemExit(f"ERROR: {label} expectedCommit mismatch: {path} actual={expected_commit} expected={expected}")

    health_commit = _normalize_commit(payload.get("healthCommit") or payload.get("HealthCommit"))
    if not health_commit:
        raise SystemExit(f"ERROR: {label} missing healthCommit for same-commit evidence: {path}")
    if health_commit != expected:
        raise SystemExit(f"ERROR: {label} D-layer smoke healthCommit mismatch: {path} actual={health_commit} expected={expected}")
    _require_smoke_provider_canary_rows(payload, label, path)


def _require_protocol_canary_for_commit(path: str, label: str, commit: str) -> None:
    payload = _require_pass_json(path, label)
    expected = _normalize_commit(commit)
    if not expected:
        raise SystemExit(f"ERROR: {label} cannot validate commit because ledger commit is empty: {path}")

    mode = str(payload.get("mode") or payload.get("Mode") or "").strip().lower()
    if mode != "execute":
        raise SystemExit(f"ERROR: {label} mode is not execute: {path} mode={mode or 'empty'}")

    health = payload.get("health") or payload.get("Health") or {}
    if not isinstance(health, dict):
        raise SystemExit(f"ERROR: {label} missing health object: {path}")
    health_commit = _normalize_commit(health.get("commit") or health.get("Commit"))
    if health_commit and health_commit != expected:
        raise SystemExit(f"ERROR: {label} health commit mismatch: {path} actual={health_commit} expected={expected}")

    cases = payload.get("cases") or payload.get("Cases") or []
    if not isinstance(cases, list):
        raise SystemExit(f"ERROR: {label} cases are not a list: {path}")
    required_protocols = {"gw-native", "openai-compatible", "claude-compatible", "gemini-compatible"}
    passed_protocols = {
        str(case.get("protocol") or case.get("Protocol") or "").strip()
        for case in cases
        if isinstance(case, dict) and (case.get("ok") is True or case.get("Ok") is True)
    }
    missing = sorted(required_protocols.difference(passed_protocols))
    if missing:
        raise SystemExit(f"ERROR: {label} missing protocol canary samples: {path} missing={','.join(missing)}")


def _require_smoke_provider_canary_rows(payload: dict, label: str, path: str) -> None:
    rows = payload.get("rows") or payload.get("Rows") or []
    if not isinstance(rows, list):
        raise SystemExit(f"ERROR: {label} rows are not a list: {path}")

    required_prefixes = [
        "invoke[chat]",
        "send-compat[chat]",
        "stream[chat]",
        "client-stream[chat]",
        "canary(",
    ]
    missing: list[str] = []
    failed: list[str] = []
    for prefix in required_prefixes:
        matches = [
            row for row in rows
            if isinstance(row, dict) and str(row.get("case") or row.get("Case") or "").startswith(prefix)
        ]
        if not matches:
            missing.append(prefix)
            continue
        if not any(str(row.get("status") or row.get("Status") or "").lower() == "pass" for row in matches):
            failed.append(prefix)
    if missing or failed:
        raise SystemExit(
            f"ERROR: {label} missing real provider canary rows: {path} "
            f"missing={','.join(missing) or 'none'} failed={','.join(failed) or 'none'}"
        )


def _require_smoke_route_matrix(path: str, label: str) -> None:
    payload = _require_pass_json(path, label)
    rows = payload.get("rows") or payload.get("Rows") or []
    if not isinstance(rows, list):
        raise SystemExit(f"ERROR: {label} route matrix rows are not a list: {path}")

    missing: list[str] = []
    failed: list[str] = []
    skipped: list[str] = []
    for prefix in ["route-auto", "route-pool", "route-pinned"]:
        matches = [
            row for row in rows
            if isinstance(row, dict) and str(row.get("case") or row.get("Case") or "").startswith(prefix)
        ]
        if not matches:
            missing.append(prefix)
            continue
        if not any(str(row.get("status") or row.get("Status") or "").lower() == "pass" for row in matches):
            failed.append(prefix)
        if any("skipped:" in str(row.get("detail") or row.get("Detail") or "").lower() for row in matches):
            skipped.append(prefix)
    if missing or failed or skipped:
        raise SystemExit(
            f"ERROR: {label} route matrix incomplete: {path} "
            f"missing={','.join(missing) or 'none'} failed={','.join(failed) or 'none'} skipped={','.join(skipped) or 'none'}"
        )


def _require_release_gate_for_commit(
    path: str,
    label: str,
    commit: str,
    require_config_authority: bool = False,
    allow_skipped_runtime_gates: bool = False,
    allow_skipped_config_authority: bool = False,
) -> None:
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

    if require_config_authority:
        config = payload.get("configAuthority") or payload.get("ConfigAuthority") or {}
        if not isinstance(config, dict):
            raise SystemExit(f"ERROR: {label} missing configAuthority object for http-full gate: {path}")
        required = bool(config.get("required") if "required" in config else config.get("Required"))
        ok = bool(config.get("ok") if "ok" in config else config.get("Ok"))
        status = str(config.get("status") or config.get("Status") or "").lower()
        map_remaining = config.get("mapFallbackObjectsRemaining")
        if map_remaining is None:
            map_remaining = config.get("MapFallbackObjectsRemaining")
        active_ready = config.get("activeAppCallerMapFallbackReady")
        if active_ready is None:
            active_ready = config.get("ActiveAppCallerMapFallbackReady")
        active_without_usable = config.get("activeBoundPoolWithoutUsableMember")
        if active_without_usable is None:
            active_without_usable = config.get("ActiveBoundPoolWithoutUsableMember")
        active_missing_pool = config.get("activeMissingGatewayPool")
        if active_missing_pool is None:
            active_missing_pool = config.get("ActiveMissingGatewayPool")
        readiness_percent = config.get("readinessPercent")
        if readiness_percent is None:
            readiness_percent = config.get("ReadinessPercent")
        config_failures = config.get("failures")
        if config_failures is None:
            config_failures = config.get("Failures")
        if not isinstance(config_failures, list):
            config_failures = []
        audited_maintenance_config_skip = (
            allow_skipped_config_authority
            and not required
            and not ok
            and status == "not-required"
            and map_remaining is None
            and active_ready is None
            and active_without_usable is None
            and active_missing_pool is None
            and readiness_percent is None
            and not config_failures
        )
        if not audited_maintenance_config_skip and (not required or not ok):
            raise SystemExit(
                f"ERROR: {label} configAuthority is not required+ok for http-full gate: "
                f"{path} required={required} ok={ok}"
            )
        if not audited_maintenance_config_skip and status != "ready":
            raise SystemExit(f"ERROR: {label} configAuthority status is not ready: {path} status={status or 'empty'}")
        if not audited_maintenance_config_skip and int(map_remaining or 0) != 0:
            raise SystemExit(
                f"ERROR: {label} configAuthority mapFallbackObjectsRemaining is not zero: "
                f"{path} value={map_remaining}"
            )
        if not audited_maintenance_config_skip and active_ready is not True:
            raise SystemExit(f"ERROR: {label} activeAppCallerMapFallbackReady is not true: {path}")
        if not audited_maintenance_config_skip and int(active_without_usable or 0) != 0:
            raise SystemExit(
                f"ERROR: {label} activeBoundPoolWithoutUsableMember is not zero: "
                f"{path} value={active_without_usable}"
            )

        runtime = payload.get("runtimeGates") or payload.get("RuntimeGates") or {}
        if not isinstance(runtime, dict):
            raise SystemExit(f"ERROR: {label} missing runtimeGates object for http-full gate: {path}")
        runtime_required = bool(runtime.get("required") if "required" in runtime else runtime.get("Required"))
        runtime_ok = bool(runtime.get("ok") if "ok" in runtime else runtime.get("Ok"))
        runtime_ready = bool(runtime.get("readyForHttpFull") if "readyForHttpFull" in runtime else runtime.get("ReadyForHttpFull"))
        remaining = runtime.get("remainingRuntimeGates")
        if remaining is None:
            remaining = runtime.get("RemainingRuntimeGates")
        if not isinstance(remaining, list):
            remaining = []
        allowed_pending = runtime.get("allowedPendingRuntimeGates")
        if allowed_pending is None:
            allowed_pending = runtime.get("AllowedPendingRuntimeGates")
        if not isinstance(allowed_pending, list):
            allowed_pending = []
        self_finalizing = bool(
            runtime.get("selfFinalizingHttpFullLedger")
            if "selfFinalizingHttpFullLedger" in runtime
            else runtime.get("SelfFinalizingHttpFullLedger")
        )
        pending_http_full_ledger_only = (
            self_finalizing
            and remaining == ["full_http_rollout_ledger"]
            and allowed_pending == ["full_http_rollout_ledger"]
        )
        audited_maintenance_skip = (
            allow_skipped_runtime_gates
            and not runtime_required
            and not runtime_ok
            and not runtime_ready
            and not remaining
            and not allowed_pending
            and not self_finalizing
        )
        if not audited_maintenance_skip and (
            not runtime_required or not runtime_ok or (not runtime_ready and not pending_http_full_ledger_only)
        ):
            raise SystemExit(
                f"ERROR: {label} runtimeGates is not required+ok+ready for http-full gate: "
                f"{path} required={runtime_required} ok={runtime_ok} readyForHttpFull={runtime_ready} "
                f"remaining={','.join(str(x) for x in remaining) or 'none'} "
                f"allowedPending={','.join(str(x) for x in allowed_pending) or 'none'}"
            )


def _validated_maintenance_baseline_commit(args: argparse.Namespace) -> str:
    commit = _normalize_commit(args.maintenance_baseline_commit)
    if not commit:
        if args.maintenance_baseline_json:
            raise SystemExit("ERROR: maintenance baseline JSON requires a maintenance baseline commit")
        return ""
    if len(commit) != 40 or any(char not in "0123456789abcdef" for char in commit):
        raise SystemExit("ERROR: maintenance baseline commit must be a complete 40-character commit")
    if args.stage != "http-full":
        raise SystemExit("ERROR: maintenance baseline commit is only valid for stage http-full")
    if commit == _normalize_commit(args.commit):
        raise SystemExit("ERROR: maintenance baseline commit must differ from the new release commit")
    payload = _require_pass_json(args.maintenance_baseline_json, "maintenance baseline audit")
    audited_commit = _normalize_commit(payload.get("commit") or payload.get("Commit"))
    if audited_commit != commit:
        raise SystemExit(
            "ERROR: maintenance baseline audit commit mismatch: "
            f"actual={audited_commit or 'empty'} expected={commit}"
        )
    audited_shadow_commit = _normalize_commit(
        payload.get("shadowEvidenceCommit") or payload.get("ShadowEvidenceCommit") or audited_commit
    )
    expected_shadow_commit = _normalize_commit(args.shadow_evidence_commit)
    if not expected_shadow_commit or audited_shadow_commit != expected_shadow_commit:
        raise SystemExit(
            "ERROR: maintenance baseline audit shadowEvidenceCommit mismatch: "
            f"actual={audited_shadow_commit or 'empty'} expected={expected_shadow_commit or 'empty'}"
        )
    return commit


def _require_prod_preflight_for_commit(path: str, label: str, commit: str, stage: str = "") -> None:
    payload = _require_pass_json(path, label)
    expected = _normalize_commit(commit)
    if not expected:
        raise SystemExit(f"ERROR: {label} cannot validate commit because ledger commit is empty: {path}")

    expected_commit = _normalize_commit(payload.get("expectCommit") or payload.get("expectedCommit"))
    if expected_commit != expected:
        raise SystemExit(
            f"ERROR: {label} expectedCommit mismatch: {path} actual={expected_commit or 'empty'} expected={expected}"
        )

    mode = str(payload.get("mode") or "").strip().lower()
    if mode != "start":
        raise SystemExit(f"ERROR: {label} mode mismatch: {path} actual={mode or 'empty'} expected=start")

    if str(stage or "").strip() != "shadow-start":
        _require_prod_preflight_route_self_test(payload, label, path)


def _require_prod_health_preflight_for_commit(path: str, label: str, commit: str) -> None:
    payload = _require_pass_json(path, label)
    expected = _normalize_commit(commit)
    if not expected:
        raise SystemExit(f"ERROR: {label} cannot validate commit because ledger commit is empty: {path}")

    health = payload.get("health") or payload.get("Health") or {}
    if not isinstance(health, dict):
        health = {}
    actual = _normalize_commit(payload.get("actualCommit") or payload.get("ActualCommit") or health.get("commit") or health.get("Commit"))
    expected_from_payload = _normalize_commit(payload.get("expectedCommit") or payload.get("ExpectedCommit"))
    if expected_from_payload and expected_from_payload != expected:
        raise SystemExit(
            f"ERROR: {label} expectedCommit mismatch: {path} actual={expected_from_payload} expected={expected}"
        )
    if actual != expected:
        raise SystemExit(f"ERROR: {label} actualCommit mismatch: {path} actual={actual or 'empty'} expected={expected}")

    auth_checks = payload.get("authBoundaryChecks") or payload.get("AuthBoundaryChecks") or []
    if auth_checks and not isinstance(auth_checks, list):
        raise SystemExit(f"ERROR: {label} authBoundaryChecks are not a list: {path}")
    failed = [
        str(item.get("path") or item.get("Path") or "unknown")
        for item in auth_checks
        if isinstance(item, dict) and item.get("ok") is not True and item.get("Ok") is not True
    ]
    if failed:
        raise SystemExit(f"ERROR: {label} auth boundary failed: {path} failed={','.join(failed)}")


def _require_prod_preflight_route_self_test(payload: dict, label: str, path: str) -> None:
    checks = payload.get("checks") or payload.get("Checks") or []
    if not isinstance(checks, list):
        raise SystemExit(f"ERROR: {label} checks is not a list: {path}")

    matches = [
        item for item in checks
        if isinstance(item, dict)
        and str(item.get("name") or item.get("Name") or "").strip() == "gateway_route_self_test"
    ]
    if not matches:
        raise SystemExit(f"ERROR: {label} missing gateway_route_self_test check: {path}")

    check = matches[-1]
    if check.get("ok") is not True and check.get("Ok") is not True:
        raise SystemExit(f"ERROR: {label} gateway_route_self_test is not ok: {path}")

    detail_raw = str(check.get("detail") or check.get("Detail") or "{}")
    try:
        detail = json.loads(detail_raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"ERROR: {label} gateway_route_self_test detail is not JSON: {path}: {exc}") from exc
    if not isinstance(detail, dict):
        raise SystemExit(f"ERROR: {label} gateway_route_self_test detail is not an object: {path}")

    required_protocols = {"gw-native", "openai-compatible", "claude-compatible", "gemini-compatible"}
    protocols = {
        str(item).strip()
        for item in (detail.get("protocols") or detail.get("Protocols") or [])
        if str(item).strip()
    }
    missing_protocols = sorted(required_protocols.difference(protocols))
    status = str(detail.get("selfTestStatus") or detail.get("SelfTestStatus") or "").strip().lower()
    mode = str(detail.get("mode") or detail.get("Mode") or "").strip().lower()
    upstream_called = detail.get("upstreamCalled") if "upstreamCalled" in detail else detail.get("UpstreamCalled")
    total = detail.get("total") if "total" in detail else detail.get("Total")
    passed = detail.get("passed") if "passed" in detail else detail.get("Passed")

    if status != "ok" or mode != "dry-run" or upstream_called is not False or not isinstance(total, int) or not isinstance(passed, int) or total != passed or missing_protocols:
        raise SystemExit(
            f"ERROR: {label} gateway_route_self_test invalid: {path} "
            f"status={status or 'empty'} mode={mode or 'empty'} upstreamCalled={upstream_called} "
            f"total={total} passed={passed} missingProtocols={','.join(missing_protocols) or 'none'}"
        )


def _require_upstream_readiness(path: str, label: str) -> None:
    _require_pass_json(path, label)


def _require_provider_audit(path: str, label: str) -> None:
    payload = _require_pass_json(path, label)
    blockers = payload.get("externalBlockers") or payload.get("ExternalBlockers") or []
    if blockers:
        codes = sorted({
            str(item.get("code") or item.get("Code") or "unknown")
            for item in blockers
            if isinstance(item, dict)
        })
        raise SystemExit(
            f"ERROR: {label} contains external blockers: {','.join(codes) or 'unknown'}"
        )


def _provider_external_blockers(path: str) -> list[dict]:
    return _external_blockers_from_json(path, "provider config audit evidence")


def _external_blockers_from_json(path: str, label: str) -> list[dict]:
    if not path or not os.path.exists(path):
        return []
    try:
        payload = _load_json_file(path, label)
    except SystemExit:
        return []
    blockers = payload.get("externalBlockers") or payload.get("ExternalBlockers") or []
    if not isinstance(blockers, list):
        return []
    sanitized: list[dict] = []
    for item in blockers:
        if not isinstance(item, dict):
            continue
        sanitized.append({
            "code": str(item.get("code") or item.get("Code") or ""),
            "scope": str(item.get("scope") or item.get("Scope") or ""),
            "source": str(item.get("source") or item.get("Source") or ""),
            "appCaller": str(item.get("appCaller") or item.get("AppCaller") or ""),
            "modelId": str(item.get("modelId") or item.get("ModelId") or ""),
            "logId": str(item.get("logId") or item.get("LogId") or ""),
            "step": str(item.get("step") or item.get("Step") or ""),
            "remediation": str(item.get("remediation") or item.get("Remediation") or ""),
        })
    return sanitized


def _canary_external_blockers(path: str) -> list[dict]:
    return _external_blockers_from_json(path, "canary evidence")


def _merge_blockers(*groups: list[dict]) -> list[dict]:
    merged: list[dict] = []
    seen: set[tuple[str, str, str, str, str, str]] = set()
    for group in groups:
        for item in group:
            key = (
                str(item.get("code") or ""),
                str(item.get("scope") or ""),
                str(item.get("source") or ""),
                str(item.get("appCaller") or ""),
                str(item.get("modelId") or ""),
                str(item.get("step") or ""),
            )
            if key in seen:
                continue
            seen.add(key)
            merged.append(item)
    return merged


def _require_video_canary(path: str, label: str) -> None:
    _require_pass_json(path, label)


def _require_asr_http_canary(path: str, label: str) -> None:
    _require_pass_json(path, label)


def _require_config_authority_apply(path: str, label: str) -> None:
    payload = _require_pass_json(path, label)
    if payload.get("execute") is not True and payload.get("Execute") is not True:
        raise SystemExit(f"ERROR: {label} was not executed: {path}")

    after = payload.get("after") or payload.get("After") or {}
    if not isinstance(after, dict):
        raise SystemExit(f"ERROR: {label} missing final after report: {path}")

    status = str(after.get("status") or after.get("Status") or "").lower()
    map_remaining = after.get("mapFallbackObjectsRemaining")
    if map_remaining is None:
        map_remaining = after.get("MapFallbackObjectsRemaining")
    active_ready = after.get("activeAppCallerMapFallbackReady")
    if active_ready is None:
        active_ready = after.get("ActiveAppCallerMapFallbackReady")
    active_missing = after.get("activeMissingGatewayPool")
    if active_missing is None:
        active_missing = after.get("ActiveMissingGatewayPool")
    active_without_usable = after.get("activeBoundPoolWithoutUsableMember")
    if active_without_usable is None:
        active_without_usable = after.get("ActiveBoundPoolWithoutUsableMember")

    if status != "ready":
        raise SystemExit(f"ERROR: {label} final status is not ready: {path} status={status or 'empty'}")
    if int(map_remaining or 0) != 0:
        raise SystemExit(
            f"ERROR: {label} final mapFallbackObjectsRemaining is not zero: {path} value={map_remaining}"
        )
    if active_ready is not True:
        raise SystemExit(f"ERROR: {label} final activeAppCallerMapFallbackReady is not true: {path}")
    if int(active_missing or 0) != 0:
        raise SystemExit(f"ERROR: {label} final activeMissingGatewayPool is not zero: {path} value={active_missing}")
    if int(active_without_usable or 0) != 0:
        raise SystemExit(
            f"ERROR: {label} final activeBoundPoolWithoutUsableMember is not zero: "
            f"{path} value={active_without_usable}"
        )


def _require_external_backup(path: str, label: str) -> None:
    payload = _require_pass_json(path, label)
    backup_dir = str(payload.get("backupDir") or payload.get("BackupDir") or "").strip()
    if not backup_dir:
        raise SystemExit(f"ERROR: {label} missing backupDir: {path}")
    dry_run = bool(payload.get("dryRun") if "dryRun" in payload else payload.get("DryRun"))
    if dry_run:
        raise SystemExit(f"ERROR: {label} is dry-run evidence, not an executed backup: {path}")
    archive_count = int(payload.get("archiveCount") or payload.get("ArchiveCount") or 0)
    if archive_count <= 0:
        raise SystemExit(f"ERROR: {label} archiveCount is zero: {path}")
    sha256_sums = str(payload.get("sha256Sums") or payload.get("Sha256Sums") or "").strip()
    if not sha256_sums:
        raise SystemExit(f"ERROR: {label} missing sha256Sums: {path}")


def _require_protocol_router_audit(path: str, label: str) -> None:
    payload = _require_pass_json(path, label)
    scope = str(payload.get("scope") or payload.get("Scope") or "").strip()
    if scope != "static-code-and-document-evidence":
        raise SystemExit(f"ERROR: {label} scope is not static-code-and-document-evidence: {path} scope={scope or 'empty'}")
    if payload.get("targetComplete") is not False and payload.get("TargetComplete") is not False:
        raise SystemExit(f"ERROR: {label} targetComplete must remain false until runtime gates pass: {path}")
    if payload.get("runtimeEvidenceComplete") is not False and payload.get("RuntimeEvidenceComplete") is not False:
        raise SystemExit(f"ERROR: {label} runtimeEvidenceComplete must remain false in static audit evidence: {path}")
    progress_percent = payload.get("progressPercent")
    if progress_percent is None:
        progress_percent = payload.get("ProgressPercent")
    if isinstance(progress_percent, (int, float)) and progress_percent >= 100:
        raise SystemExit(
            f"ERROR: {label} progressPercent must not report 100 while targetComplete=false: "
            f"{path} progressPercent={progress_percent}"
        )
    remaining = payload.get("remainingRuntimeGates")
    if remaining is None:
        remaining = payload.get("RemainingRuntimeGates")
    if not isinstance(remaining, list) or not remaining:
        raise SystemExit(f"ERROR: {label} missing remainingRuntimeGates: {path}")


def _bool_flag(value: str) -> bool:
    return str(value).strip().lower() in {"1", "true", "yes", "y", "on"}


def _require_http_full_map_fallback_exit(stage: str, status: str, value: str, label: str) -> None:
    if stage != "http-full" or status != "success":
        return
    if not _bool_flag(value):
        raise SystemExit(f"ERROR: {label} {HTTP_FULL_MAP_FALLBACK_EXIT_ERROR}")


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


def _entries_after(entries: list[dict], commit: str, after: datetime, statuses: set[str]) -> list[dict]:
    later: list[dict] = []
    for item in entries:
        if str(item.get("commit") or "").lower() != commit.lower():
            continue
        if str(item.get("status") or "") not in statuses:
            continue
        recorded_at = _parse_recorded_at(item.get("recordedAt"))
        if recorded_at and recorded_at > after:
            later.append(item)
    return later


def _latest_success_evidence_failures(entries: list[dict], commit: str, stage: str) -> list[str]:
    latest = _latest_success(entries, commit, stage)
    if not latest:
        return [f"missing success stage for commit: stage={stage} commit={commit}"]
    failures = _entry_evidence_failures(latest)
    return [
        f"prior stage evidence invalid before rollout: stage={stage} {failure}"
        for failure in failures
    ]


def _existing_success_evidence_failures(entries: list[dict], commit: str, stage: str) -> list[str]:
    latest = _latest_success(entries, commit, stage)
    if not latest:
        return []
    failures = _entry_evidence_failures(latest)
    return [
        f"existing prior stage evidence invalid before out-of-order rollout: stage={stage} {failure}"
        for failure in failures
    ]


def _required_rollout_stages(target_stage: str, require_target_success: bool) -> list[str]:
    if target_stage == "rollback-inproc":
        return []
    if target_stage not in ROLLOUT_SEQUENCE:
        raise SystemExit(f"ERROR: unknown rollout target stage: {target_stage}")
    end = ROLLOUT_SEQUENCE.index(target_stage)
    if require_target_success:
        end += 1
    return ROLLOUT_SEQUENCE[:end]


def _observation_stages(stages: list[str]) -> list[str]:
    return [stage for stage in stages if stage != CONFIG_AUTHORITY_STAGE]


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
        _require_stage_evidence_matches_entry(evidence_json, f"{stage} stage evidence", entry)
    except SystemExit as exc:
        failures.append(str(exc))
    protocol_router_audit_json = str(entry.get("protocolRouterAuditJson") or "")
    if protocol_router_audit_json:
        try:
            _require_protocol_router_audit(protocol_router_audit_json, f"{stage} protocol router audit evidence")
        except SystemExit as exc:
            failures.append(str(exc))

    if stage == ROLLBACK_REHEARSAL_STAGE:
        return failures

    if stage == CONFIG_AUTHORITY_STAGE:
        try:
            _require_external_backup(
                str(entry.get("externalBackupJson") or ""),
                f"{stage} external backup evidence",
            )
        except SystemExit as exc:
            failures.append(str(exc))
        try:
            _require_config_authority_apply(
                str(entry.get("configAuthorityJson") or ""),
                f"{stage} config authority evidence",
            )
        except SystemExit as exc:
            failures.append(str(exc))
        return failures

    try:
        _require_prod_preflight_for_commit(str(entry.get("prodPreflightJson") or ""), f"{stage} production preflight evidence", commit, stage)
    except SystemExit as exc:
        failures.append(str(exc))
    if _bool_flag(str(entry.get("prodHealthPreflightRequired") or "0")):
        try:
            _require_prod_health_preflight_for_commit(
                str(entry.get("prodHealthPreflightJson") or ""),
                f"{stage} production health preflight evidence",
                commit,
            )
        except SystemExit as exc:
            failures.append(str(exc))

    evidence_checks = [
        ("servingProbeJson", "serving probe evidence", True),
        ("smokeJson", "D-layer smoke evidence", _bool_flag(str(entry.get("smokeRequired", True)))),
        ("protocolCanaryJson", "protocol canary evidence", _bool_flag(str(entry.get("protocolCanaryRequired", False)))),
    ]
    for key, label, required in evidence_checks:
        if not required:
            continue
        try:
            if key == "servingProbeJson":
                _require_serving_probe_for_commit(str(entry.get(key) or ""), f"{stage} {label}", commit)
            elif key == "protocolCanaryJson":
                _require_protocol_canary_for_commit(str(entry.get(key) or ""), f"{stage} {label}", commit)
            else:
                _require_smoke_for_commit(str(entry.get(key) or ""), f"{stage} {label}", commit)
                if _bool_flag(str(entry.get("smokeRouteMatrixRequired", False))):
                    _require_smoke_route_matrix(str(entry.get(key) or ""), f"{stage} D-layer smoke route matrix evidence")
        except SystemExit as exc:
            failures.append(str(exc))
    if _bool_flag(str(entry.get("releaseGateRequired") or "0")):
        try:
            shadow_evidence_commit = _normalize_commit(entry.get("shadowEvidenceCommit")) or commit
            maintenance_baseline_commit = _validated_maintenance_baseline_commit(argparse.Namespace(
                maintenance_baseline_commit=str(entry.get("maintenanceBaselineCommit") or ""),
                maintenance_baseline_json=str(entry.get("maintenanceBaselineJson") or ""),
                shadow_evidence_commit=shadow_evidence_commit,
                stage=stage,
                commit=commit,
            ))
            _require_release_gate_for_commit(
                str(entry.get("releaseGateJson") or ""),
                f"{stage} release gate evidence",
                shadow_evidence_commit,
                require_config_authority=stage == "http-full",
                allow_skipped_runtime_gates=bool(maintenance_baseline_commit),
                allow_skipped_config_authority=bool(maintenance_baseline_commit),
            )
        except SystemExit as exc:
            failures.append(str(exc))
    if _bool_flag(str(entry.get("upstreamReadinessRequired") or "0")):
        try:
            _require_upstream_readiness(str(entry.get("upstreamReadinessJson") or ""), f"{stage} upstream readiness evidence")
        except SystemExit as exc:
            failures.append(str(exc))
    if _bool_flag(str(entry.get("providerAuditRequired") or "0")):
        try:
            _require_provider_audit(str(entry.get("providerAuditJson") or ""), f"{stage} provider config audit evidence")
        except SystemExit as exc:
            failures.append(str(exc))
    if _bool_flag(str(entry.get("videoCanaryRequired") or "0")):
        try:
            _require_video_canary(str(entry.get("videoCanaryJson") or ""), f"{stage} video canary evidence")
        except SystemExit as exc:
            failures.append(str(exc))
    if _bool_flag(str(entry.get("asrHttpCanaryRequired") or "0")):
        try:
            _require_asr_http_canary(str(entry.get("asrHttpCanaryJson") or ""), f"{stage} ASR HTTP canary evidence")
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
                f"recordedAt=`{cell(item.get('recordedAt') or '')}` "
                f"providerExternalBlockers=`{len(item.get('providerAuditExternalBlockers') or [])}`\n"
            )
            for blocker in item.get("providerAuditExternalBlockers") or []:
                fh.write(
                    f"  - `{cell(blocker.get('code') or '')}` scope=`{cell(blocker.get('scope') or '')}` "
                    f"appCaller=`{cell(blocker.get('appCaller') or '')}` model=`{cell(blocker.get('modelId') or '')}`\n"
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
        required = STAGES[: STAGES.index(stage)] if stage in STAGES else []
        evidence_failures: list[str] = []
        if stage in STAGES and _stage_requires_rehearsal(stage):
            evidence_failures.extend(_existing_success_evidence_failures(entries, commit, ROLLBACK_REHEARSAL_STAGE))
        for prior_stage in required:
            evidence_failures.extend(_existing_success_evidence_failures(entries, commit, prior_stage))
        if evidence_failures:
            print(
                "ERROR: rollout stage prior evidence validation failed. "
                f"stage={stage} commit={commit} ledger={args.ledger}",
                file=sys.stderr,
            )
            for failure in evidence_failures:
                print(f"ERROR: {failure}", file=sys.stderr)
            return 1
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

    evidence_failures: list[str] = []
    if _stage_requires_rehearsal(stage):
        evidence_failures.extend(_latest_success_evidence_failures(entries, commit, ROLLBACK_REHEARSAL_STAGE))
    for prior_stage in required:
        evidence_failures.extend(_latest_success_evidence_failures(entries, commit, prior_stage))
    if evidence_failures:
        print(
            "ERROR: rollout stage prior evidence validation failed. "
            f"stage={stage} commit={commit} ledger={args.ledger}",
            file=sys.stderr,
        )
        for failure in evidence_failures:
            print(f"ERROR: {failure}", file=sys.stderr)
        return 1

    try:
        min_observation_hours = max(0.0, float(args.min_observation_hours or 0))
    except (TypeError, ValueError):
        print(f"ERROR: --min-observation-hours must be a non-negative number: {args.min_observation_hours}", file=sys.stderr)
        return 2
    if min_observation_hours > 0 and required and stage != CONFIG_AUTHORITY_STAGE:
        observation_required = _observation_stages(required)
        if not observation_required:
            print(f"LLM Gateway rollout ledger: no observation stage required for {stage}")
            print(f"LLM Gateway rollout ledger: prior stages satisfied for {stage}")
            return 0
        previous_stage = observation_required[-1]
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
    maintenance_baseline_commit = _validated_maintenance_baseline_commit(args)
    if args.status == "success":
        _require_http_full_map_fallback_exit(
            args.stage,
            args.status,
            args.disable_map_config_fallback_for_active_app_callers,
            "rollout ledger append",
        )
        _require_stage_evidence_for_commit(args.evidence_json, "stage evidence", args.commit)
        _require_protocol_router_audit(args.protocol_router_audit_json, "protocol router audit evidence")
        if args.stage == CONFIG_AUTHORITY_STAGE:
            _require_external_backup(args.external_backup_json, "external backup evidence")
            _require_config_authority_apply(args.config_authority_json, "config authority evidence")
        elif args.stage != ROLLBACK_REHEARSAL_STAGE:
            _require_prod_preflight_for_commit(args.prod_preflight_json, "production preflight evidence", args.commit, args.stage)
            if _bool_flag(args.prod_health_preflight_required):
                _require_prod_health_preflight_for_commit(args.prod_health_preflight_json, "production health preflight evidence", args.commit)
            _require_serving_probe_for_commit(args.serving_probe_json, "serving probe evidence", args.commit)
            if _bool_flag(args.smoke_required):
                _require_smoke_for_commit(args.smoke_json, "D-layer smoke evidence", args.commit)
                if _bool_flag(args.smoke_route_matrix_required):
                    _require_smoke_route_matrix(args.smoke_json, "D-layer smoke route matrix evidence")
            if _bool_flag(args.release_gate_required):
                _require_release_gate_for_commit(
                    args.release_gate_json,
                    "release gate evidence",
                    args.shadow_evidence_commit or args.commit,
                    require_config_authority=args.stage == "http-full",
                    allow_skipped_runtime_gates=bool(maintenance_baseline_commit),
                    allow_skipped_config_authority=bool(maintenance_baseline_commit),
                )
            if _bool_flag(args.protocol_canary_required):
                _require_protocol_canary_for_commit(args.protocol_canary_json, "protocol canary evidence", args.commit)
            if _bool_flag(args.upstream_readiness_required):
                _require_upstream_readiness(args.upstream_readiness_json, "upstream readiness evidence")
            if _bool_flag(args.provider_audit_required):
                _require_provider_audit(args.provider_audit_json, "provider config audit evidence")
            if _bool_flag(args.video_canary_required):
                _require_video_canary(args.video_canary_json, "video canary evidence")
            if _bool_flag(args.asr_http_canary_required):
                _require_asr_http_canary(args.asr_http_canary_json, "ASR HTTP canary evidence")

    provider_external_blockers = _provider_external_blockers(args.provider_audit_json)
    video_canary_external_blockers = _canary_external_blockers(args.video_canary_json)
    asr_http_canary_external_blockers = _canary_external_blockers(args.asr_http_canary_json)
    all_external_blockers = _merge_blockers(
        provider_external_blockers,
        video_canary_external_blockers,
        asr_http_canary_external_blockers,
    )
    entry = {
        "recordedAt": datetime.now(timezone.utc).isoformat(),
        "stage": args.stage,
        "status": args.status,
        "commit": args.commit.lower(),
        "mode": args.mode,
        "canaryStage": args.canary_stage,
        "allowlist": args.allowlist,
        "shadowFullSamplePercent": args.shadow_full_sample_percent,
        "disableMapConfigFallbackForActiveAppCallers": _bool_flag(args.disable_map_config_fallback_for_active_app_callers),
        "gateBase": args.gate_base,
        "evidenceJson": args.evidence_json,
        "evidenceMarkdown": args.evidence_md,
        "releaseGateJson": args.release_gate_json,
        "shadowEvidenceCommit": _normalize_commit(args.shadow_evidence_commit) or args.commit.lower(),
        "maintenanceBaselineCommit": maintenance_baseline_commit,
        "maintenanceBaselineJson": args.maintenance_baseline_json,
        "releaseGateRequired": _bool_flag(args.release_gate_required),
        "prodPreflightJson": args.prod_preflight_json,
        "prodHealthPreflightJson": args.prod_health_preflight_json,
        "prodHealthPreflightRequired": _bool_flag(args.prod_health_preflight_required),
        "shadowSeedJson": args.shadow_seed_json,
        "upstreamReadinessJson": args.upstream_readiness_json,
        "upstreamReadinessRequired": _bool_flag(args.upstream_readiness_required),
        "providerAuditJson": args.provider_audit_json,
        "providerAuditRequired": _bool_flag(args.provider_audit_required),
        "providerAuditExternalBlockers": provider_external_blockers,
        "protocolRouterAuditJson": args.protocol_router_audit_json,
        "protocolCanaryJson": args.protocol_canary_json,
        "protocolCanaryRequired": _bool_flag(args.protocol_canary_required),
        "videoCanaryJson": args.video_canary_json,
        "videoCanaryRequired": _bool_flag(args.video_canary_required),
        "videoCanaryExternalBlockers": video_canary_external_blockers,
        "asrHttpCanaryJson": args.asr_http_canary_json,
        "asrHttpCanaryRequired": _bool_flag(args.asr_http_canary_required),
        "asrHttpCanaryExternalBlockers": asr_http_canary_external_blockers,
        "configAuthorityJson": args.config_authority_json,
        "externalBackupJson": args.external_backup_json,
        "externalBlockers": all_external_blockers,
        "rollbackRehearsal": args.stage == ROLLBACK_REHEARSAL_STAGE,
        "allowOutOfOrder": _bool_flag(args.allow_out_of_order),
        "allowOutOfOrderReason": args.allow_out_of_order_reason.strip(),
        "servingProbeJson": args.serving_probe_json,
        "smokeJson": args.smoke_json,
        "smokeRequired": _bool_flag(args.smoke_required),
        "smokeRouteMatrixRequired": _bool_flag(args.smoke_route_matrix_required),
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
        fh.write(f"- disableMapConfigFallbackForActiveAppCallers: `{cell(report['disableMapConfigFallbackForActiveAppCallers'])}`\n")
        fh.write(f"- releaseGateRequired: `{cell(report['releaseGateRequired'])}`\n")
        fh.write(f"- maintenanceBaselineCommit: `{cell(report['maintenanceBaselineCommit'])}`\n")
        fh.write(f"- maintenanceBaselineJson: `{cell(report['maintenanceBaselineJson'])}`\n")
        fh.write(f"- rollbackRehearsal: `{cell(report['rollbackRehearsal'])}`\n")
        fh.write(f"- allowOutOfOrder: `{cell(report['allowOutOfOrder'])}`\n")
        fh.write(f"- allowOutOfOrderReason: `{cell(report['allowOutOfOrderReason'])}`\n")
        fh.write(f"- minStageObservationHours: `{cell(report['minStageObservationHours'])}`\n")
        fh.write(f"- releaseGateJson: `{cell(report['releaseGateJson'])}`\n")
        fh.write(f"- prodPreflightJson: `{cell(report['prodPreflightJson'])}`\n")
        fh.write(f"- prodHealthPreflightRequired: `{cell(report['prodHealthPreflightRequired'])}`\n")
        fh.write(f"- prodHealthPreflightJson: `{cell(report['prodHealthPreflightJson'])}`\n")
        fh.write(f"- shadowSeedJson: `{cell(report['shadowSeedJson'])}`\n")
        fh.write(f"- upstreamReadinessRequired: `{cell(report['upstreamReadinessRequired'])}`\n")
        fh.write(f"- upstreamReadinessJson: `{cell(report['upstreamReadinessJson'])}`\n")
        fh.write(f"- providerAuditRequired: `{cell(report['providerAuditRequired'])}`\n")
        fh.write(f"- providerAuditJson: `{cell(report['providerAuditJson'])}`\n")
        fh.write(f"- providerAuditExternalBlockers: `{len(report.get('providerAuditExternalBlockers') or [])}`\n")
        fh.write(f"- protocolRouterAuditJson: `{cell(report['protocolRouterAuditJson'])}`\n")
        fh.write(f"- protocolCanaryRequired: `{cell(report['protocolCanaryRequired'])}`\n")
        fh.write(f"- protocolCanaryJson: `{cell(report['protocolCanaryJson'])}`\n")
        fh.write(f"- videoCanaryRequired: `{cell(report['videoCanaryRequired'])}`\n")
        fh.write(f"- videoCanaryJson: `{cell(report['videoCanaryJson'])}`\n")
        fh.write(f"- asrHttpCanaryRequired: `{cell(report['asrHttpCanaryRequired'])}`\n")
        fh.write(f"- asrHttpCanaryJson: `{cell(report['asrHttpCanaryJson'])}`\n")
        fh.write(f"- configAuthorityJson: `{cell(report['configAuthorityJson'])}`\n")
        fh.write(f"- externalBackupJson: `{cell(report['externalBackupJson'])}`\n")
        fh.write(f"- servingProbeJson: `{cell(report['servingProbeJson'])}`\n")
        fh.write(f"- smokeRequired: `{cell(report['smokeRequired'])}`\n")
        fh.write(f"- smokeRouteMatrixRequired: `{cell(report['smokeRouteMatrixRequired'])}`\n")
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
        blockers = report.get("providerAuditExternalBlockers") or []
        fh.write("\n## Provider External Blockers\n\n")
        if blockers:
            for item in blockers:
                fh.write(
                    f"- `{cell(item.get('code') or '')}` scope=`{cell(item.get('scope') or '')}` "
                    f"appCaller=`{cell(item.get('appCaller') or '')}` model=`{cell(item.get('modelId') or '')}`: "
                    f"{cell(item.get('remediation') or '')}\n"
                )
        else:
            fh.write("- none\n")
        canary_blockers = _merge_blockers(
            report.get("videoCanaryExternalBlockers") or [],
            report.get("asrHttpCanaryExternalBlockers") or [],
        )
        fh.write("\n## Canary External Blockers\n\n")
        if canary_blockers:
            for item in canary_blockers:
                fh.write(
                    f"- `{cell(item.get('code') or '')}` scope=`{cell(item.get('scope') or '')}` "
                    f"source=`{cell(item.get('source') or '')}` appCaller=`{cell(item.get('appCaller') or '')}` "
                    f"model=`{cell(item.get('modelId') or '')}`: {cell(item.get('remediation') or '')}\n"
                )
        else:
            fh.write("- none\n")


def stage_report(args: argparse.Namespace) -> int:
    failures: list[str] = []
    maintenance_baseline_commit = _validated_maintenance_baseline_commit(args)
    provider_external_blockers = _provider_external_blockers(args.provider_audit_json)
    video_canary_external_blockers = _canary_external_blockers(args.video_canary_json)
    asr_http_canary_external_blockers = _canary_external_blockers(args.asr_http_canary_json)
    all_external_blockers = _merge_blockers(
        provider_external_blockers,
        video_canary_external_blockers,
        asr_http_canary_external_blockers,
    )
    if args.stage == CONFIG_AUTHORITY_STAGE:
        checks = [
            ("protocolRouterAuditJson", args.protocol_router_audit_json, True),
            ("externalBackupJson", args.external_backup_json, True),
            ("configAuthorityJson", args.config_authority_json, True),
        ]
    else:
        checks = [
            ("protocolRouterAuditJson", args.protocol_router_audit_json, True),
            ("prodPreflightJson", args.prod_preflight_json, True),
            ("prodHealthPreflightJson", args.prod_health_preflight_json, _bool_flag(args.prod_health_preflight_required)),
            ("servingProbeJson", args.serving_probe_json, True),
            ("smokeJson", args.smoke_json, _bool_flag(args.smoke_required)),
            ("releaseGateJson", args.release_gate_json, _bool_flag(args.release_gate_required)),
            ("protocolCanaryJson", args.protocol_canary_json, _bool_flag(args.protocol_canary_required)),
            ("upstreamReadinessJson", args.upstream_readiness_json, _bool_flag(args.upstream_readiness_required)),
            ("providerAuditJson", args.provider_audit_json, _bool_flag(args.provider_audit_required)),
            ("videoCanaryJson", args.video_canary_json, _bool_flag(args.video_canary_required)),
            ("asrHttpCanaryJson", args.asr_http_canary_json, _bool_flag(args.asr_http_canary_required)),
        ]
    if args.stage == ROLLBACK_REHEARSAL_STAGE:
        checks = [("protocolRouterAuditJson", args.protocol_router_audit_json, True)]
    try:
        _require_http_full_map_fallback_exit(
            args.stage,
            args.status,
            args.disable_map_config_fallback_for_active_app_callers,
            "stage report",
        )
    except SystemExit as exc:
        failures.append(str(exc))
    for label, path, required in checks:
        if not required:
            continue
        try:
            if label == "servingProbeJson":
                _require_serving_probe_for_commit(path, label, args.commit)
            elif label == "releaseGateJson":
                _require_release_gate_for_commit(
                    path,
                    label,
                    args.shadow_evidence_commit or args.commit,
                    require_config_authority=args.stage == "http-full",
                    allow_skipped_runtime_gates=bool(maintenance_baseline_commit),
                    allow_skipped_config_authority=bool(maintenance_baseline_commit),
                )
            elif label == "prodPreflightJson":
                _require_prod_preflight_for_commit(path, label, args.commit, args.stage)
            elif label == "prodHealthPreflightJson":
                _require_prod_health_preflight_for_commit(path, label, args.commit)
            elif label == "upstreamReadinessJson":
                _require_upstream_readiness(path, label)
            elif label == "providerAuditJson":
                _require_provider_audit(path, label)
            elif label == "protocolRouterAuditJson":
                _require_protocol_router_audit(path, label)
            elif label == "protocolCanaryJson":
                _require_protocol_canary_for_commit(path, label, args.commit)
            elif label == "videoCanaryJson":
                _require_video_canary(path, label)
            elif label == "asrHttpCanaryJson":
                _require_asr_http_canary(path, label)
            elif label == "configAuthorityJson":
                _require_config_authority_apply(path, label)
            elif label == "externalBackupJson":
                _require_external_backup(path, label)
            else:
                _require_smoke_for_commit(path, label, args.commit)
                if _bool_flag(args.smoke_route_matrix_required):
                    _require_smoke_route_matrix(path, "D-layer smoke route matrix evidence")
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
        "disableMapConfigFallbackForActiveAppCallers": _bool_flag(args.disable_map_config_fallback_for_active_app_callers),
        "gateBase": args.gate_base,
        "releaseGateRequired": _bool_flag(args.release_gate_required),
        "shadowEvidenceCommit": _normalize_commit(args.shadow_evidence_commit) or args.commit.lower(),
        "maintenanceBaselineCommit": maintenance_baseline_commit,
        "maintenanceBaselineJson": args.maintenance_baseline_json,
        "rollbackRehearsal": args.stage == ROLLBACK_REHEARSAL_STAGE,
        "allowOutOfOrder": _bool_flag(args.allow_out_of_order),
        "allowOutOfOrderReason": args.allow_out_of_order_reason.strip(),
        "minStageObservationHours": args.min_stage_observation_hours,
        "releaseGateJson": args.release_gate_json,
        "prodPreflightJson": args.prod_preflight_json,
        "prodHealthPreflightJson": args.prod_health_preflight_json,
        "prodHealthPreflightRequired": _bool_flag(args.prod_health_preflight_required),
        "shadowSeedJson": args.shadow_seed_json,
        "upstreamReadinessJson": args.upstream_readiness_json,
        "upstreamReadinessRequired": _bool_flag(args.upstream_readiness_required),
        "providerAuditJson": args.provider_audit_json,
        "providerAuditRequired": _bool_flag(args.provider_audit_required),
        "providerAuditExternalBlockers": provider_external_blockers,
        "protocolRouterAuditJson": args.protocol_router_audit_json,
        "protocolCanaryJson": args.protocol_canary_json,
        "protocolCanaryRequired": _bool_flag(args.protocol_canary_required),
        "videoCanaryJson": args.video_canary_json,
        "videoCanaryRequired": _bool_flag(args.video_canary_required),
        "videoCanaryExternalBlockers": video_canary_external_blockers,
        "asrHttpCanaryJson": args.asr_http_canary_json,
        "asrHttpCanaryRequired": _bool_flag(args.asr_http_canary_required),
        "asrHttpCanaryExternalBlockers": asr_http_canary_external_blockers,
        "configAuthorityJson": args.config_authority_json,
        "externalBackupJson": args.external_backup_json,
        "externalBlockers": all_external_blockers,
        "servingProbeJson": args.serving_probe_json,
        "smokeJson": args.smoke_json,
        "smokeRequired": _bool_flag(args.smoke_required),
        "smokeRouteMatrixRequired": _bool_flag(args.smoke_route_matrix_required),
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
                "prodHealthPreflightJson": latest.get("prodHealthPreflightJson") or "",
                "prodHealthPreflightRequired": _bool_flag(str(latest.get("prodHealthPreflightRequired") or "0")),
                "shadowSeedJson": latest.get("shadowSeedJson") or "",
                "upstreamReadinessJson": latest.get("upstreamReadinessJson") or "",
                "upstreamReadinessRequired": _bool_flag(str(latest.get("upstreamReadinessRequired") or "0")),
                "providerAuditJson": latest.get("providerAuditJson") or "",
                "providerAuditRequired": _bool_flag(str(latest.get("providerAuditRequired") or "0")),
                "providerAuditExternalBlockers": latest.get("providerAuditExternalBlockers") or _provider_external_blockers(str(latest.get("providerAuditJson") or "")),
                "protocolRouterAuditJson": latest.get("protocolRouterAuditJson") or "",
                "protocolCanaryJson": latest.get("protocolCanaryJson") or "",
                "protocolCanaryRequired": _bool_flag(str(latest.get("protocolCanaryRequired") or "0")),
                "videoCanaryJson": latest.get("videoCanaryJson") or "",
                "videoCanaryRequired": _bool_flag(str(latest.get("videoCanaryRequired") or "0")),
                "videoCanaryExternalBlockers": latest.get("videoCanaryExternalBlockers") or _canary_external_blockers(str(latest.get("videoCanaryJson") or "")),
                "asrHttpCanaryJson": latest.get("asrHttpCanaryJson") or "",
                "asrHttpCanaryRequired": _bool_flag(str(latest.get("asrHttpCanaryRequired") or "0")),
                "asrHttpCanaryExternalBlockers": latest.get("asrHttpCanaryExternalBlockers") or _canary_external_blockers(str(latest.get("asrHttpCanaryJson") or "")),
                "configAuthorityJson": latest.get("configAuthorityJson") or "",
                "externalBackupJson": latest.get("externalBackupJson") or "",
                "externalBlockers": latest.get("externalBlockers") or _merge_blockers(
                    latest.get("providerAuditExternalBlockers") or _provider_external_blockers(str(latest.get("providerAuditJson") or "")),
                    latest.get("videoCanaryExternalBlockers") or _canary_external_blockers(str(latest.get("videoCanaryJson") or "")),
                    latest.get("asrHttpCanaryExternalBlockers") or _canary_external_blockers(str(latest.get("asrHttpCanaryJson") or "")),
                ),
                "releaseMainRef": latest.get("releaseMainRef") or "",
                "releaseMainSha": latest.get("releaseMainSha") or "",
                "disableMapConfigFallbackForActiveAppCallers": _bool_flag(str(latest.get("disableMapConfigFallbackForActiveAppCallers") or "0")),
                "allowOutOfOrder": _bool_flag(str(latest.get("allowOutOfOrder") or "0")),
                "allowOutOfOrderReason": latest.get("allowOutOfOrderReason") or "",
            }
        )

    stages_requiring_prior_rehearsal_order = [
        stage
        for stage in required_stages
        if stage.startswith("canary-") or stage in {CONFIG_AUTHORITY_STAGE, "http-full"}
    ]
    rehearsal = latest_by_stage.get(ROLLBACK_REHEARSAL_STAGE)
    rehearsal_time = _parse_recorded_at(rehearsal.get("recordedAt")) if rehearsal else None
    for stage in stages_requiring_prior_rehearsal_order:
        stage_entry = latest_by_stage.get(stage)
        stage_time = _parse_recorded_at(stage_entry.get("recordedAt")) if stage_entry else None
        if not rehearsal_time:
            failures.append(f"missing rollback rehearsal time before stage={stage}")
        elif stage_time and rehearsal_time > stage_time:
            failures.append(
                "rollback rehearsal must be recorded before canary/http stage. "
                f"stage={stage} rehearsalAt={rehearsal_time.isoformat()} stageAt={stage_time.isoformat()}"
            )

    if bool(args.require_target_success) and args.target_stage != "rollback-inproc":
        target = latest_by_stage.get(args.target_stage)
        target_time = _parse_recorded_at(target.get("recordedAt")) if target else None
        if target_time:
            later_negative = _entries_after(entries, commit, target_time, {"failed", "rollback"})
            for item in later_negative:
                failures.append(
                    "rollout target success is stale because a later negative event exists. "
                    f"target_stage={args.target_stage} event_stage={item.get('stage') or ''} "
                    f"event_status={item.get('status') or ''} recordedAt={item.get('recordedAt') or ''}"
                )

    ordered_real_stages = _observation_stages([stage for stage in STAGES if stage in required_stages])
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


def maintenance_baseline(args: argparse.Namespace) -> int:
    commit = _normalize_commit(args.commit)
    if len(commit) != 40 or any(ch not in "0123456789abcdef" for ch in commit):
        print("ERROR: maintenance baseline requires a full 40-character commit", file=sys.stderr)
        return 2

    entries = _load(args.ledger)
    target = _latest_success(entries, commit, "http-full")
    failures: list[str] = []
    stage_evidence: dict = {}
    release_gate: dict = {}
    shadow_evidence_commit = commit
    if not target:
        failures.append(f"missing http-full success baseline for commit={commit}")
    else:
        evidence_path = str(target.get("evidenceJson") or "")
        release_gate_path = str(target.get("releaseGateJson") or "")
        try:
            stage_evidence = _require_pass_json(evidence_path, "maintenance baseline stage evidence")
            checks = {
                "stage": str(stage_evidence.get("stage") or "").lower() == "http-full",
                "status": str(stage_evidence.get("status") or "").lower() == "success",
                "commit": _normalize_commit(stage_evidence.get("commit")) == commit,
                "mode": str(stage_evidence.get("mode") or "").lower() == "http",
                "mapFallbackDisabled": _bool_flag(str(stage_evidence.get("disableMapConfigFallbackForActiveAppCallers") or "0")),
                "noFailures": not (stage_evidence.get("failures") or []),
            }
            failures.extend(f"maintenance baseline stage evidence invalid: {name}" for name, ok in checks.items() if not ok)
            shadow_evidence_commit = _normalize_commit(stage_evidence.get("shadowEvidenceCommit")) or commit
        except SystemExit as exc:
            failures.append(str(exc))

        try:
            release_gate = _require_pass_json(release_gate_path, "maintenance baseline release gate")
            if _normalize_commit(release_gate.get("shadowReleaseCommit") or release_gate.get("expectedCommit")) != shadow_evidence_commit:
                failures.append("maintenance baseline release gate commit mismatch")
            shadow_checks = release_gate.get("shadowChecks") or []
            if not isinstance(shadow_checks, list) or not shadow_checks:
                failures.append("maintenance baseline release gate has no shadow checks")
            else:
                for item in shadow_checks:
                    if not isinstance(item, dict):
                        failures.append("maintenance baseline release gate contains an invalid shadow check")
                        continue
                    if _normalize_commit(item.get("releaseCommit")) != shadow_evidence_commit:
                        failures.append("maintenance baseline shadow check commit mismatch")
                    if int(item.get("critical") or 0) != 0 or int(item.get("httpFail") or 0) != 0 or item.get("ok") is not True:
                        failures.append(f"maintenance baseline shadow check is unsafe: {item.get('label') or 'unknown'}")
            _require_release_gate_for_commit(
                release_gate_path,
                "maintenance baseline release gate",
                shadow_evidence_commit,
                require_config_authority=True,
                allow_skipped_runtime_gates=True,
                allow_skipped_config_authority=True,
            )
        except (SystemExit, TypeError, ValueError) as exc:
            failures.append(str(exc))

        target_time = _parse_recorded_at(target.get("recordedAt"))
        if not target_time:
            failures.append("maintenance baseline http-full success has no valid recordedAt")
        else:
            for item in _entries_after(entries, commit, target_time, {"failed", "rollback"}):
                failures.append(
                    "maintenance baseline is stale because a later negative event exists. "
                    f"stage={item.get('stage') or ''} status={item.get('status') or ''} recordedAt={item.get('recordedAt') or ''}"
                )

    report = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "verdict": "fail" if failures else "pass",
        "ledger": args.ledger,
        "commit": commit,
        "shadowEvidenceCommit": shadow_evidence_commit,
        "stage": "http-full",
        "recordedAt": str((target or {}).get("recordedAt") or ""),
        "evidenceJson": str((target or {}).get("evidenceJson") or ""),
        "releaseGateJson": str((target or {}).get("releaseGateJson") or ""),
        "failures": failures,
    }
    _write_json(args.json_out, report)
    if failures:
        for failure in failures:
            print(f"ERROR: {failure}", file=sys.stderr)
        return 1
    print(f"LLM Gateway maintenance baseline audit: PASS commit={commit}")
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
    append_parser.add_argument("--disable-map-config-fallback-for-active-app-callers", default="0")
    append_parser.add_argument("--gate-base", default="")
    append_parser.add_argument("--evidence-json", default="")
    append_parser.add_argument("--evidence-md", default="")
    append_parser.add_argument("--release-gate-json", default="")
    append_parser.add_argument("--shadow-evidence-commit", default="")
    append_parser.add_argument("--maintenance-baseline-commit", default="")
    append_parser.add_argument("--maintenance-baseline-json", default="")
    append_parser.add_argument("--release-gate-required", default="0")
    append_parser.add_argument("--prod-preflight-json", default="")
    append_parser.add_argument("--prod-health-preflight-json", default="")
    append_parser.add_argument("--prod-health-preflight-required", default="0")
    append_parser.add_argument("--shadow-seed-json", default="")
    append_parser.add_argument("--upstream-readiness-json", default="")
    append_parser.add_argument("--upstream-readiness-required", default="0")
    append_parser.add_argument("--provider-audit-json", default="")
    append_parser.add_argument("--provider-audit-required", default="0")
    append_parser.add_argument("--protocol-router-audit-json", default="")
    append_parser.add_argument("--protocol-canary-json", default="")
    append_parser.add_argument("--protocol-canary-required", default="0")
    append_parser.add_argument("--video-canary-json", default="")
    append_parser.add_argument("--video-canary-required", default="0")
    append_parser.add_argument("--asr-http-canary-json", default="")
    append_parser.add_argument("--asr-http-canary-required", default="0")
    append_parser.add_argument("--config-authority-json", default="")
    append_parser.add_argument("--external-backup-json", default="")
    append_parser.add_argument("--serving-probe-json", default="")
    append_parser.add_argument("--smoke-json", default="")
    append_parser.add_argument("--smoke-required", default="1")
    append_parser.add_argument("--smoke-route-matrix-required", default="0")
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
    report_parser.add_argument("--disable-map-config-fallback-for-active-app-callers", default="0")
    report_parser.add_argument("--gate-base", default="")
    report_parser.add_argument("--release-gate-json", default="")
    report_parser.add_argument("--shadow-evidence-commit", default="")
    report_parser.add_argument("--maintenance-baseline-commit", default="")
    report_parser.add_argument("--maintenance-baseline-json", default="")
    report_parser.add_argument("--release-gate-required", default="0")
    report_parser.add_argument("--prod-preflight-json", default="")
    report_parser.add_argument("--prod-health-preflight-json", default="")
    report_parser.add_argument("--prod-health-preflight-required", default="0")
    report_parser.add_argument("--shadow-seed-json", default="")
    report_parser.add_argument("--upstream-readiness-json", default="")
    report_parser.add_argument("--upstream-readiness-required", default="0")
    report_parser.add_argument("--provider-audit-json", default="")
    report_parser.add_argument("--provider-audit-required", default="0")
    report_parser.add_argument("--protocol-router-audit-json", default="")
    report_parser.add_argument("--protocol-canary-json", default="")
    report_parser.add_argument("--protocol-canary-required", default="0")
    report_parser.add_argument("--video-canary-json", default="")
    report_parser.add_argument("--video-canary-required", default="0")
    report_parser.add_argument("--asr-http-canary-json", default="")
    report_parser.add_argument("--asr-http-canary-required", default="0")
    report_parser.add_argument("--config-authority-json", default="")
    report_parser.add_argument("--external-backup-json", default="")
    report_parser.add_argument("--serving-probe-json", default="")
    report_parser.add_argument("--smoke-json", default="")
    report_parser.add_argument("--smoke-required", default="1")
    report_parser.add_argument("--smoke-route-matrix-required", default="0")
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

    maintenance_parser = sub.add_parser("maintenance-baseline", help="audit a historical full-http maintenance baseline")
    maintenance_parser.add_argument("--ledger", required=True)
    maintenance_parser.add_argument("--commit", required=True)
    maintenance_parser.add_argument("--json-out", default="")
    maintenance_parser.set_defaults(func=maintenance_baseline)

    args = parser.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
