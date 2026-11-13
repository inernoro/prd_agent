"""原技能采集→持续台账的真实调用路径回归；不借用周报Agent代码。"""
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import subprocess
from types import SimpleNamespace

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'


def module(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + '.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


@pytest.fixture
def adapter():
    return module('delivery_evidence')


@pytest.fixture
def collector():
    return module('collect_week_context')


def git(repo, *args, **kwargs):
    return subprocess.check_output(['git', '-C', str(repo), *args], text=True, **kwargs).strip()


@pytest.fixture
def repository(tmp_path):
    repo = tmp_path / 'repo'
    repo.mkdir()
    git(repo, 'init', '-b', 'main')
    git(repo, 'config', 'user.name', 'Fixture')
    git(repo, 'config', 'user.email', 'fixture@example.test')
    git(repo, 'remote', 'add', 'origin', 'https://github.com/example/project.git')
    def commit(message, day):
        (repo / 'content').write_text(message)
        git(repo, 'add', 'content')
        env = {**os.environ, 'GIT_AUTHOR_DATE': day + 'T10:00:00+08:00', 'GIT_COMMITTER_DATE': day + 'T10:00:00+08:00'}
        git(repo, 'commit', '-m', message, env=env)
        sha = git(repo, 'rev-parse', 'HEAD')
        git(repo, 'update-ref', 'refs/remotes/origin/main', sha)
        return sha
    commit('base', '2026-09-27')
    return repo, commit


def ledger(kind='code_complete', revision='v1', event_id='proof'):
    event = {'id': event_id, 'workItemId': 'task', 'kind': kind, 'revision': revision,
             'occurredAt': '2026-09-29T10:00:00+08:00',
             'source': {'uri': 'https://example.test/proof', 'excerpt': kind}}
    if kind.startswith('validation_'):
        event['scope'] = 'feature'
    return {'schemaVersion': 1, 'workItems': [{'id': 'task', 'title': '批量导出'}], 'events': [event]}


def context(**sources):
    return {'weekStart': '2026-09-28', 'weekEnd': '2026-10-04', **sources}


def test_multiple_prs_explicitly_close_one_task_without_fuzzy_join(adapter, repository):
    repo, commit = repository
    one = commit('feat: initial (#101)', '2026-09-28')
    two = commit('fix: repair (#102)', '2026-09-29')
    commit('fix: very similar repair without a binding', '2026-09-30')
    prs = [{'number': number, 'merge_commit_sha': sha, 'body': 'Closes #42', 'merged': True, 'base': {'ref': 'main'}} for number, sha in [(101, one), (102, two)]]
    data = adapter.collect_git_ledger(repo, 'origin/main', None, '2026-09-28', '2026-10-04', adapter.empty_ledger(), prs)
    report = adapter.engine()['analyze'](data, '2026-09-28', '2026-10-04')
    assert len(data['events']) == 3
    assert len(report['items']) == 1
    assert len(report['unassignedEvidence']) == 1
    assert report['items'][0]['workItemId'] == 'https://github.com/example/project/issues/42'
    assert report['items'][0]['current']['code'] == 'in_progress'
    assert report['items'][0]['current']['validation'] == 'unknown'
    assert report['items'][0]['current']['release'] == 'unknown'
    assert all(value is None for value in report['newMilestones'].values())
    assert {event['revision'] for event in data['events']} >= {one, two}


def test_closing_references_are_explicit_single_and_not_code_examples(adapter):
    repo = 'https://github.com/example/project'
    assert adapter._closing_identity('Fixes #42\nResolves #43', repo) is None
    assert adapter._closing_identity('See #42\nWork similar to #42', repo) is None
    assert adapter._closing_identity('```\nCloses #42\n```', repo) is None
    assert adapter._closing_identity('Fixes #42\nCloses #42', repo) == repo + '/issues/42'


def test_source_outage_and_recollection_keep_current_period_facts(adapter, repository, tmp_path):
    repo, commit = repository
    commit('no inferred milestone', '2026-09-28')
    prior = ledger()
    prior['artifactBindings'] = {'acceptance:valid': {'workItemIds': ['task'], 'scope': 'feature'}}
    data, coverage = adapter.collect_context_evidence(context(acceptance={'available': False, 'reason': 'source outage'}), prior, repo, 'origin/main')
    assert any(event['id'] == 'proof' for event in data['events'])
    assert data['artifactBindings'] == prior['artifactBindings']
    assert any('source outage' in limitation for limitation in data['limitations'])
    repeated, _ = adapter.collect_context_evidence(context(acceptance={'available': False, 'reason': 'source outage'}), data, repo, 'origin/main')
    assert repeated['events'] == data['events']
    report = adapter.engine()['analyze'](repeated, '2026-09-28', '2026-10-04')
    assert report['items'][0]['current']['code'] == 'complete'
    assert coverage['available']
    destination = tmp_path / 'ledger.json'
    adapter.write_ledger(destination, repeated)
    assert adapter.read_ledger(destination)['events'] == repeated['events']


def test_previous_and_same_period_published_ledgers_are_loaded(adapter):
    previous = ledger()
    latest = ledger('validation_passed', event_id='validated')
    ctx = context(prevWeekly={'available': True,
        'prevEntry': {'metadata': {'deliveryEvidenceLedger': json.dumps(previous)}},
        'currentEntry': {'metadata': {'deliveryEvidenceLedger': json.dumps(latest)}}})
    out = adapter.context_ledger(ctx, adapter.empty_ledger())
    assert {e['id'] for e in out['events']} == {'proof', 'validated'}


def test_report_pass_is_not_feature_validation_and_short_sha_is_not_revision(adapter):
    prior = ledger()
    row = {'id': 'valid', 'workItemId': 'task', 'createdAt': '2026-09-30T10:00:00Z',
           'commitSha': 'abc1234', 'verdict': 'pass', 'scope': 'feature',
           'sourceUrl': 'https://example.test/acceptance', 'excerpt': 'Report pass'}
    out = adapter.context_ledger(context(acceptance={'available': True, 'items': [row]}), prior)
    event = out['events'][0]
    assert event['kind'] == 'observation'
    assert event['timeBasis'] == 'observed'
    assert event['revision'] is None
    assert any('不能把报告通过' in text for text in out['limitations'])


def test_explicit_ci_failure_remains_ci_risk_without_changing_feature_stage(adapter):
    prior = ledger()
    row = {'id': 'ci', 'workItemId': 'task', 'occurredAt': '2026-09-30T10:00:00Z',
           'revision': 'v1', 'verdict': 'fail', 'scope': 'ci',
           'sourceUrl': 'https://example.test/ci', 'excerpt': 'Unit tests failed'}
    out = adapter.engine()['merge_ledgers']([prior, adapter.context_ledger(context(acceptance={'available': True, 'items': [row]}), prior)])
    report = adapter.engine()['analyze'](out, '2026-09-28', '2026-10-04')
    assert report['items'][0]['current']['validation'] == 'unknown'
    assert report['items'][0]['current']['ciFailed'] is True


def test_preview_or_unscoped_release_does_not_become_production_completion(adapter):
    row = {'releaseId': 'preview', 'workItemId': 'task', 'finishedAt': '2026-09-30T10:00:00Z',
           'revision': 'v1', 'status': 'success', 'environment': 'preview',
           'sourceUrl': 'https://example.test/release', 'excerpt': 'Preview successful'}
    out = adapter.context_ledger(context(releases={'available': True, 'items': [row]}), ledger())
    assert out['events'][0]['kind'] == 'observation'
    assert out['events'][0]['environment'] == 'preview'


def test_daily_original_content_watermark_and_source_snapshot_are_retained(collector, monkeypatch):
    body = '<h1>真实日报冻结原文</h1>' + ('original ' * 1000)
    entry = {'id': 'entry', 'title': '日报2026-09-28', 'summary': 'short summary',
             'createdAt': '2026-09-28T08:00:00Z', 'metadata': {'kind': 'daily-report', 'dailyDate': '2026-09-28', 'lastCommit': 'a' * 40}}
    monkeypatch.setattr(collector, '_find_store', lambda *args: {'id': 'store'})
    seen = []
    def curl(args, **kwargs):
        url = args[-1]
        seen.append(url)
        if url.endswith('/share-links'):
            return {'success': True, 'data': {'items': []}}
        if url.endswith('/content'):
            return {'success': True, 'data': {'content': body}}
        assert 'all=true' in url
        return {'success': True, 'data': {'items': [entry], 'total': 1}}
    monkeypatch.setattr(collector, '_curl', curl)
    out = collector.collect_daily_reports('https://example.test', [], '2026-09-28', '2026-10-04')
    saved = out['items'][0]
    assert saved['content'] == body
    assert saved['metadata']['lastCommit'] == 'a' * 40
    assert len(saved['contentSha256']) == 64
    assert saved['sourceUrl'] == 'https://example.test/api/document-store/entries/entry/content'
    assert saved['sourceUrl'] in seen


def test_cds_created_time_is_observed_full_revision_and_china_date(collector, monkeypatch):
    row = {'id': 'report', 'title': '功能验收通过', 'verdict': 'pass', 'createdAt': '2026-10-04T22:08:14.766Z', 'commitSha': 'a' * 40}
    monkeypatch.setattr(collector, '_cdscli', lambda args: {'ok': True, 'data': [row]})
    monkeypatch.setattr(collector, 'acceptance_deeplink', lambda rid: 'https://example.test/reports?report=' + rid)
    assert not collector.collect_acceptance('project', '2026-09-28', '2026-10-04')['items']
    out = collector.collect_acceptance('project', '2026-10-05', '2026-10-11')
    assert out['items'][0]['createdAt'] == row['createdAt']
    assert out['items'][0]['date'] == '2026-10-05'
    assert out['items'][0]['commitSha'] == 'a' * 40
    assert out['items'][0]['scope'] is None


def test_collector_main_updates_after_sources_and_returns_the_bound_ledger(collector, monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(collector, 'assert_not_shallow', lambda: {'checked': True, 'shallow': False})
    monkeypatch.setattr(collector, '_headers', lambda *args: [])
    for name in ['collect_daily_reports', 'collect_defects', 'collect_prev_weekly', 'collect_team_insights', 'collect_adoption', 'collect_releases', 'collect_preview_deploys']:
        monkeypatch.setattr(collector, name, lambda *args: {'available': False, 'reason': 'controlled outage'})
    monkeypatch.setattr(collector, 'collect_acceptance', lambda *args: {'available': True, 'items': [{'id': 'actual-source'}]})
    def update(ctx, args):
        assert ctx['acceptance']['items'][0]['id'] == 'actual-source'
        assert ctx['dailyReports']['reason'] == 'controlled outage'
        return {'available': True, 'ledger': ledger(), 'ledgerPath': str(tmp_path / 'state.json'), 'report': {'items': []}}
    monkeypatch.setattr(collector, 'update_delivery_evidence', update)
    monkeypatch.setattr('sys.argv', ['collect', '--week-start', '2026-09-28', '--week-end', '2026-10-04'])
    collector.main()
    out = json.loads(capsys.readouterr().out)
    assert out['deliveryEvidence']['ledger']['events'][0]['id'] == 'proof'


def test_conflicting_recollection_does_not_overwrite_saved_period(collector, repository, tmp_path):
    repo, commit = repository
    commit('unassigned activity', '2026-09-28')
    path = tmp_path / 'ledger.json'
    path.write_text(json.dumps(ledger()))
    before = path.read_bytes()
    bad = ledger()
    bad['events'][0]['source']['excerpt'] = 'rewritten original source'
    enrich = tmp_path / 'enrich.json'
    enrich.write_text(json.dumps(bad))
    args = SimpleNamespace(evidence_ledger=str(path), ledger_out='', evidence_input=str(enrich), pull_requests='', repo=str(repo), project='project', mainline='origin/main', git_head='', cadence='weekly')
    with pytest.raises(ValueError, match='冲突'):
        collector.update_delivery_evidence(context(), args)
    assert path.read_bytes() == before


def test_pending_published_shell_is_not_used_as_successful_evidence(adapter):
    pending = {'metadata': {'deliveryEvidenceStatus': 'pending', 'deliveryEvidenceLedger': json.dumps(ledger())}}
    out = adapter.context_ledger(context(prevWeekly={'available': True, 'currentEntry': pending}, dailyReports={'available': True, 'items': [pending]}), adapter.empty_ledger())
    assert not out['events']
    assert any('pending' in text for text in out['limitations'])


def test_successful_rollback_invalidates_only_the_exact_original_release(adapter):
    prior = ledger('release_succeeded')
    prior['events'][0]['environment'] = 'production'
    prior['events'][0]['source']['recordId'] = 'release-new'
    row = {'releaseId': 'rollback', 'rollbackOf': 'release-new', 'finishedAt': '2026-10-01T10:00:00Z', 'status': 'rollback_success',
           'commitSha': 'b' * 40, 'sourceUrl': 'https://example.test/rollback', 'excerpt': 'rollback completed'}
    extra = adapter.context_ledger(context(releases={'available': True, 'items': [row]}), prior)
    assert extra['events'][0]['kind'] == 'release_failed'
    assert extra['events'][0]['revision'] == 'v1'
    assert extra['events'][0]['workItemId'] == 'task'
    data = adapter.engine()['merge_ledgers']([prior, extra])
    report = adapter.engine()['analyze'](data, '2026-09-28', '2026-10-04')
    assert report['items'][0]['current']['release'] == 'failed'


def test_explicit_daily_watermark_does_not_fall_back_to_calendar_day(adapter, repository):
    repo, commit = repository
    baseline = git(repo, 'rev-parse', 'HEAD')
    earlier = commit('feat: earlier part\n\nFixes #42', '2026-09-28')
    head = commit('fix: next-day repair\n\nFixes #42', '2026-09-29')
    out = adapter.collect_git_ledger(repo, 'origin/main', head, '2026-09-29', '2026-09-29', adapter.empty_ledger(), git_base=baseline)
    assert {event['revision'] for event in out['events']} == {earlier, head}
    assert out['collection']['base'] == baseline
    with pytest.raises(subprocess.CalledProcessError):
        adapter.collect_git_ledger(repo, 'origin/main', earlier, '2026-09-29', '2026-09-29', adapter.empty_ledger(), git_base=head)


def test_unmerged_pr_is_observed_progress_not_mainline_delivery(adapter, repository):
    repo, _ = repository
    out = adapter.collect_git_ledger(repo, 'origin/main', None, '2026-09-28', '2026-10-04', adapter.empty_ledger(),
        [{'number': 101, 'title': '跨日开发', 'body': 'Fixes #42', 'merged': False, 'state': 'open', 'draft': True,
          'updated_at': '2026-09-29T10:00:00Z', 'html_url': 'https://github.com/example/project/pull/101'}])
    assert len(out['events']) == 1
    assert out['events'][0]['kind'] == 'observation'
    report = adapter.engine()['analyze'](out, '2026-09-28', '2026-10-04')
    assert report['items'][0]['current']['code'] == 'unknown'
    assert report['items'][0]['current']['validation'] == 'unknown'
    assert report['items'][0]['current']['release'] == 'unknown'


def test_recollecting_old_git_snapshot_keeps_original_source_and_identity(adapter, repository):
    repo, commit = repository
    sha = commit('feat: work\n\nFixes #42', '2026-09-28')
    first = adapter.collect_git_ledger(repo, 'origin/main', sha, '2026-09-28', '2026-10-04', adapter.empty_ledger())
    first['events'][0]['source']['excerpt'] = '原采集器保存的不可变摘录'
    again = adapter.collect_git_ledger(repo, 'origin/main', sha, '2026-09-28', '2026-10-04', first, git_base=first['collection']['base'])
    assert again['events'][0] == first['events'][0]


def test_changed_daily_source_is_versioned_at_update_not_backdated_to_creation(adapter):
    first = {'entryId': 'daily', 'createdAt': '2026-09-28T01:00:00Z', 'updatedAt': '2026-09-28T01:00:01Z',
             'sourceUrl': 'https://example.test/daily', 'content': 'first source text'}
    changed = {**first, 'updatedAt': '2026-09-29T01:00:00Z', 'content': 'later amended source text'}
    old = adapter.context_ledger(context(dailyReports={'available': True, 'items': [first]}), adapter.empty_ledger())
    new = adapter.context_ledger(context(dailyReports={'available': True, 'items': [changed]}), old)
    data = adapter.engine()['merge_ledgers']([old, new])
    assert len(data['events']) == 2
    report = adapter.engine()['analyze'](data, '2026-09-28', '2026-09-28', 'daily')
    assert len(report['evidence']) == 1
    assert next(iter(report['evidence'].values()))['source']['excerpt'] == 'first source text'


def test_monthly_resumes_own_verified_current_and_previous_edition(collector, monkeypatch):
    stores = []
    monkeypatch.setattr(collector, '_find_store', lambda base, headers, name: stores.append(name) or {'id': 'monthly'})
    entries = [
        {'id': 'pending', 'metadata': {'kind': 'project-monthly-report', 'dailyDate': '2026-10-31', 'deliveryEvidenceStatus': 'pending'}},
        {'id': 'current', 'metadata': {'kind': 'project-monthly-report', 'dailyDate': '2026-10-31', 'deliveryEvidenceStatus': 'verified', 'deliveryEvidenceLedger': '{}'}},
        {'id': 'previous', 'metadata': {'kind': 'project-monthly-report', 'dailyDate': '2026-09-30', 'deliveryEvidenceStatus': 'verified'}},
        {'id': 'wrong-kind', 'metadata': {'kind': 'weekly-report', 'dailyDate': '2026-10-25'}}]
    monkeypatch.setattr(collector, '_curl', lambda args: {'success': True, 'data': {'items': entries, 'hasNextPage': False}})
    result = collector.collect_prev_weekly('https://example.test', [], '', '2026-10-31', 'monthly')
    assert stores == ['项目月度汇总知识库']
    assert result['prevEntry']['entryId'] == 'previous'
    assert result['currentEntry']['entryId'] == 'current'


def test_preview_keeps_full_revision_without_becoming_production(collector, monkeypatch):
    monkeypatch.setattr(collector, '_cdscli', lambda args: {'ok': True, 'data': {'versions': [
        {'id': 'preview', 'createdAt': '2026-10-03T10:00:00+08:00', 'commitSha': 'a' * 40}]}})
    result = collector.collect_preview_deploys('project', '2026-09-28', '2026-10-04')
    assert result['items'][0]['commitSha'] == 'a' * 40
    assert '不等于正式发布' in result['note']


def test_monitoring_and_code_review_are_not_feature_acceptance(collector, monkeypatch):
    records=[{'id':'notice','createdAt':'2026-10-03T10:00:00Z','title':'监控通知'},
             {'id':'review','createdAt':'2026-10-03T10:00:00Z','reportType':'code-review','verdict':'fail'},
             {'id':'legacy','createdAt':'2026-10-03T10:00:00Z','verdict':'fail','title':'旧验收'},
             {'id':'typed','createdAt':'2026-10-03T10:00:00Z','reportType':'acceptance','verdict':'pass'}]
    monkeypatch.setattr(collector,'_cdscli',lambda args:{'ok':True,'data':records})
    calls=[]
    monkeypatch.setattr(collector,'acceptance_deeplink',lambda rid:calls.append(rid) or 'https://example.test/'+rid)
    result=collector.collect_acceptance('project','2026-09-28','2026-10-04')
    assert result['count']==2 and result['tally']['fail']==1
    assert set(calls)=={'legacy','typed'}
    assert result['unclassifiedRecords']==records[:2]


def test_same_run_source_binding_and_published_checkpoint_apply_before_git(adapter, repository):
    repo, commit = repository
    base = git(repo, 'rev-parse', 'HEAD')
    sha = commit('repair without title inference', '2026-09-29')
    seed = adapter.empty_ledger()
    seed['workItems']=[{'id':'task','title':'同一事项'}]
    seed['evidenceBindings']={sha:'task'}
    seed['collection']={'head':base,'repository':'https://github.com/example/project','mainline':'origin/main'}
    ctx=context(sourceEvidence=seed,prevWeekly={'available':True,'prevEntry':{'metadata':{'deliveryEvidenceStatus':'verified','deliveryEvidenceLedger':json.dumps(seed)}}})
    result,coverage=adapter.collect_context_evidence(ctx,adapter.empty_ledger(),repo,'origin/main',sha)
    event=next(e for e in result['events'] if e['id']=='git-'+sha)
    assert event['workItemId']=='task'
    assert coverage['collection']['base']==base
    assert adapter.engine()['analyze'](result,'2026-09-28','2026-10-04')['items'][0]['current']['code']=='in_progress'
