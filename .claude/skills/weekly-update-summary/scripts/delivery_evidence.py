"""原周报技能的来源→连续台账适配器；只采用显式身份与有范围的阶段证据。"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import runpy
import subprocess
import tempfile
from urllib.parse import urlparse


def engine():
    return runpy.run_path(str(Path(__file__).resolve().parents[4] / 'scripts/reporting/evidence.py'))


def empty_ledger():
    return {'schemaVersion': 1, 'historyComplete': False, 'workItems': [], 'events': [], 'measurements': [], 'limitations': []}


def _git(repo, *args):
    return subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()


def _hash(value):
    return hashlib.sha256(value.encode()).hexdigest()


def default_ledger_path(repo, project):
    common = Path(_git(repo, 'rev-parse', '--git-common-dir'))
    if not common.is_absolute():
        common = (Path(repo) / common).resolve()
    return common / 'report-skills' / (_hash(project)[:16] + '.json')


def read_ledger(path):
    p = Path(path)
    return engine()['normalize'](json.loads(p.read_text())) if p.exists() else empty_ledger()


def write_ledger(path, ledger):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    # 先校验再原子替换；输入冲突、磁盘错误或中断不破坏本期已保存台账。
    blob = json.dumps(engine()['normalize'](ledger), ensure_ascii=False, indent=2) + '\n'
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as f:
        temporary = Path(f.name)
        f.write(blob)
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def _canonical_repo(repo):
    remote = _git(repo, 'remote', 'get-url', 'origin')
    match = re.fullmatch(r'(?:https://github.com/|git@github.com:)([^/]+/[^/]+?)(?:\.git)?', remote)
    if not match:
        raise ValueError('Git来源只支持可核查的GitHub origin，不猜测提交链接')
    return 'https://github.com/' + match[1]


def _closing_identity(body, repository):
    """独立 closing 行的单个明确事项；普通 mentions、多事项和代码块不作身份。"""
    found = set()
    fence = False
    for line in (body or '').splitlines():
        if line.lstrip().startswith(('```', '~~~')):
            fence = not fence
            continue
        if fence:
            continue
        match = re.fullmatch(r'\s*(?:[-*]\s*)?(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(https://github\.com/[\w.-]+/[\w.-]+/issues/\d+|[\w.-]+/[\w.-]+#\d+|#\d+)\s*[.]?\s*', line, re.I)
        if match:
            ref = match[1]
            if ref.startswith('#'):
                ref = repository + '/issues/' + ref[1:]
            elif not ref.startswith('https://'):
                slug, number = ref.split('#')
                ref = 'https://github.com/' + slug + '/issues/' + number
            found.add(ref)
    return next(iter(found)) if len(found) == 1 else None


def collect_git_ledger(repo, mainline, head, start, end, prior, pull_requests=None, git_base=None):
    if _git(repo, 'rev-parse', '--is-shallow-repository') != 'false':
        raise ValueError('浅克隆不能建立连续提交证据，请补全历史')
    if not mainline:
        try:
            mainline = _git(repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
        except subprocess.CalledProcessError:
            mainline = 'origin/main'
    if not mainline.startswith('origin/'):
        raise ValueError('主干必须使用固定的 origin/<默认分支>，不能用当前feature分支')
    resolved = _git(repo, 'rev-parse', mainline + '^{commit}')
    if not head:
        lines = _git(repo, 'log', '--first-parent', '--format=%H%x09%cd', '--date=short', resolved).splitlines()
        head = next((line.split('\t')[0] for line in lines if line.split('\t')[1] <= end), None)
        if not head:
            raise ValueError('截止日期之前没有可确定的主干提交')
    head = _git(repo, 'rev-parse', head + '^{commit}')
    _git(repo, 'merge-base', '--is-ancestor', head, resolved)
    repository = _canonical_repo(repo)
    prior_collection = prior.get('collection') or {}
    base = git_base or prior_collection.get('head')
    if prior_collection.get('repository') not in (None, repository):
        raise ValueError('台账来源仓库与当前origin不一致，拒绝混入另一项目')
    if git_base:
        base = _git(repo, 'rev-parse', git_base + '^{commit}')
        _git(repo, 'merge-base', '--is-ancestor', base, head)
    elif base:
        # 历史回放可以选更早head；绝不回退/改写后来已经成功采集的水位线。
        try:
            _git(repo, 'merge-base', '--is-ancestor', base, head)
        except subprocess.CalledProcessError:
            _git(repo, 'merge-base', '--is-ancestor', head, base)
            return empty_ledger() | {'collection': prior_collection, 'limitations': ['正在回放早于已存水位线的历史窗口；未后退水位线，展示仍按事件时间过滤。']}
    else:
        lines = _git(repo, 'log', '--first-parent', '--format=%H%x09%cd', '--date=short', head).splitlines()
        base = next((line.split('\t')[0] for line in lines if line.split('\t')[1] < start), None)
    revision_range = base + '..' + head if base else head
    commits = _git(repo, 'rev-list', '--reverse', '--topo-order', revision_range).splitlines()
    bindings = prior.get('evidenceBindings') or {}
    prs_by_sha = {}
    for pr in pull_requests or []:
        sha = pr.get('merge_commit_sha') or pr.get('mergeCommitSha')
        if sha and (pr.get('merged') is True or pr.get('merged_at') or pr.get('mergedAt')) and (pr.get('base') or {}).get('ref', mainline[7:]) == mainline[7:]:
            prs_by_sha[sha] = pr
    out = empty_ledger()
    items = {}
    old_events = {event['id']: event for event in prior.get('events', [])}
    inherited = {}
    for sha, pr in prs_by_sha.items():
        if sha not in commits:
            continue
        work = _closing_identity(pr.get('body') or '', repository)
        parents = _git(repo, 'show', '-s', '--format=%P', sha).split()
        if work and len(parents) > 1:
            for child in _git(repo, 'rev-list', sha + '^1..' + sha + '^2').splitlines():
                inherited.setdefault(child, set()).add(work)
    for sha in commits:
        body = _git(repo, 'show', '-s', '--format=%B', sha)
        when = _git(repo, 'show', '-s', '--format=%cI', sha)
        parents = _git(repo, 'show', '-s', '--format=%P', sha).split()
        subject = body.splitlines()[0] if body.splitlines() else '代码活动'
        pr = prs_by_sha.get(sha)
        pr_number = (pr or {}).get('number')
        if pr_number is None:
            match = re.search(r'(?:Merge pull request #|\(#)(\d+)', subject)
            pr_number = match[1] if match else None
        work_id = bindings.get(sha) or (bindings.get('pr:' + str(pr_number)) if pr_number else None)
        work_id = work_id or (next(iter(inherited[sha])) if len(inherited.get(sha, [])) == 1 else None)
        work_id = work_id or _closing_identity(((pr or {}).get('body') or '') + '\n' + body, repository)
        saved = old_events.get('git-' + sha)
        if saved:
            if saved.get('revision') != sha or saved.get('source', {}).get('uri') != repository + '/commit/' + sha:
                raise ValueError('已存Git证据与不可变提交来源冲突')
            if saved.get('workItemId') and work_id and saved['workItemId'] != work_id:
                raise ValueError('同一提交的已存事项与本次明确关联冲突，需要人工核查')
            out['events'].append(deepcopy(saved))
            # 旧快照保留原文与身份；后补身份不能默默篡改已存事件。
            continue
        if work_id:
            old = next((x for x in prior.get('workItems', []) if x['id'] == work_id), None)
            items[work_id] = old or {'id': work_id, 'title': (pr or {}).get('workItemTitle') or '关联事项 ' + work_id.rsplit('/', 1)[-1]}
        out['events'].append({'id': 'git-' + sha, 'workItemId': work_id, 'kind': 'merged' if len(parents) > 1 or pr else 'commit',
                              'revision': sha, 'occurredAt': when,
                              'source': {'uri': repository + '/commit/' + sha, 'excerpt': body,
                                         'prNumber': str(pr_number) if pr_number else None}})
    for pr in pull_requests or []:
        if pr.get('merged') is True or pr.get('merged_at') or pr.get('mergedAt'):
            continue
        work_id = _closing_identity(pr.get('body') or '', repository)
        when = pr.get('updated_at') or pr.get('updatedAt') or pr.get('created_at') or pr.get('createdAt')
        if not pr.get('number') or not when:
            continue
        text = json.dumps({key: pr.get(key) for key in ('number', 'title', 'body', 'state', 'draft', 'updated_at', 'created_at')}, ensure_ascii=False)
        if work_id:
            items.setdefault(work_id, next((item for item in prior.get('workItems', []) if item['id'] == work_id), None)
                             or {'id': work_id, 'title': pr.get('workItemTitle') or '关联事项 ' + work_id.rsplit('/', 1)[-1]})
        out['events'].append({'id': 'pr-observed-' + _hash(str(pr['number']) + ':' + when + ':' + text),
                              'workItemId': work_id, 'kind': 'observation', 'occurredAt': when, 'timeBasis': 'observed',
                              'source': {'uri': pr.get('html_url') or repository + '/pull/' + str(pr['number']),
                                         'excerpt': text, 'prNumber': str(pr['number']), 'integration': '尚未合并，不是主干交付'}})
    # 复用旧Git事件时，相应事项仍由prior提供给merge；适配器本体也保持自洽。
    for event in out['events']:
        if event.get('workItemId') and event['workItemId'] not in items:
            old_item = next((item for item in prior.get('workItems', []) if item['id'] == event['workItemId']), None)
            if old_item:
                items[event['workItemId']] = old_item
    out['workItems'] = list(items.values())
    out['collection'] = {'base': base, 'head': head, 'repository': repository, 'mainline': mainline}
    out['limitations'].append('Git只证明开发/主干整合；没有显式任务身份的记录保持未归属，完成、验证、生产上线分别需要独立来源。')
    return out


def _typed_ledger(value):
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return None
    return value if isinstance(value, dict) and value.get('schemaVersion') == 1 else None


def context_ledger(context, prior):
    """原采集器真实响应的有限字段适配，不从标题、verdict总数或日报语言推交付。"""
    out = empty_ledger()
    fragments = [out]
    for source_name in ('dailyReports', 'acceptance', 'releases', 'previewDeploys', 'defects', 'teamInsights', 'adoption'):
        source = context.get(source_name) or {}
        if not source.get('available'):
            out['limitations'].append(f"{source_name}：{source.get('reason') or '本次未取得来源'}；不能按无活动或无风险处理。")
        out['limitations'].extend((source.get('coverage') or {}).get('warnings') or [])
    for key in ('sourceEvidence', 'evidenceLedger'):
        if context.get(key):
            typed = _typed_ledger(context[key])
            if typed:
                fragments.append(typed)
            else:
                raise ValueError('补充证据台账不是受支持的schemaVersion=1结构')
    previous = context.get('prevWeekly') or {}
    for key in ('prevEntry', 'currentEntry'):
        metadata = (previous.get(key) or {}).get('metadata') or {}
        if metadata.get('deliveryEvidenceStatus') == 'pending':
            out['limitations'].append('已发布周报条目仍为pending，正文与台账未核验，不推进发布快照。')
            continue
        typed = _typed_ledger(metadata.get('deliveryEvidenceLedger'))
        if typed:
            fragments.append(typed)
        elif metadata.get('deliveryEvidenceLedger'):
            out['limitations'].append('已发布周报的事项台账无法校验，未把旧正文当成已证实成果。')
    for source_name in ('dailyReports', 'acceptance', 'releases'):
        for row in (context.get(source_name) or {}).get('items') or []:
            metadata = row.get('metadata') or {}
            if metadata.get('deliveryEvidenceStatus') == 'pending':continue
            for key in ('deliveryEvidenceLedger', 'deliveryLedger', 'evidenceLedger'):
                if metadata.get(key):
                    typed = _typed_ledger(metadata[key])
                    if typed:fragments.append(typed)
                    else:out['limitations'].append(f'{source_name}中的{key}无法校验，未将旧正文或损坏元数据当作完成证据。')
    known = engine()['merge_ledgers']([prior, *fragments])
    items = {i['id']: i for i in known.get('workItems', [])}
    artifact_bindings = known.get('artifactBindings') or {}
    for source_name in ('dailyReports', 'acceptance', 'releases'):
        for row in (context.get(source_name) or {}).get('items') or []:
            metadata = row.get('metadata') or {}
            if metadata.get('deliveryEvidenceStatus') == 'pending':
                out['limitations'].append(f'{source_name}记录{row.get("entryId") or row.get("id")}仍为pending，正文与台账未核验，不当作成功发布。')
                continue
            record_id = row.get('entryId') or row.get('id') or row.get('releaseId')
            source_uri = row.get('sourceUrl') or row.get('deeplink') or row.get('shareUrl')
            excerpt = row.get('excerpt') or row.get('content') or row.get('summary') or row.get('title')
            when = row.get('occurredAt') or row.get('finishedAt') or row.get('updatedAt') or row.get('createdAt')
            if not record_id or not source_uri or not excerpt or not when:
                out['limitations'].append(f'{source_name}记录{record_id or "未知ID"}缺少链接、原文或带时区时间；保留在原始采集段，不据此认证交付。')
                continue
            binding = artifact_bindings.get(source_name + ':' + str(record_id)) or {}
            if isinstance(binding, str):
                binding = {'workItemIds': [binding]}
            work_ids = row.get('workItemIds') or binding.get('workItemIds') or ([row['workItemId']] if row.get('workItemId') else [])
            revision = row.get('revision') or (row.get('commitSha') if re.fullmatch(r'[0-9a-fA-F]{40}|[0-9a-fA-F]{64}', row.get('commitSha') or '') else None)
            scope = row.get('scope') or binding.get('scope')
            environment = row.get('environment') or binding.get('environment')
            kind = 'observation'
            if source_name == 'acceptance' and scope in ('feature', 'ci') and revision:
                if row.get('verdict') in ('pass', 'fail'):
                    kind = 'validation_passed' if row['verdict'] == 'pass' else 'validation_failed'
            elif source_name == 'releases' and revision and environment == 'production':
                if row.get('status') in ('success', 'failed'):
                    kind = 'release_succeeded' if row['status'] == 'success' else 'release_failed'
            if source_name == 'releases' and row.get('status') in ('rollback_success', 'rollback_failed'):
                original = next((event for event in prior.get('events', [])
                                 if event.get('kind') == 'release_succeeded'
                                 and (event.get('source') or {}).get('recordId') == row.get('rollbackOf')
                                 and row.get('rollbackOf')), None)
                if row['status'] == 'rollback_success' and original:
                    kind, revision, environment = 'release_failed', original['revision'], 'production'
                    work_ids = [original.get('workItemId')]
                    excerpt = '正式发布记录确认已回滚该版本；不再作为当前版本已上线依据。\n' + excerpt
                else:
                    out['limitations'].append(f'正式发布记录{record_id}报告回滚结果{row["status"]}，未找到可核对的原发布版本；当前生产状态需复核，不按新增上线统计。')
            if kind == 'observation' and source_name in ('acceptance', 'releases'):
                out['limitations'].append(f'{source_name}记录{record_id}未提供明确范围/版本/环境，不能把报告通过或发布尝试当作事项验证或上线完成。')
            for work_id in work_ids or [None]:
                if work_id and work_id not in items:
                    items[work_id] = {'id': work_id, 'title': row.get('workItemTitle') or '关联事项 ' + work_id.rsplit('/', 1)[-1]}
                source = {'uri': source_uri, 'excerpt': excerpt, 'recordId': str(record_id), 'contentSha256': row.get('contentSha256') or _hash(excerpt)}
                event = {'id': 'artifact-' + _hash(source_name + ':' + str(record_id) + ':' + str(work_id) + ':' + kind + ':' + str(revision) + ':' + when + ':' + _hash(excerpt)),
                         'workItemId': work_id, 'kind': kind, 'revision': revision, 'occurredAt': when,
                         'timeBasis': row.get('timeBasis') or ('occurred' if row.get('occurredAt') or row.get('finishedAt') else 'observed'), 'source': source}
                if scope in ('feature', 'ci'): event['scope'] = scope
                if environment in ('production', 'preview'): event['environment'] = environment
                out['events'].append(event)
    out['workItems'] = list(items.values())
    return engine()['merge_ledgers'](fragments)


def collect_context_evidence(context, prior, repo='.', mainline='', head=None, pull_requests=None, git_base=None):
    known = engine()['merge_ledgers']([prior, context_ledger(context, prior)])
    parts = [known]
    try:
        git_data = collect_git_ledger(repo, mainline, head, context['weekStart'], context['weekEnd'], known, pull_requests, git_base)
        parts.append(git_data)
        coverage = {'available': True, 'collection': git_data['collection']}
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        coverage = {'available': False, 'reason': str(error)}
        parts.append(empty_ledger() | {'limitations': ['Git采集失败，保留已存事实与水位线：' + str(error)]})
    ledger = engine()['merge_ledgers'](parts)
    if coverage['available']:
        ledger['collection'] = coverage['collection']
    elif prior.get('collection'):
        ledger['collection'] = prior['collection']
    return ledger, coverage
