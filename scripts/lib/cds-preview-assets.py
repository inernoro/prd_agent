#!/usr/bin/env python3
"""Prepare an owned CDS preview's compatibility assets from local image IDs."""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
from html.parser import HTMLParser
import importlib.util
import itertools
import json
import os
from pathlib import Path
import re
import select
import shutil
import stat
import subprocess
import tarfile
import tempfile
import time
import uuid

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('static_asset_retention', HERE / 'static-asset-retention.py')
retention = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(retention)
IMAGE = re.compile(r'sha256:[0-9a-f]{64}\Z')
CID = re.compile(r'[0-9a-f]{64}\Z')
KEY = re.compile(r'[a-zA-Z0-9_.-]{1,128}\Z')
ASSET = re.compile(r'[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+\Z')
MiB = 1024 ** 2
ARCHIVE_LIMIT = 64 * MiB
STORE_LIMIT = 2048 * MiB
COMPATIBILITY_DAYS = 30


def command(args, timeout=15):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          text=True, timeout=timeout).stdout.strip()


def ensure_directory(directory):
    directory.mkdir(mode=0o755, exist_ok=True)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
        raise ValueError('compatibility directory ownership is unconfirmed')
    if directory.resolve(strict=True) != directory:
        raise ValueError('compatibility directory contains a symbolic alias')


class EntryAssets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.scripts = []
        self.styles = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'script' and attrs.get('type') == 'module' and attrs.get('src'):
            self.scripts.append(attrs['src'])
        if tag == 'link' and attrs.get('rel') == 'stylesheet' and attrs.get('href'):
            self.styles.append(attrs['href'])


def verify_entry(directory):
    index = directory / 'index.html'
    _, _, stamp = retention.file_proof(index)
    if not 0 < stamp[2] <= MiB:
        raise ValueError('invalid preview HTML entry')
    parser = EntryAssets()
    parser.feed(index.read_text(encoding='utf-8'))
    if not parser.scripts:
        raise ValueError('missing preview module entry')
    for url in parser.scripts + parser.styles:
        if not url.startswith('/assets/') or not ASSET.fullmatch(url.removeprefix('/assets/')):
            raise ValueError('invalid preview entry asset path')
        if not retention.file_proof(directory / url.removeprefix('/'))[2][2]:
            raise ValueError('empty preview entry asset')


