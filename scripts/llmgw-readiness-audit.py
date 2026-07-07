#!/usr/bin/env python3
"""LLM Gateway full-cutover readiness audit.

This script is a coordinator for release readiness. It does not mutate
production state. It combines static release invariants, rollback dry-run,
optional dotnet gate tests, optional D-layer smoke, optional shadow coverage matrix,
optional serving stability/auth probe, and optional live release-gate evidence.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _read(rel: str) -> str:
    path = ROOT / rel
    return path.read_text(encoding="utf-8") if path.exists() else ""


def _redact_cmd(cmd: list[str]) -> list[str]:
    redacted: list[str] = []
    redact_next = False
    for item in cmd:
        if redact_next:
            redacted.append("***")
            redact_next = False
            continue
        redacted.append(item)
        if item in {"--key", "--gateway-key"}:
            redact_next = True
    return redacted


def _run(
    cmd: list[str],
    *,
    cwd: Path = ROOT,
    env: dict[str, str] | None = None,
    timeout: int = 300,
    tail: int | None = 6000,
) -> dict:
    proc = subprocess.run(
        cmd,
        cwd=str(cwd),
        env=env,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )
    return {
        "cmd": _redact_cmd(cmd),
        "cwd": str(cwd),
        "exitCode": proc.returncode,
        "stdout": proc.stdout if tail is None else proc.stdout[-tail:],
        "stderr": proc.stderr if tail is None else proc.stderr[-tail:],
        "ok": proc.returncode == 0,
    }


def _check(name: str, ok: bool, detail: str = "") -> dict:
    return {"name": name, "ok": bool(ok), "detail": detail}


def _contains_all(text: str, needles: list[str]) -> tuple[bool, str]:
    missing = [item for item in needles if item not in text]
    return not missing, "missing: " + ", ".join(missing) if missing else "ok"


def _dictionary_block_is_empty(text: str, name: str) -> bool:
    pattern = re.compile(
        rf"{re.escape(name)}\s*=\s*new\([^)]*\)\s*\{{(?P<body>.*?)\}};",
        re.DOTALL,
    )
    match = pattern.search(text)
    if not match:
        return False
    body = re.sub(r"//.*", "", match.group("body")).strip()
    return body == ""


def _static_checks() -> list[dict]:
    checks: list[dict] = []

    release_gate = _read("scripts/llmgw-release-gate.py")
    shadow_coverage = _read("scripts/llmgw-shadow-coverage-report.py")
    serving_probe = _read("scripts/llmgw-serving-probe.py")
    prod_preflight_workflow = _read(".github/workflows/llmgw-prod-preflight.yml")
    prod_stage_workflow = _read(".github/workflows/llmgw-prod-stage.yml")
    prod_stage_path = ROOT / "scripts/llmgw-prod-stage.sh"
    prod_stage = prod_stage_path.read_text(encoding="utf-8")
    rollout_ledger_path = ROOT / "scripts/llmgw-rollout-ledger.py"
    rollout_ledger = rollout_ledger_path.read_text(encoding="utf-8") if rollout_ledger_path.exists() else ""
    prod_preflight_path = ROOT / "scripts/llmgw-prod-preflight.py"
    prod_preflight = prod_preflight_path.read_text(encoding="utf-8") if prod_preflight_path.exists() else ""
    upstream_readiness_path = ROOT / "scripts/llmgw-upstream-readiness.py"
    upstream_readiness = upstream_readiness_path.read_text(encoding="utf-8") if upstream_readiness_path.exists() else ""
    disk_guard_path = ROOT / "scripts/llmgw-disk-space-guard.sh"
    disk_guard = disk_guard_path.read_text(encoding="utf-8") if disk_guard_path.exists() else ""
    external_backup_path = ROOT / "scripts/llmgw-prod-external-backup.sh"
    external_backup = external_backup_path.read_text(encoding="utf-8") if external_backup_path.exists() else ""
    chat_bootstrap_path = ROOT / "scripts/llmgw-prod-chat-pool-bootstrap.sh"
    chat_bootstrap = chat_bootstrap_path.read_text(encoding="utf-8") if chat_bootstrap_path.exists() else ""
    chat_bootstrap_js_path = ROOT / "scripts/llmgw-prod-chat-pool-bootstrap.js"
    chat_bootstrap_js = chat_bootstrap_js_path.read_text(encoding="utf-8") if chat_bootstrap_js_path.exists() else ""
    asr_bootstrap_path = ROOT / "scripts/llmgw-prod-asr-pool-bootstrap.sh"
    asr_bootstrap = asr_bootstrap_path.read_text(encoding="utf-8") if asr_bootstrap_path.exists() else ""
    asr_bootstrap_js_path = ROOT / "scripts/llmgw-prod-asr-pool-bootstrap.js"
    asr_bootstrap_js = asr_bootstrap_js_path.read_text(encoding="utf-8") if asr_bootstrap_js_path.exists() else ""
    video_bootstrap_path = ROOT / "scripts/llmgw-prod-video-caller-bootstrap.sh"
    video_bootstrap = video_bootstrap_path.read_text(encoding="utf-8") if video_bootstrap_path.exists() else ""
    video_bootstrap_js_path = ROOT / "scripts/llmgw-prod-video-caller-bootstrap.js"
    video_bootstrap_js = video_bootstrap_js_path.read_text(encoding="utf-8") if video_bootstrap_js_path.exists() else ""
    video_exchange_bootstrap_path = ROOT / "scripts/llmgw-prod-video-exchange-bootstrap.sh"
    video_exchange_bootstrap = video_exchange_bootstrap_path.read_text(encoding="utf-8") if video_exchange_bootstrap_path.exists() else ""
    video_exchange_bootstrap_js_path = ROOT / "scripts/llmgw-prod-video-exchange-bootstrap.js"
    video_exchange_bootstrap_js = video_exchange_bootstrap_js_path.read_text(encoding="utf-8") if video_exchange_bootstrap_js_path.exists() else ""
    video_canary_path = ROOT / "scripts/llmgw-video-exchange-canary.py"
    video_canary = video_canary_path.read_text(encoding="utf-8") if video_canary_path.exists() else ""
    asr_http_canary_path = ROOT / "scripts/llmgw-asr-http-canary.py"
    asr_http_canary = asr_http_canary_path.read_text(encoding="utf-8") if asr_http_canary_path.exists() else ""
    provider_audit_path = ROOT / "scripts/llmgw-prod-provider-config-audit.py"
    provider_audit = provider_audit_path.read_text(encoding="utf-8") if provider_audit_path.exists() else ""
    ok, detail = _contains_all(
        release_gate,
        [
            "--since-hours",
            "--min-coverage-hours",
            "--require-kind",
            "--require-app-kind",
            "--shadow-release-commit",
            "--health-samples",
            "--json-out",
            "critical mismatch",
            "httpFail",
            "coverageHours",
            "shadowReleaseCommit",
        ],
    )
    checks.append(_check("release_gate_supports_required_shadow_and_health_gates", ok, detail))

    ok, detail = _contains_all(
        shadow_coverage,
        [
            "LLM Gateway shadow coverage",
            "/shadow-comparisons",
            "--app-caller",
            "--kind",
            "--min-per-cell",
            "--min-coverage-hours",
            "--release-commit",
            "LLMGW_HTTP_APP_CALLER_ALLOWLIST",
            "critical",
            "httpFail",
            "coverageHours",
            "LLMGW_SHADOW_COVERAGE_JSON_OUT",
            "LLMGW_SHADOW_COVERAGE_REPORT_MD",
            "releaseCommit",
        ],
    )
    checks.append(_check("shadow_coverage_report_available", ok, detail))

    shadow_watch = _read(".github/workflows/llmgw-shadow-watch.yml")
    ok, detail = _contains_all(
        shadow_watch,
        [
            "cron: \"17 */6 * * *\"",
            "LLMGW_PROD_GATE_BASE",
            "LLMGW_PROD_GATE_KEY",
            "expect_commit",
            "INPUT_EXPECT_COMMIT",
            "missing production expected commit",
            "--expect-commit \"$expect_commit\"",
            "--run-serving-probe",
            "--run-shadow-coverage",
            "--require-release-gate",
            "--min-coverage-hours \"$MIN_COVERAGE_HOURS\"",
            "WATCH_APP_CALLERS",
            "WATCH_REQUIRED_APP_KINDS",
            "visual-agent.image-gen.generate::generation",
            "visual-agent.image-gen.generate::generation:raw:${MIN_PER_CELL}",
            "video-agent.v2d.transcribe::asr",
            "video-agent.v2d.transcribe::asr:raw:${MIN_PER_CELL}",
            "video-agent.video-to-text::asr",
            "video-agent.video-to-text::asr:raw:${MIN_PER_CELL}",
            "actions/upload-artifact@v4",
        ],
    )
    checks.append(_check("shadow_watch_workflow_runs_scheduled_evidence_gate", ok, detail))

    ok, detail = _contains_all(
        prod_preflight_workflow,
        [
            "LLM Gateway Production Preflight",
            "workflow_dispatch:",
            "mode:",
            "start",
            "completion",
            "PRD_AGENT_PROD_BASE",
            "PRD_AGENT_PROD_API_KEY",
            "LLMGW_PROD_GATE_BASE",
            "LLMGW_PROD_GATE_KEY",
            "LLMGW_PROD_EXPECT_COMMIT",
            "rollout_evidence_run_id",
            "actions: read",
            "logs:read access",
            "actions/download-artifact@v4",
            "Restore rollout evidence for completion",
            "llmgw-prod-stage-{0}",
            ".llmgw-release-evidence/",
            "default branch",
            "completion mode requires rollout_evidence_run_id",
            "completion mode could not find .llmgw-release-evidence/rollout-ledger.jsonl after artifact restore",
            "scripts/llmgw-prod-preflight.py",
            "--mode \"$mode\"",
            "--map-base \"$map_base\"",
            "--gw-base \"$gw_base\"",
            "--expect-commit \"$expect_commit\"",
            "--rollout-target-stage \"$ROLLOUT_TARGET_STAGE\"",
            "--rollout-min-observation-hours \"$ROLLOUT_MIN_OBSERVATION_HOURS\"",
            "artifacts/llmgw-prod-preflight/prod-preflight.json",
            "actions/upload-artifact@v4",
        ],
    )
    leaks_preflight_secret = "echo \"$PRD_AGENT_API_KEY\"" in prod_preflight_workflow or "echo \"$LLMGW_GATE_KEY\"" in prod_preflight_workflow
    checks.append(_check(
        "prod_preflight_workflow_uploads_redacted_start_completion_report",
        ok and not leaks_preflight_secret,
        f"{detail}; leaksPreflightSecret={leaks_preflight_secret}",
    ))

    ok, detail = _contains_all(
        prod_stage_workflow,
        [
            "LLM Gateway Production Stage",
            "workflow_dispatch:",
            "stage:",
            "shadow-start",
            "rollback-rehearsal",
            "canary-intent-text",
            "canary-chat",
            "canary-streaming",
            "canary-vision",
            "canary-image",
            "canary-video-asr",
            "http-full",
            "rollback-inproc",
            "execute:",
            "default: false",
            "runner_labels_json",
            "[\\\"self-hosted\\\",\\\"prd-agent-prod\\\"]",
            "environment: production",
            "PRD_AGENT_PROD_BASE",
            "PRD_AGENT_PROD_API_KEY",
            "LLMGW_PROD_GATE_BASE",
            "LLMGW_PROD_GATE_KEY",
            "PRD_AGENT_PROD_GITHUB_TOKEN",
            "rollout_evidence_run_id",
            "actions: read",
            "logs:read access",
            "actions/download-artifact@v4",
            "Restore previous rollout evidence",
            "llmgw-prod-stage-{0}",
            "default branch",
            "scripts/llmgw-prod-stage.sh",
            "stage $stage requires rollout_evidence_run_id so prior rollout ledger evidence is restored",
            "--stage \"$stage\"",
            "--commit \"$commit\"",
            "--execute",
            "--dry-run",
            "--repo \"$repo\"",
            "--sample-percent \"$sample_percent\"",
            "--min-observation-hours \"$min_observation_hours\"",
            "--main-ref \"$main_ref\"",
            "--evidence-dir \".llmgw-release-evidence\"",
            "--allow-out-of-order-reason \"$allow_out_of_order_reason\"",
            "scripts/llmgw-rollout-ledger.py audit",
            "--require-target-success",
            "stage-audit.json",
            "stage-audit.md",
            "actions/upload-artifact@v4",
            ".llmgw-release-evidence/",
        ],
    )
    leaks_stage_secret = "echo \"$PRD_AGENT_API_KEY\"" in prod_stage_workflow or "echo \"$LLMGW_GATE_KEY\"" in prod_stage_workflow
    checks.append(_check(
        "prod_stage_workflow_runs_on_production_runner_and_uploads_rollout_evidence",
        ok and not leaks_stage_secret,
        f"{detail}; leaksStageSecret={leaks_stage_secret}",
    ))

    ok, detail = _contains_all(
        serving_probe,
        [
            "LLM Gateway serving probe",
            "/healthz",
            "--protected-path",
            "expectedCommit",
            "healthSamples",
            "protectedChecks",
            "commit drift",
            "should reject missing key with 401",
            "LLMGW_SERVING_PROBE_JSON_OUT",
            "LLMGW_SERVING_PROBE_REPORT_MD",
        ],
    )
    checks.append(_check("serving_probe_available", ok, detail))

    ok, detail = _contains_all(
        disk_guard,
        [
            "df -Pm",
            "available_mb",
            "min_free_mb",
            "nearest existing parent",
            "requires at least",
        ],
    )
    disk_guard_executable = bool(disk_guard_path.exists() and (disk_guard_path.stat().st_mode & stat.S_IXUSR))
    disk_guard_destructive = any(item in disk_guard for item in ["rm -", "deleteMany", "dropDatabase", "docker volume rm", "down -v"])
    checks.append(_check(
        "disk_space_guard_available_for_prod_rollout",
        ok and disk_guard_executable and not disk_guard_destructive,
        f"{detail}; executable={disk_guard_executable}; destructive={disk_guard_destructive}",
    ))

    ok, detail = _contains_all(
        external_backup,
        [
            "LLM Gateway production external backup",
            "LLMGW_EXTERNAL_BACKUP_HOST",
            "LLMGW_EXTERNAL_BACKUP_REMOTE_REPO",
            "LLMGW_EXTERNAL_BACKUP_MODE",
            "LLMGW_EXTERNAL_BACKUP_DATABASES:-prdagent llm_gateway",
            "LLMGW_EXTERNAL_BACKUP_COLLECTIONS",
            "prdagent.model_groups",
            "llm_gateway.*",
            "--collection '$collection'",
            "mongodump --db '$db' --archive",
            "| gzip > \"$backup_dir/$db.archive.gz\"",
            "gzip -t \"$backup_dir/$db.archive.gz\"",
            "SHA256SUMS",
            "env.snapshot.redacted",
            "LLMGW_EXTERNAL_BACKUP_INCLUDE_SECRETS",
        ],
    )
    external_backup_executable = bool(external_backup_path.exists() and (external_backup_path.stat().st_mode & stat.S_IXUSR))
    external_backup_destructive = any(item in external_backup for item in ["rm -", "deleteMany", "dropDatabase", "docker volume rm", "down -v"])
    checks.append(_check(
        "prod_external_backup_streams_mongo_without_remote_archives",
        ok and external_backup_executable and not external_backup_destructive,
        f"{detail}; executable={external_backup_executable}; destructive={external_backup_destructive}",
    ))

    ok, detail = _contains_all(
        chat_bootstrap + "\n" + chat_bootstrap_js,
        [
            "LLMGW_CHAT_BOOTSTRAP_DRY_RUN:-1",
            "mongodump --db \"$mongo_db\" --archive",
            "llmgw-disk-space-guard.sh",
            "LLMGW_CHAT_BOOTSTRAP_MIN_FREE_MB:-6144",
            "llmgw-prod-before-chat-pool-bootstrap",
            "LLMGW_CHAT_BOOTSTRAP_MODEL_NAME",
            "LLMGW_CHAT_BOOTSTRAP_PLATFORM_ID",
            "LLMGW_CHAT_BOOTSTRAP_POOL_ID",
            "LLMGW_CHAT_BOOTSTRAP_TARGET_CALLERS",
            "LLMGW_CHAT_BOOTSTRAP_BIND_CALLERS",
            "deepseek-ai/DeepSeek-V4-Flash",
            "report-agent.generate::chat",
            "enabled LLMModel not found",
            "target chat pool missing or not chat",
            "ModelGroupIds",
            "ModelGroupId",
        ],
    )
    chat_bootstrap_executable = bool(chat_bootstrap_path.exists() and (chat_bootstrap_path.stat().st_mode & stat.S_IXUSR))
    chat_bootstrap_destructive = any(item in chat_bootstrap + chat_bootstrap_js for item in ["dropDatabase", "deleteMany", "remove(", "docker volume rm", "down -v"])
    checks.append(_check(
        "prod_chat_pool_bootstrap_is_backed_up_and_dry_run_first",
        ok and chat_bootstrap_executable and not chat_bootstrap_destructive,
        f"{detail}; executable={chat_bootstrap_executable}; destructive={chat_bootstrap_destructive}",
    ))

    ok, detail = _contains_all(
        asr_bootstrap + "\n" + asr_bootstrap_js,
        [
            "LLMGW_ASR_BOOTSTRAP_DRY_RUN:-1",
            "mongodump --db \"$mongo_db\" --archive",
            "llmgw-disk-space-guard.sh",
            "LLMGW_ASR_BOOTSTRAP_MIN_FREE_MB:-6144",
            "llmgw-prod-before-asr-pool-bootstrap",
            "LLMGW_ASR_BOOTSTRAP_MODE",
            "LLMGW_ASR_BOOTSTRAP_BIND_CALLERS",
            "LLMGW_ASR_BOOTSTRAP_DEFAULT_FOR_TYPE",
            "caller binding skipped",
            "asr_doubao_bigmodel_pool",
            "doubao-asr-bigmodel",
            "asr_doubao_stream_pool",
            "doubao-asr-stream",
            "LLMGW_ASR_BOOTSTRAP_DESCRIPTION",
            "document-store.subtitle::asr",
            "transcript-agent.transcribe::asr",
            "video-agent.v2d.transcribe::asr",
            "video-agent.video-to-text::asr",
            "ModelGroupIds",
            "ModelGroupId",
        ],
    )
    asr_bootstrap_executable = bool(asr_bootstrap_path.exists() and (asr_bootstrap_path.stat().st_mode & stat.S_IXUSR))
    asr_bootstrap_destructive = any(item in asr_bootstrap + asr_bootstrap_js for item in ["dropDatabase", "deleteMany", "remove(", "docker volume rm", "down -v"])
    checks.append(_check(
        "prod_asr_pool_bootstrap_is_backed_up_and_dry_run_first",
        ok and asr_bootstrap_executable and not asr_bootstrap_destructive,
        f"{detail}; executable={asr_bootstrap_executable}; destructive={asr_bootstrap_destructive}",
    ))

    ok, detail = _contains_all(
        video_bootstrap + "\n" + video_bootstrap_js,
        [
            "LLMGW_VIDEO_BOOTSTRAP_DRY_RUN:-1",
            "mongodump --db \"$mongo_db\" --archive",
            "llmgw-disk-space-guard.sh",
            "LLMGW_VIDEO_BOOTSTRAP_MIN_FREE_MB:-6144",
            "llmgw-prod-before-video-caller-bootstrap",
            "LLMGW_VIDEO_BOOTSTRAP_SOURCE_CALLER",
            "LLMGW_VIDEO_BOOTSTRAP_TARGET_CALLERS",
            "video-agent.videogen::video-gen",
            "visual-agent.videogen::video-gen",
            "source video appCaller missing",
            "source video appCaller has no video-gen ModelGroupIds",
            "source video appCaller references missing video-gen pools",
            "target video appCallers missing",
            "ModelGroupIds: poolIds",
            "ModelGroupId: poolIds[0]",
        ],
    )
    video_bootstrap_executable = bool(video_bootstrap_path.exists() and (video_bootstrap_path.stat().st_mode & stat.S_IXUSR))
    video_bootstrap_destructive = any(item in video_bootstrap + video_bootstrap_js for item in ["dropDatabase", "deleteMany", "remove(", "docker volume rm", "down -v"])
    checks.append(_check(
        "prod_video_caller_bootstrap_is_backed_up_and_dry_run_first",
        ok and video_bootstrap_executable and not video_bootstrap_destructive,
        f"{detail}; executable={video_bootstrap_executable}; destructive={video_bootstrap_destructive}",
    ))

    ok, detail = _contains_all(
        video_exchange_bootstrap + "\n" + video_exchange_bootstrap_js,
        [
            "LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_DRY_RUN:-1",
            "mongodump --db \"$mongo_db\" --archive",
            "llmgw-disk-space-guard.sh",
            "LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_MIN_FREE_MB:-6144",
            "llmgw-prod-before-video-exchange-bootstrap",
            "LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_EXCHANGE_ID",
            "LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_POOL_ID",
            "LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_RESET_HEALTH",
            "LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_BIND_CALLERS",
            "video_seedance_2_0_fast_pool",
            "doubao-seedance-2-0-fast-260128",
            "volcengine-video",
            "contents/generations/tasks",
            "llmplatforms.ApiKeyEncrypted copied to model_exchanges.TargetApiKeyEncrypted",
            "source Volcengine platform has no encrypted key",
            "video-agent.videogen::video-gen",
            "visual-agent.videogen::video-gen",
            "ModelGroupIds",
            "ModelGroupId",
            "HealthStatus: nextHealthStatus",
        ],
    )
    video_exchange_bootstrap_executable = bool(video_exchange_bootstrap_path.exists() and (video_exchange_bootstrap_path.stat().st_mode & stat.S_IXUSR))
    video_exchange_bootstrap_destructive = any(item in video_exchange_bootstrap + video_exchange_bootstrap_js for item in ["dropDatabase", "deleteMany", "remove(", "docker volume rm", "down -v"])
    checks.append(_check(
        "prod_video_exchange_bootstrap_is_backed_up_and_dry_run_first",
        ok and video_exchange_bootstrap_executable and not video_exchange_bootstrap_destructive,
        f"{detail}; executable={video_exchange_bootstrap_executable}; destructive={video_exchange_bootstrap_destructive}",
    ))

    ok, detail = _contains_all(
        video_canary,
        [
            "LLM Gateway Volcengine video exchange canary",
            "/raw",
            "video-agent.videogen::video-gen",
            "visual-agent.videogen::video-gen",
            "DEFAULT_APP_CALLERS",
            "canaries",
            "doubao-seedance-2-0-fast-260128",
            "LLMGW_VIDEO_CANARY_JSON_OUT",
            "--poll-status",
            "--download-result",
            "video status did not complete",
            "video result download probe failed",
            "ModelNotOpen",
            "has not activated the requested video model",
            "externalBlockers",
            "video_model_not_open",
            "video_channel_unavailable",
            "video_authorization_failed",
            "_external_blocker_from_failure",
            "return 0 if report[\"verdict\"] == \"pass\" else 1",
        ],
    )
    video_canary_executable = bool(video_canary_path.exists() and (video_canary_path.stat().st_mode & stat.S_IXUSR))
    video_canary_destructive = any(item in video_canary for item in ["updateOne", "deleteMany", "dropDatabase", "mongorestore", "docker volume rm", "down -v"])
    checks.append(_check(
        "video_exchange_canary_records_submit_evidence_without_mutating_config",
        ok and video_canary_executable and not video_canary_destructive,
        f"{detail}; executable={video_canary_executable}; destructive={video_canary_destructive}",
    ))

    ok, detail = _contains_all(
        asr_http_canary,
        [
            "LLM Gateway ASR HTTP canary",
            "/api/ops/llmgw/canary/asr",
            "document-store.subtitle::asr",
            "transcript-agent.transcribe::asr",
            "video-agent.v2d.transcribe::asr",
            "video-agent.video-to-text::asr",
            "DEFAULT_APP_CALLERS",
            "canaries",
            "X-Gateway-Key",
            "MultipartFileRefs",
            "MAP API failed to upload ASR canary audio to object storage",
            "llmgw-serve could not rehydrate ASR MultipartFileRefs from shared object storage",
            "ASR upstream rejected credential",
            "ASR model pool or upstream provider has no available channel",
            "externalBlockers",
            "asr_credential_rejected",
            "asr_channel_unavailable",
            "asr_authorization_failed",
            "_external_blocker_from_failure",
            "return 0 if report[\"verdict\"] == \"pass\" else 1",
        ],
    )
    asr_http_canary_executable = bool(asr_http_canary_path.exists() and (asr_http_canary_path.stat().st_mode & stat.S_IXUSR))
    asr_http_canary_destructive = any(item in asr_http_canary for item in ["updateOne", "deleteMany", "dropDatabase", "mongorestore", "docker volume rm", "down -v"])
    checks.append(_check(
        "asr_http_canary_proves_multipart_refs_without_mutating_config",
        ok and asr_http_canary_executable and not asr_http_canary_destructive,
        f"{detail}; executable={asr_http_canary_executable}; destructive={asr_http_canary_destructive}",
    ))

    ok, detail = _contains_all(
        provider_audit,
        [
            "LLM Gateway production provider config audit",
            "document-store.subtitle::asr",
            "transcript-agent.transcribe::asr",
            "video-agent.v2d.transcribe::asr",
            "video-agent.video-to-text::asr",
            "video-agent.videogen::video-gen",
            "visual-agent.videogen::video-gen",
            "asr_doubao_bigmodel_pool",
            "doubao-asr-bigmodel",
            "DEFAULT_ASR_POOL_ID",
            "DEFAULT_ASR_TRANSFORMER",
            "doubao-asr-stream",
            "asr-pool-id",
            "LLMGW_PROVIDER_AUDIT_ASR_POOL_ID",
            "asr-transformer",
            "LLMGW_PROVIDER_AUDIT_ASR_TRANSFORMER",
            "TargetApiKeyEncrypted",
            "llmplatforms",
            "model_exchanges",
            "llmrequestlogs",
            "LLMGW_PROVIDER_AUDIT_GATEWAY_DB",
            "LLMGW_PROVIDER_AUDIT_RECENT_LOG_HOURS",
            "recentGatewayLogs",
            "skip-gateway-logs",
            "ApiKeyEncrypted",
            "apiKeyShape",
            "volcengine-video",
            "contents/generations/tasks",
            "video model exchange key cannot be decrypted",
            "video model exchange does not declare model",
            "videoClassifications",
            "ASR upstream has no available channels",
            "Video upstream has no available channels",
            "Volcengine Ark account has not activated the video model",
            "OpenRouter /videos requests",
            "Volcengine Ark OpenAI chat base URL",
            "dedicated Volcengine video adapter",
            "targetApiKeyEncryptedLength",
            "targetApiKeyShape",
            "containsPipe",
            "looksUuidOnly",
            "Invalid X-Api-Key",
            "ASR upstream rejected credential",
            "externalBlockers",
            "asr_credential_rejected",
            "asr_authorization_failed",
            "asr_channel_unavailable",
            "video_channel_unavailable",
            "video_model_not_open",
            "--self-test",
            "_self_test_report",
            "requiredCodes",
            "missingCodes",
            "asrClassifications",
            "asrDiagnostic",
            "uninitialized diagnostic",
            "deploy the diagnostic build and rerun ASR seed",
            "seed-evidence-json",
            "no Healthy video-gen model",
        ],
    )
    provider_audit_executable = bool(provider_audit_path.exists() and (provider_audit_path.stat().st_mode & stat.S_IXUSR))
    provider_audit_destructive = any(item in provider_audit for item in ["updateOne", "insertOne", "deleteMany", "dropDatabase", "remove(", "docker volume rm", "down -v"])
    checks.append(_check(
        "prod_provider_config_audit_is_read_only_and_secret_safe",
        ok and provider_audit_executable and not provider_audit_destructive,
        f"{detail}; executable={provider_audit_executable}; destructive={provider_audit_destructive}",
    ))

    ok, detail = _contains_all(
        prod_stage,
        [
            "LLM Gateway production stage runner",
            "shadow-start",
            "canary-intent-text",
            "canary-chat",
            "canary-streaming",
            "canary-vision",
            "canary-image",
            "canary-video-asr",
            "rollback-rehearsal",
            "http-full",
            "rollback-inproc",
            "LLMGW_GATE_KEY, GW_KEY, or LLMGW_SERVE_KEY",
            "execute=0",
            "--execute",
            "LLMGW_GATE_BASE",
            "LLMGW_STAGE_MIN_OBSERVATION_HOURS",
            "--min-observation-hours",
            "LLMGW_RELEASE_MAIN_REF",
            "--main-ref",
            "validate_main_ancestry",
            "git merge-base --is-ancestor",
            "release commit does not include latest main",
            "LLMGW_STAGE_ALLOW_SCRIPT_TREE_MISMATCH",
            "validate_release_script_tree",
            "critical_paths",
            "git show \"$commit:<critical rollout scripts>\" | cmp local files",
            "local rollout scripts must match --commit",
            "script differs from release commit",
            "LLM Gateway release script tree: OK",
            "LLMGW_ALLOW_OUT_OF_ORDER_REASON",
            "--allow-out-of-order-reason",
            "requires --allow-out-of-order-reason",
            "allowOutOfOrderReason",
            "minObservationHours",
            "PRD_AGENT_REQUIRE_FAST_INTENT",
            "LLMGW_PROD_STAGE_ACTIVE=1",
            "LLMGW_PROD_STAGE=\"$stage\"",
            "LLMGW_GATE_JSON_OUT",
            "LLMGW_GATE_REPORT_MD",
            "rollout-ledger.jsonl",
            "--allow-out-of-order",
            "validate_ledger_order",
            "append_ledger_entry success",
            "record_failed_stage_on_exit",
            "append_ledger_entry failed",
            "LLM Gateway production stage failed; appending failed rollout ledger entry.",
            "append_ledger_entry rollback",
            "rollout_ledger_status=\"rollback\"",
            "release-gate.json",
            "prod-preflight.json",
            "serving-probe.json",
            "gw-smoke.json",
            "upstream-readiness.json",
            "provider-audit.json",
            "video-canary.json",
            "asr-http-canary.json",
            "LLMGW_STAGE_RUN_UPSTREAM_READINESS",
            "run_upstream_readiness_evidence",
            "scripts/llmgw-upstream-readiness.py",
            "LLMGW_STAGE_RUN_PROVIDER_AUDIT",
            "run_provider_audit_evidence",
            "scripts/llmgw-prod-provider-config-audit.py",
            "LLMGW_STAGE_RUN_VIDEO_CANARY",
            "run_video_canary_evidence",
            "scripts/llmgw-video-exchange-canary.py",
            "LLMGW_VIDEO_CANARY_JSON_OUT",
            "LLMGW_STAGE_RUN_ASR_HTTP_CANARY",
            "run_asr_http_canary_evidence",
            "scripts/llmgw-asr-http-canary.py",
            "PRD_AGENT_BASE",
            "LLMGW_ASR_CANARY_JSON_OUT",
            "LLMGW_STAGE_MIN_FREE_MB",
            "LLMGW_STAGE_DISK_GUARD_PATH",
            "run_stage_disk_guard",
            "scripts/llmgw-disk-space-guard.sh",
            "providerAuditRequired",
            "LLMGW_STAGE_AUTO_RESTORE_SHADOW_ON_FAILURE",
            "scripts/llmgw-restore-shadow-safe.sh",
            "run_prod_preflight",
            "scripts/llmgw-prod-preflight.py --mode start",
            "--prod-preflight-json \"$prod_preflight_json\"",
            "--upstream-readiness-json \"$upstream_readiness_json\"",
            "--upstream-readiness-required \"$run_upstream_readiness\"",
            "--provider-audit-json \"$provider_audit_json\"",
            "--provider-audit-required \"$run_provider_audit\"",
            "--video-canary-json \"$video_canary_json\"",
            "--video-canary-required \"$run_video_canary\"",
            "--asr-http-canary-json \"$asr_http_canary_json\"",
            "--asr-http-canary-required \"$run_asr_http_canary\"",
            "videoCanaryJson",
            "videoCanaryRequired",
            "asrHttpCanaryJson",
            "asrHttpCanaryRequired",
            "stage-report",
            "GW_SMOKE_JSON_OUT",
            "LLMGW_SERVING_PROBE_JSON_OUT",
            "scripts/llmgw-rollout-ledger.py validate",
            "scripts/llmgw-rollout-ledger.py append",
            "report-agent.generate::chat,prd-agent-desktop.chat.sendmessage::chat,open-platform-agent.proxy::chat",
            "visual-agent.image-gen.generate::generation,visual-agent.image.text2img::generation,visual-agent.image.img2img::generation",
            "video-agent.videogen::video-gen,visual-agent.videogen::video-gen,document-store.subtitle::asr,transcript-agent.transcribe::asr,video-agent.v2d.transcribe::asr,video-agent.video-to-text::asr",
            "./fast.sh --commit \"$commit\"",
            "./exec_dep.sh --commit \"$commit\"",
            "scripts/llmgw-rollback-inproc.sh",
            "LLMGW_ROLLBACK_DRY_RUN=1 scripts/llmgw-rollback-inproc.sh",
        ],
    )
    executable = bool(prod_stage_path.stat().st_mode & stat.S_IXUSR)
    ledger_executable = bool(rollout_ledger_path.exists() and (rollout_ledger_path.stat().st_mode & stat.S_IXUSR))
    preflight_executable = bool(prod_preflight_path.exists() and (prod_preflight_path.stat().st_mode & stat.S_IXUSR))
    upstream_executable = bool(upstream_readiness_path.exists() and (upstream_readiness_path.stat().st_mode & stat.S_IXUSR))
    preflight_idx = prod_stage.find("run_prod_preflight\n\nrun_upstream_readiness_evidence")
    upstream_idx = prod_stage.find("run_upstream_readiness_evidence\n\nrun_provider_audit_evidence")
    provider_idx = prod_stage.find("run_provider_audit_evidence\n\nif [ -n \"$repo\" ]")
    fast_idx = prod_stage.find("run_or_print ./fast.sh")
    video_canary_idx = prod_stage.find("run_video_canary_evidence\n\nrun_asr_http_canary_evidence")
    asr_canary_idx = prod_stage.find("run_asr_http_canary_evidence\n\nrun_shadow_seed_evidence")
    upstream_before_deploy = (
        preflight_idx >= 0
        and upstream_idx >= 0
        and provider_idx >= 0
        and video_canary_idx >= 0
        and asr_canary_idx >= 0
        and preflight_idx < upstream_idx < provider_idx < fast_idx < video_canary_idx < asr_canary_idx
    )
    ledger_ok, ledger_detail = _contains_all(
        rollout_ledger,
        [
            "LLM Gateway rollout ledger",
            "STAGES = [",
            "ROLLBACK_REHEARSAL_STAGE = \"rollback-rehearsal\"",
            "_stage_requires_rehearsal",
            "shadow-start",
            "canary-video-asr",
            "http-full",
            "missing_success",
            "requires rollback rehearsal success for the same commit",
            "min_observation_hours",
            "rollout stage observation window not satisfied",
            "_latest_success_evidence_failures",
            "_existing_success_evidence_failures",
            "rollout stage prior evidence validation failed",
            "prior stage evidence invalid before rollout",
            "existing prior stage evidence invalid before out-of-order rollout",
            "allow-out-of-order",
            "allow-out-of-order-reason",
            "\"allowOutOfOrder\": _bool_flag(args.allow_out_of_order)",
            "\"allowOutOfOrderReason\": args.allow_out_of_order_reason.strip()",
            "allowOutOfOrder missing reason",
            "ensure_ascii=False",
            "\"status\": args.status",
            "\"evidenceJson\": args.evidence_json",
            "\"prodPreflightJson\": args.prod_preflight_json",
            "\"upstreamReadinessJson\": args.upstream_readiness_json",
            "\"upstreamReadinessRequired\": _bool_flag(args.upstream_readiness_required)",
            "_require_upstream_readiness",
            "upstream readiness evidence",
            "\"providerAuditJson\": args.provider_audit_json",
            "\"providerAuditRequired\": _bool_flag(args.provider_audit_required)",
            "_require_provider_audit",
            "provider config audit evidence",
            "\"providerAuditExternalBlockers\": provider_external_blockers",
            "_provider_external_blockers",
            "contains external blockers",
            "providerExternalBlockers",
            "_canary_external_blockers",
            "_merge_blockers",
            "\"externalBlockers\": all_external_blockers",
            "\"videoCanaryJson\": args.video_canary_json",
            "\"videoCanaryRequired\": _bool_flag(args.video_canary_required)",
            "\"videoCanaryExternalBlockers\": video_canary_external_blockers",
            "_require_video_canary",
            "video canary evidence",
            "\"asrHttpCanaryJson\": args.asr_http_canary_json",
            "\"asrHttpCanaryRequired\": _bool_flag(args.asr_http_canary_required)",
            "\"asrHttpCanaryExternalBlockers\": asr_http_canary_external_blockers",
            "_require_asr_http_canary",
            "ASR HTTP canary evidence",
            "_require_prod_preflight_for_commit",
            "production preflight evidence",
            "\"servingProbeJson\": args.serving_probe_json",
            "\"smokeJson\": args.smoke_json",
            "\"rollbackRehearsal\": args.stage == ROLLBACK_REHEARSAL_STAGE",
            "\"releaseMainRef\": args.main_ref",
            "\"releaseMainSha\": args.main_sha.lower()",
            "\"minStageObservationHours\": args.min_stage_observation_hours",
            "missing releaseMainSha",
            "_require_pass_json",
            "_require_smoke_for_commit",
            "_require_stage_evidence_matches_entry",
            "missing expectedCommit for same-commit evidence",
            "releaseMainSha mismatch",
            "D-layer smoke healthCommit mismatch",
            "stage-report",
            "audit",
            "ROLLOUT_SEQUENCE",
            "requireTargetSuccess",
            "LLM Gateway rollout ledger audit",
        ],
    )
    preflight_ok, preflight_detail = _contains_all(
        prod_preflight,
        [
            "LLM Gateway production preflight",
            "--mode",
            "start",
            "completion",
            "map_logs_scope",
            "map_direct_transport_absent",
            "LLMGW_PROD_PREFLIGHT_DIRECT_TRANSPORT_SINCE_HOURS",
            "LLMGW_PROD_PREFLIGHT_DIRECT_TRANSPORT_PAGE_SIZE",
            "LLMGW_PROD_PREFLIGHT_DIRECT_TRANSPORT_MAX_PAGES",
            "directTransportSinceHours",
            "gatewayTransport",
            "\"direct\"",
            "gateway_protected_requires_key",
            "rollout_ledger_start_ready",
            "rollout_ledger_completion",
            "PRD_AGENT_API_KEY",
            "LLMGW_GATE_BASE",
            "LLMGW_GATE_KEY",
            "LLMGW_SERVE_KEY",
            "scripts/llmgw-rollout-ledger.py",
            "--require-target-success",
            "\"expectCommit\"",
        ],
    )
    upstream_ok, upstream_detail = _contains_all(
        upstream_readiness,
        [
            "LLM Gateway upstream resolution readiness gate",
            "DEFAULT_REQUIREMENTS",
            "video-agent.videogen::video-gen=video-gen",
            "visual-agent.videogen::video-gen=video-gen",
            "document-store.subtitle::asr=asr",
            "transcript-agent.transcribe::asr=asr",
            "video-agent.v2d.transcribe::asr=asr",
            "video-agent.video-to-text::asr=asr",
            "/resolve",
            "X-Gateway-Key",
            "apiKeyPresent",
            "--allow-legacy",
            "--allow-missing-api-key",
            "--require-api-key",
            "--fail-on-degraded",
            "--json-out",
            "--report-md",
            "\"verdict\": \"pass\" if not failures else \"fail\"",
        ],
    )
    leaks_key_arg = "--key" in prod_stage or "--gateway-key" in prod_stage or "--key" in rollout_ledger
    checks.append(_check(
        "prod_stage_runner_sequences_shadow_canary_http_and_rollback",
        ok and ledger_ok and preflight_ok and upstream_ok and upstream_before_deploy and executable and ledger_executable and preflight_executable and upstream_executable and not leaks_key_arg,
        f"{detail}; ledger={ledger_detail}; preflight={preflight_detail}; upstream={upstream_detail}; upstreamBeforeDeploy={upstream_before_deploy}; executable={executable}; ledgerExecutable={ledger_executable}; preflightExecutable={preflight_executable}; upstreamExecutable={upstream_executable}; leaksKeyArg={leaks_key_arg}",
    ))

    fast = _read("fast.sh")
    ok, detail = _contains_all(
        fast,
        [
            "PRD_AGENT_RELEASE_INTENT_FILE",
            ".prd-agent-release-intent.env",
            "write_release_intent",
            "RELEASE_TAG=%s",
            "RELEASE_REF_TYPE=%s",
            "PRD_AGENT_LLMGW_SERVE_IMAGE=%s",
            "PRD_AGENT_LLMGW_WEB_IMAGE=%s",
            "Release intent written:",
        ],
    )
    checks.append(_check("fast_writes_same_commit_release_intent", ok, detail))

    exec_dep = _read("exec_dep.sh")
    ok, detail = _contains_all(
        exec_dep,
        [
            "run_llmgw_release_gate_if_needed",
            "run_llmgw_post_deploy_verification_if_needed",
            "LLMGW_POST_DEPLOY_VERIFY_NEEDED",
            "check_fast_release_intent",
            "PRD_AGENT_RELEASE_INTENT_FILE",
            "PRD_AGENT_REQUIRE_FAST_INTENT",
            "PRD_AGENT_IGNORE_FAST_INTENT",
            "fast.sh / exec_dep.sh release ref mismatch",
            "guard_llmgw_prod_stage_context_if_needed",
            "check_intent_image_match PRD_AGENT_API_IMAGE",
            "check_intent_image_match PRD_AGENT_LLMGW_IMAGE",
            "check_intent_image_match PRD_AGENT_LLMGW_SERVE_IMAGE",
            "check_intent_image_match PRD_AGENT_LLMGW_WEB_IMAGE",
            "fast.sh / exec_dep.sh image mismatch",
            "Release intent: matched fast.sh warmup",
            "LLMGW_HTTP_APP_CALLER_ALLOWLIST",
            "LLMGW_CANARY_STAGE",
            "canary_allowed_app_callers=\"report-agent.generate::chat prd-agent-desktop.chat.sendmessage::chat open-platform-agent.proxy::chat\"",
            "canary_allowed_app_callers=\"visual-agent.image-gen.generate::generation visual-agent.image.text2img::generation visual-agent.image.img2img::generation\"",
            "ERROR: LLM Gateway canary 发布设置了 LLMGW_HTTP_APP_CALLER_ALLOWLIST，但未设置 LLMGW_CANARY_STAGE。",
            "LLMGW_PROD_STAGE_ACTIVE",
            "LLMGW_PROD_STAGE",
            "必须通过 scripts/llmgw-prod-stage.sh 执行",
            "绕过 rollout ledger、生产预检和阶段顺序审计",
            "ERROR: LLM Gateway canary 阶段 $canary_stage 不允许入口 $app_trimmed。",
            "LLM Gateway canary stage: $canary_stage allowlist=$allowlist_compact",
            "LLMGW_SHADOW_FULL_SAMPLE_PERCENT",
            "shadow_sample_enabled=0",
            "release_gate_required=0",
            "shadow sample startup",
            "serving/smoke verification runs after compose up",
            "LLMGW_GATE_SHADOW_SINCE_HOURS",
            "--since-hours ${LLMGW_GATE_SHADOW_SINCE_HOURS:-24}",
            "LLMGW_GATE_MIN_COVERAGE_HOURS",
            "--min-coverage-hours $gate_min_coverage_hours",
            "默认要求 shadow 证据覆盖 24 小时",
            "same-commit shadow evidence only; commit probe runs after compose up",
            "--shadow-release-commit $expect_commit",
            "--health-samples ${LLMGW_GATE_HEALTH_SAMPLES:-3}",
            "probe_args=\"$probe_args --expect-commit $expect_commit\"",
            "LLMGW_GATE_FULL_HTTP_APP_CALLERS",
            "gate_app_callers_raw=\"${LLMGW_GATE_FULL_HTTP_APP_CALLERS:-report-agent.generate::chat",
            "visual-agent.image-gen.generate::generation",
            "visual-agent.image.img2img::generation",
            "document-store.subtitle::asr",
            "video-agent.v2d.transcribe::asr",
            "video-agent.video-to-text::asr",
            "required_kinds_raw=\"${LLMGW_GATE_REQUIRED_KINDS:-}\"",
            "required_kinds_raw=\"send:${full_http_kind_min},stream:${full_http_kind_min},raw:${full_http_kind_min}\"",
            "LLMGW_GATE_CANARY_KIND_MIN",
            "required_kinds_raw=\"stream:${canary_kind_min}\"",
            "required_kinds_raw=\"raw:${canary_kind_min}\"",
            "LLMGW_GATE_FULL_HTTP_APP_KINDS",
            "required_app_kinds_raw=\"${LLMGW_GATE_REQUIRED_APP_KINDS:-}\"",
            "full_http_app_kind_min=\"${LLMGW_GATE_FULL_HTTP_APP_KIND_MIN:-${LLMGW_GATE_FULL_HTTP_KIND_MIN:-${LLMGW_GATE_MIN_PER_APP:-30}}}\"",
            "visual-agent.image-gen.generate::generation:raw:",
            "visual-agent.image.img2img::generation:raw:",
            "video-agent.videogen::video-gen:raw:",
            "visual-agent.videogen::video-gen:raw:",
            "transcript-agent.transcribe::asr:raw:",
            "video-agent.v2d.transcribe::asr:raw:",
            "video-agent.video-to-text::asr:raw:",
            "LLMGW_GATE_CANARY_APP_KIND_MIN",
            "LLMGW_GATE_CANARY_APP_KINDS",
            "canary 阶段 $canary_stage 默认要求 raw app-kind 样本逐个达标",
            "LLMGW_GATE_RUN_SMOKE",
            "GW_BASE=\"$gate_base\" GW_KEY=\"$gate_key\" GW_TIMEOUT=\"${LLMGW_GATE_SMOKE_TIMEOUT_SECONDS:-120}\" GW_EXPECT_COMMIT=\"$expect_commit\" python3 scripts/gw-smoke.py",
            "LLMGW_GATE_RUN_SERVING_PROBE",
            "LLMGW_SERVING_PROBE_JSON_OUT",
            "scripts/llmgw-disk-space-guard.sh",
            "LLMGW_DEPLOY_DISK_GUARD_PATH",
            "LLMGW_DEPLOY_MIN_FREE_MB:-4096",
            "LLM Gateway exec_dep deploy",
            "provider_audit_required=0",
            "if [ \"$mode\" = \"http\" ] || [ \"$canary_stage\" = \"video-asr\" ]; then",
            "scripts/llmgw-prod-provider-config-audit.py",
            "LLMGW_PROVIDER_AUDIT_JSON_OUT",
            "LLMGW_PROVIDER_AUDIT_REPORT_MD",
            "LLMGW_PROVIDER_AUDIT_SEED_EVIDENCE_JSON",
            "LLM Gateway provider config audit: required before deploy",
            "GW_SMOKE_JSON_OUT",
            "python3 scripts/llmgw-serving-probe.py $probe_args",
            "LLM Gateway post-deploy serving probe",
            "LLM Gateway post-deploy D-layer smoke",
            "LLMGW_SKIP_RELEASE_GATE=1",
            "LLMGW_SKIP_RELEASE_GATE=1 is not allowed when LLM Gateway release evidence is required",
            "Use scripts/llmgw-rollback-inproc.sh for emergency rollback",
        ],
    )
    checks.append(_check("exec_dep_gates_http_canary_and_shadow_sample_release", ok, detail))

    rollback_path = ROOT / "scripts/llmgw-rollback-inproc.sh"
    rollback = rollback_path.read_text(encoding="utf-8")
    ok, detail = _contains_all(
        rollback,
        [
            "export LLMGW_MODE=inproc",
            "export LLMGW_HTTP_APP_CALLER_ALLOWLIST=",
            "export LLMGW_SHADOW_FULL_SAMPLE_PERCENT=0",
            "LLMGW_ROLLBACK_DRY_RUN",
            "LLM Gateway rollback dry-run",
            "up -d --no-deps --force-recreate",
            "database: unchanged",
            "images: unchanged",
        ],
    )
    executable = bool(rollback_path.stat().st_mode & stat.S_IXUSR)
    destructive = any(item in rollback for item in ["down -v", "docker volume rm", "mongorestore", "db.dropDatabase", "git checkout"])
    checks.append(_check("rollback_script_is_safe_and_executable", ok and executable and not destructive, f"{detail}; executable={executable}; destructive={destructive}"))

    restore_path = ROOT / "scripts/llmgw-restore-shadow-safe.sh"
    restore = restore_path.read_text(encoding="utf-8") if restore_path.exists() else ""
    ok, detail = _contains_all(
        restore,
        [
            "export LLMGW_MODE=shadow",
            "export LLMGW_HTTP_APP_CALLER_ALLOWLIST=",
            "export LLMGW_SHADOW_FULL_SAMPLE_PERCENT=\"$sample_percent\"",
            "LLMGW_RESTORE_DRY_RUN",
            "LLMGW_RESTORE_ENV_FILE",
            "LLMGW_RESTORE_PERSIST_ENV",
            "LLMGW_RESTORE_SHADOW_FULL_SAMPLE_PERCENT",
            "persist_env_file",
            "LLM Gateway restore dry-run",
            "up -d --no-deps --force-recreate",
            "database: unchanged",
            "images: unchanged",
        ],
    )
    restore_executable = bool(restore_path.exists() and (restore_path.stat().st_mode & stat.S_IXUSR))
    restore_destructive = any(item in restore for item in ["down -v", "docker volume rm", "mongorestore", "db.dropDatabase", "git checkout"])
    checks.append(_check(
        "restore_shadow_script_is_safe_and_executable",
        ok and restore_executable and not restore_destructive,
        f"{detail}; executable={restore_executable}; destructive={restore_destructive}",
    ))

    direct = _read("prd-api/tests/PrdAgent.Tests/GatewayDirectClientRatchetTests.cs")
    direct_empty = _dictionary_block_is_empty(direct, "Baseline")
    manual_empty = _dictionary_block_is_empty(direct, "ManualUpstreamHttpBaseline")
    checks.append(_check("direct_client_ratchet_baselines_are_empty", direct_empty and manual_empty, f"Baseline={direct_empty}; ManualUpstreamHttpBaseline={manual_empty}"))
    ok, detail = _contains_all(
        direct,
        [
            "ManualUpstreamHttpDetector_CoversTextImageAudioVideoEndpoints",
            "ManualUpstreamHttpDetector_DoesNotFlagGatewayRawRequests",
            "ContainsProviderModelEndpoint",
            "/v1/chat/completions",
            "/v1/messages",
            "/v1/responses",
            "/v1/images/generations",
            "/v1/images/edits",
            "/v1/audio/transcriptions",
            "/v1/audio/speech",
            "/v1/embeddings",
            "/v1/rerank",
            "/videos",
            "GatewayRawRequest",
            "SendRawWithResolutionAsync",
        ],
    )
    checks.append(_check(
        "manual_upstream_http_guard_covers_text_image_audio_video",
        ok,
        detail,
    ))
    direct_transport_empty = _dictionary_block_is_empty(direct, "DirectTransportMarkerBaseline")
    ok, detail = _contains_all(
        direct,
        [
            "DirectTransportMarkers_AreOnlyInTrackedNonGatewayPaths",
            "DirectTransportMarkerBaseline",
            "GatewayTransports.AdminProbe",
        ],
    )
    checks.append(_check(
        "direct_transport_marker_baseline_is_empty",
        ok and direct_transport_empty,
        f"{detail}; DirectTransportMarkerBaseline={direct_transport_empty}",
    ))

    gateway_src = _read("prd-api/src/PrdAgent.LlmGateway/GatewayHttpEndpoints.cs")
    multipart_tests = _read("prd-api/tests/PrdAgent.Api.Tests/Gateway/GatewayMultipartHttpTests.cs")
    no_unsupported = "MULTIPART_HTTP_UNSUPPORTED" not in "\n".join(
        path.read_text(encoding="utf-8", errors="ignore")
        for path in (ROOT / "prd-api/src").rglob("*.cs")
    )
    ok, detail = _contains_all(
        gateway_src + "\n" + multipart_tests,
        [
            "RehydrateMultipartFileRefsAsync",
            "MultipartFileRefs",
            "MULTIPART_REF_HASH_MISMATCH",
            "HttpClient_UploadsInlineMultipartFiles_AsRefs_WithoutSerializingBytes",
            "RawEndpoint_RehydratesMultipartFileRefs_BeforeGatewaySend",
        ],
    )
    checks.append(_check("multipart_http_path_has_refs_rehydrate_and_hash_guard", ok and no_unsupported, f"{detail}; noUnsupported={no_unsupported}"))

    compose = _read("docker-compose.yml")
    ok, detail = _contains_all(
        compose,
        [
            "LlmGateway__Mode=${LLMGW_MODE:-inproc}",
            "LlmGateway__HttpAppCallerAllowlist=${LLMGW_HTTP_APP_CALLER_ALLOWLIST:-}",
            "LlmGateway__ShadowFullSamplePercent=${LLMGW_SHADOW_FULL_SAMPLE_PERCENT:-0}",
            "LlmGateway__DatabaseName=${LLMGW_DATABASE_NAME:-llm_gateway}",
            "LlmGwServe__ApiKey=${LLMGW_SERVE_KEY:?",
            "LLMGW_ADMIN_PASSWORD=${LLMGW_ADMIN_PASSWORD:-}",
            "LLMGW_ADMIN_FORCE_RESET=${LLMGW_ADMIN_FORCE_RESET:-}",
        ],
    )
    admin_password_required = "LLMGW_ADMIN_PASSWORD=${LLMGW_ADMIN_PASSWORD:?" in compose
    admin_user_env = "LLMGW_ADMIN_USER" in compose
    checks.append(_check(
        "compose_exposes_gateway_mode_and_data_domain_controls",
        ok and not admin_password_required and not admin_user_env,
        f"{detail}; adminPasswordRequired={admin_password_required}; adminUserEnv={admin_user_env}",
    ))

    return checks


def _rollback_dry_run() -> dict:
    with tempfile.TemporaryDirectory(prefix="llmgw-rollback-audit-") as tmp:
        tmp_path = Path(tmp)
        fake_compose = tmp_path / "docker-compose"
        out_path = tmp_path / "compose.out"
        fake_compose.write_text(
            "#!/usr/bin/env sh\n"
            "printf 'ARGS=%s\\n' \"$*\" > \"$FAKE_ROLLBACK_OUT\"\n"
            "printf 'LLMGW_MODE=%s\\n' \"$LLMGW_MODE\" >> \"$FAKE_ROLLBACK_OUT\"\n"
            "printf 'ALLOWLIST=%s\\n' \"$LLMGW_HTTP_APP_CALLER_ALLOWLIST\" >> \"$FAKE_ROLLBACK_OUT\"\n"
            "printf 'SHADOW=%s\\n' \"$LLMGW_SHADOW_FULL_SAMPLE_PERCENT\" >> \"$FAKE_ROLLBACK_OUT\"\n",
            encoding="utf-8",
        )
        fake_compose.chmod(0o755)
        env = os.environ.copy()
        env["PATH"] = f"{tmp}:{env.get('PATH', '')}"
        env["FAKE_ROLLBACK_OUT"] = str(out_path)
        env["LLMGW_ROLLBACK_COMPOSE_FILE"] = str(ROOT / "docker-compose.yml")
        env["LLMGW_ROLLBACK_DRY_RUN"] = "1"
        result = _run(["scripts/llmgw-rollback-inproc.sh"], env=env, timeout=60)
        captured = out_path.read_text(encoding="utf-8") if out_path.exists() else ""
        stdout = str(result.get("stdout") or "")
        ok = (
            result["ok"]
            and not captured
            and "dryRun: 1" in stdout
            and "LLM Gateway rollback dry-run" in stdout
            and "up -d --no-deps --force-recreate api" in stdout
            and "API would restart with LLMGW_MODE=inproc" in stdout
        )
        return {"name": "rollback_dry_run", "ok": ok, "detail": stdout + captured, "command": result}


def _restore_shadow_dry_run() -> dict:
    with tempfile.TemporaryDirectory(prefix="llmgw-restore-audit-") as tmp:
        tmp_path = Path(tmp)
        fake_compose = tmp_path / "docker-compose"
        out_path = tmp_path / "compose.out"
        fake_compose.write_text(
            "#!/usr/bin/env sh\n"
            "printf 'ARGS=%s\\n' \"$*\" > \"$FAKE_RESTORE_OUT\"\n"
            "printf 'LLMGW_MODE=%s\\n' \"$LLMGW_MODE\" >> \"$FAKE_RESTORE_OUT\"\n"
            "printf 'ALLOWLIST=%s\\n' \"$LLMGW_HTTP_APP_CALLER_ALLOWLIST\" >> \"$FAKE_RESTORE_OUT\"\n"
            "printf 'SHADOW=%s\\n' \"$LLMGW_SHADOW_FULL_SAMPLE_PERCENT\" >> \"$FAKE_RESTORE_OUT\"\n",
            encoding="utf-8",
        )
        fake_compose.chmod(0o755)
        env = os.environ.copy()
        env["PATH"] = f"{tmp}:{env.get('PATH', '')}"
        env["FAKE_RESTORE_OUT"] = str(out_path)
        env_file = tmp_path / "prod.env"
        env["LLMGW_RESTORE_COMPOSE_FILE"] = str(ROOT / "docker-compose.yml")
        env["LLMGW_RESTORE_ENV_FILE"] = str(env_file)
        env["LLMGW_RESTORE_DRY_RUN"] = "1"
        env["LLMGW_RESTORE_SHADOW_FULL_SAMPLE_PERCENT"] = "1"
        result = _run(["scripts/llmgw-restore-shadow-safe.sh"], env=env, timeout=60)
        captured = out_path.read_text(encoding="utf-8") if out_path.exists() else ""
        stdout = str(result.get("stdout") or "")
        ok = (
            result["ok"]
            and not captured
            and not env_file.exists()
            and "dryRun: 1" in stdout
            and "env file would be updated" in stdout
            and "LLM Gateway restore dry-run" in stdout
            and "up -d --no-deps --force-recreate api" in stdout
            and "API would restart with LLMGW_MODE=shadow and sample=1" in stdout
        )
        return {"name": "restore_shadow_dry_run", "ok": ok, "detail": stdout + captured, "command": result}


def _restore_shadow_persist_env_test() -> dict:
    with tempfile.TemporaryDirectory(prefix="llmgw-restore-persist-audit-") as tmp:
        tmp_path = Path(tmp)
        fake_compose = tmp_path / "docker-compose"
        out_path = tmp_path / "compose.out"
        env_path = tmp_path / "prod.env"
        env_path.write_text(
            "UNCHANGED=value\n"
            "LLMGW_MODE=http\n"
            "LLMGW_HTTP_APP_CALLER_ALLOWLIST=image-worker.text2img\n"
            "LLMGW_SHADOW_FULL_SAMPLE_PERCENT=100\n",
            encoding="utf-8",
        )
        fake_compose.write_text(
            "#!/usr/bin/env sh\n"
            "printf 'ARGS=%s\\n' \"$*\" >> \"$FAKE_RESTORE_OUT\"\n"
            "printf 'LLMGW_MODE=%s\\n' \"$LLMGW_MODE\" >> \"$FAKE_RESTORE_OUT\"\n"
            "printf 'ALLOWLIST=%s\\n' \"$LLMGW_HTTP_APP_CALLER_ALLOWLIST\" >> \"$FAKE_RESTORE_OUT\"\n"
            "printf 'SHADOW=%s\\n' \"$LLMGW_SHADOW_FULL_SAMPLE_PERCENT\" >> \"$FAKE_RESTORE_OUT\"\n",
            encoding="utf-8",
        )
        fake_compose.chmod(0o755)
        env = os.environ.copy()
        env["PATH"] = f"{tmp}:{env.get('PATH', '')}"
        env["FAKE_RESTORE_OUT"] = str(out_path)
        env["LLMGW_RESTORE_COMPOSE_FILE"] = str(ROOT / "docker-compose.yml")
        env["LLMGW_RESTORE_ENV_FILE"] = str(env_path)
        env["LLMGW_RESTORE_GATEWAY_SERVICE"] = ""
        env["LLMGW_RESTORE_DRY_RUN"] = "0"
        env["LLMGW_RESTORE_SHADOW_FULL_SAMPLE_PERCENT"] = "1"
        result = _run(["scripts/llmgw-restore-shadow-safe.sh"], env=env, timeout=60)
        captured = out_path.read_text(encoding="utf-8") if out_path.exists() else ""
        persisted = env_path.read_text(encoding="utf-8") if env_path.exists() else ""
        ok = (
            result["ok"]
            and "LLMGW_MODE=shadow" in persisted
            and "LLMGW_HTTP_APP_CALLER_ALLOWLIST=\n" in persisted
            and "LLMGW_SHADOW_FULL_SAMPLE_PERCENT=1" in persisted
            and "UNCHANGED=value" in persisted
            and "LLMGW_MODE=shadow" in captured
            and "ALLOWLIST=\n" in captured
            and "SHADOW=1" in captured
            and "up -d --no-deps --force-recreate api" in captured
        )
        detail = str(result.get("stdout") or "") + captured + "\n" + persisted
        return {"name": "restore_shadow_persist_env_test", "ok": ok, "detail": detail, "command": result}


def _provider_audit_self_test() -> dict:
    result = _run(
        ["python3", "scripts/llmgw-prod-provider-config-audit.py", "--self-test", "--print-json"],
        timeout=60,
    )
    detail = result["stdout"] + result["stderr"]
    ok = result["ok"]
    try:
        payload = _parse_json_object(result["stdout"])
        codes = set(payload.get("actualCodes") or [])
        required = set(payload.get("requiredCodes") or [])
        ok = ok and payload.get("verdict") == "pass" and required.issubset(codes)
        detail = json.dumps({
            "verdict": payload.get("verdict"),
            "requiredCodes": sorted(required),
            "actualCodes": sorted(codes),
            "missingCodes": payload.get("missingCodes") or [],
        }, ensure_ascii=False, sort_keys=True)
    except Exception:
        ok = False
    return {"name": "provider_audit_external_blocker_self_test", "ok": ok, "detail": detail, "command": result}


def _dotnet_checks() -> list[dict]:
    checks: list[dict] = []
    tests = [
        (
            "gateway_data_domain_and_direct_ratchet_tests",
            [
                "dotnet",
                "test",
                "tests/PrdAgent.Tests/PrdAgent.Tests.csproj",
                "--no-restore",
                "--filter",
                "FullyQualifiedName~GatewayDataDomainGuardTests|FullyQualifiedName~GatewayDirectClientRatchetTests",
            ],
            ROOT / "prd-api",
        ),
        (
            "gateway_protocol_and_shadow_unit_tests",
            [
                "dotnet",
                "test",
                "tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj",
                "--no-restore",
                "--filter",
                "FullyQualifiedName~GatewayPinnedModelTests|FullyQualifiedName~GatewayProtocolFidelityTests|FullyQualifiedName~ClaudeToolTranslationTests|FullyQualifiedName~ShadowLlmGatewayTests",
            ],
            ROOT / "prd-api",
        ),
        (
            "gateway_http_boundary_unit_tests",
            [
                "dotnet",
                "test",
                "tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj",
                "--no-restore",
                "--filter",
                "FullyQualifiedName~GatewayMultipartHttpTests|FullyQualifiedName~GatewayKeyGateContractTests|FullyQualifiedName~HttpLlmGatewayClientFailureTests",
            ],
            ROOT / "prd-api",
        ),
        (
            "gateway_cross_process_matrix_tests",
            [
                "dotnet",
                "test",
                "tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj",
                "--no-restore",
                "--filter",
                "FullyQualifiedName~CrossProcessServingSelfTest|FullyQualifiedName~CrossProcessServingErrorLoadTests|FullyQualifiedName~GatewayServingEndpointContractTests",
            ],
            ROOT / "prd-api",
        ),
        (
            "gateway_media_contract_tests",
            [
                "dotnet",
                "test",
                "tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj",
                "--no-restore",
                "--filter",
                "FullyQualifiedName~GatewayDoubaoStreamAsrTests|FullyQualifiedName~OpenRouterVideoClientGatewayTests",
            ],
            ROOT / "prd-api",
        ),
    ]
    env = os.environ.copy()
    env["DOTNET_ROLL_FORWARD"] = env.get("DOTNET_ROLL_FORWARD", "Major")
    for name, cmd, cwd in tests:
        result = _run(cmd, cwd=cwd, env=env, timeout=600)
        checks.append({"name": name, "ok": result["ok"], "detail": result["stdout"] + result["stderr"], "command": result})
    return checks


def _release_gate(args: argparse.Namespace) -> dict:
    cmd = [
        "python3",
        "scripts/llmgw-release-gate.py",
        "--base",
        args.base,
        "--key",
        args.key,
        "--min-total",
        str(args.min_total),
        "--min-per-app",
        str(args.min_per_app),
        "--since-hours",
        str(args.since_hours),
        "--min-coverage-hours",
        str(args.min_coverage_hours),
        "--health-samples",
        str(args.health_samples),
        "--health-interval",
        str(args.health_interval),
    ]
    if args.expect_commit:
        cmd.extend(["--expect-commit", args.expect_commit])
    for item in args.app_caller:
        cmd.extend(["--app-caller", item])
    for item in args.require_kind:
        cmd.extend(["--require-kind", item])
    for item in args.require_app_kind:
        cmd.extend(["--require-app-kind", item])
    result = _run(cmd, timeout=600)
    return {"name": "live_release_gate", "ok": result["ok"], "detail": result["stdout"] + result["stderr"], "command": result}


def _gw_smoke(args: argparse.Namespace) -> dict:
    env = os.environ.copy()
    env["GW_BASE"] = args.base
    env["GW_KEY"] = args.key
    if args.smoke_timeout_seconds > 0:
        env["GW_TIMEOUT"] = str(args.smoke_timeout_seconds)
    if args.expect_commit:
        env["GW_EXPECT_COMMIT"] = args.expect_commit
    result = _run(["python3", "scripts/gw-smoke.py"], env=env, timeout=max(60, args.smoke_timeout_seconds * 10))
    return {"name": "gw_smoke_d_layer", "ok": result["ok"], "detail": result["stdout"] + result["stderr"], "command": result}


def _shadow_coverage(args: argparse.Namespace) -> dict:
    cmd = [
        "python3",
        "scripts/llmgw-shadow-coverage-report.py",
        "--base",
        args.base,
        "--key",
        args.key,
        "--min-per-cell",
        str(args.min_per_app),
        "--since-hours",
        str(args.since_hours),
        "--min-coverage-hours",
        str(args.min_coverage_hours),
    ]
    if args.expect_commit:
        cmd.extend(["--release-commit", args.expect_commit])
    for item in args.app_caller:
        cmd.extend(["--app-caller", item])
    for item in args.kind:
        cmd.extend(["--kind", item])
    result = _run(cmd, timeout=600)
    return {"name": "shadow_coverage_matrix", "ok": result["ok"], "detail": result["stdout"] + result["stderr"], "command": result}


def _serving_probe(args: argparse.Namespace) -> dict:
    cmd = [
        "python3",
        "scripts/llmgw-serving-probe.py",
        "--base",
        args.base,
        "--samples",
        str(args.serving_probe_samples),
        "--interval",
        str(args.serving_probe_interval),
    ]
    if args.expect_commit:
        cmd.extend(["--expect-commit", args.expect_commit])
    result = _run(cmd, timeout=max(120, int(args.serving_probe_samples * max(1, args.serving_probe_interval + 30))))
    return {"name": "serving_stability_and_auth_probe", "ok": result["ok"], "detail": result["stdout"] + result["stderr"], "command": result}


def _parse_json_object(output: str) -> dict:
    start = output.find("{")
    end = output.rfind("}")
    if start < 0 or end < start:
        raise ValueError("no JSON object in command output")
    return json.loads(output[start:end + 1])


def _csv(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def _extract_branch_id(output: str) -> str:
    stripped = output.strip()
    if stripped.startswith("{"):
        data = _parse_json_object(stripped)
        payload = data.get("data") if isinstance(data.get("data"), dict) else data
        branch_id = payload.get("branchId") if isinstance(payload, dict) else ""
        if branch_id:
            return str(branch_id).strip()
    return stripped.splitlines()[-1].strip() if stripped else ""


def _cds_runtime(args: argparse.Namespace) -> dict:
    branch_id = args.cds_branch_id.strip()
    if not branch_id:
        branch_result = _run(["python3", ".claude/skills/cds/cli/cdscli.py", "branch-id"], timeout=60)
        if not branch_result["ok"]:
            return {
                "name": "cds_runtime_uses_release_gateway_profiles",
                "ok": False,
                "detail": branch_result["stdout"] + branch_result["stderr"],
                "command": branch_result,
            }
        branch_id = _extract_branch_id(branch_result["stdout"] or "")
        if not branch_id:
            return {
                "name": "cds_runtime_uses_release_gateway_profiles",
                "ok": False,
                "detail": f"failed to parse branch id from cdscli output: {branch_result['stdout'][:1000]}",
                "command": branch_result,
            }

    result = _run(["python3", ".claude/skills/cds/cli/cdscli.py", "branch", "status", branch_id], timeout=120, tail=None)
    if not result["ok"]:
        return {
            "name": "cds_runtime_uses_release_gateway_profiles",
            "ok": False,
            "detail": result["stdout"] + result["stderr"],
            "command": result,
        }

    try:
        status = _parse_json_object(result["stdout"])
        if isinstance(status.get("data"), dict):
            status = status["data"]
    except Exception as exc:
        return {
            "name": "cds_runtime_uses_release_gateway_profiles",
            "ok": False,
            "detail": f"failed to parse cdscli branch status JSON: {exc}; stdout={result['stdout'][:1000]}",
            "command": result,
        }

    failures: list[str] = []
    branch_status = str(status.get("status") or "")
    if branch_status != "running":
        failures.append(f"branch status is not running: {branch_status or 'empty'}")

    commit_candidates = [
        str(status.get("githubCommitSha") or ""),
        str(status.get("commitSha") or ""),
        str(status.get("ciTargetSha") or ""),
        str(status.get("lastDeployDispatchCommitSha") or ""),
    ]
    if args.expect_commit and args.expect_commit not in commit_candidates:
        failures.append(f"commit mismatch: expected={args.expect_commit}, actual={','.join(item for item in commit_candidates if item)}")
    if args.expect_commit and str(status.get("lastDeployDispatchCommitSha") or "") != args.expect_commit:
        failures.append(
            "lastDeployDispatchCommitSha mismatch: "
            f"expected={args.expect_commit}, actual={status.get('lastDeployDispatchCommitSha') or 'empty'}"
        )

    if status.get("ciImageStatus") not in (None, "", "ready"):
        failures.append(f"ciImageStatus is not ready: {status.get('ciImageStatus')}")

    services = status.get("services") or {}
    for profile_id, service in sorted(services.items()):
        if isinstance(service, dict) and service.get("status") != "running":
            failures.append(f"{profile_id} status={service.get('status')}")
    for profile_id in _csv(args.cds_release_profiles):
        service = services.get(profile_id)
        if not isinstance(service, dict):
            failures.append(f"missing release profile: {profile_id}")
            continue
        if service.get("status") != "running":
            failures.append(f"{profile_id} status={service.get('status')}")
        if service.get("deployedMode") != "express":
            failures.append(f"{profile_id} deployedMode={service.get('deployedMode')!r}, expected 'express'")

    for profile_id in _csv(args.cds_running_profiles):
        service = services.get(profile_id)
        if not isinstance(service, dict):
            failures.append(f"missing running profile: {profile_id}")
            continue
        if service.get("status") != "running":
            failures.append(f"{profile_id} status={service.get('status')}")

    runtime = status.get("deployRuntime") or {}
    if runtime.get("drift", {}).get("hasDrift") is True:
        failures.append("deployRuntime.drift.hasDrift=true")

    detail = {
        "branchId": branch_id,
        "branchStatus": branch_status,
        "commitCandidates": [item for item in commit_candidates if item],
        "ciImageStatus": status.get("ciImageStatus"),
        "lastDeployDispatchCommitSha": status.get("lastDeployDispatchCommitSha"),
        "releaseProfiles": {
            profile_id: services.get(profile_id, {})
            for profile_id in _csv(args.cds_release_profiles)
        },
        "runningProfiles": {
            profile_id: services.get(profile_id, {})
            for profile_id in _csv(args.cds_running_profiles)
        },
        "failures": failures,
    }
    return {
        "name": "cds_runtime_uses_release_gateway_profiles",
        "ok": not failures,
        "detail": json.dumps(detail, ensure_ascii=False, sort_keys=True),
        "command": result,
    }


def _current_commit() -> str:
    result = _run(["git", "rev-parse", "HEAD"], timeout=30)
    if not result["ok"]:
        return ""
    return str(result.get("stdout") or "").strip().splitlines()[-1].strip()


def _rollout_ledger(args: argparse.Namespace) -> dict:
    commit = (args.expect_commit or _current_commit()).strip()
    if not commit:
        return {
            "name": "rollout_ledger_completion_state",
            "ok": False,
            "detail": "missing --expect-commit and failed to resolve git HEAD",
        }
    cmd = [
        "python3",
        "scripts/llmgw-rollout-ledger.py",
        "audit",
        "--ledger",
        args.rollout_ledger,
        "--commit",
        commit,
        "--target-stage",
        args.rollout_target_stage,
        "--min-observation-hours",
        str(args.rollout_min_observation_hours),
    ]
    if args.require_rollout_complete:
        cmd.append("--require-target-success")
    result = _run(cmd, timeout=120)
    return {
        "name": "rollout_ledger_completion_state",
        "ok": result["ok"],
        "detail": result["stdout"] + result["stderr"],
        "command": result,
    }


def _write_outputs(report: dict, json_out: str, report_md: str) -> None:
    if json_out:
        path = Path(json_out)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if report_md:
        path = Path(report_md)
        path.parent.mkdir(parents=True, exist_ok=True)
        lines = [
            "# LLM Gateway Readiness Audit",
            "",
            f"- generatedAt: `{report['generatedAt']}`",
            f"- verdict: `{report['verdict']}`",
            f"- base: `{report.get('base') or ''}`",
            "",
            "| gate | status | detail |",
            "|---|---|---|",
        ]
        for item in report["checks"]:
            detail = str(item.get("detail") or "").replace("|", "\\|").replace("\n", "<br>")
            lines.append(f"| {item['name']} | {'pass' if item.get('ok') else 'fail'} | {detail[:1000]} |")
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="LLM Gateway full-cutover readiness audit")
    parser.add_argument("--base", default=os.environ.get("GW_BASE", "").strip().rstrip("/"), help="serving base URL, e.g. https://host/gw/v1")
    parser.add_argument("--key", default=os.environ.get("GW_KEY", ""), help="X-Gateway-Key for live release gate")
    parser.add_argument("--expect-commit", default=os.environ.get("GIT_COMMIT", ""), help="optional healthz commit assertion")
    parser.add_argument("--min-total", type=int, default=30)
    parser.add_argument("--min-per-app", type=int, default=30)
    parser.add_argument("--since-hours", type=float, default=float(os.environ.get("LLMGW_GATE_SHADOW_SINCE_HOURS", "24")))
    parser.add_argument("--min-coverage-hours", type=float, default=float(os.environ.get("LLMGW_GATE_MIN_COVERAGE_HOURS", "0")))
    parser.add_argument("--health-samples", type=int, default=int(os.environ.get("LLMGW_GATE_HEALTH_SAMPLES", "3")))
    parser.add_argument("--health-interval", type=float, default=float(os.environ.get("LLMGW_GATE_HEALTH_INTERVAL_SECONDS", "5")))
    parser.add_argument("--app-caller", action="append", default=[])
    parser.add_argument("--kind", action="append", default=[])
    parser.add_argument("--require-kind", action="append", default=[])
    parser.add_argument("--require-app-kind", action="append", default=[])
    parser.add_argument("--run-dotnet", action="store_true", help="run xUnit gateway guard tests")
    parser.add_argument("--run-smoke", action="store_true", help="run D-layer scripts/gw-smoke.py against --base/--key")
    parser.add_argument("--run-shadow-coverage", action="store_true", help="run appCaller x kind shadow coverage matrix")
    parser.add_argument("--run-serving-probe", action="store_true", help="run serving health stability and no-key auth probe")
    parser.add_argument("--run-cds-runtime", action="store_true", help="verify CDS preview/grey runtime uses release gateway profiles")
    parser.add_argument("--run-rollout-ledger", action="store_true", help="audit rollout ledger stage evidence for --expect-commit or git HEAD")
    parser.add_argument("--cds-branch-id", default=os.environ.get("CDS_BRANCH_ID", ""), help="CDS branch id for --run-cds-runtime; default: cdscli branch-id")
    parser.add_argument("--cds-release-profiles", default=os.environ.get("LLMGW_CDS_RELEASE_PROFILES", "api-prd-agent,llmgw-prd-agent,llmgw-serve-prd-agent"), help="comma-separated CDS profile ids that must run express prebuilt images")
    parser.add_argument("--cds-running-profiles", default=os.environ.get("LLMGW_CDS_RUNNING_PROFILES", "llmgw-web-prd-agent"), help="comma-separated CDS profile ids that must be running")
    parser.add_argument("--rollout-ledger", default=os.environ.get("LLMGW_ROLLOUT_LEDGER", ".llmgw-release-evidence/rollout-ledger.jsonl"))
    parser.add_argument("--rollout-target-stage", default=os.environ.get("LLMGW_ROLLOUT_TARGET_STAGE", "http-full"))
    parser.add_argument("--rollout-min-observation-hours", type=float, default=float(os.environ.get("LLMGW_STAGE_MIN_OBSERVATION_HOURS", "24")))
    parser.add_argument("--require-rollout-complete", action="store_true", help="require target stage success in rollout ledger audit")
    parser.add_argument("--serving-probe-samples", type=int, default=int(os.environ.get("LLMGW_SERVING_PROBE_SAMPLES", "12")))
    parser.add_argument("--serving-probe-interval", type=float, default=float(os.environ.get("LLMGW_SERVING_PROBE_INTERVAL_SECONDS", "5")))
    parser.add_argument("--smoke-timeout-seconds", type=int, default=int(os.environ.get("GW_TIMEOUT", "120")))
    parser.add_argument("--require-release-gate", action="store_true", help="fail when --base/--key are missing and run live release gate")
    parser.add_argument("--json-out", default=os.environ.get("LLMGW_READINESS_JSON_OUT", ""))
    parser.add_argument("--report-md", default=os.environ.get("LLMGW_READINESS_REPORT_MD", ""))
    parser.add_argument("--print-json", action="store_true")
    args = parser.parse_args()

    checks = _static_checks()
    checks.append(_rollback_dry_run())
    checks.append(_restore_shadow_dry_run())
    checks.append(_restore_shadow_persist_env_test())
    checks.append(_provider_audit_self_test())
    if args.run_dotnet:
        checks.extend(_dotnet_checks())
    if args.run_smoke:
        if not args.base or not args.key:
            checks.append(_check("gw_smoke_d_layer", False, "missing --base/--key"))
        else:
            checks.append(_gw_smoke(args))
    if args.run_shadow_coverage:
        if not args.base or not args.key:
            checks.append(_check("shadow_coverage_matrix", False, "missing --base/--key"))
        else:
            checks.append(_shadow_coverage(args))
    if args.run_serving_probe:
        if not args.base:
            checks.append(_check("serving_stability_and_auth_probe", False, "missing --base"))
        else:
            checks.append(_serving_probe(args))
    if args.run_cds_runtime:
        checks.append(_cds_runtime(args))
    if args.run_rollout_ledger or args.require_rollout_complete:
        checks.append(_rollout_ledger(args))
    if args.require_release_gate:
        if not args.base or not args.key:
            checks.append(_check("live_release_gate", False, "missing --base/--key"))
        else:
            checks.append(_release_gate(args))

    failures = [item for item in checks if not item.get("ok")]
    report = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "verdict": "fail" if failures else "pass",
        "base": args.base,
        "checks": checks,
        "failureCount": len(failures),
    }
    _write_outputs(report, args.json_out, args.report_md)
    if args.print_json:
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    if failures:
        print("LLM Gateway readiness audit: FAIL")
        for item in failures:
            print(f"- {item['name']}: {item.get('detail', '')[:300]}")
        return 1
    print("LLM Gateway readiness audit: PASS")
    print(f"- checks={len(checks)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
