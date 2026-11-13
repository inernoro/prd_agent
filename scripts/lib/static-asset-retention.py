#!/usr/bin/env python3
"""Preview or retain managed static assets; unknown provenance always stays.

A compatibility window is opt-in. It controls inheritance into new staging and
retires only individually verified generated files. Native assets of the
current/previous releases remain protected. Age is used only after a manifest
and the actual file SHA-256 agree. Preview is read-only and conveys no permit;
apply repeats inventory under the same lock used by activation and rollback.
"""
from __future__ import annotations
import argparse
import contextlib
import errno
import fcntl
import hashlib
import itertools
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import time

MANIFEST = '.static-assets-retention.json'
LOCK = '.static-assets-retention.lock'
LIMIT = 100_000
PROOF_CACHE = {}
GENERATED_ASSET_SUFFIXES = {'.js', '.mjs', '.css', '.map', '.woff', '.woff2', '.ttf', '.eot', '.otf', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.avif', '.wasm'}


def assert_no_persistent_payload(destination):
    scanned = 0
    for directory, dirs, names in os.walk(destination, followlinks=False):
        for name in dirs + names:
            scanned += 1
            if scanned > LIMIT:
                raise ValueError('static preparation exceeds inventory budget')
            low = name.lower()
            if low in {'.cds-data', '.cds-run-data', 'ibdata1', 'wiredtiger', 'dump.rdb', 'appendonly.aof'} or low.startswith('ib_logfile') or low.endswith(('.ibd', '.sqlite', '.sqlite3', '.db', '.sql')):
                raise ValueError('persistent or unknown database payload in static preparation; retained for inspection')


def identity(p: Path):
    s = p.lstat()
    if not stat.S_ISDIR(s.st_mode):
        raise ValueError('static directory is not an ordinary directory')
    return s.st_dev, s.st_ino


def open_parent(p: Path, create=False):
    # Pin every ancestor. O_NOFOLLOW on just the final file does not reject
    # an exchanged parent directory that became a link after inventory.
    parts = p.absolute().parts
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in parts[1:-1]:
            if create:
                try:
                    os.mkdir(part, 0o755, dir_fd=fd)
                except FileExistsError:
                    pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd, parts[-1]
    except BaseException:
        os.close(fd)
        raise


def file_proof(p: Path):
    parent, name = open_parent(p)
    fd = None
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size > 512 * 1024 * 1024:
            raise ValueError('static asset is not a bounded regular file')
        cache_key = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
        digest = PROOF_CACHE.get(cache_key)
        if digest is None:
            h = hashlib.sha256()
            with os.fdopen(fd, 'rb', closefd=False) as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b''):
                    h.update(block)
            digest = h.hexdigest()
            PROOF_CACHE[cache_key] = digest
        after = os.fstat(fd)
        actual = os.stat(name, dir_fd=parent, follow_symlinks=False)
        current, _ = open_parent(p)
        try:
            if (os.fstat(current).st_dev, os.fstat(current).st_ino) != (os.fstat(parent).st_dev, os.fstat(parent).st_ino):
                raise ValueError('static asset parent replaced')
        finally:
            os.close(current)
        stamp = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns)
        if stamp(before) != stamp(after) or stamp(before) != stamp(actual) or before.st_ctime_ns != after.st_ctime_ns or after.st_ctime_ns != actual.st_ctime_ns:
            raise ValueError('static asset identity changed')
        return digest, before.st_blocks * 512, stamp(before)
    finally:
        if fd is not None:
            os.close(fd)
        os.close(parent)


