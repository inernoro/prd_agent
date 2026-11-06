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


class ContractFixture(Fixture):
    def __init__(self, *, loose_schema=False, fail_initialize=False, revoked_status=401, extra_scope=False):
        super().__init__()
        self.loose_schema, self.fail_initialize = loose_schema, fail_initialize
        self.revoked_status, self.extra_scope, self.revoked = revoked_status, extra_scope, False
        self.mcp_methods, self.tool_calls = [], []

    def http(self, base, path, token="", method="GET", body=None, **kwargs):
        if path == "/api/mcp":
            self.calls.append((method, path, body))
            rpc_method = body["method"]
            self.mcp_methods.append(rpc_method)
            if self.revoked:
                return response(status=self.revoked_status)
            if rpc_method == "initialize":
                if self.fail_initialize:
                    return response(status=403)
                result = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "secret": CANARY}
            elif rpc_method == "tools/list":
                result = {"tools": [{"name": name, "description": CANARY, "inputSchema": {
                    "type": "object", "additionalProperties": self.loose_schema,
                    "properties": {key: {"type": "string"} for key in required}, "required": sorted(required)}}
                    for name, required in smoke.SPEECH_TOOL_REQUIRED.items()]}
            else:
                name = body["params"]["name"]
                self.tool_calls.append(name)
                if name == "map_speech_capabilities":
                    data = {"environment": "Production", "profiles": [], "secret": CANARY}
                elif name == "map_speech_list_runs":
                    data = {"items": [{"id": RUN_ID, "text": CANARY}]}
                else:
                    raise AssertionError("Contract check attempted a tool outside the read-only allowlist")
                result = {"content": [{"type": "text", "text": json.dumps({"success": True, "data": data})}]}
            return {**response(), "payload": {"jsonrpc": "2.0", "id": 1, "result": result}}
        if path in ("/api/mcp-speech/capabilities", "/api/mcp-speech/settings"):
            self.calls.append((method, path, body))
            return response({"profiles": []})
        if path.endswith("/revoke"):
            self.revoked = True
        result = super().http(base, path, token, method, body, **kwargs)
        if path == "/api/agent-api-keys" and self.extra_scope:
            result["payload"]["data"]["item"]["scopes"] = smoke.SPEECH_SCOPES + ["unrelated:write"]
        return result


class McpContractTests(unittest.TestCase):
    def test_explicit_contract_discovers_strict_tools_reads_owner_and_always_revokes_without_synthesis(self):
        fixture = ContractFixture()
        check = runner(fixture)
        self.assertFalse(check.readiness())  # Empty profiles must remain not ready for synthesis.
        check.check_mcp_contract()
        report = check.finish()
        summary = report["mcpContract"]
        self.assertTrue(summary["ok"])
        self.assertEqual((summary["toolCount"], summary["speechToolCount"], summary["strictSchemaCount"]), (6, 6, 6))
        self.assertTrue(summary["configurationEmpty"])
        self.assertTrue(summary["productionEnvironment"])
        self.assertTrue(summary["ownerHistoryMatches"])
        self.assertEqual(summary["historyCount"], 1)
        self.assertEqual(fixture.tool_calls, ["map_speech_capabilities", "map_speech_list_runs"])
        self.assertEqual(fixture.mcp_methods, ["initialize", "tools/list", "tools/call", "tools/call", "initialize"])
        self.assertFalse(report["run"]["attempted"])
        self.assertFalse(summary["synthesisVerified"])
        self.assertNotIn(CANARY, json.dumps(report))
        created = next(body for method, path, body in fixture.calls if path == "/api/agent-api-keys")
        self.assertEqual(created["ttlDays"], 1)
        self.assertEqual(created["scopeMode"], "manual")
        self.assertEqual(created["scopes"], smoke.SPEECH_SCOPES)
        self.assertTrue(all(method == "GET" or path in {"/api/mcp", "/api/agent-api-keys", "/api/agent-api-keys/" + KEY_ID + "/revoke"}
                            for method, path, _ in fixture.calls))

    def test_contract_rejects_loose_schema_and_revokes_without_calling_any_tool(self):
        fixture = ContractFixture(loose_schema=True)
        check = runner(fixture); check.readiness()
        with self.assertRaises(smoke.CheckFailure): check.check_mcp_contract()
        self.assertTrue(fixture.revoked)
        self.assertFalse(fixture.tool_calls)
        self.assertFalse(check.report["mcpContract"]["ok"])

    def test_contract_initialize_failure_still_revokes_and_verifies_401(self):
        fixture = ContractFixture(fail_initialize=True)
        check = runner(fixture); check.readiness()
        with self.assertRaises(smoke.CheckFailure): check.check_mcp_contract()
        self.assertTrue(fixture.revoked)
        self.assertTrue(check.report["mcpContract"]["revokedKeyRejected"])
        self.assertFalse(fixture.tool_calls)

    def test_contract_rejects_broader_key_scope_and_still_revokes(self):
        fixture = ContractFixture(extra_scope=True)
        check = runner(fixture); check.readiness()
        with self.assertRaises(smoke.CheckFailure): check.check_mcp_contract()
        self.assertTrue(fixture.revoked)
        self.assertFalse(fixture.tool_calls)

    def test_contract_requires_revoked_key_to_receive_exact_401(self):
        fixture = ContractFixture(revoked_status=200)
        check = runner(fixture); check.readiness(); check.check_mcp_contract()
        self.assertFalse(check.report["mcpContract"]["ok"])
        self.assertFalse(check.report["mcpContract"]["revokedKeyRejected"])

    def test_contract_preconditions_fail_before_creating_any_key(self):
        fixture = ContractFixture()
        check = runner(fixture)
        with self.assertRaises(smoke.CheckFailure): check.check_mcp_contract()
        self.assertFalse(fixture.calls)
        self.assertFalse(fixture.revoked)

    def test_contract_is_not_executed_without_explicit_flag(self):
        fixture = ContractFixture()
        check = runner(fixture)
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"DEFAULT_MAP_BASE": BASE, "STABLE_SMOKE_USER": "stsmk_prod"}), \
                patch.object(smoke, "SpeechSmoke", return_value=check), patch.object(check, "check_mcp_contract") as contract, \
                contextlib.redirect_stdout(io.StringIO()):
            smoke.main(["--map-base", BASE, "--expect-commit", COMMIT, "--json-out", str(Path(directory) / "report.json")])
            contract.assert_not_called()


