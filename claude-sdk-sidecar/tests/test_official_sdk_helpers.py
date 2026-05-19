import os
import sys
import unittest
from pathlib import Path
from typing import Any


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.schemas import SidecarRunRequest, SidecarToolDef  # noqa: E402
from app.sdk_events import SdkEventAccumulator, handle_sdk_message, safe_result_metadata, usage_value  # noqa: E402
from app.sdk_tooling import build_sdk_tooling  # noqa: E402
from app.upstream import UpstreamResolution, provider_key_missing_event, resolve_upstream  # noqa: E402
from app.workspace import git_auth_env, normalize_git_ref, parse_github_repository, workspace_error_diagnostics, workspace_slug  # noqa: E402


class FakeUsage:
    input_tokens = "7"
    output_tokens = 11


class FakeResultMessage:
    result = "final answer"
    subtype = "success"
    usage = FakeUsage()
    session_id = "sdk-session-helpers"
    total_cost_usd = 0.42
    duration_ms = 321
    should_not_leak = {"nested": True}


class FakeTextBlock:
    type = "text"
    text = "hello "


class FakeToolUseBlock:
    type = "tool_use"
    name = "repo_read"
    id = "toolu_1"
    input = {"path": "README.md"}


class FakeAssistantMessage:
    content = [
        FakeTextBlock(),
        FakeToolUseBlock(),
        {"type": "tool_result", "tool_use_id": "toolu_1", "content": "ok"},
    ]


class FakeBridge:
    def __init__(self, *, permission_requested: bool = True, approved: bool = True):
        self.invocations: list[tuple[str, dict[str, Any]]] = []
        self.permission_requested = permission_requested
        self.approved = approved

    async def invoke(self, tool_name: str, payload: dict[str, Any]) -> tuple[bool, str]:
        self.invocations.append((tool_name, payload))
        return True, f"{tool_name}:ok"

    async def request_permission(
        self,
        tool_name: str,
        tool_input: dict[str, Any],
        approval_id: str,
        description: str,
    ) -> tuple[bool, str]:
        self.permission = (tool_name, tool_input, approval_id, description)
        return self.permission_requested, "requested"

    async def wait_for_approval(self, tool_name: str, approval_id: str) -> tuple[bool, str]:
        self.waited = (tool_name, approval_id)
        return self.approved, "approved" if self.approved else "denied"


class PermissionResultAllow:
    behavior = "allow"


class PermissionResultDeny:
    behavior = "deny"

    def __init__(self, message: str = "", interrupt: bool = False):
        self.message = message
        self.interrupt = interrupt


def sdk_tool(name: str, description: str, input_schema: dict[str, Any]):
    def decorator(handler: Any) -> dict[str, Any]:
        return {
            "name": name,
            "description": description,
            "input_schema": input_schema,
            "handler": handler,
        }

    return decorator


def create_sdk_mcp_server(name: str, version: str, tools: list[Any]) -> dict[str, Any]:
    return {"name": name, "version": version, "tools": tools}


def helper_request() -> SidecarRunRequest:
    return SidecarRunRequest(
        runId="helper-test",
        model="claude-opus-4-5",
        tools=[
            SidecarToolDef(name="repo_read", description="read repo", input_schema={"type": "object"}),
            SidecarToolDef(name="issue_lookup", description="lookup issue", input_schema={"type": "object"}),
        ],
    )


class SdkEventHelperTests(unittest.TestCase):
    def test_maps_sdk_blocks_and_result_metadata_without_rebuilding_loop_state(self) -> None:
        state = SdkEventAccumulator()

        events = handle_sdk_message(FakeAssistantMessage(), FakeResultMessage, state, cancelled=False)
        self.assertEqual([event.type for event in events], ["text_delta", "tool_use", "tool_result"])
        self.assertEqual(events[0].text, "hello ")
        self.assertEqual(events[1].tool_name, "repo_read")
        self.assertEqual(events[1].tool_input, {"path": "README.md"})
        self.assertEqual(events[2].content, "ok")

        result_events = handle_sdk_message(FakeResultMessage(), FakeResultMessage, state, cancelled=False)
        self.assertEqual(result_events, [])
        self.assertEqual(state.final_text, "final answer")
        self.assertEqual(state.input_tokens, 7)
        self.assertEqual(state.output_tokens, 11)
        self.assertEqual(state.result_metadata["session_id"], "sdk-session-helpers")
        self.assertNotIn("should_not_leak", state.result_metadata)

    def test_cancelled_result_does_not_promote_final_text_or_result_error(self) -> None:
        class CancelledResult:
            result = "partial"
            subtype = "error_during_execution"
            usage = {"input_tokens": "bad", "output_tokens": 5}

        state = SdkEventAccumulator(final_text="prior")
        handle_sdk_message(CancelledResult(), CancelledResult, state, cancelled=True)

        self.assertEqual(state.final_text, "prior")
        self.assertEqual(state.input_tokens, 0)
        self.assertEqual(state.output_tokens, 5)
        self.assertIsNone(state.result_error)

    def test_usage_and_metadata_are_scalar_only(self) -> None:
        self.assertEqual(usage_value({"input_tokens": "12"}, "input_tokens"), 12)
        self.assertEqual(usage_value({"input_tokens": object()}, "input_tokens", 3), 3)
        self.assertEqual(safe_result_metadata(FakeResultMessage())["total_cost_usd"], 0.42)


