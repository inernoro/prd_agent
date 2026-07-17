#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "scripts" / "prd-agent-public-surface-smoke.py"
SPEC = importlib.util.spec_from_file_location("public_surface_smoke", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


BASE = "https://example.test/"
HEALTH = json.dumps({"status": "healthy", "commit": "a" * 40}).encode()
VERSION = json.dumps({"service": "prd-api", "commit": "a" * 40}).encode()
RESPONSES = {
    "https://example.test/": MODULE.HttpResult("https://example.test/", 200, "text/html", b'<script src="/assets/app.js"></script><link rel="stylesheet" href="/assets/app.css">'),
    "https://example.test/assets/app.js": MODULE.HttpResult("https://example.test/assets/app.js", 200, "application/javascript", b"console.log('ok')"),
    "https://example.test/assets/app.css": MODULE.HttpResult("https://example.test/assets/app.css", 200, "text/css", b"body{}"),
    "https://example.test/api/version": MODULE.HttpResult("https://example.test/api/version", 200, "application/json", VERSION),
    "https://example.test/health": MODULE.HttpResult("https://example.test/health", 200, "application/json", HEALTH),
    "https://example.test/llmgw/": MODULE.HttpResult("https://example.test/llmgw/", 200, "text/html", b"gateway"),
    "https://example.test/llmgw/gw/healthz": MODULE.HttpResult("https://example.test/llmgw/gw/healthz", 200, "application/json", HEALTH),
    "https://example.test/llmgw/gw/v1/healthz": MODULE.HttpResult("https://example.test/llmgw/gw/v1/healthz", 200, "application/json", HEALTH),
}


def fake_fetch(url: str, _timeout: float):
    return RESPONSES[url]


passed = MODULE.probe_once(
    BASE,
    "/api/version",
    "/health",
    "/llmgw/",
    "/llmgw/gw/healthz",
    "/llmgw/gw/v1/healthz",
    1,
    fake_fetch,
    "a" * 40,
)
assert passed["verdict"] == "pass", passed
assert len(passed["checks"]) == 8, passed

broken = dict(RESPONSES)
broken["https://example.test/assets/app.js"] = MODULE.HttpResult("https://example.test/assets/app.js", 404, "text/html", b"missing")
failed = MODULE.probe_once(
    BASE,
    "/api/version",
    "/health",
    "/llmgw/",
    "/llmgw/gw/healthz",
    "/llmgw/gw/v1/healthz",
    1,
    lambda url, _timeout: broken[url],
)
assert failed["verdict"] == "fail", failed
assert any("entry-js-1" in item for item in failed["failures"]), failed

wrong_commit = MODULE.probe_once(
    BASE,
    "/api/version",
    "/health",
    "/llmgw/",
    "/llmgw/gw/healthz",
    "/llmgw/gw/v1/healthz",
    1,
    fake_fetch,
    "b" * 40,
)
assert wrong_commit["verdict"] == "fail", wrong_commit
assert any("commit mismatch" in item for item in wrong_commit["failures"]), wrong_commit

with tempfile.TemporaryDirectory() as temporary:
    output = Path(temporary) / "nested" / "surface.json"
    MODULE.write_json(str(output), passed)
    persisted = json.loads(output.read_text(encoding="utf-8"))
    assert persisted["verdict"] == "pass"

print("Public surface smoke test: PASS")