def retain_file(src: Path, dst: Path, digest: str):
    source_parent, source_name = open_parent(src)
    output_parent, output_name = open_parent(dst, create=True)
    fd = None
    try:
        fd = os.open(source_name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=source_parent)
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError('static source replaced by a special file')
        try:
            # linkat follows our own pinned regular-file descriptor, not a
            # pathname that could have been exchanged for a symbolic link.
            os.link('/proc/self/fd/' + str(fd), output_name, dst_dir_fd=output_parent, follow_symlinks=True)
        except OSError as error:
            if error.errno != errno.EXDEV:
                raise
            import shutil
            out = os.open(output_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=output_parent)
            with os.fdopen(fd, 'rb', closefd=False) as inp, os.fdopen(out, 'wb') as output:
                shutil.copyfileobj(inp, output)
        if file_proof(dst)[0] != digest:
            raise ValueError('retained asset changed during copy')
    finally:
        if fd is not None:
            os.close(fd)
        os.close(source_parent)
        os.close(output_parent)


def files(root: Path, select=None):
    if not root.exists() and not root.is_symlink():
        return []
    start = identity(root)
    result = []
    scanned = 0
    def walk_error(error):
        raise error
    for base, dirs, names in os.walk(root, followlinks=False, onerror=walk_error):
        scanned += len(dirs) + len(names)
        if scanned > LIMIT:
            raise ValueError('static inventory exceeds bounded traversal budget')
        directory = Path(base)
        identity(directory)
        for name in dirs:
            identity(directory / name)
        for name in sorted(names):
            p = directory / name
            relative = p.relative_to(root).as_posix()
            if select is None or select(relative):
                result.append((relative, p, file_proof(p)))
            if len(result) > LIMIT:
                raise ValueError('static inventory exceeds bounded file budget')
    if identity(root) != start:
        raise ValueError('static directory replaced')
    return result


def load_manifest(parent: Path):
    try:
        p = parent / MANIFEST
        fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            os.close(fd)
            return None, 'manifest-invalid'
        with os.fdopen(fd) as f:
            raw = f.read(4 * 1024 * 1024 + 1)
            if len(raw) > 4 * 1024 * 1024:
                return None, 'manifest-too-large'
            data = json.loads(raw)
        if not isinstance(data, dict) or data.get('schema') != 1 or not isinstance(data.get('files'), dict) or len(data['files']) > LIMIT:
            return None, 'manifest-invalid'
        if data.get('directoryIdentity') is not None and tuple(data['directoryIdentity']) != identity(parent):
            return None, 'release-directory-replaced'
        return data, None
    except FileNotFoundError:
        return None, 'manifest-missing'
    except OSError:
        return None, 'manifest-query-failed'
    except (ValueError, TypeError):
        return None, 'manifest-invalid'


def valid_record(value, digest: str, now: float):
    return isinstance(value, dict) and value.get('sha256') == digest and isinstance(value.get('native'), bool) \
        and isinstance(value.get('lastServedAt'), (int, float)) and math.isfinite(value['lastServedAt']) \
        and 0 <= value['lastServedAt'] <= now + 300


def save_manifest(parent: Path, data, expected):
    import secrets
    fd, name = open_parent(parent / MANIFEST)
    temp = MANIFEST + '.tmp-' + secrets.token_hex(16)
    try:
        if (os.fstat(fd).st_dev, os.fstat(fd).st_ino) != expected or identity(parent) != expected:
            raise ValueError('static release identity changed')
        output = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=fd)
        with os.fdopen(output, 'w') as f:
            json.dump(data, f, separators=(',', ':'), sort_keys=True)
            f.flush()
            os.fsync(f.fileno())
        if identity(parent) != expected:
            raise ValueError('static release replaced before manifest update')
        os.replace(temp, name, src_dir_fd=fd, dst_dir_fd=fd)
        os.fsync(fd)
    finally:
        # A failed private metadata temp stays for inspection; never unlink
        # an unconfirmed replacement supplied by another writer.
        os.close(fd)


