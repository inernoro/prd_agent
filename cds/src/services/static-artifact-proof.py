"""Private publication proofs for generated static output, never legacy adoption.

The publisher and reclaimer hold the same target retention lock. A proof is
write-once, outside public content, bound to target/commit/root identity. Removal
uses only proved entries; a private journal permits retry after our own partial
unlink without accepting additions or changed content. No recursive fallback.
"""
import hashlib
import json
import os
import pathlib
import re
import stat
import sys
import time

PROOF_LIMIT = 4 * 1024 * 1024
ENTRY_LIMIT = 20000
CONTENT_LIMIT = 8 * 1024 ** 3
DATA_NAMES = {'.cds-data', '.cds-run-data'}


def proof_identity(s):
    return str(s.st_dev) + ':' + str(s.st_ino)


def proof_directory(p):
    s = p.lstat()
    if not stat.S_ISDIR(s.st_mode) or p.resolve() != p.absolute():
        raise ValueError('static-directory-identity-unconfirmed')
    return s


def proof_store(release_root, create=False):
    proof_directory(release_root)
    root = release_root / 'static-proofs'
    if create:
        try:
            root.mkdir(mode=0o700)
        except FileExistsError:
            pass
    s = proof_directory(root)
    if s.st_uid != os.getuid() or s.st_mode & 0o077:
        raise ValueError('static-proof-storage-not-private')
    return root


def proof_read(p):
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        s = os.fstat(fd)
        if not stat.S_ISREG(s.st_mode) or s.st_uid != os.getuid() or s.st_nlink != 1 or s.st_mode & 0o077 or s.st_size > PROOF_LIMIT:
            raise ValueError('static-proof-file-unconfirmed')
        raw = os.read(fd, PROOF_LIMIT + 1)
        if len(raw) > PROOF_LIMIT or len(raw) != s.st_size:
            raise ValueError('static-proof-budget-exceeded')
        return json.loads(raw), hashlib.sha256(raw).hexdigest()
    finally:
        os.close(fd)


def proof_write_once(p, value):
    raw = json.dumps(value, sort_keys=True, separators=(',', ':')).encode()
    journal = p.name.endswith('.deleting')
    if len(raw) > (16 * 1024 if journal else PROOF_LIMIT):
        raise ValueError('static-proof-budget-exceeded')
    # Normal removal drops both records; abandoned records must not make this
    # new bookkeeping itself unbounded after repeated interrupted publications.
    count, stored = 0, 0
    with os.scandir(p.parent) as records:
        for entry in records:
            s = entry.stat(follow_symlinks=False)
            if entry.name.endswith('.deleting') != journal:
                continue
            count += 1
            stored += s.st_size
            if not stat.S_ISREG(s.st_mode) or count >= 1024 or stored + len(raw) > (16 if journal else 48) * 1024 * 1024:
                raise ValueError('static-proof-storage-budget-exceeded')
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as f:
            f.write(raw)
            f.flush()
            os.fsync(fd)
    finally:
        os.close(fd)
    directory = os.open(p.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def proof_mount_guard(root):
    # Mounts on the host itself also matter, including same-device bind mounts.
    with open('/proc/self/mountinfo', encoding='utf-8') as f:
        for line in f:
            fields = line.split()
            if len(fields) < 6:
                raise ValueError('static-mount-query-unconfirmed')
            name = re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), fields[4])
            mount = pathlib.Path(os.path.normpath(name))
            if mount == root or root in mount.parents:
                raise ValueError('static-host-mount')


