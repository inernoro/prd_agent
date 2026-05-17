import os
import sys
import unittest
import json
from pathlib import Path
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app.main as sidecar_main  # noqa: E402
from app.main import _adapter_diagnostics, readyz  # noqa: E402


class SidecarReadinessTests(unittest.TestCase):
    def test_legacy_adapter_is_ready_without_official_sdk(self) -> None:
        diagnostics = _adapter_diagnostics("legacy-sidecar")

        self.assertEqual(diagnostics["adapter"], "legacy-sidecar")
        self.assertEqual(diagnostics["ready"], True)
        self.assertEqual(diagnostics["loopOwner"], "sidecar-legacy-loop")
        self.assertEqual(diagnostics["sdkLoopEnabled"], False)

    def test_official_adapter_reports_missing_sdk_and_cli(self) -> None:
        with patch("importlib.util.find_spec", return_value=None), patch("shutil.which", return_value=None):
            diagnostics = _adapter_diagnostics("claude-agent-sdk")

        self.assertEqual(diagnostics["adapter"], "claude-agent-sdk")
        self.assertEqual(diagnostics["ready"], False)
        self.assertIn("claude_agent_sdk", diagnostics["missing"])
        self.assertIn("claude_cli", diagnostics["missing"])
        self.assertEqual(diagnostics["allowedTools"], ["Read", "Grep", "Glob"])
        self.assertEqual(diagnostics["approvalBridge"], "sdk-can-use-tool")
        self.assertEqual(diagnostics["loopOwner"], "claude-agent-sdk")
        self.assertEqual(diagnostics["sdkLoopEnabled"], True)
        self.assertEqual(diagnostics["mapRole"], "control-plane")
        self.assertEqual(diagnostics["cdsRole"], "sandbox-runtime")

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

    def test_readyz_defaults_to_runtime_profile_or_env_provider_key(self) -> None:
        previous_token = sidecar_main.SIDECAR_TOKEN
        sidecar_main.SIDECAR_TOKEN = "test-token"
        try:
            with patch.dict(os.environ, {
                "SIDECAR_AGENT_ADAPTER": "legacy-sidecar",
            }, clear=True):
                response = self._run_readyz()
        finally:
            sidecar_main.SIDECAR_TOKEN = previous_token

        payload = json.loads(response.body)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["ready"], True)
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
        self.assertIn("missing claude_cli", payload["blockers"])
        self.assertIn("install the official SDK: pip install claude-agent-sdk", payload["nextActions"])
        self.assertIn("install and authenticate Claude Code CLI so `claude` is on PATH", payload["nextActions"])
        self.assertIn(
            "provider key may be supplied by MAP runtime profile or per-request override",
            payload["nextActions"],
        )

    @staticmethod
    def _run_readyz():
        import asyncio

        return asyncio.run(readyz())


if __name__ == "__main__":
    unittest.main()
