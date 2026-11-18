"""Adversarial contract tests. No live provider, approval server, or repository credentials."""
import asyncio
import copy
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import main
from app.authorization import RunAuthorization, authorize, narrow_request, check_tool_path
from app.schemas import SidecarRunRequest, SidecarEvent, SidecarToolDef
from app.sdk_tooling import build_sdk_tooling
from app.tool_bridge import ToolBridge
from test_official_sdk_helpers import (FakeBridge, PermissionResultAllow, PermissionResultDeny,
    create_sdk_mcp_server, sdk_tool)


class RuntimeAuthorizationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name, "workspace")
        self.root.mkdir()
        (self.root / "read.txt").write_text("allowed content")
        self.outside = Path(self.tmp.name, "secret.txt")
        self.outside.write_text("outside secret")
        self.env = patch.dict(os.environ, {"SIDECAR_AUTHORITY_URL": "https://authority.test", "AGENT_WORKSPACE_ROOT": str(self.root),
            "CLAUDE_AGENT_SDK_ALLOWED_TOOLS": "Read,Grep,Glob,Edit,Write"})
        self.env.start()
        self.addCleanup(self.env.stop)
        main._active_runs.clear()
        main._used_runs.clear()
        self.req = SidecarRunRequest(runId="run-a", workspaceRoot=str(self.root),
            builtinTools=["Read", "Grep", "Glob", "Edit", "Write"],
            callbackBaseUrl="https://authority.test", agentApiKey="map-task-v2.alice")
        self.auth = RunAuthorization("alice", "run-a", int(time.time()) + 600, "alice-hash")
        self.req._authorization = self.auth
        self.req._cancel_event = asyncio.Event()
        scope = self.req.model_dump(by_alias=True)
        self.scope = {"subject": "alice", "runId": "run-a", "purpose": "run",
            "expiresAt": self.auth.expires_at, "runtime": scope}

    def tooling(self, bridge=None):
        return build_sdk_tooling(self.req, bridge or FakeBridge(), create_sdk_mcp_server=create_sdk_mcp_server,
            sdk_tool=sdk_tool, permission_result_allow=PermissionResultAllow, permission_result_deny=PermissionResultDeny)

    async def test_read_hook_executes_only_contained_paths(self):
        (self.root / "link").symlink_to(self.outside)
        executed = []
        async def fake_provider_read(path):
            result = await self.tooling().pre_tool_use({"tool_name": "Read", "tool_input": {"file_path": path}}, "id", None)
            if result["hookSpecificOutput"]["permissionDecision"] == "allow":
                executed.append(path)
                return (self.root / path).read_text()
            return None
        for path in (str(self.outside), "../secret.txt", "link"):
            self.assertIsNone(await fake_provider_read(path))
        self.assertEqual(executed, [])
        self.assertEqual(await fake_provider_read("read.txt"), "allowed content")
        self.assertEqual(await fake_provider_read(str(self.root / "read.txt")), "allowed content")

    async def test_recursive_search_rejects_link_trees_and_escaping_patterns(self):
        for tool, args in [("Glob", {"pattern": "../*"}), ("Glob", {"pattern": "/etc/*"}),
                ("Grep", {"path": str(self.outside), "pattern": "secret"})]:
            self.assertIsInstance(await self.tooling().can_use_tool(tool, args, None), PermissionResultDeny)
        for tool in ("Glob", "Grep"):
            self.assertIsInstance(await self.tooling().can_use_tool(tool, {"pattern": "*"}, None), PermissionResultAllow)
        (self.root / "link").symlink_to(self.tmp.name, target_is_directory=True)
        for tool in ("Glob", "Grep"):
            self.assertIsInstance(await self.tooling().can_use_tool(tool, {"pattern": "*"}, None), PermissionResultDeny)

    async def test_approved_write_runs_but_denial_timeout_expiry_and_cancel_do_not(self):
        executed = []
        class TimeoutBridge(FakeBridge):
            async def wait_for_approval(self, *args):
                raise TimeoutError()
        for bridge in (FakeBridge(approved=False), FakeBridge(permission_requested=False), TimeoutBridge(), FakeBridge()):
            result = await self.tooling(bridge).pre_tool_use(
                {"tool_name": "Write", "tool_input": {"file_path": "new.txt", "content": "safe"}}, "id", None)
            if result["hookSpecificOutput"]["permissionDecision"] == "allow":
                executed.append("write")
                (self.root / "new.txt").write_text("safe")
        self.assertEqual(executed, ["write"])
        self.req._cancel_event.set()
        self.assertIsInstance(await self.tooling().can_use_tool("Read", {"file_path": "read.txt"}, None), PermissionResultDeny)
        self.req._cancel_event.clear()
        self.req._authorization = RunAuthorization("alice", "run-a", 0, "expired")
        self.assertIsInstance(await self.tooling().can_use_tool("Read", {"file_path": "read.txt"}, None), PermissionResultDeny)

    async def test_approval_return_after_cancel_cannot_release_tool(self):
        event = self.req._cancel_event
        class CancellingBridge(FakeBridge):
            async def wait_for_approval(self, *args):
                event.set()
                return True, "allowed"
        result = await self.tooling(CancellingBridge()).can_use_tool("Edit", {"file_path": "read.txt"}, None)
        self.assertIsInstance(result, PermissionResultDeny)

    async def test_unknown_and_shell_tools_are_not_auto_allowed(self):
        self.req.builtin_tools.append("Bash")
        for tool in ("Bash", "Agent", "WebFetch", "mcp__evil__read"):
            self.assertIsInstance(await self.tooling().can_use_tool(tool, {}, None), PermissionResultDeny)

    def test_request_can_only_narrow_authority_and_server_tool_policy(self):
        for field, value in [("workspace_root", "/etc"), ("profile", "other"), ("callback_base_url", "https://evil.test"),
                ("agent_api_key", "self-approved"), ("base_url", "https://evil.test"), ("api_key", "other"),
                ("builtin_tools", ["Bash"]), ("timeout_seconds", 601),
                ("tools", [SidecarToolDef(name="evil", description="", input_schema={})])]:
            with self.subTest(field=field), self.assertRaises(HTTPException):
                narrow_request(self.req.model_copy(update={field:value}), copy.deepcopy(self.scope), "map-task-v2.alice")
        narrowed = self.req.model_copy(update={"builtin_tools": [], "timeout_seconds": 1})
        narrow_request(narrowed, copy.deepcopy(self.scope), "map-task-v2.alice")
        self.assertEqual(narrowed.builtin_tools, [])

    def test_unassigned_workspace_never_grants_default_filesystem_tools(self):
        req = self.req.model_copy(update={"workspace_root": None, "builtin_tools": None})
        scope = copy.deepcopy(self.scope)
        scope["runtime"]["workspaceRoot"] = None
        narrow_request(req, scope, "map-task-v2.alice")
        self.assertEqual(req.builtin_tools, [])
        req.builtin_tools = ["Read"]
        with self.assertRaises(HTTPException):
            narrow_request(req, scope, "map-task-v2.alice")

    async def test_authority_is_fixed_and_credential_is_bound_to_run_and_purpose(self):
        calls = []
        real_client = httpx.AsyncClient
        def server(request):
            calls.append(str(request.url))
            import json
            body = json.loads(request.content)
            data = copy.deepcopy(self.scope)
            data["purpose"] = body["purpose"]
            if body["runId"] != "run-a":
                return httpx.Response(403)
            return httpx.Response(200, json=data)
        with patch("app.authorization.httpx.AsyncClient", lambda **kw: real_client(transport=httpx.MockTransport(server), **kw)):
            auth, _ = await authorize("Bearer map-task-v2.alice", "run-a", "run")
            self.assertEqual(auth.subject, "alice")
            with self.assertRaises(HTTPException):
                await authorize("Bearer map-task-v2.alice", "run-b", "run")
            for bearer in (None, "Bearer shared", "Bearer dev-skip"):
                with self.assertRaises(HTTPException):
                    await authorize(bearer, "run-a", "run")
        self.assertEqual(set(calls), {"https://authority.test/api/agent-tools/authorize"})

    async def test_duplicate_run_reservation_two_principals_and_owner_cancel(self):
        async def fake_auth(token, run_id, purpose):
            await asyncio.sleep(0)
            if run_id != "run-a":
                raise HTTPException(403)
            return (self.auth if token.endswith("alice") else RunAuthorization("bob", run_id, self.auth.expires_at, "bob-hash")), {**self.scope, "state": {"complete": "completed", "cancel": "cancel_requested", "fail": "failed"}.get(purpose, "running")}
        class Request:
            async def is_disconnected(self): return False
        async def fake_provider(req, cancel_event):
            yield SidecarEvent(type="text_delta", text="streaming")
            yield SidecarEvent(type="done", final_text="ok")
        with patch.object(main, "authorize", fake_auth), patch.object(main, "run_official_agent", fake_provider):
            results = await asyncio.gather(*[main.run(self.req.model_copy(), Request(), "Bearer map-task-v2.alice") for _ in range(2)], return_exceptions=True)
            self.assertEqual(sum(isinstance(r, HTTPException) and r.status_code == 409 for r in results), 1)
            with self.assertRaises(HTTPException) as error:
                await main.cancel("run-a", "Bearer map-task-v2.bob")
            self.assertEqual(error.exception.status_code, 403)
            self.assertFalse(main._active_runs["run-a"][1].is_set())
            response = next(r for r in results if not isinstance(r, Exception))
            chunks = [chunk async for chunk in response.body_iterator]
            self.assertIn(b"streaming", b"".join(chunks))
            self.assertIn(b"event: done", b"".join(chunks))
            with self.assertRaises(HTTPException):
                await main.run(self.req.model_copy(), Request(), "Bearer map-task-v2.alice")
            main._active_runs["run-a"] = (self.auth, asyncio.Event())
            self.assertEqual((await main.cancel("run-a", "Bearer map-task-v2.alice")).status_code, 202)
            self.assertTrue(main._active_runs["run-a"][1].is_set())

    async def test_two_subjects_run_concurrently_without_reading_or_cancelling_each_other(self):
        other = Path(self.tmp.name, "bob")
        other.mkdir()
        (other / "read.txt").write_text("bob content")
        bob = self.req.model_copy(update={"run_id": "run-b", "workspace_root": str(other), "agent_api_key": "map-task-v2.bob"})
        auth_bob = RunAuthorization("bob", "run-b", self.auth.expires_at, "bob-hash")
        async def fake_auth(token, run_id, purpose):
            await asyncio.sleep(0)
            req, auth = (self.req, self.auth) if token.endswith("alice") else (bob, auth_bob)
            if run_id != req.run_id:
                raise HTTPException(403)
            return auth, {"runtime": req.model_dump(by_alias=True), "state": {"complete": "completed", "cancel": "cancel_requested", "fail": "failed"}.get(purpose, "running")}
        class Request:
            async def is_disconnected(self): return False
        async def provider(req, cancel_event):
            own = Path(req.workspace_root)
            victim = other if req.run_id == "run-a" else self.root
            check_tool_path(str(own), "Read", {"file_path": "read.txt"})
            with self.assertRaises(ValueError):
                check_tool_path(str(own), "Read", {"file_path": str(victim / "read.txt")})
            yield SidecarEvent(type="text_delta", text=(own / "read.txt").read_text())
            await asyncio.sleep(0)
            yield SidecarEvent(type="done", final_text="ok")
        with patch.dict(os.environ, {"AGENT_WORKSPACE_ROOT": self.tmp.name}), patch.object(main, "authorize", fake_auth), patch.object(main, "run_official_agent", provider):
            responses = await asyncio.gather(main.run(self.req, Request(), "Bearer map-task-v2.alice"),
                main.run(bob, Request(), "Bearer map-task-v2.bob"))
            self.assertEqual(len(main._active_runs), 2)
            with self.assertRaises(HTTPException):
                await main.cancel("run-b", "Bearer map-task-v2.alice")
            self.assertFalse(main._active_runs["run-b"][1].is_set())
            async def read(response): return b"".join([chunk async for chunk in response.body_iterator])
            alice_output, bob_output = await asyncio.gather(*(read(response) for response in responses))
            self.assertIn(b"allowed content", alice_output)
            self.assertNotIn(b"bob content", alice_output)
            self.assertIn(b"bob content", bob_output)
            self.assertNotIn(b"allowed content", bob_output)

    async def test_readiness_requires_authority_not_shared_bearer(self):
        with patch.dict(os.environ, {"SIDECAR_AUTHORITY_URL": ""}), patch.object(main, "SIDECAR_TOKEN", "shared"):
            response = await main.readyz()
        self.assertEqual(response.status_code, 503)
        self.assertIn(b"missing SIDECAR_AUTHORITY_URL", response.body)

    async def test_missing_bridge_and_absent_approval_are_fail_closed(self):
        bridge = ToolBridge(None, None, "run-a", None, authorization=self.auth, allowed_tools={"Write"})
        self.assertFalse((await bridge.invoke("Write", {}))[0])
        self.assertFalse((await bridge.wait_for_approval("Write", ""))[0])

    async def test_bridge_denial_timeout_or_replay_never_invokes(self):
        real_client = httpx.AsyncClient
        calls = []
        for mode in ("deny", "timeout", "replay", "allow"):
            calls.clear()
            def server(request):
                calls.append(request.url.path)
                if request.url.path.endswith("/request"):
                    return httpx.Response(200, json={"success": True})
                if request.url.path.endswith("/wait"):
                    if mode == "timeout": raise httpx.ReadTimeout("timeout")
                    return httpx.Response(403 if mode == "replay" else 200, json={"success": mode == "allow"})
                return httpx.Response(200, json={"success": True, "content": "executed"})
            bridge = ToolBridge("https://authority.test", "map-task-v2.alice", "run-a", None,
                authorization=self.auth, allowed_tools={"Write"})
            with patch("app.tool_bridge.httpx.AsyncClient", lambda **kw: real_client(transport=httpx.MockTransport(server), **kw)):
                ok, _ = await bridge.invoke("Write", {"file_path": "new.txt", "__approval_id": "run-b:old"})
            self.assertEqual(ok, mode == "allow")
            self.assertEqual(any(p.endswith("/invoke") for p in calls), mode == "allow")
            self.assertTrue(calls[0].startswith("/api/agent-tools/approvals/run-a/run-a:"))
