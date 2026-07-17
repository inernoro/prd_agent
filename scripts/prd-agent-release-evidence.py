#!/usr/bin/env python3
from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import os
import socket
import stat
from datetime import datetime, timezone
from pathlib import Path


def file_sha256(path: str) -> str | None:
    if not path:
        return None
    candidate = Path(path)
    if not candidate.is_file():
        return None
    digest = hashlib.sha256()
    with candidate.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def path_metadata(path: str) -> dict[str, object]:
    candidate = Path(path)
    try:
        details = candidate.lstat()
    except FileNotFoundError:
        return {"path": path, "exists": False}
    payload: dict[str, object] = {
        "path": path,
        "exists": True,
        "mode": stat.filemode(details.st_mode),
        "modeOctal": format(stat.S_IMODE(details.st_mode), "04o"),
        "uid": details.st_uid,
        "gid": details.st_gid,
        "symlinkTarget": os.readlink(candidate) if candidate.is_symlink() else None,
    }
    try:
        resolved = candidate.resolve(strict=True)
        resolved_details = resolved.stat()
        payload["resolvedPath"] = str(resolved)
        payload["resolvedMode"] = format(stat.S_IMODE(resolved_details.st_mode), "04o")
        payload["resolvedUid"] = resolved_details.st_uid
        payload["resolvedGid"] = resolved_details.st_gid
    except (FileNotFoundError, OSError):
        payload["resolvedPath"] = None
        payload["resolvedMode"] = None
    return payload


def read_json(path: str) -> object | None:
    if not path:
        return None
    candidate = Path(path)
    if not candidate.is_file():
        return None
    return json.loads(candidate.read_text(encoding="utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description="Write an immutable production release evidence record")
    parser.add_argument("--out", required=True)
    parser.add_argument("--status", choices=["success", "failed", "rollback"], required=True)
    parser.add_argument("--release-ref", required=True)
    parser.add_argument("--started-at", required=True)
    parser.add_argument("--command-semantics", required=True)
    parser.add_argument("--release-pid", required=True, type=int)
    parser.add_argument("--asset-url", default="")
    parser.add_argument("--asset-file", default="")
    parser.add_argument("--expected-sha256", default="")
    parser.add_argument("--checksum-verified", choices=["0", "1"], default="0")
    parser.add_argument("--manifest-url", default="")
    parser.add_argument("--static-root", default="deploy/web/dist")
    parser.add_argument("--current-link", default="deploy/web/current")
    parser.add_argument("--previous-link", default="deploy/web/previous")
    parser.add_argument("--static-before-mode", default="")
    parser.add_argument("--static-before-owner", default="")
    parser.add_argument("--static-before-current", default="")
    parser.add_argument("--static-before-previous", default="")
    parser.add_argument("--smoke-json", default="")
    parser.add_argument("--failure-stage", default="")
    parser.add_argument("--rollback-result", default="not-needed")
    args = parser.parse_args()

    output = Path(args.out)
    if output.exists():
        raise SystemExit(f"release evidence already exists and cannot be overwritten: {output}")
    payload = {
        "schemaVersion": 1,
        "status": args.status,
        "operator": getpass.getuser(),
        "host": socket.gethostname(),
        "releaseProcessPid": args.release_pid,
        "evidenceWriterPid": os.getpid(),
        "startedAt": args.started_at,
        "endedAt": datetime.now(timezone.utc).isoformat(),
        "releaseRef": args.release_ref,
        "commandSemantics": args.command_semantics,
        "artifact": {
            "url": args.asset_url or None,
            "manifestUrl": args.manifest_url or None,
            "sha256": file_sha256(args.asset_file),
            "expectedSha256": args.expected_sha256 or None,
            "checksumVerified": args.checksum_verified == "1",
        },
        "staticLayout": {
            "before": {
                "rootMode": args.static_before_mode or None,
                "rootOwner": args.static_before_owner or None,
                "currentTarget": args.static_before_current or None,
                "previousTarget": args.static_before_previous or None,
            },
            "root": path_metadata(args.static_root),
            "current": path_metadata(args.current_link),
            "previous": path_metadata(args.previous_link),
        },
        "publicSurface": read_json(args.smoke_json),
        "firstFailureStage": args.failure_stage or None,
        "rollbackResult": args.rollback_result,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f"{output.name}.tmp.{os.getpid()}")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(output)
    print(f"Release evidence written: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
