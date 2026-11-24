"""Exercise CLI→HTTP code review contracts with real project credentials and multipart bytes."""
import contextlib
import io
import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "cli"))
import cdscli


class CodeReviewCliTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cdscli-review-")
        self.root = Path(self.temp.name)
        (self.root / ".git").mkdir()
        (self.root / ".cds").mkdir()
        (self.root / "code.zip").write_bytes(b"PK\x03\x04sample source")
        (self.root / "review.md").write_text("# 代码审查结果", encoding="utf-8")
        self.requests = []
        requests = self.requests

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                self.handle_request()

            def do_POST(self):
                self.handle_request()

            def handle_request(self):
                content = self.rfile.read(int(self.headers.get("content-length", "0")))
                requests.append({"method": self.command, "path": self.path,
                                 "headers": dict(self.headers), "body": content})
                task = {"id": "task-1", "projectId": "project-one", "status": "running"}
                if "wrong-project" in self.path:
                    task["projectId"] = "other"
                if self.path.endswith("/reports"):
                    result = {"report": {"id": "report-1", "projectId": "project-one", "reportType": "code-review"}}
                elif self.path.startswith("/api/code-reviews/branches?"):
                    result = {"branches": [{"id": "branch-1", "branch": "feature/audit", "status": "idle"}]}
                elif "includeResult=1" in self.path:
                    result = {"task": task, "result": {"projectId": "project-one", "taskId": task["id"], "findings": [], "coverage": {"complete": False}}}
                elif "?" in self.path:
                    result = {"tasks": [task]}
                else:
                    result = {"task": task}
                body = json.dumps(result).encode()
                self.send_response(202 if self.command == "POST" else 200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.host = f"http://127.0.0.1:{self.server.server_port}"
        (self.root / ".cds/credentials.json").write_text(json.dumps({
            "version": 1, "host": self.host, "projectId": "project-one",
            "projectKey": "cdsp_test_not_a_real_credential",
        }))
        self.old_cwd = os.getcwd()
        os.chdir(self.root)
        self.env = mock.patch.dict(os.environ, {"NO_PROXY": "127.0.0.1", "no_proxy": "127.0.0.1"}, clear=True)
        self.env.start()

    def tearDown(self):
        self.env.stop()
        os.chdir(self.old_cwd)
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def call(self, *args):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            try:
                cdscli.main(["code-review", *args])
                code = 0
            except SystemExit as error:
                code = error.code
        payload = json.loads(output.getvalue().strip().splitlines()[-1])
        return code, payload

    def test_github_uses_real_project_credentials_and_project_id(self):
        code, output = self.call("submit", "--github", "https://github.com/inernoro/prd_agent", "--ref", "main", "--email", "owner@example.com", "--exclude", "vendor/**", "--idempotency-key", "submission-1")
        self.assertEqual(code, 0, output)
        request = self.requests[-1]
        self.assertEqual(request["headers"]["X-Ai-Access-Key"], "cdsp_test_not_a_real_credential")
        self.assertEqual(json.loads(request["body"]), {
            "projectId": "project-one", "sourceType": "github", "githubUrl": "https://github.com/inernoro/prd_agent", "ref": "main", "email": "owner@example.com", "excludePatterns": ["vendor/**"], "idempotencyKey": "submission-1",
        })
        self.assertEqual(output["data"]["task"]["id"], "task-1")

    def test_cds_branch_discovery_and_submission_without_upload(self):
        code, output = self.call("list", "--include-branches")
        self.assertEqual(code, 0, output)
        self.assertEqual(output["data"]["branches"][0]["id"], "branch-1")
        self.assertEqual(self.requests[-1]["path"], "/api/code-reviews/branches?projectId=project-one")
        code, output = self.call("submit", "--branch-id", "branch-1", "--exclude", "vendor/")
        self.assertEqual(code, 0, output)
        self.assertEqual(json.loads(self.requests[-1]["body"]), {
            "sourceType": "cds", "projectId": "project-one", "branchId": "branch-1", "excludePatterns": ["vendor/"],
        })
        count = len(self.requests)
        code, _ = self.call("submit", "--branch-id", "branch-1", "--ref", "main")
        self.assertEqual(code, 1)
        self.assertEqual(len(self.requests), count)

    def test_zip_upload_and_report_upload_send_local_bytes(self):
        code, output = self.call("submit", "--zip-file", "code.zip", "--exclude", "vendor/**")
        self.assertEqual(code, 0, output)
        request = self.requests[-1]
        self.assertTrue(request["headers"]["Content-Type"].startswith("multipart/form-data; boundary="))
        self.assertIn(b'filename="code.zip"', request["body"])
        self.assertIn(b"PK\x03\x04sample source", request["body"])
        self.assertIn(b'name="projectId"\r\n\r\nproject-one', request["body"])
        code, output = self.call("upload-report", "--file", "review.md", "--title", "质量审查")
        self.assertEqual(code, 0, output)
        self.assertEqual(self.requests[-1]["path"], "/api/code-reviews/reports")
        self.assertIn("# 代码审查结果".encode(), self.requests[-1]["body"])
        self.assertIn(b'name="format"\r\n\r\nmd', self.requests[-1]["body"])

    def test_task_commands_share_same_scoped_resource_paths(self):
        for action, path, method in (("show", "", "GET"), ("cancel", "/cancel", "POST"), ("retry", "/retry", "POST"), ("mail-retry", "/delivery/retry", "POST")):
            with self.subTest(action=action):
                code, output = self.call(action, "task/encoded")
                self.assertEqual(code, 0, output)
                self.assertEqual(self.requests[-1]["path"], "/api/code-reviews/task%2Fencoded" + path)
                self.assertEqual(self.requests[-1]["method"], method)
        code, output = self.call("list")
        self.assertEqual(code, 0, output)
        self.assertEqual(self.requests[-1]["path"], "/api/code-reviews?projectId=project-one")

    def test_project_override_and_server_mismatch_are_rejected(self):
        code, output = self.call("list", "--project", "other")
        self.assertEqual(code, 1)
        self.assertFalse(output["ok"])
        self.assertEqual(self.requests, [])
        code, output = self.call("show", "wrong-project")
        self.assertEqual(code, 1)
        self.assertFalse(output["ok"])

    def test_structured_results_keep_explicit_pagination_and_project_scope(self):
        code, output = self.call("show", "task-1", "--results", "--offset", "50", "--limit", "25", "--severity", "high")
        self.assertEqual(code, 0, output)
        self.assertIn("includeResult=1", self.requests[-1]["path"])
        for part in ("offset=50", "limit=25", "severity=high"):
            self.assertIn(part, self.requests[-1]["path"])
        self.assertFalse(output["data"]["result"]["coverage"]["complete"])

    def test_invalid_file_or_zip_ref_fails_before_network(self):
        for args in (("submit", "--zip-file", "review.md"), ("submit", "--zip-file", "code.zip", "--ref", "main"), ("upload-report", "--file", "code.zip", "--title", "bad")):
            with self.subTest(args=args):
                code, output = self.call(*args)
                self.assertEqual(code, 1)
                self.assertFalse(output["ok"])
        self.assertEqual(self.requests, [])


if __name__ == "__main__":
    unittest.main()