def retain(root: Path, destination: Path, days: int, release_id: str, apply: bool):
    now = time.time()
    root_id, destination_id = identity(root), identity(destination)
    if destination.resolve().parent not in (root.resolve(), (root / '.releases').resolve()):
        raise ValueError('destination is outside the managed static root')
    links = {n: os.readlink(root / n) if (root / n).is_symlink() else None for n in ('current', 'previous')}
    def fence():
        if identity(root) != root_id or identity(destination) != destination_id:
            raise ValueError('static root or destination replaced')
        if any((os.readlink(root / n) if (root / n).is_symlink() else None) != v for n, v in links.items()):
            raise ValueError('current or previous changed; plan invalidated')
    native = files(destination / 'assets')
    own, _ = load_manifest(destination)
    if release_id:
        assert_no_persistent_payload(destination)
        if not re.fullmatch(r'[A-Za-z0-9._-]+', release_id) or (destination / MANIFEST).exists() or (destination / MANIFEST).is_symlink():
            raise ValueError('fresh staging identity is invalid or already recorded')
        own = {'schema': 1, 'releaseId': release_id, 'createdAt': now, 'directoryIdentity': destination_id, 'rootFiles': {name: {'sha256': proof[0], 'identity': list(proof[2]), 'native': True, 'lastServedAt': now} for name, _, proof in files(destination, lambda n: n == 'index.html')}, 'files': {
            name: {'sha256': proof[0], 'identity': list(proof[2]), **({'native': True, 'lastServedAt': now} if Path(name).suffix.lower() in GENERATED_ASSET_SUFFIXES else {'native': False})} for name, _, proof in native}}
    elif own is None:
        # Rollback into a legacy tree: all original bytes stay unclassified.
        own = {'schema': 1, 'releaseId': destination.name, 'files': {}}
    existing = {name: proof[0] for name, _, proof in native}
    sources = [root / 'current', root / 'previous', root]
    releases = root / '.releases'
    if releases.exists():
        identity(releases)
        entries = list(itertools.islice(releases.iterdir(), 1025))
        if len(entries) > 1024:
            raise ValueError('static release inventory exceeds budget')
        sources.extend(sorted(entries))
    rows, seen, changes = [], set(), []
    incomplete_sources = []
    expired_seen = {}
    for candidate in sources:
        if not candidate.exists():
            if candidate.is_symlink():
                raise ValueError('static source reference is unresolved')
            continue
        parent = candidate.resolve()
        if parent != root.resolve() and parent.parent != releases.resolve():
            raise ValueError('static source is outside the managed release root')
        if parent in seen or parent == destination.resolve():
            continue
        seen.add(parent)
        source_id = identity(parent)
        meta, meta_reason = load_manifest(parent)
        if meta_reason:
            incomplete_sources.append({'source': parent.name, 'reason': meta_reason})
        refreshed = False
        is_current = candidate == root / 'current'
        is_anchor = candidate in (root / 'current', root / 'previous')
        if is_current and meta:
            for name, record in meta.get('rootFiles', {}).items():
                if not safe_relative(name):
                    raise ValueError('invalid root-file identity')
                root_proof = file_proof(parent / name)
                if valid_record(record, root_proof[0], now) and tuple(record.get('identity', []))[:2] == root_proof[2][:2]:
                    record['identity'] = list(root_proof[2])
                    record['lastServedAt'] = now
                    refreshed = True
        def select(name):
            record = (meta or {}).get('files', {}).get(name)
            if name in existing:
                return bool(is_current and isinstance(record, dict) and record.get('native'))
            if name in expired_seen and isinstance(record, dict) and not (is_anchor and record.get('native')):
                s = (parent / 'assets' / name).lstat()
                same_object = tuple(record.get('identity', [])) == (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns)
                digest, served = expired_seen[name]
                return not (same_object and record.get('sha256') == digest and record.get('lastServedAt', now) <= served)
            return True
        for name, src, proof in files(parent / 'assets', select):
            digest, allocated, stamp = proof
            record = (meta or {}).get('files', {}).get(name)
            known = valid_record(record, digest, now)
            if known:
                record = dict(record)
                if is_current and record['native']:
                    record['lastServedAt'] = now
                    meta['files'][name] = record
                    refreshed = True
            expired = known and now - record['lastServedAt'] > days * 86400
            protected = is_anchor and known and record['native']
            action = 'already-present' if name in existing else 'omit-expired-inheritance' if expired and not protected else 'retain'
            reason = 'native-anchor' if protected else 'verified-window' if known and not expired else 'verified-expired' if known else (meta_reason or ('digest-mismatch' if isinstance(record, dict) and record.get('sha256') != digest else 'unverified-inheritance'))
            rows.append({'source': parent.name if parent != root.resolve() else 'legacy-root', 'asset': name,
                         'action': action, 'reason': reason, 'allocatedBytes': allocated})
            if len(rows) > LIMIT:
                raise ValueError('aggregate static inventory exceeds bounded object budget')
            if action == 'omit-expired-inheritance':
                expired_seen[name] = (digest, record['lastServedAt'])
                continue
            if name in existing:
                # Keep destination bytes. Refresh only matching inherited proofs.
                old = own['files'].get(name)
                if existing[name] == digest and known and valid_record(old, digest, now) and not old['native']:
                    old['lastServedAt'] = max(old['lastServedAt'], record['lastServedAt'])
                continue
            if apply:
                fence()
                if identity(parent) != source_id or file_proof(src)[2] != stamp:
                    raise ValueError('source changed after inventory')
                dst = destination / 'assets' / name
                retain_file(src, dst, digest)
            existing[name] = digest
            retained_proof = file_proof(destination / 'assets' / name) if apply else proof
            own['files'][name] = ({**record, 'native': False, 'identity': list(retained_proof[2])} if known else {'sha256': digest, 'identity': list(retained_proof[2]), 'native': False})
        if refreshed and apply:
            changes.append((parent, meta, source_id))
    fence()
    if apply:
        for parent, meta, expected in changes:
            save_manifest(parent, meta, expected)
        own['directories'] = {Path(d).relative_to(destination).as_posix(): list(identity(Path(d))) for d, _, _ in os.walk(destination, followlinks=False) if Path(d) != destination}
        save_manifest(destination, own, destination_id)
    return {'dryRun': not apply, 'compatibilityDays': days, 'scanStatus': 'partial' if incomplete_sources or any(r['reason'] not in ('native-anchor', 'verified-window', 'verified-expired') for r in rows) else 'complete', 'unconfirmedSources': incomplete_sources,
            'retained': sum(r['action'] == 'retain' for r in rows), 'omittedExpiredInheritance': sum(r['action'] == 'omit-expired-inheritance' for r in rows),
            'note': 'allocatedBytes is object evidence; omitting a hard link is not filesystem space reclaimed', 'scannedObjects': len(rows), 'objectsTruncated': len(rows) > 1024, 'objects': rows[:1024]}


