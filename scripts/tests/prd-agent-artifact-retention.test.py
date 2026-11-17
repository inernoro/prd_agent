import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import subprocess
import json

spec = importlib.util.spec_from_file_location('retention', Path(__file__).parents[1] / 'prd-agent-artifact-retention.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class ArtifactRetentionTests(unittest.TestCase):
    def test_running_and_two_rollbacks_survive_with_both_static_pointers(self):
        a, b, c, old = ('a'*40, 'b'*40, 'c'*40, 'd'*40)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for sha in (a,b):
                (root / ('sha-'+sha+'-stamp')).mkdir()
            (root/'current').symlink_to('sha-'+a+'-stamp')
            (root/'previous').symlink_to('sha-'+b+'-stamp')
            protected = m.protected_revisions([{'Config': {'Labels': {'org.opencontainers.image.revision': old}}}],
                [{'status':'success','releaseRef':'sha-'+s,'endedAt':str(3-i)} for i,s in enumerate((a,b,c))], root)
            self.assertEqual(protected, {a,b,c,old})
            (root/'previous').unlink()
            with self.assertRaises(RuntimeError):
                m.protected_revisions([], [], root)

    def test_images_exclude_other_apps_running_and_rollback(self):
        rows = [{'Repository':repo,'Tag':'sha-'+sha,'ID':id} for repo,sha,id in [
            ('ghcr.io/inernoro/prd_agent/prdagent-server','a'*40,'running'),
            ('ghcr.io/inernoro/prd_agent/prdagent-server','b'*40,'rollback'),
            ('ghcr.io/other/app','c'*40,'other'),
            ('get.miduo.org/ghcr.io/inernoro/prd_agent/prdagent-server','d'*40,'old')]]
        self.assertEqual(m.image_candidates(rows, {'b'*40}, {'running'}),
            ['get.miduo.org/ghcr.io/inernoro/prd_agent/prdagent-server:sha-'+'d'*40])

    def test_disappearing_container_retries_a_complete_inventory(self):
        containers = [{'Name':'/prdagent-api','State':{'Running':True}}]
        with tempfile.TemporaryDirectory() as tmp, patch.object(m, 'run', side_effect=[
            'removed-id', subprocess.CalledProcessError(1, ['docker','inspect']),
            'live-id', json.dumps(containers)]), patch.object(m, 'protected_revisions', return_value={'a'*40}):
            actual, _, protected = m.inventory(Path(tmp), Path(tmp))
            self.assertEqual(actual, containers)
            self.assertEqual(protected, {'a'*40})

    def test_mounts_nested_below_worktree_protect_the_entire_worktree(self):
        candidate = Path('/root/releases/version')
        self.assertTrue(m.contains_live_path(candidate, {candidate/'deploy/web/dist'}))
        self.assertFalse(m.contains_live_path(candidate, {Path('/root/releases/version-other')}))


if __name__ == '__main__': unittest.main()