class UpstreamHelperTests(unittest.TestCase):
    def setUp(self) -> None:
        os.environ.pop("ANTHROPIC_API_KEY", None)
        os.environ.pop("ANTHROPIC_BASE_URL", None)
        os.environ.pop("SIDECAR_PROVIDER_KEY_MODE", None)
        os.environ.pop("CLAUDE_CODE_MAX_RETRIES", None)

    def test_request_override_beats_env_and_builds_sdk_env(self) -> None:
        os.environ["ANTHROPIC_API_KEY"] = "sk-env"
        os.environ["ANTHROPIC_BASE_URL"] = "https://env.example"
        os.environ["CLAUDE_CODE_MAX_RETRIES"] = "4"
        req = SidecarRunRequest(runId="u1", baseUrl="https://request.example", apiKey="sk-request")

        resolution = resolve_upstream(req)
        self.assertEqual(resolution.source, "request-override")
        self.assertEqual(resolution.base_url, "https://request.example")
        self.assertEqual(resolution.api_key, "sk-request")
        self.assertEqual(resolution.to_sdk_env(9), {
            "API_TIMEOUT_MS": "9000",
            "CLAUDE_CODE_MAX_RETRIES": "4",
            "ANTHROPIC_API_KEY": "sk-request",
            "ANTHROPIC_BASE_URL": "https://request.example",
        })

    def test_missing_provider_key_event_is_actionable_and_source_specific(self) -> None:
        os.environ["SIDECAR_PROVIDER_KEY_MODE"] = "runtime-profile-only"
        event = provider_key_missing_event(UpstreamResolution("https://anthropic.example", None, "profile:prod"))

        self.assertEqual(event.error_code, "provider_key_missing")
        self.assertEqual(event.content["adapter"], "claude-agent-sdk")
        self.assertEqual(event.content["upstreamSource"], "profile:prod")
        self.assertEqual(event.content["baseUrlConfigured"], True)
        self.assertEqual(event.content["providerKeyMode"], "runtime-profile-only")
        self.assertIn("select or create a MAP runtime profile", event.content["nextActions"][1])

    def test_sdk_env_requires_key_before_official_client_creation(self) -> None:
        with self.assertRaises(ValueError):
            UpstreamResolution(None, None, "env-default").to_sdk_env(30)


class SdkToolingHelperTests(unittest.IsolatedAsyncioTestCase):
    async def test_mcp_tool_handlers_preserve_tool_names_and_payloads(self) -> None:
        bridge = FakeBridge()
        tooling = build_sdk_tooling(
            helper_request(),
            bridge,  # type: ignore[arg-type]
            create_sdk_mcp_server=create_sdk_mcp_server,
            sdk_tool=sdk_tool,
            permission_result_allow=PermissionResultAllow,
            permission_result_deny=PermissionResultDeny,
        )

        self.assertEqual(tooling.map_tool_names, ["mcp__map__repo_read", "mcp__map__issue_lookup"])
        self.assertEqual(tooling.mcp_servers["map"]["name"], "map-agent-tools")
        first, second = tooling.mcp_servers["map"]["tools"]
        self.assertEqual(await first["handler"]({"path": "README.md"}), {
            "content": [{"type": "text", "text": "repo_read:ok"}],
            "is_error": False,
        })
        self.assertEqual(await second["handler"]({"issue": 7}), {
            "content": [{"type": "text", "text": "issue_lookup:ok"}],
            "is_error": False,
        })
        self.assertEqual(bridge.invocations, [
            ("repo_read", {"path": "README.md"}),
            ("issue_lookup", {"issue": 7}),
        ])

    async def test_permission_callback_allows_read_tools_and_bridges_write_tools(self) -> None:
        bridge = FakeBridge(approved=True)
        tooling = build_sdk_tooling(
            SidecarRunRequest(runId="permissions"),
            bridge,  # type: ignore[arg-type]
            create_sdk_mcp_server=create_sdk_mcp_server,
            sdk_tool=sdk_tool,
            permission_result_allow=PermissionResultAllow,
            permission_result_deny=PermissionResultDeny,
        )

        self.assertIsInstance(await tooling.can_use_tool("Read", {}, None), PermissionResultAllow)
        self.assertIsInstance(await tooling.can_use_tool("Bash", {"cmd": "pwd"}, None), PermissionResultAllow)
        self.assertEqual(bridge.permission[0], "Bash")
        self.assertEqual(bridge.waited, ("Bash", "bash-permissions-1"))

        self.assertIsInstance(await tooling.can_use_tool("Bash", {"cmd": "ls"}, None), PermissionResultAllow)
        self.assertEqual(bridge.waited, ("Bash", "bash-permissions-2"))

    async def test_permission_callback_denies_failed_or_rejected_map_approval(self) -> None:
        failed_bridge = FakeBridge(permission_requested=False)
        tooling = build_sdk_tooling(
            SidecarRunRequest(runId="failed-permission"),
            failed_bridge,  # type: ignore[arg-type]
            create_sdk_mcp_server=create_sdk_mcp_server,
            sdk_tool=sdk_tool,
            permission_result_allow=PermissionResultAllow,
            permission_result_deny=PermissionResultDeny,
        )
        failed = await tooling.can_use_tool("Write", {"path": "x"}, None)
        self.assertIsInstance(failed, PermissionResultDeny)
        self.assertIn("MAP approval request failed", failed.message)

        rejected_bridge = FakeBridge(approved=False)
        tooling = build_sdk_tooling(
            SidecarRunRequest(runId="rejected-permission"),
            rejected_bridge,  # type: ignore[arg-type]
            create_sdk_mcp_server=create_sdk_mcp_server,
            sdk_tool=sdk_tool,
            permission_result_allow=PermissionResultAllow,
            permission_result_deny=PermissionResultDeny,
        )
        rejected = await tooling.can_use_tool("Edit", {"path": "x"}, None)
        self.assertIsInstance(rejected, PermissionResultDeny)
        self.assertIn("MAP approval denied", rejected.message)


