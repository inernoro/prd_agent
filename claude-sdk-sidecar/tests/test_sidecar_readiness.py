import os
import sys
import unittest
import json
from pathlib import Path
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app.main as sidecar_main  # noqa: E402
from app.main import _adapter_diagnostics, _adapter_for, _legacy_runtime_init_event, readyz  # noqa: E402
from app.schemas import SidecarRunRequest  # noqa: E402


class SidecarReadinessTests(unittest.TestCase):
    def test_legacy_adapter_is_ready_without_official_sdk(self) -> None:
        diagnostics = _adapter_diagnostics("legacy-sidecar")

        self.assertEqual(diagnostics["adapter"], "legacy-sidecar")
        self.assertEqual(diagnostics["ready"], True)
        self.assertEqual(diagnostics["loopOwner"], "sidecar-legacy-loop")
        self.assertEqual(diagnostics["sdkLoopEnabled"], False)

    def test_default_adapter_is_official_and_legacy_requires_explicit_request(self) -> None:
        previous_adapter = sidecar_main.DEFAULT_AGENT_ADAPTER
        try:
            sidecar_main.DEFAULT_AGENT_ADAPTER = "claude-agent-sdk"
            self.assertEqual(_adapter_for(SidecarRunRequest(runId="default-run")), "claude-agent-sdk")
            self.assertEqual(
                _adapter_for(SidecarRunRequest(runId="legacy-run", runtimeAdapter="legacy-sidecar")),
                "legacy-sidecar",
            )
        finally:
            sidecar_main.DEFAULT_AGENT_ADAPTER = previous_adapter

    def test_unknown_adapter_does_not_fall_back_to_legacy(self) -> None:
        previous_adapter = sidecar_main.DEFAULT_AGENT_ADAPTER
        try:
            sidecar_main.DEFAULT_AGENT_ADAPTER = "claude-agent-sdk"
            with self.assertRaisesRegex(ValueError, "unsupported runtimeAdapter: codex"):
                _adapter_for(SidecarRunRequest(runId="codex-run", runtimeAdapter="codex"))
        finally:
            sidecar_main.DEFAULT_AGENT_ADAPTER = previous_adapter

    def test_empty_default_adapter_still_uses_official_sdk(self) -> None:
        previous_adapter = sidecar_main.DEFAULT_AGENT_ADAPTER
        try:
            sidecar_main.DEFAULT_AGENT_ADAPTER = ""
            self.assertEqual(_adapter_for(SidecarRunRequest(runId="empty-default-run")), "claude-agent-sdk")
        finally:
            sidecar_main.DEFAULT_AGENT_ADAPTER = previous_adapter

    def test_unknown_adapter_diagnostics_are_not_legacy_ready(self) -> None:
        diagnostics = _adapter_diagnostics("codex")

        self.assertEqual(diagnostics["adapter"], "codex")
        self.assertEqual(diagnostics["ready"], False)
        self.assertEqual(diagnostics["missing"], ["unsupported_runtime_adapter"])
        self.assertEqual(diagnostics["loopOwner"], "unsupported")
        self.assertEqual(diagnostics["sdkLoopEnabled"], False)

    def test_legacy_runtime_init_makes_fallback_auditable(self) -> None:
        event = _legacy_runtime_init_event(SidecarRunRequest(
            runId="legacy-run",
            runtimeAdapter="legacy-sidecar",
            mapSessionId="session-1",
            traceId="trace-1",
        ))

        self.assertEqual(event.type, "runtime_init")
        self.assertEqual(event.content["adapter"], "legacy-sidecar")
        self.assertEqual(event.content["runtimeAdapter"], "legacy-sidecar")
        self.assertEqual(event.content["loopOwner"], "sidecar-legacy-loop")
        self.assertEqual(event.content["sdkLoopEnabled"], False)
        self.assertEqual(event.content["mapRole"], "control-plane")
        self.assertEqual(event.content["cdsRole"], "sandbox-runtime")
        self.assertEqual(event.content["fallback"], "explicit")
        self.assertEqual(event.content["mapSessionId"], "session-1")
        self.assertEqual(event.content["traceId"], "trace-1")

    def test_official_adapter_reports_missing_sdk(self) -> None:
        with patch("importlib.util.find_spec", return_value=None), patch("shutil.which", return_value=None):
            diagnostics = _adapter_diagnostics("claude-agent-sdk")

        self.assertEqual(diagnostics["adapter"], "claude-agent-sdk")
        self.assertEqual(diagnostics["ready"], False)
        self.assertIn("claude_agent_sdk", diagnostics["missing"])
        self.assertNotIn("claude_cli", diagnostics["missing"])
        self.assertEqual(diagnostics["allowedTools"], ["Read", "Grep", "Glob"])
        self.assertEqual(diagnostics["approvalBridge"], "sdk-can-use-tool")
        self.assertEqual(diagnostics["loopOwner"], "claude-agent-sdk")
        self.assertEqual(diagnostics["sdkLoopEnabled"], True)
        self.assertEqual(diagnostics["mapRole"], "control-plane")
        self.assertEqual(diagnostics["cdsRole"], "sandbox-runtime")

    def test_official_adapter_is_ready_with_bundled_cli_when_sdk_exists(self) -> None:
        with patch("importlib.util.find_spec", return_value=object()), \
                patch("importlib.metadata.version", return_value="0.2.82"), \
                patch("shutil.which", return_value=None):
            diagnostics = _adapter_diagnostics("claude-agent-sdk")

        self.assertEqual(diagnostics["ready"], True)
        self.assertEqual(diagnostics["claudeCliPath"], None)
        self.assertEqual(diagnostics["claudeCliBundled"], True)

    def test_official_adapter_reports_write_tool_opt_in(self) -> None:
        with patch.dict(os.environ, {
            "CLAUDE_AGENT_SDK_ALLOWED_TOOLS": "Read,Grep,Glob,Bash,Write",
            "CLAUDE_AGENT_SDK_PERMISSION_MODE": "acceptEdits",
        }, clear=False):
            with patch("importlib.util.find_spec", return_value=object()), \
                    patch("importlib.metadata.version", return_value="0.2.82"), \
                    patch("shutil.which", return_value="/usr/local/bin/claude"):
                diagnostics = _adapter_diagnostics("official")

        self.assertEqual(diagnostics["ready"], True)
        self.assertEqual(diagnostics["sdkVersion"], "0.2.82")
        self.assertEqual(diagnostics["permissionMode"], "acceptEdits")
        self.assertEqual(diagnostics["builtinWriteToolsEnabled"], True)
        self.assertEqual(diagnostics["builtinWriteTools"], ["Bash", "Write"])

    def test_readyz_defaults_to_official_adapter_and_runtime_profile_or_env_provider_key(self) -> None:
        previous_token = sidecar_main.SIDECAR_TOKEN
        previous_adapter = sidecar_main.DEFAULT_AGENT_ADAPTER
        sidecar_main.SIDECAR_TOKEN = "test-token"
        sidecar_main.DEFAULT_AGENT_ADAPTER = "claude-agent-sdk"
        try:
            with patch.dict(os.environ, {
                "SIDECAR_AGENT_ADAPTER": "claude-agent-sdk",
            }, clear=True), \
                    patch("importlib.util.find_spec", return_value=object()), \
                    patch("importlib.metadata.version", return_value="0.2.82"), \
                    patch("shutil.which", return_value=None):
                response = self._run_readyz()
        finally:
            sidecar_main.SIDECAR_TOKEN = previous_token
            sidecar_main.DEFAULT_AGENT_ADAPTER = previous_adapter

        payload = json.loads(response.body)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["ready"], True)
        self.assertEqual(payload["agentAdapter"], "claude-agent-sdk")
        self.assertEqual(payload["adapterDiagnostics"]["loopOwner"], "claude-agent-sdk")
        self.assertEqual(payload["adapterDiagnostics"]["sdkLoopEnabled"], True)
        self.assertEqual(payload["anthropicKey"], False)
        self.assertEqual(payload["providerKeyMode"], "runtime-profile-or-env")
        self.assertEqual(payload["providerKeyRequiredForReady"], False)
        self.assertEqual(payload["blockers"], [])
        self.assertEqual(payload["nextActions"], ["ready: start or attach a MAP/CDS Agent run"])

    def test_readyz_can_require_env_provider_key_for_standalone_sidecar(self) -> None:
        previous_token = sidecar_main.SIDECAR_TOKEN
        sidecar_main.SIDECAR_TOKEN = "test-token"
        try:
            with patch.dict(os.environ, {
                "SIDECAR_AGENT_ADAPTER": "legacy-sidecar",
                "SIDECAR_PROVIDER_KEY_MODE": "env",
            }, clear=True):
                response = self._run_readyz()
        finally:
            sidecar_main.SIDECAR_TOKEN = previous_token

        payload = json.loads(response.body)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(payload["ready"], False)
        self.assertEqual(payload["providerKeyMode"], "env")
        self.assertEqual(payload["providerKeyRequiredForReady"], True)
        self.assertIn("missing ANTHROPIC_API_KEY", payload["blockers"])
        self.assertIn(
            "set ANTHROPIC_API_KEY or use SIDECAR_PROVIDER_KEY_MODE=runtime-profile-or-env when MAP provides provider keys per request",
            payload["nextActions"],
        )

    def test_readyz_reports_official_adapter_actionable_blockers(self) -> None:
        previous_token = sidecar_main.SIDECAR_TOKEN
        previous_adapter = sidecar_main.DEFAULT_AGENT_ADAPTER
        sidecar_main.SIDECAR_TOKEN = "test-token"
        sidecar_main.DEFAULT_AGENT_ADAPTER = "claude-agent-sdk"
        try:
            with patch.dict(os.environ, {
                "SIDECAR_AGENT_ADAPTER": "claude-agent-sdk",
            }, clear=True), \
                    patch("importlib.util.find_spec", return_value=None), \
                    patch("shutil.which", return_value=None):
                response = self._run_readyz()
        finally:
            sidecar_main.SIDECAR_TOKEN = previous_token
            sidecar_main.DEFAULT_AGENT_ADAPTER = previous_adapter

        payload = json.loads(response.body)
        self.assertEqual(response.status_code, 503)
        self.assertIn("missing claude_agent_sdk", payload["blockers"])
        self.assertNotIn("missing claude_cli", payload["blockers"])
        self.assertIn("install the official SDK: pip install claude-agent-sdk", payload["nextActions"])
        self.assertIn(
            "provider key may be supplied by MAP runtime profile or per-request override",
            payload["nextActions"],
        )

    def test_readyz_rejects_unsupported_adapter_instead_of_legacy_fallback(self) -> None:
        previous_token = sidecar_main.SIDECAR_TOKEN
        previous_adapter = sidecar_main.DEFAULT_AGENT_ADAPTER
        sidecar_main.SIDECAR_TOKEN = "test-token"
        sidecar_main.DEFAULT_AGENT_ADAPTER = "codex"
        try:
            with patch.dict(os.environ, {
                "SIDECAR_AGENT_ADAPTER": "codex",
            }, clear=True):
                response = self._run_readyz()
        finally:
            sidecar_main.SIDECAR_TOKEN = previous_token
            sidecar_main.DEFAULT_AGENT_ADAPTER = previous_adapter

        payload = json.loads(response.body)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(payload["ready"], False)
        self.assertEqual(payload["agentAdapter"], "codex")
        self.assertIn("missing unsupported_runtime_adapter", payload["blockers"])
        self.assertIn(
            "set runtimeAdapter=claude-agent-sdk, or explicitly set runtimeAdapter=legacy-sidecar only for legacy fallback",
            payload["nextActions"],
        )
        self.assertEqual(payload["adapterDiagnostics"]["loopOwner"], "unsupported")

    @staticmethod
    def _run_readyz():
        import asyncio

        return asyncio.run(readyz())


if __name__ == "__main__":
    unittest.main()
