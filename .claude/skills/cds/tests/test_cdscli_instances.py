"""主备 CDS：离线发现、凭据隔离、失败不切换以及真实 HTTP 部署目标验证。"""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

spec = importlib.util.spec_from_file_location('instance_cli', Path(__file__).resolve().parents[1] / 'cli/cdscli.py')
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)


def run(*argv):
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        try:
            cli.main(list(argv))
        except SystemExit as error:
            return error.code, output.getvalue()
    return 0, output.getvalue()


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    subprocess.run(['git', 'init', '-q', str(tmp_path)], check=True)
    subprocess.run(['git', '-C', str(tmp_path), 'remote', 'add', 'origin', 'https://github.com/acme/app.git'], check=True)
    monkeypatch.chdir(tmp_path)
    for key in cli._EXPLICIT_CREDENTIAL_ENV:
        monkeypatch.delenv(key, raising=False)
        monkeypatch.setitem(cli._EXPLICIT_CREDENTIAL_ENV, key, '')
    catalog = {'version': 1, 'instances': [
        {'id': 'primary', 'name': '主用', 'role': 'primary', 'url': 'https://primary.example'},
        {'id': 'standby', 'name': '备用', 'role': 'standby', 'url': 'https://standby.example'},
    ]}
    (tmp_path / 'cds-instances.json').write_text(json.dumps(catalog))
    return tmp_path, catalog


def save(host, project, key):
    cli._save_local_credentials(host=host, project_id=project, project_key=key)


def ready(*args, **kwargs):
    return 200, {'id': 'b', 'githubRepoFullName': 'acme/app', 'customEnv': {'SECRET': 'never-log'}}, {'content-type': 'application/json'}


def test_connect_archives_both_hosts_and_offline_list_never_prints_keys(workspace):
    root, _ = workspace
    save('https://primary.example', 'a', 'primary-secret')
    save('https://standby.example', 'b', 'standby-secret')
    status, output = run('instance', 'list')
    assert status == 0
    assert 'secret' not in output
    store = json.loads((root / '.cds/instance-credentials.json').read_text())
    assert len(store['hosts']) == 2
    assert (root / '.cds/instance-credentials.json').stat().st_mode & 0o777 == 0o600
    exclude = (root / '.git/info/exclude').read_text()
    assert '/.cds/instance-credentials.json' in exclude


def test_selection_overrides_inherited_keys_and_keeps_old_host_reversible(workspace, monkeypatch):
    root, _ = workspace
    save('https://primary.example', 'a', 'primary-secret')
    save('https://standby.example', 'b', 'standby-secret')
    monkeypatch.setattr(cli, '_request', ready)
    assert run('instance', 'use', 'standby')[0] == 0
    monkeypatch.setenv('CDS_HOST', 'https://primary.example')
    monkeypatch.setenv('AI_ACCESS_KEY', 'primary-global-secret')
    calls = []
    def call(method, path, **kwargs):
        calls.append((os.environ['CDS_HOST'], os.environ['CDS_PROJECT_KEY'], os.environ.get('AI_ACCESS_KEY'), path))
        return {'projects': []}
    monkeypatch.setattr(cli, '_call', call)
    assert run('project', 'list')[0] == 0
    assert calls == [('https://standby.example', 'standby-secret', None, '/api/projects')]
    assert json.loads((root / '.cds/instance-credentials.json').read_text())['hosts']['https://primary.example']['projectKey'] == 'primary-secret'
    evidence = list((root / '.cds/instance-checks').glob('*.json'))
    assert len(evidence) == 1
    assert 'never-log' not in evidence[0].read_text()


@pytest.mark.parametrize('explicit', [False, True])
def test_strict_inspection_uses_selected_store_not_legacy_pointer(workspace, monkeypatch, explicit):
    root, _ = workspace
    save('https://standby.example', 'b', 'cdsp_standby_private')
    save('https://primary.example', 'a', 'cdsp_primary_private')
    legacy = (root / '.cds/credentials.json').read_bytes()
    monkeypatch.setattr(cli, '_request', ready)
    if explicit:
        argv = ('--instance', 'standby', 'auth', 'inspect', '--strict')
    else:
        assert run('instance', 'use', 'standby')[0] == 0
        argv = ('auth', 'inspect', '--strict')
    status, output = run(*argv)
    assert status == 0, output
    summary = json.loads(output)['data']
    assert summary['host'] == 'https://standby.example' and summary['projectId'] == 'b'
    assert summary['workspaceCredentials']['host'] == 'https://standby.example'
    assert summary['conflicts'] == []
    assert (root / '.cds/credentials.json').read_bytes() == legacy
    assert 'cdsp_primary_private' not in output and 'cdsp_standby_private' not in output


