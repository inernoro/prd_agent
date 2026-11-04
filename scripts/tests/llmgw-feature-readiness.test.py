#!/usr/bin/env python3
"""发布目标检查的行为回归；HTTP 200 不能把业务失败变成绿灯。"""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/llmgw-serving-probe.py"
SPEC = importlib.util.spec_from_file_location("probe", SCRIPT)
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)


class FeatureReadinessTests(unittest.TestCase):
    def test_scope_rejects_unknown_and_does_not_scan_unselected_agents(self):
        self.assertEqual(probe._feature_routes(["none"]), [])
        self.assertEqual(len(probe._feature_routes(["defect-agent,defect-agent"])), 2)
        with self.assertRaises(ValueError):
            probe._feature_routes(["typo-agent"])
        with self.assertRaises(ValueError):
            probe._feature_routes(["none,defect-agent"])

    def test_failed_target_blocks_release_command_then_recovery_passes(self):
        requests = []
        state = {"broken": True}

        class Handler(BaseHTTPRequestHandler):
            def reply(self, status, payload):
                raw = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                if self.path in ("/healthz", "/readyz"):
                    self.reply(200, {"status": "ready", "commit": "test"})
                else:
                    self.reply(401, {"error": {"code": "KEY_REQUIRED"}})

            def do_POST(self):
                if not self.headers.get("X-Gateway-Key"):
                    self.reply(401, {"error": {"code": "KEY_REQUIRED"}})
                    return
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                requests.append((self.path, body))
                broken = state["broken"] and "polish-stream" in body["AppCallerCode"]
                self.reply(200, {"success": not broken, "failureCode": "APPCALLER_POOL_UNBOUND" if broken else None,
                                 "logicalModelPublicId": "default-chat-curated" if not broken else None})

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as temp:
                output = Path(temp) / "readiness.json"
                command = [sys.executable, str(SCRIPT), "--base", f"http://127.0.0.1:{server.server_port}",
                           "--feature", "defect-agent", "--samples", "1", "--interval", "0", "--expect-commit", "test",
                           "--protected-endpoint", "POST /resolve", "--json-out", str(output)]
                env = dict(os.environ, LLMGW_GATE_KEY="test-credential-do-not-print")
                for broken in (True, False):
                    state["broken"] = broken
                    result = subprocess.run(command, capture_output=True, text=True, env=env)
                    report = json.loads(output.read_text())
                    self.assertEqual(result.returncode, 1 if broken else 0, result.stdout + result.stderr)
                    self.assertEqual(report["verdict"], "fail" if broken else "pass")
                    self.assertEqual(len(report["featureRoutes"]), 2)
                    self.assertNotIn(env["LLMGW_GATE_KEY"], result.stdout + output.read_text())
                    if broken:
                        self.assertIn("defect-agent.polish-stream::chat", result.stdout)
                self.assertTrue(all(path == "/resolve" and body["ReadOnlyMetadata"] is True for path, body in requests))
                self.assertEqual(len(requests), 4)
                # 跑发布脚本的真实验收函数；删掉其范围接线会让这一条错误地放行。
                deploy = (ROOT / "exec_dep.sh").read_text()
                function = deploy.split("run_llmgw_post_deploy_verification_if_needed() {", 1)[1].split(
                    '\n}\n\nif [ -n "${SKIP_API_PULL:-}"', 1)[0]
                shell = "run_llmgw_post_deploy_verification_if_needed() {" + function + "\n}\nrun_llmgw_post_deploy_verification_if_needed"
                env.update(LLMGW_POST_DEPLOY_VERIFY_NEEDED="1", LLMGW_POST_DEPLOY_GATE_KEY=env["LLMGW_GATE_KEY"],
                           LLMGW_POST_DEPLOY_GATE_BASE=f"http://127.0.0.1:{server.server_port}",
                           LLMGW_POST_DEPLOY_RUN_SMOKE="0", LLMGW_POST_DEPLOY_RUN_PROTOCOL_CANARY="0",
                           LLMGW_GATE_SERVING_PROBE_SAMPLES="1", LLMGW_GATE_SERVING_PROBE_INTERVAL_SECONDS="0",
                           LLMGW_POST_DEPLOY_EXPECT_COMMIT="test", LLMGW_SERVING_PROBE_JSON_OUT=str(output))
                env.pop("LLMGW_RELEASE_FEATURES", None)
                state["broken"] = True
                unwired = shell.replace('LLMGW_RELEASE_FEATURES="$release_features" ', "")
                previous = subprocess.run(["bash", "-euc", unwired], cwd=ROOT, env=env, capture_output=True, text=True)
                self.assertEqual(previous.returncode, 0, previous.stdout + previous.stderr)
                self.assertEqual(json.loads(output.read_text())["featureRoutes"], [])
                blocked = subprocess.run(["bash", "-euc", shell], cwd=ROOT, env=env, capture_output=True, text=True)
                self.assertEqual(blocked.returncode, 1, blocked.stdout + blocked.stderr)
                self.assertEqual(len(json.loads(output.read_text())["featureRoutes"]), 2)
                env["LLMGW_RELEASE_FEATURES"] = "none"
                unselected = subprocess.run(["bash", "-euc", shell], cwd=ROOT, env=env, capture_output=True, text=True)
                self.assertEqual(unselected.returncode, 0, unselected.stdout + unselected.stderr)
                self.assertEqual(json.loads(output.read_text())["featureRoutes"], [])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_release_and_ci_consume_the_probe(self):
        deploy = (ROOT / "exec_dep.sh").read_text()
        self.assertIn("LLMGW_RELEASE_FEATURES", deploy)
        self.assertIn('LLMGW_RELEASE_FEATURES="$release_features"', deploy)
        ci = (ROOT / ".github/workflows/ci.yml").read_text()
        self.assertIn("- 'scripts/llmgw-serving-probe.py'", ci)
        self.assertIn("- 'scripts/tests/llmgw-feature-readiness.test.py'", ci)
        self.assertIn("run: python3 scripts/tests/llmgw-feature-readiness.test.py", ci)


if __name__ == "__main__":
    unittest.main()
