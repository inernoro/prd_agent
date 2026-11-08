"""Task-owned immutable source archives; no uploaded project code is executed."""
import asyncio
import hashlib
import json
import logging
import os
import re
import shutil
import stat
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit, parse_qs
from app.core.config import settings

MAX_FILES = 20000
MAX_EXPANDED_BYTES = 512 * 1024 * 1024
MAX_ARCHIVE_BYTES = 500 * 1024 * 1024
MAX_RESPONSE_RECORD_BYTES = 16384


class RepositoryEvidenceError(RuntimeError):
    pass


def read_repository_responses(task_id, offset=0, limit=50):
    if offset < 0 or not 1 <= limit <= 100:
        raise ValueError('Invalid response evidence page')
    directory = task_directory(task_id) / 'source-responses'
    paths = sorted(directory.glob('response-*.json'))
    events = []
    for path in paths[offset:offset + limit]:
        with path.open('rb') as source:
            data = source.read(MAX_RESPONSE_RECORD_BYTES + 1)
        if len(data) > MAX_RESPONSE_RECORD_BYTES:
            raise ValueError('Response evidence exceeds limit')
        events.append(json.loads(data))
    next_offset = offset + len(events)
    return {'events': events, 'total': len(paths),
            'next_offset': next_offset if next_offset < len(paths) else None}


def _repository_safe_text(value, secrets):
    text = str(value)
    for secret in sorted(set(secrets), key=len, reverse=True):
        if secret: text = text.replace(secret, '[redacted]')
    text = text[:4096]
    text = re.sub(r'https?://[^\s<>"\']+', '[url]', text)
    text = re.sub(r'''(?i)\b(bearer|token|password|secret|api[_-]?key|authorization|cookie)\b["']?\s*[:= ]+\s*["']?[^"'\s,;<>]+''', r'\1 [redacted]', text)
    text = re.sub(r'\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b', '[redacted]', text)
    text = re.sub(r'[\w.+-]{1,128}@[\w.-]{1,128}\.[A-Za-z]{2,24}', '[email]', text)
    text = re.sub(r'(?<!\w)\+?\d[\d ()-]{7,}\d(?!\w)', '[phone]', text)
    text = re.sub(r'<[^>]*>', ' ', text)
    return ''.join(c for c in text if c.isprintable() or c in '\n\t')[:512]


