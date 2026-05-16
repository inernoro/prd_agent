import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.main import _adapter_diagnostics  # noqa: E402


class SidecarReadinessTests(unittest.TestCase):
    def test_legacy_adapter_is_ready_without_official_sdk(self) -> None:
        diagnostics = _adapter_diagnostics("legacy-sidecar")

        self.assertEqual(diagnostics["adapter"], "legacy-sidecar")
        self.assertEqual(diagnostics["ready"], True)

    def test_official_adapter_reports_missing_sdk_and_cli(self) -> None:
        with patch("importlib.util.find_spec", return_value=None), patch("shutil.which", return_value=None):
            diagnostics = _adapter_diagnostics("claude-agent-sdk")

        self.assertEqual(diagnostics["adapter"], "claude-agent-sdk")
        self.assertEqual(diagnostics["ready"], False)
        self.assertIn("claude_agent_sdk", diagnostics["missing"])
        self.assertIn("claude_cli", diagnostics["missing"])
        self.assertEqual(diagnostics["allowedTools"], ["Read", "Grep", "Glob"])
        self.assertEqual(diagnostics["approvalBridge"], "sdk-can-use-tool")

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


if __name__ == "__main__":
    unittest.main()
