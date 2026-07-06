#!/usr/bin/env python3
"""LLM Gateway production preflight.

This script is a read-only operator check for the full-cutover release path. It
does not deploy or mutate data. It verifies that the operator has enough
production access to inspect MAP logs, probe llmgw-serve, and audit the rollout
ledger before claiming a full HTTP cutover is complete.
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
from datetime import datetime, timezone
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
    version_ok = version["ok"] and (not expected or commit.lower() == expected)
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
        checks.append({"name": "map_logs_scope", "ok": False, "detail": f"missing {args.map_key_env} or PRD_AGENT_API_KEY"})
        return checks

    logs_url = f"{base}/api/logs/llm?" + urllib.parse.urlencode({"page": 1, "pageSize": 10})
    logs = _http_json(logs_url, headers={"Authorization": f"Bearer {key}", "Accept": "application/json"}, timeout=args.timeout)
    payload = logs.get("payload") if isinstance(logs.get("payload"), dict) else {}
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    error = payload.get("error") if isinstance(payload.get("error"), dict) else {}
    total = data.get("total") if isinstance(data, dict) else None
    checks.append({
        "name": "map_logs_scope",
        "ok": logs["ok"] and isinstance(total, int),
        "detail": json.dumps({
            "status": logs["status"],
            "keyEnv": key_name,
            "total": total,
            "errorCode": error.get("code"),
            "errorMessage": error.get("message"),
        }, ensure_ascii=False),
    })
    return checks


def _gateway_checks(args: argparse.Namespace) -> list[dict]:
    checks: list[dict] = []
    base = (args.gw_base or os.environ.get("LLMGW_GATE_BASE") or os.environ.get("GW_BASE") or "").strip().rstrip("/")
    key_env_names = [args.gw_key_env, "LLMGW_GATE_KEY", "GW_KEY", "LLMGW_SERVE_KEY"]
    key_name, key = _env_first(key_env_names)
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
    health_ok = health["ok"] and (not expected or commit.lower() == expected)
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
    parser.add_argument("--map-base", default="")
    parser.add_argument("--map-key-env", default="PRD_AGENT_API_KEY")
    parser.add_argument("--gw-base", default="")
    parser.add_argument("--gw-key-env", default="LLMGW_GATE_KEY")
    parser.add_argument("--expect-commit", default="")
    parser.add_argument("--rollout-ledger", default=os.environ.get("LLMGW_ROLLOUT_LEDGER", ".llmgw-release-evidence/rollout-ledger.jsonl"))
    parser.add_argument("--rollout-target-stage", default=os.environ.get("LLMGW_ROLLOUT_TARGET_STAGE", "http-full"))
    parser.add_argument("--rollout-min-observation-hours", type=float, default=float(os.environ.get("LLMGW_STAGE_MIN_OBSERVATION_HOURS", "24")))
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