class WorkspaceHelperTests(unittest.TestCase):
    def setUp(self) -> None:
        os.environ.pop("SIDECAR_GITHUB_TOKEN", None)
        os.environ.pop("GITHUB_TOKEN", None)
        os.environ.pop("GIT_CONFIG_COUNT", None)

    def test_github_repository_and_ref_are_strictly_normalized(self) -> None:
        self.assertEqual(parse_github_repository("inernoro/prd_agent"), (
            "inernoro/prd_agent",
            "https://github.com/inernoro/prd_agent.git",
        ))
        self.assertEqual(parse_github_repository("inernoro/prd_agent.git"), (
            "inernoro/prd_agent",
            "https://github.com/inernoro/prd_agent.git",
        ))
        self.assertEqual(parse_github_repository("https://github.com/inernoro/prd_agent.git"), (
            "inernoro/prd_agent",
            "https://github.com/inernoro/prd_agent.git",
        ))
        self.assertEqual(normalize_git_ref("main"), "main")
        self.assertEqual(normalize_git_ref("feature/cds-agent"), "feature/cds-agent")
        for bad_repo in ("git@github.com:inernoro/prd_agent.git", "https://example.com/inernoro/prd_agent"):
            with self.subTest(bad_repo=bad_repo):
                with self.assertRaises(ValueError):
                    parse_github_repository(bad_repo)
        for bad_ref in ("../main", "refs/heads/.hidden", "branch.lock"):
            with self.subTest(bad_ref=bad_ref):
                with self.assertRaises(ValueError):
                    normalize_git_ref(bad_ref)

    def test_workspace_slug_is_stable_and_sanitized(self) -> None:
        slug = workspace_slug("inernoro/prd_agent", "feature/cds-agent")
        self.assertRegex(slug, r"^inernoro-prd_agent-feature-cds-agent-[a-f0-9]{10}$")
        self.assertEqual(slug, workspace_slug("inernoro/prd_agent", "feature/cds-agent"))

    def test_github_token_uses_git_extraheader_without_changing_clone_url(self) -> None:
        os.environ["GIT_CONFIG_COUNT"] = "2"
        os.environ["SIDECAR_GITHUB_TOKEN"] = "ghp-secret"

        env = git_auth_env()

        self.assertIsNotNone(env)
        assert env is not None
        self.assertEqual(env["GIT_CONFIG_COUNT"], "3")
        self.assertEqual(env["GIT_CONFIG_KEY_2"], "http.https://github.com/.extraheader")
        self.assertEqual(env["GIT_CONFIG_VALUE_2"], "AUTHORIZATION: bearer ghp-secret")

    def test_missing_git_binary_has_actionable_workspace_error(self) -> None:
        req = SidecarRunRequest(runId="workspace", gitRepository="inernoro/prd_agent", gitRef="main")

        diagnostics = workspace_error_diagnostics(FileNotFoundError(2, "No such file or directory"), req)

        self.assertEqual(diagnostics["workspaceErrorCode"], "git_not_installed")
        self.assertIn("install git", diagnostics["nextActions"][0])


if __name__ == "__main__":
    unittest.main()
