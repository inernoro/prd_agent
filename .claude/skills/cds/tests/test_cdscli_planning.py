"""Exercise the actual planning and debt CLI entry points against a local HTTP fixture."""

import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


CLI = Path(__file__).resolve().parents[1] / "cli" / "cdscli.py"
PROJECT = "planning-fixture"
KEY = "cdsp_planning_fixture_key"
BASE = f"/api/projects/{PROJECT}/planning"
PROPOSAL = {
    "type": "proposal.submit",
    "requestId": "planning-fixture:proposal-1",
    "kind": "debt",
    "draft": {"title": "补齐导出测试", "whyDebt": "经确认安排下个版本"},
    "source": {"type": "manual", "ref": "fixture:confirmed-tradeoff-1"},
}


class PlanningCliTest(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.committed = {}
        self.permissions = ["read", "propose", "write"]
        self.foreign = False
        self.drop_write_response = False
        self.reject_write = False
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def respond(self, status, value):
                body = json.dumps(value, ensure_ascii=False).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def handle_request(self):
                url = urlsplit(self.path)
                key = self.headers.get("X-AI-Access-Key")
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or "{}")
                fixture.requests.append((self.command, url, body, key))
                if key != KEY:
                    self.respond(401, {"error": "unauthorized"})
                    return

                project = "other-project" if fixture.foreign else PROJECT
                debt = {"id": "D-0001", "projectId": project, "title": "导出结果"}
                if url.path == BASE + "/capabilities":
                    self.respond(200, {
                        "projectId": PROJECT, "protocolVersion": 1, "permissions": fixture.permissions,
                    })
                elif url.path == BASE:
                    self.respond(200, {
                        "projectId": PROJECT, "capabilities": fixture.permissions,
                        "decisions": [], "proposals": [], "plans": [],
                    })
                elif url.path == BASE + "/debts":
                    self.respond(200, {"projectId": PROJECT, "items": [debt], "nextCursor": None})
                elif url.path == BASE + "/debts/D-0001":
                    self.respond(200, {"projectId": PROJECT, "debt": debt, "events": []})
                elif url.path == BASE + "/commands" and self.command == "POST":
                    if fixture.reject_write or body.get("type") != "proposal.submit" or "propose" not in fixture.permissions:
                        self.respond(403, {"error": "write_forbidden", "message": KEY, "details": "upstream fixture detail"})
                        return
                    request_id = body.get("requestId")
                    previous = fixture.committed.get(request_id)
                    if previous is not None and body != previous:
                        self.respond(409, {"error": "idempotency_conflict"})
                        return
                    fixture.committed[request_id] = body
                    if fixture.drop_write_response:
                        fixture.drop_write_response = False
                        self.close_connection = True
                        return
                    proposal = {"id": "P-0001", "projectId": project, "status": "pending"}
                    self.respond(200 if previous else 201, {
                        "projectId": PROJECT, "result": proposal, "reused": previous is not None,
                    })
                else:
                    self.respond(404, {"error": "not_found"})

            do_GET = handle_request
            do_POST = handle_request

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 1)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        root = tempfile.TemporaryDirectory(prefix="cdscli-planning-")
        self.addCleanup(root.cleanup)
        self.root = Path(root.name)
        (self.root / ".git").mkdir()
        (self.root / ".cds").mkdir()
        (self.root / ".cds" / "credentials.json").write_text(json.dumps({
            "version": 1,
            "host": f"http://127.0.0.1:{self.server.server_port}",
            "projectId": PROJECT,
            "projectKey": KEY,
        }), encoding="utf-8")

    def call(self, *args):
        completed = subprocess.run(
            [sys.executable, str(CLI), *args], cwd=self.root,
            env={"PATH": os.defpath, "NO_PROXY": "127.0.0.1", "no_proxy": "127.0.0.1"},
            capture_output=True, text=True, timeout=12, check=False,
        )
        if not completed.stdout.strip():
            return completed, {}
        return completed, json.loads(completed.stdout)

    def submit(self, command):
        filename = self.root / "command.json"
        filename.write_text(json.dumps(command, ensure_ascii=False), encoding="utf-8")
        return self.call("planning", "submit", "--project", PROJECT, "--file", str(filename))

    def assert_ok(self, outcome):
        process, payload = outcome
        self.assertEqual(process.returncode, 0, process.stderr or payload)
        self.assertIs(payload["ok"], True)
        self.assertTrue(payload["trace"])
        return payload["data"]

    def assert_error(self, outcome):
        process, payload = outcome
        self.assertNotEqual(process.returncode, 0)
        self.assertIs(payload.get("ok"), False, process.stderr or payload)
        self.assertNotIn(KEY, process.stdout + process.stderr)
        self.assertNotIn("upstream fixture detail", process.stdout + process.stderr)

    def test_reads_board_and_debts_with_project_credentials(self):
        board = self.assert_ok(self.call("planning", "show", "--project", PROJECT))
        self.assertEqual(board["projectId"], PROJECT)
        self.assertEqual(self.requests[-1][1].path, BASE)
        self.assertEqual(self.requests[-1][3], KEY)
        listing = self.assert_ok(self.call("debt", "list", "--project", PROJECT, "--q", "导出 & 回归"))
        self.assertEqual(listing["items"][0]["id"], "D-0001")
        self.assertEqual(self.requests[-1][1].path, BASE + "/debts")
        self.assertEqual(parse_qs(self.requests[-1][1].query)["q"], ["导出 & 回归"])
        detail = self.assert_ok(self.call("debt", "show", "D-0001", "--project", PROJECT))
        self.assertEqual(detail["debt"]["id"], "D-0001")
        self.assertEqual(self.requests[-1][1].path, BASE + "/debts/D-0001")

    def test_rejects_other_project_and_file_overrides_before_writing(self):
        self.assert_error(self.call("planning", "show", "--project", "other-project"))
        self.assertEqual(self.requests, [])
        self.assert_error(self.submit({**PROPOSAL, "projectId": "other-project"}))
        self.assert_error(self.submit({**PROPOSAL, "host": "https://other.example.invalid"}))
        self.assertFalse(any(method == "POST" for method, *_rest in self.requests))

    def test_rejects_foreign_resource_in_success_response(self):
        self.foreign = True
        self.assert_error(self.call("debt", "list", "--project", PROJECT))
        self.assert_error(self.call("debt", "show", "D-0001", "--project", PROJECT))
        self.assert_error(self.submit(PROPOSAL))

    def test_submission_reports_original_receipt_when_repeated(self):
        first = self.assert_ok(self.submit(PROPOSAL))
        self.assertEqual(self.requests[-1][1].path, BASE + "/commands")
        self.assertEqual(self.requests[-1][2], PROPOSAL)
        self.assertFalse(first["reused"])
        again = self.assert_ok(self.submit(PROPOSAL))
        self.assertTrue(again["reused"])
        self.assertEqual(again["result"]["id"], first["result"]["id"])
        self.assertEqual(len(self.committed), 1)
        self.assert_error(self.submit({**PROPOSAL, "draft": {"title": "不同的提案"}}))

    def test_response_loss_has_error_receipt_and_same_key_can_be_retried(self):
        self.drop_write_response = True
        self.assert_error(self.submit(PROPOSAL))
        self.assertEqual(len([call for call in self.requests if call[0] == "POST"]), 1)
        receipt = self.assert_ok(self.submit(PROPOSAL))
        self.assertTrue(receipt["reused"])
        self.assertEqual(receipt["result"]["id"], "P-0001")
        self.assertEqual(len(self.committed), 1)

    def test_denied_write_does_not_echo_upstream_details(self):
        self.reject_write = True
        self.assert_error(self.submit(PROPOSAL))
        self.assertFalse(self.committed)


if __name__ == "__main__":
    unittest.main()
