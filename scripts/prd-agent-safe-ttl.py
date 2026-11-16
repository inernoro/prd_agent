#!/usr/bin/env python3
"""Resume temporary-data TTL only behind backup, runtime and log-index guards."""
import argparse
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess


def run(args, **kwargs):
    return subprocess.check_output(args, text=True, timeout=90, **kwargs)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    lock = Path('/run/lock/prd-agent-production.lock').open('a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print(json.dumps({'status': 'skipped', 'reason': 'production-maintenance-lock-held'}))
        return
    mongo = ['docker', 'exec', 'prdagent-mongodb', 'mongosh', '--quiet', '--eval']

    def monitor(enabled):
        value = 'true' if enabled else 'false'
        run(mongo + ['const result=db.getSiblingDB("admin").runCommand({setParameter:1,ttlMonitorEnabled:' + value + '});if(result.ok!==1)throw new Error("TTL parameter update failed");'])

    # A rollback or restart must fail closed before any further inspection.
    monitor(False)
    try:
        minimum = config['minimumRuntimeCommit']
        if not re.fullmatch(r'[a-f0-9]{40}', minimum):
            raise ValueError('Invalid protected runtime identity')
        names = ['prdagent-api', 'prdagent-llmgw-serve', 'prdagent-llmgw-serve-b']
        containers = json.loads(run(['docker', 'inspect', *names]))
        for container in containers:
            revision = container['Config']['Labels'].get('org.opencontainers.image.revision', '')
            if not re.fullmatch(r'[a-f0-9]{40}', revision) or not container['State']['Running']:
                raise RuntimeError('Runtime is not ready for protected TTL')
            subprocess.run(['git', '-C', config['repository'], 'merge-base', '--is-ancestor', minimum, revision],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
            if 'serve' in container['Name']:
                environment = dict(v.split('=', 1) for v in container['Config']['Env'] if '=' in v)
                if any(environment.get(key, '').lower() != 'false' for key in
                       ('LlmGateway__Retention__ApplyChanges', 'LlmGateway__Retention__EnableTtlIndexes')):
                    raise RuntimeError('Destructive gateway retention is not disabled')
        receipts = []
        root = Path('/var/lib/prd-agent/business-backups')
        for directory in root.iterdir():
            path = directory / 'offsite-restored.json'
            if directory.is_symlink() or not re.fullmatch(r'[0-9]{8}T[0-9]{6}Z', directory.name) or not path.is_file() or path.is_symlink():
                continue
            receipt = json.loads(path.read_text())
            if (receipt.get('restoreStatus') == 'passed' and receipt.get('coldArchiveReferencesVerified') is True
                    and receipt.get('archiveMetadataSupplement', {}).get('sha256')
                    and receipt.get('offsiteHost') == config['offsiteHost']):
                receipts.append(receipt)
        if not receipts:
            raise RuntimeError('No verified offsite restore receipt')
        latest = max(receipts, key=lambda value: value['verifiedAt'])
        verified = dt.datetime.fromisoformat(latest['verifiedAt'].replace('Z', '+00:00'))
        age = (dt.datetime.now(dt.timezone.utc) - verified).total_seconds()
        if not 0 <= age <= config.get('maxBackupAgeHours', 48) * 3600:
            raise RuntimeError('Offsite restore receipt is stale')
        script = Path(__file__).with_name('prd-agent-log-ttl-protection.js').read_text()
        audit = json.loads(run(mongo + [script]))
        if audit['protected'] or audit['unknown'] or audit['collectionTtl']:
            raise RuntimeError('Log or unknown expiration indexes remain')
        monitor(True)
        proof = {'status': 'enabled', 'temporaryTtlIndexes': len(audit['temporary']),
                 'backupVerifiedAt': latest['verifiedAt'], 'offsiteHost': latest['offsiteHost'],
                 'capturedAt': dt.datetime.now(dt.timezone.utc).isoformat()}
        Path('/var/lib/prd-agent/safe-ttl-status.json').write_text(json.dumps(proof, indent=2) + '\n')
        print(json.dumps(proof))
    except Exception as error:
        monitor(False)
        print(json.dumps({'status': 'paused', 'reasonType': type(error).__name__}))
        raise


if __name__ == '__main__':
    main()
