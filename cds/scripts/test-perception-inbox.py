"""Use the actual independent process, an offline CDS socket and a local provider."""

from contextlib import closing, contextmanager
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path
import select
import secrets
import sqlite3
import subprocess
import sys
import tempfile
from threading import Thread
import time
import unittest
import urllib.error
import urllib.request


@contextmanager
def running_server(handler):
    with HTTPServer(('127.0.0.1', 0), handler) as server:
        worker = Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            yield server
        finally:
            server.shutdown()
            worker.join(timeout=5)


class PerceptionInboxTest(unittest.TestCase):
    def test_cold_start_accepts_a_new_event_while_cds_is_down(self):
        sent = []

        class Provider(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                sent.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"code":200}')

        with running_server(Provider) as provider, tempfile.TemporaryDirectory() as d:
            with HTTPServer(('127.0.0.1', 0), BaseHTTPRequestHandler) as stopped_cds:
                cds_port = stopped_cds.server_port
            token = secrets.token_urlsafe(32)
            root = Path(d)
            config = root / 'config.json'
            config.write_text(json.dumps({
                'cdsBase': f'http://127.0.0.1:{cds_port}', 'headers': {}, 'relayPrivateKey': 'offline-fixture',
                'publicUrl': 'https://example.test/', 'perception': {
                    'port': 0,
                    'sources': {'fixture-ci': {'token': token, 'project': 'map', 'target': 'model-api', 'system': 'map',
                                              'channel': 'phone', 'kinds': ['release-succeeded']}},
                    'channels': {'phone': {'bark': {'key': 'local-test-only', 'serverUrl': f'http://127.0.0.1:{provider.server_port}'}}},
                },
            }))
            config.chmod(0o600)
            program = Path(__file__).with_name('independent-monitor.py')
            with subprocess.Popen([sys.executable, str(program), '--config', str(config)],
                                  stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True) as process:
                try:
                    self.assertTrue(select.select([process.stdout], [], [], 10)[0], '感知系统接收端未启动')
                    ready = json.loads(process.stdout.readline())
                    self.assertEqual(ready['result'], 'perception-intake-ready')
                    self.assertNotEqual(ready['port'], cds_port)
                    base = f"http://127.0.0.1:{ready['port']}/v1/sources/fixture-ci/events"
                    event = {'id': 'event-123', 'run': 'run-456', 'kind': 'release-succeeded', 'version': 'abcdef0123456789'}

                    def request(suffix='', payload=None, bearer=token):
                        req = urllib.request.Request(base + suffix, None if payload is None else json.dumps(payload).encode(),
                                                     {'Authorization': f'Bearer {bearer}', 'Content-Type': 'application/json'})
                        try:
                            with urllib.request.urlopen(req, timeout=3) as response:
                                return response.status, json.load(response)
                        except urllib.error.HTTPError as error:
                            return error.code, json.load(error)

                    self.assertEqual(request(payload=event, bearer='invalid')[0], 403)
                    self.assertEqual(request(payload={**event, 'kind': 'rollback-succeeded'})[0], 400)
                    self.assertEqual(request(payload=event), (202, {'status': 'queued'}))
                    self.assertEqual(request(payload=event), (202, {'status': 'queued'}))
                    self.assertEqual(request(payload={**event, 'version': 'fedcba0123456789'})[0], 409)
                    deadline = time.monotonic() + 65
                    status = None
                    while time.monotonic() < deadline:
                        _, result = request('/event-123')
                        status = result['status']
                        if status == 'provider-accepted':
                            break
                        time.sleep(0.5)
                    self.assertEqual(status, 'provider-accepted')
                    self.assertEqual([(item['title'], item['body']) for item in sent], [('正式 MAP', 'abcdef012345发布完成')])
                    self.assertEqual(request(payload=event), (202, {'status': 'provider-accepted'}))
                    event_db = root / 'perception-events.sqlite3'
                    self.assertEqual(event_db.stat().st_mode & 0o777, 0o600)
                    with closing(sqlite3.connect(event_db)) as db:
                        self.assertEqual(db.execute('SELECT COUNT(*) FROM events').fetchone(), (1,))
                    self.assertNotIn(token.encode(), event_db.read_bytes())
                finally:
                    process.terminate()
                    process.wait(timeout=10)
                self.assertIn('relay-sync-unavailable', process.stdout.read())


if __name__ == '__main__':
    unittest.main()
