#!/usr/bin/env python3
"""Fixture-only APT normalization and all four workflow consumer contracts."""

import importlib.util
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / 'scripts/ci/normalize-ubuntu-apt-sources.py'
WORKFLOW = ROOT / '.github/workflows/ci.yml'
spec = importlib.util.spec_from_file_location('ci_ubuntu_apt', HELPER)
apt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(apt)


class UbuntuAptFixtures(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / 'etc/apt/sources.list.d').mkdir(parents=True)

    def write(self, relative, text):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(text.encode())
        return path

    def test_runner_deb822_mirror_file_covers_archive_and_same_file_security(self):
        original = '''# Preserve this source declaration.
Types: deb deb-src
URIs: mirror+file:/etc/apt/apt-mirrors.txt
Suites: noble noble-updates noble-backports
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: mirror+file:/etc/apt/apt-mirrors.txt
Suites: noble-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
'''
        path = self.write('etc/apt/sources.list.d/ubuntu.sources', original)
        path.chmod(0o640)
        result = subprocess.run([sys.executable, str(HELPER), '--root', str(self.root)], capture_output=True, text=True, check=True)
        actual = path.read_text()
        self.assertIn('normalized 1 source files', result.stdout)
        self.assertIn('URIs: https://archive.ubuntu.com/ubuntu\nSuites: noble noble-updates noble-backports', actual)
        self.assertIn('URIs: https://security.ubuntu.com/ubuntu\nSuites: noble-security', actual)
        self.assertEqual([line for line in actual.splitlines() if not line.startswith('URIs:')],
                         [line for line in original.splitlines() if not line.startswith('URIs:')])
        self.assertEqual(path.stat().st_mode & 0o777, 0o640)
        self.assertEqual(apt.prepare(self.root), 0, 'second normalization must be idempotent')
        self.assertEqual(path.read_text(), actual)

    def test_legacy_azure_sources_preserve_options_components_comments_and_third_party(self):
        original = '''# deb http://azure.archive.ubuntu.com/ubuntu jammy main
  deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] http://azure.archive.ubuntu.com/ubuntu/ jammy main universe # keep comment
 deb-src https://azure.archive.ubuntu.com/ubuntu jammy-security main
 deb http://us.archive.ubuntu.com/ubuntu jammy-updates main restricted
 deb [signed-by=/key/microsoft.gpg] https://packages.microsoft.com/repos/azure-cli jammy main
'''
        path = self.write('etc/apt/sources.list', original)
        extra = self.write('etc/apt/sources.list.d/ubuntu-extra.list', 'deb http://security.ubuntu.com/ubuntu jammy-security main\n')
        self.assertEqual(apt.prepare(self.root), 2)
        expected = original.replace('http://azure.archive.ubuntu.com/ubuntu/ jammy', 'https://archive.ubuntu.com/ubuntu jammy').replace('https://azure.archive.ubuntu.com/ubuntu jammy-security', 'https://security.ubuntu.com/ubuntu jammy-security').replace('http://us.archive.ubuntu.com/ubuntu jammy-updates', 'https://archive.ubuntu.com/ubuntu jammy-updates')
        self.assertEqual(path.read_text(), expected)
        self.assertEqual(extra.read_text(), 'deb https://security.ubuntu.com/ubuntu jammy-security main\n')

    def test_multiline_uri_fields_keep_inline_signing_key_and_third_party_byte_exact(self):
        original = '''Types: deb
URIs: http://azure.archive.ubuntu.com/ubuntu
 https://packages.microsoft.com/repos/code
Suites: noble
 noble-updates
Components: main universe
Enabled: no
Signed-By:
 -----BEGIN PGP PUBLIC KEY BLOCK-----
 .
 unchanged-key-content
 -----END PGP PUBLIC KEY BLOCK-----

Types: deb
URIs: https://third-party.example/ubuntu
Suites: noble
Signed-By: /key/third-party.gpg
'''
        path = self.write('etc/apt/sources.list.d/mixed.sources', original)
        apt.prepare(self.root)
        self.assertEqual(path.read_text(), original.replace('http://azure.archive.ubuntu.com/ubuntu', 'https://archive.ubuntu.com/ubuntu'))

    def test_unknown_or_authenticated_locations_are_never_rewritten(self):
        uris = ['https://archive.ubuntu.com.attacker.example/ubuntu', 'https://private.example/ubuntu',
                'https://user:credential@archive.ubuntu.com/ubuntu', 'https://archive.ubuntu.com:8443/ubuntu',
                'mirror+file:/etc/apt/private-mirrors.txt', 'http://azure.archive.ubuntu.com/other',
                'https://ports.ubuntu.com/ubuntu-ports']
        original = ''.join(f'deb {uri} noble main\n' for uri in uris)
        path = self.write('etc/apt/sources.list.d/third-party.list', original)
        self.assertEqual(apt.prepare(self.root), 0)
        self.assertEqual(path.read_text(), original)
        self.assertEqual(apt.canonical_uri('mirror+file:///etc/apt/apt-mirrors.txt'), 'https://archive.ubuntu.com/ubuntu')
        self.assertEqual(apt.canonical_uri('mirror+file:/etc/apt/apt-mirrors-security.txt'), 'https://security.ubuntu.com/ubuntu')

    def test_crlf_and_pgp_fields_are_preserved(self):
        original = 'Types: deb\r\nURIs: http://archive.ubuntu.com/ubuntu\r\nSuites: jammy\r\nComponents: main\r\nSigned-By: /key/ubuntu.gpg\r\n'
        path = self.write('etc/apt/sources.list.d/crlf.sources', original)
        apt.prepare(self.root)
        self.assertEqual(path.read_bytes().decode(), original.replace('http://archive.', 'https://archive.'))

    def test_bounded_acquisition_does_not_disable_package_or_tls_verification(self):
        apt.prepare(self.root)
        config = self.root / 'etc/apt/apt.conf.d/99-ci-network-bounds'
        directives = re.findall(r'^([^/\n][^\n]*);$', config.read_text(), re.MULTILINE)
        self.assertEqual(directives, ['Acquire::Retries "2"', 'Acquire::http::Timeout "20"', 'Acquire::https::Timeout "20"'])
        self.assertEqual(config.stat().st_mode & 0o777, 0o644)
        self.assertFalse((self.root / 'etc/apt/sources.list').exists(), 'do not invent repositories when none exist')
        result = subprocess.run([sys.executable, str(HELPER)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2, 'root must be explicit; never default to the test host APT')

    def test_fixture_cannot_follow_source_or_config_symlinks_outside_root(self):
        outside = self.root / 'outside'
        sandbox = self.root / 'sandbox'
        outside.mkdir(); (sandbox / 'etc/apt/sources.list.d').mkdir(parents=True)
        source = outside / 'untouched.list'
        source.write_text('deb http://azure.archive.ubuntu.com/ubuntu noble main\n')
        link = sandbox / 'etc/apt/sources.list'
        link.symlink_to(source)
        with self.assertRaises(ValueError): apt.prepare(sandbox)
        self.assertIn('azure.archive', source.read_text())
        link.unlink()
        config_dir = sandbox / 'etc/apt/apt.conf.d'; config_dir.mkdir()
        config = config_dir / '99-ci-network-bounds'; config.symlink_to(outside / 'not-created')
        with self.assertRaises(ValueError): apt.prepare(sandbox)
        self.assertFalse((outside / 'not-created').exists())


class WorkflowAptWiring(unittest.TestCase):
    def test_all_four_real_consumers_prepare_sources_before_unchanged_dependency_commands(self):
        source = WORKFLOW.read_text()
        helper = 'sudo python3 "${{ github.workspace }}/scripts/ci/normalize-ubuntu-apt-sources.py" --root /'
        steps = {
            'Install video test dependencies': ['sudo apt-get update', 'sudo apt-get install -y ffmpeg'],
            'Install Chromium for recording acceptance': ['pnpm exec playwright install --with-deps chromium'],
            'Install system dependencies (Linux)': ['sudo apt-get update', 'sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf'],
            'Install isolated quality browser': ['pnpm exec playwright-core install --with-deps chromium'],
        }
        for name, commands in steps.items():
            with self.subTest(step=name):
                matches = re.findall(rf'(?ms)^      - name: {re.escape(name)}\n(.*?)(?=^      - name:|^  [a-zA-Z]|\Z)', source)
                self.assertEqual(len(matches), 1)
                step = matches[0]
                executable = '\n'.join(line for line in step.splitlines() if not line.lstrip().startswith('#'))
                self.assertIn('timeout-minutes: 10', step)
                self.assertNotRegex(step, r'(?m)^        (?:continue-on-error|if):')
                self.assertIn(helper, executable)
                for command in commands:
                    self.assertIn(command, executable)
                    self.assertLess(executable.index(helper), executable.index(command))
        self.assertEqual(source.count(helper), 4)
        self.assertNotIn('sudo sed -i', source, 'the former partial Azure rewrite must not survive')

    def test_helper_changes_trigger_all_four_jobs_and_fixture_guard_is_unconditional(self):
        source = WORKFLOW.read_text()
        for section in ['server', 'admin', 'desktop', 'cds']:
            block = re.search(rf'(?ms)^            {section}:\n(.*?)(?=^            [a-z_]+:)', source)
            self.assertIsNotNone(block)
            self.assertIn("- 'scripts/ci/normalize-ubuntu-apt-sources.py'", block[1])
        layout = re.search(r'(?ms)^  repository-layout:\n(.*?)(?=^  [a-zA-Z])', source)
        self.assertIsNotNone(layout)
        self.assertNotRegex(layout[1], r'(?m)^    (?:if|needs):')
        self.assertIn('run: python3 scripts/tests/test_ci_ubuntu_apt.py', layout[1])


if __name__ == '__main__':
    unittest.main()
