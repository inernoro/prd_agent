#!/usr/bin/env python3
"""Commit-addressed web bundles. Published bundles are reused, never replaced.

GitHub Releases own retention; Pages is only a replaceable presentation layer.
Downloads are public and never carry the workflow token across redirects.
"""
import argparse
import datetime
import http.client
import uuid
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import shlex
import subprocess
import sys
import tempfile
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile


class ArtifactError(Exception):
    def __init__(self, message, code='artifact_error'):
        super().__init__(message)
        self.code = code


def checked_ref(ref):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,119}", ref) or ref == "latest":
        raise ArtifactError("A fixed SHA or release tag is required; latest remains a compatibility channel")
    if ref.startswith("sha-") and not re.fullmatch(r"sha-[0-9a-f]{40}", ref):
        raise ArtifactError("Commit reference must contain the full lowercase SHA")
    return ref


def names(ref):
    checked_ref(ref)
    return [f"prd-admin-dist-{ref}.zip", f"prd-admin-dist-{ref}.zip.sha256", f"release-manifest-{ref}.json"]


def urls(repo, ref, base=None):
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        raise ArtifactError("Invalid repository identity")
    if base is None:
        base = f"https://github.com/{repo}/releases/download/web-{checked_ref(ref)}"
        prefix = os.environ.get("PRD_AGENT_RELEASE_DOWNLOAD_PREFIX", "")
        if prefix:
            base = prefix.rstrip("/") + "/" + base
    return [base.rstrip("/") + "/" + name for name in names(ref)]


# Artifact transport audit only. Bodies/credentials are never persisted.
_AUDIT_CONTEXT = {}
_AUDIT_TRACE = uuid.uuid4().hex
_AUDIT_SNAPSHOT_LIMIT = 4096

class AuditPersistenceError(ArtifactError):
    pass


def _safe_label(value, pattern=r'[A-Za-z0-9_.:/-]{1,180}'):
    return value if isinstance(value, str) and re.fullmatch(pattern, value) else None


def _audit_context():
    values = {'application': 'map-release-artifacts', 'jobId': os.environ.get('GITHUB_JOB'), 'projectId': os.environ.get('CDS_PROJECT_ID') or os.environ.get('GITHUB_REPOSITORY') or _AUDIT_CONTEXT.get('repo'), 'releaseId': os.environ.get('CDS_RELEASE_ID'),
              'branchId': os.environ.get('CDS_BRANCH_ID'), 'targetId': os.environ.get('CDS_TARGET_ID'),
              'sourceCommit': os.environ.get('CDS_COMMIT_SHA') or os.environ.get('GITHUB_SHA'),
              'repo': os.environ.get('GITHUB_REPOSITORY'), 'runId': os.environ.get('GITHUB_RUN_ID'),
              'runAttempt': os.environ.get('GITHUB_RUN_ATTEMPT')}
    values.update({key: _AUDIT_CONTEXT[key] for key in ['repo', 'ref', 'sourceCommit'] if key in _AUDIT_CONTEXT})
    return {key: _safe_label(value) for key, value in values.items()}


def _audit_path():
    explicit = os.environ.get('PRD_AGENT_ARTIFACT_AUDIT_PATH') or os.environ.get('PRD_AGENT_ARTIFACT_DIAGNOSTICS')
    if explicit:
        return Path(explicit)
    root = Path(os.environ.get('PRD_AGENT_RELEASE_EVIDENCE_DIR') or Path.home() / 'prd-agent-release-evidence')
    identity = _safe_label(os.environ.get('CDS_RELEASE_ID'), r'[A-Za-z0-9_-]{1,100}') or _AUDIT_TRACE
    return root / f'{identity}-{os.getpid()}.artifact-audit.jsonl'


def _trace_id():
    return (_safe_label(os.environ.get('PRD_AGENT_ARTIFACT_AUDIT_REQUEST_ID'))
            or _safe_label(os.environ.get('CDS_RELEASE_ID'))
            or _AUDIT_TRACE)


def _safe_endpoint(url):
    if not url.startswith(('https://', 'http://')):
        url = 'https://api.github.com/' + url.lstrip('/')
    parts = urllib.parse.urlsplit(url)
    path = parts.path
    if parts.hostname not in {'api.github.com', 'uploads.github.com', 'github.com'}:
        path = '/[path-sha256:' + hashlib.sha256(path.encode()).hexdigest()[:16] + ']'
    return f'{parts.scheme}://{parts.hostname or "unknown"}{path}'


def _field_state(mapping, name, expected_type, pattern=None):
    if not isinstance(mapping, dict):
        return {'state': 'container_type_error', 'type': type(mapping).__name__}
    if name not in mapping:
        return {'state': 'missing'}
    value = mapping[name]
    result = {'type': type(value).__name__}
    if value is None: result['state'] = 'null'
    elif type(value) is not expected_type: result['state'] = 'type_error'
    elif isinstance(value, str):
        result['length'] = len(value)
        result['state'] = ('empty' if value == '' else 'whitespace' if not value.strip()
                           else 'format_error' if pattern and not re.fullmatch(pattern, value) else 'valid')
    else: result['state'] = 'valid'
    return result


