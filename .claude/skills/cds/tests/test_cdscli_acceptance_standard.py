"""Exercise design acceptance through the standalone skill and loopback CDS."""

import io
import json
import os
import shutil
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from zipfile import ZipFile

import pytest

SKILL = Path(__file__).resolve().parents[1]
CLI = SKILL / 'cli/cdscli.py'
RELEASE = SKILL / 'scripts/design/release.mjs'
PROJECT = 'acceptance-standard-fixture'
FRAMEWORK = 'FW-CDS-UI'
SOURCE_COMMIT = 'a' * 40
ROUTE = f'/api/projects/{PROJECT}/design'
METHODS = {
    'mece': 'MECE 覆盖', 'compare': '对照图', 'visual': '视觉', 'regress': '历史易错',
    'flow': '流程', 'human': '人工', 'smoke': '冒烟', 'debt': '验收债务',
}
DIMENSIONS = {
    'correctness': '正确性', 'compatibility': '兼容性', 'performance': '性能容量',
    'security': '安全合规', 'operations': '运维部署', 'experience': '用户体验',
}
POLICY = {
    'version': 1, 'gate': 'G-11',
    'methods': [{'id': key, 'label': label} for key, label in METHODS.items()],
    'dimensions': [{'id': key, 'label': label} for key, label in DIMENSIONS.items()],
}
ISSUES = [
    {'field': 'acceptancePlan', 'code': 'missing_acceptance_plan'},
    {'field': 'acceptance[0].dimension', 'code': 'invalid_dimension', 'ruleId': 'A-01'},
    {'field': 'risks.security', 'code': 'missing_coverage'},
]
PRIVATE_DIAGNOSTIC = 'synthetic-private-upstream-diagnostic'


def isolated_env():
    return {'PATH': os.environ.get('PATH', os.defpath), 'LANG': 'C.UTF-8',
            'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull, 'PYTHONDONTWRITEBYTECODE': '1'}


@pytest.fixture
def cds(tmp_path):
    calls = []
    publications = []
    material = {'rules': '# 示例规则\n\n| R-01 | 核对交付标题 | 人工 |\n'}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def respond(self, status, data):
            body = json.dumps(data).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            target = urlsplit(self.path)
            calls.append((self.command, target.path))
            common = {'projectId': PROJECT, 'permissions': {'write': True}, 'designs': []}
            if target.path == ROUTE + '/intake':
                return self.respond(200, {**common, 'protocolVersion': 1, 'acceptancePolicy': POLICY,
                                          'frameworks': [{'id': FRAMEWORK, 'title': '示例框架', 'latestVersion': 1}]})
            if target.path == ROUTE:
                return self.respond(200, {**common, 'frameworks': [{'id': FRAMEWORK, 'projectId': PROJECT,
                                          'versions': [{'version': 1, 'material': material}]}]})
            self.respond(404, {'error': 'fixture_route_missing'})

        def do_POST(self):
            target = urlsplit(self.path)
            calls.append((self.command, target.path))
            if target.path != ROUTE + '/packages':
                self.respond(404, {'error': 'fixture_route_missing'})
                return
            query = {key: values[0] for key, values in parse_qs(target.query).items()}
            content = self.rfile.read(int(self.headers['Content-Length']))
            with ZipFile(io.BytesIO(content)) as archive:
                manifest = json.loads(archive.read('design.json'))
            publications.append((query, manifest))
            if 'acceptancePlan' not in manifest:
                self.respond(400, {
                    'error': 'G-11', 'message': PRIVATE_DIAGNOSTIC,
                    'issues': [
                        {**ISSUES[0], 'message': PRIVATE_DIAGNOSTIC}, ISSUES[1], ISSUES[2],
                        {'field': 'acceptancePlan.' + PRIVATE_DIAGNOSTIC, 'code': 'missing_method'},
                        {'field': 'acceptance[1].dimension', 'code': 'invalid_dimension', 'ruleId': PRIVATE_DIAGNOSTIC},
                        {'field': 'acceptancePlan.flow', 'code': PRIVATE_DIAGNOSTIC},
                    ],
                })
                return
            self.respond(201, {'projectId': PROJECT, 'reused': False,
                               'result': {'type': 'package', 'designId': 'DSN-fixture', 'version': 1}})

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.02}, daemon=True)
    thread.start()

    def run(*args):
        return subprocess.run([sys.executable, str(CLI), 'design', *args], cwd=tmp_path, capture_output=True,
                              text=True, check=False, timeout=15,
                              env={**isolated_env(), 'CDS_HOST': f'http://127.0.0.1:{server.server_port}',
                                   'CDS_PROJECT_ID': PROJECT, 'CDS_PROJECT_KEY': 'cdsp_fixture_only'})

    try:
        yield run, calls, publications, material
    finally:
        server.shutdown()
        server.server_close()
        thread.join(1)


