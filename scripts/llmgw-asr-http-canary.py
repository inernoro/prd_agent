#!/usr/bin/env python3
"""Run a production ASR canary through MAP API -> llmgw-serve HTTP raw path.

The target API endpoint creates a tiny WAV file inside the API process, sends it
through HttpLlmGatewayClient, uploads it as MultipartFileRefs, and lets
llmgw-serve rehydrate and call the ASR upstream. This proves the cross-process
multipart path used by production ASR without exposing provider secrets.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_APP_CALLERS = [
    "document-store.subtitle::asr",
    "transcript-agent.transcribe::asr",
    "video-agent.v2d.transcribe::asr",
    "video-agent.video-to-text::asr",
]


def _env_first(names: list[str]) -> tuple[str, str]:
    for name in dict.fromkeys(names):
        value = os.environ.get(name, "").strip()
        if value:
            return name, value
    return "", ""


def _post_json(url: str, key: str, body: dict[str, Any], timeout: int) -> dict[str, Any]:
    req = urllib.request.Request(
        url,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        method="POST",
    )
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    req.add_header("User-Agent", "llmgw-asr-http-canary/1.0")
    req.add_header("X-Gateway-Key", key)

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read(2_000_000)
            status = resp.status
    except urllib.error.HTTPError as exc:
        raw = exc.read(2_000_000)
        status = exc.code
    except Exception as exc:  # noqa: BLE001
        return {
            "httpStatus": 0,
            "apiResponse": {},
            "raw": "",
            "transportError": f"{type(exc).__name__}: {str(exc)[:500]}",
        }

    text = raw.decode("utf-8", "replace")
    try:
        payload = json.loads(text)
    except Exception:
        payload = {"raw": text[:2000]}
    if not isinstance(payload, dict):
        payload = {"value": payload}
    return {
        "httpStatus": status,
        "apiResponse": payload,
        "raw": text[:4000],
        "transportError": "",
    }


def _get(payload: dict[str, Any], *names: str) -> Any:
    for name in names:
        if name in payload:
            return payload.get(name)
        alt = name[:1].upper() + name[1:]
        if alt in payload:
            return payload.get(alt)
    return None


def _classify(response: dict[str, Any]) -> tuple[bool, list[str], list[str]]:
    failures: list[str] = []
    warnings: list[str] = []
    api = response.get("apiResponse") if isinstance(response.get("apiResponse"), dict) else {}
    http_status = int(response.get("httpStatus") or 0)
    success = bool(_get(api, "success"))
    stage = str(_get(api, "stage") or "")
    status_code = int(_get(api, "statusCode") or 0)
    error = " ".join([
        str(_get(api, "errorCode") or ""),
        str(_get(api, "errorMessage") or ""),
        str(_get(api, "contentPreview") or ""),
        str(response.get("transportError") or ""),
        str(response.get("raw") or ""),
    ]).strip()
    normalized = error.lower()

    if http_status != 200:
        failures.append(f"MAP ASR canary endpoint HTTP status is {http_status}")
    if success:
        content = str(_get(api, "contentPreview") or "").strip()
        if not content:
            warnings.append("ASR canary succeeded with an empty transcript preview; silent WAV can produce empty text.")
        return True, failures, warnings

    if stage == "auth" or "gateway_key_invalid" in normalized:
        failures.append("MAP ASR canary endpoint rejected X-Gateway-Key; verify LlmGwServe:ApiKey alignment.")
    elif stage == "resolve" or "resolution_failed" in normalized:
        failures.append("ASR model resolution failed before HTTP raw send.")
    elif "multipart_storage_unavailable" in normalized:
        failures.append("MAP API process has no IAssetStorage for multipart refs.")
    elif "multipart_upload_failed" in normalized:
        failures.append("MAP API failed to upload ASR canary audio to object storage.")
    elif "multipart_ref_not_found" in normalized or "multipart_ref_hash_mismatch" in normalized:
        failures.append("llmgw-serve could not rehydrate ASR MultipartFileRefs from shared object storage.")
    elif "invalid x-api-key" in normalized or "401" in normalized or "unauthorized" in normalized:
        failures.append("ASR upstream rejected credential.")
    elif "no available channels" in normalized or "模型池内所有模型不可用" in error:
        failures.append("ASR model pool or upstream provider has no available channel.")
    elif "websocket" in normalized and ("auth" in normalized or "handshake" in normalized):
        failures.append("ASR stream WebSocket upstream handshake or auth failed.")
    elif status_code >= 400:
        failures.append(f"ASR upstream returned HTTP {status_code}.")
    else:
        failures.append("ASR HTTP canary returned success=false.")

    return False, failures, warnings


def _write_json(path: str, report: dict[str, Any]) -> None:
    if not path:
        return
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _split_csv(raw: str) -> list[str]:
    return [item.strip() for item in raw.replace(";", ",").split(",") if item.strip()]


def _resolve_app_callers(args: argparse.Namespace) -> list[str]:
    values: list[str] = []
    for raw in args.app_caller or []:
        values.extend(_split_csv(raw))
    if values:
        return list(dict.fromkeys(values))

    env_raw = os.environ.get("LLMGW_ASR_CANARY_APP_CALLERS", "").strip()
    if env_raw:
        return list(dict.fromkeys(_split_csv(env_raw)))

    single_env = os.environ.get("LLMGW_ASR_CANARY_APP_CALLER", "").strip()
    if single_env:
        return [single_env]

    return DEFAULT_APP_CALLERS.copy()


def _run_one_canary(args: argparse.Namespace, base: str, key: str, app_caller: str) -> dict[str, Any]:
    request_id = "llmgw-asr-canary-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    body: dict[str, Any] = {
        "appCallerCode": app_caller,
        "requestId": request_id,
        "timeoutSeconds": args.timeout,
    }
    if args.expected_model.strip():
        body["expectedModel"] = args.expected_model.strip()
    if args.pinned_platform_id.strip():
        body["pinnedPlatformId"] = args.pinned_platform_id.strip()
    if args.pinned_model_id.strip():
        body["pinnedModelId"] = args.pinned_model_id.strip()

    response = _post_json(base + "/api/ops/llmgw/canary/asr", key, body, args.timeout + 15)
    ok, failures, warnings = _classify(response)
    return {
        "appCallerCode": app_caller,
        "requestId": request_id,
        "api": response,
        "failures": failures,
        "warnings": warnings,
        "verdict": "pass" if ok and not failures else "fail",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="LLM Gateway ASR HTTP multipart canary")
    parser.add_argument("--api-base", default=os.environ.get("PRD_AGENT_BASE") or os.environ.get("MAP_BASE") or "")
    parser.add_argument("--key-env", default=os.environ.get("LLMGW_ASR_CANARY_KEY_ENV", "LLMGW_SERVE_KEY/GW_KEY/LLMGW_GATE_KEY"))
    parser.add_argument(
        "--app-caller",
        action="append",
        default=[],
        help="ASR appCallerCode to canary. May be repeated or comma-separated. Defaults to all production ASR callers.",
    )
    parser.add_argument("--expected-model", default=os.environ.get("LLMGW_ASR_CANARY_EXPECTED_MODEL", ""))
    parser.add_argument("--pinned-platform-id", default=os.environ.get("LLMGW_ASR_CANARY_PINNED_PLATFORM_ID", ""))
    parser.add_argument("--pinned-model-id", default=os.environ.get("LLMGW_ASR_CANARY_PINNED_MODEL_ID", ""))
    parser.add_argument("--timeout", type=int, default=int(os.environ.get("LLMGW_ASR_CANARY_TIMEOUT", "180")))
    parser.add_argument("--json-out", default=os.environ.get("LLMGW_ASR_CANARY_JSON_OUT", ""))
    parser.add_argument("--print-json", action="store_true")
    args = parser.parse_args()

    base = args.api_base.strip().rstrip("/")
    key_env_names = [item.strip() for item in args.key_env.replace(",", "/").split("/") if item.strip()]
    key_env, key = _env_first(key_env_names)
    app_callers = _resolve_app_callers(args)
    report: dict[str, Any] = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "apiBase": base,
        "gatewayKeyEnv": key_env,
        "appCallers": app_callers,
        "expectedModel": args.expected_model.strip() or None,
        "pinnedPlatformId": args.pinned_platform_id.strip() or None,
        "pinnedModelId": args.pinned_model_id.strip() or None,
        "verdict": "fail",
        "failures": [],
        "warnings": [],
        "canaries": [],
    }

    if not base:
        report["failures"].append("missing --api-base")
        _write_json(args.json_out, report)
        print("LLM Gateway ASR HTTP canary: FAIL")
        print("- missing --api-base")
        return 2
    if not key:
        report["failures"].append(f"missing gateway key env: {args.key_env}")
        _write_json(args.json_out, report)
        print("LLM Gateway ASR HTTP canary: FAIL")
        print(f"- missing gateway key env: {args.key_env}")
        return 2

    all_failures: list[str] = []
    all_warnings: list[str] = []
    canaries: list[dict[str, Any]] = []
    for app_caller in app_callers:
        item = _run_one_canary(args, base, key, app_caller)
        canaries.append(item)
        for failure in item.get("failures") or []:
            all_failures.append(f"{app_caller}: {failure}")
        for warning in item.get("warnings") or []:
            all_warnings.append(f"{app_caller}: {warning}")

    report["canaries"] = canaries
    if len(canaries) == 1:
        report["appCallerCode"] = canaries[0].get("appCallerCode")
        report["requestId"] = canaries[0].get("requestId")
        report["api"] = canaries[0].get("api")
    report["failures"] = all_failures
    report["warnings"] = all_warnings
    report["verdict"] = "pass" if canaries and not all_failures and all(item.get("verdict") == "pass" for item in canaries) else "fail"
    _write_json(args.json_out, report)

    print(f"LLM Gateway ASR HTTP canary: {report['verdict'].upper()}")
    for failure in all_failures:
        print(f"- {failure}")
    for warning in all_warnings:
        print(f"- warning: {warning}")
    if args.print_json:
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if report["verdict"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
