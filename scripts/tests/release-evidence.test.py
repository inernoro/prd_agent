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
    ]
    subprocess.run(command, check=True, capture_output=True, text=True)
    payload = json.loads(output.read_text(encoding="utf-8"))
    assert payload["status"] == "success"
    assert payload["releaseProcessPid"] == 1234
    assert payload["artifact"]["sha256"]
    assert payload["artifact"]["checksumVerified"] is True
    assert payload["staticLayout"]["current"]["symlinkTarget"] == "releases/sha-test"
    assert payload["publicSurface"]["verdict"] == "pass"

    duplicate = subprocess.run(command, capture_output=True, text=True)
    assert duplicate.returncode != 0
    assert "cannot be overwritten" in duplicate.stderr

print("Release evidence test: PASS")