def copy_preview_files(container, stage, archive, asset_mode, scope_remaining):
    source = '/app/cds/web/dist/assets/.' if asset_mode else '/app/cds/web/dist/index.html'
    with subprocess.Popen(['docker', 'cp', container + ':' + source, '-'],
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as child:
        try:
            size = 0
            deadline = time.monotonic() + 15
            while True:
                if not select.select([child.stdout], [], [], max(0, deadline - time.monotonic()))[0] or time.monotonic() >= deadline:
                    raise ValueError('preview asset export timed out')
                block = os.read(child.stdout.fileno(), MiB)
                if not block:
                    break
                size += len(block)
                if size > scope_remaining:
                    raise ValueError('preview asset export exceeds 64 MiB')
                archive.write(block)
            if child.wait(timeout=5) != 0:
                raise ValueError('preview asset export failed')
        finally:
            if child.poll() is None:
                child.kill()
    archive.seek(0)
    with tarfile.open(fileobj=archive, mode='r:') as bundle:
        for count, member in enumerate(bundle, start=1):
            name = member.name.removeprefix('./')
            if asset_mode and member.isdir() and name in ('', '.'):
                continue
            if count > 4096 or member.issparse() or not member.isfile() or member.size > size:
                raise ValueError('preview export has too many or unsafe entries')
            if asset_mode:
                if not ASSET.fullmatch(name) or Path(name).suffix not in retention.GENERATED_ASSET_SUFFIXES:
                    raise ValueError('unexpected file in preview asset directory')
                output = stage / 'assets' / name
            else:
                if name != 'index.html' or member.size > MiB:
                    raise ValueError('unexpected preview HTML entry')
                output = stage / name
            with bundle.extractfile(member) as contents, output.open('xb') as saved:
                shutil.copyfileobj(contents, saved)
    return size


def extract_image(image, stage):
    image_id, volumes = json.loads(command(['docker', 'image', 'inspect', '--format',
                                            '[{{json .Id}},{{json (index .Config "Volumes")}}]', image]))
    if image_id != image or volumes:
        raise ValueError('preview image or volume declarations are unconfirmed')
    name = 'cds-preview-assets-' + uuid.uuid4().hex
    owner = 'cds.preview-assets.export=' + name
    ref = command(['docker', 'create', '--pull=never', '--network=none', '--read-only',
                   '--name', name, '--label', owner, image])
    if not CID.fullmatch(ref):
        raise ValueError('export container ID is unconfirmed')
    try:
        # Spool only the entry and generated assets, bounded by their tar bytes.
        (stage / 'assets').mkdir()
        with tempfile.TemporaryFile(dir=stage) as archive:
            entry_size = copy_preview_files(ref, stage, archive, False, 2 * MiB)
        with tempfile.TemporaryFile(dir=stage) as archive:
            copy_preview_files(ref, stage, archive, True, ARCHIVE_LIMIT - entry_size)
        verify_entry(stage)
    finally:
        actual = json.loads(command(['docker', 'container', 'inspect', '--format',
                                     '[{{json .Id}},{{json .Name}},{{json .Image}},{{json (index .Config.Labels "cds.preview-assets.export")}}]', ref]))
        if actual != [ref, '/' + name, image, name]:
            raise ValueError('export container identity changed')
        command(['docker', 'rm', ref])


def release_anchor(root, name):
    link = root / name
    if not os.path.lexists(link):
        return None
    if not link.is_symlink() or not re.fullmatch(r'\.releases/[0-9a-f]{64}-[0-9a-f]{32}', os.readlink(link)):
        raise ValueError('unrecognized preview asset activation')
    current = link.resolve(strict=True)
    if current.parent != root / '.releases' or not current.is_dir():
        raise ValueError('preview asset version outside scope')
    return current


def current_release(root):
    return release_anchor(root, 'current')


def verify_snapshot(directory):
    verify_entry(directory)
    manifest, reason = retention.load_manifest(directory)
    if reason or manifest.get('releaseId') != directory.name:
        raise ValueError('preview asset manifest is unconfirmed')
    if manifest.get('rootFiles', {}).get('index.html', {}).get('sha256') != retention.file_proof(directory / 'index.html')[0]:
        raise ValueError('preview HTML entry identity changed')
    assets = retention.files(directory / 'assets')
    records = manifest['files']
    if set(records) != {name for name, _, _ in assets}:
        raise ValueError('preview asset inventory changed')
    for name, _, (digest, _, stamp) in assets:
        record = records[name]
        if record.get('sha256') != digest or tuple(record.get('identity', [])) != stamp:
            raise ValueError('preview asset identity changed')
    return manifest


def reject_asset_collisions(stage, anchors):
    for name, _, (digest, _, _) in retention.files(stage / 'assets'):
        for anchor in anchors:
            if anchor is None:
                continue
            old = anchor / 'assets' / name
            if os.path.lexists(old) and retention.file_proof(old)[0] != digest:
                raise ValueError('an immutable preview asset URL changed bytes')


def activate(root, image, lock, store_lock, serving_release=None):
    current = current_release(root)
    digest = image.split(':')[1]
    if current is not None and current.name.split('-')[0] == digest:
        verify_snapshot(current)
        return current
    volume = os.statvfs(root)
    allocated = int(command(['du', '-skx', '--', str(root.parent)], timeout=10).split()[0]) * 1024
    if allocated + 2 * ARCHIVE_LIMIT > STORE_LIMIT and current is not None:
        retention.retire_versions(root, COMPATIBILITY_DAYS, True)
        allocated = int(command(['du', '-skx', '--', str(root.parent)], timeout=10).split()[0]) * 1024
        volume = os.statvfs(root)
    if allocated + 2 * ARCHIVE_LIMIT > STORE_LIMIT or volume.f_bavail * volume.f_frsize < 4 * 1024 * MiB + 2 * ARCHIVE_LIMIT:
        raise ValueError('preview compatibility storage budget exhausted')
    with tempfile.TemporaryDirectory(prefix='.staging-', dir=root) as stage:
        cached = cached_release(root, image)
        if cached is None:
            extract_image(image, Path(stage))
        else:
            reuse_native_assets(cached, Path(stage))
        reject_asset_collisions(Path(stage), {current, release_anchor(root, 'previous')})
        env = {**os.environ, 'STATIC_ASSET_COMPAT_DAYS': str(COMPATIBILITY_DAYS),
               'STATIC_ASSET_RETENTION_SCRIPT': str(HERE / 'static-asset-retention.py'), 'STATIC_ASSET_LOCK_FD': str(lock)}
        subprocess.run(['sh', '-eu', '-c', '. "$1"; shift; static_release_activate_impl "$@"', 'cds-preview-assets',
                        str(HERE / 'static-release.sh'), stage, str(root), digest + '-' + uuid.uuid4().hex],
                       env=env, pass_fds=(lock, store_lock), stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=60)
    selected = current_release(root)
    verify_snapshot(selected)
    if serving_release is not None and serving_release != selected:
        set_anchor(root, 'previous', serving_release)
    return selected


def serving_image(owner, expected_id, may_be_stopped):
    keys = ('cds.instance', 'cds.project.id', 'cds.branch.id', 'cds.profile.id')
    filters = [v for key, value in zip(keys, owner) for v in ('--filter', f'label={key}={value}')]
    all_states = expected_id or may_be_stopped
    containers = command(['docker', 'ps', '-aq' if all_states else '-q', '--no-trunc', '--filter', 'label=cds.type=app', *filters]).splitlines()
    if any(not CID.fullmatch(cid) for cid in containers) or (expected_id and expected_id not in containers):
        raise ValueError('previous preview container inventory is unconfirmed')
    if not expected_id and len(containers) > 1:
        raise ValueError('serving preview identity must be specified before bootstrap')
    cid = expected_id or (containers[0] if containers else None)
    if not cid:
        return None
    prior_id, image, labels = json.loads(command(['docker', 'container', 'inspect', '--format',
        '[{{json .Id}},{{json .Image}},{{json .Config.Labels}}]', cid]))
    if prior_id != cid or not IMAGE.fullmatch(image) or labels.get('cds.type') != 'app' or [labels.get(k) for k in keys] != owner:
        raise ValueError('previous preview container ownership is unconfirmed')
    return image


def set_anchor(root, anchor, version):
    release_anchor(root, anchor)
    temporary = root / ('.anchor-' + uuid.uuid4().hex)
    temporary.symlink_to(version.relative_to(root))
    temporary.replace(root / anchor)


def cached_release(root, image):
    digest = image.removeprefix('sha256:')
    entries = list(itertools.islice((root / '.releases').iterdir(), 1025))
    if len(entries) > 1024:
        raise ValueError('preview release inventory exceeds budget')
    versions = [p for p in entries if re.fullmatch(digest + r'-[0-9a-f]{32}', p.name)]
    if not versions:
        return None
    version = max(versions, key=lambda p: p.stat(follow_symlinks=False).st_mtime_ns)
    if version.resolve(strict=True) != version:
        raise ValueError('serving preview asset directory has a symbolic alias')
    return version


def reuse_native_assets(cached, stage):
    manifest = verify_snapshot(cached)
    shutil.copyfile(cached / 'index.html', stage / 'index.html')
    (stage / 'assets').mkdir()
    for name, row in manifest['files'].items():
        if row.get('native'):
            if not ASSET.fullmatch(name):
                raise ValueError('invalid native preview asset name')
            retention.retain_file(cached / 'assets' / name, stage / 'assets' / name, row['sha256'])
    verify_entry(stage)


def keep_serving_release(root, image):
    current = current_release(root)
    if current is not None and current.name.startswith(image.removeprefix('sha256:') + '-'):
        return current
    version = cached_release(root, image)
    if version is None:
        return None
    manifest = verify_snapshot(version)
    set_anchor(root, 'previous', version)
    now = time.time()
    for row in (*manifest.get('rootFiles', {}).values(), *manifest['files'].values()):
        if row.get('native'):
            row['lastServedAt'] = now
    retention.save_manifest(version, manifest, retention.identity(version))
    return version


def scope_root(base, owner):
    root = base / hashlib.sha256('\0'.join(owner).encode()).hexdigest()
    fresh = not os.path.lexists(root)
    ensure_directory(root)
    marker = root / '.owner.json'
    expected = {'schema': 1, 'owner': owner, 'identity': list(retention.identity(root))}
    if fresh:
        fd = os.open(marker, os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'w') as stream:
            json.dump(expected, stream)
            stream.flush()
            os.fsync(stream.fileno())
    fd = os.open(marker, os.O_NOFOLLOW | os.O_NONBLOCK | os.O_RDONLY)
    with os.fdopen(fd) as stream:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid() or info.st_size > 8192 \
                or json.loads(stream.read(8193)) != expected:
            raise ValueError('preview asset scope identity is unconfirmed')
    return root


@contextmanager
def exclusive_lock(lock_path):
    fd = os.open(lock_path, os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_RDWR, 0o600)
    try:
        lock = os.fstat(fd)
        if not stat.S_ISREG(lock.st_mode) or lock.st_nlink != 1 or lock.st_uid != os.geteuid():
            raise ValueError('preview asset lock identity is unconfirmed')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield fd
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--owner', nargs=4, required=True, metavar=('INSTANCE', 'PROJECT', 'BRANCH', 'PROFILE'))
    parser.add_argument('--image', required=True)
    parser.add_argument('--previous-container')
    args = parser.parse_args()
    if not args.repo.is_absolute() or args.repo.resolve(strict=True) != args.repo or not IMAGE.fullmatch(args.image) \
            or not all(KEY.fullmatch(k) for k in args.owner):
        parser.error('invalid preview ownership or image identity')
    if args.previous_container and not CID.fullmatch(args.previous_container):
        parser.error('previous container ID must be immutable')
    base = args.repo / '.cds-preview-assets-v1'
    ensure_directory(base)
    # Serialize peak accounting even when the administrator changes the enrollment.
    with exclusive_lock(base / '.store.lock') as store_lock:
        root = scope_root(base, args.owner)
        with exclusive_lock(root / retention.LOCK) as fd:
            ensure_directory(root / '.releases')
            release_anchor(root, 'previous')
            published = serving_image(args.owner, args.previous_container, current_release(root) is None)
            serving_release = keep_serving_release(root, published) if published else None
            # Bootstrap a legacy runtime before the existing deployment path retires it.
            if published and serving_release is None:
                serving_release = activate(root, published, fd, store_lock)
            selected = activate(root, args.image, fd, store_lock, serving_release)
            print(json.dumps({'assetDirectory': str(selected / 'assets'), 'compatibilityDays': COMPATIBILITY_DAYS}))


if __name__ == '__main__':
    main()
