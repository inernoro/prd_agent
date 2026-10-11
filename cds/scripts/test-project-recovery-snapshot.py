import copy
import importlib.util
import json
import io
import os
from pathlib import Path
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
import unittest
from unittest.mock import patch
import contextlib

spec = importlib.util.spec_from_file_location('snapshot', Path(__file__).with_name('project-recovery-snapshot.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def fixture():
    return {
        '/api/projects/p': {'id': 'p', 'defaultDeployModes': {'api': 'express'}, 'githubAutoDeploy': False, 'defaultEnv': {'SECRET': 'PRIVATE_SENTINEL'}},
        '/api/build-profiles?project=p': {'profiles': [{'id': 'api', 'projectId': 'p', 'dockerImage': 'r/api:sha-${CDS_COMMIT_SHA}', 'containerPort': 8080, 'activeDeployMode': '', 'resources': {'cpus': 1.5}, 'env': {'TOKEN': 'PRIVATE_SENTINEL'}, 'command': 'PRIVATE_SENTINEL', 'deployModes': {'express': {'prebuilt': True, 'dockerImage': 'r/api:sha-${CDS_COMMIT_SHA}', 'env': {'TOKEN': 'PRIVATE_SENTINEL'}}}}]},
        '/api/routing-rules?project=p': {'rules': [{'id': 'r', 'projectId': 'p', 'type': 'domain', 'match': 'preview.example', 'branch': 'main', 'priority': 0, 'enabled': True, 'private': 'PRIVATE_SENTINEL'}]},
        '/api/branches?project=p': {'branches': [{'id': 'b', 'projectId': 'p'}]},
        '/api/branches/b': {'branch': {'id': 'b', 'projectId': 'p', 'branch': 'main', 'status': 'running', 'profileOverrides': {'api': {'activeDeployMode': None, 'env': {'TOKEN': 'PRIVATE_SENTINEL'}}}, 'services': {'api': {'profileId': 'api', 'status': 'running', 'hostPort': 8000, 'containerName': 'c', 'deployedImage': 'sha256:'+'a'*64, 'buildLog': 'PRIVATE_SENTINEL'}}, 'customEnv': {'TOKEN': 'PRIVATE_SENTINEL'}, 'extraProfiles': []}},
        **{'/api/deployment-runs?project=p&status='+s+'&limit=200': {'runs': []} for s in m.RUN_STATUSES},
    }


class SnapshotTest(unittest.TestCase):
    def collect(self, data):
        paths = []
        def get(path):
            paths.append(path)
            return copy.deepcopy(data[path])
        result = m.collect('p', get)
        self.assertTrue(all(path.startswith('/api/') for path in paths))
        return result

    def test_stable_readonly_observation_preserves_explicit_defaults(self):
        x = self.collect(fixture())
        self.assertEqual(x['status'], 'observed-stable')
        self.assertFalse(x['frames'][0]['project']['githubAutoDeploy'])
        self.assertEqual(x['frames'][0]['profiles'][0]['activeDeployMode'], '')
        self.assertIsNone(x['frames'][0]['branches'][0]['profileOverrides']['api']['activeDeployMode'])

    def test_no_private_fields_or_intent_fills_unknown_runtime(self):
        x = self.collect(fixture())
        self.assertNotIn('PRIVATE_SENTINEL', json.dumps(x))
        service = x['frames'][0]['branches'][0]['services']['api']
        self.assertNotIn('deployedPrebuilt', service)
        self.assertNotIn('deployedCommitSha', service)
        self.assertNotIn('containerId', service)

    def test_optional_absent_is_different_from_null_and_empty(self):
        data = fixture(); del data['/api/branches/b']['branch']['profileOverrides']['api']['activeDeployMode']
        x = self.collect(data)
        self.assertNotIn('activeDeployMode', x['frames'][0]['branches'][0]['profileOverrides']['api'])

    def test_actual_api_materialized_optional_nulls_are_preserved(self):
        data = fixture(); p = data['/api/build-profiles?project=p']['profiles'][0]
        p.update({'resources': None, 'dependsOn': None, 'pathPrefixes': None})
        data['/api/branches/b']['branch']['extraProfiles'] = None
        x = self.collect(data)
        self.assertEqual(x['status'], 'observed-stable')
        self.assertIsNone(x['frames'][0]['profiles'][0]['resources'])
        self.assertIsNone(x['frames'][0]['profiles'][0]['dependsOn'])
        self.assertIsNone(x['frames'][0]['branches'][0]['extraProfiles'])

    def test_credential_urls_in_image_or_routing_are_not_saved(self):
        for source, collection, field, value in [('/api/build-profiles?project=p', 'profiles', 'dockerImage', 'https://PRIVATE_SENTINEL@r/image'), ('/api/routing-rules?project=p', 'rules', 'match', '/api?token=PRIVATE_SENTINEL')]:
            data = fixture(); data[source][collection][0][field] = value
            x = self.collect(data)
            self.assertEqual(x['status'], 'incomplete'); self.assertNotIn('PRIVATE_SENTINEL', json.dumps(x))

    def test_second_round_drift_cannot_be_stable(self):
        data = fixture(); count = 0
        def get(path):
            nonlocal count
            if path == '/api/projects/p': count += 1
            x = copy.deepcopy(data[path])
            if path == '/api/projects/p' and count == 2: x['githubAutoDeploy'] = True
            return x
        self.assertEqual(m.collect('p', get)['status'], 'drifted')

    def test_foreign_project_rejected_not_silently_filtered(self):
        for source, key in [('/api/build-profiles?project=p', 'profiles'), ('/api/routing-rules?project=p', 'rules'), ('/api/branches?project=p', 'branches')]:
            data = fixture(); data[source][key].append({'id': 'foreign', 'projectId': 'q', 'secret': 'PRIVATE_SENTINEL'})
            x = self.collect(data)
            self.assertEqual(x['status'], 'incomplete'); self.assertNotIn('PRIVATE_SENTINEL', json.dumps(x))

    def test_duplicate_identity_incomplete(self):
        data = fixture(); data['/api/build-profiles?project=p']['profiles'] *= 2
        self.assertEqual(self.collect(data)['status'], 'incomplete')

    def test_provider_explicit_truncation_is_not_stable(self):
        for field, value in [('truncated', True), ('hasMore', True), ('nextCursor', 'next'), ('pagination', {'page': 1}), ('total', 5)]:
            data = fixture(); data['/api/build-profiles?project=p'][field] = value
            self.assertEqual(self.collect(data)['status'], 'incomplete')

    def test_missing_services_is_unknown_not_empty(self):
        data = fixture(); del data['/api/branches/b']['branch']['services']
        self.assertEqual(self.collect(data)['status'], 'incomplete')

    def test_scope_change_between_list_and_detail(self):
        data = fixture(); data['/api/branches/b']['branch']['projectId'] = 'q'
        self.assertEqual(self.collect(data)['status'], 'incomplete')

    def test_resource_boolean_and_nonfinite_are_invalid(self):
        for value in [True, float('nan'), -1, '1.5']:
            data = fixture(); data['/api/build-profiles?project=p']['profiles'][0]['resources']['cpus'] = value
            self.assertEqual(self.collect(data)['status'], 'incomplete')

    def test_run_scope_status_identity_checked(self):
        path = '/api/deployment-runs?project=p&status=queued&limit=200'
        run = {'id': 'dr_a', 'projectId': 'p', 'branchId': 'b', 'status': 'queued', 'operationId': 'op_a', 'events': [{'secret': 'PRIVATE_SENTINEL'}]}
        data = fixture(); data[path]['runs'] = [run]
        self.assertEqual(self.collect(data)['status'], 'observed-stable')
        for field, value in [('projectId', 'q'), ('status', 'running'), ('branchId', 'absent')]:
            bad = copy.deepcopy(data); bad[path]['runs'][0][field] = value
            self.assertEqual(self.collect(bad)['status'], 'incomplete')

    def test_run_cap_is_truncated_even_unique_and_valid(self):
        data = fixture(); data['/api/deployment-runs?project=p&status=queued&limit=200']['runs'] = [{'id': str(i), 'projectId': 'p', 'branchId': 'b', 'status': 'queued'} for i in range(200)]
        self.assertEqual(self.collect(data)['status'], 'incomplete')

    def test_failed_unreleased_candidate_is_still_a_reservation(self):
        data = fixture(); data['/api/deployment-runs?project=p&status=failed&limit=200']['runs'] = [{'id': 'failed', 'projectId': 'p', 'branchId': 'b', 'status': 'failed', 'candidate': {'phase': 'reconciling', 'operationId': 'op_a', 'serving': {'api': {'profileId': 'api', 'status': 'running', 'deployedImage': 'old'}}, 'services': {}, 'secret': 'PRIVATE_SENTINEL'}}]
        x = self.collect(data)
        self.assertEqual(x['status'], 'observed-stable')
        self.assertEqual(x['frames'][0]['terminalReservations'][0]['candidate']['phase'], 'reconciling')
        self.assertNotIn('PRIVATE_SENTINEL', json.dumps(x))

    def test_branch_read_fanout_is_bounded_before_detail_reads(self):
        data = fixture(); data['/api/branches?project=p']['branches'] = [{'id': 'b'+str(i), 'projectId': 'p'} for i in range(20)]
        self.assertEqual(self.collect(data)['status'], 'incomplete')

    def test_error_body_not_persisted(self):
        def get(_): raise RuntimeError('PRIVATE_SENTINEL')
        x = m.collect('p', get)
        self.assertEqual(x['status'], 'incomplete'); self.assertNotIn('PRIVATE_SENTINEL', json.dumps(x))

    def test_file_exclusive_private_and_roundtrip(self):
        with tempfile.TemporaryDirectory() as root:
            p = Path(root)/'snap.json'; x = self.collect(fixture()); m.save_new(p, x)
            self.assertEqual(os.stat(p).st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(p.read_text()), x)
            with self.assertRaises(FileExistsError): m.save_new(p, {'changed': True})
            self.assertEqual(json.loads(p.read_text()), x)

    def test_output_symlink_never_overwrites_target(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root)/'target'; target.write_text('owned-original'); p = Path(root)/'snap'; p.symlink_to(target)
            with self.assertRaises(OSError): m.save_new(p, {})
            self.assertEqual(target.read_text(), 'owned-original')

    def test_output_parent_links_cannot_place_observation_in_git(self):
        with tempfile.TemporaryDirectory() as root:
            repo = Path(root)/'repo'; repo.mkdir(); (repo/'.git').mkdir(); link = Path(root)/'link'; link.symlink_to(repo)
            with self.assertRaises(ValueError): m.external_output(link/'snapshot.json')

    def test_actual_http_get_no_redirect_body_cap_and_error_sanitization(self):
        received = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_GET(self):
                received.append((self.command, self.path))
                if self.path == '/api/redirect':
                    self.send_response(302); self.send_header('Location', '/api/private'); self.end_headers(); return
                status = 503 if self.path == '/api/error' else 200
                body = b'x'*(m.MAX_BODY+1) if self.path == '/api/large' else b'{"private":"PRIVATE_SENTINEL"}' if status == 503 else b'{"id":"p"}'
                self.send_response(status); self.send_header('Content-Length', str(len(body))); self.end_headers()
                try: self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError): pass
        server = HTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            get = m.getter('http://127.0.0.1:'+str(server.server_port), {})
            self.assertEqual(get('/api/project'), {'id': 'p'})
            for route in ['/api/redirect', '/api/large', '/api/error']:
                with self.assertRaises(Exception): get(route)
            self.assertNotIn(('GET', '/api/private'), received)
            self.assertTrue(all(method == 'GET' for method, _ in received))
            x = m.collect('p', lambda _: get('/api/error'))
            self.assertEqual(x['status'], 'incomplete'); self.assertNotIn('PRIVATE_SENTINEL', json.dumps(x))
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_actual_cli_credentials_and_exclusive_output(self):
        data = fixture(); received = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_GET(self):
                received.append((self.command, self.path, self.headers.get('X-AI-Access-Key')))
                body = json.dumps(data[self.path]).encode()
                self.send_response(200); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
        server = HTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        previous = os.getcwd()
        try:
            with tempfile.TemporaryDirectory() as root:
                os.chdir(root); output = Path(root)/'snapshot.json'; std = io.StringIO()
                argv = ['snapshot', '--project', 'p', '--output', str(output)]
                env = {'CDS_HOST': 'http://127.0.0.1:'+str(server.server_port), 'CDS_PROJECT_KEY': 'cdsp_PRIVATE_SENTINEL', 'CDS_PROJECT_ID': 'p'}
                with patch.dict(os.environ, env, clear=True), patch('sys.argv', argv), contextlib.redirect_stdout(std):
                    self.assertEqual(m.main(), 0)
                self.assertNotIn('PRIVATE_SENTINEL', output.read_text()+std.getvalue())
                self.assertEqual(len(received), 2*(4+1+len(m.RUN_STATUSES)))
                self.assertTrue(all(method == 'GET' and key == 'cdsp_PRIVATE_SENTINEL' for method, _, key in received))
                self.assertFalse(any('live=' in path for _, path, _ in received))
        finally:
            os.chdir(previous); server.shutdown(); server.server_close(); thread.join()

    def test_trickle_response_and_total_deadline_are_bounded(self):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_GET(self):
                self.send_response(200); self.send_header('Content-Length', '100'); self.end_headers()
                try:
                    for _ in range(30): self.wfile.write(b'x'); self.wfile.flush(); time.sleep(.02)
                except (BrokenPipeError, ConnectionResetError): pass
        server = HTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            get = m.getter('http://127.0.0.1:'+str(server.server_port), {}, request_timeout=.08, total_timeout=.12)
            start = time.monotonic()
            with self.assertRaises(TimeoutError): get('/api/trickle')
            self.assertLess(time.monotonic()-start, .3)
            time.sleep(.13)
            start = time.monotonic()
            with self.assertRaises(TimeoutError): get('/api/trickle')
            self.assertLess(time.monotonic()-start, .03)
        finally:
            server.shutdown(); server.server_close(); thread.join()


if __name__ == '__main__': unittest.main()