def test_design_intake_exposes_the_current_acceptance_policy(cds):
    run, calls, _, _ = cds
    result = run('intake')
    assert result.returncode == 0, result.stdout + result.stderr
    assert json.loads(result.stdout)['data']['acceptancePolicy'] == POLICY
    assert calls == [('GET', ROUTE + '/intake')]


@pytest.mark.parametrize('human_required', [True, False])
def test_design_scaffold_marks_known_methods_and_leaves_open_decisions(tmp_path, cds, human_required):
    run, _, _, material = cds
    if not human_required:
        material['rules'] = '# 示例规则\n\n| R-01 | 核对画面 | 自动：显示主区域 |\n'
    directory = tmp_path / 'draft'
    result = run('scaffold', '--framework', FRAMEWORK, '--title', '示例设计', '--dir', str(directory))
    assert result.returncode == 0, result.stdout + result.stderr
    manifest = json.loads((directory / 'design.json').read_text(encoding='utf-8'))
    assert manifest['acceptanceMode'] == 'objective'
    plan = manifest['acceptancePlan']
    expected = dict.fromkeys(METHODS, None)
    expected.update(mece=True, compare=True, visual=True)
    if human_required:
        expected['human'] = True
    assert {method: entry['applicable'] for method, entry in plan.items()} == expected
    assert all(not entry.get('reason') for entry in plan.values() if entry['applicable'] is None)
    assert manifest['acceptance'] and all(not rule.get('dimension') for rule in manifest['acceptance'])
    assert not manifest.get('risks')


def completed_plan():
    plan = {method: {'applicable': True} for method in ('mece', 'compare', 'visual', 'human')}
    optional_reasons = {
        'regress': '这是首个稿件，项目尚无和此画面有关的历史问题。',
        'flow': '稿件仅展示静态说明，没有跨步骤操作。',
        'smoke': '稿件不涉及请求或正式页面入口。',
        'debt': '此合成示例的每条验收项都有明确的检查方式。',
    }
    plan.update({method: {'applicable': False, 'reason': reason} for method, reason in optional_reasons.items()})
    return plan


def test_cli_publish_returns_only_safe_gate_issues_and_accepts_repaired_submission(tmp_path, cds):
    run, _, publications, _ = cds
    archive_path = tmp_path / 'draft.zip'
    manifest = {'project': PROJECT, 'title': '示例设计', 'acceptanceMode': 'objective'}

    def publish():
        with ZipFile(archive_path, 'w') as archive:
            archive.writestr('design.json', json.dumps(manifest))
        return run('publish', '--private', '--intent', 'create', '--design-key', 'fixture/overview',
                   '--source-commit', SOURCE_COMMIT, '--source-path', 'design/overview',
                   '--request-id', 'acceptance-repair', '--zip', str(archive_path))

    rejected = publish()
    assert rejected.returncode == 2, rejected.stdout + rejected.stderr
    error = json.loads(rejected.stdout)
    assert error['ok'] is False
    assert error['gate'] == 'G-11'
    assert error['issues'] == ISSUES
    assert PRIVATE_DIAGNOSTIC not in rejected.stdout + rejected.stderr

    manifest['acceptancePlan'] = completed_plan()
    repaired = publish()
    assert repaired.returncode == 0, repaired.stdout + repaired.stderr
    assert json.loads(repaired.stdout)['data']['result'] == {'type': 'package', 'designId': 'DSN-fixture', 'version': 1}
    assert [query['requestId'] for query, _ in publications] == ['acceptance-repair', 'acceptance-repair']
    assert all(query['sourceMode'] == 'private' for query, _ in publications)
    assert 'acceptancePlan' not in publications[0][1]
    assert publications[1][1]['acceptancePlan'] == manifest['acceptancePlan']


