"""Read-only version comparisons and explicit baseline changes."""
import argparse
import contextlib
import importlib.util
import io
import json
import os
from hashlib import sha256
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
import tempfile
import unittest
from unittest.mock import patch


CLI = Path(__file__).resolve().parents[1] / 'cli' / 'cdscli.py'
BASE = '/api/projects/fixture/design'
DESIGN_ID = 'DSN-fixture'


class DesignVersionCli(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('cds_version_fixture', CLI)
        self.cli = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.cli)
        self.test_tmp = os.environ.get('TMPDIR')
        env = patch.dict(os.environ, {'CDS_PROJECT_ID': 'fixture', 'CDS_PROJECT_KEY': 'cdsp_fixture_scope'}, clear=True)
        env.start()
        self.addCleanup(env.stop)
        self.calls = []
        self.can_record = True
        changes = {'added': [], 'removed': [], 'changed': []}
        self.diff = {'projectId': 'fixture', 'designId': DESIGN_ID, 'fromVersion': 11, 'toVersion': 17,
                     'acceptance': {**changes, 'added': [{'id': 'A-64'}]}, 'screens': changes, 'files': changes}

        def api(method, path, body=None, **kwargs):
            self.calls.append((method, path, body))
            if method == 'GET' and path.startswith(BASE + '/diff?'):
                return 200, self.diff, {}
            if method == 'POST' and path.startswith(BASE + '/packages?'):
                return 400, {'error': 'G-07', 'message': '不应回显的原附件上下文'}, {}
            if method == 'GET' and path == BASE:
                return 200, {'projectId': 'fixture', 'permissions': {'visual': self.can_record}, 'frameworks': [], 'designs': [
                    {'id': DESIGN_ID, 'projectId': 'fixture', 'frozen': 17, 'pullRequest': 42, 'versions': [{'version': 11}, {'version': 17}]}]}, {}
            receipt = {'type': body['type'], 'designId': DESIGN_ID, 'version': body.get('version', 17)}
            if body['type'].startswith('implementation.'):
                receipt['upgradeId'] = 'UP-fixture'
            if body['type'] == 'acceptance.start':
                receipt['runId'] = 'RUN-fixture'
            if body.get('runId'):
                receipt['runId'] = body['runId']
            receipt.update(id=body.get('dimension') or body.get('issueId') or 'K-fixture')
            return 201, {'projectId': 'fixture', 'reused': False, 'result': receipt}, {}

        for replacement in (patch.object(self.cli, '_request', api),
                            patch.object(self.cli, '_human_session_headers', return_value={'Cookie': 'fixture-synthetic'})):
            replacement.start()
            self.addCleanup(replacement.stop)

    def command(self, *args):
        parser = argparse.ArgumentParser()
        self.cli._register_design_parser(parser.add_subparsers(dest='cmd', required=True))
        parsed = parser.parse_args(['design', *args])
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            with self.assertRaises(SystemExit) as ending:
                self.cli.cmd_design_workspace(parsed)
        return ending.exception.code, json.loads(output.getvalue())

    def test_named_versions_use_single_server_side_diff(self):
        status, payload = self.command('diff', DESIGN_ID, '--from', '11', '--to', '17')
        self.assertEqual(status, 0, payload)
        self.assertEqual(payload['data'], self.diff)
        self.assertEqual(self.calls, [('GET', BASE + '/diff?designId=DSN-fixture&from=11&to=17', None)])

    def test_freeze_uses_bound_project_without_member_login(self):
        status, payload = self.command('freeze', DESIGN_ID, '17', '--expected-baseline', '0', '--request-id', 'fixture-freeze')
        self.assertEqual(status, 0, payload)
        self.assertEqual(self.calls, [('POST', BASE + '/commands', {'type': 'design.freeze', 'designId': DESIGN_ID,
                         'version': 17, 'expectedBaseline': None, 'requestId': 'fixture-freeze'})])

    def test_diff_receipt_must_match_both_requested_versions_and_draft(self):
        for field, wrong in (('designId', 'DSN-other'), ('fromVersion', 12), ('toVersion', 18), ('projectId', 'other'), ('files', {})):
            with self.subTest(field=field), patch.dict(self.diff, {field: wrong}):
                status, payload = self.command('diff', DESIGN_ID, '--from', '11', '--to', '17')
                self.assertNotEqual(status, 0, payload)
                self.assertIn('CDS', payload['error'])

    def test_diff_rejects_mixed_or_incomplete_version_pair_without_request(self):
        for invalid in (('--from', '11'), ('--from', '0', '--to', '17'), ('11', '17', '--from', '12', '--to', '16')):
            with self.subTest(invalid=invalid):
                status, payload = self.command('diff', DESIGN_ID, *invalid)
                self.assertNotEqual(status, 0, payload)
                self.assertIn('版本', payload['error'])
        self.assertEqual(self.calls, [])

    def test_delivery_pins_the_requested_version_and_checks_every_file_receipt(self):
        filename = '交接清单.md'
        chunks = {0: '前𠀀', 3: '后\n'}
        content = ''.join(chunks.values())
        digest = sha256(content.encode()).hexdigest()
        selected = {'id': 'archived-v11', 'path': filename, 'kind': 'document',
                    'text': True, 'sha256': digest, 'size': len(content.encode())}
        later = {**selected, 'id': 'archived-v17', 'path': '新版说明.md'}
        revisions = [{'version': 11, 'sourceCommit': 'a' * 40, 'delivery': {'files': [selected]}},
                     {'version': 17, 'sourceCommit': 'b' * 40, 'delivery': {'files': [later]}}]
        offsets = []
        requested_versions = []
        receipt_id = selected['id']

        def read(method, endpoint, _body=None, **_kwargs):
            self.assertEqual(method, 'GET')
            target = urlsplit(endpoint)
            arguments = parse_qs(target.query)
            if target.path == BASE:
                self.assertEqual(arguments['designId'], [DESIGN_ID])
                requested_versions.append(arguments['version'][0])
                return 200, {'projectId': 'fixture', 'designs': [
                    {'id': DESIGN_ID, 'projectId': 'fixture', 'versions': revisions}]}, {}
            self.assertEqual(target.path, BASE + '/artifacts/' + selected['id'])
            self.assertEqual(arguments['view'], ['text'])
            offset = int(arguments.get('offset', ['0'])[0])
            offsets.append(offset)
            return 200, {'path': filename, 'artifactId': receipt_id, 'sha256': digest,
                         'offset': offset, 'nextOffset': 3 if offset == 0 else None, 'text': chunks[offset]}, {}

        with patch.object(self.cli, '_request', read):
            args = ('delivery', DESIGN_ID, '--version', '11')
            status, payload = self.command(*args)
            self.assertEqual(status, 0, payload)
            self.assertEqual(payload['data']['version'], 11)
            self.assertEqual(payload['data']['delivery']['files'], [selected])
            status, payload = self.command(*args, '--file', filename)
            self.assertEqual(status, 0, payload)
            self.assertEqual(payload['data']['path'], filename)
            self.assertEqual(payload['data']['text'], content)
            self.assertEqual(offsets, [0, 3])

            self.assertNotEqual(self.command('delivery', DESIGN_ID, '--version', '12')[0], 0)
            self.assertNotEqual(self.command(*args, '--file', later['path'])[0], 0)
            self.assertEqual(offsets, [0, 3])
            receipt_id = later['id']
            self.assertNotEqual(self.command(*args, '--file', filename)[0], 0)
            self.assertEqual(requested_versions, ['11', '11', '12', '11', '11'])

    def test_freeze_passes_reason_and_expected_baseline_with_member_session(self):
        status, payload = self.command('freeze', DESIGN_ID, '11', '--reason', '复验旧版', '--expected-baseline', '17',
                                       '--as-user', 'fixture', '--request-id', 'freeze-fixture')
        self.assertEqual(status, 0, payload)
        self.assertEqual(self.calls[-1], ('POST', BASE + '/commands', {'type': 'design.freeze', 'designId': DESIGN_ID,
                          'version': 11, 'reason': '复验旧版', 'expectedBaseline': 17, 'requestId': 'freeze-fixture'}))

    def test_freeze_relays_member_requirement_from_server(self):
        with patch.object(self.cli, '_request', return_value=(403, {'message': '此操作需要项目成员确认'}, {})) as request:
            status, payload = self.command('freeze', DESIGN_ID, '11', '--reason', '复验旧版')
        self.assertNotEqual(status, 0, payload)
        self.assertIn('成员', payload['error'])
        self.assertEqual(request.call_args.args[:2], ('POST', BASE + '/commands'))

    def test_withdraw_baseline_and_bind_screens_use_the_same_project_binding(self):
        status, payload = self.command('unfreeze', DESIGN_ID, '17', '--request-id', 'unfreeze-fixture')
        self.assertEqual(status, 0, payload)
        self.assertEqual(self.calls[-1], ('POST', BASE + '/commands', {
            'type': 'design.unfreeze', 'designId': DESIGN_ID, 'version': 17, 'requestId': 'unfreeze-fixture'}))
        screens = [{'screenId': 'fixture', 'path': '/fixture', 'readySelector': 'main'}]
        with tempfile.TemporaryDirectory(dir=self.test_tmp) as directory:
            file = Path(directory) / 'bindings.json'
            file.write_text(json.dumps(screens), encoding='utf-8')
            status, payload = self.command('bind', DESIGN_ID, '--version', '17', '--file', str(file), '--request-id', 'bind-fixture')
        self.assertEqual(status, 0, payload)
        self.assertEqual(self.calls[-1], ('POST', BASE + '/commands', {
            'type': 'implementation.bind', 'designId': DESIGN_ID, 'version': 17, 'screens': screens, 'requestId': 'bind-fixture'}))

    def test_start_upgrade_fixes_a_selected_target_and_supports_a_missing_baseline(self):
        status, payload = self.command('start-upgrade', DESIGN_ID, '--version', '17', '--expected-baseline', '0',
                                       '--as-user', 'fixture', '--request-id', 'start-fixture')
        self.assertEqual(status, 0, payload)
        self.assertEqual(self.calls[-1], ('POST', BASE + '/commands', {'type': 'implementation.start', 'designId': DESIGN_ID,
                          'version': 17, 'expectedBaseline': None, 'requestId': 'start-fixture'}))
        status, payload = self.command('start-upgrade', DESIGN_ID, '--as-user', 'fixture', '--request-id', 'lock-latest')
        self.assertEqual(status, 0, payload)
        self.assertEqual(self.calls[-1], ('POST', BASE + '/commands', {'type': 'implementation.start', 'designId': DESIGN_ID,
                          'requestId': 'lock-latest'}))

    def test_cancel_upgrade_targets_current_lock_with_reason(self):
        status, payload = self.command('cancel-upgrade', DESIGN_ID, '--upgrade', 'UP-fixture', '--reason', '改排期',
                                       '--as-user', 'fixture', '--request-id', 'cancel-fixture')
        self.assertEqual(status, 0, payload)
        self.assertEqual(self.calls[-1], ('POST', BASE + '/commands', {'type': 'implementation.cancel', 'designId': DESIGN_ID,
                          'upgradeId': 'UP-fixture', 'reason': '改排期', 'requestId': 'cancel-fixture'}))

    def test_publish_returns_the_gate_number_without_echoing_server_content(self):
        with tempfile.TemporaryDirectory(dir=self.test_tmp) as directory:
            archive = Path(directory) / 'gate.zip'
            archive.write_bytes(b'fixture')
            status, payload = self.command('publish', DESIGN_ID, '--zip', str(archive), '--source-commit', 'a' * 40,
                                           '--intent', 'revise', '--expected-version', '17')
        self.assertEqual(status, 2, payload)
        self.assertEqual(payload['gate'], 'G-07')
        self.assertIn('G-07', payload['error'])
        self.assertNotIn('原附件上下文', payload['error'])

    def test_accept_installed_locks_current_build_without_falling_back_to_pr_capture(self):
        commit = '1' * 40
        status, payload = self.command('accept', DESIGN_ID, '--installed', '--commit', commit, '--request-id', 'installed-fixture')
        self.assertEqual(status, 0, payload)
        self.assertEqual(payload['data']['result']['runId'], 'RUN-fixture')
        self.assertEqual(self.calls, [('GET', BASE, None), ('POST', BASE + '/commands', {
            'type': 'acceptance.start', 'designId': DESIGN_ID, 'version': 17, 'target': 'installed',
            'commit': commit, 'requestId': 'installed-fixture',
        })])

    def test_accept_installed_and_pull_request_are_mutually_exclusive(self):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), self.assertRaisesRegex(SystemExit, '^2$'):
            self.command('accept', DESIGN_ID, '--installed', '--pr', '42')
        self.assertIn('not allowed with argument', stderr.getvalue())
        self.assertEqual(self.calls, [])

    def test_v17_json_evidence_preserves_current_run_and_uses_project_write_access(self):
        commit = 'a' * 40
        records = {
            'coverage': {'dimension': 'compatibility', 'risk': '横向溢出', 'ruleIds': ['A-13']},
            'regress': {'issueId': 'K-fixture', 'status': 'passed', 'evidence': '视口和内容宽度均为 853px'},
            'known-create': {'problem': '旧滚动问题', 'how': 'measure', 'check': '测量宽度',
                             'sources': [{'kind': 'feedback', 'ref': 'FDB-fixture', 'count': 2}], 'screenIds': ['screen']},
        }
        with tempfile.TemporaryDirectory(dir=self.test_tmp) as directory:
            filename = Path(directory) / 'evidence.json'
            for action, record in records.items():
                filename.write_text(json.dumps(record), encoding='utf-8')
                flags = ('--run', 'RUN-fixture', '--commit', commit) if action != 'known-create' else ()
                kind = f'acceptance.{action}' if flags else 'known.create'
                expected_run = {'runId': 'RUN-fixture', 'commit': commit} if flags else {}
                args = (action, DESIGN_ID, '--file', str(filename), '--request-id', action, *flags)
                status, payload = self.command(*args)
                self.assertEqual(status, 0, payload)
                self.assertEqual(self.calls[-1], ('POST', BASE + '/commands', {'type': kind, 'designId': DESIGN_ID,
                                  'requestId': action, **expected_run, **record}))
            filename.write_text(json.dumps({**records['regress'], 'runId': 'RUN-other'}), encoding='utf-8')
            writes = len([call for call in self.calls if call[0] == 'POST'])
            status, _ = self.command('regress', DESIGN_ID, '--file', str(filename), '--run', 'RUN-fixture', '--commit', commit)
            self.assertNotEqual(status, 0)
            self.can_record = False
            status, _ = self.command('known-create', DESIGN_ID, '--file', str(filename))
            self.assertNotEqual(status, 0)
            self.assertEqual(len([call for call in self.calls if call[0] == 'POST']), writes)


if __name__ == '__main__':
    unittest.main()
