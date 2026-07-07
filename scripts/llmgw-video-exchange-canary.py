#!/usr/bin/env python3
"""Volcengine video exchange canary for LLM Gateway.

The canary submits one video task through /gw/v1/raw and writes the raw gateway
response to evidence. By default it stops at submit for the lowest practical
blast radius. With --poll-status and --download-result it also verifies the
status and signed-result download paths required by the full cutover gate.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_APP_CALLERS = [
    "video-agent.videogen::video-gen",
    "visual-agent.videogen::video-gen",
]
DEFAULT_MODEL = "doubao-seedance-2-0-fast-260128"
DEFAULT_PROMPT = "A five second minimal test video of a red cube rotating on a white background."
VOLCENGINE_MODEL_NOT_OPEN_CODE = "ModelNotOpen"


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
    req.add_header("User-Agent", "llmgw-video-exchange-canary/1.0")
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
            "gatewayResponse": {},
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
        "gatewayResponse": payload,
        "raw": text[:4000],
        "transportError": "",
    }


def _download_probe(url: str, timeout: int, max_bytes: int = 1_000_000) -> dict[str, Any]:
    req = urllib.request.Request(url, method="GET")
    req.add_header("User-Agent", "llmgw-video-exchange-canary/1.0")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            chunk = resp.read(max_bytes)
            return {
                "httpStatus": resp.status,
                "contentType": resp.headers.get("Content-Type", ""),
                "byteLengthSampled": len(chunk),
                "contentLength": resp.headers.get("Content-Length", ""),
                "transportError": "",
            }
    except urllib.error.HTTPError as exc:
        return {
            "httpStatus": exc.code,
            "contentType": exc.headers.get("Content-Type", ""),
            "byteLengthSampled": len(exc.read(min(max_bytes, 4096))),
            "contentLength": exc.headers.get("Content-Length", ""),
            "transportError": "",
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "httpStatus": 0,
            "contentType": "",
            "byteLengthSampled": 0,
            "contentLength": "",
            "transportError": f"{type(exc).__name__}: {str(exc)[:500]}",
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
    gateway = response.get("gatewayResponse") if isinstance(response.get("gatewayResponse"), dict) else {}
    http_status = int(response.get("httpStatus") or 0)
    success = bool(_get(gateway, "success"))
    status_code = int(_get(gateway, "statusCode") or 0)
    content = str(_get(gateway, "content") or "")
    error = " ".join([
        str(_get(gateway, "errorCode") or ""),
        str(_get(gateway, "errorMessage") or ""),
        content,
        str(response.get("transportError") or ""),
    ]).strip()
    normalized = error.lower()

    if http_status != 200:
        failures.append(f"gateway raw HTTP status is {http_status}")
    if success:
        return True, failures, warnings

    if "模型池内所有模型不可用" in error or ("all models" in normalized and "unavailable" in normalized):
        failures.append("video-gen model pool has no available model; restore pool health only after upstream activation passes.")
    elif VOLCENGINE_MODEL_NOT_OPEN_CODE.lower() in normalized or "has not activated the model" in normalized or "not activated the model" in normalized:
        failures.append("Volcengine Ark account has not activated the requested video model.")
    elif "no available channels" in normalized:
        failures.append("Video upstream has no available channels.")
    elif "401" in normalized or "403" in normalized or "unauthorized" in normalized or "forbidden" in normalized:
        failures.append("Video upstream authorization failed.")
    elif status_code >= 400:
        failures.append(f"video upstream returned HTTP {status_code}")
    else:
        failures.append("gateway raw video canary returned success=false")

    return False, failures, warnings


def _content_json(response: dict[str, Any]) -> dict[str, Any]:
    gateway = response.get("gatewayResponse") if isinstance(response.get("gatewayResponse"), dict) else {}
    content = _get(gateway, "content")
    if not isinstance(content, str) or not content.strip():
        return {}
    try:
        payload = json.loads(content)
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def _extract_job_id(response: dict[str, Any]) -> str:
    content = _content_json(response)
    return str(
        content.get("id")
        or content.get("generation_id")
        or content.get("task_id")
        or content.get("taskId")
        or ""
    ).strip()


def _extract_status(response: dict[str, Any]) -> str:
    content = _content_json(response)
    return str(content.get("status") or "").strip().lower()


def _extract_result_url(response: dict[str, Any]) -> str:
    content = _content_json(response)
    urls = content.get("unsigned_urls")
    if isinstance(urls, list) and urls:
        return str(urls[0] or "").strip()
    for key in ("video_url", "videoUrl", "result_url", "resultUrl", "download_url", "downloadUrl"):
        value = content.get(key)
        if value:
            return str(value).strip()
    return ""


def _status_request_body(args: argparse.Namespace, app_caller: str, job_id: str) -> dict[str, Any]:
    return {
        "appCallerCode": app_caller,
        "modelType": "video-gen",
        "expectedModel": args.model,
        "endpointPath": f"/videos/{job_id}",
        "httpMethod": "GET",
        "timeoutSeconds": args.timeout,
        "requestBody": {
            "_gateway_operation": "status",
            "task_id": job_id,
        },
        "context": {
            "requestId": "llmgw-video-status-canary-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"),
            "questionText": "LLM Gateway video exchange canary status",
        },
    }


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

    env_raw = os.environ.get("LLMGW_VIDEO_CANARY_APP_CALLERS", "").strip()
    if env_raw:
        return list(dict.fromkeys(_split_csv(env_raw)))

    single_env = os.environ.get("LLMGW_VIDEO_CANARY_APP_CALLER", "").strip()
    if single_env:
        return [single_env]

    return DEFAULT_APP_CALLERS.copy()


def _submit_request_body(args: argparse.Namespace) -> dict[str, Any]:
    return {
        "model": args.model,
        "prompt": args.prompt,
        "aspect_ratio": "16:9",
        "resolution": "720p",
        "duration": 5,
        "generate_audio": False,
    }


def _run_one_canary(args: argparse.Namespace, base: str, key: str, app_caller: str) -> dict[str, Any]:
    request_body = _submit_request_body(args)
    item: dict[str, Any] = {
        "appCallerCode": app_caller,
        "model": args.model,
        "verdict": "fail",
        "failures": [],
        "warnings": [],
        "request": {
            "endpointPath": "/videos",
            "httpMethod": "POST",
            "requestBody": request_body,
        },
    }
    body = {
        "appCallerCode": app_caller,
        "modelType": "video-gen",
        "expectedModel": args.model,
        "endpointPath": "/videos",
        "httpMethod": "POST",
        "timeoutSeconds": args.timeout,
        "requestBody": request_body,
        "context": {
            "requestId": "llmgw-video-canary-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"),
            "questionText": "LLM Gateway video exchange canary submit",
        },
    }
    response = _post_json(base + "/raw", key, body, args.timeout)
    ok, failures, warnings = _classify(response)
    item["gateway"] = response

    if ok and args.poll_status:
        job_id = _extract_job_id(response)
        item["jobId"] = job_id
        if not job_id:
            failures.append("video submit succeeded but response did not contain a job id.")
            ok = False
        else:
            status_history: list[dict[str, Any]] = []
            last_status_response: dict[str, Any] | None = None
            terminal_statuses = {"completed", "failed", "cancelled", "canceled", "expired"}
            for attempt in range(1, max(args.poll_attempts, 1) + 1):
                if attempt > 1:
                    time.sleep(max(args.poll_interval_seconds, 0))
                status_response = _post_json(
                    base + "/raw",
                    key,
                    _status_request_body(args, app_caller, job_id),
                    args.timeout,
                )
                last_status_response = status_response
                status_ok, status_failures, status_warnings = _classify(status_response)
                status = _extract_status(status_response)
                status_history.append({
                    "attempt": attempt,
                    "httpStatus": status_response.get("httpStatus"),
                    "gatewayStatusCode": _get(status_response.get("gatewayResponse") or {}, "statusCode"),
                    "gatewaySuccess": _get(status_response.get("gatewayResponse") or {}, "success"),
                    "status": status,
                    "failures": status_failures,
                    "warnings": status_warnings,
                })
                warnings.extend(status_warnings)
                if not status_ok:
                    failures.extend([f"video status poll failed: {detail}" for detail in status_failures])
                    ok = False
                    break
                if status in terminal_statuses:
                    ok = status == "completed"
                    if not ok:
                        failures.append(f"video status reached terminal failure state: {status}")
                    break
            else:
                ok = False
                failures.append(f"video status did not complete after {args.poll_attempts} attempts.")

            item["statusHistory"] = status_history
            if last_status_response is not None:
                item["lastStatusGateway"] = last_status_response

            if ok and args.download_result:
                result_url = _extract_result_url(last_status_response or {})
                item["resultUrlPresent"] = bool(result_url)
                if not result_url:
                    ok = False
                    failures.append("video completed but status response did not contain unsigned_urls or a video URL.")
                else:
                    download = _download_probe(result_url, args.timeout)
                    item["download"] = download
                    download_status = int(download.get("httpStatus") or 0)
                    sampled = int(download.get("byteLengthSampled") or 0)
                    if download_status < 200 or download_status >= 300 or sampled <= 0:
                        ok = False
                        failures.append(f"video result download probe failed: HTTP {download_status}, sampledBytes={sampled}.")

    item["failures"] = failures
    item["warnings"] = warnings
    item["verdict"] = "pass" if ok and not failures else "fail"
    return item


def main() -> int:
    parser = argparse.ArgumentParser(description="LLM Gateway Volcengine video exchange canary")
    parser.add_argument("--gw-base", default=os.environ.get("GW_BASE") or os.environ.get("LLMGW_GATE_BASE") or "")
    parser.add_argument("--gw-key-env", default=os.environ.get("LLMGW_VIDEO_CANARY_KEY_ENV", "LLMGW_SERVE_KEY/GW_KEY/LLMGW_GATE_KEY"))
    parser.add_argument(
        "--app-caller",
        action="append",
        default=[],
        help="Video appCallerCode to canary. May be repeated or comma-separated. Defaults to all production video callers.",
    )
    parser.add_argument("--model", default=os.environ.get("LLMGW_VIDEO_CANARY_MODEL", DEFAULT_MODEL))
    parser.add_argument("--prompt", default=os.environ.get("LLMGW_VIDEO_CANARY_PROMPT", DEFAULT_PROMPT))
    parser.add_argument("--timeout", type=int, default=int(os.environ.get("LLMGW_VIDEO_CANARY_TIMEOUT", "120")))
    parser.add_argument("--poll-status", action="store_true", default=os.environ.get("LLMGW_VIDEO_CANARY_POLL_STATUS", "").lower() in {"1", "true"})
    parser.add_argument("--poll-attempts", type=int, default=int(os.environ.get("LLMGW_VIDEO_CANARY_POLL_ATTEMPTS", "12")))
    parser.add_argument("--poll-interval-seconds", type=float, default=float(os.environ.get("LLMGW_VIDEO_CANARY_POLL_INTERVAL_SECONDS", "10")))
    parser.add_argument("--download-result", action="store_true", default=os.environ.get("LLMGW_VIDEO_CANARY_DOWNLOAD_RESULT", "").lower() in {"1", "true"})
    parser.add_argument("--json-out", default=os.environ.get("LLMGW_VIDEO_CANARY_JSON_OUT", ""))
    parser.add_argument("--print-json", action="store_true")
    args = parser.parse_args()
    if args.download_result:
        args.poll_status = True

    base = args.gw_base.strip().rstrip("/")
    key_env_names = [item.strip() for item in args.gw_key_env.replace(",", "/").split("/") if item.strip()]
    key_env, key = _env_first(key_env_names)
    app_callers = _resolve_app_callers(args)
    report: dict[str, Any] = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "gatewayBase": base,
        "gatewayKeyEnv": key_env,
        "appCallers": app_callers,
        "model": args.model,
        "verdict": "fail",
        "failures": [],
        "warnings": [],
        "pollStatus": bool(args.poll_status),
        "downloadResult": bool(args.download_result),
        "canaries": [],
    }

    if not base:
        report["failures"].append("missing --gw-base")
        _write_json(args.json_out, report)
        print("LLM Gateway video canary: FAIL")
        print("- missing --gw-base")
        return 2
    if not key:
        report["failures"].append(f"missing gateway key env: {args.gw_key_env}")
        _write_json(args.json_out, report)
        print("LLM Gateway video canary: FAIL")
        print(f"- missing gateway key env: {args.gw_key_env}")
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
        report["gateway"] = canaries[0].get("gateway")
        report["jobId"] = canaries[0].get("jobId")
        report["request"] = canaries[0].get("request")
    report["failures"] = all_failures
    report["warnings"] = all_warnings
    report["verdict"] = "pass" if canaries and not all_failures and all(item.get("verdict") == "pass" for item in canaries) else "fail"
    _write_json(args.json_out, report)

    print(f"LLM Gateway video canary: {report['verdict'].upper()}")
    for failure in all_failures:
        print(f"- {failure}")
    if args.print_json:
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if report["verdict"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
