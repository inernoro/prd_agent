#!/usr/bin/env python3
"""Project-scoped, read-only recovery observations; never performs a restore.

See doc/guide.cds.deploy-three-paths.md P0-05. Output belongs outside Git.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import signal
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

ACTIVE_STATUSES = ('pending', 'queued', 'preparing', 'building', 'starting', 'verifying')
RUN_STATUSES = ACTIVE_STATUSES + ('running', 'failed', 'cancelled')
MAX_BODY = 4 * 1024 * 1024


def text(value):
    return isinstance(value, str) and len(value) <= 1024 and not any(ord(c) < 32 for c in value)


def number(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def identifier(value):
    return isinstance(value, str) and re.fullmatch(r'[a-zA-Z0-9_.-]{1,120}', value) is not None


def image(value):
    return text(value) and re.fullmatch(r'[a-zA-Z0-9_./:@${}-]*', value) is not None and '://' not in value and ('@' not in value or re.search(r'@sha256:[a-fA-F0-9]{64}$', value) is not None)


def route_match(value):
    return text(value) and not any(c in value for c in ('?', '#', '@', '=', '&')) and not any(c.isspace() for c in value)


def project_fields(source, fields):
    if not isinstance(source, dict): raise ValueError('invalid_shape')
    result = {}
    for key, check in fields.items():
        if key in source:
            # API producers have historically materialized optional absence as null.
            # Keep this fact; do not convert it to persisted default semantics.
            if source[key] is not None and not check(source[key]): raise ValueError('invalid_field')
            result[key] = source[key]
    return result


def strings(value):
    return isinstance(value, list) and len(value) < 500 and all(text(x) for x in value)


def modes(value):
    return isinstance(value, dict) and len(value) < 500 and all(identifier(k) and (v == '' or identifier(v)) for k, v in value.items())


def resources(value):
    if value is None: return None
    return project_fields(value, {'memoryMB': number, 'cpus': number})


PROFILE_FIELDS = {k: text for k in ('id', 'projectId', 'dockerImage', 'activeDeployMode', 'subdomain', 'role', 'replacementStrategy', 'prebuiltCommitPolicy')}
PROFILE_FIELDS.update({'dockerImage': image, 'activeDeployMode': lambda v: v == '' or identifier(v), 'containerPort': number, 'prebuiltImage': lambda v: type(v) is bool, 'pathPrefixes': strings, 'dependsOn': strings, 'calls': strings})


def profile(source, scoped=True):
    result = project_fields(source, PROFILE_FIELDS)
    if scoped and (not identifier(result.get('id')) or not identifier(result.get('projectId'))): raise ValueError('invalid_identity')
    if 'resources' in source: result['resources'] = resources(source['resources'])
    if 'deployModes' in source:
        value = source['deployModes']
        if value is None: result['deployModes'] = None
        else:
            if not isinstance(value, dict) or len(value) >= 500: raise ValueError('invalid_modes')
            result['deployModes'] = {}
            for key, mode in value.items():
                if not identifier(key): raise ValueError('invalid_identity')
                fields = {k: v for k, v in PROFILE_FIELDS.items() if k not in ('id', 'projectId')}
                fields.update({'prebuilt': lambda v: type(v) is bool, 'commitPolicy': text})
                result['deployModes'][key] = project_fields(mode, fields)
                if 'resources' in mode: result['deployModes'][key]['resources'] = resources(mode['resources'])
    return result


def scope_list(body, key, project_id, limit=500):
    if not isinstance(body, dict) or not isinstance(body.get(key), list): raise ValueError('missing_collection')
    items = body[key]
    for flag in ('truncated', 'hasMore'):
        if flag in body and body[flag] is not False: raise ValueError('source_limit')
    if any(body.get(key) is not None for key in ('pagination', 'nextPage', 'nextCursor')): raise ValueError('source_limit')
    if 'total' in body and (type(body['total']) is not int or body['total'] != len(items)): raise ValueError('source_limit')
    # Equal to the cap cannot establish that the source wasn't truncated.
    if len(items) >= limit: raise ValueError('source_limit')
    seen = set()
    for item in items:
        if not isinstance(item, dict) or item.get('projectId') != project_id: raise ValueError('scope_mismatch')
        item_id = item.get('id')
        if not identifier(item_id) or item_id in seen: raise ValueError('invalid_identity')
        seen.add(item_id)
    return sorted(items, key=lambda x: x['id'])


def branch(source, project_id, branch_id):
    if not isinstance(source, dict) or source.get('id') != branch_id or source.get('projectId') != project_id: raise ValueError('scope_mismatch')
    result = project_fields(source, {k: text for k in ('id', 'projectId', 'branch', 'createdAt', 'status', 'githubCommitSha', 'deploymentTargetSha', 'pinnedCommit', 'currentVersionId', 'lastDeploymentRunId', 'executorId')})
    for key in ('subdomainAliases', 'customDomains'):
        if key in source: result[key] = project_fields(source, {key: strings})[key]
    for key in ('profileOverrides', 'services'):
        if key == 'profileOverrides' and key not in source: continue
        values = source.get(key)
        if key == 'profileOverrides' and values is None:
            result[key] = None; continue
        if not isinstance(values, dict) or len(values) >= 500: raise ValueError('missing_collection')
        result[key] = {}
        for service_id, value in sorted(values.items()):
            if not identifier(service_id): raise ValueError('invalid_identity')
            if key == 'profileOverrides': result[key][service_id] = profile(value, scoped=False)
            else:
                fields = {k: text for k in ('profileId', 'containerName', 'containerId', 'status', 'deployedMode', 'deployedImage', 'deployedArtifactRef', 'deployedCommitSha')}
                fields.update({'deployedImage': image, 'deployedArtifactRef': image, 'hostPort': number, 'deployedPrebuilt': lambda v: type(v) is bool})
                projected = project_fields(value, fields)
                if projected.get('profileId') != service_id or not text(projected.get('status')): raise ValueError('invalid_identity')
                result[key][service_id] = projected
    if 'extraProfiles' in source:
        if source['extraProfiles'] is None: result['extraProfiles'] = None
        else:
            values = scope_list({'profiles': source['extraProfiles']}, 'profiles', project_id)
            result['extraProfiles'] = [profile(x) for x in values]
    return result


def candidate(source, project_id, branch_id):
    fields = {k: text for k in ('operationId', 'targetSha', 'configHash', 'networkName', 'phase', 'servingControlFingerprint')}
    fields.update({'createIntents': strings, 'stopBeforeStart': strings})
    result = project_fields(source, fields)
    if result.get('phase') not in ('prepared', 'starting', 'ready', 'switch-intent', 'routed', 'rollback-intent', 'rollback-verified', 'reconciling', 'released'): raise ValueError('invalid_field')
    for key in ('serving', 'services'):
        result[key] = branch({'id': branch_id, 'projectId': project_id, 'services': source.get(key)}, project_id, branch_id)['services']
    if 'networkCreation' in source:
        value = source['networkCreation']
        result['networkCreation'] = project_fields(value, {'intent': lambda v: v is True})
        if 'identity' in value: result['networkCreation']['identity'] = project_fields(value['identity'], {'id': text, 'fingerprint': text})
    if 'createdContainers' in source:
        value = source['createdContainers']
        if not isinstance(value, dict) or len(value) >= 500: raise ValueError('invalid_shape')
        result['createdContainers'] = {}
        for key, value in sorted(value.items()):
            if not identifier(key): raise ValueError('invalid_identity')
            result['createdContainers'][key] = project_fields(value, {'id': text, 'image': image, 'fingerprint': text})
    return result


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def stamp():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def collect(project_id, get):
    if not identifier(project_id): raise ValueError('invalid_project')
    output = {'version': 1, 'projectId': project_id, 'startedAt': stamp(), 'status': 'incomplete',
              'meaning': 'two-read-api-projection-not-transaction-or-daemon-proof',
              'completeness': 'bounded-observation-only',
              'omissions': ['secrets-and-commands', 'unexposed-persisted-fields', 'infra-and-databases', 'deployment-versions', 'replica-sets', 'pending-journal', 'daemon-inspect', 'forwarder-applied-mapping'],
              'frames': [], 'requests': [], 'gaps': []}
    def read(path):
        receipt = {'round': len(output['frames']) + 1, 'path': path, 'startedAt': stamp(), 'status': 'unknown'}
        output['requests'].append(receipt)
        try:
            result = get(path); receipt['status'] = 'received'; return result
        except Exception:
            receipt['status'] = 'request_failed'; raise ValueError('request_failed') from None
        finally: receipt['finishedAt'] = stamp()
    for _ in range(2):
        frame = {}
        try:
            source = read('/api/projects/'+project_id)
            if not isinstance(source, dict) or source.get('id') != project_id: raise ValueError('scope_mismatch')
            fields = {k: text for k in ('id', 'slug', 'kind', 'createdAt', 'gitDefaultBranch', 'previewMode', 'deliveryMode', 'infraIsolation', 'githubRepoFullName')}
            fields.update({k: lambda v: type(v) is bool for k in ('githubAutoDeploy', 'agentPrebuiltOnly', 'paused', 'inheritGlobalEnv', 'githubBotPushFilterEnabled', 'autoSmokeEnabled')})
            fields.update({k: number for k in ('autoPublishAfterMinutes', 'autoStopAfterMinutes', 'deployReadinessFloorSeconds')})
            fields.update({'defaultBranch': lambda v: v is None or text(v), 'defaultDeployModes': modes})
            frame['project'] = project_fields(source, fields)
            if 'githubEventPolicy' in source:
                frame['project']['githubEventPolicy'] = None if source['githubEventPolicy'] is None else project_fields(source['githubEventPolicy'], {k: lambda v: type(v) is bool for k in ('push', 'delete', 'prClose', 'prOpen', 'slashCommand')})
            frame['profiles'] = [profile(x) for x in scope_list(read('/api/build-profiles?project='+project_id), 'profiles', project_id)]
            frame['rules'] = [project_fields(x, {k: text for k in ('id', 'projectId', 'type', 'branch')} | {'match': route_match, 'priority': lambda v: type(v) in (int, float) and math.isfinite(v), 'enabled': lambda v: type(v) is bool}) for x in scope_list(read('/api/routing-rules?project='+project_id), 'rules', project_id)]
            listed = scope_list(read('/api/branches?project='+project_id), 'branches', project_id, limit=20)
            frame['branches'] = [branch(read('/api/branches/'+x['id']).get('branch'), project_id, x['id']) for x in listed]
            frame['activeRuns'] = []; frame['terminalReservations'] = []; seen = set(); branch_ids = {x['id'] for x in listed}
            for status in RUN_STATUSES:
                path = '/api/deployment-runs?project='+project_id+'&status='+status+'&limit=200'
                for run in scope_list(read(path), 'runs', project_id, limit=200):
                    if run.get('status') != status or run.get('branchId') not in branch_ids or run['id'] in seen: raise ValueError('run_scope_mismatch')
                    seen.add(run['id'])
                    item = project_fields(run, {k: text for k in ('id', 'projectId', 'branchId', 'status', 'phase', 'operationId', 'commitSha', 'versionId', 'configHash', 'executorId')})
                    if 'candidate' in run:
                        item['candidate'] = candidate(run['candidate'], project_id, run['branchId'])
                    if status in ACTIVE_STATUSES: frame['activeRuns'].append(item)
                    elif item.get('candidate', {}).get('phase') not in (None, 'released'): frame['terminalReservations'].append(item)
            frame['activeRuns'].sort(key=lambda x: x['id'])
            frame['terminalReservations'].sort(key=lambda x: x['id'])
        except ValueError as error:
            allowed = {'invalid_shape', 'invalid_field', 'invalid_identity', 'invalid_modes', 'missing_collection', 'source_limit', 'scope_mismatch', 'run_scope_mismatch', 'request_failed'}
            output['gaps'].append({'round': len(output['frames'])+1, 'code': str(error) if str(error) in allowed else 'invalid_response'})
        except Exception:
            output['gaps'].append({'round': len(output['frames'])+1, 'code': 'invalid_response'})
        output['frames'].append(frame)
    output['frameDigests'] = [hashlib.sha256(canonical(frame)).hexdigest() for frame in output['frames']]
    if not output['gaps']: output['status'] = 'observed-stable' if output['frameDigests'][0] == output['frameDigests'][1] else 'drifted'
    output['finishedAt'] = stamp()
    return output


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        fp.close()
        raise ValueError('redirect_forbidden')


@contextlib.contextmanager
def absolute_timeout(seconds):
    # This Unix operator CLI owns its timer; do not interfere with an embedding host.
    if threading.current_thread() is not threading.main_thread() or not hasattr(signal, 'setitimer') or signal.getitimer(signal.ITIMER_REAL)[0]: raise ValueError('timer_unavailable')
    previous = signal.getsignal(signal.SIGALRM)
    def expired(*_): raise TimeoutError('request_deadline')
    signal.signal(signal.SIGALRM, expired); signal.setitimer(signal.ITIMER_REAL, seconds)
    try: yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0); signal.signal(signal.SIGALRM, previous)


def getter(base, headers, request_timeout=5, total_timeout=60):
    url = urllib.parse.urlsplit(base)
    if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password or url.query or url.fragment: raise ValueError('invalid_host')
    opener = urllib.request.build_opener(NoRedirect())
    deadline = time.monotonic()+total_timeout
    def get(path):
        if not path.startswith('/api/') or '://' in path: raise ValueError('invalid_path')
        request = urllib.request.Request(base.rstrip('/')+path, headers=headers, method='GET')
        remaining = min(request_timeout, deadline-time.monotonic())
        if remaining <= 0: raise TimeoutError('collection_deadline')
        try:
            with absolute_timeout(remaining), opener.open(request, timeout=remaining) as response:
                if response.status != 200: raise ValueError('http_status')
                raw = response.read(MAX_BODY+1)
                if len(raw) > MAX_BODY: raise ValueError('body_limit')
                return json.loads(raw)
        except urllib.error.HTTPError as error:
            error.close()
            raise ValueError('http_status') from None
    return get


def save_new(path, value):
    data = canonical(value)+b'\n'
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(fd, 'wb') as output: output.write(data)


def external_output(path):
    # Resolve parent links before testing Git ancestry; the final leaf stays exclusive.
    parent = path.absolute().parent.resolve(strict=True)
    if any((root/'.git').exists() for root in (parent, *parent.parents)): raise ValueError('output_in_git')
    return parent/path.name


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        args.output = external_output(args.output)
        if not identifier(args.project): raise ValueError('invalid_project')
        if args.output.exists() or args.output.is_symlink(): raise FileExistsError('output_exists')
        cli_path = Path(__file__).resolve().parents[2]/'.claude/skills/cds/cli/cdscli.py'
        spec = importlib.util.spec_from_file_location('cdscli', cli_path)
        cli = importlib.util.module_from_spec(spec); spec.loader.exec_module(cli)
        with cli._nested_call():
            try: cli.cmd_auth_inspect(argparse.Namespace(strict=True))
            except SystemExit as exit_status:
                if exit_status.code != 0: raise ValueError('credentials_invalid') from None
        if not cli._NESTED_PAYLOAD or cli._NESTED_PAYLOAD.get('ok') is not True: raise ValueError('credentials_invalid')
        if os.environ.get('CDS_PROJECT_ID') and os.environ['CDS_PROJECT_ID'] != args.project: raise ValueError('credential_scope_mismatch')
        headers = cli._auth_headers()
        if not headers.get('X-AI-Access-Key'): raise ValueError('credentials_missing')
        result = collect(args.project, getter(cli._cds_base(), headers))
        save_new(args.output, result)
        print(json.dumps({'status': result['status'], 'projectId': args.project, 'gaps': result['gaps'], 'output': str(args.output)}))
        return 0 if result['status'] == 'observed-stable' else 2
    except (Exception, SystemExit):
        # Neither provider error text nor authentication helper payload escapes.
        print(json.dumps({'status': 'failed', 'code': 'snapshot_not_saved'}))
        return 2


if __name__ == '__main__': sys.exit(main())
