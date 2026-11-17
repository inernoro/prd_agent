#!/usr/bin/env python3
"""Bound production release worktrees/images without touching volumes or other apps.

Dry-run by default. Deployment and execution must share the same flock path.
"""
import argparse
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import time

SHA = re.compile(r"[0-9a-f]{40}")
IMAGE_REPO = re.compile(r"^(?:get\.miduo\.org/)?ghcr\.io/inernoro/prd_agent/prdagent-[a-z-]+$")
WORKTREE = re.compile(r"prd_agent_release_[A-Za-z0-9_-]+")


def run(*args, timeout=120):
    return subprocess.check_output(args, text=True, stderr=subprocess.PIPE, timeout=timeout).strip()


def protected_revisions(containers, evidence, static):
    revisions = set()
    for c in containers:
        revision = (c['Config'].get('Labels') or {}).get('org.opencontainers.image.revision', '')
        if SHA.fullmatch(revision):
            revisions.add(revision)
    successful = sorted((e for e in evidence if e.get('status') == 'success'),
                        key=lambda e: e.get('endedAt', ''), reverse=True)
    recent = []
    for e in successful:
        ref = e.get('releaseRef', '').removeprefix('sha-')
        if SHA.fullmatch(ref) and ref not in recent:
            recent.append(ref)
    if len(recent) < 3:
        raise RuntimeError('Need three distinct successful release records before reclamation')
    revisions.update(recent[:3])
    for name in ('current', 'previous'):
        p = static / name
        if not p.is_symlink() or not p.resolve().is_dir():
            raise RuntimeError(f'Missing live static pointer: {name}')
        match = re.search(r'sha-([0-9a-f]{40})(?:-|$)', p.resolve().name)
        if not match:
            raise RuntimeError('Cannot identify static release revision')
        revisions.add(match[1])
    return revisions


def live_paths(containers):
    paths = set()
    for c in containers:
        # Even stopped containers can be restarted with these bind paths.
        for mount in c.get('Mounts', []):
            if mount.get('Type') == 'bind':
                paths.add(Path(mount['Source']).resolve())
        labels = c['Config'].get('Labels') or {}
        if labels.get('com.docker.compose.project.working_dir'):
            paths.add(Path(labels['com.docker.compose.project.working_dir']).resolve())
    # Protect running commands in any release tree, not only Compose containers.
    for entry in Path('/proc').iterdir():
        if entry.name.isdigit():
            try:
                paths.add((entry / 'cwd').resolve(strict=True))
            except (OSError, RuntimeError):
                pass
    return paths


def contains_live_path(candidate, paths):
    return any(p == candidate or candidate in p.parents for p in paths)


def image_candidates(images, protected, referenced):
    result = []
    for row in images:
        repo, tag, image_id = row['Repository'], row['Tag'], row['ID']
        if not IMAGE_REPO.fullmatch(repo) or not tag.startswith('sha-'):
            continue
        revision = tag[4:]
        if SHA.fullmatch(revision) and revision not in protected and image_id not in referenced:
            result.append(f'{repo}:{tag}')
    return sorted(set(result))


