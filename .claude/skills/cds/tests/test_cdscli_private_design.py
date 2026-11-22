"""Use the real CLI parser, local Git, and a loopback publication fixture."""

import contextlib
import importlib.util
import io
import json
import os
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlsplit
from zipfile import ZipFile

CLI = Path(__file__).resolve().parents[1] / 'cli' / 'cdscli.py'
PROJECT = 'private-design-fixture'
KEY = 'cdsp_private_fixture_only'
ROUTE = f'/api/projects/{PROJECT}/design/packages'
DESIGN = 'DSN-fixture'
GIT_ENV = {'PATH': os.defpath, 'LANG': 'C.UTF-8', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null'}


class PrivatePublishCliTest(unittest.TestCase):
    def setUp(self):
        self.writes = []
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                target = urlsplit(self.path)
                body = self.rfile.read(int(self.headers['Content-Length']))
                query = {key: values[0] for key, values in parse_qs(target.query).items()}
                fixture.writes.append((target.path, self.headers['X-AI-Access-Key'],
                                       self.headers['Content-Type'], query, body))
                reused = len(fixture.writes) > 1 and fixture.writes[-1] == fixture.writes[0]
                response = json.dumps({'projectId': PROJECT, 'reused': reused,
                                       'result': {'type': 'package', 'designId': DESIGN, 'version': 5}}).encode()
                self.send_response(200 if reused else 201)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(response)))
                self.end_headers()
                self.wfile.write(response)

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.02}, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 1)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        sandbox = tempfile.TemporaryDirectory(prefix='cli-private-design-')
        self.addCleanup(sandbox.cleanup)
        self.repo = Path(sandbox.name)
        self.path = 'design/reports'
        self.directory = self.repo / self.path
        (self.directory / 'dist').mkdir(parents=True)
        self.files = {'design.json': json.dumps({'project': PROJECT, 'title': 'Fixture'}).encode(),
                      '思路.md': b'# Private design fixture',
                      'dist/index.html': b'<!doctype html><h1>Fixture</h1>'}
        for name, data in self.files.items():
            (self.directory / name).write_bytes(data)
        (self.repo / 'excluded.txt').write_text('Outside the requested design directory', encoding='utf-8')
        self.git('init', '-q')
        self.git('add', '.')
        self.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Fixture')
        self.commit = self.git('rev-parse', 'HEAD').decode().strip()
        self.assertEqual(self.git('remote'), b'')
        self.env = {**GIT_ENV, 'CDS_PROJECT_ID': PROJECT, 'CDS_PROJECT_KEY': KEY,
                    'CDS_HOST': f'http://127.0.0.1:{server.server_port}'}
        self.git_ops = []

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.repo, env=GIT_ENV)

    def call(self, *args, directory=None):
        cli_path = CLI
        spec = importlib.util.spec_from_file_location('private_design_cli', cli_path)
        cli = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cli)
        base_run = subprocess.run

        def record(command, **kwargs):
            if isinstance(command, list) and Path(command[0]).name == 'git':
                self.git_ops.append(tuple(command))
                self.assertNotIn('push', command, 'private publication must not push Git')
            return base_run(command, **kwargs)

        stdout, stderr = io.StringIO(), io.StringIO()
        previous = Path.cwd()
        try:
            os.chdir(self.repo)
            with mock.patch.dict(os.environ, self.env, clear=True), mock.patch.object(cli.subprocess, 'run', record), \
                    contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit) as ended:
                cli.main(['design', 'publish', DESIGN, '--dir', str(directory or self.directory),
                          '--intent', 'revise', '--design-key', 'reports/summary', '--expected-version', '4', *args])
        finally:
            os.chdir(previous)
        return ended.exception.code, stdout.getvalue(), stderr.getvalue()

    def check_receipts(self, *flags, mode):
        for reused in (False, True):
            code, output, error = self.call(*flags)
            self.assertEqual(code, 0, output or error)
            payload = json.loads(output)
            self.assertIs(payload['ok'], True)
            self.assertEqual(payload['data'], {'projectId': PROJECT, 'reused': reused,
                                               'result': {'type': 'package', 'designId': DESIGN, 'version': 5}})
        self.assertEqual(len(self.writes), 2)
        self.assertEqual(self.writes[0], self.writes[1])
        path, key, content_type, query, blob = self.writes[0]
        self.assertEqual((path, key, content_type), (ROUTE, KEY, 'application/zip'))
        self.assertEqual(query.get('sourceMode'), mode)
        for field, value in {'sourceCommit': self.commit, 'sourcePath': self.path, 'intent': 'revise',
                             'designKey': 'reports/summary', 'expectedVersion': '4', 'designId': DESIGN}.items():
            self.assertEqual(query[field], value)
        self.assertTrue(query['requestId'])
        with ZipFile(io.BytesIO(blob)) as archive:
            found = {item.filename: archive.read(item) for item in archive.infolist() if not item.is_dir()}
        self.assertEqual(found, self.files)
        self.assertTrue(any('archive' in command for command in self.git_ops))

    def test_private_directory_revision_keeps_local_bytes_and_replays_original_id(self):
        self.check_receipts('--private', '--request-id', 'private-cli-fixture', mode='private')
        self.assertEqual(self.writes[0][3]['requestId'], 'private-cli-fixture')

    def test_default_directory_revision_still_uses_the_existing_git_query(self):
        self.check_receipts(mode=None)

    def test_generated_request_id_is_stable_and_distinguishes_private_and_git_mode(self):
        self.check_receipts('--private', mode='private')
        private_id = self.writes[0][3]['requestId']
        self.writes.clear()
        self.check_receipts(mode=None)
        self.assertNotEqual(self.writes[0][3]['requestId'], private_id)

    def test_private_directory_does_not_upload_when_project_or_local_commit_does_not_match(self):
        got = self.call('--private', '--project', 'unrelated')
        self.assertNotEqual(got[0], 0)
        self.assertIn('当前绑定的 CDS 项目', got[1])
        got = self.call('--private', '--source-commit', '0' * 40)
        self.assertNotEqual(got[0], 0)
        self.assertIn('--source-commit 不符', got[1])
        (self.directory / 'dist/index.html').write_bytes(b'Uncommitted change')
        got = self.call('--private')
        self.assertNotEqual(got[0], 0)
        self.assertIn('先提交稿件目录', got[1])
        self.assertEqual(self.writes, [])

    def test_private_publication_never_packages_repository_root(self):
        (self.repo / 'design.json').write_bytes(self.files['design.json'])
        self.git('add', 'design.json')
        self.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Root manifest')
        code, output, stderr = self.call('--private', directory=self.repo)
        self.assertNotEqual(code, 0)
        self.assertIn('稿件子目录', output or stderr)
        self.assertEqual(self.writes, [])


if __name__ == '__main__':
    unittest.main()
