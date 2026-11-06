"""负载提示保持原命令语义，备用密钥只在明确选择后使用。"""
import json
import os
from pathlib import Path
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from test_cdscli_instances import cli, workspace, save, run  # noqa: F401


@pytest.mark.parametrize('status,body,state', [
    (200, {'cpu': {'cores': 4, 'loadAvg1': 3.16, 'loadPercent': 79}}, 'normal'),
    (200, {'cpu': {'cores': 4, 'loadAvg1': 3.2, 'loadPercent': 80}}, 'high'),
    (200, {'cpu': {'cores': 4, 'loadAvg1': 4, 'loadPercent': 100}}, 'high'),
    (200, {'cpu': {'cores': 4, 'loadAvg1': 0, 'loadPercent': True}}, 'unknown'),
    (200, {'cpu': {'cores': 4, 'loadAvg1': 4, 'loadPercent': float('nan')}}, 'unknown'),
    (200, {'cpu': {'cores': 4, 'loadAvg1': 4, 'loadPercent': float('inf')}}, 'unknown'),
    (200, {'cpu': {'cores': 0, 'loadAvg1': 4, 'loadPercent': 100}}, 'unknown'),
    (200, {'cpu': None, 'mem': {'usedPercent': 100}}, 'unknown'),
    (200, 'bad-json secret-do-not-save', 'unknown'),
    (401, {'error': 'unauthorized', 'message': 'secret-do-not-save'}, 'unknown'),
    (429, {'error': 'rate_limited'}, 'unknown'),
    (503, {'error': 'self_update_draining'}, 'unknown'),
    (0, {'error': 'timeout'}, 'unknown'),
])
def test_load_states_and_sanitized_audit(workspace, monkeypatch, capsys, status, body, state):
    root, _ = workspace
    save('https://primary.example', 'a', 'primary-secret')
    calls = []
    def request(method, path, **kwargs):
        calls.append((method, path, kwargs))
        return status, body, {}
    monkeypatch.setattr(cli, '_request', request)
    code, output = run('instance', 'recommend')
    result = json.loads(output)
    assert code == 0 and result['data']['state'] == state
    assert result['data']['switched'] is False
    assert result['data']['alternativeHealthChecked'] is False
    assert result['data']['alternatives'][0]['authorization'] == 'required'
    assert calls == [('GET', '/api/host-stats', {'timeout': 3, 'fatal_network_errors': False, 'follow_redirects': False})]
    assert ('notices' in result) == (state == 'high')
    stderr = capsys.readouterr().err
    assert ('不同站点使用不同密钥' in stderr) == (state == 'high')
    evidence = list((root / '.cds/instance-load-checks').glob('*.json'))
    assert len(evidence) == 1
    text = evidence[0].read_text()
    assert 'secret' not in text + output + stderr
    audit = json.loads(text)
    assert audit['state'] == state and audit['responseReceived'] == (status != 0)
    assert len(audit['responseSha256']) == 64
    assert evidence[0].stat().st_mode & 0o777 == 0o600
    assert '/.cds/instance-load-checks/' in (root / '.git/info/exclude').read_text()
    assert not (root / '.cds/active-instance.json').exists()


def test_auto_high_load_keeps_single_original_write_and_error(workspace, monkeypatch):
    save('https://primary.example', 'a', 'primary-secret')
    calls = []
    def request(method, path, **kwargs):
        calls.append((os.environ['CDS_HOST'], method, path))
        if path == '/api/host-stats':
            return 200, {'cpu': {'cores': 1, 'loadAvg1': 2, 'loadPercent': 200}}, {}
        return 503, {'error': 'self_update_draining'}, {}
    monkeypatch.setattr(cli, '_request', request)
    code, output = run('branch', 'create', '--branch', 'feature')
    result = json.loads(output)
    assert code == 3 and result['ok'] is False
    assert result['notices'][0]['code'] == 'cds-load-high'
    assert calls == [('https://primary.example', 'GET', '/api/host-stats'),
                     ('https://primary.example', 'POST', '/api/branches')]


def test_unregistered_host_does_not_probe_or_change_normal_schema(workspace, monkeypatch):
    save('https://other.example', 'a', 'primary-secret')
    calls = []
    monkeypatch.setattr(cli, '_request', lambda method, path, **kw: (calls.append(path) or (200, {'id': 'branch'}, {})))
    code, output = run('branch', 'create', '--branch', 'feature')
    assert code == 0 and set(json.loads(output)) == {'ok', 'trace', 'data', 'note'}
    assert calls == ['/api/branches']


