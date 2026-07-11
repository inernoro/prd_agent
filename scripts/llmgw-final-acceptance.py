#!/usr/bin/env python3
"""Run the bounded, one-shot LLM Gateway production acceptance matrix."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


CELLS = ("text", "stream", "image", "vision", "asr", "video")
APP_CALLERS = {
    "text": "report-agent.generate::chat",
    "stream": "prd-agent-desktop.chat.sendmessage::chat",
    "image": "visual-agent.image-gen.generate::generation",
    "vision": "visual-agent.image.vision::generation",
    "asr": "transcript-agent.transcribe::asr",
    "video": "video-agent.videogen::video-gen",
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"invalid acceptance manifest: {path}")
    return value


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"missing required env: {name}")
    return value


def console_token(console_base: str) -> str:
    existing = os.environ.get("LLMGW_CONSOLE_TOKEN", "").strip()
    if existing:
        return existing
    password = require_env("LLMGW_CONSOLE_PASSWORD")
    body = json.dumps({"username": os.environ.get("LLMGW_CONSOLE_USERNAME", "admin"), "password": password}).encode()
    request = urllib.request.Request(console_base + "/auth/login", data=body, method="POST")
    request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))
    token = str(((payload.get("data") or {}).get("token") if isinstance(payload, dict) else "") or "")
    if not token:
        raise RuntimeError("GW console login did not return a token")
    return token


def get_json(url: str, token: str = "") -> dict[str, Any]:
    request = urllib.request.Request(url, method="GET")
    if token:
        request.add_header("Authorization", "Bearer " + token)
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError(f"expected JSON object from {url}")
    return payload


def verify_preflight(gw_base: str, console_base: str, token: str, commit: str) -> dict[str, Any]:
    health = get_json(gw_base + "/healthz")
    actual_commit = str(health.get("commit") or "").lower()
    if actual_commit != commit:
        raise RuntimeError(f"serving commit mismatch: expected={commit} actual={actual_commit or 'empty'}")
    lifecycle_payload = get_json(console_base + "/lifecycle/status", token)
    lifecycle = lifecycle_payload.get("data") if isinstance(lifecycle_payload.get("data"), dict) else {}
    latest = lifecycle.get("latestRun") if isinstance(lifecycle.get("latestRun"), dict) else {}
    if lifecycle.get("allIndexesReady") is not True or latest.get("status") != "applied":
        raise RuntimeError("lifecycle apply/index gate is not ready; paid acceptance requests are blocked")
    return {
        "servingCommit": actual_commit,
        "lifecycleRunId": latest.get("id"),
        "lifecycleStatus": latest.get("status"),
        "retentionIndexesReady": lifecycle.get("allIndexesReady"),
    }


def verify_http_log(console_base: str, token: str, app_caller: str, started_at: str) -> dict[str, Any]:
    query = urllib.parse.urlencode({
        "from": started_at,
        "appCallerCode": app_caller,
        "transport": "http",
        "pageSize": "5",
    })
    request = urllib.request.Request(console_base + "/logs?" + query, method="GET")
    request.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"GW log verification HTTP {exc.code}") from exc
    data = payload.get("data") if isinstance(payload, dict) else None
    items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(items, list) or not items:
        raise RuntimeError(f"no transport=http GW log found for {app_caller}")
    item = items[0] if isinstance(items[0], dict) else {}
    return {
        "requestId": item.get("requestId"),
        "appCallerCode": item.get("appCallerCode"),
        "transport": item.get("gatewayTransport") or item.get("transport"),
        "status": item.get("status"),
        "model": item.get("model"),
    }


def map_seed_command(cell: str, evidence: Path, map_base: str, gw_base: str, commit: str) -> list[str]:
    command = [
        sys.executable, "scripts/llmgw-map-shadow-seed.py",
        "--base", map_base,
        "--gw-base", gw_base,
        "--release-commit", commit,
        "--iterations", "1",
        "--evidence-out", str(evidence),
    ]
    if cell == "text":
        return command + ["--skip-text-seeds", "--include-report-agent-generate"]
    if cell == "stream":
        return command + ["--skip-preview-ask"]
    if cell == "image":
        return command + ["--skip-text-seeds", "--include-image-raw"]
    if cell == "vision":
        return command + [
            "--skip-text-seeds", "--include-image-worker-vision",
            "--image-ref-shas", require_env("LLMGW_FINAL_IMAGE_REF_SHAS"),
        ]
    raise RuntimeError(f"unsupported MAP seed cell: {cell}")


def command_for(cell: str, evidence_dir: Path, map_base: str, gw_base: str, commit: str) -> list[str]:
    evidence = evidence_dir / f"{cell}.json"
    if cell in {"text", "stream", "image", "vision"}:
        return map_seed_command(cell, evidence, map_base, gw_base, commit)
    if cell == "asr":
        return [
            sys.executable, "scripts/llmgw-asr-http-canary.py",
            "--api-base", map_base,
            "--app-caller", APP_CALLERS[cell],
            "--max-canary-calls", "1",
            "--json-out", str(evidence),
        ]
    return [
        sys.executable, "scripts/llmgw-video-exchange-canary.py",
        "--gw-base", gw_base,
        "--app-caller", APP_CALLERS[cell],
        "--max-canary-calls", "1",
        "--poll-status", "--download-result",
        "--json-out", str(evidence),
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description="Bounded LLM Gateway final acceptance")
    parser.add_argument("--commit", required=True)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--resume-cell", choices=CELLS)
    parser.add_argument("--approval-note", default="")
    parser.add_argument("--evidence-root", default=".llmgw-release-evidence")
    args = parser.parse_args()

    commit = args.commit.strip().lower()
    if len(commit) != 40 or any(char not in "0123456789abcdef" for char in commit):
        raise SystemExit("--commit must be a full 40-character SHA")
    evidence_dir = Path(args.evidence_root) / f"final-acceptance-{commit}"
    manifest_path = evidence_dir / "manifest.json"
    selected = list(CELLS[CELLS.index(args.resume_cell):]) if args.resume_cell else list(CELLS)

    if not args.execute:
        print("LLM Gateway final acceptance: DRY-RUN")
        print(f"commit={commit}")
        print("cells=" + ",".join(selected))
        print("upstreamLimit=text:1,stream:1,image:1,vision:1,asr:1,videoSubmit:1")
        print("automaticRetry=false")
        return 0

    map_base = require_env("PRD_AGENT_BASE").rstrip("/")
    gw_base = require_env("LLMGW_GATE_BASE").rstrip("/")
    require_env("GW_KEY")
    console_base = os.environ.get("LLMGW_CONSOLE_API_BASE", map_base + "/gw").rstrip("/")
    token = console_token(console_base)
    preflight = verify_preflight(gw_base, console_base, token, commit)

    if manifest_path.exists():
        manifest = load_json(manifest_path)
        if not args.resume_cell:
            raise SystemExit(f"acceptance already started for commit {commit}; automatic full rerun is forbidden")
        if not args.approval_note.strip():
            raise SystemExit("--resume-cell requires --approval-note describing the code/config change")
        failed_cell = str(manifest.get("failedCell") or "")
        if failed_cell != args.resume_cell:
            raise SystemExit(f"only failed cell may resume: failed={failed_cell or 'none'} requested={args.resume_cell}")
        manifest.setdefault("manualResumes", []).append({"cell": args.resume_cell, "note": args.approval_note, "at": now_iso()})
    else:
        if args.resume_cell:
            raise SystemExit("--resume-cell requires an existing failed manifest")
        manifest = {"commit": commit, "status": "running", "startedAt": now_iso(), "automaticRetry": False, "preflight": preflight, "cells": {}}
    write_json(manifest_path, manifest)

    for cell in selected:
        started_at = now_iso()
        manifest["currentCell"] = cell
        request_limit = {"maxSubmitCalls": 1, "statusPollsOnly": True} if cell == "video" else {"maxUpstreamCalls": 1}
        manifest["cells"][cell] = {"status": "running", "startedAt": started_at, **request_limit}
        write_json(manifest_path, manifest)
        command = command_for(cell, evidence_dir, map_base, gw_base, commit)
        result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
        output = (result.stdout or "")[-4000:]
        if result.returncode != 0:
            manifest["status"] = "failed"
            manifest["failedCell"] = cell
            manifest["cells"][cell].update({"status": "failed", "finishedAt": now_iso(), "exitCode": result.returncode, "outputTail": output})
            write_json(manifest_path, manifest)
            print(f"LLM Gateway final acceptance: FAIL cell={cell}; no later cells executed")
            return result.returncode or 1

        time.sleep(max(0, int(os.environ.get("LLMGW_FINAL_LOG_SETTLE_SECONDS", "5"))))
        try:
            log = verify_http_log(console_base, token, APP_CALLERS[cell], started_at)
        except Exception as exc:  # noqa: BLE001
            manifest["status"] = "failed"
            manifest["failedCell"] = cell
            manifest["cells"][cell].update({"status": "failed", "finishedAt": now_iso(), "exitCode": 1, "outputTail": output, "error": str(exc)})
            write_json(manifest_path, manifest)
            print(f"LLM Gateway final acceptance: FAIL cell={cell}; GW log evidence missing; no later cells executed")
            return 1
        manifest["cells"][cell].update({"status": "passed", "finishedAt": now_iso(), "exitCode": 0, "gatewayLog": log})
        manifest.pop("failedCell", None)
        write_json(manifest_path, manifest)
        print(f"PASS cell={cell} requestId={log.get('requestId') or 'unknown'}")

    manifest["status"] = "passed"
    manifest["completedAt"] = now_iso()
    manifest.pop("currentCell", None)
    write_json(manifest_path, manifest)
    print("LLM Gateway final acceptance: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
