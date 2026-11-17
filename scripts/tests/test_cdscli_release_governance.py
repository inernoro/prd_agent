#!/usr/bin/env python3
"""项目作用域、结构化调试范围及无隐式发布的 CLI 契约。"""
import argparse
import importlib.util
import pathlib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('governance_cli', pathlib.Path(__file__).resolve().parents[2] / '.claude/skills/cds/cli/cdscli.py')
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)

class GovernanceCliTests(unittest.TestCase):
    def args(self, **changes):
        values = dict(release_target_cmd='approval-request', project='p', id='target', branch='feature', kind='debug',
                      expires_in=60, scope=['allowed/', 'exact.ts'], rollback_version=None, reason='限定范围的真实调试')
        return argparse.Namespace(**(values | changes))

    def test_structured_request_does_not_approve_or_publish(self):
        with patch.object(cli, '_release_environment_rows', return_value=([], [{'id':'target','projectId':'p'}])), patch.object(cli, '_call', return_value={}) as call, patch.object(cli, 'ok'):
            cli.cmd_release_governance(self.args())
            self.assertEqual(call.call_count, 1)
            self.assertEqual(call.call_args.args, ('POST','/api/releases/targets/target/authorizations'))
            body=call.call_args.kwargs['body']
            self.assertEqual(body['allowedPaths'], ['allowed/', 'exact.ts'])
            self.assertEqual(body['action'], 'release')
            self.assertNotIn('approvedBy',body)

    def test_cross_project_never_writes(self):
        with patch.object(cli, '_release_environment_rows', return_value=([], [{'id':'target','projectId':'other'}])), patch.object(cli, '_call') as call, patch.object(cli, 'die', side_effect=SystemExit):
            with self.assertRaises(SystemExit): cli.cmd_release_governance(self.args())
            call.assert_not_called()

    def test_scheduled_job_is_explicit_and_never_spoofs_requester(self):
        with patch.object(cli, '_release_environment_rows', return_value=([], [{'id':'target','projectId':'p'}])), patch.object(cli, '_call', return_value={}) as call, patch.object(cli, 'ok'):
            cli.cmd_release_governance(self.args(scheduled_job='job-real'))
            body=call.call_args.kwargs['body']
            self.assertEqual(body['scheduledJobId'],'job-real')
            self.assertNotIn('operator',body)
            self.assertNotIn('requestedBy',body)
    def test_fixed_version_is_explicit_single_only_and_never_changes_branch(self):
        with patch.object(cli, '_release_environment_rows', return_value=([], [{'id':'target','projectId':'p'}])), patch.object(cli, '_call', return_value={}) as call, patch.object(cli, 'ok'):
            cli.cmd_release_governance(self.args(kind='single',deployment_version='saved-a'))
            self.assertEqual(call.call_count,1)
            self.assertEqual(call.call_args.kwargs['body']['deploymentVersionId'],'saved-a')
        for changes in [{'kind':'debug'},{'kind':'single','rollback_version':'old-run'}]:
            with patch.object(cli, '_release_environment_rows', return_value=([], [{'id':'target','projectId':'p'}])), patch.object(cli, '_call') as call, patch.object(cli, 'die', side_effect=SystemExit):
                with self.assertRaises(SystemExit): cli.cmd_release_governance(self.args(deployment_version='saved-a',**changes))
                call.assert_not_called()

    def test_invalid_duration_or_missing_scope_never_writes(self):
        for changes in [{'expires_in':0}, {'expires_in':1441}, {'scope':None}]:
            with patch.object(cli, '_release_environment_rows', return_value=([], [{'id':'target','projectId':'p'}])), patch.object(cli, '_call') as call, patch.object(cli, 'die', side_effect=SystemExit):
                with self.assertRaises(SystemExit): cli.cmd_release_governance(self.args(**changes))
                call.assert_not_called()

    def test_revoke_checks_project_record_first(self):
        with patch.object(cli, '_call', return_value={'authorizations':[{'id':'other'}]}) as call, patch.object(cli, 'die', side_effect=SystemExit):
            with self.assertRaises(SystemExit): cli.cmd_release_governance(self.args(release_target_cmd='approval-revoke'))
            self.assertEqual(call.call_count,1)
            self.assertEqual(call.call_args.args[0],'GET')

if __name__ == '__main__': unittest.main()
