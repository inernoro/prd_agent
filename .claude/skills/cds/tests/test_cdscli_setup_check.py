"""Exercise the shipped CLI over real HTTP with isolated workspace credentials."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

CLI = Path(__file__).resolve().parents[1] / "cli" / "cdscli.py"
SECRET = "cdsp_setup_test_secret_never_print"
SKILLS = ("cds", "cds-project-scan", "cds-deploy-pipeline", "cds-release", "preview-url")


class SetupCheckTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / ".git").mkdir()
        self.cli = self.root / ".agents/skills/cds/cli/cdscli.py"
        self.cli.parent.mkdir(parents=True)
        shutil.copyfile(CLI, self.cli)
        for skill in SKILLS:
            folder = self.root / ".agents/skills" / skill
            folder.mkdir(parents=True, exist_ok=True)
            (folder / "SKILL.md").write_text(f"---\nname: {skill}\ndescription: test\n---\n")
        self.requests = []
        self.status = "active"
        self.kind = "project"
        self.version = "0.17.0"
        self.project_status = 200
        self.returned_project = "proj-a"
        test = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                test.requests.append((self.path, self.headers.get("X-AI-Access-Key")))
                status = 200
                if self.path == "/api/agent/setup.json":
                    body = {"version": "cds-agent-setup.v1", "cliVersion": test.version}
                elif self.path == "/api/credentials/self-check":
                    body = {"kind": test.kind, "status": test.status}
                    if test.kind == "project":
                        body["projectId"] = "proj-a"
                elif self.path == "/api/projects/proj-a":
                    status = test.project_status
                    body = {"project": {"id": test.returned_project}, "secret": SECRET}
                elif self.path == "/api/config":
                    body = {"secret": SECRET}
                else:
                    status, body = 404, {"secret": SECRET}
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(body).encode())

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.host = f"http://127.0.0.1:{self.server.server_port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.credentials = self.root / ".cds/credentials.json"
        self.credentials.parent.mkdir()
        self.credentials.write_text(json.dumps({"host": self.host, "projectId": "proj-a", "projectKey": SECRET}))

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.tmp.cleanup()

    def run_check(self, *target, host=None):
        env = {key: value for key, value in os.environ.items()
               if key not in ("CDS_HOST", "CDS_PROJECT_ID", "CDS_PROJECT_KEY", "AI_ACCESS_KEY")}
        result = subprocess.run([sys.executable, str(self.cli), "setup-check", "--host", host or self.host,
                                 *(target or ("--project", "proj-a")), "--skills", "cds-deploy-pipeline"],
                                cwd=self.root, env=env, capture_output=True, text=True, timeout=15)
        self.assertNotIn(SECRET, result.stdout + result.stderr)
        return result, json.loads(result.stdout)

    def assert_failure(self, reason, *target, host=None):
        result, payload = self.run_check(*target, host=host)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(payload["data"]["connected"])
        self.assertEqual(payload["data"]["checks"][-1]["reason"], reason)

    def test_existing_credentials_are_reused_and_target_is_really_read(self):
        before = self.credentials.read_bytes()
        result, payload = self.run_check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(payload["data"]["connected"])
        self.assertEqual(payload["data"]["projectId"], "proj-a")
        self.assertEqual([path for path, _ in self.requests], [
            "/api/agent/setup.json", "/api/credentials/self-check", "/api/projects/proj-a"])
        self.assertTrue(all(key == SECRET for _, key in self.requests))
        self.assertEqual(self.credentials.read_bytes(), before)
        self.assertFalse((self.root / ".git/info/exclude").exists())

    def test_host_mismatch_sends_no_credentials(self):
        self.assert_failure("host_mismatch", host="https://other.example")
        self.assertEqual(self.requests, [])

    def test_project_mismatch_stops_before_network(self):
        self.assert_failure("project_mismatch", "--project", "proj-b")
        self.assertEqual(self.requests, [])

    def test_empty_project_does_not_fall_back_to_system_access(self):
        self.assert_failure("invalid_project", "--project", "")
        self.assertEqual(self.requests, [])

    def test_missing_credentials_does_not_start_authorization(self):
        self.credentials.unlink()
        self.assert_failure("missing_credentials")
        self.assertEqual(self.requests, [])

    def test_revoked_credentials_do_not_read_project(self):
        self.status = "revoked"
        self.assert_failure("revoked")
        self.assertEqual(len(self.requests), 2)

    def test_disabled_identity_does_not_recommend_repeated_authorization(self):
        self.status = "principal-disabled"
        result, payload = self.run_check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("恢复账号", payload["data"]["checks"][-1]["nextStep"])
        self.assertEqual(len(self.requests), 2)

    def test_uncheckable_identity_distinguishes_service_support_from_expired_key(self):
        self.status = "not-checkable"
        result, payload = self.run_check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("服务版本", payload["data"]["checks"][-1]["nextStep"])

    def test_stale_cli_cannot_claim_connected(self):
        self.version = "99.0.0"
        self.assert_failure("stale_cli")
        self.assertEqual(len(self.requests), 1)

    def test_missing_bundle_is_distinct_from_authorization(self):
        (self.root / ".agents/skills/preview-url/SKILL.md").unlink()
        self.assert_failure("incomplete_bundle")
        self.assertEqual(self.requests, [])

    def test_active_credential_without_real_project_access_fails(self):
        self.project_status = 403
        self.assert_failure("access_denied")

    def test_wrong_project_response_is_rejected_even_with_http_200(self):
        self.returned_project = "proj-b"
        self.assert_failure("target_mismatch")

    def test_system_task_cannot_reuse_project_key_as_system_permission(self):
        self.assert_failure("system_scope_required", "--system")
        self.assertFalse(any(path == "/api/config" for path, _ in self.requests))

    def test_system_read_only_check_does_not_invent_project(self):
        self.kind = "static"
        result, payload = self.run_check("--system")
        self.assertEqual(result.returncode, 0)
        self.assertIsNone(payload["data"]["projectId"])
        self.assertEqual(payload["data"]["scope"], "system-read")
        self.assertEqual(self.requests[-1][0], "/api/config")


if __name__ == "__main__":
    unittest.main()
