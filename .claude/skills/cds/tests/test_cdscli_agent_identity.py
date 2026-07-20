import os
import sys
import unittest
from pathlib import Path
from unittest import mock

CLI_DIR = Path(__file__).resolve().parents[1] / "cli"
sys.path.insert(0, str(CLI_DIR))

import cdscli  # noqa: E402


class CdsCliAgentIdentityTests(unittest.TestCase):
    def test_auth_headers_add_progressive_agent_identity(self) -> None:
        env = {
            "CODEX_THREAD_ID": "thread-123",
            "CODEX_TURN_ID": "turn-456",
            "CDS_SKILL_NAME": "cds-release",
            "CDS_SKILL_VERSION": "1.2.3",
            "CDS_OPERATION_REASON": "verify release audit",
            "AI_ACCESS_KEY": "secret-value",
        }
        with mock.patch.object(cdscli, "_AGENT_SESSION_ID", "cdscli_test_session"), mock.patch.dict(
            os.environ, env, clear=True,
        ):
            headers = cdscli._auth_headers()

        self.assertEqual(headers["X-CDS-Agent-Session-Id"], "cdscli_test_session")
        self.assertEqual(headers["X-Codex-Thread-Id"], "thread-123")
        self.assertEqual(headers["X-Codex-Turn-Id"], "turn-456")
        self.assertEqual(headers["X-CDS-Skill-Name"], "cds-release")
        self.assertEqual(headers["X-CDS-Skill-Version"], "1.2.3")
        self.assertEqual(headers["X-CDS-Operation-Reason"], "verify release audit")
        self.assertEqual(headers["X-AI-Access-Key"], "secret-value")

    def test_identity_headers_remain_compatible_without_codex_environment(self) -> None:
        with mock.patch.object(cdscli, "_AGENT_SESSION_ID", "cdscli_generated_once"), mock.patch.dict(
            os.environ, {}, clear=True,
        ):
            first = cdscli._agent_identity_headers()
            second = cdscli._agent_identity_headers()

        self.assertEqual(first, {"X-CDS-Agent-Session-Id": "cdscli_generated_once"})
        self.assertEqual(second, first)

    def test_invalid_environment_values_are_not_sent(self) -> None:
        env = {
            "CODEX_THREAD_ID": "x" * 129,
            "CDS_OPERATION_REASON": "line one\nline two",
        }
        with mock.patch.object(cdscli, "_AGENT_SESSION_ID", "cdscli_safe"), mock.patch.dict(
            os.environ, env, clear=True,
        ):
            headers = cdscli._agent_identity_headers()

        self.assertNotIn("X-Codex-Thread-Id", headers)
        self.assertNotIn("X-CDS-Operation-Reason", headers)

    def test_self_action_surfaces_server_correlation_ids(self) -> None:
        class FakeResponse:
            headers = {
                "X-CDS-Request-Id": "req_server_123",
                "X-CDS-Operation-Id": "op_server_456",
            }

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, traceback):
                return False

            def __iter__(self):
                return iter((
                    b"event: done\n",
                    b'data: {"message":"scheduled"}\n',
                ))

        with mock.patch.object(cdscli, "_AGENT_SESSION_ID", "cdscli_session_789"), mock.patch.object(
            cdscli.urllib.request, "urlopen", return_value=FakeResponse(),
        ), mock.patch.object(cdscli, "ok") as ok_mock:
            cdscli._run_self_action(
                "/api/self-restart",
                {},
                no_wait=True,
                note="restart scheduled",
            )

        ok_mock.assert_called_once_with(
            {
                "events": [{"message": "scheduled", "_event": "done"}],
                "restarted": False,
                "agentSessionId": "cdscli_session_789",
                "requestId": "req_server_123",
                "operationId": "op_server_456",
            },
            note="restart scheduled",
        )


if __name__ == "__main__":
    unittest.main()
