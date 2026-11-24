#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "prd-agent-release-evidence.py"

with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    web = root / "web"
    release = web / "releases" / "sha-test"
    release.mkdir(parents=True)
    (release / "index.html").write_text("<script src='/app.js'></script>", encoding="utf-8")
    (web / "current").symlink_to("releases/sha-test")
    (web / "dist").symlink_to("current")
    smoke = root / "smoke.json"
    smoke.write_text(json.dumps({"verdict": "pass"}), encoding="utf-8")
    storage_readiness = root / "asset-storage-readiness.json"
    storage_readiness.write_text(
        json.dumps(
            {
                "status": "healthy",
                "provider": "tencentCos",
                "expectedProvider": "tencentCos",
                "writeVerified": True,
                "internalReadVerified": True,
                "publicReadVerified": True,
                "cleanupVerified": True,
            }
        ),
        encoding="utf-8",
    )
    artifact = root / "artifact.zip"
    artifact.write_bytes(b"artifact")
    output = root / "evidence" / "release.json"

    command = [
        "python3",
        str(SCRIPT),
        "--out",
        str(output),
        "--status",
        "success",
        "--release-ref",
        "sha-test",
        "--started-at",
        "2026-07-17T00:00:00Z",
        "--command-semantics",
        "immutable-commit",
        "--release-pid",
        "1234",
        "--asset-file",
        str(artifact),
        "--expected-sha256",
        "c7c5c1d70c5dec44a7467b64fa78f0b1c7c5c1d70c5dec44a7467b64fa78f0b1",
        "--checksum-verified",
        "1",
        "--static-root",
        str(web / "dist"),
        "--current-link",
        str(web / "current"),
        "--previous-link",
        str(web / "previous"),
        "--smoke-json",
        str(smoke),
        "--asset-storage-readiness-json",
        str(storage_readiness),
        "--gateway-bind-state",
        "coherent",
        "--gateway-bind-initial-state",
        "confirmed-drift",
        "--gateway-bind-initial-reason",
        "host-container-values-differ",
        "--gateway-bind-recreated",
        "1",
        "--gateway-container-before",
        "container-old",
        "--gateway-container-after",
        "container-new",
        "--gateway-host-static-target",
        "releases/sha-test",
        "--gateway-container-static-target",
        "releases/sha-test",
        "--gateway-host-static-sha256",
        "a" * 64,
        "--gateway-container-static-sha256",
        "a" * 64,
        "--gateway-host-nginx-sha256",
        "b" * 64,
        "--gateway-container-nginx-sha256",
        "b" * 64,
        "--gateway-bind-initial-host-static-target",
        "releases/sha-test",
        "--gateway-bind-initial-container-static-target",
        "releases/sha-old",
        "--gateway-bind-initial-host-static-sha256",
        "a" * 64,
        "--gateway-bind-initial-container-static-sha256",
        "c" * 64,
        "--gateway-bind-initial-host-nginx-sha256",
        "b" * 64,
        "--gateway-bind-initial-container-nginx-sha256",
        "d" * 64,
    ]
    subprocess.run(command, check=True, capture_output=True, text=True)
    payload = json.loads(output.read_text(encoding="utf-8"))
    assert payload["status"] == "success"
    assert payload["releaseProcessPid"] == 1234
    assert payload["artifact"]["sha256"]
    assert payload["artifact"]["checksumVerified"] is True
    assert payload["staticLayout"]["current"]["symlinkTarget"] == "releases/sha-test"
    assert payload["publicSurface"]["verdict"] == "pass"
    assert payload["assetStorageReadiness"]["provider"] == "tencentCos"
    assert payload["assetStorageReadiness"]["cleanupVerified"] is True
    assert payload["gatewayBindMount"] == {
        "recreated": True,
        "containerIdBefore": "container-old",
        "containerIdAfter": "container-new",
        "initial": {
            "state": "confirmed-drift",
            "reason": "host-container-values-differ",
            "hostStaticTarget": "releases/sha-test",
            "containerStaticTarget": "releases/sha-old",
            "hostStaticSha256Prefix": "a" * 12,
            "containerStaticSha256Prefix": "c" * 12,
            "hostNginxSha256Prefix": "b" * 12,
            "containerNginxSha256Prefix": "d" * 12,
        },
        "final": {
            "state": "coherent",
            "reason": None,
            "hostStaticTarget": "releases/sha-test",
            "containerStaticTarget": "releases/sha-test",
            "hostStaticSha256Prefix": "a" * 12,
            "containerStaticSha256Prefix": "a" * 12,
            "hostNginxSha256Prefix": "b" * 12,
            "containerNginxSha256Prefix": "b" * 12,
        },
    }

    duplicate = subprocess.run(command, capture_output=True, text=True)
    assert duplicate.returncode != 0
    assert "cannot be overwritten" in duplicate.stderr

    invalid_readiness = root / "invalid-readiness.json"
    invalid_readiness.write_text("", encoding="utf-8")
    invalid_output = root / "evidence" / "invalid-readiness-release.json"
    invalid_command = command.copy()
    invalid_command[invalid_command.index(str(output))] = str(invalid_output)
    invalid_command[invalid_command.index(str(storage_readiness))] = str(invalid_readiness)
    subprocess.run(invalid_command, check=True, capture_output=True, text=True)
    invalid_payload = json.loads(invalid_output.read_text(encoding="utf-8"))
    assert invalid_payload["assetStorageReadiness"]["status"] == "unreadable"
    assert invalid_payload["assetStorageReadiness"]["error"] == "JSONDecodeError"

print("Release evidence test: PASS")
