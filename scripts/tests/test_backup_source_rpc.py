#!/usr/bin/env python3
"""Reject SSH escape paths before any production-side operation is possible."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('source_rpc', Path(__file__).resolve().parents[1] / 'prd-agent-backup-source-rpc.py')
rpc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rpc)


class SourceBoundaryTests(unittest.TestCase):
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
