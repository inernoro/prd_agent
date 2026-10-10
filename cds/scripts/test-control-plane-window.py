import importlib.util
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import io
from pathlib import Path
import threading
import unittest

spec = importlib.util.spec_from_file_location("window", Path(__file__).with_name("control-plane-window.py"))
window = importlib.util.module_from_spec(spec)
spec.loader.exec_module(window)


class WindowEvidenceTests(unittest.TestCase):
    def test_transport_timings_whitelist_rejects_invalid_and_sensitive_fields(self):
        result = window.curl_timings({"time_namelookup": .01, "time_connect": .02,
                                      "time_appconnect": float("nan"), "time_starttransfer": -1,
                                      "time_pretransfer": True, "time_total": .5,
                                      "url_effective": "never-save", "password": "never-save"})
        self.assertEqual(result["dnsCompletedMs"], 10)
        self.assertEqual(result["tcpConnectedMs"], 20)
        self.assertEqual(result["curlTotalMs"], 500)
        self.assertIsNone(result["tlsConnectedMs"])
        self.assertIsNone(result["firstByteMs"])
        self.assertIsNone(result["transferReadyMs"])
        self.assertNotIn("never-save", str(result))

    def test_incremental_evidence_is_flushed_before_window_completion(self):
        class RecordingStream(io.StringIO):
            flushed = False

            def flush(self):
                self.flushed = True
                super().flush()

        stream = RecordingStream()
        window.append_evidence(stream, {"process": {"pid": 123}})
        self.assertTrue(stream.flushed)
        self.assertEqual(json.loads(stream.getvalue()), {"process": {"pid": 123}})

    def test_nearest_rank_and_empty_sample_do_not_fake_success(self):
        self.assertEqual(window.nearest_rank(list(range(1, 101)), .95), 95)
        self.assertIsNone(window.nearest_rank([], .95))
        self.assertFalse(window.latency_summary([], 180)["latencyTargetMet"])

    def test_timeout_is_retained_in_percentile_and_fails_window(self):
        rows = [{"elapsedMs": 100, "error": None} for _ in range(179)]
        rows.append({"elapsedMs": 30000, "error": "timeout"})
        result = window.latency_summary(rows, 180)
        self.assertEqual(result["samples"], 180)
        self.assertEqual(result["errors"], 1)
        self.assertEqual(result["maxMs"], 30000)
        self.assertFalse(result["latencyTargetMet"])

    def test_incomplete_sample_window_cannot_pass(self):
        rows = [{"elapsedMs": 100, "error": None} for _ in range(179)]
        self.assertFalse(window.latency_summary(rows, 180)["latencyTargetMet"])
        self.assertTrue(window.latency_summary(rows + rows[:1], 180)["latencyTargetMet"])

    def test_html_health_response_and_error_json_are_not_healthy(self):
        self.assertEqual(window.classify("health", 200, 0, "text/html", None), "invalid_response")
        self.assertEqual(window.classify("health", 200, 0, "application/json", {"error": "busy"}), "invalid_response")
        self.assertIsNone(window.classify("health", 200, 0, "application/json", {"ok": True}))
        self.assertEqual(window.classify("health", 503, 0, "application/json", {"ok": True}), "http_error")

    def test_completed_running_run_does_not_count_as_active_load(self):
        result = window.active_projects({"runs": [
            {"projectId": "one", "status": "building"},
            {"projectId": "two", "status": "running", "finishedAt": "2026-10-10T14:00:00Z"},
            {"projectId": "three", "status": "failed"},
        ]})
        self.assertEqual(result, ["one"])

    def test_partial_diagnostic_window_and_credentials_are_not_saved(self):
        result = window.diagnostic_snapshot({"eventLoop": {"current": {"p99Ms": 1}},
                                             "mainThread": {"current": {"sections": []}},
                                             "process": {"pid": 1, "secret": "never-save"}, "token": "never-save"})
        self.assertIsNone(result["eventLoopPrevious"])
        self.assertNotIn("never-save", str(result))

    def test_headers_are_stdin_config_and_injection_is_rejected(self):
        self.assertEqual(window.header_config({"X-AI-Access-Key": 'a"b'}), 'header = "X-AI-Access-Key: a\\"b"\n')
        with self.assertRaises(ValueError):
            window.header_config({"X-AI-Access-Key": "a\nurl=untrusted"})

    def test_actual_http_probe_keeps_http_failures_and_rejects_html(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.headers.get("X-AI-Access-Key") != "probe-only-key":
                    self.send_response(401)
                    self.end_headers()
                    return
                status, mime, body = {
                    "/health": (200, "application/json", json.dumps({"ok": True})),
                    "/branches": (200, "text/html", "<html>not JSON</html>"),
                    "/runs": (503, "application/json", json.dumps({"runs": []})),
                }[self.path]
                self.send_response(status)
                self.send_header("Content-Type", mime)
                self.end_headers()
                self.wfile.write(body.encode())

            def log_message(self, *_):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            probe = window.Probe(f"http://127.0.0.1:{server.server_port}", {"X-AI-Access-Key": "probe-only-key"}, 2)
            health, _ = probe.request("health", "/health")
            html, _ = probe.request("branches", "/branches")
            failed, _ = probe.request("runs", "/runs")
            self.assertIsNone(health["error"])
            self.assertGreater(health["timings"]["curlTotalMs"], 0)
            self.assertGreaterEqual(health["timings"]["firstByteMs"], health["timings"]["tcpConnectedMs"])
            self.assertEqual(html["error"], "invalid_response")
            self.assertEqual(failed["status"], 503)
            self.assertEqual(failed["error"], "http_error")
            self.assertNotIn("probe-only-key", str([health, html, failed]))
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