class AccessFixture(Fixture):
    def __init__(self):
        super().__init__()
        self.username = "stsmk_prod"
        self.grants = ["access", "authz.manage", "unrelated.read"]
        self.catalog = list(smoke.SPEECH_PERMISSIONS)
        self.snapshot = {"userId": "user_own", "username": "stsmk_prod", "systemRoleKey": "qa-inspector",
                         "permAllow": ["unrelated.read", CANARY], "permDeny": ["unrelated.delete"]}
        self.changed_snapshot = False
        self.changed_commit = False
        self.snapshot_reads = self.version_reads = 0
        self.updates = []

    def http(self, base, path, token="", method="GET", body=None, **kwargs):
        if path == "/api/version":
            self.version_reads += 1
            if self.changed_commit and self.version_reads > 1:
                self.calls.append((method, path, body))
                return {**response(), "payload": {"commit": "e" * 40}}
        if path == "/api/authz/me":
            self.calls.append((method, path, body))
            return response({"userId": "user_own", "username": self.username, "isRoot": False, "effectivePermissions": self.grants})
        if path == "/api/authz/catalog":
            self.calls.append((method, path, body))
            return response({"items": [{"key": key} for key in self.catalog]})
        if path == "/api/authz/users/user_own/authz":
            self.calls.append((method, path, body))
            if method == "PUT":
                self.updates.append(body)
                self.snapshot = {**self.snapshot, **body}
                self.grants = self.grants + [key for key in smoke.SPEECH_PERMISSIONS if key not in self.grants]
            else:
                self.snapshot_reads += 1
                if self.changed_snapshot and self.snapshot_reads > 1:
                    return response({**self.snapshot, "permAllow": [*self.snapshot["permAllow"], "concurrent.change"]})
            return response(self.snapshot.copy())
        return super().http(base, path, token, method, body, **kwargs)


def access_runner(fixture, enabled=True):
    return smoke.SpeechSmoke(BASE, COMMIT, http=fixture.http, session=lambda *_: ("rsa", CANARY, {}), prepare_access=enabled)


