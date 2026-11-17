#!/usr/bin/env python3
"""Reject SSH escape paths before any production-side operation is possible."""
import importlib.util
import json
import os
import shutil
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('source_rpc', Path(__file__).resolve().parents[1] / 'prd-agent-backup-source-rpc.py')
rpc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rpc)


class SourceBoundaryTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which('prlimit'), 'Native Linux resource-limit test')
    def test_dump_ceiling_uses_the_full_byte_budget_and_still_stops_overflow(self):
        script = Path(__file__).resolve().parents[1] / 'prd-agent-business-backup-source.sh'
        for payload_size, metadata_size, expected_success in [(6000, 6000, True), (12000, 6000, False), (6000, 12000, False)]:
            with self.subTest(payload_size=payload_size, metadata_size=metadata_size), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve()
                binaries = root / 'bin'; binaries.mkdir()
                fake_df = binaries / 'df'
                fake_df.write_text('#!/bin/sh\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted\\nfixture 20000000 0 10485768 0%% /fixture\\n"\n')
                fake_df.chmod(0o700)
                docker = binaries / 'docker'
                docker.write_text('#!' + os.sys.executable + '\nimport gzip,random,sys\n'
                    'size=' + str(metadata_size) + ' if "log_archive_batches" in sys.argv else ' + str(payload_size) + '\n'
                    'sys.stdout.buffer.write(gzip.compress(random.Random(7).randbytes(size)) if "mongodump" in sys.argv else b"{}")\n')
                docker.chmod(0o700)
                program = root / 'source.sh'
                program.write_text(script.read_text().replace('/var/lib/prd-agent/business-backups', str(root / 'backups'))
                    .replace('/run/lock/prd-agent-business-backup.lock', str(root / 'source.lock')))
                result = subprocess.run(['sh', str(program), '20261117T000000Z'],
                    env={**os.environ, 'PATH': str(binaries) + os.pathsep + os.environ['PATH']},
                    capture_output=True, text=True, timeout=30)
                self.assertEqual(result.returncode == 0, expected_success, result.stderr)
                folder = root / 'backups' / '20261117T000000Z'
                self.assertEqual((folder / 'status').read_text().strip(), 'completed' if expected_success else 'failed')
                if expected_success:
                    self.assertGreater((folder / 'prdagent.archive.gz').stat().st_size, 4096)
                    self.assertTrue((folder / 'admin.archive.gz.sha256').is_file())
                else:
                    failed = 'prdagent' if payload_size > 8192 else 'log-archive-index'
                    self.assertLessEqual((folder / (failed + '.archive.gz.partial')).stat().st_size, 8192)

    def test_unmounted_vault_is_rejected_before_creating_a_backup_or_contacting_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = root / 'config.json'
            config.write_text(json.dumps({'vaultMount': str(root), 'destination': str(root / 'must-not-exist')}))
            script = Path(__file__).resolve().parents[1] / 'prd-agent-linux-offsite-backup.py'
            result = subprocess.run([os.sys.executable, str(script), '--config', str(config)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('vault is not mounted', result.stderr)
            self.assertFalse((root / 'must-not-exist').exists())

    def test_only_fixed_backup_files_can_be_read(self):
        for name in rpc.FILES:
            self.assertEqual(rpc.parse('read 20261117T000000Z ' + name + ' 123')[2], name)

    def test_arbitrary_commands_paths_and_options_are_rejected(self):
        for command in ('', 'sh', 'status 20261117T000000Z; id',
                        'read 20261117T000000Z ../../root/.ssh/id_ed25519 0',
                        'read 20261117T000000Z /etc/shadow 0',
                        'read 20261117T000000Z indexes.json -1',
                        'read 20261117T000000Z indexes.json 0;id',
                        'read 20261117T000000Z indexes.json 99999999999999999',
                        'read ../20261117T000000Z indexes.json 0',
                        'config /etc/shadow', 'config environment.snapshot extra',
                        'start 20261317T000000Z', 'receipt 20261117T000000Z extra'):
            with self.subTest(command=command), self.assertRaises(ValueError):
                rpc.parse(command)

    def test_symlinked_spool_directory_is_rejected(self):
        original = rpc.BASE
        with tempfile.TemporaryDirectory() as temporary:
            rpc.BASE = Path(temporary) / 'spool'
            rpc.BASE.mkdir()
            (rpc.BASE / '20261117T000000Z').symlink_to(Path(temporary))
            try:
                with self.assertRaises(ValueError):
                    rpc.folder('20261117T000000Z')
            finally:
                rpc.BASE = original


if __name__ == '__main__':
    unittest.main()