def _audit_write(record):
    record = {'schemaVersion': 1, 'traceId': _trace_id(), 'context': _audit_context(), **record}
    path = _audit_path()
    encoded = (json.dumps(record, separators=(',', ':'), ensure_ascii=True) + '\n').encode()
    try:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        try:
            view = memoryview(encoded)
            while view:
                written = os.write(fd, view)
                if not written: raise OSError('short audit write')
                view = view[written:]
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError as error:
        print(f'Artifact audit persistence failed: {type(error).__name__}; evidence missing; no retry or fallback', file=sys.stderr, flush=True)
        raise AuditPersistenceError('Audit persistence failed; operation outcome must not be treated as success') from None
    # The full private JSONL is authoritative; CDS log lines have a 1KB limit.
    print('Artifact audit: ' + json.dumps({'traceId': record['traceId'], 'callId': record.get('callId'),
          'attempt': record.get('attempt'), 'phase': record.get('phase'),
          'event': record['event'], 'outcome': record.get('decision', {}).get('outcome'),
          'recordSha256': hashlib.sha256(encoded).hexdigest(), 'file': str(path)}), file=sys.stderr, flush=True)


def _configuration(limit=None):
    return {'timeoutSeconds': 90, 'byteLimit': limit, 'snapshotLimit': _AUDIT_SNAPSHOT_LIMIT,
            'maxGetAttempts': 3, 'buildCommit': _safe_label(os.environ.get('PRD_AGENT_ARTIFACT_HELPER_COMMIT') or os.environ.get('GITHUB_SHA') or os.environ.get('CDS_COMMIT_SHA')), 'buildFingerprint': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            'instance': {'pid': os.getpid()}, 'configurationUpdatedAt': None,
            'configurationTimestampOmissionReason': 'embedded_script_policy_identified_by_build_fingerprint'}


def _header(headers, name):
    value = headers.get(name) if headers is not None and hasattr(headers, 'get') else None
    if value is None and headers is not None and hasattr(headers, 'get'):
        value = headers.get(name.lower())
    return value if isinstance(value, str) else None


def _response_audit(received, status, headers, body, complete=False, no_headers_reason=None):
    raw_ctype = _header(headers, 'Content-Type')
    ctype = raw_ctype
    ctype = ctype.split(';', 1)[0].strip().lower() if ctype is not None else None
    if ctype and not re.fullmatch(r'[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+', ctype): ctype = None
    ids = {}
    for name in ['X-GitHub-Request-Id', 'X-Request-Id', 'X-MS-Request-Id', 'traceparent']:
        value = _header(headers, name)
        if value is None:
            ids[name] = {'state': 'missing', 'reason': no_headers_reason or 'not_provided_by_upstream'}
        elif value == '': ids[name] = {'state': 'empty'}
        elif not value.strip(): ids[name] = {'state': 'whitespace', 'length': len(value)}
        elif len(value) <= 128 and re.fullmatch(r'[0-9a-fA-F:-]+', value):
            ids[name] = {'state': 'valid', 'value': value}
        else:
            ids[name] = {'state': 'omitted', 'length': len(value), 'sha256': hashlib.sha256(value.encode()).hexdigest(),
                         'reason': 'unrecognized_trace_format_may_contain_credentials_or_personal_data'}
    declared = _header(headers, 'Content-Length')
    declared = int(declared) if declared and re.fullmatch(r'[0-9]{1,12}', declared) else None
    size = len(body) if body is not None else 0
    provider_reason = None; provider_code = None
    if body is not None and status is not None and status >= 400 and size <= _AUDIT_SNAPSHOT_LIMIT:
        try:
            error_json = json.loads(body)
            if isinstance(error_json, dict):
                message = error_json.get('message')
                if isinstance(message, str) and message in {'Bad credentials', 'Not Found', 'Validation Failed', 'Resource not accessible by integration', 'Requires authentication'}:
                    provider_reason = message
                value = error_json.get('status')
                if type(value) is int and 100 <= value <= 599: provider_code = value
                elif isinstance(value, str) and re.fullmatch(r'[1-5][0-9]{2}', value): provider_code = value
        except (ValueError, UnicodeError):
            pass
    unknown_at_limit = body is not None and not complete and declared is None and size == _AUDIT_SNAPSHOT_LIMIT
    content_state = ('missing' if raw_ctype is None else 'empty' if raw_ctype == '' else 'whitespace' if not raw_ctype.strip() else 'valid' if ctype else 'format_error')
    return {'received': received, 'httpStatus': status if type(status) is int else None,
            'contentType': ctype, 'contentTypeState': content_state, 'upstreamBusinessCode': provider_code, 'upstreamReason': provider_reason, 'upstreamReasonOmissionReason': None if provider_reason else 'unreviewed_or_absent_provider_body_not_persisted', 'responseState': 'received' if received is True else 'not_received' if received is False else 'not_exposed_by_cli', 'headerOmissionReason': no_headers_reason if not headers else None,
            'upstreamRequestId': ids, 'declaredBodyBytes': declared, 'bodyObservedBytes': size,
            'digestInputBytes': min(size, _AUDIT_SNAPSHOT_LIMIT),
            'prefixSha256': hashlib.sha256(body[:_AUDIT_SNAPSHOT_LIMIT]).hexdigest() if body is not None else None,
            'fullBodySha256': hashlib.sha256(body).hexdigest() if body is not None and complete else None,
            'bodyOmitted': True, 'storedBodyBytes': 0, 'bodyReadComplete': complete,
            'omissionReason': ('response_facts_not_exposed_by_cli' if received is None else 'no_response' if not received else 'binary_artifact_not_stored' if ctype in {'application/zip', 'application/octet-stream'}
                               else 'unreviewed_metadata_or_error_body_may_contain_signed_urls_credentials_or_personal_data'),
            'truncated': None if unknown_at_limit else size > _AUDIT_SNAPSHOT_LIMIT or bool(declared is not None and size < declared),
            'truncationReason': 'bounded_error_prefix_at_limit_total_size_unknown' if unknown_at_limit else 'bounded_digest_prefix_or_incomplete_response' if size > _AUDIT_SNAPSHOT_LIMIT or bool(declared is not None and size < declared) else None}