class OwnAccessPreparationTests(unittest.TestCase):
    def test_default_does_not_read_or_modify_user_authorization_snapshot(self):
        fixture = AccessFixture()
        access_runner(fixture, enabled=False).readiness()
        self.assertFalse(fixture.updates)
        self.assertFalse(any(path.startswith("/api/authz/users/") for _, path, _ in fixture.calls))

    def test_explicit_grant_adds_only_own_speech_permissions_and_preserves_other_state(self):
        fixture = AccessFixture()
        before = fixture.snapshot.copy()
        check = access_runner(fixture)
        self.assertTrue(check.readiness())
        self.assertEqual(len(fixture.updates), 1)
        update = fixture.updates[0]
        self.assertEqual(set(update), {"systemRoleKey", "permAllow", "permDeny"})
        self.assertEqual(update["systemRoleKey"], before["systemRoleKey"])
        self.assertEqual(update["permDeny"], before["permDeny"])
        self.assertEqual(update["permAllow"], before["permAllow"] + smoke.SPEECH_PERMISSIONS)
        self.assertNotIn("super", update["permAllow"])
        self.assertTrue(all(path == "/api/authz/users/user_own/authz" for method, path, _ in fixture.calls if method == "PUT"))
        report = check.finish()
        self.assertEqual(report["accessPreparation"], {"grantedOwnSpeechAccess": True, "permissions": {"read": True, "generate": True, "manage": True}})
        self.assertNotIn(CANARY, json.dumps(report))
        self.assertNotIn("qa-inspector", json.dumps(report))

    def test_existing_effective_permissions_are_idempotent_without_put(self):
        fixture = AccessFixture()
        fixture.grants += smoke.SPEECH_PERMISSIONS
        check = access_runner(fixture)
        self.assertTrue(check.readiness())
        self.assertFalse(fixture.updates)
        self.assertFalse(check.report["accessPreparation"]["grantedOwnSpeechAccess"])

    def test_explicit_speech_deny_is_not_removed(self):
        fixture = AccessFixture()
        fixture.snapshot["permDeny"].append("mcp-speech.generate")
        with self.assertRaisesRegex(smoke.CheckFailure, "explicit_speech_deny"):
            access_runner(fixture).readiness()
        self.assertFalse(fixture.updates)
        self.assertIn("mcp-speech.generate", fixture.snapshot["permDeny"])

    def test_wrong_real_username_is_rejected_before_snapshot_access(self):
        fixture = AccessFixture()
        fixture.username = "another_user"
        with self.assertRaisesRegex(smoke.CheckFailure, "identity_mismatch"):
            access_runner(fixture).readiness()
        self.assertFalse(fixture.updates)
        self.assertEqual(fixture.snapshot_reads, 0)

    def test_missing_manage_authority_or_catalog_permission_never_writes(self):
        for change in ("authority", "catalog"):
            fixture = AccessFixture()
            if change == "authority":
                fixture.grants.remove("authz.manage")
            else:
                fixture.catalog.remove("mcp-speech.manage")
            with self.subTest(change=change), self.assertRaises(smoke.CheckFailure):
                access_runner(fixture).readiness()
            self.assertFalse(fixture.updates)

    def test_snapshot_identity_cannot_redirect_an_update_to_other_user(self):
        fixture = AccessFixture()
        fixture.snapshot["userId"] = "someone_else"
        with self.assertRaisesRegex(smoke.CheckFailure, "snapshot_identity_mismatch"):
            access_runner(fixture).readiness()
        self.assertFalse(fixture.updates)

    def test_changed_snapshot_or_commit_stops_before_put(self):
        for change in ("snapshot", "commit"):
            fixture = AccessFixture()
            setattr(fixture, "changed_" + change, True)
            with self.subTest(change=change), self.assertRaises(smoke.CheckFailure):
                access_runner(fixture).readiness()
            self.assertFalse(fixture.updates)

    def test_noncanonical_role_is_not_silently_normalized_by_put(self):
        fixture = AccessFixture()
        fixture.snapshot["systemRoleKey"] = "LegacyRole"
        with self.assertRaisesRegex(smoke.CheckFailure, "snapshot_not_preservable"):
            access_runner(fixture).readiness()
        self.assertFalse(fixture.updates)


