"""结构化验收 CLI：默认正式环境、票据不泄漏、归档与验真分离。"""
import argparse
import contextlib
import importlib.util
import io
import json
import os
import pathlib
import tempfile
import unittest
from unittest.mock import patch

REPO = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("cdscli_acceptance_test", REPO / ".claude/skills/cds/cli/cdscli.py")
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)


class AcceptanceCliTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="cds-acceptance-cli-")
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        for name, value in [("_workspace_root", self.tmp.name), ("_cds_base", "https://cds.example")]:
            p = patch.object(cli, name, return_value=value)
            p.start()
            self.addCleanup(p.stop)
        p = patch.object(cli, "_exclude_local_path")
        self.exclude = p.start()
        self.addCleanup(p.stop)

    def invoke(self, action, **kwargs):
        result = []
        with patch.object(cli, "ok", side_effect=result.append):
            cli.cmd_acceptance(argparse.Namespace(action=action, project="p1", id="task-1", **kwargs))
        return result[0]

    def claim(self):
        with patch.object(cli, "_call", return_value={"task": {"id": "task-1"}, "leaseToken": "private-test-token"}):
            return self.invoke("claim", agent="Agent")

    def test_create_defaults_to_production_without_branch(self):
        parser = argparse.ArgumentParser()
        cli._register_acceptance_parser(parser.add_subparsers())
        args = parser.parse_args(["acceptance", "create", "--template", "template-1", "--project", "p1"])
        with patch.object(cli, "_call", return_value={}) as call, patch.object(cli, "ok"):
            args.func(args)
        payload = call.call_args.kwargs["body"]
        self.assertEqual(payload["environment"], "production")
        self.assertNotIn("branch", payload)

    def test_claim_stores_private_ticket_and_never_returns_it(self):
        body = self.claim()
        filename = pathlib.Path(cli._acceptance_lease_path("task-1"))
        self.assertEqual(filename.stat().st_mode & 0o777, 0o600)
        self.assertEqual(filename.parent.stat().st_mode & 0o777, 0o700)
        self.assertNotIn("private-test-token", json.dumps(body))
        self.assertTrue(body["leaseStored"])
        self.exclude.assert_called_once()

    def test_heartbeat_uses_private_ticket(self):
        self.claim()
        with patch.object(cli, "_call", return_value={}) as call:
            self.invoke("heartbeat")
        self.assertEqual(call.call_args.kwargs["body"]["leaseToken"], "private-test-token")

    def test_failed_complete_keeps_ticket_for_recovery(self):
        self.claim()
        with patch.object(cli, "_call", side_effect=SystemExit(1)), self.assertRaises(SystemExit):
            self.invoke("complete")
        self.assertTrue(pathlib.Path(cli._acceptance_lease_path("task-1")).exists())

    def test_release_deletes_ticket_only_after_success(self):
        self.claim()
        with patch.object(cli, "_call", return_value={}):
            self.invoke("release")
        self.assertFalse(pathlib.Path(cli._acceptance_lease_path("task-1")).exists())

    def test_world_readable_ticket_is_rejected_without_remote_write(self):
        self.claim()
        os.chmod(cli._acceptance_lease_path("task-1"), 0o644)
        with patch.object(cli, "_call") as call, contextlib.redirect_stdout(io.StringIO()), self.assertRaises(SystemExit):
            self.invoke("heartbeat")
        call.assert_not_called()

    def test_changed_host_rejects_old_ticket(self):
        self.claim()
        with patch.object(cli, "_cds_base", return_value="https://other.example"), contextlib.redirect_stdout(io.StringIO()), self.assertRaises(SystemExit):
            cli._acceptance_lease("task-1")

    def test_result_file_cannot_supply_ticket(self):
        filename = self.root / "result.json"
        filename.write_text(json.dumps({"leaseToken": "do-not-use"}))
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(SystemExit):
            cli._acceptance_json_file(str(filename))

    def test_id_rejects_path_escape(self):
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(SystemExit):
            cli._acceptance_id("../task")

    def test_archive_uses_canonical_source_and_does_not_claim_verification(self):
        source = {"title": "报告", "format": "md", "content": "# 报告", "sourceId": "task-1", "verdict": "fail", "defectCounts": {"p0": 0, "p1": 1}}
        with patch.object(cli, "_call", side_effect=[{"task": {"projectId": "p1"}, "report": source}, {"report": {"id": "report-1"}}, {"task": {"id": "task-1"}}]) as call:
            result = self.invoke("archive-report")
        self.assertEqual(call.call_args_list[1].kwargs["body"]["sourceId"], "task-1")
        self.assertEqual(call.call_args_list[2].args[1], "/api/acceptance/tasks/task-1/bind-report")
        self.assertEqual(result["delivery"], "pending-verify-open")
        self.assertEqual(call.call_count, 3)


if __name__ == "__main__":
    unittest.main()
