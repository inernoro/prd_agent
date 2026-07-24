#!/usr/bin/env python3
"""守卫正式发布烟测的 chat AppCaller 单一事实源。"""

import ast
import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import patch


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "gw-smoke.py"


def load_smoke_module():
    spec = importlib.util.spec_from_file_location("gw_smoke_app_caller_test", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class GatewaySmokeAppCallerTests(unittest.TestCase):
    def test_quickstart_dry_run_header_is_sent_for_post_requests(self):
        with patch.dict(
            os.environ,
            {
                "GW_SMOKE_QUICKSTART_DRY_RUN": "1",
                "GW_BASE": "https://gateway.example.test/gw/v1",
            },
            clear=False,
        ):
            module = load_smoke_module()

        captured = {}

        class FakeResponse:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            @staticmethod
            def read():
                return b"{}"

        def fake_urlopen(request, timeout):
            captured["headers"] = dict(request.header_items())
            captured["timeout"] = timeout
            return FakeResponse()

        with patch.object(module.urllib.request, "urlopen", side_effect=fake_urlopen):
            status, _ = module._req("POST", "/invoke", {"AppCallerCode": "release-probe.stable::chat"})

        self.assertEqual(status, 200)
        self.assertEqual(captured["headers"].get("X-gateway-dry-run"), "quickstart")

    def test_configured_app_caller_replaces_default_chat_sample(self):
        configured = "release-probe.stable::chat"
        with patch.dict(
            os.environ,
            {
                "GW_SMOKE_APP_CALLER": configured,
                "GW_SMOKE_MODEL_TYPES": "chat",
            },
            clear=False,
        ):
            module = load_smoke_module()

        self.assertEqual(module._selected_sample_codes(), [(configured, "chat")])

    def test_request_bodies_do_not_hardcode_default_chat_app_caller(self):
        tree = ast.parse(SCRIPT_PATH.read_text(encoding="utf-8"))
        hardcoded_request_values = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.Dict):
                continue
            for key, value in zip(node.keys, node.values):
                if (
                    isinstance(key, ast.Constant)
                    and key.value == "AppCallerCode"
                    and isinstance(value, ast.Constant)
                    and value.value == "report-agent.generate::chat"
                ):
                    hardcoded_request_values.append(value.lineno)

        self.assertEqual(
            hardcoded_request_values,
            [],
            f"请求体仍硬编码默认 chat AppCaller，行号: {hardcoded_request_values}",
        )


if __name__ == "__main__":
    unittest.main()