def safe_relative(name):
    return isinstance(name, str) and bool(name) and not name.startswith('/') and all(p not in ('', '.', '..') for p in name.split('/')) and '\\' not in name


def retire_versions(root: Path, days: int, apply: bool):
    now = time.time()
    identity(root)
    if root.resolve() != root.absolute():
        raise ValueError('static root aliases are unconfirmed')
    current = {name: os.readlink(root / name) if (root / name).is_symlink() else None for name in ('current', 'previous')}
    if not current['current']:
        raise ValueError('current static reference is unconfirmed')
    anchors = {(root / name).resolve(strict=True) for name in current if current[name]}
    versions = root / '.releases'
    identity(versions)
    if versions.resolve() != versions.absolute():
        raise ValueError('version root is a symbolic alias')
    objects = []
    for p in versions.iterdir():
        if len(objects) >= 1024:
            raise ValueError('version inventory exceeds budget')
        if p.is_symlink() or not p.is_dir():
            continue
        meta, reason = load_manifest(p)
        if not meta or not isinstance(meta.get('rootFiles'), dict) or not isinstance(meta.get('createdAt'), (int,float)) or tuple(meta.get('directoryIdentity', [])) != identity(p):
            objects.append((p, None, reason or 'legacy-content-proof-unconfirmed'))
        else:
            objects.append((p, meta, None))
    recent = {p for p, meta, _ in sorted(objects, key=lambda row: (row[1] or {}).get('createdAt', 0), reverse=True)[:20] if meta}
    report = {'dryRun': not apply, 'scanned': len(objects), 'eligibleVersions': 0, 'candidateFiles': 0, 'retiredFiles': 0, 'heldFiles': 0, 'failedFiles': 0, 'pendingVersions': 0, 'protected': {}, 'scope': 'verified generated files only; unknown payloads remain'}
    before = os.statvfs(root)
    try:
        ids = subprocess.check_output(['docker', 'ps', '-aq', '--no-trunc'], stderr=subprocess.PIPE, timeout=15).decode().splitlines()
        if len(ids) > 5000 or any(not re.fullmatch('[a-f0-9]{64}', v) for v in ids):
            raise ValueError('container inventory is incomplete')
        mounts = []
        if ids:
            raw = subprocess.check_output(['docker', 'inspect', '--format', '{{json .Mounts}}', *ids], stderr=subprocess.PIPE, timeout=15)
            if len(raw) > 16 * 1024 * 1024 or len(raw.splitlines()) != len(ids):
                raise ValueError('container mount inventory is incomplete')
            for line in raw.splitlines():
                values = json.loads(line)
                if not isinstance(values, list):
                    raise ValueError('mount inventory is invalid')
                for m in values:
                    if m.get('Type') == 'tmpfs':
                        continue
                    if not m.get('Source') or not os.path.isabs(m['Source']):
                        raise ValueError('mount source is unknown')
                    mounts.append(Path(m['Source']).resolve(strict=True))
    except Exception:
        return {**report, 'scanStatus': 'partial', 'queryError': 'running-or-stopped-container-references-unconfirmed', 'pendingVersions': len(objects), 'filesystemNetAvailableChange': None}
    attempted = 0
    for p, meta, reason in sorted(objects, key=lambda row: ((row[1] or {}).get('createdAt', 0), row[0].name)):
        if p.resolve() in anchors or p in recent:
            report['protected'][p.name] = 'current-previous-or-recent-20'
            continue
        if not meta:
            report['protected'][p.name] = reason
            continue
        if any(p == m or p in m.parents or m in p.parents for m in mounts):
            report['protected'][p.name] = 'running-or-stopped-container'
            continue
        records = {**{('assets/' + n): r for n, r in meta['files'].items()}, **meta['rootFiles']}
        if not any(safe_relative(n) and os.path.lexists(p / n) for n in records):
            report['protected'][p.name] = 'unknown-or-changed-remaining-content'
            continue
        native = [r for r in records.values() if isinstance(r,dict) and r.get('native')]
        if not native or any(not isinstance(r.get('lastServedAt'), (int,float)) or now - r['lastServedAt'] <= days * 86400 for r in native):
            report['protected'][p.name] = 'compatibility-window'
            continue
        report['eligibleVersions'] += 1
        if attempted >= 2:
            report['pendingVersions'] += 1
            continue
        attempted += 1
        expected_dir = identity(p)
        known_dirs = meta.get('directories', {})
        if any(not safe_relative(n) or tuple(v) != identity(p / n) for n,v in known_dirs.items() if (p/n).exists()):
            report['protected'][p.name] = 'directory-replaced'
            continue
        unknown_count = 0
        for directory, dirs, names in os.walk(p, followlinks=False):
            for name in names:
                relative = (Path(directory) / name).relative_to(p).as_posix()
                if relative != MANIFEST and relative not in records:
                    unknown_count += 1
            for name in dirs:
                relative = (Path(directory) / name).relative_to(p).as_posix()
                if relative not in known_dirs or (Path(directory)/name).is_symlink():
                    unknown_count += 1
        report['heldFiles'] += unknown_count
        manifest_digest = file_proof(p / MANIFEST)[0]
        for name, record in records.items():
            if not safe_relative(name):
                report['heldFiles'] += 1
                continue
            target = p / name
            try:
                proof = file_proof(target)
            except FileNotFoundError:
                continue
            except Exception:
                report['heldFiles'] += 1
                continue
            if not valid_record(record, proof[0], now) or tuple(record.get('identity', [])) != proof[2] or now - record['lastServedAt'] <= days * 86400:
                report['heldFiles'] += 1
                continue
            report['candidateFiles'] += 1
            if not apply:
                continue
            fd = None
            try:
                if identity(p) != expected_dir or any((os.readlink(root / n) if (root / n).is_symlink() else None) != v for n,v in current.items()):
                    raise ValueError('version identity or references changed')
                fd, leaf = open_parent(target)
                s = os.stat(leaf, dir_fd=fd, follow_symlinks=False)
                if (s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns) != proof[2]:
                    raise ValueError('file identity changed')
                os.unlink(leaf, dir_fd=fd)
                report['retiredFiles'] += 1
            except Exception:
                report['failedFiles'] += 1
            finally:
                if fd is not None:
                    os.close(fd)
        # Only remove now-empty private directories; unknown files and data
        # keep both their path and the manifest. No recursive removal fallback.
        if apply:
            for directory, dirs, names in os.walk(p, topdown=False, followlinks=False):
                d = Path(directory)
                relative = d.relative_to(p).as_posix()
                if d != p and relative in known_dirs and list(identity(d)) == known_dirs[relative]:
                    try: d.rmdir()
                    except OSError: pass
            if set(os.listdir(p)) == {MANIFEST} and file_proof(p / MANIFEST)[0] == manifest_digest and identity(p) == expected_dir:
                fd, leaf = open_parent(p / MANIFEST)
                try: os.unlink(leaf, dir_fd=fd)
                finally: os.close(fd)
                try: p.rmdir()
                except OSError: pass
            elif os.path.lexists(p):
                report['protected'][p.name] = 'unknown-or-changed-remaining-content'
    after = os.statvfs(root)
    report['filesystemNetAvailableChange'] = after.f_bavail * after.f_frsize - before.f_bavail * before.f_frsize
    report['scanStatus'] = 'partial' if report['heldFiles'] or report['failedFiles'] or any(v not in ('current-previous-or-recent-20','compatibility-window') for v in report['protected'].values()) else 'complete'
    return report


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--destination', type=Path)
    p.add_argument('--versions', action='store_true')
    p.add_argument('--release-id', default='')
    p.add_argument('--compat-days', type=int, required=True)
    p.add_argument('--apply', action='store_true')
    a = p.parse_args()
    if not a.versions and a.destination is None:
        p.error('--destination is required for asset inheritance')
    if a.compat_days < 30:
        p.error('compatibility window must be at least 30 days; activation requires separate production authorization')
    with contextlib.ExitStack() as stack:
        if a.apply:
            lock_path = a.root / LOCK
            inherited = os.environ.get('STATIC_ASSET_LOCK_FD')
            if inherited:
                fd = int(inherited)
                s, expected = os.fstat(fd), lock_path.lstat()
                if (s.st_dev, s.st_ino) != (expected.st_dev, expected.st_ino) or not stat.S_ISREG(s.st_mode):
                    raise ValueError('inherited static lock identity mismatch')
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            else:
                fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
                stack.callback(os.close, fd)
                fcntl.flock(fd, fcntl.LOCK_EX)
        result = retire_versions(a.root.absolute(), a.compat_days, a.apply) if a.versions else retain(a.root.absolute(), a.destination.absolute(), a.compat_days, a.release_id, a.apply)
        print(json.dumps(result, separators=(',', ':')))

if __name__ == '__main__':
    main()
