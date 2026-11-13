"""发布环境登记必须可读回，并且不能变成隐式发布或覆盖。"""
import io
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'cli'))
import cdscli


def invoke(monkeypatch, tmp_path, config, *, existing=None, visible=True):
    calls = []
    created = {'id': 'rt_new', 'name': '预发', 'projectId': 'p1', 'isEnabled': True, 'environment': 'staging'}
    reads = 0
    def api(method, path, body=None, **kwargs):
        nonlocal reads
        calls.append((method, path, body))
        if path == '/api/projects/p1':
            return {'id': 'p1'}
        if method == 'POST':
            assert path == '/api/releases/targets'
            return {'target': created}
        reads += 1
        return {'targets': (existing or []) + ([created] if reads > 1 and visible else [])}
    monkeypatch.setattr(cdscli, '_call', api)
    monkeypatch.setattr(cdscli, '_load_local_credentials', lambda: None)
    monkeypatch.setattr(cdscli, '_read_instance_private', lambda name, default: default)
    file = tmp_path / 'environment.json'
    file.write_text(json.dumps(config))
    output = io.StringIO()
    monkeypatch.setattr(sys, 'stdout', output)
    code = 0
    try:
        cdscli.main(['release-target', 'register', '--project', 'p1', '--file', str(file)])
    except SystemExit as exc:
        code = exc.code or 0
    return code, json.loads(output.getvalue().splitlines()[-1]), calls


def test_register_reads_back_selectable_environment_without_releasing(monkeypatch, tmp_path):
    code, result, calls = invoke(monkeypatch, tmp_path, {'name': '预发', 'environment': 'staging'})
    assert code == 0 and result['data']['selectable'] is True
    assert result['data']['releaseStarted'] is False
    assert [c[0] for c in calls] == ['GET', 'GET', 'POST', 'GET']
    assert calls[2][2]['projectId'] == 'p1'
    assert not any('/runs' in c[1] for c in calls)


@pytest.mark.parametrize('config', [
    {'name': '预发', 'projectId': 'other', 'environment': 'staging'},
    {'name': '预发'},
    {'name': '预发', 'environment': 'unknown'},
    {'name': '预发', 'environment': 'staging', 'isEnabled': False},
])
def test_invalid_identity_or_ambiguous_environment_never_writes(monkeypatch, tmp_path, config):
    code, _, calls = invoke(monkeypatch, tmp_path, config)
    assert code != 0 and not any(c[0] == 'POST' for c in calls)


def test_existing_environment_is_not_duplicated_or_overwritten(monkeypatch, tmp_path):
    code, _, calls = invoke(monkeypatch, tmp_path, {'name': '预发', 'environment': 'staging'}, existing=[{'id': 'old', 'name': '预发', 'projectId': 'p1', 'isEnabled': True}])
    assert code != 0 and not any(c[0] == 'POST' for c in calls)


def test_missing_readback_does_not_report_success_or_retry_creation(monkeypatch, tmp_path):
    code, result, calls = invoke(monkeypatch, tmp_path, {'name': '预发', 'environment': 'staging'}, visible=False)
    assert code != 0 and result['targetId'] == 'rt_new'
    assert sum(c[0] == 'POST' for c in calls) == 1
