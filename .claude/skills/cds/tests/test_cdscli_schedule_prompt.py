"""cdscli schedule prompt tests.

用标准库 unittest 覆盖口令解析、动作检测和创建 payload，不访问真实 CDS。
"""
import io
import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
CLI_DIR = ROOT / "cli"
sys.path.insert(0, str(CLI_DIR))

import cdscli  # noqa: E402


def call_main(argv: list[str]) -> tuple[int, str]:
    buf = io.StringIO()
    code = 0
    real_stdout = sys.stdout
    sys.stdout = buf
    try:
        cdscli.main(argv)
    except SystemExit as e:
        code = e.code if isinstance(e.code, int) else 1
    finally:
        sys.stdout = real_stdout
    return code, buf.getvalue()


def parse_last_json(out: str) -> dict:
    return json.loads(out.strip().split("\n")[-1])


class CdsCliSchedulePromptTest(unittest.TestCase):
    def setUp(self) -> None:
        self.env = mock.patch.dict(
            os.environ,
            {
                "CDS_HOST": "cds.test.example",
                "AI_ACCESS_KEY": "test-key-not-real",
            },
            clear=False,
        )
        self.env.start()
        os.environ.pop("CDS_PROJECT_ID", None)
        os.environ.pop("CDS_PROJECT_KEY", None)
        cdscli._TRACE_ID = "testtrace"
        cdscli._HUMAN = False

    def tearDown(self) -> None:
        self.env.stop()

    def test_schedule_parse_daily_http_prompt(self) -> None:
        code, out = call_main([
            "schedule", "parse",
            "每天 02:00 调用 POST /api/statistics/sync",
            "--project", "demo",
            "--name", "生码统计",
        ])

        self.assertEqual(code, 0, out)
        payload = parse_last_json(out)
        self.assertTrue(payload["ok"])
        job = payload["data"]
        self.assertEqual(job["projectId"], "demo")
        self.assertEqual(job["name"], "生码统计")
        self.assertEqual(job["schedule"], {
            "type": "daily",
            "timeOfDay": "02:00",
            "timezone": "Asia/Shanghai",
        })
        self.assertEqual(job["actions"][0]["type"], "http")
        self.assertEqual(job["actions"][0]["method"], "POST")
        self.assertEqual(job["actions"][0]["url"], "/api/statistics/sync")

    def test_schedule_parse_interval_command_prompt(self) -> None:
        code, out = call_main([
            "schedule", "parse",
            "每隔 10 分钟 执行命令 echo ok",
            "--project", "demo",
        ])

        self.assertEqual(code, 0, out)
        job = parse_last_json(out)["data"]
        self.assertEqual(job["schedule"]["type"], "interval")
        self.assertEqual(job["schedule"]["intervalMinutes"], 10)
        self.assertEqual(job["actions"][0]["type"], "command")
        self.assertEqual(job["actions"][0]["command"], "echo ok")

    def test_schedule_create_with_test_checks_actions_before_post(self) -> None:
        calls: list[tuple[str, str, dict | None]] = []

        def fake_call(method, path, body=None, timeout=15, quiet=False):
            calls.append((method, path, body))
            if path == "/api/scheduled-jobs/check-target":
                return {"result": {"ok": True, "httpStatus": 200, "log": "ok"}}
            if path == "/api/scheduled-jobs":
                return {"job": {"id": "sjob_1", **body}}
            raise AssertionError(path)

        with mock.patch.object(cdscli, "_call", fake_call):
            code, out = call_main([
                "schedule", "create",
                "每天 03:30 curl -X POST -H 'Content-Type: application/json' -d '{\"a\":1}' https://old.example/sync",
                "--project", "demo",
                "--test",
                "--retry", "1",
            ])

        self.assertEqual(code, 0, out)
        self.assertEqual([c[1] for c in calls], [
            "/api/scheduled-jobs/check-target",
            "/api/scheduled-jobs",
        ])
        check_body = calls[0][2]
        self.assertEqual(check_body["projectId"], "demo")
        self.assertEqual(check_body["target"]["method"], "POST")
        self.assertEqual(check_body["target"]["headers"], {"Content-Type": "application/json"})
        self.assertEqual(check_body["target"]["body"], '{"a":1}')
        create_body = calls[1][2]
        self.assertEqual(create_body["retryCount"], 1)
        self.assertEqual(create_body["schedule"]["timeOfDay"], "03:30")
        payload = parse_last_json(out)
        self.assertEqual(payload["data"]["job"]["id"], "sjob_1")

    def test_schedule_test_fails_when_check_target_fails(self) -> None:
        with mock.patch.object(
            cdscli,
            "_call",
            lambda *a, **kw: {"result": {"ok": False, "exitCode": 2, "log": "bad"}},
        ):
            code, out = call_main([
                "schedule", "test",
                "手动 执行命令 exit 2",
                "--project", "demo",
            ])

        self.assertEqual(code, 2)
        payload = parse_last_json(out)
        self.assertFalse(payload["ok"])
        self.assertIn("检测未通过", payload["error"])

    def test_schedule_prompt_without_schedule_dies(self) -> None:
        def fail_call(*_args, **_kwargs):
            raise AssertionError("不应请求 CDS")

        with mock.patch.object(cdscli, "_call", fail_call):
            code, out = call_main([
                "schedule", "create",
                "调用 POST /api/statistics/sync",
                "--project", "demo",
            ])

        self.assertEqual(code, 1)
        payload = parse_last_json(out)
        self.assertFalse(payload["ok"])
        self.assertIn("未识别调度口令", payload["error"])


if __name__ == "__main__":
    unittest.main()
