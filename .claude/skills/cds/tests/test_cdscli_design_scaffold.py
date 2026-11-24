"""Exercise the design CLI entry points with an isolated workspace."""

import json
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit
from zipfile import ZipFile

import pytest

from test_cdscli_instances import cli, run, save, workspace  # noqa: F401


def test_scaffold_pins_framework_and_preserves_rule_check_modes(workspace, monkeypatch):
    root, _ = workspace
    save('https://cds.example', 'fixture', 'cdsp_fixture')
    markdown = '''# Fixture

| 编号 | 规则 | 检查 |
|---|---|---|
| R-01 | Compare the header geometry | 自动：measure the same page header |
| R-02 | Check that the hierarchy is easy to read | 人工 |

## R-03 · Preserve existing headings
'''
    framework = {'id': 'FW-01', 'projectId': 'fixture', 'versions': [{'version': 4, 'material': {'rules': markdown}}]}
    monkeypatch.setattr(cli, '_request', lambda *_args, **_kwargs: (
        200, {'projectId': 'fixture', 'frameworks': [framework], 'designs': []}, {}))
    destination = root / 'draft'
    code, output = run('design', 'scaffold', '--legacy-template', '--framework', 'FW-01', '--title', 'Fixture', '--dir', str(destination))
    assert code == 0, output
    manifest = json.loads((destination / 'design.json').read_text())
    assert manifest['frameworkVersion'] == 4
    assert [(row['id'], row['how']) for row in manifest['acceptance']] == [('R-01', 'measure'), ('R-02', 'human'), ('R-03', 'human')]
    assert manifest['acceptance'][0]['expected'] == 'measure the same page header'
    result = json.loads((destination / 'checks/result.json').read_text())
    assert result['passed'] == 0
    assert [row['id'] for row in result['items']] == ['R-01', 'R-02', 'R-03']
    assert {row['status'] for row in result['items']} == {'unverified'}


def test_scaffold_starts_with_the_v1_gate_layout_and_no_invented_results(workspace, monkeypatch):
    root, _ = workspace
    save('https://cds.example', 'fixture', 'cdsp_fixture')
    material = {'rules': '# Shared\n\n## R-01 · Preserve the active navigation state\n'}
    framework = {'id': 'FW-01', 'projectId': 'fixture', 'versions': [{'version': 4, 'material': material}]}
    monkeypatch.setattr(cli, '_request', lambda *_args, **_kwargs: (
        200, {'projectId': 'fixture', 'frameworks': [framework], 'designs': []}, {}))
    destination = root / 'draft'
    code, output = run('design', 'scaffold', '--framework', 'FW-01', '--title', '首稿', '--dir', str(destination))
    assert code == 0, output
    manifest = json.loads((destination / 'design.json').read_text(encoding='utf-8'))
    assert manifest['project'] == 'fixture' and manifest['title'] == '首稿'
    assert manifest['frameworkVersion'] == 4 and manifest['prototypeVersion'] == 1
    assert len(manifest['date']) == 10 and isinstance(manifest['notes'], str)
    assert manifest['acceptance'] == []
    screen = manifest['screens'][0]
    assert screen['route'] == '#/home' and screen['entryReadySelector'] == '[data-cds-design-ready]'
    assert 'data-cds-design-ready' in (destination / manifest['prototype']).read_text(encoding='utf-8')
    assert all((destination / name).is_file() for name in [manifest['rationale'], manifest['checks'], *manifest['docs']])
    assert '（V1）' in (destination / '交付说明.md').read_text(encoding='utf-8').splitlines()[0]
    assert '（V1）' in (destination / manifest['rationale']).read_text(encoding='utf-8').splitlines()[0]
    assert json.loads((destination / 'versions.json').read_text()) == {'versions': []}
    assert json.loads((destination / 'changes/index.json').read_text()) == {'to': 1, 'from': []}
    results = json.loads((destination / manifest['checks']).read_text(encoding='utf-8'))
    assert results['total'] == len(results['items']) == 1 and results['passed'] == 0
    assert results['items'][0]['id'] == 'R-01'
    assert results['items'][0]['pass'] is False and results['items'][0]['status'] == 'unverified'
    assert not (destination / 'tools/gate-allow.json').exists()


