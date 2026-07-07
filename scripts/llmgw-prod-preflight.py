#!/usr/bin/env python3
"""LLM Gateway production preflight.

This script is a read-only operator check for the full-cutover release path. It
does not deploy or mutate data. It verifies that the operator has enough
production access to inspect MAP logs, probe llmgw-serve, and audit the rollout
ledger before claiming a full HTTP cutover is complete. Use --mode start before
the first shadow-start stage, and --mode completion for the final release gate.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _env_first(names: list[str]) -> tuple[str, str]:
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return name, value
    return "", ""


def _join_unique(names: list[str]) -> str:
    seen: list[str] = []
    for name in names:
        if name and name not in seen:
            seen.append(name)
    return "/".join(seen)


def _http_json(url: str, headers: dict[str, str] | None = None, method: str = "GET", body: bytes | None = None, timeout: int = 30) -> dict:
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read(2_000_000)
            status = resp.status
    except urllib.error.HTTPError as exc:
        raw = exc.read(2_000_000)
        status = exc.code
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "status": 0, "error": f"{type(exc).__name__}: {str(exc)[:180]}"}

    try:
        payload = json.loads(raw.decode("utf-8"))
    except Exception:
        payload = {"raw": raw.decode("utf-8", "replace")[:500]}
    return {"ok": 200 <= status < 300, "status": status, "payload": payload}


def _redact_url(url: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    if not parsed.query:
        return url
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "?redacted", parsed.fragment))


def _payload_dict(value: object, name: str) -> dict:
    if isinstance(value, dict):
        child = value.get(name) or value.get(name[:1].upper() + name[1:])
        return child if isinstance(child, dict) else {}
    return {}


def _item_value(item: dict, *names: str) -> str:
    for name in names:
        value = item.get(name)
        if value is None:
            value = item.get(name[:1].upper() + name[1:])
        if value is not None:
            return str(value)
    return ""


def _direct_transport_check(args: argparse.Namespace, base: str, key_name: str, key: str) -> dict:
    if args.mode != "completion":
        return {
            "name": "map_direct_transport_deferred",
            "ok": True,
            "detail": "direct transport absence is enforced by completion mode",
        }

    since_hours = max(0.0, float(args.direct_transport_since_hours))
    page_size = min(max(10, int(args.direct_transport_page_size)), 200)
    max_pages = max(1, int(args.direct_transport_max_pages))
    from_dt = datetime.now(timezone.utc) - timedelta(hours=since_hours) if since_hours > 0 else None
    headers = {"Authorization": f"Bearer {key}", "Accept": "application/json"}

    total: int | None = None
    scanned = 0
    direct_samples: list[dict[str, str]] = []
    failures: list[str] = []

    for page in range(1, max_pages + 1):
        query: dict[str, object] = {"page": page, "pageSize": page_size}
        if from_dt:
            query["from"] = from_dt.isoformat()
        logs_url = f"{base}/api/logs/llm?" + urllib.parse.urlencode(query)
        logs = _http_json(logs_url, headers=headers, timeout=args.timeout)
        if not logs["ok"]:
            failures.append(f"page={page} status={logs['status']}")
            break

        payload = logs.get("payload") if isinstance(logs.get("payload"), dict) else {}
        data = _payload_dict(payload, "data")
        items = data.get("items") or data.get("Items") or []
        if not isinstance(items, list):
            failures.append(f"page={page} items_not_list")
            break

        total_value = data.get("total") if "total" in data else data.get("Total")
        if isinstance(total_value, int):
            total = total_value
        elif isinstance(total_value, str) and total_value.isdigit():
            total = int(total_value)
        elif total is None:
            total = len(items)

        scanned += len(items)
        for item in items:
            if not isinstance(item, dict):
                continue
            transport = _item_value(item, "gatewayTransport", "transport").strip().lower()
            if transport == "direct":
                direct_samples.append({
                    "requestId": _item_value(item, "requestId"),
                    "appCallerCode": _item_value(item, "appCallerCode"),
                    "provider": _item_value(item, "provider"),
                    "model": _item_value(item, "model"),
                    "startedAt": _item_value(item, "startedAt", "createdAt"),
                    "gatewayTransport": transport,
                })
                if len(direct_samples) >= 10:
                    break
        if direct_samples:
            break
        if len(items) == 0 or (total is not None and scanned >= total):
            break

    truncated = total is not None and scanned < total and not direct_samples and not failures
    ok = not failures and not direct_samples and not truncated
    return {
        "name": "map_direct_transport_absent",
        "ok": ok,
        "detail": json.dumps({
            "keyEnv": key_name,
            "directTransportSinceHours": since_hours,
            "from": from_dt.isoformat() if from_dt else None,
            "pageSize": page_size,
            "maxPages": max_pages,
            "scanned": scanned,
            "total": total,
            "truncated": truncated,
            "directCountInScanned": len(direct_samples),
            "directSamples": direct_samples,
            "failures": failures,
        }, ensure_ascii=False),
    }


def _map_checks(args: argparse.Namespace) -> list[dict]:
    checks: list[dict] = []
    base = (args.map_base or os.environ.get("PRD_AGENT_BASE", "")).strip().rstrip("/")
    key_name, key = _env_first([args.map_key_env, "PRD_AGENT_API_KEY"])
    if not base:
        checks.append({"name": "map_base_configured", "ok": False, "detail": "missing PRD_AGENT_BASE or --map-base"})
        return checks
    checks.append({"name": "map_base_configured", "ok": True, "detail": base})

    health = _http_json(f"{base}/health", timeout=args.timeout)
    checks.append({
        "name": "map_health",
        "ok": health["ok"],
        "detail": f"status={health['status']}",
    })

    version = _http_json(f"{base}/api/version", timeout=args.timeout)
    payload = version.get("payload") if isinstance(version.get("payload"), dict) else {}
    commit = str(payload.get("commit") or payload.get("commitSha") or "").strip()
    expected = (args.expect_commit or "").strip().lower()
    requires_expected_commit = args.mode == "completion"
    version_ok = version["ok"] and (not requires_expected_commit or not expected or commit.lower() == expected)
    checks.append({
        "name": "map_version_commit",
        "ok": version_ok,
        "detail": json.dumps({
            "status": version["status"],
            "commit": commit,
            "expectedCommit": expected,
        }, ensure_ascii=False),
    })

    if not key:
        if args.allow_missing_map_logs and args.mode == "start":
            checks.append({
                "name": "map_logs_scope_deferred",
                "ok": True,
                "detail": f"missing {args.map_key_env} or PRD_AGENT_API_KEY; deferred for initial shadow-start bootstrap",
            })
        else:
            checks.append({"name": "map_logs_scope", "ok": False, "detail": f"missing {args.map_key_env} or PRD_AGENT_API_KEY"})
        return checks

    logs_url = f"{base}/api/logs/llm?" + urllib.parse.urlencode({"page": 1, "pageSize": 10})
    logs = _http_json(logs_url, headers={"Authorization": f"Bearer {key}", "Accept": "application/json"}, timeout=args.timeout)
    payload = logs.get("payload") if isinstance(logs.get("payload"), dict) else {}
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    error = payload.get("error") if isinstance(payload.get("error"), dict) else {}
    total = data.get("total") if isinstance(data, dict) else None
    logs_ok = logs["ok"] and isinstance(total, int)
    checks.append({
        "name": "map_logs_scope" if logs_ok or not (args.allow_missing_map_logs and args.mode == "start") else "map_logs_scope_deferred",
        "ok": logs_ok or (args.allow_missing_map_logs and args.mode == "start"),
        "detail": json.dumps({
            "status": logs["status"],
            "keyEnv": key_name,
            "total": total,
            "errorCode": error.get("code"),
            "errorMessage": error.get("message"),
            "deferred": not logs_ok and args.allow_missing_map_logs and args.mode == "start",
        }, ensure_ascii=False),
    })
    if logs_ok:
        checks.append(_direct_transport_check(args, base, key_name, key))
    return checks


def _gateway_checks(args: argparse.Namespace) -> list[dict]:
    checks: list[dict] = []
    base = (args.gw_base or os.environ.get("LLMGW_GATE_BASE") or os.environ.get("GW_BASE") or "").strip().rstrip("/")
    key_env_names = [args.gw_key_env, "LLMGW_GATE_KEY", "GW_KEY", "LLMGW_SERVE_KEY"]
    key_name, key = _env_first(key_env_names)
    if args.allow_missing_gateway and args.mode == "start":
        checks.append({
            "name": "gateway_bootstrap_deferred",
            "ok": True,
            "detail": json.dumps({
                "reason": "initial shadow-start may deploy the gateway route for the first time; post-deploy serving probe remains required",
                "baseConfigured": bool(base),
                "keyConfigured": bool(key),
                "keyEnv": key_name,
            }, ensure_ascii=False),
        })
        return checks
    if not base:
        checks.append({"name": "gateway_base_configured", "ok": False, "detail": "missing LLMGW_GATE_BASE/GW_BASE or --gw-base"})
        checks.append({
            "name": "gateway_key_configured",
            "ok": bool(key),
            "detail": f"keyEnv={key_name}" if key else f"missing {_join_unique(key_env_names)}",
        })
        return checks
    checks.append({"name": "gateway_base_configured", "ok": True, "detail": _redact_url(base)})

    health = _http_json(f"{base}/healthz", timeout=args.timeout)
    payload = health.get("payload") if isinstance(health.get("payload"), dict) else {}
    commit = str(payload.get("commit") or payload.get("commitSha") or "").strip()
    expected = (args.expect_commit or "").strip().lower()
    requires_expected_commit = args.mode == "completion"
    health_ok = health["ok"] and (not requires_expected_commit or not expected or commit.lower() == expected)
    checks.append({
        "name": "gateway_health_commit",
        "ok": health_ok,
        "detail": json.dumps({
            "status": health["status"],
            "commit": commit,
            "expectedCommit": expected,
        }, ensure_ascii=False),
    })

    protected = _http_json(f"{base}/send", method="POST", body=b"{}", headers={"Content-Type": "application/json"}, timeout=args.timeout)
    checks.append({
        "name": "gateway_protected_requires_key",
        "ok": protected["status"] == 401,
        "detail": f"status={protected['status']}",
    })

    if not key:
        checks.append({"name": "gateway_key_configured", "ok": False, "detail": f"missing {_join_unique(key_env_names)}"})
    else:
        checks.append({"name": "gateway_key_configured", "ok": True, "detail": f"keyEnv={key_name}"})
    return checks


def _rollout_check(args: argparse.Namespace) -> dict:
    if args.mode == "start":
        return {"name": "rollout_ledger_start_ready", "ok": True, "detail": "rollout ledger completion is not required before shadow-start"}
    commit = (args.expect_commit or "").strip()
    if not commit:
        return {"name": "rollout_ledger_completion", "ok": False, "detail": "missing --expect-commit"}
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
        "--require-target-success",
    ]
    proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=args.timeout)
    detail = (proc.stderr or proc.stdout or "").strip()
    return {
        "name": "rollout_ledger_completion",
        "ok": proc.returncode == 0,
        "detail": detail[:4000],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="LLM Gateway production preflight")
    parser.add_argument("--mode", choices=["start", "completion"], default=os.environ.get("LLMGW_PROD_PREFLIGHT_MODE", "completion"))
    parser.add_argument("--map-base", default="")
    parser.add_argument("--map-key-env", default="PRD_AGENT_API_KEY")
    parser.add_argument(
        "--allow-missing-map-logs",
        action="store_true",
        help="Start-mode bootstrap escape hatch when a logs:read key is not available before the first shadow-start deploy.",
    )
    parser.add_argument("--gw-base", default="")
    parser.add_argument("--gw-key-env", default="LLMGW_GATE_KEY")
    parser.add_argument(
        "--allow-missing-gateway",
        action="store_true",
        help="Start-mode bootstrap escape hatch for the first shadow-start deploy. Gateway probes are deferred until post-deploy gates.",
    )
    parser.add_argument("--expect-commit", default="")
    parser.add_argument("--rollout-ledger", default=os.environ.get("LLMGW_ROLLOUT_LEDGER", ".llmgw-release-evidence/rollout-ledger.jsonl"))
    parser.add_argument("--rollout-target-stage", default=os.environ.get("LLMGW_ROLLOUT_TARGET_STAGE", "http-full"))
    parser.add_argument("--rollout-min-observation-hours", type=float, default=float(os.environ.get("LLMGW_STAGE_MIN_OBSERVATION_HOURS", "24")))
    parser.add_argument("--direct-transport-since-hours", type=float, default=float(os.environ.get("LLMGW_PROD_PREFLIGHT_DIRECT_TRANSPORT_SINCE_HOURS", "24")))
    parser.add_argument("--direct-transport-page-size", type=int, default=int(os.environ.get("LLMGW_PROD_PREFLIGHT_DIRECT_TRANSPORT_PAGE_SIZE", "200")))
    parser.add_argument("--direct-transport-max-pages", type=int, default=int(os.environ.get("LLMGW_PROD_PREFLIGHT_DIRECT_TRANSPORT_MAX_PAGES", "10")))
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--json-out", default=os.environ.get("LLMGW_PROD_PREFLIGHT_JSON_OUT", ""))
    args = parser.parse_args()

    checks = []
    checks.extend(_map_checks(args))
    checks.extend(_gateway_checks(args))
    checks.append(_rollout_check(args))

    report = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "verdict": "pass" if all(item.get("ok") for item in checks) else "fail",
        "mode": args.mode,
        "expectCommit": args.expect_commit,
        "checks": checks,
    }
    if args.json_out:
        path = Path(args.json_out)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if report["verdict"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
