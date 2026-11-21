"""A scaffold uses framework rules in both Markdown formats."""

import json
from pathlib import Path
from types import SimpleNamespace

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
    code, output = run('design', 'scaffold', '--framework', 'FW-01', '--title', 'Fixture', '--dir', str(destination))
    assert code == 0, output
    manifest = json.loads((destination / 'design.json').read_text())
    assert manifest['frameworkVersion'] == 4
    assert [(row['id'], row['how']) for row in manifest['acceptance']] == [('R-01', 'measure'), ('R-02', 'human'), ('R-03', 'human')]
    assert manifest['acceptance'][0]['expected'] == 'measure the same page header'
    result = json.loads((destination / 'checks/result.json').read_text())
    assert result['passed'] == 0
    assert [row['id'] for row in result['items']] == ['R-01', 'R-02', 'R-03']
    assert {row['status'] for row in result['items']} == {'unverified'}


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
