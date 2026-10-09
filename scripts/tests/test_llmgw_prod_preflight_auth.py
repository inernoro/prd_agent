#!/usr/bin/env python3
"""守卫生产网关预检使用长期 RSA 身份换取短期 MAP 会话。"""

import importlib.util
import json
import os
from pathlib import Path
import unittest
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[2]
PREFLIGHT = ROOT / "scripts" / "llmgw-prod-preflight.py"


def _load_preflight_module():
    spec = importlib.util.spec_from_file_location("llmgw_prod_preflight_auth", PREFLIGHT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


preflight = _load_preflight_module()


class ProductionPreflightAuthTests(unittest.TestCase):
    def test_rsa_identity_mints_short_lived_session_without_leaking_secrets(self) -> None:
        secret = "private-key-must-not-leak"
        access_token = "short-lived-token-must-not-leak"
        http_responses = [
            {
                "ok": True,
                "status": 200,
                "payload": {"data": {"loginUrl": "https://map.example/#code=one-time-code"}},
            },
            {
                "ok": True,
                "status": 200,
                "payload": {"data": {"accessToken": access_token}},
            },
        ]
        signed = Mock(stdout=json.dumps({"X-Stable-Smoke-Signature": "signature"}))

        with patch.dict(
            os.environ,
            {
                "STABLE_SMOKE_SIGNING_KEY_ID": "prod-rsa-test",
                "STABLE_SMOKE_SIGNING_PRIVATE_KEY": secret,
                "STABLE_SMOKE_USER": "stsmk_prod",
            },
            clear=False,
        ), patch.object(preflight.subprocess, "run", return_value=signed) as run, patch.object(
            preflight, "_http_json", side_effect=http_responses
        ) as http_json:
            key_name, token, check = preflight._stable_smoke_session("https://map.example", 30)

        self.assertEqual(key_name, "STABLE_SMOKE_RSA")
        self.assertEqual(token, access_token)
        self.assertTrue(check["ok"])
        self.assertNotIn(secret, json.dumps(check, ensure_ascii=False))
        self.assertNotIn(access_token, json.dumps(check, ensure_ascii=False))
        run.assert_called_once()
        self.assertEqual(http_json.call_count, 2)
        self.assertEqual(
            http_json.call_args_list[1].args[0],
            "https://map.example/api/v1/auth/synthetic/exchange",
        )

    def test_partial_rsa_configuration_fails_closed(self) -> None:
        with patch.dict(
            os.environ,
            {
                "STABLE_SMOKE_SIGNING_KEY_ID": "prod-rsa-test",
                "STABLE_SMOKE_SIGNING_PRIVATE_KEY": "",
                "STABLE_SMOKE_USER": "stsmk_prod",
            },
            clear=False,
        ), patch.object(preflight.subprocess, "run") as run:
            key_name, token, check = preflight._stable_smoke_session("https://map.example", 30)

        self.assertEqual(key_name, "STABLE_SMOKE_RSA")
        self.assertEqual(token, "")
        self.assertFalse(check["ok"])
        run.assert_not_called()

    def test_no_rsa_configuration_preserves_legacy_key_fallback(self) -> None:
        with patch.dict(
            os.environ,
            {
                "STABLE_SMOKE_SIGNING_KEY_ID": "",
                "STABLE_SMOKE_SIGNING_PRIVATE_KEY": "",
                "STABLE_SMOKE_USER": "",
            },
            clear=False,
        ):
            self.assertIsNone(preflight._stable_smoke_session("https://map.example", 30))


if __name__ == "__main__":
    unittest.main(verbosity=2)
