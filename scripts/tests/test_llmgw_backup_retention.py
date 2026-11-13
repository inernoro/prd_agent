"""Adapter contracts using real synthetic archives and the shared native worker.

Docker is not exercised here. A private descriptor view makes the unit fixture
independent of unrelated processes; the native PID-namespace drill covers /proc.
"""
import contextlib
import datetime
import gzip
import hashlib
import importlib.util
import io
import json
import os
import subprocess
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('llmgw_retention', REPO/'scripts/llmgw-backup-retention.py')
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class BackupStreamTest(unittest.TestCase):
    def test_docker_tmpfs_omitted_from_mounts_cannot_claim_a_stable_physical_source(self):
        with tempfile.TemporaryDirectory(prefix='backup-source-query-') as folder:
            binary = Path(folder)/'docker'
            binary.write_text('#!/bin/sh\nprintf \'%s\\n\' \'[{"Name":"/tmpfs-source","Mounts":[],"HostConfig":{"Tmpfs":{"/data/db":"rw"}}}]\'\n')
            binary.chmod(0o700)
            result = subprocess.run(['python3', '-c', adapter.engine()], input=json.dumps({'action': 'source', 'containerName': 'tmpfs-source'}), env={**os.environ, 'PATH': folder+os.pathsep+os.environ['PATH']}, capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('backup-source-volatile-mount-lineage-unconfirmed', result.stderr)

    def test_failed_export_cannot_be_hidden_by_a_valid_gzip(self):
        with tempfile.TemporaryDirectory(prefix='backup-stream-status-') as folder:
            target = Path(folder)/'export.gz'
            command = '. "$1"; cds_backup_stream "$2" sh -c \'printf synthetic; exit "$1"\' producer "$3"'
            for status in [0, 17]:
                with self.subTest(export_status=status):
                    result = subprocess.run(['sh', '-c', command, 'test', str(REPO/'scripts/lib/backup-stream.sh'), str(target), str(status)], capture_output=True, text=True, timeout=10)
                    self.assertEqual(result.returncode == 0, status == 0)
                    self.assertEqual(gzip.decompress(target.read_bytes()), b'synthetic')
                    self.assertEqual(list(Path(folder).glob('.export-pipe.*')), [])


class BackupAdapterTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='llmgw-backup-policy-unit-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base/'backups'
        self.root.mkdir()
        proc = self.base/'proc'
        (proc/str(os.getpid())).mkdir(parents=True)
        (proc/str(os.getpid())/'fd').symlink_to('/proc/'+str(os.getpid())+'/fd')
        self.program = adapter.engine().replace('def backup_mount_references():\n', 'def backup_mount_references():\n return [] # unit fixture\n').replace("pathlib.Path('/proc')", 'pathlib.Path('+repr(str(proc))+')')

    def invoke(self, *args):
        output = io.StringIO()
        with patch.object(adapter, 'engine', return_value=self.program), patch.object(sys, 'argv', ['retention', '--root', str(self.root), *args]), contextlib.redirect_stdout(output):
            code = adapter.main()
        return code, json.loads(output.getvalue())

    def export(self, name, *, mode='full', scopes=None, source='a'*64, stable=True):
        folder = self.root/name
        folder.mkdir()
        if mode == 'full':
            databases = scopes or ['db']
            names = [v+'.archive.gz' for v in databases]
        else:
            databases = []
            names = [v.replace('.*', '')+'.archive.gz' for v in scopes]
        files = []
        for name in names:
            file = folder/name
            file.write_bytes(gzip.compress(b'synthetic archive fixture'))
            files.append(file)
        (folder/'SHA256SUMS').write_text(''.join(hashlib.sha256(v.read_bytes()).hexdigest()+'  ./'+v.name+'\n' for v in files))
        receipt = folder/'.cds-export.json'
        receipt.write_text(json.dumps({'backupDir': str(folder), 'verdict': 'pass', 'dryRun': False, 'mode': mode, 'databases': databases, 'criticalCollections': scopes or [], 'archives': list(map(str, files)), 'sourceFingerprint': source, 'sourceIdentityStable': stable, 'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}))
        return receipt, files

    def test_registers_shared_checksum_format_and_exact_source_scope(self):
        receipt, files = self.export('first')
        code, result = self.invoke('--register-export', str(receipt), '--register-only')
        self.assertEqual(code, 0)
        self.assertTrue(result['replacementVerified'])
        db = json.loads((self.root/'.cds-retention/backups.json').read_text())
        row = db['files'][str(files[0])]
        self.assertTrue(row['recoveryVerified'])
        self.assertEqual(row['serviceId'], 'production-data/db')
        self.assertEqual(db['files'][str(receipt)]['disposition'], 'reproducible-artifact')

    def test_collection_export_cannot_displace_a_full_database_backup(self):
        receipt, files = self.export('critical', mode='critical', scopes=['db.users', 'other.*'])
        self.invoke('--register-export', str(receipt), '--register-only')
        rows = json.loads((self.root/'.cds-retention/backups.json').read_text())['files']
        self.assertEqual({rows[str(file)]['serviceId'] for file in files}, {'production-data/db/users', 'production-data/other'})

    def test_changed_source_and_manual_copy_never_become_fresh_replacement_proof(self):
        receipt, files = self.export('unstable', stable=False)
        _, result = self.invoke('--register-export', str(receipt), '--register-only')
        self.assertFalse(result['replacementVerified'])
        plan = self.base/'adopt.json'
        plan.write_text(json.dumps([{'path': str(files[0]), 'projectId': 'llmgw-production', 'serviceId': 'production-data/db', 'origin': 'manual'}]))
        self.invoke('--adopt-plan', str(plan))
        rows = json.loads((self.root/'.cds-retention/backups.json').read_text())['files']
        self.assertFalse(rows[str(files[0])]['recoveryVerified'])

    def test_refuses_missing_corrupt_or_incomplete_checksums_and_zero_archives(self):
        for kind in ['missing', 'corrupt', 'incomplete', 'zero']:
            with self.subTest(kind=kind):
                receipt, files = self.export(kind)
                if kind == 'missing': (receipt.parent/'SHA256SUMS').unlink()
                elif kind == 'corrupt': files[0].write_bytes(b'corrupt gzip')
                elif kind == 'incomplete': (receipt.parent/'SHA256SUMS').write_text('')
                else: files[0].write_bytes(b'')
                with self.assertRaises((RuntimeError, OSError, ValueError)):
                    self.invoke('--register-export', str(receipt), '--register-only')

    def test_retains_unowned_and_unique_business_archives_and_requires_explicit_execution(self):
        unknown = self.root/'old-unowned.gz'
        unknown.write_bytes(gzip.compress(b'synthetic unknown'))
        os.utime(unknown, (time.time()-20*86400,)*2)
        _, result = self.invoke()
        self.assertEqual(result['scanStatus'], 'partial')
        self.assertTrue(unknown.exists())
        with self.assertRaises(RuntimeError): self.invoke('--execute')
        plan = self.base/'adopt.json'
        plan.write_text(json.dumps([{'path': str(unknown), 'projectId': 'p', 'serviceId': 'retired', 'origin': 'historical'}]))
        self.invoke('--adopt-plan', str(plan))
        _, result = self.invoke('--execute', '--confirm', adapter.CONFIRM_PHRASE)
        self.assertEqual(len(result['policyConflicts']), 1)
        self.assertTrue(unknown.exists())

    def test_root_alias_and_receipt_alias_are_rejected(self):
        alias = self.base/'alias'
        alias.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(RuntimeError): self.invoke('--root', str(alias))
        receipt, _ = self.export('safe')
        linked = receipt.parent/'alias.json'
        linked.symlink_to(receipt)
        with self.assertRaises(RuntimeError): self.invoke('--register-export', str(linked))


if __name__ == '__main__':
    unittest.main()
