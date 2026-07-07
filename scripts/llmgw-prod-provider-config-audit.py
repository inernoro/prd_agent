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


def _mongo_snapshot(compose_file: str, mongo_service: str, mongo_db: str) -> dict[str, Any]:
    js = r'''
const asrCallers = [
  "document-store.subtitle::asr",
  "transcript-agent.transcribe::asr",
  "video-agent.v2d.transcribe::asr",
  "video-agent.video-to-text::asr",
  "video-agent.videogen::video-gen"
];
const data = {
  generatedAt: new Date().toISOString(),
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
  }).toArray()
};
print(JSON.stringify(data));
'''
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

    by_exchange_id = {str(x.get("_id")): x for x in exchanges}
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
    for group in video_groups:
        for model in group.get("Models") or []:
            if int(model.get("HealthStatus") or 0) == 0:
                exchange = by_exchange_id.get(str(model.get("PlatformId") or ""))
                healthy_video_models.append({
                    "groupId": group.get("_id"),
                    "groupName": group.get("Name"),
                    "modelId": model.get("ModelId"),
                    "platformId": model.get("PlatformId"),
                    "platformName": (exchange or {}).get("Name"),
                })
    if not healthy_video_models:
        failures.append("no Healthy video-gen model in production model_groups")

    seed_summary = None
    if seed_evidence:
        failed = [s for s in seed_evidence.get("steps", []) if not s.get("ok")]
        asr_classifications: list[dict[str, str]] = []
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
            "healthyModels": healthy_video_models,
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
        fh.write(f"- video healthy models: `{len((report.get('video') or {}).get('healthyModels') or [])}`\n\n")
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
        data = _load_snapshot(args.input_json) if args.input_json else _mongo_snapshot(args.compose_file, args.mongo_service, args.mongo_db)
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
