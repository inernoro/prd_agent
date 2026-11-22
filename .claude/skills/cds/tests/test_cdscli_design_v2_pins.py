"""Compact CLI contract regression. Uses only local fixtures and the standard library."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

CLI = Path(__file__).resolve().parents[1] / 'cli' / 'cdscli.py'
BASE = '/api/projects/fixture/design'
OLD = {'rules': '## R-01 固定版本\n', 'tokens': {'palette': '旧颜色'}, 'components': '旧卡片',
       'skeleton': '<!doctype html><h1>{{title}}</h1>'}
LATEST = {'rules': '## R-02 最新规则', 'tokens': {'palette': '新颜色'}}
FRAMEWORK = {'id': 'FW-fixture', 'projectId': 'fixture', 'versions': [
    {'version': 1, 'material': OLD, 'charter': {'status': 'adopted'}},
    {'version': 2, 'material': LATEST},
]}
DRAFT = {'id': 'DSN-fixture', 'projectId': 'fixture', 'frozen': 1, 'versions': [
    {'version': 1, 'spec': {'rules': '## R-03 第一版候选'}},
    {'version': 2, 'spec': {'rules': '## R-04 第二版候选'}},
]}


class CliFlags(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(
            prefix='design-intake-cli-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        previous = Path.cwd()
        self.addCleanup(os.chdir, previous)
        os.chdir(self.root)
        subprocess.run(['git', 'init', '-q'], check=True)
        credentials = {
            'PATH': os.environ['PATH'],
            'CDS_HOST': 'http://127.0.0.1:1',
            'CDS_PROJECT_ID': 'fixture',
            'CDS_PROJECT_KEY': 'cdsp_fixture_scope',
        }
        environment = patch.dict(os.environ, credentials, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        spec = importlib.util.spec_from_file_location('cds_test_fixture', CLI)
        self.cli = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.cli)
        self.draft = json.loads(json.dumps(DRAFT))
        self.writes = []

        def api(method, path, body=None, **kwargs):
            if method == 'GET':
                self.assertEqual(path, BASE)
                return 200, {'projectId': 'fixture', 'frameworks': [FRAMEWORK], 'designs': [self.draft]}, {}
            self.writes.append((path, body))
            return 201, {'projectId': 'fixture', 'reused': False, 'result': {
                'type': 'framework.extract', 'frameworkId': 'FW-fixture', 'version': 3}}, {}
        request = patch.object(self.cli, '_request', api)
        login = patch.object(self.cli, '_human_session_headers', return_value={
                             'Cookie': 'fixture-synthetic'})
        for mock in (request, login):
            mock.start()
            self.addCleanup(mock.stop)

    def command(self, *args):
        emitted = io.StringIO()
        with contextlib.redirect_stdout(emitted):
            with self.assertRaises(SystemExit) as ending:
                self.cli.main(list(args))
        return ending.exception.code, json.loads(emitted.getvalue())

    def test_scaffold_old_material_is_utf8_under_a_non_utf8_default(self):
        def non_utf8_default(path, data, encoding=None, errors=None, newline=None):
            return path.write_bytes(data.encode(encoding or 'cp1252', errors or 'strict'))
        with patch.object(Path, 'write_text', non_utf8_default):
            status, body = self.command('design', 'scaffold', '--framework', 'FW-fixture', '--framework-version', '1',
                                        '--dir', 'draft', '--title', '旧版 & 页面')
        self.assertEqual(status, 0, body)
        self.assertEqual(body['data']['version'], 1)
        manifest = json.loads((self.root/'draft/design.json').read_bytes())
        self.assertEqual(manifest['frameworkVersion'], 1)
        self.assertEqual([rule['id']
                         for rule in manifest['acceptance']], ['R-01'])
        self.assertEqual(
            (self.root/'draft/spec/rules.md').read_bytes(), OLD['rules'].encode('utf-8'))
        self.assertEqual((self.root/'draft/spec/components.md').read_bytes(),
                         OLD['components'].encode('utf-8'))
        self.assertEqual((self.root/'draft/dist/index.html').read_bytes(),
                         b'<!doctype html><h1>' + '旧版 &amp; 页面'.encode('utf-8')+b'</h1>')

    def test_extract_previews_both_versions_and_transmits_explicit_choice(self):
        args = ('design', 'extract', 'DSN-fixture', '--into', 'FW-fixture')
        status, result = self.command(*args)
        self.assertEqual(status, 0)
        preview = result['data']
        self.assertEqual(
            (preview['sourceVersion'], preview['expectedVersion']), (1, 2))
        self.assertEqual(preview['conflicts'], ['rules'])
        self.assertFalse(self.writes)
        for flags in (('--expected-version', '2'), ('--resolve', 'rules=adopt'),
                      ('--version', '1', '--resolve', 'rules=adopt')):
            status, result = self.command(
                *args, '--apply', 'rules', '--as-user', 'fixture', *flags)
            self.assertNotEqual(status, 0)
            self.assertIn('--version', result['error'])
            self.assertIn('--expected-version', result['error'])
            self.assertFalse(self.writes)
        maybe_invalid = ('--expected-version', '2', '--apply', 'rules',
                         '--resolve', 'rules=adopt', '--as-user', 'fixture')
        status, result = self.command(*args, '--version', '0', *maybe_invalid)
        self.assertNotEqual(status, 0)
        self.assertIn('定稿版本', result['error'])
        self.assertFalse(self.writes)
        apply = ('--version', '1', *maybe_invalid)
        self.draft['frozen'] = 2
        status, result = self.command(*args, *apply)
        self.assertNotEqual(status, 0)
        self.assertIn('定稿版本', result['error'])
        self.assertFalse(self.writes)
        self.draft['frozen'] = 1
        status, result = self.command(*args, *apply)
        self.assertEqual(status, 0, result)
        path, command = self.writes[0]
        self.assertEqual(path, BASE+'/commands')
        self.assertEqual(
            (command['version'], command['expectedVersion']), (1, 2))
        self.assertEqual(command['resolutions'], {'rules': 'adopt'})


if __name__ == '__main__':
    unittest.main()