class RepositoryResponses:
    """Private task snapshot evidence; never retain successful source-file bodies."""
    def __init__(self, task_id, project_id, provider):
        self.task_id, self.project_id, self.provider = task_id, project_id, provider
        self.attempt = read_repository_responses(task_id, 0, 1)['total']

    def _persist(self, record):
        directory = task_directory(self.task_id) / 'source-responses'
        temporary = None
        try:
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            directory.chmod(0o700); directory.parent.chmod(0o700)
            name = f"response-{record['attempt']:08d}-{record['request_id']}.json"
            temporary = directory / (name + '.part')
            data = (json.dumps(record, ensure_ascii=True) + '\n').encode()
            if len(data) > MAX_RESPONSE_RECORD_BYTES:
                raise ValueError('Response evidence exceeds limit')
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, 'wb') as target:
                target.write(data); target.flush(); os.fsync(target.fileno())
            os.replace(temporary, directory / name)
        except (OSError, ValueError):
            logging.getLogger(__name__).error('Repository response evidence write failed task=%s request=%s',
                                            self.task_id, record['request_id'])
            if temporary is not None:
                try: temporary.unlink(missing_ok=True)
                except OSError: pass
            raise RepositoryEvidenceError('Repository response evidence could not be persisted') from None

    async def request(self, url, headers=None, json_response=False):
        from app.services.scanner import repository_get
        self.attempt += 1
        started = datetime.now(timezone.utc)
        parsed = urlsplit(url)
        secrets = [value.removeprefix('Bearer ').removeprefix('token ')
                   for key, value in (headers or {}).items()
                   if key.lower() in ('authorization', 'private-token')]
        record = {'app': 'deepaudit', 'task_id': self.task_id, 'project_id': self.project_id,
                  'request_id': uuid.uuid4().hex, 'attempt': self.attempt, 'provider': self.provider,
                  'operation': 'resolve_revision' if json_response and '/commits/' in parsed.path else 'enumerate_files' if json_response else 'fetch_source',
                  'method': 'GET', 'target_host': parsed.hostname,
                  'target_path_sha256': hashlib.sha256(parsed.path.encode()).hexdigest(),
                  'started_at': started.isoformat(), 'timeout_seconds': 30,
                  'evidence_limit_bytes': MAX_RESPONSE_RECORD_BYTES,
                  'credential_fingerprint': hashlib.sha256('\n'.join(secrets).encode()).hexdigest() if secrets else None,
                  'build_revision': os.environ.get('CDS_COMMIT_SHA') if re.fullmatch(r'[a-fA-F0-9]{40}', os.environ.get('CDS_COMMIT_SHA', '')) else None,
                  'process_id': os.getpid(), 'response_received': False, 'status': None,
                  'outcome': 'no_response', 'recovery': 'none'}
        query = parse_qs(parsed.query)
        record['pagination'] = {key: int(query[key][0]) for key in ('page', 'per_page')
                                if key in query and re.fullmatch(r'[0-9]{1,8}', query[key][0])}
        try:
            response = await repository_get(url, headers=headers, json_response=json_response)
        except BaseException as error:
            record['failure_stage'], record['error_type'] = 'request', type(error).__name__
            record['finished_at'] = datetime.now(timezone.utc).isoformat()
            record['duration_ms'] = (datetime.now(timezone.utc) - started).total_seconds() * 1000
            self._persist(record)
            raise
        record.update(response_received=True, status=response.status_code,
                      content_type=_repository_safe_text(response.headers.get('content-type', ''), secrets),
                      upstream_request_id=_repository_safe_text(response.headers.get('x-github-request-id') or response.headers.get('x-request-id', ''), secrets),
                      body_bytes=len(response.content), body_sha256=hashlib.sha256(response.content).hexdigest(),
                      outcome='success' if response.status_code == 200 else 'http_error')
        if json_response or response.status_code != 200:
            try:
                payload = response.json()
                record['parse'] = 'json'
                record['json_type'] = type(payload).__name__
                if record['operation'] == 'resolve_revision' and not isinstance(payload, dict):
                    record.update(outcome='contract_error', revision_state='wrong_container_type')
                if isinstance(payload, dict):
                    record['field_types'] = {k: type(payload[k]).__name__ for k in ('id', 'sha', 'tree', 'truncated', 'message', 'code', 'error', 'success') if k in payload}
                    message = payload.get('message')
                    revision_field = 'id' if self.provider == 'gitlab' else 'sha'
                    sha = payload.get(revision_field)
                    if record['operation'] == 'resolve_revision' and response.status_code == 200 and isinstance(sha, str) and re.fullmatch(r'[a-fA-F0-9]{40}', sha) and not payload.get('error') and payload.get('success') is not False:
                        message = None
                        record['reason_omission'] = 'private_commit_message'
                    record['reason'] = _repository_safe_text(message, secrets) if isinstance(message, (str, int, bool)) else '[non-scalar omitted]' if message is not None else ''
                    record['reason_characters'] = len(message) if isinstance(message, str) else None
                    record['reason_truncated'] = isinstance(message, str) and len(message) > 512
                    error = payload.get('error')
                    if isinstance(error, (str, int, bool)): record['upstream_error'] = _repository_safe_text(error, secrets)
                    elif isinstance(error, dict): record['upstream_error'] = {k: _repository_safe_text(error[k], secrets) for k in ('code', 'message') if isinstance(error.get(k), (str, int, bool))}
                    for key in ('code', 'success'):
                        if isinstance(payload.get(key), (str, int, bool)): record[key] = _repository_safe_text(payload[key], secrets)
                    record['revision_field'] = revision_field
                    record['revision_state'] = ('missing' if revision_field not in payload else 'null' if sha is None else
                        'wrong_type' if not isinstance(sha, str) else 'empty' if sha == '' else
                        'whitespace' if not sha.strip() else 'usable' if re.fullmatch(r'[a-fA-F0-9]{40}', sha) else 'invalid_format')
                    record['revision_type'] = type(sha).__name__ if revision_field in payload else None
                    record['revision_length'] = len(sha) if isinstance(sha, str) else None
                    if record['revision_state'] == 'usable': record['revision'] = sha
                    if response.status_code == 200 and (error or payload.get('success') is False): record['outcome'] = 'business_error'
                    elif response.status_code == 200 and record['operation'] == 'resolve_revision' and record['revision_state'] != 'usable': record['outcome'] = 'contract_error'
                if record['operation'] == 'enumerate_files':
                    entries = payload if self.provider == 'gitlab' else payload.get('tree') if isinstance(payload, dict) else None
                    record['manifest_state'] = 'usable' if isinstance(entries, list) else 'wrong_type'
                    record['manifest_entries'] = len(entries) if isinstance(entries, list) else None
                    record['manifest_more'] = payload.get('truncated') is True if isinstance(payload, dict) else None
                    if self.provider == 'github' and record['manifest_more']:
                        record['manifest_state'] = 'truncated'
                    if response.status_code == 200 and record['outcome'] == 'success' and record['manifest_state'] != 'usable':
                        record['outcome'] = 'contract_error'
                record['body_omission'] = 'repository_metadata_except_bounded_reason'
            except (ValueError, TypeError):
                record.update(parse='invalid_json', excerpt=_repository_safe_text(response.text[:4096], secrets) if json_response else '',
                              body_omission='non_json_excerpt_bounded_to_512_characters' if json_response else 'non_json_file_response_may_contain_private_source')
                if response.status_code == 200 and json_response: record['outcome'] = 'parse_error'
        else:
            record['body_omission'] = 'private_repository_source'
        record['finished_at'] = datetime.now(timezone.utc).isoformat()
        record['duration_ms'] = (datetime.now(timezone.utc) - started).total_seconds() * 1000
        self._persist(record)
        if record['outcome'] in ('contract_error', 'business_error'):
            raise ValueError('Repository response contract was not satisfied; see task response evidence')
        return response