def test_design_accept_root_measurement_does_not_approve_a_container_rule(monkeypatch):
    route = '/fixture'
    full = {'id': 'R-07', 'rule': '375 宽下文档没有横向溢出；只有表格、图表、代码块可以在自身容器里横向滚动',
            'how': 'measure', 'probe': {'type': 'horizontal-overflow'}}
    version = {'acceptance': [full], 'screens': [{'impl': route, 'themes': ['light'], 'viewport': 'phone'}]}
    run = {'pullRequest': 7, 'commit': 'a' * 40, 'previewUrl': 'https://preview.example/',
           'cells': [{'itemId': 'R-07', 'slot': 'phone-light', 'status': 'unverified'}]}
    monkeypatch.setattr(cli, '_request', lambda *_args, **_kwargs: (
        200, {'projectId': 'fixture', 'commit': run['commit'], 'url': 'https://preview.example/fixture'}, {}))
    geometry = {'width': 375, 'height': 812, 'contentWidth': 375}

    def browser(_command, *, input, **_kwargs):
        (Path(json.loads(input)['directory']) / 'screen-0.png').write_bytes(b'fixture screenshot')
        return SimpleNamespace(stdout=json.dumps({'rows': [{'captured': True, 'geometry': geometry}]}))

    monkeypatch.setattr(cli.subprocess, 'run', browser)
    rows = []
    cli._design_acceptance_browser('fixture', version, run, {}, rows.append)
    assert rows[-1]['status'] == 'unverified'
    assert '容器' in rows[-1]['actual'] and rows[-1]['image']
    geometry['contentWidth'] = 520
    cli._design_acceptance_browser('fixture', version, run, {}, rows.append)
    assert rows[-1]['status'] == 'failed'
    geometry['contentWidth'] = 375
    version['acceptance'] = [{**full, 'rule': '375 宽下文档没有横向溢出'}]
    cli._design_acceptance_browser('fixture', version, run, {}, rows.append)
    assert rows[-1]['status'] == 'passed'


def test_design_diff_detects_a_local_capture_change_and_keeps_missing_captures_unverified(workspace, monkeypatch):
    save('https://cds.example', 'fixture', 'cdsp_fixture')
    screens = [{'id': 'source', 'themes': ['light', 'dark']}, {'id': 'unchanged', 'themes': ['light']},
               {'id': 'missing', 'themes': ['light']}]
    before = {'version': 1, 'sourceCommit': 'a' * 40, 'sha256': '1' * 64, 'prototypeSha256': '6' * 64, 'screens': screens, 'resolves': {},
              'renders': {'source': {'light': {'id': 'capture-1', 'sha256': '2' * 64}},
                           'unchanged': {'light': {'id': 'capture-2', 'sha256': '3' * 64}}}}
    after = {**before, 'version': 2, 'sourceCommit': 'b' * 40, 'sha256': '4' * 64, 'prototypeSha256': '7' * 64,
             'renders': {'source': {'light': {'id': 'capture-3', 'sha256': '5' * 64}},
                         'unchanged': {'light': {'id': 'capture-4', 'sha256': '3' * 64}}}}
    monkeypatch.setattr(cli, '_request', lambda *_args, **_kwargs: (
        200, {'projectId': 'fixture', 'designs': [{'projectId': 'fixture', 'id': 'DSN-fixture', 'versions': [before, after]}],
              'frameworks': []}, {}))
    code, output = run('design', 'diff', 'DSN-fixture', '1', '2')
    assert code == 0, output
    result = json.loads(output)['data']
    assert result['prototypeChanged'] is True
    assert result['left']['sourceCommit'] == before['sourceCommit'] and result['right']['sourceCommit'] == after['sourceCommit']
    changes = {row['id']: row for row in result['screens']}
    assert changes['source']['status'] == 'same'
    assert changes['source']['visual'] == {'light': 'changed', 'dark': 'unverified'}
    assert changes['unchanged']['visual'] == {'light': 'same'}
    assert changes['missing']['visual'] == {'light': 'unverified'}
    after['prototypeSha256'] = before['prototypeSha256']
    code, output = run('design', 'diff', 'DSN-fixture', '1', '2')
    assert code == 0, output
    result = json.loads(output)['data']
    assert result['prototypeChanged'] is False and result['packageChanged'] is True
    del before['prototypeSha256']
    code, output = run('design', 'diff', 'DSN-fixture', '1', '2')
    assert code == 0, output
    assert json.loads(output)['data']['prototypeChanged'] is None