def _attempt_record(event, call_id, attempt, phase, started_at, started_clock, request, response=None, decision=None, limit=None):
    _audit_write({'event': event, 'callId': call_id, 'attempt': attempt, 'phase': phase,
        'request': request, 'timing': {'startedAt': started_at,
          'finishedAt': datetime.datetime.now(datetime.timezone.utc).isoformat() if phase == 'finish' else None,
          'durationMs': round((time.monotonic() - started_clock) * 1000, 3) if phase == 'finish' else None},
        'response': response or _response_audit(False, None, None, None),
        'decision': decision or {'outcome': 'started'}, 'configuration': _configuration(limit)})


def audit_validation(stage, outcome, states=None):
    _audit_write({'event': 'artifact_validation', 'callId': uuid.uuid4().hex, 'attempt': 1, 'phase': 'finish',
                  'decision': {'stage': stage, 'outcome': outcome}, 'states': states or {},
                  'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'configuration': _configuration()})


def read_url(url, limit=100 * 1024 * 1024, accept='application/octet-stream'):
    if not url.startswith('https://'):
        raise ArtifactError('Artifact sources must use HTTPS')
    request = urllib.request.Request(url, headers={'User-Agent': 'MAP-Release-Artifact/1.0', 'Cache-Control': 'no-cache', 'Accept': accept})
    safe_request = {'method': 'GET', 'endpoint': _safe_endpoint(url), 'accept': accept}
    call_id = uuid.uuid4().hex
    for attempt in range(1, 4):
        started_at = datetime.datetime.now(datetime.timezone.utc).isoformat(); started_clock = time.monotonic()
        _attempt_record('public_artifact_get', call_id, attempt, 'start', started_at, started_clock, safe_request, limit=limit)
        response = None
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                data = response.read(limit + 1)
                status = getattr(response, 'status', None)
                headers = getattr(response, 'headers', None)
            rejected = len(data) > limit
            _attempt_record('public_artifact_get', call_id, attempt, 'finish', started_at, started_clock, safe_request,
                            _response_audit(True, status, headers, data, not rejected),
                            {'outcome': 'rejected' if rejected else 'success', 'parseStatus': 'not_yet_parsed',
                             'errorType': 'response_limit_exceeded' if rejected else None, 'recoveryAction': 'stop' if rejected else 'consume_after_audit',
                             'willRetrySameUrl': False, 'delaySeconds': None}, limit)
            if rejected: raise ArtifactError('Artifact exceeds the supported size')
            return data
        except AuditPersistenceError:
            raise
        except (urllib.error.URLError, OSError, http.client.HTTPException) as error:
            status = getattr(error, 'code', None)
            if type(status) is not int and response is not None:
                status = getattr(response, 'status', None)
            status = status if type(status) is int else None
            retry = status in {502, 503, 504} and attempt < 3; delay = float(attempt)
            headers = error.headers if isinstance(error, urllib.error.HTTPError) else getattr(response, 'headers', None)
            header = _header(headers, 'Retry-After')
            if header is not None:
                try:
                    requested = float(header)
                    if not 0 <= requested <= 10: retry = False
                    else: delay = max(delay, requested)
                except ValueError: retry = False
            body = None
            if isinstance(error, urllib.error.HTTPError):
                try: body = error.read(_AUDIT_SNAPSHOT_LIMIT)
                except (OSError, ValueError): pass
            elif isinstance(error, http.client.IncompleteRead): body = error.partial
            decision = {'outcome': 'error', 'errorType': type(error).__name__,
                        'reasonType': type(getattr(error, 'reason', error)).__name__,
                        'failureStage': 'response_body' if response is not None else 'http_response' if status else 'connection_or_no_response',
                        'recoveryAction': 'retry_same_url' if retry else 'stop', 'willRetrySameUrl': retry, 'delaySeconds': delay if retry else None,
                        'parseStatus': 'not_parsed', 'upstreamReasonOmission': 'untrusted_error_text_may_echo_credentials; status_and_trace_retained'}
            _attempt_record('public_artifact_get', call_id, attempt, 'finish', started_at, started_clock, safe_request,
                            _response_audit(bool(status is not None or response is not None), status, headers, body), decision, limit)
            if retry:
                time.sleep(delay); continue
            raise ArtifactError(f'Artifact source unavailable ({status}); reasonType={decision["reasonType"]}; no Pages fallback; audit={_audit_path()}') from None


def validate(directory, ref, commit=None):
    manifest_path = Path(directory) / names(ref)[2]
    try:
        manifest = json.loads(manifest_path.read_text())
        states = {'parseStatus': 'valid_json', 'fieldStates': {key: _field_state(manifest, key, str, pattern)
                  for key, pattern in [('commit', r'[0-9a-f]{40}'), ('ref', r'[A-Za-z0-9._-]+'),
                                       ('webDist', r'[A-Za-z0-9._-]+'), ('webSha256', r'[0-9a-f]{64}')]}}
    except (OSError, ValueError, UnicodeError):
        states = {'parseStatus': 'unreadable_or_invalid_json', 'fieldStates': {}}
    audit_validation('manifest_fields', 'observed', states)
    try:
        result = _validate_bundle(directory, ref, commit)
    except AuditPersistenceError:
        raise
    except ArtifactError as error:
        audit_validation('bundle_validation', 'rejected', {'errorType': type(error).__name__, 'reasonCode': error.code, **states})
        raise
    audit_validation('bundle_validation', 'valid', {'fileCount': len(result['files']), 'zipSha256': result['zipSha256'], **states})
    return result


def _validate_bundle(directory, ref, commit=None):
    files = [Path(directory) / name for name in names(ref)]
    if not all(p.is_file() and p.stat().st_size > 0 for p in files):
        raise ArtifactError('The ZIP, checksum and manifest must all exist and be nonempty', code='missing_bundle_files')
    try:
        manifest = json.loads(files[2].read_text())
        declared = manifest["webSha256"]
        actual_commit = manifest["commit"]
        checksum = files[1].read_text().split()[0]
    except (ValueError, KeyError, IndexError, UnicodeError, TypeError):
        raise ArtifactError('Malformed release manifest or checksum', code='invalid_manifest_or_checksum') from None
    if not re.fullmatch(r"[0-9a-f]{40}", str(actual_commit)):
        raise ArtifactError('Manifest must declare a full immutable commit', code='invalid_commit_format')
    expected_commit = commit or (ref[4:] if ref.startswith("sha-") else actual_commit)
    if actual_commit != expected_commit or manifest.get("ref") != ref or manifest.get("webDist") != files[0].name:
        raise ArtifactError('Manifest commit/ref/ZIP does not match the requested release', code='artifact_identity_mismatch')
    actual = hashlib.sha256(files[0].read_bytes()).hexdigest()
    if not re.fullmatch(r"[0-9a-f]{64}", str(declared)) or declared != checksum or actual != declared:
        raise ArtifactError('ZIP, manifest and checksum SHA256 disagree', code='digest_mismatch')
    try:
        with zipfile.ZipFile(files[0]) as archive:
            if archive.testzip() is not None:
                raise ArtifactError('Corrupt ZIP', code='corrupt_zip')
            html = archive.read("index.html").decode()
            # Bind the actual entry resource to the declared commit, not just metadata.
            entries = re.findall(r'(?:src|href)=["\']/?(assets/[^"\']+\.(?:js|css))["\']', html)
            if not entries or not any(p.endswith(f"-{actual_commit}.js") for p in entries):
                raise ArtifactError('ZIP entry resources are not bound to the manifest commit', code='entry_commit_mismatch')
            for entry in entries:
                if f"-{actual_commit}." not in entry or not archive.getinfo(entry).file_size:
                    raise ArtifactError('ZIP entry resource is absent, empty or belongs to another commit', code='entry_resource_mismatch')
            if any(p.startswith("/") or ".." in Path(p).parts for p in archive.namelist()):
                raise ArtifactError('Unsafe ZIP member', code='unsafe_zip_member')
    except (zipfile.BadZipFile, KeyError, UnicodeError):
        raise ArtifactError('Invalid ZIP or missing entry resource', code='invalid_zip_or_entry') from None
    return {"commit": actual_commit, "ref": ref, "zipSha256": actual, "zipBytes": files[0].stat().st_size,
            "files": [{"name": p.name, "sha256": hashlib.sha256(p.read_bytes()).hexdigest(), "bytes": p.stat().st_size} for p in files]}


def api_sources(repo, ref):
    _AUDIT_CONTEXT.update(repo=repo, ref=ref)
    try:
        result = _api_sources_impl(repo, ref)
    except AuditPersistenceError:
        raise
    except ArtifactError as error:
        audit_validation('release_metadata', 'rejected', {'errorType': type(error).__name__, 'reasonCode': error.code})
        raise
    audit_validation('release_metadata', 'valid', {'releaseId': result[1]['releaseId'], 'assetCount': len(result[1]['assetIds'])})
    return result


def _api_sources_impl(repo, ref):
    urls(repo, ref)  # validate ref/repository before constructing API paths
    metadata_url = f"https://api.github.com/repos/{repo}/releases/tags/web-{ref}"
    try:
        raw_metadata = read_url(metadata_url, limit=2 * 1024 * 1024, accept="application/vnd.github+json")
        try:
            metadata = json.loads(raw_metadata)
        except (ValueError, UnicodeError):
            audit_validation('release_metadata_fields', 'rejected', {'parseStatus': 'invalid_json', 'fieldStates': {}})
            raise ArtifactError('Malformed fixed-release metadata', code='invalid_json') from None
        fields = {name: _field_state(metadata, name, kind, pattern) for name, kind, pattern in [
            ('draft', bool, None), ('tag_name', str, r'[A-Za-z0-9._-]+'), ('id', int, None),
            ('target_commitish', str, r'[0-9a-f]{40}'), ('assets', list, None)]}
        audit_validation('release_metadata_fields', 'observed', {'parseStatus': 'valid_json', 'fieldStates': fields})
        if type(metadata['draft']) is not bool or metadata["draft"] or metadata["tag_name"] != "web-" + ref:
            raise ArtifactError('Requested fixed release is unpublished or has another ref', code='release_not_published_or_ref_mismatch')
        if type(metadata["id"]) is not int or metadata["id"] <= 0:
            raise ArtifactError('Release requires a valid persistent ID', code='invalid_release_id')
        assets = metadata["assets"]
        source_commit = metadata["target_commitish"]
        if not re.fullmatch(r"[0-9a-f]{40}", source_commit):
            raise ArtifactError('Release metadata must pin its full original commit', code='invalid_release_commit')
        if ref.startswith("sha-") and source_commit != ref[4:]:
            raise ArtifactError('Release metadata target does not match the requested commit', code='release_commit_mismatch')
        selected = []
        for name in names(ref):
            matches = [a for a in assets if a["name"] == name]
            if len(matches) != 1 or type(matches[0]["id"]) is not int or matches[0]["id"] <= 0 or matches[0].get("state") != "uploaded":
                raise ArtifactError('Release requires three unique, completely uploaded asset IDs', code='incomplete_or_ambiguous_release_assets')
            selected.append(matches[0])
    except (ValueError, KeyError, TypeError):
        raise ArtifactError('Malformed fixed-release metadata', code='invalid_release_metadata') from None
    ids = [asset["id"] for asset in selected]
    if len(set(ids)) != 3:
        raise ArtifactError('Release asset IDs must be distinct', code='duplicate_asset_ids')
    return [f"https://api.github.com/repos/{repo}/releases/assets/{asset_id}" for asset_id in ids], {
        "metadataUrl": metadata_url, "releaseId": metadata["id"], "assetIds": ids, "commit": source_commit}


def fetch(repo, ref, output, base=None, commit=None):
    # Never expose an unvalidated partial set to callers.
    _AUDIT_CONTEXT.update(repo=repo, ref=ref, sourceCommit=commit or (ref[4:] if ref.startswith('sha-') else None))
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    sources = urls(repo, ref, base)
    transport = os.environ.get("PRD_AGENT_RELEASE_DOWNLOAD_TRANSPORT", "browser")
    api_proof = None
    if base is None and transport == "github-api":
        sources, api_proof = api_sources(repo, ref)
    elif base is None and transport != "browser":
        raise ArtifactError("Unknown explicit release download transport")
    with tempfile.TemporaryDirectory(dir=output) as temporary:
        for name, url in zip(names(ref), sources):
            (Path(temporary) / name).write_bytes(read_url(url))
        result = validate(temporary, ref, commit)
        if api_proof and api_proof["commit"] != result["commit"]:
            audit_validation('source_bundle_binding', 'rejected', {'reasonCode': 'metadata_manifest_commit_mismatch'})
            raise ArtifactError("Release metadata and original manifest commit disagree")
        audit_validation('source_bundle_binding', 'valid', {'zipSha256': result['zipSha256'], 'files': result['files']})
        for name in names(ref):
            os.replace(Path(temporary) / name, output / name)
    result["urls"] = sources
    result["transport"] = "github-api" if api_proof else "browser"
    if api_proof:
        result["sourceIdentity"] = api_proof
    return result


def _split_gh_response(raw):
    headers = {}; status = None; body = raw
    # gh --include may expose more than one HTTP header block on redirects.
    # Never retain Location, authorization, cookies or arbitrary headers.
    while re.match(rb'^HTTP/[^\s]+ [0-9]{3}(?:[^\r\n]*)[\r\n]', body):
        match = re.search(rb'\r?\n\r?\n', body)
        if not match: break
        block, body = body[:match.start()], body[match.end():]
        lines = block.splitlines(); status = int(lines[0].split()[1]); headers = {}
        for line in lines[1:]:
            key, sep, value = line.partition(b':')
            if sep and key.decode('ascii', errors='ignore').lower() in {'content-type', 'content-length', 'x-github-request-id', 'x-request-id', 'x-ms-request-id', 'traceparent'}:
                headers[key.decode('ascii').lower()] = value.strip().decode('utf-8', errors='replace')
    return status, headers, body


def gh(*args, missing_ok=False):
    call_id = uuid.uuid4().hex; started_at = datetime.datetime.now(datetime.timezone.utc).isoformat(); started_clock = time.monotonic()
    api = bool(args and args[0] == 'api')
    method = None
    for flag in ['--method', '-X']:
        if flag in args and args.index(flag) + 1 < len(args): method = args[args.index(flag) + 1]
    if method is None:
        method = 'POST' if any(a in args for a in ['-f', '-F', '--raw-field', '--field', '--input']) else 'GET'
    request = {'method': method if api else 'CLI', 'endpoint': _safe_endpoint(args[1]) if len(args) > 1 else None,
               'operation': args[0] if args else None, 'accept': 'application/octet-stream' if 'Accept: application/octet-stream' in args else 'application/vnd.github+json'}
    _attempt_record('github_cli', call_id, 1, 'start', started_at, started_clock, request)
    command = ['gh', *args]
    if api and '--include' not in args and '-i' not in args: command.append('--include')
    try: result = subprocess.run(command, capture_output=True)
    except OSError as error:
        _attempt_record('github_cli', call_id, 1, 'finish', started_at, started_clock, request,
                        _response_audit(False, None, None, None),
                        {'outcome': 'error', 'errorType': type(error).__name__, 'recoveryAction': 'stop', 'parseStatus': 'no_response'})
        raise ArtifactError('GitHub CLI transport failed; no overwrite or fallback attempted') from None
    status, headers, body = _split_gh_response(result.stdout) if api else (None, {}, result.stdout)
    if status is None:
        match = re.search(rb'HTTP ([0-9]{3})', result.stderr)
        if match: status = int(match[1])
    binary = request['accept'] == 'application/octet-stream'
    parsed = None; parse_status = 'not_applicable_binary' if binary else 'not_exposed_by_cli'
    if api and not binary:
        try: parsed = json.loads(body); parse_status = 'valid_json'
        except (ValueError, UnicodeError): parse_status = 'invalid_json'
    known_messages = {'Bad credentials', 'Not Found', 'Validation Failed', 'Resource not accessible by integration', 'Requires authentication'}
    message = parsed.get('message') if isinstance(parsed, dict) else None
    known_missing = bool(result.returncode and missing_ok and status == 404)
    outcome = 'not_found_expected' if known_missing else 'error' if result.returncode else 'rejected' if parse_status == 'invalid_json' else 'success'
    _attempt_record('github_cli', call_id, 1, 'finish', started_at, started_clock, request,
                    _response_audit(True if status is not None else None, status, headers, body, True,
                                    'not_exposed_by_cli' if not headers else None),
                    {'outcome': outcome, 'errorType': ('unsupported_cli_flag' if b'unknown flag:' in result.stderr else 'github_operation_failed') if result.returncode else None,
                     'remoteMessage': message if isinstance(message, str) and message in known_messages else None,
                     'remoteMessageOmissionReason': None if isinstance(message, str) and message in known_messages else 'unreviewed_cli_or_provider_message_may_contain_credentials',
                     'cliExitCode': result.returncode, 'parseStatus': parse_status, 'recoveryAction': 'absence_for_first_publish' if known_missing else 'stop' if outcome in {'error', 'rejected'} else 'consume_after_audit',
                     'internalTransportAttempts': 'not_exposed_by_cli'})
    if known_missing: return None
    if result.returncode:
        raise ArtifactError(f'GitHub release operation failed (HTTP {status}); no overwrite or fallback attempted; audit={_audit_path()}')
    if parse_status == 'invalid_json': raise ArtifactError('GitHub API returned malformed JSON; response evidence recorded')
    return body


def release(repo, ref):
    _AUDIT_CONTEXT.update(repo=repo, ref=ref)
    data = gh("api", f"repos/{repo}/releases/tags/web-{checked_ref(ref)}", missing_ok=True)
    if data is not None:
        return json.loads(data)
    # A new draft does not create its Git tag until publication. Discover it
    # by ID rather than incorrectly treating a tag-endpoint 404 as absence.
    matches = []
    for number in range(1, 1001):
        page = json.loads(gh("api", f"repos/{repo}/releases?per_page=100&page={number}"))
        matches.extend(item for item in page if item["tag_name"] == "web-" + ref)
        if len(page) < 100:
            break
    else:
        raise ArtifactError("Release listing exceeded the supported safety bound")
    if len(matches) > 1:
        raise ArtifactError("Multiple drafts claim this ref; manual original-bundle recovery required")
    return matches[0] if matches else None


def restore(repo, ref, output, commit=None):
    existing = release(repo, ref)
    if existing is None:
        return {"exists": False}
    if existing.get("draft"):
        raise ArtifactError("An unpublished draft exists; recover its original workflow bundle before retrying")
    if not set(names(ref)).issubset({asset["name"] for asset in existing["assets"]}):
        raise ArtifactError("Published release is incomplete; refusing to rebuild or replace it")
    return {"exists": True, **fetch(repo, ref, output, commit=commit)}


def bundle(dist, output, repo, commit, ref):
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ArtifactError("Full commit required")
    files = [Path(output) / name for name in names(ref)]
    Path(output).mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(files[0], "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(Path(dist).rglob("*")):
            if path.is_symlink():
                raise ArtifactError("Symlinks are not accepted in release bundles")
            if path.is_file():
                info = zipfile.ZipInfo(path.relative_to(dist).as_posix(), date_time=(2000, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                archive.writestr(info, path.read_bytes())
    digest = hashlib.sha256(files[0].read_bytes()).hexdigest()
    files[1].write_text(f"{digest}  {files[0].name}\n")
    manifest = {"commit": commit, "ref": ref, "webDist": files[0].name, "webSha256": digest}
    for key, image in [("apiImage", "prdagent-server"), ("llmgwImage", "prdagent-llmgw"),
                       ("llmgwServeImage", "prdagent-llmgw-serve"), ("llmgwWebImage", "prdagent-llmgw-web")]:
        manifest[key] = f"ghcr.io/{repo}/{image}:{ref}"
    files[2].write_text(json.dumps(manifest, indent=2) + "\n")
    return validate(output, ref, commit)


def import_pages(archive_path, output, ref, commit, original_sha256):
    """Extract only the original three files from a verified workflow artifact."""
    if not re.fullmatch(r"[0-9a-f]{64}", original_sha256 or ""):
        raise ArtifactError("Import requires the previously audited original ZIP hash")
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output) as temporary:
        with tarfile.open(archive_path) as archive:
            for name in names(ref):
                matches = [m for m in archive.getmembers() if m.name.removeprefix("./") == name]
                if len(matches) != 1 or not matches[0].isfile() or not 0 < matches[0].size <= 100 * 1024 * 1024:
                    raise ArtifactError("Original workflow artifact is incomplete or ambiguous")
                (Path(temporary) / name).write_bytes(archive.extractfile(matches[0]).read())
        result = validate(temporary, ref, commit)
        if result["zipSha256"] != original_sha256:
            raise ArtifactError("Original workflow ZIP differs from the audited deployed ZIP")
        for name in names(ref):
            os.replace(Path(temporary) / name, output / name)
    return result


def alias(directory, source_ref, ref):
    original = validate(directory, source_ref)
    source = [Path(directory) / n for n in names(source_ref)]
    target = [Path(directory) / n for n in names(ref)]
    if ref == source_ref:
        return original
    shutil.copyfile(source[0], target[0])
    target[1].write_text(f"{original['zipSha256']}  {target[0].name}\n")
    manifest = json.loads(source[2].read_text())
    manifest.update(ref=ref, webDist=target[0].name)
    for key in ("apiImage", "llmgwImage", "llmgwServeImage", "llmgwWebImage"):
        if key in manifest:
            manifest[key] = manifest[key].rsplit(":", 1)[0] + ":" + ref
    target[2].write_text(json.dumps(manifest, indent=2) + "\n")
    return validate(directory, ref, original["commit"])


def pages(directory, ref, output, repo):
    result = validate(directory, ref)
    output = Path(output)
    output.mkdir(parents=True, exist_ok=False)
    with zipfile.ZipFile(Path(directory) / names(ref)[0]) as archive:
        archive.extractall(output)
        archive.extractall(output / "admin")
    for name in names(ref):
        shutil.copyfile(Path(directory) / name, output / name)
    for root in (output, output / "admin"):
        (root / "commit.txt").write_text(result["commit"] + "\n")
    latest_names = ["prd-admin-dist-latest.zip", "prd-admin-dist-latest.zip.sha256", "release-manifest-latest.json"]
    if os.environ.get("PUBLISH_LATEST") == "true":
        shutil.copyfile(Path(directory) / names(ref)[0], output / latest_names[0])
        (output / latest_names[1]).write_text(f"{result['zipSha256']}  {latest_names[0]}\n")
        manifest = json.loads((Path(directory) / names(ref)[2]).read_text())
        manifest.update(ref="latest", webDist=latest_names[0])
        for key in ("apiImage", "llmgwImage", "llmgwServeImage", "llmgwWebImage"):
            if key in manifest:
                manifest[key] = manifest[key].rsplit(":", 1)[0] + ":latest"
        (output / latest_names[2]).write_text(json.dumps(manifest, indent=2) + "\n")
    else:
        owner, name = repo.split("/")
        base = os.environ.get("PAGES_PRESERVE_BASE_URL", f"https://{owner}.github.io/{name}")
        old = []
        for name in latest_names:
            try:
                old.append(read_url(base.rstrip("/") + "/" + name))
            except ArtifactError as error:
                if "(404)" not in str(error):
                    raise
                old.append(None)
        if any(item is not None for item in old):
            if not all(item is not None for item in old):
                raise ArtifactError("Mutable latest is incomplete; Pages was not published")
            try:
                expected = old[1].decode().split()[0]
                manifest = json.loads(old[2])
                if hashlib.sha256(old[0]).hexdigest() != expected or manifest["webSha256"] != expected or manifest["ref"] != "latest":
                    raise ArtifactError("Mutable latest checksum mismatch; Pages was not published")
            except (ValueError, KeyError, TypeError, IndexError, UnicodeError):
                raise ArtifactError("Mutable latest is malformed; Pages was not published") from None
            for name, data in zip(latest_names, old):
                (output / name).write_bytes(data)
    return result


def legacy_bridge_prefix(contract_commit, contract_sha256, repo):
    """Prefix the existing, unchanged rollback body; do not rewrite old snapshots."""
    if not re.fullmatch(r"[0-9a-f]{40}", contract_commit) or not re.fullmatch(r"[0-9a-f]{64}", contract_sha256):
        raise ArtifactError("Bridge contract must be pinned to Git commit and body SHA256")
    urls(repo, "sha-" + contract_commit)  # validate repository before shell interpolation
    return f'''set -eu
umask 077
: "${{CDS_COMMIT_SHA:?missing immutable historical commit}}"
printf '%s' "$CDS_COMMIT_SHA" | grep -Eq '^[0-9a-f]{{40}}$'
bridge_repo="$(git rev-parse --show-toplevel)"
[ "$(pwd -P)" = "$bridge_repo" ]
git cat-file -e '{contract_commit}^{{commit}}' || git -c gc.auto=0 -c maintenance.auto=false fetch --no-tags origin '{contract_commit}'
bridge_dir="$(mktemp -d)"
trap 'rm -rf "$bridge_dir"' EXIT
git show '{contract_commit}:scripts/lib/release-artifacts.py' > "$bridge_dir/release-artifacts.py"
[ "$(sha256sum "$bridge_dir/release-artifacts.py" | awk '{{print $1}}')" = '{contract_sha256}' ]
PRD_AGENT_ARTIFACT_HELPER_COMMIT={shlex.quote(contract_commit)} PRD_AGENT_RELEASE_DOWNLOAD_TRANSPORT=github-api python3 "$bridge_dir/release-artifacts.py" fetch --repo {shlex.quote(repo)} --ref "sha-$CDS_COMMIT_SHA" --commit "$CDS_COMMIT_SHA" \\
  --directory "$bridge_dir/bundle" --env-file "$bridge_dir/inputs.env" --local-inputs > "$bridge_dir/evidence.json"
printf 'Retained artifact bridge: contract={contract_commit} body={contract_sha256}\\n'
cat "$bridge_dir/evidence.json"
. "$bridge_dir/inputs.env"
'''


def publish(repo, ref, directory, resume_id=None, original_sha256=None):
    # Per-ref workflow concurrency serializes writers. Also handle a create race
    # without clobber: a winner must already be complete and validate publicly.
    local = validate(directory, ref)
    if (resume_id is None) != (original_sha256 is None):
        raise ArtifactError("Draft recovery requires both the exact release ID and original workflow ZIP hash")
    if original_sha256 and original_sha256 != local["zipSha256"]:
        raise ArtifactError("Recovery ZIP is not the audited original workflow bundle")
    existing = release(repo, ref)
    if resume_id is not None and (existing is None or not existing.get("draft")):
        raise ArtifactError("Recovery requires the matching existing unpublished draft; no new release was created")
    if existing and not existing.get("draft"):
        with tempfile.TemporaryDirectory() as temporary:
            return {"reused": True, **restore(repo, ref, temporary, local["commit"])}
    if existing:
        # A draft might still belong to another writer. Never take it over.
        if resume_id != existing["id"] or not original_sha256 or original_sha256 != local["zipSha256"]:
            raise ArtifactError("Unpublished draft exists; explicit ID and original workflow ZIP hash required to recover")
        if existing.get("target_commitish") != local["commit"]:
            raise ArtifactError("Draft target commit does not match the original workflow bundle")
    else:
        manifest = json.loads((Path(directory) / names(ref)[2]).read_text())
        try:
            existing = json.loads(gh("api", f"repos/{repo}/releases", "-f", f"tag_name=web-{ref}", "-f", f"target_commitish={manifest['commit']}",
               "-f", f"name=Web bundle {ref}", "-F", "draft=true", "-f", "make_latest=false"))
        except AuditPersistenceError:
            raise
        except ArtifactError:
            winner = release(repo, ref)
            if winner and not winner.get("draft"):
                with tempfile.TemporaryDirectory() as temporary:
                    return {"reused": True, **restore(repo, ref, temporary, local["commit"])}
            raise
    release_id = existing["id"]
    # Use IDs throughout the draft phase: there may not yet be a Git tag.
    with tempfile.TemporaryDirectory() as temporary:
        assets = {asset["name"]: asset for asset in existing.get("assets", [])}
        if set(assets) - set(names(ref)):
            raise ArtifactError("Draft has unrelated assets; refusing to change it")
        # First verify every existing byte before uploading anything missing.
        for name, asset in assets.items():
            data = gh("api", f"repos/{repo}/releases/assets/{asset['id']}", "-H", "Accept: application/octet-stream")
            if data != (Path(directory) / name).read_bytes():
                raise ArtifactError("Draft assets differ from the original bundle; refusing to overwrite")
            (Path(temporary) / name).write_bytes(data)
        for name in names(ref):
            if name not in assets:
                asset = json.loads(gh("api", f"https://uploads.github.com/repos/{repo}/releases/{release_id}/assets?name={name}",
                                      "--method", "POST", "-H", "Content-Type: application/octet-stream", "--input", str(Path(directory) / name)))
                data = gh("api", f"repos/{repo}/releases/assets/{asset['id']}", "-H", "Accept: application/octet-stream")
                (Path(temporary) / name).write_bytes(data)
        remote = validate(temporary, ref)
        local = validate(directory, ref)
        if remote["files"] != local["files"]:
            raise ArtifactError("Remote draft bytes differ from the original bundle")
    gh("api", f"repos/{repo}/releases/{release_id}", "--method", "PATCH", "-F", "draft=false", "-f", "make_latest=false")
    with tempfile.TemporaryDirectory() as temporary:
        return {"reused": False, **fetch(repo, ref, temporary)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["bundle", "import-pages", "alias", "pages", "validate", "fetch", "restore", "publish"])
    parser.add_argument("--repo", default="inernoro/prd_agent")
    parser.add_argument("--ref", required=True)
    parser.add_argument("--commit")
    parser.add_argument("--directory", required=True)
    parser.add_argument("--dist")
    parser.add_argument("--source-ref")
    parser.add_argument("--archive")
    parser.add_argument("--base-url")
    parser.add_argument("--github-output")
    parser.add_argument("--env-file", help="For the audited legacy consumer bridge; written only after full validation")
    parser.add_argument("--local-inputs", action="store_true", help="Legacy consumer reads this invocation's validated staging files")
    parser.add_argument("--resume-draft-id", type=int, help="Explicit recovery only, with the original workflow bundle hash")
    parser.add_argument("--original-sha256")
    args = parser.parse_args()
    _AUDIT_CONTEXT.update(repo=args.repo, ref=args.ref, sourceCommit=args.commit or (args.ref[4:] if args.ref.startswith('sha-') else None))
    try:
        if args.env_file and args.command != "fetch":
            raise ArtifactError("Only a validated fetch can export legacy consumer inputs")
        if args.local_inputs and (args.command != "fetch" or not args.env_file):
            raise ArtifactError("Local staging inputs require fetch with an export file")
        if args.resume_draft_id and args.command != "publish":
            raise ArtifactError("Draft recovery is only supported by publish")
        if args.original_sha256 and args.command not in ("publish", "import-pages"):
            raise ArtifactError("Original ZIP hash is only supported for publish recovery or workflow import")
        if args.command == "bundle":
            result = bundle(args.dist, args.directory, args.repo, args.commit, args.ref)
        elif args.command == "import-pages":
            result = import_pages(args.archive, args.directory, args.ref, args.commit, args.original_sha256)
        elif args.command == "alias":
            result = alias(args.directory, args.source_ref, args.ref)
        elif args.command == "pages":
            result = pages(args.directory, args.ref, args.dist, args.repo)
        elif args.command == "validate":
            result = validate(args.directory, args.ref, args.commit)
        elif args.command == "fetch":
            result = fetch(args.repo, args.ref, args.directory, args.base_url, args.commit)
        elif args.command == "restore":
            result = restore(args.repo, args.ref, args.directory, args.commit)
        else:
            result = publish(args.repo, args.ref, args.directory, args.resume_draft_id, args.original_sha256)
        if args.github_output:
            with open(args.github_output, "a") as output:
                output.write("exists=" + str(result.get("exists", False)).lower() + "\n")
        if args.env_file:
            values = dict(DIST_URL=result["urls"][0], DIST_SHA256_URL=result["urls"][1],
                          DIST_MANIFEST_URL=result["urls"][2], DIST_SHA256=result["zipSha256"])
            if args.local_inputs:
                files = [(Path(args.directory) / name).resolve().as_uri() for name in names(args.ref)]
                values.update(DIST_URL=files[0], DIST_SHA256_URL=files[1], DIST_MANIFEST_URL=files[2])
            Path(args.env_file).write_text("\n".join("export " + key + "=" + shlex.quote(value) for key, value in values.items()) + "\n")
        print(json.dumps(result))
    except ArtifactError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