class UnconfiguredUiReadinessTests(unittest.TestCase):
    def empty_runner(self):
        fixture = Fixture()

        def http(base, path, token="", method="GET", body=None, **kwargs):
            if path in ("/api/mcp-speech/capabilities", "/api/mcp-speech/settings"):
                fixture.calls.append((method, path, body))
                return response({"profiles": [], "canManage": False})
            return fixture.http(base, path, token, method, body, **kwargs)

        return fixture, smoke.SpeechSmoke(BASE, COMMIT, http=http, session=lambda *_: ("rsa", CANARY, {}))

    def test_empty_ui_is_eligible_only_after_real_feature_and_read_access_checks(self):
        fixture, check = self.empty_runner()
        self.assertFalse(check.readiness())
        self.assertTrue(check.can_check_unconfigured_ui())
        self.assertFalse(check.report["run"]["attempted"])
        self.assertTrue(all(method == "GET" for method, _, _ in fixture.calls))
        check.report["permissions"]["speechRead"] = False
        self.assertFalse(check.can_check_unconfigured_ui())

    def test_missing_feature_does_not_attempt_empty_ui_login(self):
        check = runner(Fixture(missing=True))
        check.readiness()
        self.assertFalse(check.can_check_unconfigured_ui())

    def test_explicit_readiness_ui_check_does_not_turn_empty_profile_into_synthesis_pass(self):
        fixture, check = self.empty_runner()

        def browser_result(*args, **kwargs):
            check.report["browser"] = {"scope": "unconfigured_state", "ok": True, "synthesisVerified": False}

        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"DEFAULT_MAP_BASE": BASE, "STABLE_SMOKE_USER": "stsmk_prod"}), \
                patch.object(smoke, "SpeechSmoke", return_value=check), patch.object(check, "verify_browser", side_effect=browser_result) as browser, \
                contextlib.redirect_stdout(io.StringIO()):
            output = Path(directory) / "report.json"
            code = smoke.main(["--map-base", BASE, "--expect-commit", COMMIT, "--check-unconfigured-ui", "--json-out", str(output)])
            self.assertEqual(code, 1)
            browser.assert_called_once_with(output.parent, unconfigured=True)
            report = json.loads(output.read_text())
        self.assertEqual(report["verdict"], "fail")
        self.assertFalse(report["run"]["attempted"])
        self.assertFalse(report["browser"]["synthesisVerified"])
        self.assertTrue(all(method == "GET" for method, _, _ in fixture.calls))

    def test_empty_ui_ticket_does_not_require_or_fabricate_a_run(self):
        captured = []

        def http(base, path, **kwargs):
            captured.append(kwargs)
            return response({"loginUrl": BASE + "/synthetic-login#code=" + CANARY})

        check = smoke.SpeechSmoke(BASE, COMMIT, http=http)
        with patch.object(smoke.subprocess, "run", return_value=SimpleNamespace(stdout="{}")):
            check.browser_login_url()
        self.assertEqual(captured[0]["body"]["returnUrl"], "/mcp-console?tab=speech")
        self.assertNotIn(CANARY, json.dumps(check.report))


class ProductionSpeechTests(unittest.TestCase):
    def test_preinstalled_chrome_is_used_without_dropping_real_browser_checks(self):
        with patch.object(smoke.shutil, "which", side_effect=lambda name: "/usr/bin/google-chrome" if name == "google-chrome" else None):
            options = smoke.browser_launch_options()
        self.assertEqual(options["executable_path"], "/usr/bin/google-chrome")
        self.assertTrue(options["headless"])
        self.assertIn("--autoplay-policy=no-user-gesture-required", options["args"])

    def test_missing_system_browser_keeps_bundled_headless_shell_selection(self):
        with patch.object(smoke.shutil, "which", return_value=None):
            self.assertIsNone(smoke.system_browser_executable())
            self.assertNotIn("executable_path", smoke.browser_launch_options())

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

    def test_screenshot_guard_rejects_login_fragments_and_sensitive_queries(self):
        for value in [BASE + "/synthetic-login#code=" + CANARY, BASE + "/mcp-console#code=" + CANARY,
                      BASE + "/mcp-console?token=" + CANARY, "https://other.example/mcp-console"]:
            self.assertFalse(smoke.safe_browser_page(value, BASE))
        self.assertTrue(smoke.safe_browser_page(BASE + "/mcp-console?tab=speech&run=" + RUN_ID, BASE))
        self.assertTrue(smoke.safe_browser_page(BASE + "/my-assets?tab=audio", BASE))

    def test_browser_ticket_url_is_same_origin_and_never_reported(self):
        captured = []

        def http(base, path, **kwargs):
            captured.append((path, kwargs))
            return response({"loginUrl": BASE + "/synthetic-login#code=" + CANARY})

        check = smoke.SpeechSmoke(BASE, COMMIT, http=http)
        with patch.object(smoke.subprocess, "run", return_value=SimpleNamespace(stdout="{}")):
            url = check.browser_login_url(RUN_ID)
        self.assertIn(CANARY, url)  # Only the in-memory return value contains the one-time code.
        self.assertNotIn(CANARY, json.dumps(check.report))
        self.assertEqual(captured[0][1]["body"]["returnUrl"], "/mcp-console?tab=speech&run=" + RUN_ID)

        with patch.object(smoke.subprocess, "run", return_value=SimpleNamespace(stdout="{}")):
            check.http = lambda *a, **k: response({"loginUrl": "https://other.example/synthetic-login#code=" + CANARY})
            with self.assertRaises(smoke.CheckFailure):
                check.browser_login_url(RUN_ID)

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