def test_selected_bootstrap_inspection_cannot_reload_primary_project_key(workspace):
    root, _ = workspace
    cli._save_local_credentials(host='https://standby.example', bootstrap_key='cdsg_standby_private')
    save('https://primary.example', 'a', 'cdsp_primary_private')
    cli._write_instance_private('active-instance.json', {'id': 'standby'})
    status, output = run('auth', 'inspect', '--strict')
    assert status == 0, output
    assert cli._auth_headers()['X-AI-Access-Key'] == 'cdsg_standby_private'
    assert not os.environ.get('CDS_PROJECT_KEY') and not os.environ.get('CDS_PROJECT_ID')
    assert json.loads(output)['data']['workspaceCredentials']['host'] == 'https://standby.example'


@pytest.mark.parametrize('response', [
    (401, {'error': 'unauthorized'}, {}),
    (0, {'error': 'timeout'}, {}),
    (200, {'id': 'b', 'githubRepoFullName': 'someone/else'}, {}),
    (200, {'id': 'wrong', 'githubRepoFullName': 'acme/app'}, {}),
    (200, {'project': None}, {}),
])
def test_failed_checks_do_not_select_or_deploy_and_are_audited(workspace, monkeypatch, response):
    root, _ = workspace
    save('https://primary.example', 'a', 'primary-secret')
    save('https://standby.example', 'b', 'standby-secret')
    cli._write_instance_private('active-instance.json', {'id': 'primary'})
    monkeypatch.setattr(cli, '_request', lambda *args, **kwargs: response)
    assert run('instance', 'use', 'standby')[0] != 0
    assert json.loads((root / '.cds/active-instance.json').read_text()) == {'id': 'primary'}
    assert len(list((root / '.cds/instance-checks').glob('*.json'))) == 1


def test_missing_credentials_never_send_primary_key_to_standby(workspace, monkeypatch):
    save('https://primary.example', 'a', 'primary-secret')
    monkeypatch.setattr(cli, '_request', lambda *a, **kw: pytest.fail('must not contact target without its credential'))
    assert run('--instance', 'standby', 'branch', 'create', '--branch', 'main')[0] != 0


def test_global_override_does_not_change_persistent_selection(workspace, monkeypatch):
    root, _ = workspace
    save('https://standby.example', 'b', 'standby-secret')
    cli._write_instance_private('active-instance.json', {'id': 'primary'})
    monkeypatch.setattr(cli, '_request', ready)
    monkeypatch.setattr(cli, '_call', lambda *a, **kw: {'projects': []})
    assert run('--instance', 'standby', 'project', 'list')[0] == 0
    assert json.loads((root / '.cds/active-instance.json').read_text()) == {'id': 'primary'}


def test_catalog_sync_projects_only_public_fields(workspace, monkeypatch):
    root, catalog = workspace
    save('https://primary.example', 'a', 'primary-secret')
    catalog['instances'][0]['key'] = 'never-copy'
    monkeypatch.setattr(cli, '_request', lambda *a, **kw: (200, catalog, {}))
    assert run('instance', 'sync')[0] == 0
    assert 'never-copy' not in (root / 'cds-instances.json').read_text()


def test_real_http_target_receives_only_its_key_after_selection_and_process_restart(workspace):
    root, catalog = workspace
    calls = []
    class Target(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_GET(self):
            calls.append((self.command, self.path, self.headers.get('X-CDS-Project-Key'), self.headers.get('X-AI-Access-Key')))
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
            if self.path == '/api/host-stats':
                body = {'cpu': {'cores': 4, 'loadAvg1': 1, 'loadPercent': 25}}
            elif self.path == '/api/agent/setup.json':
                body = {'version': 'cds-agent-setup.v1', 'cliVersion': cli.VERSION, 'minCliVersion': '0.17.5'}
            elif self.path == '/api/credentials/self-check':
                body = {'status': 'active', 'kind': 'project', 'projectId': 'b'}
            else:
                body = {'id': 'b', 'githubRepoFullName': 'acme/app'}
            self.wfile.write(json.dumps(body).encode())
        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers['content-length'])))
            calls.append((self.command, self.path, payload, self.headers.get('X-CDS-Project-Key')))
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
            self.wfile.write(json.dumps({'id': 'target-branch', 'branch': payload['branch'], 'projectId': payload['projectId']}).encode())
    server = ThreadingHTTPServer(('127.0.0.1', 0), Target)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    host = f'http://127.0.0.1:{server.server_port}'
    catalog['instances'][1]['url'] = host
    (root / 'cds-instances.json').write_text(json.dumps(catalog))
    save('https://primary.example', 'a', 'primary-secret')
    save(host, 'b', 'standby-secret')
    # Start from the primary legacy pointer, as a process after primary failure would.
    save('https://primary.example', 'a', 'primary-secret')
    env = {k: v for k, v in os.environ.items() if k not in cli._EXPLICIT_CREDENTIAL_ENV}
    try:
        for argv in [('instance', 'use', 'standby'), ('auth', 'inspect', '--strict'),
                     ('setup-check', '--host', host, '--project', 'b', '--skills', 'cds'),
                     ('branch', 'create', '--branch', 'feature')]:
            completed = subprocess.run([os.sys.executable, str(Path(cli.__file__).resolve()), *argv], cwd=root, env=env, capture_output=True, text=True)
            assert completed.returncode == 0, completed.stdout + completed.stderr
            assert 'standby-secret' not in completed.stdout
        assert calls[0][0:2] == ('GET', '/api/projects/b')
        assert [call[1] for call in calls[1:4]] == ['/api/agent/setup.json', '/api/credentials/self-check', '/api/projects/b']
        assert calls[4][0:2] == ('GET', '/api/host-stats')
        assert calls[5][0:3] == ('POST', '/api/branches', {'projectId': 'b', 'branch': 'feature'})
        assert 'primary-secret' not in repr(calls)
        assert 'standby-secret' in repr(calls)
    finally:
        server.shutdown(); server.server_close(); thread.join()


