#!/usr/bin/env python3
"""Daily offsite backup and real isolated restore using a restricted SSH endpoint."""
import argparse
import datetime as dt
import fcntl
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import time

DATABASES = ('prdagent', 'llm_gateway', 'admin')


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write_json(path, value):
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.chmod(0o600)
    temporary.replace(path)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--source-stamp', help='Adopt a source dump that was already started and inspected')
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    if config.get('vaultMount') and not os.path.ismount(config['vaultMount']):
        raise RuntimeError('Offsite vault is not mounted; refusing a local fallback directory')
    base = Path(config['destination']).resolve()
    base.mkdir(parents=True, exist_ok=True, mode=0o700)
    base.chmod(0o700)
    lock = (base / 'backup.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    if not re.fullmatch(r'(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9][A-Za-z0-9.-]*', config['host']):
        raise ValueError('Invalid source host')
    ssh = ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
           '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15',
           '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=6',
           '-o', 'UserKnownHostsFile=' + config['knownHosts'], '-i', config['identity'], config['host']]

    def rpc(command, **kwargs):
        return subprocess.run(ssh + [command], check=True, **kwargs)

    def status(stamp):
        return json.loads(rpc('status ' + stamp, capture_output=True, text=True, timeout=60).stdout)

    active = base / 'active.json'
    if active.exists():
        current = json.loads(active.read_text())
        stamp = current['stamp']
        if current['sourceHost'] != config['host']:
            raise ValueError('Active backup belongs to another source')
    else:
        if shutil.disk_usage(base).free < config.get('minimumFreeGiB', 100) * 1024 ** 3:
            raise RuntimeError('Offsite reserve is below safety threshold; existing backups retained')
        stamp = args.source_stamp or dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        if not re.fullmatch(r'[0-9]{8}T[0-9]{6}Z', stamp):
            raise ValueError('Invalid source identity')
        if args.source_stamp and status(stamp)['status'] not in ('running', 'completed'):
            raise ValueError('Existing source dump is not running or completed')
        write_json(active, {'stamp': stamp, 'sourceHost': config['host']})
        # Persist identity before requesting start: an unknown result is inspected, never replayed.
        if not args.source_stamp:
            rpc('start ' + stamp, capture_output=True, timeout=60)
    if not re.fullmatch(r'[0-9]{8}T[0-9]{6}Z', stamp):
        raise ValueError('Invalid active identity')
    backup = base / stamp
    backup.mkdir(exist_ok=True, mode=0o700)
    manifest_path = backup / 'manifest.json'
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {
        'startedAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'sourceHost': config['host'],
        'offsiteHost': socket.gethostname(), 'scope': list(DATABASES), 'exclusions': [],
        'sourceDirectory': '/var/lib/prd-agent/business-backups/' + stamp,
        'consistency': 'online standalone logical backup; not a transaction-wide point-in-time snapshot',
        'status': 'running', 'archives': []}
    write_json(manifest_path, manifest)
    try:
        manifest['status'] = 'running'
        for name in ('environment.snapshot', 'compose.snapshot.yml', 'logging-overlay.snapshot.yml', 'api-environment.snapshot.json'):
            path = backup / name
            with path.open('wb') as out:
                rpc('config ' + name, stdout=out, timeout=60)
        manifest['configuration'] = [{'file': p.name, 'bytes': p.stat().st_size, 'sha256': digest(p)}
                                     for p in backup.iterdir() if '.snapshot' in p.name]
        for database in DATABASES:
            name = database + '.archive.gz'
            completed = next((row for row in manifest['archives'] if row['database'] == database), None)
            if completed and (backup / name).is_file() and digest(backup / name) == completed['sha256']:
                continue
            print('Waiting for complete source archive: ' + database, flush=True)
            deadline = time.monotonic() + 8 * 3600
            while True:
                state = status(stamp)
                row = state['files'].get(name, {})
                if row.get('sha256'):
                    break
                if state['status'] == 'failed' or time.monotonic() > deadline:
                    raise RuntimeError('Source backup failed or timed out')
                time.sleep(15)
            reserve = config.get('minimumFreeGiB', 100) * 1024 ** 3
            if shutil.disk_usage(base).free < row['bytes'] + reserve:
                raise RuntimeError('Offsite reserve would be exceeded')
            partial = backup / (name + '.partial')
            offset = partial.stat().st_size if partial.exists() else 0
            if offset > row['bytes']:
                raise RuntimeError('Partial backup is larger than source; retain for inspection')
            print('Receiving ' + database + ' from offset ' + str(offset), flush=True)
            with partial.open('ab') as out:
                rpc('read ' + stamp + ' ' + name + ' ' + str(offset), stdout=out, timeout=12 * 3600)
            if partial.stat().st_size != row['bytes'] or digest(partial) != row['sha256']:
                raise RuntimeError('Offsite archive differs from source; retain partial for inspection')
            with gzip.open(partial, 'rb') as stream:
                while stream.read(4 * 1024 * 1024):
                    pass
            partial.replace(backup / name)
            for suffix in ('.dump.log', '.started', '.completed'):
                with (backup / (database + suffix)).open('wb') as out:
                    rpc('read ' + stamp + ' ' + database + suffix + ' 0', stdout=out, timeout=60)
            manifest['archives'].append({'database': database, 'file': name, 'bytes': row['bytes'],
                'sha256': row['sha256'], 'gzipVerified': True,
                'dumpStartedAt': (backup / (database + '.started')).read_text().strip(),
                'dumpCompletedAt': (backup / (database + '.completed')).read_text().strip()})
            write_json(manifest_path, manifest)
            print('SHA256 and gzip verified: ' + database, flush=True)
        deadline = time.monotonic() + 300
        while status(stamp)['status'] != 'completed':
            if time.monotonic() > deadline:
                raise RuntimeError('Source did not publish a complete index snapshot')
            time.sleep(5)
        with (backup / 'indexes.json').open('wb') as out:
            rpc('read ' + stamp + ' indexes.json 0', stdout=out, timeout=60)
        supplement_name = 'log-archive-index.archive.gz'
        supplement = status(stamp)['files'].get(supplement_name, {})
        if not supplement.get('sha256'):
            raise RuntimeError('Post-dump archive directory snapshot is required')
        with (backup / supplement_name).open('wb') as out:
            rpc('read ' + stamp + ' ' + supplement_name + ' 0', stdout=out, timeout=600)
        if digest(backup / supplement_name) != supplement['sha256']:
            raise RuntimeError('Archive directory checksum mismatch')
        with gzip.open(backup / supplement_name, 'rb') as stream:
            while stream.read(1024 * 1024):
                pass
        for suffix in ('.dump.log', '.started', '.completed'):
            with (backup / ('log-archive-index' + suffix)).open('wb') as out:
                rpc('read ' + stamp + ' log-archive-index' + suffix + ' 0', stdout=out, timeout=60)
        manifest['archiveMetadataSupplement'] = {'file': supplement_name, **supplement,
            'database': 'prdagent', 'collection': 'log_archive_batches', 'gzipVerified': True}
        manifest.update({'indexSnapshotSha256': digest(backup / 'indexes.json'), 'status': 'completed',
            'completedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
            'sourceWindowStart': min(row['dumpStartedAt'] for row in manifest['archives']),
            'sourceWindowEnd': max(row['dumpCompletedAt'] for row in manifest['archives'])})
        write_json(manifest_path, manifest)
        restore_root = Path(config.get('restoreRoot', str(backup))).resolve()
        restore_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        if shutil.disk_usage(restore_root).free < 40 * 1024 ** 3:
            raise RuntimeError('Isolated restore reserve is below 40 GiB')
        work = restore_root / ('restore-check-' + stamp + '-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
        subprocess.run([sys.executable, str(Path(__file__).with_name('prd-agent-isolated-restore.py')),
                        '--backup', str(backup), '--work', str(work)], check=True)
        proof = json.loads((work / 'result.json').read_text())
        if proof.get('status') != 'passed' or not proof.get('isolatedProcessStopped'):
            raise RuntimeError('Isolated restore proof incomplete')
        # Only disposable data belonging to this stopped drill is removed.
        shutil.rmtree(work / 'data')
        report = work
        if work.parent != backup:
            report = backup / work.name
            shutil.copytree(work, report)
        manifest.update({'restoreVerifiedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
                         'restoreReport': str(report / 'result.json')})
        write_json(manifest_path, manifest)
        receipt = {'sourceDirectory': manifest['sourceDirectory'], 'offsiteHost': socket.gethostname(),
            'offsiteFolder': str(backup), 'verifiedAt': manifest['restoreVerifiedAt'], 'restoreStatus': 'passed',
            'archives': manifest['archives'], 'archiveMetadataSupplement': manifest['archiveMetadataSupplement'],
            'coldArchiveReferencesVerified': proof.get('coldArchiveReferences', {}).get('missing') == 0,
            'restoreReportSha256': digest(report / 'result.json')}
        done = rpc('receipt ' + stamp, input=json.dumps(receipt), capture_output=True, text=True, timeout=600)
        manifest['sourceRetention'] = json.loads(done.stdout)
        write_json(manifest_path, manifest)
        write_json(base / 'latest.json', {'folder': str(backup), 'manifestSha256': digest(manifest_path)})
        active.unlink()
        print('Backup and actual isolated restore passed: ' + stamp, flush=True)
    except Exception as error:
        manifest.update({'status': 'failed', 'errorType': type(error).__name__})
        write_json(manifest_path, manifest)
        raise


if __name__ == '__main__':
    main()