@pytest.mark.skipif(not shutil.which('node'), reason='design release uses Node.js')
def test_release_check_blocks_missing_plan_and_passes_the_repaired_draft(tmp_path):
    manifest_name = tmp_path / 'design.json'
    manifest = {
        'project': PROJECT, 'title': '示例设计', 'framework': FRAMEWORK, 'frameworkVersion': 1, 'prototypeVersion': 1,
        'date': '2026-11-26', 'rationale': '思路.md', 'prototype': 'dist/index.html', 'checks': 'checks/result.json',
        'docs': ['交付说明.md'], 'notes': '', 'acceptanceMode': 'objective',
        'screens': [{'id': 'home', 'name': '入口', 'route': '#/', 'viewport': 'desktop', 'themes': ['light'],
                     'entryReadySelector': '.cds-main', 'impl': '/home'}],
        'acceptance': [{'id': 'A-01', 'rule': '核对标题', 'expected': '显示示例说明。', 'how': 'human',
                        'screenId': 'home', 'slots': ['desktop-light'], 'dimension': 'correctness'}],
        'goals': [{'id': 'GOAL-01', 'goal': '说明可读', 'doneWhen': '主区域显示示例标题。', 'items': ['A-01']}],
        'risks': [
            {'dimension': 'correctness', 'risk': '入口展示错误说明', 'ruleIds': ['A-01']},
            {'dimension': 'compatibility', 'risk': '平台差异', 'ruleIds': [], 'reason': '合成夹具只校验一个本地桌面视口。'},
            {'dimension': 'performance', 'risk': '加载延迟', 'ruleIds': [], 'reason': '不存在异步加载的静态示例。'},
            {'dimension': 'security', 'risk': '敏感数据', 'ruleIds': [], 'reason': '内容全部为虚构文字。'},
            {'dimension': 'operations', 'risk': '服务中断', 'ruleIds': [], 'reason': '静态说明没有运行依赖。'},
            {'dimension': 'experience', 'risk': '交互可发现性', 'ruleIds': [], 'reason': '说明画面不提供操作控件。'},
        ],
    }
    fingerprint = json.dumps({'builder': 'cds-design/prototype-build', 'baseline': SOURCE_COMMIT})
    files = {
        '思路.md': '# 思路（V1）\n用一页说明展示示例。',
        '交付说明.md': '# 交付（V1）\n从主区域读取示例。',
        'spec/rules.md': '### R-01 · 保留主区域',
        'dist/index.html': f'''<!doctype html><meta name="cds-prototype-build" content='{fingerprint}'>'''
                           '<main class="cds-main">示例说明</main>',
        'checks/result.json': json.dumps({'total': 1, 'passed': 1, 'items': [{'name': 'R-01 主区域可见', 'pass': True}]}),
    }
    for relative, content in files.items():
        file = tmp_path / relative
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(content, encoding='utf-8')

    def check():
        manifest_name.write_text(json.dumps(manifest, ensure_ascii=False), encoding='utf-8')
        return subprocess.run(['node', str(RELEASE), 'check', '--dir', str(tmp_path)], cwd=tmp_path,
                              env=isolated_env(), capture_output=True, text=True, check=False, timeout=15)

    rejected = check()
    assert rejected.returncode == 1, rejected.stdout + rejected.stderr
    assert 'G-11' in rejected.stderr and 'acceptancePlan' in rejected.stderr

    manifest['acceptancePlan'] = completed_plan()
    repaired = check()
    assert repaired.returncode == 0, repaired.stdout + repaired.stderr
    assert 'G-11' not in repaired.stderr
    assert (tmp_path / '交接清单.md').is_file()
