"""Use the real CLI parser, local Git, and a loopback publication fixture."""

import base64
import contextlib
import importlib.util
import io
import json
import os
import struct
import subprocess
import tempfile
import threading
import unittest
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlsplit
from zipfile import ZipFile

CLI = Path(__file__).resolve().parents[1] / 'cli' / 'cdscli.py'
PROJECT = 'private-design-fixture'
KEY = 'cdsp_private_fixture_only'
API = f'/api/projects/{PROJECT}/design'
ROUTE = f'{API}/packages'
DESIGN = 'DSN-fixture'
GIT_ENV = {'PATH': os.defpath, 'LANG': 'C.UTF-8', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null'}


class PrivatePublishCliTest(unittest.TestCase):
    def setUp(self):
        self.writes = []
        self.run = {'id': 'RUN-fixture', 'version': 9, 'commit': 'a' * 40, 'pullRequest': 42, 'cells': []}
        self.returned_slot = None
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def respond(self, status, data):
                response = json.dumps(data).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(response)))
                self.end_headers()
                self.wfile.write(response)

            def do_GET(self):
                if urlsplit(self.path).path != API:
                    self.respond(404, {'error': 'fixture_route_missing'})
                    return
                self.respond(200, {'projectId': PROJECT, 'permissions': {'write': True, 'visual': True},
                                   'frameworks': [], 'designs': [{'projectId': PROJECT, 'id': DESIGN,
                                   'versions': [{'version': 9, 'title': 'Fixture'}], 'runs': [fixture.run]}]})

            def do_POST(self):
                target = urlsplit(self.path)
                body = self.rfile.read(int(self.headers['Content-Length']))
                query = {key: values[0] for key, values in parse_qs(target.query).items()}
                fixture.writes.append((target.path, self.headers['X-AI-Access-Key'],
                                       self.headers['Content-Type'], query, body))
                reused = len(fixture.writes) > 1 and fixture.writes[-1] == fixture.writes[0]
                result = {'type': 'package', 'designId': DESIGN, 'version': 5}
                if target.path == f'{API}/commands':
                    payload = json.loads(body)
                    result = {**{field: payload[field] for field in ('type', 'designId', 'runId', 'screenId', 'slot')},
                              'version': fixture.run['version']}
                    if fixture.returned_slot:
                        result['slot'] = fixture.returned_slot
                    if not reused and not fixture.returned_slot:
                        key = f"{payload['screenId']}/{payload['slot']}"
                        fixture.run['visual'] = {key: {'checks': payload['checks'], 'imageId': 'art-implementation',
                                                       'referenceImageId': 'art-reference'}}
                elif target.path == f'{API}/feedback':
                    payload = json.loads(body)
                    result = {'type': payload['type'], 'designId': DESIGN, 'id': payload['feedbackId'], 'version': 8}
                self.respond(200 if reused else 201, {'projectId': PROJECT, 'reused': reused, 'result': result})

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
        return self.invoke('publish', DESIGN, '--dir', str(directory or self.directory),
                           '--intent', 'revise', '--design-key', 'reports/summary', '--expected-version', '4', *args)

    def invoke(self, *args):
        spec = importlib.util.spec_from_file_location('private_design_cli', CLI)
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
                cli.main(['design', *args])
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


    def test_visual_record_and_readback_keep_the_exact_row_and_local_images(self):
        def png(width, height):
            def chunk(kind, data):
                return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))

            header = struct.pack('>IIBBBBB', width, height, 8, 0, 0, 0, 0)
            pixels = zlib.compress(bytes((width + 1) * height))
            return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + chunk(b'IDAT', pixels) + chunk(b'IEND', b'')

        checks = {'V-02': {'status': 'failed', 'evidence': '成员标题顶边 y=212，筛选器 y=208，差 4 px。'}}
        (self.repo / 'checks.json').write_text(json.dumps(checks, ensure_ascii=False), encoding='utf-8')
        screenshot = png(1280, 800)
        for image in ('reference.png', 'implementation.png'):
            (self.repo / image).write_bytes(screenshot)
        flags = ('visual', DESIGN, '--run', self.run['id'], '--commit', self.run['commit'], '--screen', 'members',
                 '--slot', 'desktop-light', '--file', 'checks.json', '--implementation', 'implementation.png',
                 '--path', '/members/', '--reference', 'reference.png', '--request-id', 'cli-visual-fixture')

        for reused in (False, True):
            code, output, stderr = self.invoke(*flags)
            self.assertEqual(code, 0, output or stderr)
            self.assertIs(json.loads(output)['data']['reused'], reused)
        self.assertEqual(self.writes[0], self.writes[1])
        uri, key, content_type, query, body = self.writes[0]
        self.assertEqual((uri, key, content_type, query), (f'{API}/commands', KEY, 'application/json', {}))
        data_url = 'data:image/png;base64,' + base64.b64encode(screenshot).decode('ascii')
        self.assertEqual(json.loads(body), {'type': 'acceptance.visual', 'requestId': 'cli-visual-fixture',
                                          'designId': DESIGN, 'runId': self.run['id'], 'commit': self.run['commit'],
                                          'screenId': 'members', 'slot': 'desktop-light', 'checks': checks,
                                          'image': data_url, 'referenceImage': data_url,
                                          'measured': {'width': 1280, 'height': 800, 'theme': 'light', 'path': '/members/'}})
        code, output, stderr = self.invoke('result', DESIGN, '--run', self.run['id'])
        self.assertEqual(code, 0, output or stderr)
        self.assertEqual(json.loads(output)['data']['run']['visual']['members/desktop-light']['checks'], checks)
        self.returned_slot = 'desktop-dark'
        code, output, stderr = self.invoke(*flags)
        self.assertNotEqual(code, 0, output or stderr)
        self.assertIn('回执', output or stderr)

    def test_supplement_uses_the_feedback_reply_endpoint(self):
        body = '## 诉求\n\n回复入口增加补写。\n\n## 怎么算解决\n\n关闭后仍保留往来。'
        code, output, stderr = self.invoke('feedback-reply', DESIGN, '--feedback-id', 'FDB-previous',
                                           '--body', body, '--supplement', '--request-id', 'cli-supplement-fixture')
        self.assertEqual(code, 0, output or stderr)
        self.assertEqual(len(self.writes), 1)
        route, key, content_type, _, payload = self.writes[0]
        self.assertEqual((route, key, content_type), (f'{API}/feedback', KEY, 'application/json'))
        self.assertEqual(json.loads(payload), {'type': 'feedback.reply', 'requestId': 'cli-supplement-fixture',
                                             'designId': DESIGN, 'feedbackId': 'FDB-previous', 'body': body, 'supplement': True})


if __name__ == '__main__':
    unittest.main()