def task_directory(task_id):
    # IDs are generated by the engine; never interpret a client-supplied filesystem path.
    identity = str(uuid.UUID(str(task_id)))
    return Path(settings.ZIP_STORAGE_PATH).resolve() / 'task-snapshots' / identity


def archive_path(task_id):
    return task_directory(task_id) / 'source.zip'


def archive_digest(path):
    result = hashlib.sha256()
    with open(path, 'rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


async def freeze_zip(task_id, source_path):
    target = archive_path(task_id)
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    target.parent.chmod(0o700)
    if target.exists():
        return str(target)
    temporary = target.with_suffix('.part')
    temporary.touch(mode=0o600, exist_ok=True)
    temporary.chmod(0o600)
    await asyncio.to_thread(shutil.copyfile, source_path, temporary)
    if temporary.stat().st_size > MAX_ARCHIVE_BYTES:
        temporary.unlink(missing_ok=True)
        raise ValueError('Source archive exceeds limit')
    os.replace(temporary, target)
    return str(target)


def inspect_archive(task_id, config, is_text_file, should_exclude):
    target = archive_path(task_id)
    rows = []
    seen = set()
    source_config = config.get('scan_config') or {}
    selected = source_config.get('file_paths') or []
    targets = {str(PurePosixPath(path.replace('\\', '/'))) for path in selected}
    excludes = source_config.get('exclude_patterns') or []
    from app.services.scan_options import get_analysis_config
    maximum = get_analysis_config(config)['max_analyze_files']
    expanded = 0
    with zipfile.ZipFile(target) as archive:
        members = archive.infolist()
        if len(members) > MAX_FILES:
            raise ValueError('Too many archive entries')
        for member in members:
            expanded += member.file_size
            path = PurePosixPath(member.filename.replace('\\', '/'))
            if path.is_absolute() or '..' in path.parts or not path.parts or ':' in path.parts[0]:
                raise ValueError('Unsafe archive path')
            if stat.S_ISLNK(member.external_attr >> 16):
                raise ValueError('Archive links are unsupported')
            if expanded > MAX_EXPANDED_BYTES:
                raise ValueError('Expanded archive exceeds limit')
            if member.is_dir():
                continue
            normalized = str(path)
            if len(normalized.encode('utf-8')) > 1024:
                raise ValueError('Source path exceeds limit')
            if normalized in seen:
                raise ValueError('Duplicate archive path')
            seen.add(normalized)
            if not targets and (should_exclude(normalized, excludes) or not is_text_file(normalized)):
                continue
            if targets and normalized not in targets:
                continue
            # An explicit file selection is already a fixed requested manifest.
            if not targets and maximum and len(rows) >= maximum:
                break
            row = {'file_path': normalized, 'member_name': member.filename, 'source_hash': None,
                   'status': 'pending', 'skip_reason': None, 'line_count': 0}
            if should_exclude(normalized, excludes):
                row.update(status='skipped', skip_reason='EXCLUDED_BY_POLICY')
            elif not is_text_file(normalized):
                row.update(status='skipped', skip_reason='UNSUPPORTED_TYPE')
            elif member.file_size > settings.MAX_FILE_SIZE_BYTES:
                row.update(status='skipped', skip_reason='FILE_TOO_LARGE')
            else:
                content = archive.read(member)
                row['source_hash'] = hashlib.sha256(content).hexdigest()
                if not content.strip():
                    row.update(status='skipped', skip_reason='EMPTY_FILE')
            rows.append(row)
    for missing in sorted(targets - {row['file_path'] for row in rows}):
        reason = 'EXCLUDED_BY_POLICY' if should_exclude(missing, excludes) else 'UNSUPPORTED_TYPE' if not is_text_file(missing) else 'MISSING_SOURCE'
        rows.append({'file_path': missing, 'member_name': missing, 'source_hash': None,
                     'status': 'skipped', 'skip_reason': reason, 'line_count': 0})
    return rows, archive_digest(target)


def read_file(task_id, row):
    with zipfile.ZipFile(archive_path(task_id)) as archive:
        data = archive.read(row['member_name'])
    if hashlib.sha256(data).hexdigest() != row['source_hash']:
        raise ValueError('Frozen file hash mismatch')
    return data.decode('utf-8', errors='replace')


def write_manifest(task_id, metadata):
    path = task_directory(task_id) / 'manifest.json'
    temporary = path.with_suffix('.part')
    temporary.touch(mode=0o600, exist_ok=True)
    temporary.chmod(0o600)
    source_stat = archive_path(task_id).stat()
    metadata.update(archive_size=source_stat.st_size, archive_mtime_ns=source_stat.st_mtime_ns)
    temporary.write_text(json.dumps(metadata), encoding='utf-8')
    os.replace(temporary, path)


def snapshot_exists(task_id):
    try:
        archive = archive_path(task_id)
        metadata = json.loads((task_directory(task_id) / 'manifest.json').read_text())
        info = archive.stat()
        return info.st_size == metadata.get('archive_size') and info.st_mtime_ns == metadata.get('archive_mtime_ns')
    except (ValueError, OSError, TypeError):
        return False
