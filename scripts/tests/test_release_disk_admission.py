#!/usr/bin/env python3
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]

class ReleaseDiskAdmission(unittest.TestCase):
    def test_critical_space_blocks_writes_but_keeps_help_and_existing_verification(self):
        with tempfile.TemporaryDirectory(prefix='owned-release-disk-') as tmp:
            base = Path(tmp)
            (base / 'df').write_text('#!/bin/sh\nprintf "Filesystem 1M-blocks Used Available Use%% Mounted\\nfixture 10000 8976 1024 90%% /\\n"\n')
            (base / 'df').chmod(0o755)
            for name in ['curl', 'docker', 'docker-compose']:
                (base / name).write_text('#!/bin/sh\necho unexpected >> "$DISK_TEST_WRITES"\nexit 99\n')
                (base / name).chmod(0o755)
            env = {'PATH': str(base) + ':' + os.environ['PATH'], 'DISK_TEST_WRITES': str(base / 'writes'),
                   'PRD_AGENT_DOTENV_FILE': str(base / '.env')}
            command = ['sh', str(ROOT / 'exec_dep.sh')]
            blocked = subprocess.run(command + ['--commit', 'a' * 40], cwd=ROOT, env=env, capture_output=True, text=True)
            self.assertNotEqual(blocked.returncode, 0)
            self.assertIn('requires at least 4096MB free', blocked.stdout + blocked.stderr)
            self.assertFalse((base / 'writes').exists())
            self.assertFalse((base / '.env').exists())
            help_result = subprocess.run(command + ['--help'], cwd=ROOT, env=env, capture_output=True, text=True)
            self.assertEqual(help_result.returncode, 0)
            self.assertIn('Usage:', help_result.stdout)
            self.assertFalse((base / 'writes').exists())
            readonly = subprocess.run(command, cwd=ROOT, env={**env, 'LLMGW_VERIFY_ONLY': '1',
                'PRD_AGENT_REUSE_EXISTING_STATIC_DIST': '1', 'SKIP_API_PULL': '1'}, capture_output=True, text=True)
            self.assertNotIn('requires at least 4096MB free', readonly.stdout + readonly.stderr)
            self.assertFalse((base / '.env').exists())

if __name__ == '__main__':
    unittest.main()
