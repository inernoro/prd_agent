#!/usr/bin/env python3
"""Read-only production provider config audit for LLM Gateway video/ASR cutover.

The audit intentionally does not print secrets. When key-shape decryption is
enabled, it only reports metadata such as length and whether a key looks like a
single UUID or appId|accessToken pair.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ASR_APP_CALLERS = [
    "document-store.subtitle::asr",
    "transcript-agent.transcribe::asr",
    "video-agent.v2d.transcribe::asr",
    "video-agent.video-to-text::asr",
]
VIDEO_APP_CALLER = "video-agent.videogen::video-gen"
DEFAULT_ASR_POOL_ID = "asr_doubao_bigmodel_pool"
DEFAULT_ASR_MODEL_ID = "doubao-asr-bigmodel"
DEFAULT_ASR_TRANSFORMER = "doubao-asr"


def _run(cmd: list[str], cwd: str | None = None, input_text: str | None = None) -> str:
    proc = subprocess.run(
        cmd,
        cwd=cwd,
        input=input_text,
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"command failed ({proc.returncode}): {' '.join(cmd)}\n{proc.stderr[:800]}")
    return proc.stdout


def _compose_cmd() -> list[str]:
    if subprocess.run(["docker", "compose", "version"], capture_output=True, text=True).returncode == 0:
        return ["docker", "compose"]
    if subprocess.run(["docker-compose", "version"], capture_output=True, text=True).returncode == 0:
        return ["docker-compose"]
    raise RuntimeError("docker compose/docker-compose not found")


def _mongo_snapshot(
    compose_file: str,
    mongo_service: str,
    mongo_db: str,
    gateway_db: str,
    recent_log_hours: int,
    collect_gateway_logs: bool,
) -> dict[str, Any]:
    gateway_db_literal = json.dumps(gateway_db)
    recent_log_hours_literal = json.dumps(max(1, recent_log_hours))
    collect_gateway_logs_literal = "true" if collect_gateway_logs else "false"
    js = r'''
const asrCallers = [
  "document-store.subtitle::asr",
  "transcript-agent.transcribe::asr",
  "video-agent.v2d.transcribe::asr",
  "video-agent.video-to-text::asr",
  "video-agent.videogen::video-gen"
];
const gatewayDbName = __GATEWAY_DB__;
const recentLogHours = __RECENT_LOG_HOURS__;
const collectGatewayLogs = __COLLECT_GATEWAY_LOGS__;
const data = {
  generatedAt: new Date().toISOString(),
  gatewayDatabase: gatewayDbName,
  recentGatewayLogHours: recentLogHours,
  exchanges: db.model_exchanges.find({
    $or: [
      { TransformerType: /asr|video/i },
      { Name: /ASR|asr|视频|video|豆包|wan|seedance/i },
      { ModelAlias: /asr|wan|seedance/i },
      { ModelAliases: /asr|wan|seedance/i }
    ]
  }, {
    _id: 1,
    Name: 1,
    Enabled: 1,
    TransformerType: 1,
    TransformerConfig: 1,
    TargetAuthScheme: 1,
    TargetUrl: 1,
    ModelAlias: 1,
    ModelAliases: 1,
    Models: 1,
    TargetApiKeyEncrypted: 1,
    UpdatedAt: 1
  }).toArray(),
  modelGroups: db.model_groups.find({
    $or: [
      { ModelType: { $in: ["asr", "video-gen"] } },
      { Code: /asr|video/i },
      { Name: /ASR|asr|视频|video/i }
    ]
  }).toArray(),
  appCallers: db.llm_app_callers.find({
    AppCode: { $in: asrCallers }
  }, {
    _id: 1,
    AppCode: 1,
    DisplayName: 1,
    ModelRequirements: 1,
    UpdatedAt: 1
  }).toArray(),
  platforms: [],
  recentGatewayLogs: []
};
const platformIds = Array.from(new Set(
  data.modelGroups
    .flatMap(g => g.Models || [])
    .map(m => m.PlatformId)
    .filter(id => !!id)
));
if (platformIds.length > 0) {
  data.platforms = db.llmplatforms.find({
    _id: { $in: platformIds }
  }, {
    _id: 1,
    Name: 1,
    PlatformType: 1,
    ProviderId: 1,
    ApiUrl: 1,
    Enabled: 1,
    MaxConcurrency: 1,
    ApiKeyEncrypted: 1,
    UpdatedAt: 1
  }).toArray();
}
if (collectGatewayLogs) {
try {
  const gatewayDb = db.getSiblingDB(gatewayDbName);
  const since = new Date(Date.now() - recentLogHours * 60 * 60 * 1000);
  data.recentGatewayLogs = gatewayDb.llmrequestlogs.find({
    AppCallerCode: { $in: asrCallers },
    $or: [
      { StartedAt: { $gte: since } },
      { CreatedAt: { $gte: since } },
      { startedAt: { $gte: since } },
      { createdAt: { $gte: since } }
    ]
  }, {
    _id: 1,
    StartedAt: 1,
    CreatedAt: 1,
    AppCallerCode: 1,
    RequestType: 1,
    GatewayTransport: 1,
    Model: 1,
    PlatformId: 1,
    PlatformName: 1,
    ModelGroupId: 1,
    ModelGroupName: 1,
    StatusCode: 1,
    Status: 1,
    AnswerText: 1,
    Error: 1
  }).sort({ StartedAt: -1, CreatedAt: -1 }).limit(50).toArray();
} catch (err) {
  data.recentGatewayLogError = String(err);
}
}
print(JSON.stringify(data));
'''
    js = (
        js
        .replace("__GATEWAY_DB__", gateway_db_literal)
        .replace("__RECENT_LOG_HOURS__", recent_log_hours_literal)
        .replace("__COLLECT_GATEWAY_LOGS__", collect_gateway_logs_literal)
    )
    cmd = _compose_cmd() + ["-f", compose_file, "exec", "-T", mongo_service, "mongosh", mongo_db, "--quiet", "--eval", js]
    return json.loads(_run(cmd))


def _load_snapshot(path: str) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _primary_secret(compose_file: str, api_service: str) -> str:
    compose = _compose_cmd()
    for key in ("ApiKeyCrypto__Secret", "Jwt__Secret"):
        proc = subprocess.run(
            compose + ["-f", compose_file, "exec", "-T", api_service, "sh", "-lc", f"printenv {key} || true"],
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode == 0 and proc.stdout.strip():
            return proc.stdout.strip()
    return os.environ.get("APIKEY_SECRET", "DefaultEncryptionKey32Bytes!!!!").strip()


def _decrypt_shape(encrypted: str, secret: str) -> dict[str, Any]:
    result: dict[str, Any] = {
        "decryptOk": False,
        "plainLength": 0,
        "containsPipe": False,
        "pipeParts": 0,
        "looksUuidOnly": False,
        "hasWhitespace": False,
    }
    if not encrypted or ":" not in encrypted:
        return result
    try:
        iv_b64, data_b64 = encrypted.split(":", 1)
        iv = base64.b64decode(iv_b64)
        data = base64.b64decode(data_b64)
        key = secret.ljust(32)[:32].encode("utf-8")
        proc = subprocess.run(
            ["openssl", "enc", "-aes-256-cbc", "-d", "-K", key.hex(), "-iv", iv.hex(), "-nopad"],
            input=data,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if proc.returncode != 0 or not proc.stdout:
            return result
        plain_bytes = proc.stdout
        pad = plain_bytes[-1]
        if pad < 1 or pad > 16 or plain_bytes[-pad:] != bytes([pad]) * pad:
            return result
        plain = plain_bytes[:-pad].decode("utf-8", "replace")
    except Exception:
        return result

    return {
        "decryptOk": bool(plain),
        "plainLength": len(plain),
        "containsPipe": "|" in plain,
        "pipeParts": len(plain.split("|")) if plain else 0,
        "looksUuidOnly": bool(re.fullmatch(r"[0-9a-fA-F-]{32,36}", plain)),
        "hasWhitespace": any(ch.isspace() for ch in plain),
    }


def _req_for(caller: dict[str, Any], model_type: str) -> dict[str, Any] | None:
    for req in caller.get("ModelRequirements") or []:
        if str(req.get("ModelType") or "").lower() == model_type.lower():
            return req
    return None


def _health_name(value: Any) -> str:
    try:
        num = int(value)
    except Exception:
        return str(value)
    return {
        0: "Healthy",
        1: "Degraded",
        2: "Unavailable",
        3: "Disabled",
    }.get(num, str(num))


def _classify_asr_seed_error(error: str, auth_scheme: str, shape: dict[str, Any]) -> str | None:
    normalized = error.lower()
    scheme = auth_scheme.strip() or "unknown"
    if "no available channels" in normalized:
        return "ASR upstream has no available channels; fix provider channel or ASR model pool before video/ASR canary."
    if "invalid x-api-key" in normalized or "invalid x api key" in normalized:
        key_shape = "single UUID x-api-key" if shape.get("looksUuidOnly") else "x-api-key"
        if shape.get("containsPipe"):
            key_shape = "appId|accessToken"
        return (
            "ASR upstream rejected credential: Invalid X-Api-Key "
            f"(authScheme={scheme}, keyShape={key_shape}). Replace the ASR exchange credential "
            "or switch TargetAuthScheme to DoubaoAsr only when the stored secret is appId|accessToken."
        )
    if "401" in normalized or "unauthorized" in normalized or "forbidden" in normalized or "403" in normalized:
        return f"ASR upstream authorization failed (authScheme={scheme}); verify ASR exchange credential and resourceId."
    return None


def _classify_video_seed_error(error: str, model_id: str | None = None) -> str | None:
    normalized = error.lower()
    model_suffix = f" for model {model_id}" if model_id else ""
    if "no available channels" in normalized:
        return (
            "Video upstream has no available channels"
            f"{model_suffix}; keep video/ASR canary blocked until the provider channel or model pool is fixed."
        )
    if "404" in normalized or "not found" in normalized:
        return f"Video upstream model or endpoint was not found{model_suffix}; verify provider route and model id before canary."
    if "401" in normalized or "unauthorized" in normalized or "forbidden" in normalized or "403" in normalized:
        return f"Video upstream authorization failed{model_suffix}; verify platform key and provider access."
    if "insufficient" in normalized and ("quota" in normalized or "balance" in normalized):
        return f"Video upstream quota or balance is insufficient{model_suffix}; fix provider billing before canary."
    return None


def _append_unique(items: list[str], value: str) -> None:
    if value not in items:
        items.append(value)


def _sanitize_exchange(exchange: dict[str, Any], secret: str | None) -> dict[str, Any]:
    encrypted = str(exchange.get("TargetApiKeyEncrypted") or "")
    clean = {k: v for k, v in exchange.items() if k != "TargetApiKeyEncrypted"}
    clean["targetApiKeyEncryptedLength"] = len(encrypted)
    if secret is not None:
        clean["targetApiKeyShape"] = _decrypt_shape(encrypted, secret)
    return clean


def _sanitize_platform(platform: dict[str, Any] | None, secret: str | None) -> dict[str, Any] | None:
    if not platform:
        return None
    encrypted = str(platform.get("ApiKeyEncrypted") or "")
    clean = {k: v for k, v in platform.items() if k != "ApiKeyEncrypted"}
    clean["apiKeyEncryptedLength"] = len(encrypted)
    if secret is not None:
        clean["apiKeyShape"] = _decrypt_shape(encrypted, secret)
    return clean


def _gateway_log_error_text(log: dict[str, Any]) -> str:
    parts = [
        str(log.get("Error") or ""),
        str(log.get("AnswerText") or ""),
        f"statusCode={log.get('StatusCode')}" if log.get("StatusCode") is not None else "",
    ]
    return "\n".join(part for part in parts if part).strip()


def _try_parse_json_prefix(text: str) -> Any | None:
    stripped = text.strip()
    if not stripped.startswith("{"):
        return None
    decoder = json.JSONDecoder()
    try:
        value, _ = decoder.raw_decode(stripped)
        return value
    except Exception:
        return None


def _extract_asr_diagnostic(error_text: str) -> dict[str, Any] | None:
    parsed = _try_parse_json_prefix(error_text)
    if not isinstance(parsed, dict):
        return None
    gateway = parsed.get("gateway")
    if not isinstance(gateway, dict):
        return None
    diagnostic = gateway.get("diagnostic")
    if not isinstance(diagnostic, dict):
        return None
    return diagnostic


def _summarize_asr_diagnostic(diagnostic: dict[str, Any] | None) -> dict[str, Any] | None:
    if not diagnostic:
        return None
    audio = diagnostic.get("Audio") or diagnostic.get("audio")
    return {
        "wsUrl": diagnostic.get("WsUrl") or diagnostic.get("wsUrl"),
        "resourceId": diagnostic.get("ResourceId") or diagnostic.get("resourceId"),
        "requestId": diagnostic.get("RequestId") or diagnostic.get("requestId"),
        "authMode": diagnostic.get("AuthMode") or diagnostic.get("authMode"),
        "handshakeStatusCode": diagnostic.get("HandshakeStatusCode") or diagnostic.get("handshakeStatusCode"),
        "hasAudio": isinstance(audio, dict),
        "hasRawErrorChain": bool(diagnostic.get("RawErrorChain") or diagnostic.get("rawErrorChain")),
        "hasFriendlyError": bool(diagnostic.get("FriendlyError") or diagnostic.get("friendlyError")),
        "hasWscatCommand": bool(diagnostic.get("WscatCommand") or diagnostic.get("wscatCommand")),
    }


def _is_uninitialized_asr_diagnostic(summary: dict[str, Any] | None) -> bool:
    if not summary:
        return True
    auth_mode = str(summary.get("authMode") or "")
    return (
        auth_mode == "未初始化"
        or not summary.get("resourceId")
        or not summary.get("requestId")
        or not summary.get("hasRawErrorChain")
    )


def _is_failed_gateway_log(log: dict[str, Any]) -> bool:
    status = str(log.get("Status") or "").lower()
    if status == "failed":
        return True
    try:
        return int(log.get("StatusCode") or 0) >= 400
    except Exception:
        return False


def _summarize_gateway_log(
    log: dict[str, Any],
    classification: str | None = None,
    asr_diagnostic: dict[str, Any] | None = None,
) -> dict[str, Any]:
    text = _gateway_log_error_text(log)
    summary = {
        "id": str(log.get("_id") or ""),
        "startedAt": log.get("StartedAt") or log.get("CreatedAt"),
        "appCaller": log.get("AppCallerCode"),
        "requestType": log.get("RequestType"),
        "transport": log.get("GatewayTransport"),
        "status": log.get("Status"),
        "statusCode": log.get("StatusCode"),
        "model": log.get("Model"),
        "platformName": log.get("PlatformName"),
        "modelGroupId": log.get("ModelGroupId"),
        "error": text[:500],
        "classification": classification,
    }
    if asr_diagnostic is not None:
        summary["asrDiagnostic"] = asr_diagnostic
    return summary


def _audit(
    data: dict[str, Any],
    secret: str | None,
    seed_evidence: dict[str, Any] | None,
    asr_pool_id: str,
    asr_model_id: str,
    asr_transformer: str,
) -> dict[str, Any]:
    failures: list[str] = []
    warnings: list[str] = []
    exchanges = data.get("exchanges") or []
    groups = data.get("modelGroups") or []
    callers = data.get("appCallers") or []
    platforms = data.get("platforms") or []
    recent_gateway_logs = data.get("recentGatewayLogs") or []

    by_platform_id = {str(x.get("_id")): x for x in platforms}
    asr_exchange = next(
        (
            x for x in exchanges
            if str(x.get("TransformerType") or "") == asr_transformer
            and (
                str(x.get("ModelAlias") or "") == asr_model_id
                or asr_model_id in (x.get("ModelAliases") or [])
                or any(str(m.get("ModelId") or "") == asr_model_id for m in (x.get("Models") or []))
            )
        ),
        None,
    )
    if not asr_exchange:
        failures.append(f"ASR exchange missing for transformer={asr_transformer} model={asr_model_id}")
        asr_clean = None
        shape = {}
    else:
        asr_clean = _sanitize_exchange(asr_exchange, secret)
        shape = asr_clean.get("targetApiKeyShape") or {}
        if asr_exchange.get("Enabled") is not True:
            failures.append("ASR exchange is not enabled")
        if asr_transformer == "doubao-asr" and not str(asr_exchange.get("TargetUrl") or "").startswith("https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit"):
            warnings.append("ASR exchange TargetUrl is not the expected Doubao BigModel submit endpoint")
        if asr_transformer == "doubao-asr-stream" and not str(asr_exchange.get("TargetUrl") or "").startswith("wss://openspeech.bytedance.com/api/v3/sauc/"):
            warnings.append("ASR stream exchange TargetUrl is not the expected Doubao WebSocket endpoint")
        if not (asr_exchange.get("TransformerConfig") or {}).get("resourceId"):
            failures.append("ASR exchange TransformerConfig.resourceId is missing")
        if secret is not None and not shape.get("decryptOk"):
            failures.append("ASR exchange key cannot be decrypted by current ApiKeyCrypto key ring")
        if shape.get("containsPipe") and str(asr_exchange.get("TargetAuthScheme") or "").lower() in {"xapikey", "x-api-key"}:
            failures.append("ASR key looks like appId|accessToken but TargetAuthScheme is XApiKey; use DoubaoAsr")
        if shape.get("looksUuidOnly") and str(asr_exchange.get("TargetAuthScheme") or "").lower() not in {"xapikey", "x-api-key"}:
            warnings.append("ASR key looks like a single UUID but TargetAuthScheme is not XApiKey")

    asr_pool = next((g for g in groups if str(g.get("_id")) == asr_pool_id), None)
    if not asr_pool:
        failures.append(f"ASR pool missing: {asr_pool_id}")
    else:
        models = asr_pool.get("Models") or []
        match = next((m for m in models if str(m.get("ModelId") or "") == asr_model_id), None)
        if not match:
            failures.append(f"ASR pool {asr_pool_id} does not contain model {asr_model_id}")
        else:
            if asr_exchange and str(match.get("PlatformId") or "") != str(asr_exchange.get("_id") or ""):
                failures.append("ASR pool model PlatformId does not point to the selected ASR exchange")
            if int(match.get("HealthStatus") or 0) != 0:
                failures.append(f"ASR pool model is not Healthy: {_health_name(match.get('HealthStatus'))}")

    by_caller = {str(c.get("AppCode") or ""): c for c in callers}
    for code in ASR_APP_CALLERS:
        caller = by_caller.get(code)
        if not caller:
            failures.append(f"ASR appCaller missing: {code}")
            continue
        req = _req_for(caller, "asr")
        ids = [str(x) for x in ((req or {}).get("ModelGroupIds") or [])]
        if not req or asr_pool_id not in ids:
            failures.append(f"ASR appCaller is not bound to {asr_pool_id}: {code}")

    video_caller = by_caller.get(VIDEO_APP_CALLER)
    if not video_caller:
        failures.append(f"video appCaller missing: {VIDEO_APP_CALLER}")
    else:
        req = _req_for(video_caller, "video-gen")
        ids = [str(x) for x in ((req or {}).get("ModelGroupIds") or [])]
        if not ids:
            failures.append(f"video appCaller has no video-gen ModelGroupIds: {VIDEO_APP_CALLER}")

    video_groups = [g for g in groups if str(g.get("ModelType") or "").lower() == "video-gen"]
    healthy_video_models: list[dict[str, Any]] = []
    video_models: list[dict[str, Any]] = []
    for group in video_groups:
        for model in group.get("Models") or []:
            platform = by_platform_id.get(str(model.get("PlatformId") or ""))
            model_info = {
                "groupId": group.get("_id"),
                "groupName": group.get("Name"),
                "modelId": model.get("ModelId"),
                "platformId": model.get("PlatformId"),
                "platformName": (platform or {}).get("Name"),
                "healthStatus": _health_name(model.get("HealthStatus")),
                "lastFailedAt": model.get("LastFailedAt"),
                "lastSuccessAt": model.get("LastSuccessAt"),
                "consecutiveFailures": model.get("ConsecutiveFailures"),
                "platform": _sanitize_platform(platform, secret),
            }
            video_models.append(model_info)
            if not platform:
                failures.append(f"video model platform missing: model={model.get('ModelId')} platform={model.get('PlatformId')}")
            else:
                clean_platform = model_info.get("platform") or {}
                platform_shape = clean_platform.get("apiKeyShape") or {}
                if platform.get("Enabled") is not True:
                    failures.append(f"video model platform is disabled: model={model.get('ModelId')} platform={platform.get('Name')}")
                if secret is not None and not platform_shape.get("decryptOk"):
                    failures.append(f"video model platform key cannot be decrypted: model={model.get('ModelId')} platform={platform.get('Name')}")
            if int(model.get("HealthStatus") or 0) == 0:
                healthy_video_models.append({
                    "groupId": group.get("_id"),
                    "groupName": group.get("Name"),
                    "modelId": model.get("ModelId"),
                    "platformId": model.get("PlatformId"),
                    "platformName": (platform or {}).get("Name"),
                })
    if not healthy_video_models:
        failures.append("no Healthy video-gen model in production model_groups")

    seed_summary = None
    if seed_evidence:
        failed = [s for s in seed_evidence.get("steps", []) if not s.get("ok")]
        asr_classifications: list[dict[str, str]] = []
        video_classifications: list[dict[str, str]] = []
        seed_summary = {
            "ok": bool(seed_evidence.get("ok")),
            "failedStepCount": len(failed),
            "failedSteps": [
                {
                    "name": s.get("name"),
                    "error": str(s.get("error") or "")[:500],
                }
                for s in failed
            ],
            "asrClassifications": asr_classifications,
            "videoClassifications": video_classifications,
            "expectedGrowth": seed_evidence.get("expectedGrowth"),
            "summaries": seed_evidence.get("summaries"),
        }
        for step in failed:
            name = str(step.get("name") or "")
            error = str(step.get("error") or "")
            if "asr" in name:
                failures.append(f"seed evidence ASR failed: {name}")
                classification = _classify_asr_seed_error(
                    error,
                    str((asr_exchange or {}).get("TargetAuthScheme") or ""),
                    shape,
                )
                if classification:
                    _append_unique(failures, classification)
                    asr_classifications.append({
                        "step": name,
                        "classification": classification,
                    })
            if "video" in name:
                failures.append(f"seed evidence video failed: {name}")
                classification = _classify_video_seed_error(error)
                if classification:
                    _append_unique(failures, classification)
                    video_classifications.append({
                        "step": name,
                        "classification": classification,
                    })

    recent_failed_logs: list[dict[str, Any]] = []
    asr_log_classifications: list[dict[str, str]] = []
    video_log_classifications: list[dict[str, str]] = []
    for log in recent_gateway_logs:
        if not _is_failed_gateway_log(log):
            continue
        app_code = str(log.get("AppCallerCode") or "")
        model_id = str(log.get("Model") or "")
        error_text = _gateway_log_error_text(log)
        classification = None
        if app_code in ASR_APP_CALLERS:
            failures.append(f"recent gateway log ASR failed: {app_code} model={model_id} statusCode={log.get('StatusCode')}")
            classification = _classify_asr_seed_error(
                error_text,
                str((asr_exchange or {}).get("TargetAuthScheme") or ""),
                shape,
            )
            asr_diagnostic = _summarize_asr_diagnostic(_extract_asr_diagnostic(error_text))
            if "doubao-asr-stream" in model_id or "doubao-asr-stream" in error_text:
                if _is_uninitialized_asr_diagnostic(asr_diagnostic):
                    diagnostic_failure = (
                        "ASR stream gateway log has missing or uninitialized diagnostic; "
                        "deploy the diagnostic build and rerun ASR seed before video/ASR canary."
                    )
                    _append_unique(failures, diagnostic_failure)
                    if classification:
                        classification = f"{classification} {diagnostic_failure}"
                    else:
                        classification = diagnostic_failure
            if classification:
                _append_unique(failures, classification)
                asr_log_classifications.append({
                    "logId": str(log.get("_id") or ""),
                    "classification": classification,
                    "diagnostic": asr_diagnostic,
                })
        if app_code == VIDEO_APP_CALLER:
            failures.append(f"recent gateway log video failed: {app_code} model={model_id} statusCode={log.get('StatusCode')}")
            classification = _classify_video_seed_error(error_text, model_id)
            if classification:
                _append_unique(failures, classification)
                video_log_classifications.append({
                    "logId": str(log.get("_id") or ""),
                    "classification": classification,
                })
        if app_code in ASR_APP_CALLERS or app_code == VIDEO_APP_CALLER:
            recent_failed_logs.append(_summarize_gateway_log(
                log,
                classification,
                asr_diagnostic if app_code in ASR_APP_CALLERS else None,
            ))

    report = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "snapshotGeneratedAt": data.get("generatedAt"),
        "verdict": "fail" if failures else "pass",
        "failures": failures,
        "warnings": warnings,
        "asr": {
            "exchange": _sanitize_exchange(asr_exchange, secret) if asr_exchange else None,
            "poolId": asr_pool_id,
            "modelId": asr_model_id,
            "transformer": asr_transformer,
            "appCallers": ASR_APP_CALLERS,
        },
        "video": {
            "appCaller": VIDEO_APP_CALLER,
            "groupCount": len(video_groups),
            "models": video_models,
            "healthyModels": healthy_video_models,
        },
        "recentGatewayLogs": {
            "database": data.get("gatewayDatabase"),
            "hours": data.get("recentGatewayLogHours"),
            "collected": len(recent_gateway_logs),
            "failed": recent_failed_logs,
            "asrClassifications": asr_log_classifications,
            "videoClassifications": video_log_classifications,
            "error": data.get("recentGatewayLogError"),
        },
        "seedEvidence": seed_summary,
    }
    return report


def _write_json(path: str, report: dict[str, Any]) -> None:
    if not path:
        return
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2, sort_keys=True)
        fh.write("\n")


def _write_md(path: str, report: dict[str, Any]) -> None:
    if not path:
        return
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("# LLM Gateway Provider Config Audit\n\n")
        fh.write(f"- generatedAt: `{report.get('generatedAt')}`\n")
        fh.write(f"- verdict: `{report.get('verdict')}`\n")
        asr = report.get("asr") or {}
        fh.write(f"- ASR pool: `{asr.get('poolId') or ''}`\n")
        fh.write(f"- ASR model: `{asr.get('modelId') or ''}`\n")
        fh.write(f"- ASR transformer: `{asr.get('transformer') or ''}`\n")
        fh.write(f"- ASR exchange: `{((report.get('asr') or {}).get('exchange') or {}).get('name') or ((report.get('asr') or {}).get('exchange') or {}).get('Name') or ''}`\n")
        fh.write(f"- video candidate models: `{len((report.get('video') or {}).get('models') or [])}`\n")
        fh.write(f"- video healthy models: `{len((report.get('video') or {}).get('healthyModels') or [])}`\n\n")
        recent = report.get("recentGatewayLogs") or {}
        fh.write(f"- recent gateway log hours: `{recent.get('hours') or ''}`\n")
        fh.write(f"- recent gateway log collected: `{recent.get('collected') or 0}`\n")
        fh.write(f"- recent gateway log failed: `{len(recent.get('failed') or [])}`\n\n")
        fh.write("## Failures\n\n")
        failures = report.get("failures") or []
        if failures:
            for item in failures:
                fh.write(f"- {item}\n")
        else:
            fh.write("- none\n")
        fh.write("\n## Warnings\n\n")
        warnings = report.get("warnings") or []
        if warnings:
            for item in warnings:
                fh.write(f"- {item}\n")
        else:
            fh.write("- none\n")


def main() -> int:
    parser = argparse.ArgumentParser(description="LLM Gateway production provider config audit")
    parser.add_argument("--compose-file", default=os.environ.get("LLMGW_PROVIDER_AUDIT_COMPOSE_FILE", "docker-compose.yml"))
    parser.add_argument("--mongo-service", default=os.environ.get("LLMGW_PROVIDER_AUDIT_MONGO_SERVICE", "mongodb"))
    parser.add_argument("--api-service", default=os.environ.get("LLMGW_PROVIDER_AUDIT_API_SERVICE", "api"))
    parser.add_argument("--mongo-db", default=os.environ.get("LLMGW_PROVIDER_AUDIT_DB", "prdagent"))
    parser.add_argument("--gateway-db", default=os.environ.get("LLMGW_PROVIDER_AUDIT_GATEWAY_DB", "llm_gateway"))
    parser.add_argument("--recent-log-hours", type=int, default=int(os.environ.get("LLMGW_PROVIDER_AUDIT_RECENT_LOG_HOURS", "24")))
    parser.add_argument("--skip-gateway-logs", action="store_true", help="Do not collect recent llm_gateway request logs")
    parser.add_argument("--asr-pool-id", default=os.environ.get("LLMGW_PROVIDER_AUDIT_ASR_POOL_ID", DEFAULT_ASR_POOL_ID))
    parser.add_argument("--asr-model-id", default=os.environ.get("LLMGW_PROVIDER_AUDIT_ASR_MODEL_ID", DEFAULT_ASR_MODEL_ID))
    parser.add_argument("--asr-transformer", default=os.environ.get("LLMGW_PROVIDER_AUDIT_ASR_TRANSFORMER", DEFAULT_ASR_TRANSFORMER))
    parser.add_argument("--input-json", default="", help="Optional pre-collected Mongo snapshot JSON")
    parser.add_argument("--seed-evidence-json", default="", help="Optional llmgw-map-shadow-seed evidence JSON")
    parser.add_argument("--skip-key-shape", action="store_true", help="Do not decrypt key shape metadata")
    parser.add_argument("--json-out", default="")
    parser.add_argument("--report-md", default="")
    parser.add_argument("--print-json", action="store_true")
    args = parser.parse_args()

    try:
        data = _load_snapshot(args.input_json) if args.input_json else _mongo_snapshot(
            args.compose_file,
            args.mongo_service,
            args.mongo_db,
            args.gateway_db,
            args.recent_log_hours,
            not args.skip_gateway_logs,
        )
        secret = None if args.skip_key_shape else _primary_secret(args.compose_file, args.api_service)
        seed_evidence = _load_snapshot(args.seed_evidence_json) if args.seed_evidence_json else None
        report = _audit(
            data,
            secret,
            seed_evidence,
            args.asr_pool_id.strip(),
            args.asr_model_id.strip(),
            args.asr_transformer.strip(),
        )
    except Exception as exc:
        report = {
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "verdict": "fail",
            "failures": [str(exc)],
            "warnings": [],
        }

    _write_json(args.json_out, report)
    _write_md(args.report_md, report)
    if args.print_json:
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        print(f"LLM Gateway provider config audit: {str(report.get('verdict')).upper()}")
        for item in report.get("failures") or []:
            print(f"- {item}")
    return 1 if report.get("verdict") != "pass" else 0


if __name__ == "__main__":
    raise SystemExit(main())
