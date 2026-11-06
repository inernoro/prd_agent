#!/usr/bin/env python3
"""Safety contracts for production speech checks; no production credentials or network are used."""
import contextlib
import importlib.util
import io
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from unittest.mock import patch
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("speech_smoke", ROOT / "scripts/mcp-speech-production-smoke.py")
smoke = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(smoke)
COMMIT = "a" * 40
BASE = "https://production.example"
CANARY = "PRIVATE_AUTH_MUST_NEVER_APPEAR"
RUN_ID, KEY_ID, PRESET_ID = "b" * 32, "c" * 32, "d" * 32


def response(data=None, status=200, raw=b"", mime=""):
    return {"status": status, "payload": {"success": True, "data": data} if data is not None else None, "raw": raw, "mime": mime}


class Fixture:
    def __init__(self, *, missing=False, terminal="completed", available=True):
        self.calls, self.generated = [], []
        self.missing, self.terminal = missing, terminal
        self.profile = {"id": "tts-config", "revision": 2, "isDefault": True, "available": available, "protocol": "openai",
                        "maxTextChars": 1000, "defaultVoiceId": "voice", "defaultFormat": "mp3", "name": CANARY}

    def http(self, base, path, token="", method="GET", body=None, **kwargs):
        self.calls.append((method, path, body))
        if path == "/api/version":
            return {**response(), "payload": {"commit": COMMIT, "secret": CANARY}}
        if path == "/api/authz/me":
            return response({"effectivePermissions": ["mcp-speech.read", "mcp-speech.generate", CANARY]})
        if path in ("/api/mcp-speech/capabilities", "/api/mcp-speech/settings"):
            if self.missing:
                return response(status=404)
            return response({"profiles": [self.profile], "canManage": False, "secret": CANARY})
        if path == "/api/agent-api-keys":
            return response({"item": {"id": KEY_ID, "scopeMode": "manual", "scopes": smoke.SPEECH_SCOPES,
                             "expiresAt": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()}, "apiKey": CANARY})
        if path.endswith("/revoke"):
            return response({"item": {"id": KEY_ID}})
        if path == "/api/open/speech/capabilities":
            return response(status=401)
        if path == "/api/mcp":
            name, args = body["params"]["name"], body["params"]["arguments"]
            data = {}
            if name == "map_speech_capabilities":
                data = {"profiles": [self.profile]}
            if name == "map_speech_save_preset":
                data = {"id": PRESET_ID}
            if name == "map_speech_generate":
                self.generated.append(args)
                data = {"runId": RUN_ID, "status": self.terminal, "format": "mp3", "deduplicated": len(self.generated) > 1}
            rpc = {"result": {"content": [{"type": "text", "text": json.dumps({"success": True, "data": data, "secret": CANARY})}]}}
            return {**response(), "payload": rpc}
        if path.startswith("/api/mcp-speech/runs?"):
            return response({"items": [{"id": RUN_ID}]})
        if path.startswith("/api/mobile/assets?"):
            return response({"items": [{"id": "speech-" + RUN_ID}]})
        if path.endswith("/audio"):
            return response(raw=b"ID3 synthetic audio", mime="audio/mpeg")
        raise AssertionError("unexpected fixture route")


def runner(fixture):
    return smoke.SpeechSmoke(BASE, COMMIT, http=fixture.http, session=lambda *_: ("rsa", CANARY, {"detail": CANARY}))