@pytest.fixture
def design_route(workspace, monkeypatch):
    root, _ = workspace
    save('https://cds.example', 'fixture', 'cdsp_fixture')
    entry = {'projectId': 'fixture', 'id': 'DSN-fixture', 'versions': [{'version': 1}], 'frozen': 1, 'pullRequest': 7,
             'reviewers': [], 'runs': [{'id': 'RUN-fixture', 'version': 1, 'commit': 'a' * 40, 'cells': []}]}
    state = SimpleNamespace(root=root, writes=[], receipts={}, drop_response=False)

    def request(method, path, body=None, **_kwargs):
        if method == 'GET':
            assert path == '/api/projects/fixture/design'
            return 200, {'projectId': 'fixture', 'designs': [entry], 'frameworks': []}, {}
        assert method == 'POST' and path == '/api/projects/fixture/design/commands'
        assert body['designId'] == entry['id'] and body['requestId']
        state.writes.append(body)
        previous = state.receipts.get(body['requestId'])
        if previous:
            former, receipt = previous
            if body != former:
                return 409, {'message': '同一请求编号已经用于不同的内容'}, {}
            return 200, {**receipt, 'reused': True}, {}
        result = {'type': body['type'], 'designId': entry['id']}
        if body['type'] == 'design.review':
            entry['reviewers'] = [{'id': actor, 'label': actor} for actor in body['reviewerIds']]
            result['version'] = 1
        elif body['type'] == 'acceptance.record':
            assert body['runId'] == entry['runs'][0]['id'] and body['commit'] == entry['runs'][0]['commit']
            entry['runs'][0]['cells'] = body['cells']
            result['runId'] = body['runId']
        else:
            assert body['type'] == 'acceptance.start'
            result['runId'] = entry['runs'][0]['id']
        receipt = {'projectId': 'fixture', 'reused': False, 'result': result}
        state.receipts[body['requestId']] = (body, receipt)
        if state.drop_response:
            state.drop_response = False
            return 0, {'error': 'timeout'}, {}
        return 201, receipt, {}

    monkeypatch.setattr(cli, '_request', request)
    return state


def design_data(*args):
    code, output = run('design', *args)
    assert code == 0, output
    return json.loads(output)['data']


def test_design_request_review_applies_all_three_independent_requests(design_route):
    receipts = [design_data('request-review', 'DSN-fixture', '--reviewer', reviewer)
                for reviewer in ('reviewer-a', 'reviewer-b', 'reviewer-a')]
    final = design_data('list')['items'][0]['reviewers']
    ids = {body['requestId'] for body in design_route.writes}
    assert (len(ids), [receipt['reused'] for receipt in receipts], [reviewer['id'] for reviewer in final]) == (
        3, [False, False, False], ['reviewer-a'])


