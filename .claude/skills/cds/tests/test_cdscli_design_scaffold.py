"""A scaffold uses framework rules in both Markdown formats."""

import json

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
