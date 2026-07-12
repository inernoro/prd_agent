#!/usr/bin/env python3
"""Restore the minimum trusted rollout evidence for a maintenance release.

The production runner uses a clean GitHub Actions workspace. Historical manual
rollout evidence remains under the fixed production repository directory, while
older GitHub artifacts may not contain the hidden rollout ledger. This helper
copies only the append-only ledger and the two files referenced by the selected
successful http-full baseline. It rejects symlinks, path traversal, unexpected
owners, malformed JSONL, and ambiguous baselines.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import stat
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _write_json(path: Path | None, payload: dict[str, Any]) -> None:
    if path is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")


def _parse_time(raw: object) -> datetime:
    value = str(raw or "").strip()
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _load_ledger(path: Path) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"rollout ledger line {line_number} is not valid JSON") from exc
        if not isinstance(value, dict):
            raise ValueError(f"rollout ledger line {line_number} is not an object")
        entries.append(value)
    return entries


def _latest_http_full(entries: list[dict[str, Any]], commit: str) -> dict[str, Any]:
    candidates = [
        entry
        for entry in entries
        if str(entry.get("commit") or "").lower() == commit
        and str(entry.get("stage") or "") == "http-full"
        and str(entry.get("status") or "") == "success"
    ]
    if not candidates:
        raise ValueError(f"missing successful http-full baseline for commit={commit}")
    try:
        return max(candidates, key=lambda item: _parse_time(item.get("recordedAt")))
    except (TypeError, ValueError) as exc:
        raise ValueError("successful http-full baseline has invalid recordedAt") from exc


def _assert_trusted_file(path: Path, source_root: Path, required_uid: int | None) -> Path:
    if path.is_symlink():
        raise ValueError(f"trusted evidence must not be a symlink: {path}")
    resolved = path.resolve(strict=True)
    if resolved != source_root and source_root not in resolved.parents:
        raise ValueError(f"trusted evidence escapes source root: {path}")
    if not resolved.is_file():
        raise ValueError(f"trusted evidence is not a regular file: {path}")
    metadata = resolved.stat()
    if required_uid is not None and metadata.st_uid != required_uid:
        raise ValueError(f"trusted evidence owner mismatch: {path}")
    if metadata.st_mode & stat.S_IWOTH:
        raise ValueError(f"trusted evidence is world-writable: {path}")
    return resolved


def _referenced_source(path_text: object, source_root: Path, required_uid: int | None) -> tuple[Path, Path]:
    raw = str(path_text or "").strip().replace("\\", "/")
    prefix = ".llmgw-release-evidence/"
    if not raw.startswith(prefix):
        raise ValueError(f"evidence path must start with {prefix}: {raw or '<empty>'}")
    relative = Path(raw[len(prefix):])
    if relative.is_absolute() or ".." in relative.parts or not relative.parts:
        raise ValueError(f"unsafe evidence path: {raw}")
    source = _assert_trusted_file(source_root / relative, source_root, required_uid)
    return source, relative


def restore(source: Path, target: Path, commit: str, required_uid: int | None) -> dict[str, Any]:
    normalized_commit = commit.strip().lower()
    if len(normalized_commit) != 40 or any(ch not in "0123456789abcdef" for ch in normalized_commit):
        raise ValueError("maintenance commit must be a full 40-character SHA")

    source_root = source.resolve(strict=True)
    if source.is_symlink() or not source_root.is_dir():
        raise ValueError("trusted production evidence source must be a real directory")
    ledger_source = _assert_trusted_file(source_root / "rollout-ledger.jsonl", source_root, required_uid)
    entries = _load_ledger(ledger_source)
    baseline = _latest_http_full(entries, normalized_commit)
    stage_source, stage_relative = _referenced_source(baseline.get("evidenceJson"), source_root, required_uid)
    gate_source, gate_relative = _referenced_source(baseline.get("releaseGateJson"), source_root, required_uid)

    target.mkdir(parents=True, exist_ok=True)
    ledger_target = target / "rollout-ledger.jsonl"
    shutil.copy2(ledger_source, ledger_target)
    copied: list[str] = ["rollout-ledger.jsonl"]
    for source_file, relative in ((stage_source, stage_relative), (gate_source, gate_relative)):
        target_file = target / relative
        target_file.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_file, target_file)
        copied.append(relative.as_posix())

    return {
        "verdict": "pass",
        "source": str(source_root),
        "target": str(target),
        "commit": normalized_commit,
        "baselineRecordedAt": str(baseline.get("recordedAt") or ""),
        "copied": copied,
    }


def _self_test() -> int:
    with tempfile.TemporaryDirectory(prefix="llmgw-prod-evidence-restore-") as temp:
        root = Path(temp)
        source = root / "source"
        target = root / "target"
        source.mkdir()
        commit = "a" * 40
        stage_name = "baseline.stage.json"
        gate_name = "baseline.release-gate.json"
        (source / stage_name).write_text('{"verdict":"pass"}', encoding="utf-8")
        (source / gate_name).write_text('{"verdict":"pass"}', encoding="utf-8")
        entry = {
            "commit": commit,
            "stage": "http-full",
            "status": "success",
            "recordedAt": "2026-07-01T00:00:00Z",
            "evidenceJson": f".llmgw-release-evidence/{stage_name}",
            "releaseGateJson": f".llmgw-release-evidence/{gate_name}",
        }
        (source / "rollout-ledger.jsonl").write_text(json.dumps(entry) + "\n", encoding="utf-8")
        report = restore(source, target, commit, None)
        expected = {"rollout-ledger.jsonl", stage_name, gate_name}
        if report.get("verdict") != "pass" or set(report.get("copied") or []) != expected:
            print("LLM Gateway production evidence restore self-test: FAIL")
            return 1
        if not all((target / item).is_file() for item in expected):
            print("LLM Gateway production evidence restore self-test: FAIL")
            return 1
    print("LLM Gateway production evidence restore self-test: PASS")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Restore trusted LLM Gateway maintenance evidence")
    parser.add_argument("--source", default="")
    parser.add_argument("--target", default=".llmgw-release-evidence")
    parser.add_argument("--commit", default="")
    parser.add_argument("--require-owner-uid", type=int)
    parser.add_argument("--json-out", default="")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        return _self_test()

    report_path = Path(args.json_out) if args.json_out else None
    try:
        report = restore(Path(args.source), Path(args.target), args.commit, args.require_owner_uid)
    except (OSError, ValueError) as exc:
        report = {"verdict": "fail", "error": str(exc)}
        _write_json(report_path, report)
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    _write_json(report_path, report)
    print("LLM Gateway production evidence restore: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