def test_design_record_applies_all_three_independent_requests(design_route):
    evidence = design_route.root / 'cells.json'
    receipts = []
    for observation in ('证据 A', '证据 B', '证据 A'):
        evidence.write_text(json.dumps([{'itemId': 'R-01', 'slot': 'desktop-light', 'status': 'unverified',
                                         'actual': observation}]), encoding='utf-8')
        receipts.append(design_data('record', 'DSN-fixture', '--run', 'RUN-fixture', '--commit', 'a' * 40, '--file', str(evidence)))
    final = design_data('result', 'DSN-fixture', '--run', 'RUN-fixture')['run']['cells']
    ids = {body['requestId'] for body in design_route.writes}
    assert (len(ids), [receipt['reused'] for receipt in receipts], final[0]['actual']) == (3, [False, False, False], '证据 A')


@pytest.mark.parametrize('explicit', [False, True])
def test_design_timeout_provides_the_request_id_for_exact_replay(design_route, explicit, capsys):
    args = ('request-review', 'DSN-fixture', '--reviewer', 'reviewer-a')
    initial = (*args, '--request-id', 'review-manual-fixture') if explicit else args
    design_route.drop_response = True
    code, output = run('design', *initial)
    assert code == 3, output
    request_id = json.loads(output)['retry']['requestId']
    assert request_id == design_route.writes[0]['requestId']
    if explicit:
        assert request_id == 'review-manual-fixture'
    repeated = design_data(*args, '--request-id', request_id)
    assert repeated['reused'] is True
    assert design_route.writes[0] == design_route.writes[1]
    assert len(design_route.receipts) == 1
    if not explicit:
        design_route.drop_response = True
        code, output = run('--human', 'design', *args)
        assert code == 3, output
        human_request_id = design_route.writes[-1]['requestId']
        assert human_request_id != request_id
        assert f'本次请求编号 {human_request_id}' in capsys.readouterr().err


def test_design_accept_uses_stable_derived_ids_for_automatic_capture(design_route, monkeypatch):
    row = {'itemId': 'R-01', 'slot': 'desktop-light', 'status': 'unverified', 'actual': '抓图完成'}

    def capture(_project, _version, _run, _identity, record):
        record(row)
        record(row)
        return {'captured': 1, 'measured': 0}

    monkeypatch.setattr(cli, '_design_acceptance_browser', capture)
    assert design_data('accept', 'DSN-fixture', '--request-id', 'start-fixture')['automation']['captured'] == 1
    started, first, repeated = design_route.writes
    assert started['type'] == 'acceptance.start' and started['requestId'] == 'start-fixture'
    assert first['type'] == 'acceptance.record' and first['cells'] == [row]
    assert first['requestId'] != started['requestId']
    assert repeated == first
    assert len(design_route.receipts) == 2


def test_design_publish_keeps_idempotency_for_the_same_immutable_package(workspace, monkeypatch):
    root, _ = workspace
    save('https://cds.example', 'fixture', 'cdsp_fixture')
    package = root / 'fixture.zip'
    with ZipFile(package, 'w') as bundle:
        bundle.writestr('design.json', json.dumps({'project': 'fixture', 'title': 'Fixture'}))
        bundle.writestr('dist/index.html', '<main>Fixture</main>')
    writes = []

    def request(method, path, body=None, **_kwargs):
        url = urlsplit(path)
        assert method == 'POST' and url.path == '/api/projects/fixture/design/packages'
        assert body == package.read_bytes()
        params = parse_qs(url.query)
        request_id = params['requestId'][0]
        assert params['sourceCommit'] == ['a' * 40]
        reused = request_id in writes
        writes.append(request_id)
        return 200 if reused else 201, {'projectId': 'fixture', 'reused': reused, 'result': {'version': 1}}, {}

    monkeypatch.setattr(cli, '_request', request)
    args = ('publish', '--zip', str(package), '--source-commit', 'a' * 40)
    assert [design_data(*args)['reused'] for _ in range(2)] == [False, True]
    assert writes[0] == writes[1]