class ProductionSpeechTests(unittest.TestCase):
    def test_missing_feature_is_not_a_green_readiness_and_never_writes(self):
        fixture = Fixture(missing=True)
        check = runner(fixture)
        self.assertFalse(check.readiness())
        report = check.finish()
        self.assertEqual(report["verdict"], "fail")
        self.assertEqual([x["failureCode"] for x in report["checks"] if x.get("status") == 404], ["feature_missing", "feature_missing"])
        self.assertTrue(all(method == "GET" for method, _, _ in fixture.calls))
        self.assertFalse(report["run"]["attempted"])

    def test_readiness_reports_only_permission_booleans_and_capability_counts(self):
        check = runner(Fixture())
        self.assertTrue(check.readiness())
        report = check.finish()
        self.assertEqual(report["permissions"], {"speechRead": True, "speechGenerate": True, "speechConfigure": False, "authorizationManage": False, "super": False})
        self.assertNotIn(CANARY, json.dumps(report))
        self.assertEqual(report["capabilities"]["availableCount"], 1)

    def test_version_mismatch_does_not_mint_a_signed_session(self):
        fixture = Fixture()
        with patch.object(smoke.AUTH, "_stable_smoke_session") as session:
            check = smoke.SpeechSmoke(BASE, "e" * 40, http=fixture.http)
            self.assertFalse(check.readiness())
            session.assert_not_called()
        self.assertEqual(len(fixture.calls), 1)

    def test_unconfigured_profile_is_not_ready(self):
        check = runner(Fixture(available=False))
        self.assertFalse(check.readiness())
        self.assertEqual(check.finish()["capabilities"]["availableCount"], 0)

    def test_target_rejects_foreign_origins_http_and_credential_urls(self):
        for target in ["http://production.example", "https://attacker.example", "https://user:secret@production.example", BASE + "?token=secret", BASE + "/unexpected"]:
            with self.subTest(target=target), self.assertRaises(smoke.CheckFailure):
                smoke.validate_target(target, COMMIT, BASE)
        smoke.validate_target(BASE, COMMIT, BASE)
        with self.assertRaises(smoke.CheckFailure):
            smoke.validate_target(BASE, COMMIT[:8], BASE)

    def test_run_uses_only_speech_scopes_replays_same_request_and_revokes_key(self):
        fixture = Fixture()
        check = runner(fixture)
        self.assertTrue(check.readiness())
        check.run()
        report = check.finish()
        self.assertEqual(report["verdict"], "pass")
        created = next(body for method, path, body in fixture.calls if path == "/api/agent-api-keys")
        self.assertEqual(created["scopes"], ["mcp-speech:read", "mcp-speech:generate"])
        self.assertEqual(created["ttlDays"], 1)
        self.assertEqual(fixture.generated[0], fixture.generated[1])
        self.assertLessEqual(len(fixture.generated[0]["text"]), 60)
        self.assertTrue(fixture.generated[0]["title"].startswith("stsmk_prod "))
        self.assertTrue(any(path.endswith("/revoke") for _, path, _ in fixture.calls))
        self.assertNotIn(CANARY, json.dumps(report))
        self.assertIn("sha256", report["run"]["audio"])
        self.assertTrue(next(x for x in report["checks"] if x["name"] == "owner_audio_after_key_revocation")["ok"])

    def test_unknown_generation_is_not_resent_and_always_revokes_temporary_key(self):
        fixture = Fixture(terminal="unknown")
        check = runner(fixture)
        self.assertTrue(check.readiness())
        with self.assertRaises(smoke.CheckFailure):
            check.run()
        self.assertEqual(len(fixture.generated), 1)
        self.assertTrue(any(path.endswith("/revoke") for _, path, _ in fixture.calls))
        self.assertEqual(check.finish()["verdict"], "fail")

    def test_run_without_explicit_opt_in_stops_before_network_or_signing(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"DEFAULT_MAP_BASE": BASE, "STABLE_SMOKE_USER": "stsmk_prod"}), \
                patch.object(smoke.AUTH, "_stable_smoke_session") as session, contextlib.redirect_stdout(io.StringIO()):
            output = Path(directory) / "report.json"
            self.assertEqual(smoke.main(["--map-base", BASE, "--expect-commit", COMMIT, "--mode", "run", "--json-out", str(output)]), 1)
            session.assert_not_called()
            self.assertIn("explicit_production_run_opt_in_required", output.read_text())

    def test_viewer_inventory_reports_only_tts_counts_and_not_ticket_or_resource_material(self):
        fixture = Fixture()
        calls = []

        def http(base, path, token="", method="GET", **kwargs):
            calls.append((method, path))
            if path == "/api/v1/auth/synthetic/gateway-ticket":
                return response({"code": CANARY, "ticketId": CANARY})
            if path == "/llmgw/gw/auth/stable-smoke-sso":
                return response({"token": CANARY, "tenant": {"role": "viewer"}})
            if path.startswith("/llmgw/gw/logical-models"):
                return response({"items": [{"name": CANARY, "offerings": [{"protocol": "openai"}, {"protocol": "doubao-tts"}]}]})
            if path == "/llmgw/gw/exchanges":
                return response({"items": [{"id": CANARY, "name": CANARY, "transformerType": "doubao-tts", "enabled": True, "hasKey": True, "resourceId": CANARY}]})
            return fixture.http(base, path, token, method, **kwargs)

        check = smoke.SpeechSmoke(BASE, COMMIT, http=http, session=lambda *_: ("rsa", CANARY, {}), inventory=True)
        with patch.object(smoke.subprocess, "run", return_value=SimpleNamespace(stdout=json.dumps({"signature": CANARY}))):
            self.assertTrue(check.readiness())
        report = check.finish()
        self.assertEqual(report["gatewayInventory"]["enabledDoubaoTtsResourcesWithCredentials"], 1)
        self.assertEqual(report["gatewayInventory"]["protocols"], ["doubao-tts", "openai"])
        self.assertNotIn(CANARY, json.dumps(report))
        self.assertEqual([path for method, path in calls if method != "GET"], ["/api/v1/auth/synthetic/gateway-ticket", "/llmgw/gw/auth/stable-smoke-sso"])

    def test_gateway_inventory_refuses_non_viewer_session_without_changing_role(self):
        called = []

        def http(base, path, **kwargs):
            called.append(path)
            return response({"code": CANARY}) if path.endswith("gateway-ticket") else response({"token": CANARY, "tenant": {"role": "owner"}})

        check = smoke.SpeechSmoke(BASE, COMMIT, http=http)
        with patch.object(smoke.subprocess, "run", return_value=SimpleNamespace(stdout="{}")):
            check.gateway_inventory()
        self.assertFalse(check.report["gatewayInventory"]["ok"])
        self.assertFalse(check.report["gatewayInventory"]["privilegeChanged"])
        self.assertEqual(len(called), 2)

    def test_validate_only_never_requests_a_session_or_any_endpoint(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"DEFAULT_MAP_BASE": BASE, "STABLE_SMOKE_USER": "stsmk_prod"}), \
                patch.object(smoke.AUTH, "_stable_smoke_session") as session, patch.object(smoke, "request") as http, contextlib.redirect_stdout(io.StringIO()):
            output = Path(directory) / "report.json"
            self.assertEqual(smoke.main(["--map-base", BASE, "--expect-commit", COMMIT, "--validate-only", "--json-out", str(output)]), 0)
            session.assert_not_called()
            http.assert_not_called()

    def test_redirect_does_not_forward_authorization(self):
        received = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                received.append(self.path)
                self.send_response(302 if self.path == "/redirect" else 200)
                self.send_header("Location", "/other")
                self.end_headers()

            def log_message(self, *_):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            result = smoke.request("http://127.0.0.1:" + str(server.server_port), "/redirect", CANARY)
            self.assertEqual(result["status"], 302)
            self.assertEqual(received, ["/redirect"])
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
