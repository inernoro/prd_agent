#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DEPLOY_SCRIPT = ROOT / "exec_dep.sh"


class ReadinessHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        payload = json.dumps(
            {
                "status": "unhealthy",
                "provider": "tencentCos",
                "expectedProvider": "tencentCos",
                "errorCode": "public_read_failed",
            }
        ).encode("utf-8")
        self.send_response(503)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format: str, *args: object) -> None:
        return


server = ThreadingHTTPServer(("127.0.0.1", 0), ReadinessHandler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    response = subprocess.run(
        [
            "curl",
            "--fail-with-body",
            "-sS",
            f"http://127.0.0.1:{server.server_port}/health/ready",
        ],
        check=False,
        capture_output=True,
        text=True,
    )
finally:
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)

assert response.returncode != 0
payload = json.loads(response.stdout)
assert payload["errorCode"] == "public_read_failed"
assert payload["provider"] == "tencentCos"

deploy = DEPLOY_SCRIPT.read_text(encoding="utf-8")
assert "curl --fail-with-body -sS" in deploy
assert 'mv "$readiness_attempt_json" "$readiness_last_response_json"' in deploy
assert 'mv "$readiness_last_response_json" "$asset_storage_readiness_json"' in deploy

print("Asset storage readiness gate test: PASS")
