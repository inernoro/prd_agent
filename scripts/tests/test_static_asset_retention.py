#!/usr/bin/env python3
"""Real filesystem and shell activation regressions for the opt-in asset window."""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / 'scripts/lib/static-asset-retention.py'
LIB = REPO / 'scripts/lib/static-release.sh'
MANIFEST = '.static-assets-retention.json'


class StaticWindow(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='owned-static-window-')
        self.root = Path(self.temp.name) / 'web'
        self.root.mkdir()
        self.env = {**os.environ, 'STATIC_ASSET_COMPAT_DAYS': '30', 'STATIC_ASSET_RETENTION_SCRIPT': str(TOOL)}
        self.env.pop('STATIC_ASSET_LOCK_FD', None)

    def tearDown(self):
        self.temp.cleanup()

    def stage(self, version, size=16):
        dest = self.root / ('.staging-' + version)
        (dest / 'assets').mkdir(parents=True)
        (dest / 'index.html').write_text(f'<script src="/assets/{version}.js"></script>')
        (dest / 'assets' / (version + '.js')).write_bytes((version.encode() * (size // len(version) + 1))[:size])
        return dest

    def activate(self, version):
        return subprocess.run(['sh', '-eu', '-c', '. "$1"; static_release_activate "$2" "$3" "$4"',
                               'test', str(LIB), str(self.root / ('.staging-' + version)), str(self.root), version],
                              env=self.env, cwd=REPO, capture_output=True, text=True)

    def age(self, seconds):
        for p in (self.root / '.releases').glob('*/' + MANIFEST):
            data = json.loads(p.read_text())
            for record in data['files'].values():
                if 'lastServedAt' in record:
                    record['lastServedAt'] -= seconds
            for record in data.get('rootFiles', {}).values():
                record['lastServedAt'] -= seconds
            if 'createdAt' in data:
                data['createdAt'] -= seconds
            p.write_text(json.dumps(data))

    def test_verified_expiry_unknowns_and_plan_revalidation(self):
        for version in ['A', 'B', 'C']:
            self.stage(version)
            result = self.activate(version)
            self.assertEqual(result.returncode, 0, result.stderr)
        self.age(40 * 86400)
        old = self.root / '.releases/A/assets/A.js'
        original = old.read_bytes()
        (old.parent / 'unclassified.js').write_text('keep unknown')
        stage = self.stage('D')
        command = ['python3', str(TOOL), '--root', str(self.root), '--destination', str(stage), '--release-id', 'D', '--compat-days', '30']
        before = sorted(str(p.relative_to(self.root)) for p in self.root.rglob('*'))
        plan = json.loads(subprocess.check_output(command, env=self.env))
        self.assertTrue(plan['dryRun'])
        self.assertEqual(plan['scanStatus'], 'partial')
        self.assertGreater(plan['omittedExpiredInheritance'], 0)
        self.assertEqual(before, sorted(str(p.relative_to(self.root)) for p in self.root.rglob('*')))
        (old.parent / 'added-after-plan.js').write_text('latest inventory must retain me')
        result = self.activate('D')
        self.assertEqual(result.returncode, 0, result.stderr)
        current = self.root / 'current/assets'
        self.assertFalse((current / 'A.js').exists())
        for name in ['B.js', 'C.js', 'unclassified.js', 'added-after-plan.js']:
            self.assertTrue((current / name).is_file(), name)
        self.assertEqual(old.read_bytes(), original)

    def test_symlink_and_invalid_window_keep_current(self):
        self.stage('A');self.assertEqual(self.activate('A').returncode, 0)
        self.stage('B')
        (self.root / '.releases/A/assets/escape').symlink_to('/etc/passwd')
        result = self.activate('B')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(os.readlink(self.root / 'current'), '.releases/A')
        (self.root / '.releases/A/assets/escape').unlink()
        self.env['STATIC_ASSET_COMPAT_DAYS'] = '1'
        self.assertNotEqual(self.activate('B').returncode, 0)
        self.assertEqual(os.readlink(self.root / 'current'), '.releases/A')

    def test_database_in_fresh_staging_is_not_certified_as_generated_assets(self):
        self.stage('A');self.assertEqual(self.activate('A').returncode, 0)
        stage = self.stage('B')
        data = stage / 'assets/mysql/ibdata1'
        data.parent.mkdir();data.write_bytes(b'synthetic database bytes')
        result = self.activate('B')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('persistent or unknown database payload', result.stderr)
        self.assertEqual(os.readlink(self.root / 'current'), '.releases/A')
        self.assertEqual(data.read_bytes(), b'synthetic database bytes')

    def test_replaced_directory_and_manifest_query_failure_hold_assets(self):
        for version in ['A', 'B', 'C']:
            self.stage(version)
            result = self.activate(version)
            self.assertEqual(result.returncode, 0, result.stderr)
        self.age(40 * 86400)
        release = self.root / '.releases/A'
        (release / 'assets').rename(release / 'original-assets')
        (release / 'assets').mkdir()
        (release / 'assets/A.js').write_text('replacement has unknown ownership')
        stage = self.stage('D')
        command = ['python3', str(TOOL), '--root', str(self.root), '--destination', str(stage), '--release-id', 'D', '--compat-days', '30']
        plan = json.loads(subprocess.check_output(command, env=self.env))
        self.assertEqual(plan['scanStatus'], 'partial')
        self.assertTrue(any(r['reason'] == 'digest-mismatch' and r['action'] == 'retain' for r in plan['objects']))
        (release / MANIFEST).unlink()
        (release / MANIFEST).symlink_to('/etc/passwd')
        plan = json.loads(subprocess.check_output(command, env=self.env))
        self.assertEqual(plan['scanStatus'], 'partial')
        self.assertTrue(any(r['reason'] == 'manifest-query-failed' and r['action'] == 'retain' for r in plan['objects']))
        self.assertEqual(self.activate('D').returncode, 0)
        self.assertEqual((self.root / 'current/assets/A.js').read_text(), 'replacement has unknown ownership')
        self.assertTrue((release / 'original-assets/A.js').is_file())

    def test_concurrent_activations_serialize_whole_switch(self):
        self.stage('A');self.assertEqual(self.activate('A').returncode, 0)
        self.stage('B', 1024 * 1024);self.stage('C', 1024 * 1024)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(self.activate, ['B', 'C']))
        for result in results:
            self.assertEqual(result.returncode, 0, result.stderr)
        for version in ['A', 'B', 'C']:
            self.assertTrue((self.root / 'current/assets' / (version + '.js')).is_file())
        self.assertNotEqual(os.readlink(self.root / 'current'), os.readlink(self.root / 'previous'))

    def test_retirement_preview_unknown_payload_and_query_failure(self):
        for i in range(24):
            version = f'v{i:03d}'
            self.stage(version)
            result = self.activate(version)
            self.assertEqual(result.returncode, 0, result.stderr)
        self.age(40 * 86400)
        data = self.root / '.releases/v000/unknown-database'
        data.write_bytes(b'owned synthetic persistent data')
        command = ['python3', str(TOOL), '--root', str(self.root), '--versions', '--compat-days', '30']
        before = {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file() and not p.is_symlink()}
        plan = json.loads(subprocess.check_output(command, env=self.env))
        self.assertTrue(plan['dryRun'])
        self.assertGreaterEqual(plan['pendingVersions'], 2)
        self.assertEqual(plan['retiredFiles'], 0)
        self.assertGreater(plan['candidateFiles'], 0)
        self.assertEqual(before, {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file() and not p.is_symlink()})
        bin_dir = Path(self.temp.name) / 'bin'
        bin_dir.mkdir()
        fake = bin_dir / 'docker'
        fake.write_text('#!/bin/sh\nexit 91\n');fake.chmod(0o755)
        failed = json.loads(subprocess.check_output(command + ['--apply'], env={**self.env, 'PATH': str(bin_dir) + ':' + os.environ['PATH']}))
        self.assertEqual(failed['scanStatus'], 'partial')
        self.assertEqual(failed['retiredFiles'], 0)
        self.assertIsNone(failed['filesystemNetAvailableChange'])
        self.assertEqual(data.read_bytes(), b'owned synthetic persistent data')
        result = json.loads(subprocess.check_output(command + ['--apply'], env=self.env))
        self.assertEqual(result['scanStatus'], 'partial')
        self.assertGreater(result['retiredFiles'], 0)
        self.assertGreaterEqual(result['heldFiles'], 1)
        self.assertEqual(data.read_bytes(), b'owned synthetic persistent data')

    def test_accelerated_continuous_deploys_bound_managed_assets(self):
        # A private tmpfs fixture avoids unrelated builds changing the root
        # filesystem while measuring actual f_bavail. This is a lifecycle test,
        # not a production-storage throughput benchmark.
        self.temp.cleanup()
        self.temp = tempfile.TemporaryDirectory(prefix='owned-static-window-', dir='/dev/shm')
        self.root = Path(self.temp.name) / 'web'
        self.root.mkdir()
        samples = []
        for i in range(65):
            version = f'v{i:03d}'
            self.stage(version, 256 * 1024)
            result = self.activate(version)
            self.assertEqual(result.returncode, 0, result.stderr)
            after = os.statvfs(self.root)
            assets = list((self.root / 'current/assets').iterdir())
            retirement = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{') and 'retiredFiles' in line][0]
            samples.append({'cycle': i + 1, 'assets': len(assets), 'versions': len(list((self.root / '.releases').iterdir())), 'availableBytes': after.f_bavail * after.f_frsize,
                            'collectorNetAvailableChange': retirement['filesystemNetAvailableChange'], 'retiredFiles': retirement['retiredFiles'], 'retirement': retirement})
            self.age(86400)
        evidence = os.environ.get('STATIC_WINDOW_EVIDENCE')
        if evidence:
            Path(evidence).write_text(json.dumps({'scope': '65 isolated generated releases on private tmpfs; one simulated day per deployment; real per-file retirement; not production observation',
                                                'windowDays': 30, 'bytesPerNativeAsset': 256 * 1024, 'samples': samples}, indent=2))
        self.assertLessEqual(max(s['assets'] for s in samples[35:]), 33)
        self.assertLessEqual(abs(samples[-1]['assets'] - samples[35]['assets']), 1)
        self.assertLessEqual(max(s['versions'] for s in samples[35:]), 33)
        self.assertGreater(sum(s['retiredFiles'] for s in samples), 0)
        # Hard links make logical sizes misleading; compare the actual filesystem
        # after the real activation/retirement chain has saturated its window.
        # Whole versions keep their own 30-day rollback window as well. Shared
        # inherited assets stop consuming new physical blocks after both
        # windows saturate, rather than when only the current view saturates.
        self.assertLessEqual(abs(samples[-1]['availableBytes'] - samples[60]['availableBytes']), 1024 * 1024)
        self.assertGreaterEqual(min(s['collectorNetAvailableChange'] for s in samples[61:]), 256 * 1024)


if __name__ == '__main__':
    unittest.main()