def proof_snapshot(root):
    identity = proof_identity(proof_directory(root))
    proof_mount_guard(root)
    entries = []
    total = 0
    deadline = time.monotonic() + 20

    def visit(fd, prefix, depth):
        nonlocal total
        if depth > 64:
            raise ValueError('static-content-budget-exceeded')
        with os.scandir(fd) as names:
            for entry in names:
                if len(entries) >= ENTRY_LIMIT or time.monotonic() > deadline:
                    raise ValueError('static-content-budget-exceeded')
                if entry.name in DATA_NAMES:
                    raise ValueError('static-persistent-data')
                name = prefix + entry.name
                s = os.stat(entry.name, dir_fd=fd, follow_symlinks=False)
                row = {'path': name, 'identity': proof_identity(s)}
                if stat.S_ISDIR(s.st_mode):
                    row['type'] = 'directory'
                    entries.append(row)
                    child = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    try:
                        if proof_identity(os.fstat(child)) != row['identity'] or s.st_dev != os.fstat(fd).st_dev:
                            raise ValueError('static-directory-changed')
                        visit(child, name + '/', depth + 1)
                    finally:
                        os.close(child)
                elif stat.S_ISREG(s.st_mode) and s.st_nlink == 1:
                    total += s.st_size
                    if total > CONTENT_LIMIT:
                        raise ValueError('static-content-budget-exceeded')
                    child = os.open(entry.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                    try:
                        before = os.fstat(child)
                        if proof_identity(before) != row['identity'] or before.st_nlink != 1 or not stat.S_ISREG(before.st_mode):
                            raise ValueError('static-file-changed')
                        digest = hashlib.sha256()
                        read_bytes = 0
                        with os.fdopen(child, 'rb', closefd=False) as content:
                            for chunk in iter(lambda: content.read(1024 * 1024), b''):
                                read_bytes += len(chunk)
                                if read_bytes > before.st_size or time.monotonic() > deadline:
                                    raise ValueError('static-content-budget-exceeded')
                                digest.update(chunk)
                        after = os.fstat(child)
                        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                            raise ValueError('static-file-changed')
                        row.update(type='file', size=before.st_size, sha256=digest.hexdigest(),
                                   mtimeNs=before.st_mtime_ns, ctimeNs=before.st_ctime_ns)
                    finally:
                        os.close(child)
                    entries.append(row)
                else:
                    raise ValueError('static-unknown-file-type-or-hardlink')

    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        if proof_identity(os.fstat(fd)) != identity:
            raise ValueError('static-directory-changed')
        visit(fd, '', 0)
    finally:
        os.close(fd)
    if proof_identity(proof_directory(root)) != identity:
        raise ValueError('static-directory-changed')
    return identity, sorted(entries, key=lambda row: row['path'])


def static_owner(root, target, name, commit, identity):
    return {'version': 1, 'target': target, 'release': name, 'commit': commit,
            'publicRoot': str(root.parent.parent), 'identity': identity}


def seal_static_artifact(root, release_root, target, name, commit):
    if not re.fullmatch(r'rel_[0-9a-f]{16}(?:-auto-restore)?', name) or not re.fullmatch('[0-9a-f]{40}', commit):
        raise ValueError('static-publication-owner-unconfirmed')
    if release_root.name != target or root.name != name or root.parent.name != '.releases':
        raise ValueError('static-publication-owner-unconfirmed')
    proof_directory(root.parent)
    identity, entries = proof_snapshot(root)
    owner = static_owner(root, target, name, commit, identity)
    if len(json.dumps({**owner, 'manifestSha256': '0' * 64}, sort_keys=True, separators=(',', ':')).encode()) > 16 * 1024:
        raise ValueError('static-proof-budget-exceeded')
    value = {**owner, 'entries': entries}
    proof_write_once(proof_store(release_root, True) / (name + '.json'), value)


def reclaim_static_artifact(root, release_root, target, name, commit, identity, dry_run, check_live, progress):
    store = proof_store(release_root)
    proof_path = store / (name + '.json')
    journal_path = store / (name + '.deleting')
    context = static_owner(root, target, name, commit, identity)
    started = os.path.lexists(journal_path)
    if not os.path.lexists(root):
        marker = proof_read(journal_path)[0] if started else None
        if not isinstance(marker, dict) or any(marker.get(k) != v for k, v in context.items()) or not re.fullmatch('[0-9a-f]{64}', str(marker.get('manifestSha256'))):
            raise ValueError('static-partial-removal-unconfirmed')
        if os.path.lexists(proof_path) and proof_read(proof_path)[1] != marker['manifestSha256']:
            raise ValueError('static-proof-changed')
        check_live()
        if not dry_run:
            if os.path.lexists(proof_path):
                proof_path.unlink()
            journal_path.unlink()
        return
    value, digest = proof_read(proof_path)
    if value.get('version') != 1 or value.get('target') != target or value.get('release') != name or value.get('commit') != commit or value.get('publicRoot') != str(root.parent.parent) or not identity or value.get('identity') != identity:
        raise ValueError('static-publication-owner-unconfirmed')
    recorded = value.get('entries')
    if not isinstance(recorded, list) or len(recorded) > ENTRY_LIMIT:
        raise ValueError('static-proof-budget-exceeded')
    expected = {}
    for row in recorded:
        if not isinstance(row, dict):
            raise ValueError('static-proof-invalid')
        path = row.get('path')
        if not isinstance(path, str) or not path or any(p in ('', '.', '..') or p in DATA_NAMES for p in path.split('/')) or path.startswith('/') or '\x00' in path or path in expected:
            raise ValueError('static-proof-invalid')
        if row.get('type') not in ('directory', 'file') or not re.fullmatch(r'\d+:\d+', str(row.get('identity'))):
            raise ValueError('static-proof-invalid')
        expected[path] = row
    journal = {**context, 'manifestSha256': digest}
    if started and proof_read(journal_path)[0] != journal:
        raise ValueError('static-partial-removal-unconfirmed')
    actual_identity, entries = proof_snapshot(root)
    if actual_identity != identity:
        raise ValueError('static-directory-changed')
    actual = {row['path']: row for row in entries}
    if any(expected.get(k) != row for k, row in actual.items()) or (not started and actual != expected):
        raise ValueError('static-content-changed-or-unconfirmed')
    check_live()
    proof_mount_guard(root)
    if proof_read(proof_path)[1] != digest:
        raise ValueError('static-proof-changed')
    if dry_run:
        return
    if not started:
        proof_write_once(journal_path, journal)
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    first = True
    try:
        if proof_identity(os.fstat(fd)) != identity:
            raise ValueError('static-directory-changed')
        # Every directory component is opened without following symlinks.
        for row in sorted(entries, key=lambda r: (r['path'].count('/'), r['type'] == 'directory'), reverse=True):
            parent = os.dup(fd)
            try:
                parts = row['path'].split('/')
                for i, part in enumerate(parts[:-1]):
                    child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                    if proof_identity(os.fstat(child)) != expected['/'.join(parts[:i + 1])]['identity']:
                        os.close(child)
                        raise ValueError('static-directory-changed')
                    os.close(parent)
                    parent = child
                current = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
                if proof_identity(current) != row['identity'] or (row['type'] == 'file' and (not stat.S_ISREG(current.st_mode) or current.st_nlink != 1 or (current.st_size, current.st_mtime_ns, current.st_ctime_ns) != (row['size'], row['mtimeNs'], row['ctimeNs']))):
                    raise ValueError('static-entry-changed')
                if row['type'] == 'file':
                    os.unlink(parts[-1], dir_fd=parent)
                else:
                    os.rmdir(parts[-1], dir_fd=parent)
                if first:
                    first = False
                    progress('started')
            finally:
                os.close(parent)
        check_live()
        if proof_identity(proof_directory(root)) != identity:
            raise ValueError('static-directory-changed')
        root.rmdir()
        progress('directory-removed')
        proof_path.unlink()
        journal_path.unlink()
    finally:
        os.close(fd)


def pending_static_artifacts(versions, release_root):
    """Only our private, bound journals can nominate an absent directory."""
    try:
        store = proof_store(release_root)
    except FileNotFoundError:
        return []
    pending = []
    count = 0
    with os.scandir(store) as records:
        for entry in records:
            count += 1
            if count > 2048:
                raise ValueError('static-proof-storage-budget-exceeded')
            if not entry.name.endswith('.deleting'):
                continue
            name = entry.name[:-9]
            if not re.fullmatch(r'rel_[0-9a-f]{16}(?:-auto-restore)?', name):
                raise ValueError('static-partial-removal-unconfirmed')
            if os.path.lexists(versions / name) and stat.S_ISDIR((versions / name).lstat().st_mode):
                continue  # Ordinary existing roots are already in the directory inventory.
            marker = proof_read(store / entry.name)[0]
            if not isinstance(marker, dict) or marker.get('version') != 1 or marker.get('target') != release_root.name or marker.get('release') != name or marker.get('publicRoot') != str(versions.parent) or not re.fullmatch('[0-9a-f]{40}', str(marker.get('commit'))) or not re.fullmatch(r'\d+:\d+', str(marker.get('identity'))) or not re.fullmatch('[0-9a-f]{64}', str(marker.get('manifestSha256'))):
                raise ValueError('static-partial-removal-unconfirmed')
            pending.append((name, marker['identity'], marker['commit']))
    return pending


if __name__ == '__main__' and len(sys.argv) > 1 and sys.argv[1] == 'seal':
    if len(sys.argv) != 7:
        raise SystemExit('static publication command invalid')
    seal_static_artifact(pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]), *sys.argv[4:])
