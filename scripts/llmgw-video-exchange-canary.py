#!/usr/bin/env python3
"""Minimal Volcengine video exchange canary for LLM Gateway.

The canary submits one video task through /gw/v1/raw and writes the raw gateway
response to evidence. It intentionally does not poll or download the generated
asset, so it verifies gateway routing and upstream task submission with the
lowest practical blast radius.
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


DEFAULT_APP_CALLER = "video-agent.videogen::video-gen"
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

    if VOLCENGINE_MODEL_NOT_OPEN_CODE.lower() in normalized or "has not activated the model" in normalized or "not activated the model" in normalized:
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


def _write_json(path: str, report: dict[str, Any]) -> None:
    if not path:
        return
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="LLM Gateway Volcengine video exchange canary")
    parser.add_argument("--gw-base", default=os.environ.get("GW_BASE") or os.environ.get("LLMGW_GATE_BASE") or "")
    parser.add_argument("--gw-key-env", default=os.environ.get("LLMGW_VIDEO_CANARY_KEY_ENV", "LLMGW_SERVE_KEY/GW_KEY/LLMGW_GATE_KEY"))
    parser.add_argument("--app-caller", default=os.environ.get("LLMGW_VIDEO_CANARY_APP_CALLER", DEFAULT_APP_CALLER))
    parser.add_argument("--model", default=os.environ.get("LLMGW_VIDEO_CANARY_MODEL", DEFAULT_MODEL))
    parser.add_argument("--prompt", default=os.environ.get("LLMGW_VIDEO_CANARY_PROMPT", DEFAULT_PROMPT))
    parser.add_argument("--timeout", type=int, default=int(os.environ.get("LLMGW_VIDEO_CANARY_TIMEOUT", "120")))
    parser.add_argument("--json-out", default=os.environ.get("LLMGW_VIDEO_CANARY_JSON_OUT", ""))
    parser.add_argument("--print-json", action="store_true")
    args = parser.parse_args()

    base = args.gw_base.strip().rstrip("/")
    key_env_names = [item.strip() for item in args.gw_key_env.replace(",", "/").split("/") if item.strip()]
    key_env, key = _env_first(key_env_names)
    report: dict[str, Any] = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "gatewayBase": base,
        "gatewayKeyEnv": key_env,
        "appCallerCode": args.app_caller,
        "model": args.model,
        "verdict": "fail",
        "failures": [],
        "warnings": [],
        "request": {
            "endpointPath": "/videos",
            "httpMethod": "POST",
            "requestBody": {
                "model": args.model,
                "prompt": args.prompt,
                "aspect_ratio": "16:9",
                "resolution": "720p",
                "duration": 5,
                "generate_audio": False,
            },
        },
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

    body = {
        "appCallerCode": args.app_caller,
        "modelType": "video-gen",
        "endpointPath": "/videos",
        "httpMethod": "POST",
        "timeoutSeconds": args.timeout,
        "requestBody": report["request"]["requestBody"],
        "context": {
            "requestId": "llmgw-video-canary-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"),
            "questionText": "LLM Gateway video exchange canary submit",
        },
    }
    response = _post_json(base + "/raw", key, body, args.timeout)
    ok, failures, warnings = _classify(response)
    report["gateway"] = response
    report["failures"] = failures
    report["warnings"] = warnings
    report["verdict"] = "pass" if ok and not failures else "fail"
    _write_json(args.json_out, report)

    print(f"LLM Gateway video canary: {report['verdict'].upper()}")
    for failure in failures:
        print(f"- {failure}")
    if args.print_json:
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if report["verdict"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
