"""No-secret tests execute the actual workflow input-handling snippets.

Requires PyYAML. These are local guards, not proof of GitHub authorization.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / '.github/workflows'


def workflow(name):
    return yaml.safe_load((WORKFLOWS / name).read_text())


def step(name, title):
    return next(s for j in workflow(name)['jobs'].values()
                for s in j.get('steps', []) if s.get('name') == title)


class ReleaseInputTests(unittest.TestCase):
    def run_bash(self, script, env, cwd):
        return subprocess.run(['bash', '-euo', 'pipefail', '-c', script],
                              cwd=cwd, env={**os.environ, **env}, capture_output=True, text=True)

    def test_desktop_version_fixture(self):
        script = step('desktop-release.yml', 'Sync app version (tag/workflow_dispatch)')['run']
        self.assertNotIn('${{', script)
        payloads = ['1.2.3', '1.2.3-rc.1', '1.2.3+build.7', '1.2.3"; touch PWNED; #',
                    '$(touch PWNED)', '`touch PWNED`', '1.2.3\nEVIL=1',
                    '1.2.3\rEVIL=1', '', '01.2.3', '1.2.3-']
        for event in ['workflow_dispatch', 'push']:
            for version in payloads:
                with self.subTest(event=event, version=version), tempfile.TemporaryDirectory() as tmp:
                    p = Path(tmp)
                    (p/'src-tauri').mkdir()
                    (p/'package.json').write_text('{"version":"0.0.0"}')
                    (p/'src-tauri/tauri.conf.json').write_text('{"version":"0.0.0"}')
                    (p/'src-tauri/Cargo.toml').write_text('[package]\nversion = "0.0.0"\n')
                    out = p/'env'
                    result = self.run_bash(script, {'GITHUB_EVENT_NAME': event,
                        'GITHUB_REF': 'refs/tags/v'+version, 'GITHUB_REF_NAME': 'v'+version,
                        'RELEASE_VERSION_INPUT': version, 'GITHUB_ENV': str(out)}, tmp)
                    valid = version in payloads[:3]
                    self.assertEqual(result.returncode == 0, valid, result.stderr)
                    self.assertFalse((p/'PWNED').exists())
                    if valid:
                        self.assertEqual(json.loads((p/'package.json').read_text())['version'], version)
                        self.assertEqual(out.read_text(), 'APP_VERSION='+version+'\n')
                    else:
                        self.assertFalse(out.exists())
                        self.assertEqual(json.loads((p/'package.json').read_text())['version'], '0.0.0')

    def test_sidecar_tag_fixture(self):
        script = step('cds-sidecar-image.yml', 'Resolve image tag')['run']
        for tag in ['preview-1', 'x'*128, 'x'*129, '-option', 'x,y=z',
                    '$(touch PWNED)', '`touch PWNED`', 'x\nEVIL=1']:
            with self.subTest(tag=tag), tempfile.TemporaryDirectory() as tmp:
                out = Path(tmp)/'out'
                result = self.run_bash(script, {'IMAGE_TAG_INPUT': tag,
                    'REGISTRY': 'example.invalid', 'IMAGE_NAME': 'fixture',
                    'GITHUB_OUTPUT': str(out), 'GITHUB_STEP_SUMMARY': str(Path(tmp)/'summary')}, tmp)
                self.assertEqual(result.returncode == 0, tag in ['preview-1', 'x'*128])
                self.assertFalse((Path(tmp)/'PWNED').exists())
                if result.returncode:
                    self.assertFalse(out.exists())

    def test_manifest_ref_is_data(self):
        script = step('cds-prebuilt.yml', 'Write prebuilt manifest')['run']
        for ref in ['feature/preview', 'feature/$(touch${IFS}PWNED)', 'feature/"quote', 'bad\nref']:
            with self.subTest(ref=ref), tempfile.TemporaryDirectory() as tmp:
                (Path(tmp)/'cds').mkdir()
                result = self.run_bash(script, {'GITHUB_SHA': 'a'*40,
                    'GITHUB_REF_NAME': ref, 'GITHUB_RUN_ID': '123'}, tmp)
                self.assertEqual(result.returncode == 0, '\n' not in ref, result.stderr)
                self.assertFalse((Path(tmp)/'PWNED').exists())
                if not result.returncode:
                    data = json.loads((Path(tmp)/'cds/cds-prebuilt-manifest.json').read_text())
                    self.assertEqual(data['ref'], ref)

    def test_server_metadata_inputs(self):
        script = step('server-deploy.yml', 'Validate publication inputs')['run']
        for tag, platforms, valid in [('prod-1','linux/amd64',True),
              ('prod-1','linux/amd64,linux/arm64',True),
              ('x\ntype=raw,value=latest','linux/amd64',False),
              ('$(touch PWNED)','linux/amd64',False), ('ok','linux/amd64\nother',False)]:
            with self.subTest(tag=tag), tempfile.TemporaryDirectory() as tmp:
                result = self.run_bash(script, {'RELEASE_TAG_INPUT':tag,'DOCKER_PLATFORMS':platforms}, tmp)
                self.assertEqual(result.returncode == 0, valid)
                self.assertFalse((Path(tmp)/'PWNED').exists())

    def test_ci_summary_requires_release_fixtures(self):
        jobs = workflow('ci.yml')['jobs']
        fixtures = jobs['workflow-release-security']
        summary = jobs['ci-status']
        self.assertNotIn('if', fixtures)
        self.assertNotIn('needs', fixtures)
        self.assertIn('workflow-release-security', summary['needs'])
        self.assertEqual(summary['if'], 'always()')
        gate = step('ci.yml', 'Require workflow release security fixtures')
        self.assertEqual(gate['env']['FIXTURE_RESULT'], '${{ needs.workflow-release-security.result }}')
        with tempfile.TemporaryDirectory() as tmp:
            for result in ('success', 'failure', 'cancelled', 'skipped', ''):
                with self.subTest(result=result):
                    checked = self.run_bash(gate['run'], {'FIXTURE_RESULT': result}, tmp)
                    self.assertEqual(checked.returncode, 0 if result == 'success' else 1)

    def test_privileged_actions_are_recorded_full_commits(self):
        pins = json.loads((ROOT/'.github/action-pins.json').read_text())['actions']
        approved = {ref.split('@')[0]+'@'+value['sha'] for ref,value in pins.items()}
        # Scope this gate to the workflows reviewed in KD-11.
        reviewed = (
            'branch-image.yml', 'cds-external-port-audit.yml', 'cds-prebuilt.yml',
            'cds-sidecar-image.yml', 'ci.yml', 'desktop-release.yml',
            'llmgw-prod-preflight.yml', 'open-design-runtime.yml',
            'preview-acceptance.yml', 'server-deploy.yml', 'web-latest-pages.yml',
        )
        for name in reviewed:
            path = WORKFLOWS / name
            raw = path.read_text()
            for job in yaml.safe_load(raw)['jobs'].values():
                for item in job.get('steps', []):
                    action = item.get('uses', '')
                    if action and not action.startswith('./'):
                        self.assertRegex(action, r'^[\w.-]+/[\w./-]+@[0-9a-f]{40}$', str(path))
                        self.assertIn(action, approved)

    def test_preview_contract_still_present(self):
        for name in ['branch-image.yml', 'cds-prebuilt.yml']:
            raw = (WORKFLOWS/name).read_text()
            self.assertIn('branches: ["**"]', raw)
            self.assertIn('type=raw,value=sha-${{ github.sha }}', raw)
        for name in ['branch-image.yml', 'cds-prebuilt.yml', 'desktop-release.yml',
                     'server-deploy.yml', 'cds-sidecar-image.yml',
                     'open-design-runtime.yml', 'web-latest-pages.yml']:
            raw = (WORKFLOWS/name).read_text()
            self.assertNotRegex(raw, r'github\.ref_protected|trusted-artifacts|branch-preview')
        self.assertEqual(workflow('web-latest-pages.yml')['jobs']['pages']['environment']['name'],
                         'github-pages')


if __name__ == '__main__':
    unittest.main()