@pytest.mark.parametrize("matching", [False, True])
def test_connect_validates_repository_before_changing_default(workspace, monkeypatch, matching):
    root, _ = workspace
    save('https://primary.example', 'a', 'primary-secret')
    old = (root / '.cds/credentials.json').read_text()
    cli._write_instance_private('active-instance.json', {'id': 'primary'})
    def request(method, path, **kwargs):
        if method == 'POST':
            return 201, {'requestId': 'r', 'pollToken': 'poll'}, {}
        if path.endswith('/access-requests/r'):
            return 200, {'status': 'approved', 'authorizationKey': 'standby-secret'}, {}
        return 200, {'id': 'b', 'githubRepoFullName': 'acme/app' if matching else 'wrong/repo'}, {}
    monkeypatch.setattr(cli, '_request', request)
    status, output = run('instance', 'connect', 'standby', '--project', 'b')
    assert status == 0 if matching else status != 0
    assert 'standby-secret' not in output
    current = json.loads((root / '.cds/credentials.json').read_text())
    assert current['projectId'] == 'b' if matching else current == json.loads(old)
    assert json.loads((root / '.cds/active-instance.json').read_text()) == {'id': 'standby' if matching else 'primary'}


def test_instance_check_refuses_redirect_without_forwarding_credentials(workspace):
    root, catalog = workspace
    paths = []
    class Target(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_GET(self):
            paths.append(self.path)
            self.send_response(302)
            self.send_header('Location', '/would-leak')
            self.end_headers()
    server = ThreadingHTTPServer(('127.0.0.1', 0), Target)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    host = f'http://127.0.0.1:{server.server_port}'
    catalog['instances'][1]['url'] = host
    (root / 'cds-instances.json').write_text(json.dumps(catalog))
    save('https://primary.example', 'a', 'primary-secret')
    save(host, 'b', 'standby-secret')
    cli._write_instance_private('active-instance.json', {'id': 'primary'})
    try:
        status, output = run('instance', 'use', 'standby')
        assert status != 0
        assert paths == ['/api/projects/b']
        assert 'standby-secret' not in output
        assert json.loads((root / '.cds/active-instance.json').read_text()) == {'id': 'primary'}
    finally:
        server.shutdown(); server.server_close(); thread.join()


def test_fresh_install_discovers_bundled_sites_offline(workspace, monkeypatch):
    root, _ = workspace
    (root / 'cds-instances.json').unlink()
    monkeypatch.setattr(cli, '_request', lambda *a, **kw: pytest.fail('offline discovery must not call any host'))
    code, text = run('instance', 'list')
    data = json.loads(text)['data']
    assert code == 0
    assert [(x['id'], x['url']) for x in data['instances']] == [
        ('primary', 'https://cds.miduo.org'), ('standby', 'https://mycds.net')]
    assert all(not x['connected'] for x in data['instances'])
    assert not (root / 'cds-instances.json').exists()


def test_bundled_standby_without_its_grant_never_uses_primary_key(workspace, monkeypatch):
    root, _ = workspace
    (root / 'cds-instances.json').unlink()
    save('https://cds.miduo.org', 'source-project', 'primary-only-secret')
    monkeypatch.setenv('CDS_HOST', 'https://cds.miduo.org')
    monkeypatch.setenv('AI_ACCESS_KEY', 'primary-global-secret')
    monkeypatch.setattr(cli, '_request', lambda *a, **kw: pytest.fail('missing standby grant must stop before any request'))
    code, text = run('instance', 'use', 'standby')
    assert code == 1 and '尚未接入' in json.loads(text)['error']
    assert 'secret' not in text
    assert not (root / '.cds/active-instance.json').exists()
