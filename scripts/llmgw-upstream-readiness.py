#!/usr/bin/env python3
"""LLM Gateway upstream resolution readiness gate.

This script is read-only. It calls /gw/v1/resolve for production-critical
AppCallerCode + ModelType pairs and verifies that the gateway can select a
usable model, platform, and protocol before a staged rollout enters video/ASR
or full HTTP cutover.

It does not replace raw shadow seed evidence. Provider-side channel failures
can only be proven by real MAP business requests, and key decryptability is
covered by the llmgw-serve ServingKeyIntegrity startup check. This gate catches
missing AppCaller bindings, empty pools, unavailable models, and disabled
platforms earlier and with lower cost.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]

DEFAULT_REQUIREMENTS = [
    "video-agent.videogen::video-gen=video-gen",
    "visual-agent.videogen::video-gen=video-gen",
    "document-store.subtitle::asr=asr",
    "transcript-agent.transcribe::asr=asr",
    "video-agent.v2d.transcribe::asr=asr",
    "video-agent.video-to-text::asr=asr",
]


def _default_base() -> str:
    for name in ("LLMGW_GATE_BASE", "GW_BASE"):
        value = os.environ.get(name, "").strip().rstrip("/")
        if value:
            return value

    try:
        proc = subprocess.run(
            ["python3", ".claude/skills/cds/cli/cdscli.py", "--human", "preview-url"],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        root = next((line.strip() for line in proc.stdout.splitlines() if line.startswith("http")), "")
        if root:
            return root.rstrip("/") + "/gw/v1"
    except Exception:
        return ""

    return ""


def _env_first(names: list[str]) -> tuple[str, str]:
    for name in dict.fromkeys(names):
        value = os.environ.get(name, "").strip()
        if value:
            return name, value
    return "", ""


def _join_unique(names: list[str]) -> str:
    return "/".join(dict.fromkeys(name for name in names if name))


def _get(payload: dict[str, Any], *names: str) -> Any:
    for name in names:
        if name in payload:
            return payload.get(name)
        alt = name[:1].upper() + name[1:]
        if alt in payload:
            return payload.get(alt)
    return None


def _parse_requirement(raw: str) -> dict[str, str]:
    value = raw.strip()
    if "=" not in value:
        raise ValueError(f"requirement must be appCallerCode=modelType: {raw}")
    app, model_type = value.rsplit("=", 1)
    app = app.strip()
    model_type = model_type.strip()
    if not app or not model_type:
        raise ValueError(f"requirement must be appCallerCode=modelType: {raw}")
    return {"appCallerCode": app, "modelType": model_type}


def _post_json(url: str, key: str, body: dict[str, Any], timeout: int) -> dict[str, Any]:
    raw_body = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=raw_body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    req.add_header("User-Agent", "llmgw-upstream-readiness/1.0")
    req.add_header("X-Gateway-Key", key)

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read(2_000_000)
            status = resp.status
    except urllib.error.HTTPError as exc:
        raw = exc.read(2_000_000)
        status = exc.code
    except Exception as exc:  # noqa: BLE001
        return {"httpStatus": 0, "payload": {}, "error": f"{type(exc).__name__}: {str(exc)[:300]}"}

    try:
        payload = json.loads(raw.decode("utf-8"))
    except Exception:
        payload = {"raw": raw.decode("utf-8", "replace")[:1000]}
    if not isinstance(payload, dict):
        payload = {"value": payload}
    return {"httpStatus": status, "payload": payload, "error": ""}


def _check_one(
    base: str,
    key: str,
    req: dict[str, str],
    *,
    timeout: int,
    allow_legacy: bool,
    allow_missing_api_key: bool,
    fail_on_degraded: bool,
) -> dict[str, Any]:
    body = {
        "appCallerCode": req["appCallerCode"],
        "modelType": req["modelType"],
    }
    result = _post_json(base.rstrip("/") + "/resolve", key, body, timeout)
    payload = result.get("payload") if isinstance(result.get("payload"), dict) else {}
    failures: list[str] = []
    warnings: list[str] = []

    if result.get("httpStatus") != 200:
        failures.append(f"resolve HTTP {result.get('httpStatus')}: {result.get('error') or str(payload)[:300]}")

    success = bool(_get(payload, "success"))
    resolution_type = str(_get(payload, "resolutionType") or "")
    actual_model = str(_get(payload, "actualModel") or "")
    platform_id = str(_get(payload, "actualPlatformId") or "")
    platform_name = str(_get(payload, "actualPlatformName") or "")
    protocol = str(_get(payload, "protocol") or "")
    health_status = str(_get(payload, "healthStatus") or "")
    api_key = _get(payload, "apiKey")
    api_key_present = isinstance(api_key, str) and bool(api_key.strip())
    error_message = str(_get(payload, "errorMessage") or "")

    if not success:
        failures.append(error_message or "resolve returned success=false")
    if not actual_model:
        failures.append("resolve did not return actualModel")
    if not platform_id:
        failures.append("resolve did not return actualPlatformId")
    if not protocol:
        failures.append("resolve did not return protocol")
    is_exchange = protocol.lower() == "exchange" or platform_name.lower().startswith("exchange:")
    if not api_key_present:
        warnings.append("resolve response does not expose apiKey; ServingKeyIntegrity covers decryptability")
    if not allow_missing_api_key and not api_key_present and not is_exchange:
        failures.append("resolve did not return a decrypted apiKey")
    if not allow_legacy and resolution_type.lower() == "legacy":
        failures.append("resolve used legacy fallback instead of model pool binding")

    health_lower = health_status.lower()
    if health_lower == "unavailable":
        failures.append("resolved model health is Unavailable")
    elif health_lower == "degraded":
        message = "resolved model health is Degraded"
        if fail_on_degraded:
            failures.append(message)
        else:
            warnings.append(message)

    return {
        "appCallerCode": req["appCallerCode"],
        "modelType": req["modelType"],
        "httpStatus": result.get("httpStatus"),
        "ok": not failures,
        "success": success,
        "resolutionType": resolution_type,
        "actualModel": actual_model,
        "actualPlatformId": platform_id,
        "actualPlatformName": platform_name,
        "protocol": protocol,
        "healthStatus": health_status,
        "apiKeyPresent": api_key_present,
        "warnings": warnings,
        "failures": failures,
    }


def _write_json(path: str, report: dict[str, Any]) -> None:
    if not path:
        return
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _write_markdown(path: str, report: dict[str, Any]) -> None:
    if not path:
        return
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)

    def cell(value: object) -> str:
        return str(value).replace("|", "\\|")

    lines = [
        "# LLM Gateway Upstream Readiness",
        "",
        f"- generatedAt: `{cell(report['generatedAt'])}`",
        f"- verdict: `{cell(report['verdict'])}`",
        f"- gatewayBase: `{cell(report['gatewayBase'])}`",
        f"- failOnDegraded: `{cell(report['failOnDegraded'])}`",
        f"- allowLegacy: `{cell(report['allowLegacy'])}`",
        "",
        "## Requirements",
        "",
        "| AppCallerCode | ModelType | OK | Resolution | Model | Platform | Protocol | Health | Key |",
        "|---|---:|---:|---|---|---|---|---|---:|",
    ]
    for item in report.get("checks") or []:
        lines.append(
            "| "
            + " | ".join([
                cell(item.get("appCallerCode", "")),
                cell(item.get("modelType", "")),
                cell(item.get("ok", "")),
                cell(item.get("resolutionType", "")),
                cell(item.get("actualModel", "")),
                cell(item.get("actualPlatformName", "") or item.get("actualPlatformId", "")),
                cell(item.get("protocol", "")),
                cell(item.get("healthStatus", "")),
                cell(item.get("apiKeyPresent", "")),
            ])
            + " |"
        )
    lines.extend(["", "## Failures", ""])
    failures = report.get("failures") or []
    if failures:
        lines.extend(f"- {failure}" for failure in failures)
    else:
        lines.append("- none")
    lines.append("")
    out.write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="LLM Gateway upstream resolution readiness gate")
    parser.add_argument("--gw-base", default=_default_base())
    parser.add_argument("--gw-key-env", default="LLMGW_GATE_KEY")
    parser.add_argument("--require", action="append", default=[], help="Required app caller in appCallerCode=modelType format")
    parser.add_argument("--allow-legacy", action="store_true")
    parser.add_argument("--allow-missing-api-key", action="store_true", default=True)
    parser.add_argument("--require-api-key", dest="allow_missing_api_key", action="store_false")
    parser.add_argument("--fail-on-degraded", action="store_true")
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--json-out", default=os.environ.get("LLMGW_UPSTREAM_READINESS_JSON_OUT", ""))
    parser.add_argument("--report-md", default=os.environ.get("LLMGW_UPSTREAM_READINESS_REPORT_MD", ""))
    args = parser.parse_args()

    base = args.gw_base.strip().rstrip("/")
    key_envs = [args.gw_key_env, "LLMGW_GATE_KEY", "GW_KEY", "LLMGW_SERVE_KEY"]
    key_name, key = _env_first(key_envs)
    failures: list[str] = []
    if not base:
        failures.append("missing --gw-base or LLMGW_GATE_BASE/GW_BASE")
    if not key:
        failures.append(f"missing {_join_unique(key_envs)}")

    requirements_raw = args.require or DEFAULT_REQUIREMENTS
    requirements: list[dict[str, str]] = []
    for raw in requirements_raw:
        try:
            requirements.append(_parse_requirement(raw))
        except ValueError as exc:
            failures.append(str(exc))

    checks: list[dict[str, Any]] = []
    if base and key and requirements:
        for req in requirements:
            check = _check_one(
                base,
                key,
                req,
                timeout=args.timeout,
                allow_legacy=args.allow_legacy,
                allow_missing_api_key=args.allow_missing_api_key,
                fail_on_degraded=args.fail_on_degraded,
            )
            checks.append(check)
            for failure in check.get("failures") or []:
                failures.append(f"{req['appCallerCode']}[{req['modelType']}]: {failure}")

    report = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "verdict": "pass" if not failures else "fail",
        "gatewayBase": base,
        "gatewayKeyEnv": key_name,
        "allowLegacy": bool(args.allow_legacy),
        "allowMissingApiKey": bool(args.allow_missing_api_key),
        "failOnDegraded": bool(args.fail_on_degraded),
        "requirements": requirements_raw,
        "checks": checks,
        "failures": failures,
    }
    _write_json(args.json_out, report)
    _write_markdown(args.report_md, report)

    if failures:
        for failure in failures:
            print(f"ERROR: {failure}", file=sys.stderr)
        return 1

    print(f"LLM Gateway upstream readiness: PASS ({len(checks)} requirements)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
