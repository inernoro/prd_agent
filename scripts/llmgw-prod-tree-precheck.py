#!/usr/bin/env python3
"""Read-only production runner release tree precheck for LLM Gateway rollout."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


CRITICAL_PATHS = [
    "docker-compose.yml",
    "cds-compose.yml",
    "fast.sh",
    "exec_dep.sh",
    "execdep.sh",
    "deploy/nginx/Dockerfile",
    "deploy/nginx/nginx.conf",
    "deploy/nginx/conf.d/branches/_disconnected.conf",
    "deploy/nginx/conf.d/branches/_standalone.conf",
    "scripts/llmgw-prod-stage.sh",
    "scripts/llmgw-rollout-ledger.py",
    "scripts/llmgw-rollout-status.py",
    "scripts/llmgw-prod-preflight.py",
    "scripts/llmgw-upstream-readiness.py",
    "scripts/llmgw-prod-provider-config-audit.py",
    "scripts/llmgw-map-shadow-seed.py",
    "scripts/llmgw-report-agent-shadow-seed.py",
    "scripts/llmgw-shadow-coverage-report.py",
    "scripts/llmgw-shadow-sample-plan.py",
    "scripts/llmgw-video-exchange-canary.py",
    "scripts/llmgw-asr-http-canary.py",
    "scripts/llmgw-release-gate.py",
    "scripts/llmgw-serving-probe.py",
    "scripts/gw-smoke.py",
    "scripts/llmgw-disk-space-guard.sh",
    "scripts/llmgw-rollback-inproc.sh",
    "scripts/llmgw-restore-shadow-safe.sh",
]


def _json_dumps(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True)


def _run(args: list[str], *, input_bytes: bytes | None = None, check: bool = True) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(args, input=input_bytes, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=check)


def _git(args: list[str], *, check: bool = True) -> subprocess.CompletedProcess[bytes]:
    return _run(["git", *args], check=check)


def _git_text(args: list[str], *, check: bool = True) -> str:
    completed = _git(args, check=check)
    return completed.stdout.decode("utf-8", errors="replace").strip()


def _write(path: str, content: str) -> None:
    if not path:
        return
    output = Path(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(content, encoding="utf-8")


def _git_blob(commit: str, path: str) -> bytes | None:
    completed = _git(["show", f"{commit}:{path}"], check=False)
    if completed.returncode != 0:
        return None
    return completed.stdout


def _file_bytes(path: str) -> bytes | None:
    local_path = Path(path)
    if not local_path.is_file():
        return None
    return local_path.read_bytes()


def _short_status() -> dict[str, Any]:
    completed = _git(["status", "--porcelain"], check=False)
    if completed.returncode != 0:
        return {"available": False, "detail": completed.stderr.decode("utf-8", errors="replace").strip()}

    lines = [line for line in completed.stdout.decode("utf-8", errors="replace").splitlines() if line.strip()]
    tracked_dirty = [line for line in lines if not line.startswith("?? ")]
    untracked = [line for line in lines if line.startswith("?? ")]
    return {
        "available": True,
        "dirtyTrackedCount": len(tracked_dirty),
        "untrackedCount": len(untracked),
        "sample": lines[:30],
    }


def _compare_paths(commit: str) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []
    for path in CRITICAL_PATHS:
        local = _file_bytes(path)
        expected = _git_blob(commit, path)
        if local is None:
            checks.append({"path": path, "ok": False, "status": "missing-local"})
            continue
        if expected is None:
            checks.append({"path": path, "ok": False, "status": "missing-release"})
            continue
        checks.append({"path": path, "ok": local == expected, "status": "match" if local == expected else "differs"})
    return checks


def _self_test() -> int:
    expected = {
        "scripts/llmgw-prod-stage.sh",
        "scripts/llmgw-rollout-ledger.py",
        "scripts/llmgw-rollout-status.py",
        "scripts/llmgw-shadow-coverage-report.py",
        "scripts/llmgw-shadow-sample-plan.py",
        "scripts/llmgw-readiness-audit.py",
        "scripts/llmgw-release-gate.py",
        "scripts/gw-smoke.py",
    }
    missing = sorted(path for path in expected if path not in CRITICAL_PATHS and path != "scripts/llmgw-readiness-audit.py")
    if missing:
        print("LLM Gateway production tree precheck self-test: FAIL")
        print("missing critical paths: " + ", ".join(missing))
        return 1
    print("LLM Gateway production tree precheck self-test: PASS")
    return 0


def _report_markdown(report: dict[str, Any]) -> str:
    lines = [
        "# LLM Gateway production tree precheck",
        "",
        f"- verdict={report['verdict']}",
        f"- releaseCommit={report.get('releaseCommit', '')}",
        f"- allowMismatch={report.get('allowMismatch', False)}",
        f"- allowMismatchSource={report.get('allowMismatchSource', 'none')}",
        f"- localHead={report.get('localHead', '')}",
        f"- mainRef={report.get('mainRef', '')}",
        f"- mainSha={report.get('mainSha', '')}",
        "",
        "| item | progress | status | detail |",
        "|---|---:|---|---|",
    ]
    total = len(report.get("pathChecks", []))
    passed = sum(1 for item in report.get("pathChecks", []) if item.get("ok"))
    lines.append(f"| critical release files | {passed}/{total} | {'pass' if passed == total else 'fail'} | compared against release commit |")
    status = report.get("gitStatus", {})
    lines.append(
        "| local git status | 100% | info | "
        f"dirtyTracked={status.get('dirtyTrackedCount', 'n/a')} untracked={status.get('untrackedCount', 'n/a')} |"
    )
    for item in report.get("pathChecks", []):
        if item.get("ok"):
            continue
        lines.append(f"| {item.get('path')} | 0% | {item.get('status')} | local file must match release commit before execute=true |")
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="LLM Gateway production release tree precheck")
    parser.add_argument("--commit", required=False, default="")
    parser.add_argument("--main-ref", default="origin/main")
    parser.add_argument("--allow-mismatch", action="store_true")
    parser.add_argument("--json-out", default="")
    parser.add_argument("--report-md", default="")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        return _self_test()

    commit = args.commit.strip()
    if not commit:
        print("ERROR: --commit is required.", file=sys.stderr)
        return 2
    if len(commit) != 40 or any(ch not in "0123456789abcdefABCDEF" for ch in commit):
        print("ERROR: --commit must be a 40-char SHA.", file=sys.stderr)
        return 2

    generated_at = datetime.now(timezone.utc).isoformat()
    local_head = _git_text(["rev-parse", "HEAD"], check=False)
    main_sha = _git_text(["rev-parse", f"{args.main_ref}^{{commit}}"], check=False)
    commit_available = _git(["rev-parse", "--verify", f"{commit}^{{commit}}"], check=False).returncode == 0

    path_checks = _compare_paths(commit) if commit_available else []
    failures = [item for item in path_checks if not item.get("ok")]
    env_allow_raw = (os.environ.get("LLMGW_STAGE_ALLOW_RELEASE_TREE_MISMATCH") or "").strip().lower()
    legacy_env_allow_raw = (os.environ.get("LLMGW_STAGE_ALLOW_SCRIPT_TREE_MISMATCH") or "").strip().lower()
    env_allow = env_allow_raw in {"1", "true", "yes"}
    legacy_env_allow = legacy_env_allow_raw in {"1", "true", "yes"}
    allow_mismatch = args.allow_mismatch or env_allow or legacy_env_allow
    allow_mismatch_source = "none"
    if args.allow_mismatch and env_allow and legacy_env_allow:
        allow_mismatch_source = "arg+env+legacy-env"
    elif args.allow_mismatch and env_allow:
        allow_mismatch_source = "arg+env"
    elif args.allow_mismatch and legacy_env_allow:
        allow_mismatch_source = "arg+legacy-env"
    elif args.allow_mismatch:
        allow_mismatch_source = "arg"
    elif env_allow:
        allow_mismatch_source = "env"
    elif legacy_env_allow:
        allow_mismatch_source = "legacy-env"
    verdict = "pass" if commit_available and (not failures or allow_mismatch) else "fail"
    report = {
        "generatedAt": generated_at,
        "verdict": verdict,
        "releaseCommit": commit.lower(),
        "allowMismatch": allow_mismatch,
        "allowMismatchSource": allow_mismatch_source,
        "localHead": local_head,
        "mainRef": args.main_ref,
        "mainSha": main_sha,
        "commitAvailable": commit_available,
        "gitStatus": _short_status(),
        "pathChecks": path_checks,
        "failureCount": len(failures) if commit_available else 1,
    }

    _write(args.json_out, _json_dumps(report))
    _write(args.report_md, _report_markdown(report))

    print(f"LLM Gateway production tree precheck: {verdict.upper()} failures={report['failureCount']} allowMismatch={allow_mismatch} source={allow_mismatch_source}")
    if not commit_available:
        print(f"- release commit is not available locally: {commit}", file=sys.stderr)
    for item in failures[:20]:
        print(f"- {item['path']}: {item['status']}")
    return 0 if verdict == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
