"""Real HTTP exercise of DTS project scope, pinned capabilities and idempotent start."""
import contextlib
import io
import json
import os
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "cli"))
import cdscli

class DtsCliTest(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.version = 1
        self.foreign = False
        outer = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass
            def serve(self):
                payload = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))) or "{}")
                outer.calls.append((self.command, self.path, payload))
                resource = {"id": "run", "projectId": "other" if outer.foreign else "p", "plan": {"id": "plan"}}
                body = {"projectId": "p", "protocolVersion": outer.version, "tools": ["cds_dts_start", "cds_dts_runs", "cds_dts_control", "cds_dts_plan", "cds_dts_connections", "cds_dts_policies"]} if "/capabilities?" in self.path else {"connections": [{"projectId": "p"}], "services": [resource]} if "/connections?" in self.path else {"run": resource}
                self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(json.dumps(body).encode())
            do_GET = serve
            do_POST = serve
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        self.env = mock.patch.dict(os.environ, {"CDS_HOST": "http://127.0.0.1:" + str(self.server.server_port), "CDS_PROJECT_ID": "p", "CDS_PROJECT_KEY": "cdsp_dts_fixture", "AI_ACCESS_KEY": ""})
        self.env.start()
    def tearDown(self):
        self.env.stop(); self.server.shutdown(); self.server.server_close(); self.thread.join()
    def run_cli(self, *args):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            try:
                cdscli.main(["dts", *args])
            except SystemExit as e:
                if e.code != 0:
                    raise
        return output.getvalue()
    def test_start_preserves_idempotency_and_project(self):
        result = self.run_cli("start", "--plan", "plan", "--idempotency-key", "retry-stable")
        self.assertIn("run", result)
        self.assertEqual(self.calls[-1][2], {"planId": "plan", "idempotencyKey": "retry-stable", "projectId": "p"})
    def test_foreign_project_rejected_before_http(self):
        with self.assertRaises(SystemExit): self.run_cli("runs", "--project", "foreign")
        self.assertEqual(self.calls, [])
    def test_protocol_mismatch_prevents_write(self):
        self.version = 2
        with self.assertRaises(SystemExit): self.run_cli("start", "--plan", "plan", "--idempotency-key", "stable")
        self.assertEqual([c[0] for c in self.calls], ["GET"])
    def test_boolean_protocol_version_cannot_authorize_a_write(self):
        self.version = True
        with self.assertRaises(SystemExit): self.run_cli("start", "--plan", "plan", "--idempotency-key", "stable")
        self.assertEqual([c[0] for c in self.calls], ["GET"])
    def test_foreign_response_prevents_cancel(self):
        self.foreign = True
        with self.assertRaises(SystemExit): self.run_cli("cancel", "run")
        self.assertNotIn("POST", [c[0] for c in self.calls])

    def test_foreign_managed_service_is_rejected(self):
        self.foreign = True
        with self.assertRaises(SystemExit): self.run_cli("connections")