def test_real_http_advice_contacts_no_standby_and_selection_uses_own_key(workspace):
    root, catalog = workspace
    calls = []
    def handler(site, project, load):
        class Site(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                calls.append((site, 'GET', self.path, self.headers.get('X-AI-Access-Key'), None))
                self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
                body = {'cpu': {'cores': 4, 'loadAvg1': load / 25, 'loadPercent': load}, 'unexpectedKey': 'secret-do-not-save'} if self.path == '/api/host-stats' else {'id': project, 'githubRepoFullName': 'acme/app'}
                self.wfile.write(json.dumps(body).encode())
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['content-length'])))
                calls.append((site, 'POST', self.path, self.headers.get('X-AI-Access-Key'), body))
                self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
                self.wfile.write(json.dumps({'id': 'branch', **body}).encode())
        return Site
    servers = [ThreadingHTTPServer(('127.0.0.1', 0), handler('primary', 'a', 150)),
               ThreadingHTTPServer(('127.0.0.1', 0), handler('standby', 'b', 20))]
    threads = [threading.Thread(target=s.serve_forever, daemon=True) for s in servers]
    for thread in threads:
        thread.start()
    hosts = [f'http://127.0.0.1:{s.server_port}' for s in servers]
    for entry, host in zip(catalog['instances'], hosts):
        entry['url'] = host
    (root / 'cds-instances.json').write_text(json.dumps(catalog))
    save(hosts[1], 'b', 'standby-secret')
    save(hosts[0], 'a', 'primary-secret')
    env = {k: v for k, v in os.environ.items() if k not in cli._EXPLICIT_CREDENTIAL_ENV}
    def command(*args):
        result = subprocess.run([os.sys.executable, str(Path(cli.__file__).resolve()), *args], cwd=root, env=env, capture_output=True, text=True)
        assert result.returncode == 0, result.stdout + result.stderr
        assert 'secret' not in result.stdout + result.stderr
        return json.loads(result.stdout)
    try:
        advice = command('instance', 'recommend')
        assert advice['data']['state'] == 'high'
        assert advice['data']['alternatives'][0]['authorization'] == 'stored-not-verified'
        assert calls == [('primary', 'GET', '/api/host-stats', 'primary-secret', None)]
        assert not (root / '.cds/active-instance.json').exists()
        result = command('branch', 'create', '--branch', 'feature')
        assert len(result['notices']) == 1
        assert all(c[0] == 'primary' for c in calls)
        assert calls[-1][4]['projectId'] == 'a'
        command('instance', 'use', 'standby')
        selected = (root / '.cds/active-instance.json').read_text()
        assert json.loads(selected) == {'id': 'standby'}
        result = command('branch', 'create', '--branch', 'feature')
        assert 'notices' not in result
        standby_calls = [c for c in calls if c[0] == 'standby']
        assert all(c[3] == 'standby-secret' for c in standby_calls)
        assert standby_calls[-1][4]['projectId'] == 'b'
        assert all(c[3] == 'primary-secret' for c in calls if c[0] == 'primary')
        for path in (root / '.cds/instance-load-checks').glob('*.json'):
            assert 'secret' not in path.read_text()
    finally:
        for server, thread in zip(servers, threads):
            server.shutdown(); server.server_close(); thread.join()


def test_interrupted_response_is_unknown_and_audited(workspace, monkeypatch):
    root, _ = workspace
    save('https://primary.example', 'a', 'primary-secret')
    def interrupted(*args, **kwargs):
        raise ConnectionResetError('secret-do-not-save')
    monkeypatch.setattr(cli, '_request', interrupted)
    code, output = run('instance', 'recommend')
    assert code == 0 and json.loads(output)['data']['state'] == 'unknown'
    evidence = list((root / '.cds/instance-load-checks').glob('*.json'))
    assert len(evidence) == 1 and 'secret' not in evidence[0].read_text() + output


def test_load_probe_does_not_follow_cross_host_redirect(workspace):
    root, catalog = workspace
    calls = []
    class Redirect(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_GET(self):
            calls.append(self.path)
            self.send_response(302)
            self.send_header('Location', catalog['instances'][1]['url'] + '/must-not-contact')
            self.end_headers()
    server = ThreadingHTTPServer(('127.0.0.1', 0), Redirect)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    host = f'http://127.0.0.1:{server.server_port}'
    catalog['instances'][0]['url'] = host
    (root / 'cds-instances.json').write_text(json.dumps(catalog))
    save(host, 'a', 'primary-secret')
    env = {k: v for k, v in os.environ.items() if k not in cli._EXPLICIT_CREDENTIAL_ENV}
    try:
        result = subprocess.run([os.sys.executable, str(Path(cli.__file__).resolve()), 'instance', 'recommend'], cwd=root, env=env, capture_output=True, text=True)
        assert result.returncode == 0
        data = json.loads(result.stdout)['data']
        assert data['state'] == 'unknown' and data['status'] == 302
        assert calls == ['/api/host-stats']
    finally:
        server.shutdown(); server.server_close(); thread.join()
