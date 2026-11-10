import importlib.util
import json
import os
import subprocess
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('release_runtime', Path(__file__).with_name('release-notification-runtime.py'))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
SOURCE = Path(__file__).resolve().parents[2]


class ReleaseTests(unittest.TestCase):
    def fixture(self, root):
        (root / 'independent-monitor.py').write_text("print('legacy')\n")
        for file in ['config.json', 'phone-dispatch-state.json', 'relay-state.json']:
            (root / file).write_text(json.dumps({'private': 'do-not-copy', 'existing': file}))
            (root / file).chmod(0o600)
        return {p.name: p.read_bytes() for p in root.glob('*.json')}

    def test_real_filesystem_switch_keeps_private_data_and_only_one_sender(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); private = self.fixture(root); actions = []
            result = m.publish(root, SOURCE, 'a' * 40, actions.append)
            self.assertEqual(actions, ['stop', 'start', 'verify'])
            self.assertTrue((root / 'notification-current').is_symlink())
            for file in m.FILES: self.assertEqual((root / 'notification-current' / file).read_bytes(), (SOURCE / file).read_bytes())
            self.assertEqual((root / 'independent-monitor.py').read_bytes(), m.LAUNCHER)
            self.assertEqual(result['commit'], 'a' * 40)
            for name, data in private.items():
                self.assertEqual((root / name).read_bytes(), data)
                self.assertEqual((root / name).stat().st_mode & 0o777, 0o600)

    def test_failed_start_restores_previous_program_and_pointer_without_losing_queue(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); private = self.fixture(root); original = (root / 'independent-monitor.py').read_bytes(); actions = []
            def service(action):
                actions.append(action)
                if actions == ['stop', 'start']: raise RuntimeError('fixture start failure')
            with self.assertRaisesRegex(RuntimeError, 'fixture start failure'): m.publish(root, SOURCE, 'b' * 40, service)
            self.assertEqual((root / 'independent-monitor.py').read_bytes(), original)
            self.assertFalse((root / 'notification-current').exists())
            self.assertEqual(actions, ['stop', 'start', 'stop', 'start', 'verify'])
            for name, data in private.items(): self.assertEqual((root / name).read_bytes(), data)

    def test_actual_project_script_check_is_read_only(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); private = self.fixture(root); tools = root / 'bin'; tools.mkdir()
            fake = tools / 'systemctl'
            fake.write_text("#!/usr/bin/env python3\nimport sys\nif sys.argv[1:] == ['show', 'cds-independent-monitor.service', '--property=WorkingDirectory', '--value']: print(" + repr(str(root)) + ")\nelif sys.argv[1:] == ['is-active', '--quiet', 'cds-independent-monitor.service']: pass\nelse: raise SystemExit('check must not change a service')\n")
            fake.chmod(0o755)
            revision = subprocess.check_output(['git', '-C', str(SOURCE), 'rev-parse', 'HEAD'], text=True).strip()
            result = subprocess.run(['bash', str(SOURCE / 'cds/scripts/cds-notification-release.sh'), 'check'],
                env={**os.environ, 'PATH': str(tools) + os.pathsep + os.environ['PATH'], 'CDS_COMMIT_SHA': revision, 'CDS_RELEASE_ID': 'fixture-check'}, capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse((root / 'notification-releases').exists())
            for name, data in private.items(): self.assertEqual((root / name).read_bytes(), data)

    def test_existing_version_is_immutable_and_program_bundle_contains_no_private_data(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); self.fixture(root); m.publish(root, SOURCE, 'c' * 40, lambda _: None)
            release = root / 'notification-current'
            self.assertFalse(any('do-not-copy' in p.read_text() for p in release.rglob('*') if p.is_file()))
            (release / m.FILES[0]).write_text('changed')
            with self.assertRaisesRegex(ValueError, '不同程序'): m.publish(root, SOURCE, 'c' * 40, lambda _: None)


if __name__ == '__main__': unittest.main()
