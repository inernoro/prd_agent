#!/usr/bin/env python3
"""Forced-command SSH endpoint: only the private three-database backup spool."""
import datetime as dt
import io
import json
import os
from pathlib import Path
import re
import runpy
import shlex
import subprocess
import sys

BASE = Path('/var/lib/prd-agent/business-backups')
TOOLS = Path('/usr/local/lib/prd-agent-business-backup')
DATABASES = ('prdagent', 'llm_gateway', 'admin')
FILES = {'indexes.json'} | {db + suffix for db in DATABASES for suffix in
    ('.archive.gz', '.archive.gz.sha256', '.dump.log', '.started', '.completed')}
FILES |= {'log-archive-index' + suffix for suffix in
          ('.archive.gz', '.archive.gz.sha256', '.dump.log', '.started', '.completed')}
CONFIGS = {'environment.snapshot', 'compose.snapshot.yml', 'logging-overlay.snapshot.yml', 'api-environment.snapshot.json'}


def configuration_command(name):
    if name == 'logging-overlay.snapshot.yml':
        return ['cat', '/etc/prd-agent/compose.logging.yml']
    if name == 'api-environment.snapshot.json':
        return ['docker', 'inspect', 'prdagent-api', '--format', '{{json .Config.Env}}']
    config = json.loads(Path('/etc/prd-agent/backup-source.json').read_text())
    repository = Path(config['repository'])
    if not repository.is_absolute() or repository.is_symlink():
        raise ValueError('Backup repository must be an explicit physical directory')
    repository = repository.resolve(strict=True)
    actual = subprocess.check_output(['git', '-C', str(repository), 'rev-parse', '--show-toplevel'],
                                     text=True, timeout=15).strip()
    if actual != str(repository):
        raise ValueError('Backup repository identity mismatch')
    filename = '.env' if name == 'environment.snapshot' else 'docker-compose.yml'
    path = repository / filename
    if not path.is_file() or path.is_symlink():
        raise ValueError('Backup configuration must be a regular repository file')
    return ['cat', str(path)]


def parse(command):
    args = shlex.split(command)
    if len(args) == 2 and args[0] == 'config' and args[1] in CONFIGS:
        return args
    if len(args) not in (2, 4) or args[0] not in ('start', 'status', 'read', 'receipt'):
        raise ValueError('Unsupported backup operation')
    if not re.fullmatch(r'[0-9]{8}T[0-9]{6}Z', args[1]):
        raise ValueError('Invalid backup identity')
    dt.datetime.strptime(args[1], '%Y%m%dT%H%M%SZ')
    if args[0] == 'read':
        if len(args) != 4 or args[2] not in FILES or not re.fullmatch(r'[0-9]{1,13}', args[3]):
            raise ValueError('Invalid backup file or offset')
    elif len(args) != 2:
        raise ValueError('Unexpected arguments')
    return args


def folder(stamp):
    path = BASE / stamp
    if BASE.is_symlink() or path.is_symlink() or path.resolve().parent != BASE.resolve():
        raise ValueError('Unsafe backup directory')
    return path


def main():
    os.umask(0o077)
    args = parse(os.environ.get('SSH_ORIGINAL_COMMAND', ''))
    op = args[0]
    if op == 'config':
        subprocess.run(configuration_command(args[1]), check=True)
        return
    root = folder(args[1])
    if op == 'start':
        instant = dt.datetime.strptime(args[1], '%Y%m%dT%H%M%SZ').replace(tzinfo=dt.timezone.utc)
        if abs((dt.datetime.now(dt.timezone.utc) - instant).total_seconds()) > 86400:
            raise ValueError('New backup identity must be current')
        if root.exists():
            raise ValueError('Backup identity already exists; inspect status before retry')
        subprocess.run(['systemd-run', '--unit=prd-agent-business-backup-' + args[1],
            '--property=Nice=19', '--property=IOSchedulingClass=idle',
            '/usr/local/sbin/prd-agent-business-backup-source', args[1]], check=True,
            stdout=subprocess.DEVNULL)
        print(json.dumps({'accepted': True, 'sourceDirectory': str(root)}))
    elif op == 'status':
        result = {'status': 'pending', 'files': {}}
        status = root / 'status'
        if status.is_file() and not status.is_symlink():
            result['status'] = status.read_text().strip()
        for name in FILES:
            path = root / name
            if path.is_file() and not path.is_symlink():
                result['files'][name] = {'bytes': path.stat().st_size}
                if name.endswith('.archive.gz'):
                    checksum = root / (name + '.sha256')
                    if checksum.is_file() and not checksum.is_symlink():
                        value = checksum.read_text().split()[0]
                        if not re.fullmatch(r'[a-f0-9]{64}', value):
                            raise ValueError('Invalid published checksum')
                        result['files'][name]['sha256'] = value
        print(json.dumps(result))
    elif op == 'read':
        path = root / args[2]
        if path.is_symlink() or not path.is_file() or path.resolve().parent != root.resolve():
            raise ValueError('Backup file unavailable')
        if args[2].endswith('.archive.gz') and not (root / (args[2] + '.sha256')).is_file():
            raise ValueError('Archive is not complete')
        with path.open('rb') as stream:
            offset = int(args[3])
            if offset > path.stat().st_size:
                raise ValueError('Offset exceeds file size')
            stream.seek(offset)
            while block := stream.read(1024 * 1024):
                sys.stdout.buffer.write(block)
    else:
        data = sys.stdin.buffer.read(4 * 1024 * 1024 + 1)
        if len(data) > 4 * 1024 * 1024:
            raise ValueError('Receipt exceeds limit')
        receipt = json.loads(data)
        if receipt.get('sourceDirectory') != str(root):
            raise ValueError('Receipt identity mismatch')
        supplement = receipt.get('archiveMetadataSupplement', {})
        name = 'log-archive-index.archive.gz'
        path = root / name
        checksum = root / (name + '.sha256')
        if (supplement.get('file') != name or path.is_symlink() or checksum.is_symlink()
                or supplement.get('bytes') != path.stat().st_size
                or supplement.get('sha256') != checksum.read_text().split()[0]):
            raise ValueError('Archive-directory receipt mismatch')
        # Reuse the existing guarded, checksum-verified source-spool retention.
        code = runpy.run_path(str(TOOLS / 'prd-agent-business-backup.py'))['SOURCE_RECEIPT_SCRIPT']
        sys.stdin = io.StringIO(data.decode())
        exec(compile(code, '<verified-source-receipt>', 'exec'), {})


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Backup source request rejected: ' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