def inventory(repo, evidence_dir):
    for attempt in range(3):
        ids = run('docker', 'ps', '-aq').split()
        if not ids:
            raise RuntimeError('No containers; refusing to infer production state')
        try:
            containers = json.loads(run('docker', 'inspect', *ids))
            break
        except subprocess.CalledProcessError:
            # Unrelated/stopped containers may disappear between list and inspect.
            # Re-list the complete set; never proceed with a partial inventory.
            if attempt == 2:
                raise
            time.sleep(0.2)
    expected = next((c for c in containers if c['Name'] == '/prdagent-api'), None)
    if not expected or not expected['State']['Running']:
        raise RuntimeError('Production API must be running')
    evidence = []
    for p in evidence_dir.glob('*.json'):
        try:
            record = json.loads(p.read_text())
            if isinstance(record, dict):
                evidence.append(record)
        except (ValueError, OSError):
            continue
    static = repo / 'deploy/web/dist'
    protected = protected_revisions(containers, evidence, static)
    return containers, static, protected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', required=True)
    parser.add_argument('--evidence-dir', required=True)
    parser.add_argument('--lock', default='/run/lock/prd-agent-production.lock')
    parser.add_argument('--minimum-age-days', type=int, default=7)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--json-out')
    args = parser.parse_args()
    if args.minimum_age_days < 1:
        parser.error('minimum age must be at least one day')
    repo = Path(args.repo).resolve(strict=True)
    if Path(run('git', '-C', str(repo), 'rev-parse', '--show-toplevel')).resolve() != repo:
        raise RuntimeError('Expected Git root')
    lock = open(args.lock, 'a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print('Skipped: production release/maintenance lock is held')
        return
    containers, static, protected = inventory(repo, Path(args.evidence_dir))
    paths = live_paths(containers)
    records = run('git', '-C', str(repo), 'worktree', 'list', '--porcelain').split('\n\n')
    registered = {}
    for rec in records:
        fields = dict(line.split(' ', 1) for line in rec.splitlines() if ' ' in line)
        if fields.get('worktree') and fields.get('HEAD'):
            registered[Path(fields['worktree']).resolve()] = fields['HEAD']
    cutoff = time.time() - args.minimum_age_days * 86400
    candidates, kept = [], {}
    for path in sorted(repo.parent.glob('prd_agent_release_*')):
        resolved = path.resolve()
        reason = None
        if path.is_symlink() or resolved.parent != repo.parent or not WORKTREE.fullmatch(path.name):
            reason = 'unsafe path'
        elif resolved not in registered:
            reason = 'not a registered worktree'
        elif registered[resolved] in protected:
            reason = 'running/rollback revision'
        elif contains_live_path(resolved, paths):
            reason = 'container/process path'
        elif (path / '.git').stat().st_mtime > cutoff:
            reason = 'younger than minimum age'
        if reason:
            kept[path.name] = reason
        else:
            candidates.append(path)
    images = [json.loads(line) for line in run('docker', 'image', 'ls', '--no-trunc', '--format', '{{json .}}').splitlines()]
    image_refs = image_candidates(images, protected, {c['Image'] for c in containers})
    # Static entries can also accumulate; keep current/previous and rollback revisions.
    static_candidates = []
    static_root = static / '.releases'
    for p in sorted(static_root.glob('sha-*')):
        match = re.fullmatch(r'sha-([0-9a-f]{40})-[A-Za-z0-9-]+', p.name)
        if (match and not p.is_symlink() and p.is_dir() and p.stat().st_mtime <= cutoff
                and match[1] not in protected and not contains_live_path(p.resolve(), paths)):
            static_candidates.append(p)
    report = {'at': dt.datetime.now(dt.timezone.utc).isoformat(), 'execute': args.execute,
              'protectedRevisions': sorted(protected), 'worktrees': [str(p) for p in candidates],
              'images': image_refs, 'staticVersions': [str(p) for p in static_candidates], 'kept': kept,
              'removedWorktrees': [], 'removedImages': [], 'removedStaticVersions': []}
    print(json.dumps({'protectedRevisions': sorted(protected), 'plannedWorktrees': len(candidates),
                      'plannedImages': len(image_refs), 'plannedStaticVersions': len(static_candidates)}, ensure_ascii=False), flush=True)
    if args.execute:
        # Re-read all live protections under the deployment lock before each removal.
        for p in candidates:
            current, _, latest = inventory(repo, Path(args.evidence_dir))
            if registered[p.resolve()] in latest or contains_live_path(p.resolve(), live_paths(current)):
                raise RuntimeError('Live state changed; stopping reclamation')
            # fast.sh leaves this generated, non-secret intent marker untracked.
            # Remove only this exact marker; Git still refuses every other dirty file.
            intent = p / '.prd-agent-release-intent.env'
            if intent.is_file() and not intent.is_symlink():
                intent.unlink()
            # exec_dep.sh switches this tracked symlink for standalone operation.
            # Normalize only that exact generated value; preserve every other source edit.
            nginx = p / 'deploy/nginx/conf.d/default.conf'
            if nginx.is_symlink() and os.readlink(nginx) == 'branches/_standalone.conf':
                entry = run('git', '-C', str(p), 'ls-files', '-s', '--', 'deploy/nginx/conf.d/default.conf')
                if entry.startswith('120000 '):
                    run('git', '-C', str(p), 'restore', '--source=HEAD', '--', 'deploy/nginx/conf.d/default.conf')
            # No --force: refuse dirty/untracked/locked worktrees, never delete user changes.
            try:
                run('git', '-C', str(repo), 'worktree', 'remove', str(p), timeout=180)
                report['removedWorktrees'].append(str(p))
                print('Removed worktree: '+p.name, flush=True)
            except subprocess.CalledProcessError:
                report['kept'][p.name] = 'git refused removal (modified/untracked files or lock)'
                print('Kept dirty/locked worktree: '+p.name, flush=True)
        import shutil
        for p in static_candidates:
            current, _, latest = inventory(repo, Path(args.evidence_dir))
            revision = re.search(r'sha-([0-9a-f]{40})', p.name)[1]
            if revision in latest or contains_live_path(p.resolve(), live_paths(current)):
                raise RuntimeError('Static state changed; stopping reclamation')
            shutil.rmtree(p)
            report['removedStaticVersions'].append(str(p))
        for ref in image_refs:
            current, _, latest = inventory(repo, Path(args.evidence_dir))
            if ref.rsplit('sha-', 1)[1] in latest:
                raise RuntimeError('Image protection changed; stopping reclamation')
            try:
                # No --force, no prune, no volume commands.
                run('docker', 'image', 'rm', ref)
                report['removedImages'].append(ref)
            except subprocess.CalledProcessError:
                report['kept'][ref] = 'docker refused removal'
    if args.json_out:
        output = Path(args.json_out)
        tmp = output.with_suffix('.tmp')
        tmp.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        os.chmod(tmp, 0o600)
        tmp.replace(output)
    print(json.dumps({k:len(report[k]) for k in ('removedWorktrees','removedImages','removedStaticVersions')}))


if __name__ == '__main__':
    main()
