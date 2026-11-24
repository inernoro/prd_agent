#!/usr/bin/env python3
"""Prepare new release inputs, reusing existing worktrees without modifying them.

Default is read-only preview. A committed deploy/release-inputs.json opts new
prebuilt release worktrees into a cone sparse checkout. Missing declarations
preserve the existing full checkout contract. Existing paths are never cleaned,
converted, reset, adopted or deleted by this command.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import time

MANIFEST = 'deploy/release-inputs.json'


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args], timeout=30, stderr=subprocess.PIPE)


def plan(repo: Path, worktree: Path, commit: str, required_file: str):
    if not re.fullmatch('[0-9a-f]{40}', commit):
        raise ValueError('full immutable commit required')
    git(repo, 'cat-file', '-e', commit + '^{commit}')
    def common_dir(directory):
        value = Path(git(directory, 'rev-parse', '--git-common-dir').decode().strip())
        return (value if value.is_absolute() else directory / value).resolve()
    common = common_dir(repo)
    if worktree.resolve() == repo.resolve() or worktree in repo.resolve().parents:
        raise ValueError('release worktree cannot replace the repository')
    ancestor = worktree.parent
    while not os.path.lexists(ancestor):
        ancestor = ancestor.parent
    if ancestor.resolve() != ancestor.absolute() or not stat.S_ISDIR(ancestor.lstat().st_mode) or '..' in worktree.parts:
        raise ValueError('release parent identity is unconfirmed; preserved')
    paths = None
    manifest_hash = None
    entry = git(repo, 'ls-tree', commit, '--', MANIFEST).decode()
    if entry:
        if not re.match(r'^100(?:644|755) blob [0-9a-f]+\t', entry):
            raise ValueError('release input declaration is not a regular Git blob')
        if int(git(repo, 'cat-file', '-s', commit + ':' + MANIFEST)) > 65536:
            raise ValueError('release input declaration exceeds budget')
        raw = git(repo, 'show', commit + ':' + MANIFEST)
        data = json.loads(raw)
        if not isinstance(data, dict) or data.get('schema') != 1 or data.get('kind') != 'prebuilt-release-inputs':
            raise ValueError('invalid release input declaration')
        paths = data.get('directories')
        if not isinstance(paths, list) or not 1 <= len(paths) <= 32 or any(not isinstance(p, str) for p in paths) or len(set(paths)) != len(paths):
            raise ValueError('release input directories must be a bounded unique list')
        for p in paths:
            if not isinstance(p, str) or not re.fullmatch(r'[A-Za-z0-9_-][A-Za-z0-9._/-]*', p) \
                or any(s in ('', '.', '..', '.git') for s in p.split('/')):
                raise ValueError('unsafe release input directory')
            tree = git(repo, 'ls-tree', commit, '--', p).decode()
            if not re.match(r'^040000 tree [0-9a-f]+\t', tree):
                raise ValueError('release input is not an actual Git directory: ' + p)
        if required_file and '/' in required_file and not any(required_file.startswith(p + '/') for p in paths):
            raise ValueError('release script is outside declared inputs')
        manifest_hash = hashlib.sha256(raw).hexdigest()
    existing = os.path.lexists(worktree)
    if existing:
        s = worktree.lstat()
        if not stat.S_ISDIR(s.st_mode) or worktree.resolve() != worktree.absolute():
            raise ValueError('existing release path identity is unconfirmed; preserved')
        observed = common_dir(worktree)
        if observed != common or git(worktree, 'rev-parse', 'HEAD').decode().strip() != commit:
            raise ValueError('existing release belongs to a different repository or commit; preserved')
    return {'mode': 'reuse-existing' if existing else 'declared-inputs' if paths else 'full-source',
            'commitSha': commit, 'directories': paths, 'declarationSha256': manifest_hash, 'existingPreserved': existing}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--repo', type=Path, required=True)
    p.add_argument('--worktree', type=Path, required=True)
    p.add_argument('--commit', required=True)
    p.add_argument('--required-file', default='')
    p.add_argument('--apply', action='store_true')
    a = p.parse_args()
    repo, worktree = a.repo.absolute(), a.worktree.absolute()
    result = plan(repo, worktree, a.commit, a.required_file)
    ancestor = worktree.parent
    while not ancestor.exists():
        ancestor = ancestor.parent
    before = os.statvfs(ancestor)
    started = time.monotonic()
    if a.apply and not result['existingPreserved']:
        # Native Git locking serializes metadata. An unexpected concurrent
        # creator fails instead of removing or adopting its directory.
        args = ['worktree', 'add', '--detach']
        if result['directories']:
            args.append('--no-checkout')
        git(repo, *args, str(worktree), a.commit)
        if result['directories']:
            subprocess.run(['git', '-C', str(worktree), 'sparse-checkout', 'set', '--cone', '--stdin'],
                           input=('\n'.join(result['directories']) + '\n').encode(), timeout=30, check=True,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            git(worktree, 'checkout', '--detach', a.commit)
        # Revalidate native identity after checkout, before any script executes.
        plan(repo, worktree, a.commit, a.required_file)
    if a.apply:
        after = os.statvfs(ancestor)
        result['spaceObservation'] = {'availableBefore': before.f_bavail * before.f_frsize, 'availableAfter': after.f_bavail * after.f_frsize,
                                      'note': 'filesystem net availability; concurrent writes can contribute'}
        result['elapsedMs'] = round((time.monotonic() - started) * 1000)
    result['dryRun'] = not a.apply
    print(json.dumps(result, separators=(',', ':')))

if __name__ == '__main__':
    main()
