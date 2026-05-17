import asyncio
import os
import sys
import types
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.official_agent_sdk import run_official_agent  # noqa: E402
from app.schemas import SidecarMessage, SidecarRunRequest  # noqa: E402

LAST_OPTIONS: Any = None


class FakeResultMessage:
    def __init__(self, result: str = "", subtype: str = "success", usage: Any = None):
        self.result = result
        self.subtype = subtype
        self.usage = usage


class FakeUsage:
    input_tokens = 3
    output_tokens = 5


class FakeTextBlock:
    type = "text"
    text = "adapter ok"


class FakeAssistantMessage:
    content = [FakeTextBlock()]


class FakeClaudeSDKClient:
    def __init__(self, options: Any = None):
        self.options = options
        self.interrupted = False

    async def __aenter__(self) -> "FakeClaudeSDKClient":
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        return None

    async def query(self, prompt: str) -> None:
        self.prompt = prompt

    async def interrupt(self) -> None:
        self.interrupted = True

    async def receive_response(self):
        for _ in range(3):
            await asyncio.sleep(0)
            if self.interrupted:
                yield FakeResultMessage(subtype="error_during_execution", usage=FakeUsage())
                return
        yield FakeAssistantMessage()
        yield FakeResultMessage(result="adapter ok", usage=FakeUsage())


def install_fake_sdk() -> None:
    module = types.ModuleType("claude_agent_sdk")

    class ClaudeAgentOptions:
        def __init__(self, **kwargs: Any):
            global LAST_OPTIONS
            self.kwargs = kwargs
            LAST_OPTIONS = self

    def tool(name: str, description: str, input_schema: dict[str, Any]):
        def decorator(handler: Any) -> Any:
            return {
                "name": name,
                "description": description,
                "input_schema": input_schema,
                "handler": handler,
            }

        return decorator

    def create_sdk_mcp_server(name: str, version: str, tools: list[Any]) -> dict[str, Any]:
        return {"name": name, "version": version, "tools": tools}

    class PermissionResultAllow:
        behavior = "allow"

        def __init__(self, **kwargs: Any):
            self.kwargs = kwargs

    class PermissionResultDeny:
        behavior = "deny"

        def __init__(self, message: str = "", interrupt: bool = False, **kwargs: Any):
            self.message = message
            self.interrupt = interrupt
            self.kwargs = kwargs

    module.ClaudeSDKClient = FakeClaudeSDKClient
    module.ClaudeAgentOptions = ClaudeAgentOptions
    module.PermissionResultAllow = PermissionResultAllow
    module.PermissionResultDeny = PermissionResultDeny
    module.ResultMessage = FakeResultMessage
    module.create_sdk_mcp_server = create_sdk_mcp_server
    module.tool = tool
    sys.modules["claude_agent_sdk"] = module


def build_request() -> SidecarRunRequest:
    return SidecarRunRequest(
        runId="official-test",
        model="claude-opus-4-5",
        messages=[SidecarMessage(role="user", content="check repo")],
        maxTurns=1,
    )


class OfficialAgentSdkAdapterTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        global LAST_OPTIONS
        LAST_OPTIONS = None
        install_fake_sdk()
        os.environ.pop("CLAUDE_AGENT_SDK_ALLOWED_TOOLS", None)
        os.environ.pop("CLAUDE_AGENT_SDK_PERMISSION_MODE", None)
        os.environ.pop("AGENT_WORKSPACE_ROOT", None)
        self.which_patcher = patch("app.official_agent_sdk.shutil.which", return_value="/usr/local/bin/claude")
        self.which_patcher.start()
        self.addCleanup(self.which_patcher.stop)

    async def test_streams_runtime_text_usage_and_done(self) -> None:
        events = [event async for event in run_official_agent(build_request())]

        self.assertEqual([event.type for event in events], [
            "runtime_init",
            "text_delta",
            "usage",
            "done",
        ])
        self.assertEqual(events[1].text, "adapter ok")
        self.assertEqual(events[-1].final_text, "adapter ok")
        self.assertEqual(events[-1].input_tokens, 3)
        self.assertEqual(events[-1].output_tokens, 5)
        self.assertEqual(events[0].content["allowedTools"], ["Read", "Grep", "Glob"])
        self.assertEqual(events[0].content["permissionMode"], "default")
        self.assertEqual(events[0].content["builtinWriteToolsEnabled"], False)
        self.assertEqual(events[0].content["approvalBridge"], "sdk-can-use-tool")

    async def test_permission_callback_allows_readonly_and_denies_unbridged_write(self) -> None:
        stream = run_official_agent(build_request())
        first = await anext(stream)
        self.assertEqual(first.type, "runtime_init")
        await stream.aclose()

        can_use_tool = LAST_OPTIONS.kwargs["can_use_tool"]
        readonly = await can_use_tool("Read", {"file_path": "README.md"}, object())
        write = await can_use_tool("Bash", {"command": "git status"}, object())

        self.assertEqual(readonly.behavior, "allow")
        self.assertEqual(write.behavior, "deny")
        self.assertIn("MAP approval request failed", write.message)

    async def test_runtime_init_reports_opt_in_builtin_write_tools(self) -> None:
        os.environ["CLAUDE_AGENT_SDK_ALLOWED_TOOLS"] = "Read,Bash,Edit,Write"
        os.environ["CLAUDE_AGENT_SDK_PERMISSION_MODE"] = "acceptEdits"

        stream = run_official_agent(build_request())
        first = await anext(stream)
        await stream.aclose()

        self.assertEqual(first.type, "runtime_init")
        self.assertEqual(first.content["permissionMode"], "acceptEdits")
        self.assertEqual(first.content["builtinWriteToolsEnabled"], True)
        self.assertEqual(first.content["builtinWriteTools"], ["Bash", "Edit", "Write"])

    async def test_cancel_event_interrupts_client_and_returns_cancelled_error(self) -> None:
        cancel_event = asyncio.Event()
        stream = run_official_agent(build_request(), cancel_event=cancel_event)

        first = await anext(stream)
        self.assertEqual(first.type, "runtime_init")
        cancel_event.set()

        remaining = [event async for event in stream]
        self.assertEqual([event.type for event in remaining], ["usage", "error"])
        self.assertEqual(remaining[-1].error_code, "cancelled")

    async def test_preflight_reports_missing_claude_cli_before_sdk_run(self) -> None:
        with patch("app.official_agent_sdk.shutil.which", return_value=None):
            events = [event async for event in run_official_agent(build_request())]

        self.assertEqual([event.type for event in events], ["error"])
        self.assertEqual(events[0].error_code, "claude_agent_sdk_runtime_not_ready")
        self.assertEqual(events[0].content["missing"], ["claude_cli"])

    async def test_preflight_reports_missing_workspace_root(self) -> None:
        os.environ["AGENT_WORKSPACE_ROOT"] = "/tmp/cds-agent-missing-workspace"

        events = [event async for event in run_official_agent(build_request())]

        self.assertEqual([event.type for event in events], ["error"])
        self.assertEqual(events[0].error_code, "claude_agent_sdk_runtime_not_ready")
        self.assertIn("workspace_root", events[0].content["missing"])


if __name__ == "__main__":
    unittest.main()
