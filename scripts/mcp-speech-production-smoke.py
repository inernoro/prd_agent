#!/usr/bin/env python3
"""Production speech checks. Readiness is read-only unless prepare-access is explicit.

RSA credentials stay in the Actions runner. Reports use an explicit allowlist:
never write authentication responses, tickets, signatures, tokens, key material,
raw provider responses, user text, or browser state to stdout or artifacts.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("speech_preflight_auth", ROOT / "llmgw-prod-preflight.py")
AUTH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUTH)
SPEECH_SCOPES = ["mcp-speech:read", "mcp-speech:generate"]
SPEECH_PERMISSIONS = ["mcp-speech.read", "mcp-speech.generate", "mcp-speech.manage"]
PROTOCOLS = {"openai", "doubao-tts"}
MIMES = {"mp3": "audio/mpeg", "wav": "audio/wav", "aac": "audio/aac", "flac": "audio/flac",
         "opus": "audio/ogg", "ogg_opus": "audio/ogg", "pcm": "audio/pcm"}
TEXT = "MAP生产语音验收，请保持声音自然清晰。"
MAX_AUDIO = 32 * 1024 * 1024


class CheckFailure(Exception):
    """Only internal constant failure codes may reach the report."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(base, path, token="", method="GET", body=None, timeout=30, binary=False, headers=None):
    """No redirects: never forward a bearer or a signature to another origin."""
    url = base + path
    values = {"Accept": "audio/*" if binary else "application/json", **(headers or {})}
    if token:
        values["Authorization"] = "Bearer " + token
    raw_body = None if body is None else json.dumps(body, separators=(",", ":")).encode()
    if raw_body is not None:
        values["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=raw_body, method=method, headers=values)
    try:
        with urllib.request.build_opener(NoRedirect).open(req, timeout=timeout) as response:
            raw, status, mime = response.read((MAX_AUDIO if binary else 2_000_000) + 1), response.status, response.headers.get_content_type()
    except urllib.error.HTTPError as error:
        raw, status, mime = b"", error.code, ""
    except Exception:  # Do not serialize exception messages: they can contain credentials/URLs.
        return {"status": 0, "payload": None, "raw": b"", "mime": ""}
    payload = None
    if not binary and len(raw) <= 2_000_000:
        try:
            payload = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            pass
    return {"status": status, "payload": payload, "raw": raw if binary else b"", "mime": mime}


def data_of(result):
    payload = result.get("payload")
    if not isinstance(payload, dict) or payload.get("success") is not True:
        return None
    data = payload.get("data")
    return data if isinstance(data, dict) else None


def safe_identifier(value):
    return value if isinstance(value, str) and re.fullmatch(r"[0-9a-f]{32}", value) else None


def validate_target(base, expected, allowed):
    if not re.fullmatch(r"[0-9a-fA-F]{40}", expected):
        raise CheckFailure("expected_commit_required")
    target, trusted = urllib.parse.urlsplit(base), urllib.parse.urlsplit(allowed)
    if (target.scheme != "https" or not target.hostname or target.username or target.password
            or target.path.rstrip("/") or target.query or target.fragment
            or trusted.scheme != "https" or not trusted.hostname
            or (target.scheme, target.hostname, target.port) != (trusted.scheme, trusted.hostname, trusted.port)):
        raise CheckFailure("target_not_approved_production_origin")


def safe_browser_page(url, base):
    """Screenshots are permitted only after the one-time login fragment is gone."""
    parsed, trusted = urllib.parse.urlsplit(url), urllib.parse.urlsplit(base)
    return ((parsed.scheme, parsed.netloc) == (trusted.scheme, trusted.netloc) and not parsed.fragment
            and parsed.path in {"/mcp-console", "/my-assets"}
            and set(urllib.parse.parse_qs(parsed.query)).issubset({"tab", "run"}))


def system_browser_executable():
    """Hosted Ubuntu runners already include Chrome; avoid redundant browser/dependency downloads."""
    return next((path for name in ("google-chrome", "google-chrome-stable", "chromium") if (path := shutil.which(name))), None)


def browser_launch_options():
    result = {"headless": True, "args": ["--autoplay-policy=no-user-gesture-required"]}
    executable = system_browser_executable()
    if executable:
        result["executable_path"] = executable
    return result


class SpeechSmoke:
    def __init__(self, base, expected, mode="readiness", *, http=request, session=None, wait_seconds=180, profile_id="", inventory=False, prepare_access=False):
        self.base, self.expected, self.mode = base.rstrip("/"), expected.lower(), mode
        self.http, self.session = http, session or AUTH._stable_smoke_session
        self.wait_seconds, self.profile_id, self.inventory = wait_seconds, profile_id, inventory
        self.prepare_access = prepare_access
        self.token = ""
        self.profiles = []
        self.report = {"schemaVersion": 1, "mode": mode, "expectedCommit": self.expected,
                       "startedAt": datetime.now(timezone.utc).isoformat(), "checks": [], "run": {"attempted": False}}

    def check(self, name, ok, *, status=None, failure="check_failed", required=True):
        item = {"name": name, "ok": bool(ok), "required": required}
        if status is not None:
            item["status"] = int(status)
        if not ok:
            item["failureCode"] = failure
        self.report["checks"].append(item)
        return bool(ok)

    def get(self, path, token=None, **kwargs):
        return self.http(self.base, path, self.token if token is None else token, **kwargs)

    def probe(self, name, path):
        response = self.get(path)
        data = data_of(response)
        self.check(name, 200 <= response["status"] < 300 and data is not None, status=response["status"],
                   failure="feature_missing" if response["status"] == 404 else "authorization_denied" if response["status"] in (401, 403) else "invalid_or_unavailable_response")
        return data

    def readiness(self):
        version = self.get("/api/version", token="")
        payload = version["payload"] if isinstance(version["payload"], dict) else {}
        commit = payload.get("commit")
        valid_commit = isinstance(commit, str) and re.fullmatch(r"[0-9a-fA-F]{40}", commit)
        self.report["actualCommit"] = commit.lower() if valid_commit else None
        if not self.check("production_commit", version["status"] == 200 and valid_commit and commit.lower() == self.expected,
                          status=version["status"], failure="production_commit_mismatch"):
            return False
        session = self.session(self.base, 30)
        self.token = session[1] if session else ""
        if not self.check("signed_map_session", bool(self.token), failure="signed_session_unavailable"):
            return False
        auth = self.probe("owner_authorization", "/api/authz/me")
        if self.prepare_access:
            auth = self.prepare_own_speech_access(auth)
        grants = auth.get("effectivePermissions", []) if auth else []
        grants = grants if isinstance(grants, list) else []
        super_user = "super" in grants
        manage = super_user or "mcp-speech.manage" in grants
        generate = manage or "mcp-speech.generate" in grants
        self.report["permissions"] = {"speechRead": generate or "mcp-speech.read" in grants,
                                      "speechGenerate": generate, "speechConfigure": manage,
                                      "authorizationManage": super_user or "authz.manage" in grants, "super": super_user}
        capabilities = self.probe("speech_capabilities", "/api/mcp-speech/capabilities")
        settings = self.probe("speech_settings", "/api/mcp-speech/settings")
        profiles = capabilities.get("profiles") if capabilities else None
        configured = settings.get("profiles") if settings else None
        self.profiles = profiles if isinstance(profiles, list) else []
        available = [p for p in self.profiles if isinstance(p, dict) and p.get("available") is True]
        self.report["capabilities"] = {"profileCount": len(self.profiles), "availableCount": len(available),
            "protocols": sorted({p["protocol"] for p in self.profiles if isinstance(p, dict) and p.get("protocol") in PROTOCOLS})}
        self.report["configuration"] = {"profileCount": len(configured) if isinstance(configured, list) else None,
                                        "canManage": bool(settings and settings.get("canManage") is True)}
        self.check("speech_run_ready", bool(available) and self.report["permissions"]["speechRead"] and generate,
                   failure="speech_profile_or_authorization_not_ready")
        if self.inventory:
            self.gateway_inventory()
        return all(item["ok"] for item in self.report["checks"] if item["required"])

    def prepare_own_speech_access(self, auth):
        """Only the three registered speech permissions, only on the verified caller's own account."""
        summary = {"grantedOwnSpeechAccess": False}
        self.report["accessPreparation"] = summary
        self.require("access_prepare_verified_commit", self.report.get("actualCommit") == self.expected
                     and any(x["name"] == "production_commit" and x["ok"] for x in self.report["checks"]), "access_prepare_commit_not_verified")
        uid = auth.get("userId") if isinstance(auth, dict) else None
        valid_uid = isinstance(uid, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", uid) and uid != "root"
        self.require("access_prepare_own_identity", bool(valid_uid) and auth.get("username") == "stsmk_prod"
                     and auth.get("isRoot") is not True, "access_prepare_identity_mismatch")
        grants = auth.get("effectivePermissions", [])
        self.require("access_prepare_authority", isinstance(grants, list) and "authz.manage" in grants, "access_prepare_authority_missing")
        catalog = self.probe("access_prepare_permission_catalog", "/api/authz/catalog")
        registered = {x.get("key") for x in (catalog or {}).get("items", []) if isinstance(x, dict) and isinstance(x.get("key"), str)}
        self.require("access_prepare_registered_permissions", set(SPEECH_PERMISSIONS).issubset(registered), "access_prepare_permission_not_registered")
        path = "/api/authz/users/" + urllib.parse.quote(uid, safe="") + "/authz"
        snapshot = self.probe("access_prepare_own_snapshot", path)
        self.require("access_prepare_snapshot_identity", bool(snapshot) and snapshot.get("userId") == uid
                     and snapshot.get("username") == "stsmk_prod", "access_prepare_snapshot_identity_mismatch")
        allow, deny, role = snapshot.get("permAllow"), snapshot.get("permDeny"), snapshot.get("systemRoleKey")
        # The official PUT normalizes these fields. Reject noncanonical snapshots instead of altering unrelated state.
        def preserved_list(value):
            return isinstance(value, list) and all(isinstance(x, str) and x and x == x.strip() for x in value) and len(set(value)) == len(value)
        self.require("access_prepare_snapshot_preservable", preserved_list(allow) and preserved_list(deny)
                     and (role is None or isinstance(role, str) and bool(role) and role == role.strip().lower()), "access_prepare_snapshot_not_preservable")
        self.require("access_prepare_no_explicit_speech_deny", not set(deny).intersection(SPEECH_PERMISSIONS), "access_prepare_explicit_speech_deny")
        summary["permissions"] = {key.rsplit(".", 1)[1]: key in grants for key in SPEECH_PERMISSIONS}
        if set(SPEECH_PERMISSIONS).issubset(grants):
            self.check("access_prepare_already_granted", True)
            return auth
        # Do not overwrite a concurrently edited role or permission snapshot.
        current = self.probe("access_prepare_snapshot_rechecked", path)
        fields = ("userId", "username", "systemRoleKey", "permAllow", "permDeny")
        self.require("access_prepare_snapshot_unchanged", bool(current) and all(current.get(key) == snapshot.get(key) for key in fields), "access_prepare_snapshot_changed")
        version = self.get("/api/version", token="")
        version_payload = version.get("payload")
        self.require("access_prepare_commit_rechecked", version["status"] == 200 and isinstance(version_payload, dict)
                     and version_payload.get("commit") == self.expected, "access_prepare_commit_changed")
        updated_allow = list(allow) + [permission for permission in SPEECH_PERMISSIONS if permission not in allow]
        result = self.get(path, method="PUT", body={"systemRoleKey": role, "permAllow": updated_allow, "permDeny": list(deny)})
        updated = data_of(result)
        self.require("access_prepare_update_preserved", bool(updated) and updated.get("userId") == uid and updated.get("username") == "stsmk_prod"
                     and updated.get("systemRoleKey") == role and set(updated.get("permAllow", [])) == set(updated_allow)
                     and updated.get("permDeny") == deny, "access_prepare_update_not_verified")
        fresh = self.probe("access_prepare_authorization_rechecked", "/api/authz/me")
        fresh_grants = fresh.get("effectivePermissions", []) if fresh else []
        self.require("access_prepare_effective_permissions", bool(fresh) and fresh.get("userId") == uid and fresh.get("username") == "stsmk_prod"
                     and isinstance(fresh_grants, list) and set(SPEECH_PERMISSIONS).issubset(fresh_grants), "access_prepare_effective_permissions_missing")
        summary.update({"grantedOwnSpeechAccess": True,
                        "permissions": {key.rsplit(".", 1)[1]: key in fresh_grants for key in SPEECH_PERMISSIONS}})
        return fresh

    def gateway_inventory(self):
        """Optional viewer-only inventory; no role changes, raw names, keys or offering config are reported."""
        summary = {"checked": True, "ok": False, "privilegeChanged": False}
        self.report["gatewayInventory"] = summary
        try:
            path = "/api/v1/auth/synthetic/gateway-ticket"
            signed = subprocess.run(["node", str(ROOT / "stable-smoke-signature.mjs"), "--method", "POST", "--url", self.base + path,
                                     "--body", "", "--username", os.environ.get("STABLE_SMOKE_USER", "")],
                                    capture_output=True, text=True, check=True, timeout=30)
            headers = json.loads(signed.stdout)
            issued = data_of(self.http(self.base, path, method="POST", headers=headers))
            code = issued.get("code") if issued else None
            if not isinstance(code, str):
                raise CheckFailure("gateway_ticket_unavailable")
            login_result = self.http(self.base, "/llmgw/gw/auth/stable-smoke-sso", method="POST", body={"code": code})
            login = data_of(login_result)
            if not login or str((login.get("tenant") or {}).get("role", "")).lower() != "viewer":
                raise CheckFailure("gateway_viewer_session_unavailable")
            console_token = login.get("token")
            if not isinstance(console_token, str) or not console_token:
                raise CheckFailure("gateway_viewer_session_unavailable")
            response = self.http(self.base, "/llmgw/gw/logical-models?modelType=tts", console_token)
            models = data_of(response)
            items = models.get("items") if models else None
            if not isinstance(items, list):
                raise CheckFailure("gateway_inventory_unavailable")
            offerings = [o for model in items if isinstance(model, dict) for o in model.get("offerings", []) if isinstance(o, dict)]
            exchanges_response = self.http(self.base, "/llmgw/gw/exchanges", console_token)
            exchanges = data_of(exchanges_response)
            exchange_items = exchanges.get("items") if exchanges else None
            typed = [item for item in exchange_items or [] if isinstance(item, dict)
                     and (item.get("transformerType") == "doubao-tts" or any(model.get("modelType") == "tts" for model in item.get("models", []) if isinstance(model, dict)))]
            known = {"openai", "openai-compatible", "exchange", "doubao-tts"}
            summary.update({"ok": True, "viewer": True, "ttsLogicalModelCount": len(items), "ttsOfferingCount": len(offerings),
                            "protocols": sorted({o["protocol"] for o in offerings if o.get("protocol") in known}),
                            "hasExplicitDoubaoTtsProtocol": any(o.get("protocol") == "doubao-tts" for o in offerings),
                            "exchangeInventoryAvailable": isinstance(exchange_items, list), "ttsExchangeCount": len(typed),
                            "doubaoTtsExchangeCount": sum(x.get("transformerType") == "doubao-tts" for x in typed),
                            "enabledDoubaoTtsResourcesWithCredentials": sum(x.get("transformerType") == "doubao-tts" and x.get("enabled") is True
                                and x.get("hasKey") is True and bool(x.get("resourceId")) for x in typed)})
        except Exception:
            summary["failureCode"] = "viewer_inventory_unavailable"
        self.check("gateway_viewer_inventory", summary["ok"], failure="viewer_inventory_unavailable", required=False)

    def tool(self, key, name, arguments):
        response = self.get("/api/mcp", token=key, method="POST", body={"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                            "params": {"name": name, "arguments": arguments}})
        payload = response["payload"] if isinstance(response["payload"], dict) else {}
        result = payload.get("result") or {}
        if response["status"] != 200 or result.get("isError") or "error" in payload:
            raise CheckFailure("mcp_tool_rejected")
        try:
            content = result["content"]
            parsed = json.loads(next(item["text"] for item in content if item.get("type") == "text"))
        except (KeyError, StopIteration, ValueError, TypeError):
            raise CheckFailure("mcp_response_invalid") from None
        data = data_of({"payload": parsed})
        if data is None:
            raise CheckFailure("mcp_business_failed")
        return data

    def require(self, name, ok, failure):
        if not self.check(name, ok, failure=failure):
            raise CheckFailure(failure)

    def run(self):
        """Generate one short task; the second identical submit only verifies idempotency after completion."""
        selected = [p for p in self.profiles if isinstance(p, dict) and p.get("available") is True
                    and (p.get("id") == self.profile_id if self.profile_id else p.get("isDefault") is True)]
        self.require("selected_profile", len(selected) == 1, "available_explicit_profile_required")
        profile = selected[0]
        self.require("short_input", len(TEXT) <= 60 and len(TEXT) <= profile.get("maxTextChars", 0), "short_input_not_supported")
        self.report["run"]["attempted"] = True
        suffix = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:8]
        title = "stsmk_prod speech " + suffix
        key_id, key = None, ""
        run_id = None
        try:
            created = data_of(self.get("/api/agent-api-keys", method="POST", body={"name": title, "description": "Production speech acceptance; expires after one day and is revoked in finally.",
                "ttlDays": 1, "scopeMode": "manual", "scopes": SPEECH_SCOPES}))
            item = created.get("item", {}) if created else {}
            key_id = safe_identifier(item.get("id"))
            key = created.get("apiKey", "") if created else ""
            self.require("temporary_key_created", bool(key_id and isinstance(key, str) and key), "temporary_key_unavailable")
            expires = datetime.fromisoformat(str(item.get("expiresAt", "")).replace("Z", "+00:00"))
            self.require("temporary_key_least_privilege", item.get("scopeMode") == "manual" and set(item.get("scopes", [])) == set(SPEECH_SCOPES)
                and datetime.now(timezone.utc) < expires <= datetime.now(timezone.utc) + timedelta(days=1, minutes=2), "temporary_key_contract_mismatch")
            offered = self.tool(key, "map_speech_capabilities", {})
            self.require("mcp_profile_visible", any(p.get("id") == profile["id"] and p.get("revision") == profile["revision"]
                and p.get("available") is True for p in offered.get("profiles", []) if isinstance(p, dict)), "mcp_profile_unavailable")
            options = {"profileId": profile["id"], "profileRevision": profile["revision"], "voiceId": profile["defaultVoiceId"],
                       "format": profile["defaultFormat"], "speed": 1}
            preset = self.tool(key, "map_speech_save_preset", {"name": title, **options})
            preset_id = safe_identifier(preset.get("id"))
            self.require("preset_saved", bool(preset_id), "preset_contract_invalid")
            body = {"text": TEXT, "title": title, "presetId": preset_id, "clientRequestId": "stsmk_prod-" + suffix, **options}
            run = self.tool(key, "map_speech_generate", body)
            run_id = safe_identifier(run.get("runId") or run.get("id"))
            self.require("generation_submitted", bool(run_id), "run_contract_invalid")
            deadline = time.monotonic() + self.wait_seconds
            while run.get("status") in {"queued", "preparing", "generating", "saving"} and time.monotonic() < deadline:
                time.sleep(3)
                run = self.tool(key, "map_speech_get_run", {"runId": run_id})
            self.report["run"]["status"] = run.get("status") if run.get("status") in {"queued", "preparing", "generating", "saving", "completed", "failed", "unknown"} else "unrecognized"
            self.require("generation_completed", run.get("status") == "completed", "upstream_result_unknown" if run.get("status") == "unknown" else "generation_failed_or_timed_out")
            duplicate = self.tool(key, "map_speech_generate", body)
            self.require("identical_submit_deduplicated", (duplicate.get("runId") or duplicate.get("id")) == run_id
                         and duplicate.get("deduplicated") is True, "idempotency_not_confirmed")
            history = self.probe("owner_history_available", "/api/mcp-speech/runs?limit=100")
            self.require("owner_history_contains_run", bool(history) and any(x.get("id") == run_id for x in history.get("items", []) if isinstance(x, dict)), "owner_history_missing_run")
            assets = self.probe("owner_assets_available", "/api/mobile/assets?category=audio&limit=100")
            self.require("owner_asset_contains_run", bool(assets) and any(x.get("id") == "speech-" + run_id for x in assets.get("items", []) if isinstance(x, dict)), "owner_asset_missing_run")
            audio_path = "/api/open/speech/runs/" + run_id + "/audio"
            audio = self.get(audio_path, token=key, binary=True)
            expected_mime = MIMES.get(run.get("format"))
            self.require("authenticated_audio_valid", audio["status"] == 200 and audio["mime"] == expected_mime
                         and 0 < len(audio["raw"]) <= MAX_AUDIO, "audio_contract_invalid")
            self.report["run"]["audio"] = {"mime": audio["mime"], "sizeBytes": len(audio["raw"]), "sha256": hashlib.sha256(audio["raw"]).hexdigest()}
            self.report["run"]["runId"] = run_id
            self.report["run"]["title"] = title
        finally:
            if key_id:
                revoked = self.get("/api/agent-api-keys/" + key_id + "/revoke", method="POST", body={})
                self.check("temporary_key_revoked", data_of(revoked) is not None, status=revoked["status"], failure="temporary_key_revocation_failed")
                if key:
                    rejected = self.get("/api/open/speech/capabilities", token=key)
                    self.check("revoked_key_rejected", rejected["status"] in (401, 403), status=rejected["status"], failure="revoked_key_still_accepted")
                if run_id and self.report["run"].get("audio"):
                    owner_audio = self.get("/api/mcp-speech/runs/" + run_id + "/audio", binary=True)
                    self.check("owner_audio_after_key_revocation", owner_audio["status"] == 200
                        and hashlib.sha256(owner_audio["raw"]).hexdigest() == self.report["run"]["audio"]["sha256"],
                        status=owner_audio["status"], failure="owner_audio_unavailable_after_revocation")

    def browser_login_url(self, run_id=None):
        """Mint another short ticket for the real UI, never inject JWTs or storage state."""
        path = "/api/v1/auth/synthetic/ticket"
        body = {"returnUrl": "/mcp-console?tab=speech" + ("&run=" + run_id if run_id else ""), "expiresInSeconds": 180}
        wire = json.dumps(body, separators=(",", ":"))
        signed = subprocess.run(["node", str(ROOT / "stable-smoke-signature.mjs"), "--method", "POST", "--url", self.base + path,
                                 "--body", wire, "--username", os.environ.get("STABLE_SMOKE_USER", "")],
                                capture_output=True, text=True, check=True, timeout=30)
        headers = json.loads(signed.stdout)
        result = self.http(self.base, path, method="POST", headers=headers, body=body)
        issued = data_of(result)
        value = issued.get("loginUrl") if issued else None
        if not isinstance(value, str):
            raise CheckFailure("browser_login_ticket_unavailable")
        url = urllib.parse.urljoin(self.base, value)
        parsed, target = urllib.parse.urlsplit(url), urllib.parse.urlsplit(self.base)
        if (parsed.scheme, parsed.netloc) != (target.scheme, target.netloc) or parsed.path != "/synthetic-login" or not parsed.fragment:
            raise CheckFailure("browser_login_target_invalid")
        return url

    def can_check_unconfigured_ui(self):
        return (self.report.get("actualCommit") == self.expected and not self.profiles
                and self.report.get("configuration", {}).get("profileCount") == 0
                and self.report.get("permissions", {}).get("speechRead") is True
                and all(any(x["name"] == name and x["ok"] for x in self.report["checks"])
                        for name in ("production_commit", "speech_capabilities", "speech_settings")))

    def verify_browser(self, output_directory, *, unconfigured=False):
        """Real network and real one-time login. No interception, traces, HAR, video or saved browser state."""
        summary = {"checked": True, "realNetwork": True, "ok": False, "screenshots": [],
                   "scope": "unconfigured_state" if unconfigured else "generated_audio", "synthesisVerified": False}
        self.report["browser"] = summary
        run_id = safe_identifier(self.report["run"].get("runId"))
        title = self.report["run"].get("title")
        if unconfigured and not self.can_check_unconfigured_ui():
            self.require("production_unconfigured_browser", False, "unconfigured_ui_preconditions_not_met")
        if not unconfigured and (not run_id or not isinstance(title, str) or not title.startswith("stsmk_prod speech ")):
            self.require("production_browser_verification", False, "browser_run_identity_missing")
        page = None
        stage = "browser_start"
        errors = {"page": 0, "console": 0}
        try:
            from playwright.sync_api import sync_playwright

            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(**browser_launch_options())
                context = browser.new_context(viewport={"width": 1440, "height": 1000}, accept_downloads=False)
                page = context.new_page()
                page.set_default_timeout(45_000)
                page.on("pageerror", lambda _: errors.__setitem__("page", errors["page"] + 1))
                page.on("console", lambda message: errors.__setitem__("console", errors["console"] + (1 if message.type == "error" else 0)))
                try:
                    stage = "signed_browser_login"
                    login_url = self.browser_login_url(None if unconfigured else run_id)
                    page.goto(login_url, wait_until="domcontentloaded")
                    page.wait_for_function("() => location.pathname === '/mcp-console' && location.hash === ''")
                    page.get_by_role("heading", name="文生语音", exact=True).wait_for()
                    if not safe_browser_page(page.url, self.base):
                        raise CheckFailure("browser_authenticated_route_not_ready")

                    def photograph(name):
                        if not safe_browser_page(page.url, self.base):
                            raise CheckFailure("unsafe_screenshot_route")
                        path = Path(output_directory) / name
                        path.parent.mkdir(parents=True, exist_ok=True)
                        page.screenshot(path=str(path), full_page=False)
                        summary["screenshots"].append(name)

                    if unconfigured:
                        for label, width, height in [("desktop", 1440, 1000), ("mobile", 390, 844)]:
                            stage = label + "_unconfigured"
                            page.set_viewport_size({"width": width, "height": height})
                            empty = page.get_by_role("heading", name="当前环境尚未配置语音能力", exact=True)
                            empty.wait_for(state="visible")
                            generate = page.get_by_role("button", name="生成并保存语音", exact=True)
                            count = generate.count()
                            unavailable = count == 0 or all(generate.nth(index).is_disabled() for index in range(count))
                            self.require(label + "_unconfigured_generation_unavailable", unavailable, "unconfigured_generation_enabled")
                            summary[label] = {"unconfiguredMessageVisible": True, "generationUnavailable": unavailable,
                                              "generationControl": "absent" if count == 0 else "disabled"}
                            empty.scroll_into_view_if_needed()
                            photograph("speech-" + label + "-unconfigured.png")
                            if page.locator("vite-error-overlay").count() or not page.evaluate("document.documentElement.scrollWidth <= innerWidth"):
                                raise CheckFailure("unconfigured_browser_layout_invalid")
                        summary.update({"ok": errors["page"] == 0 and errors["console"] == 0,
                                        "pageErrorCount": errors["page"], "consoleErrorCount": errors["console"]})
                        self.require("production_unconfigured_browser", summary["ok"], "unconfigured_browser_runtime_errors")
                        return

                    def play_audio(container):
                        load = container.get_by_role("button", name="加载音频", exact=True)
                        if load.count():
                            load.first.click()
                        audio = container.locator("audio").first
                        audio.wait_for(state="visible")
                        audio.evaluate("element => element.play()")
                        audio.evaluate("element => new Promise((resolve,reject) => {const deadline=Date.now()+20000; const poll=()=>{if(Number.isFinite(element.duration)&&element.duration>0&&element.currentTime>0.12){resolve(true);return;} if(element.error||Date.now()>deadline){reject(new Error('Audio playback did not progress'));return;}setTimeout(poll,100);};poll();})")
                        duration = audio.evaluate("element => {element.pause();return element.duration;}")
                        return {"durationSeconds": round(duration, 3), "currentTimeProgressed": True}

                    for label, width, height in [("desktop", 1440, 1000), ("mobile", 390, 844)]:
                        stage = label + "_history"
                        page.set_viewport_size({"width": width, "height": height})
                        if label == "mobile":
                            page.go_back(wait_until="domcontentloaded")
                            page.wait_for_function("() => location.pathname === '/mcp-console' && location.hash === ''")
                        card = page.locator("#speech-run-" + run_id)
                        card.get_by_role("heading", name=title, exact=True).wait_for()
                        summary[label + "HistoryPlayback"] = play_audio(card)
                        card.scroll_into_view_if_needed()
                        photograph("speech-" + label + "-history.png")
                        stage = label + "_assets"
                        card.get_by_role("link", name="在我的资产中查看", exact=True).click()
                        page.wait_for_function("() => location.pathname === '/my-assets' && new URLSearchParams(location.search).get('tab') === 'audio'")
                        asset_title = page.get_by_text(title, exact=True).first
                        asset_title.wait_for(state="visible")
                        if label == "desktop":
                            page.locator('[role="button"]').filter(has_text=title).first.click()
                            summary[label + "AssetPlayback"] = play_audio(page.locator("main"))
                        else:
                            asset_card = asset_title.locator("xpath=../..")
                            summary[label + "AssetPlayback"] = play_audio(asset_card)
                        asset_title.scroll_into_view_if_needed()
                        photograph("speech-" + label + "-assets.png")
                        if page.locator("vite-error-overlay").count():
                            raise CheckFailure("browser_framework_error_overlay")
                        if not page.evaluate("document.documentElement.scrollWidth <= innerWidth"):
                            raise CheckFailure("browser_horizontal_overflow")
                    summary.update({"ok": errors["page"] == 0 and errors["console"] == 0,
                                    "pageErrorCount": errors["page"], "consoleErrorCount": errors["console"]})
                    self.require("production_browser_verification", summary["ok"], "browser_runtime_errors")
                    summary["synthesisVerified"] = True
                finally:
                    summary.update({"pageErrorCount": errors["page"], "consoleErrorCount": errors["console"]})
                    if not summary["ok"]:
                        summary["failureStage"] = stage
                        if safe_browser_page(page.url, self.base):
                            try:
                                photograph("speech-browser-failure.png")
                            except Exception:
                                pass
                    context.close()
                    browser.close()
        except CheckFailure:
            raise
        except Exception:
            summary["failureStage"] = stage
            self.require("production_browser_verification", False, "browser_verification_failed")

    def finish(self):
        self.report["finishedAt"] = datetime.now(timezone.utc).isoformat()
        self.report["verdict"] = "pass" if self.report["checks"] and all(x["ok"] for x in self.report["checks"] if x["required"]) else "fail"
        return self.report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--map-base", required=True)
    parser.add_argument("--expect-commit", required=True)
    parser.add_argument("--mode", choices=("readiness", "run"), default="readiness")
    parser.add_argument("--allow-production-run", action="store_true")
    parser.add_argument("--profile-id", default="")
    parser.add_argument("--wait-seconds", type=int, default=180)
    parser.add_argument("--gateway-inventory", action="store_true")
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument("--prepare-access", action="store_true", help="Explicitly allow adding only the three speech permissions to the verified stsmk_prod account.")
    parser.add_argument("--check-unconfigured-ui", action="store_true", help="In readiness mode only, verify the real empty speech UI without creating a task.")
    parser.add_argument("--json-out", required=True)
    args = parser.parse_args(argv)
    smoke = SpeechSmoke(args.map_base, args.expect_commit, args.mode, profile_id=args.profile_id,
                        wait_seconds=min(max(args.wait_seconds, 3), 300), inventory=args.gateway_inventory, prepare_access=args.prepare_access)
    try:
        validate_target(args.map_base, args.expect_commit, os.environ.get("DEFAULT_MAP_BASE", ""))
        if os.environ.get("STABLE_SMOKE_USER", "") != "stsmk_prod":
            raise CheckFailure("production_smoke_identity_required")
        if args.mode == "run" and not args.allow_production_run:
            raise CheckFailure("explicit_production_run_opt_in_required")
        if args.validate_only:
            smoke.check("production_target_validated", True)
        else:
            ready = smoke.readiness()
            if ready and args.mode == "run":
                smoke.run()
                if all(x["ok"] for x in smoke.report["checks"] if x["required"]):
                    smoke.verify_browser(Path(args.json_out).parent)
            elif args.mode == "readiness" and args.check_unconfigured_ui and smoke.can_check_unconfigured_ui():
                smoke.verify_browser(Path(args.json_out).parent, unconfigured=True)
    except CheckFailure as error:
        smoke.check("execution", False, failure=str(error))
    except Exception:
        smoke.check("execution", False, failure="unexpected_check_failure")
    report = smoke.finish()
    output = Path(args.json_out)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["verdict"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
