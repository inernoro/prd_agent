"""Exercise the actual planning and debt CLI entry points against a local HTTP fixture."""

import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


CLI = Path(__file__).resolve().parents[1] / "cli" / "cdscli.py"
PROJECT = "planning-fixture"
KEY = "cdsp_planning_fixture_key"
BASE = f"/api/projects/{PROJECT}/planning"
PROPOSAL = {
    "type": "proposal.submit",
    "requestId": "planning-fixture:proposal-1",
    "kind": "debt",
    "draft": {"title": "补齐导出测试", "whyDebt": "经确认安排下个版本"},
    "source": {"type": "manual", "ref": "fixture:confirmed-tradeoff-1"},
}
BRIEF = {
    "readiness": {
        "score": 1, "max": 7,
        "items": [{"label": label, "ok": label == "问题与影响"} for label in
                  ("问题与影响", "来源可追溯", "根因已确认", "欠债理由", "期望方向", "偿还标准", "近期确认")],
    },
    "sections": [
        {"id": "problem", "title": "现在是什么问题", "lines": [
            {"kind": "fact", "text": "合成导出重复请求", "cites": [
                {"kind": "record", "id": "D-0001", "label": "当前记录", "target": "context"},
            ]},
        ]},
        {"id": "attempts", "title": "之前如何处理", "lines": [{"kind": "gap", "text": "未记处理经过", "cites": []}]},
        {"id": "why", "title": "为什么延后", "lines": [{"kind": "gap", "text": "未记欠债理由", "cites": []}]},
        {"id": "direction", "title": "往哪个方向走", "lines": [{"kind": "gap", "text": "还没记录方向", "cites": []}]},
    ],
    "next": ["补记偿还标准"],
    "gaps": ["缺乏偿还标准"],
    "markdown": "# D-0001 导出结果\n\n- 合成导出重复请求（当前记录）\n\n## 建议的下一步\n\n- 补记偿还标准",
}


class PlanningCliTest(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.committed = {}
        self.permissions = ["read", "propose", "write"]
        self.foreign = False
        self.expose_brief = True
        self.drop_write_response = False
        self.reject_write = False
        self.candidates = []
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def respond(self, status, value):
                body = json.dumps(value, ensure_ascii=False).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def handle_request(self):
                url = urlsplit(self.path)
                key = self.headers.get("X-AI-Access-Key")
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or "{}")
                fixture.requests.append((self.command, url, body, key))
                if key != KEY:
                    self.respond(401, {"error": "unauthorized"})
                    return

                project = "other-project" if fixture.foreign else PROJECT
                debt = {"id": "D-0001", "projectId": project, "title": "导出结果"}
                if url.path == BASE + "/capabilities":
                    self.respond(200, {
                        "projectId": PROJECT, "protocolVersion": 1, "permissions": fixture.permissions,
                    })
                elif url.path == BASE:
                    self.respond(200, {
                        "projectId": PROJECT, "capabilities": fixture.permissions,
                        "decisions": [{"id": "ADR-1", "projectId": project, "title": "采用导出任务"}],
                        "proposals": [{"id": "P-0001", "projectId": project, "status": "pending"},
                                      {"id": "P-0002", "projectId": project, "status": "accepted"}],
                        "pullRequests": [{"number": 42, "projectId": project, "decisionIds": ["ADR-1"]},
                                         {"number": 43, "projectId": project, "decisionIds": ["ADR-2"]}],
                        "plans": [], "events": [],
                    })
                elif url.path == BASE + "/debts":
                    self.respond(200, {"projectId": PROJECT, "items": [debt], "nextCursor": None})
                elif url.path == BASE + "/duplicates":
                    self.respond(200, {"projectId": project, "items": fixture.candidates})
                elif url.path == BASE + "/checkup":
                    self.respond(200, {"projectId": project, "unread": 0, "notices": [],
                                       "summary": {"at": "2026-11-20T22:00:00Z", "duplicates": 1, "pending": 2, "closed": 3}})
                elif url.path == BASE + "/debts/D-0001":
                    if "read" not in fixture.permissions:
                        self.respond(404, {"error": "not_found", "message": KEY, "details": "upstream fixture detail"})
                        return
                    detail = {"projectId": PROJECT, "debt": debt, "events": []}
                    if fixture.expose_brief:
                        detail["brief"] = BRIEF
                    self.respond(200, detail)
                elif url.path == BASE + "/commands" and self.command == "POST":
                    permission = {"proposal.submit": "propose", "debt.create": "write"}.get(body.get("type"))
                    if fixture.reject_write or permission not in fixture.permissions:
                        self.respond(403, {"error": "write_forbidden", "message": KEY, "details": "upstream fixture detail"})
                        return
                    request_id = body.get("requestId")
                    previous = fixture.committed.get(request_id)
                    if previous is not None and body != previous:
                        self.respond(409, {"error": "idempotency_conflict"})
                        return
                    if not previous and body.get("type") == "debt.create" and fixture.candidates and not body.get("distinction"):
                        self.respond(409, {"error": "possible_duplicate", "message": KEY, "details": "upstream fixture detail",
                                           "candidates": fixture.candidates})
                        return
                    fixture.committed[request_id] = body
                    if fixture.drop_write_response:
                        fixture.drop_write_response = False
                        self.close_connection = True
                        return
                    result = {"id": "P-0001", "projectId": project, "status": "pending"} if permission == "propose" else debt
                    self.respond(200 if previous else 201, {
                        "projectId": PROJECT, "result": result, "reused": previous is not None,
                    })
                else:
                    self.respond(404, {"error": "not_found"})

            do_GET = handle_request
            do_POST = handle_request

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 1)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        root = tempfile.TemporaryDirectory(prefix="cdscli-planning-")
        self.addCleanup(root.cleanup)
        self.root = Path(root.name)
        (self.root / ".git").mkdir()
        (self.root / ".cds").mkdir()
        (self.root / ".cds" / "credentials.json").write_text(json.dumps({
            "version": 1,
            "host": f"http://127.0.0.1:{self.server.server_port}",
            "projectId": PROJECT,
            "projectKey": KEY,
        }), encoding="utf-8")

    def call(self, *args):
        completed = subprocess.run(
            [sys.executable, str(CLI), *args], cwd=self.root,
            env={"PATH": os.defpath, "NO_PROXY": "127.0.0.1", "no_proxy": "127.0.0.1"},
            capture_output=True, text=True, timeout=12, check=False,
        )
        if "--human" in args or not completed.stdout.strip():
            return completed, {}
        return completed, json.loads(completed.stdout)

    def submit(self, command):
        filename = self.root / "command.json"
        filename.write_text(json.dumps(command, ensure_ascii=False), encoding="utf-8")
        return self.call("planning", "submit", "--project", PROJECT, "--file", str(filename))

    def assert_ok(self, outcome):
        process, payload = outcome
        self.assertEqual(process.returncode, 0, process.stderr or payload)
        self.assertIs(payload["ok"], True)
        self.assertTrue(payload["trace"])
        return payload["data"]

    def assert_error(self, outcome):
        process, payload = outcome
        self.assertNotEqual(process.returncode, 0)
        self.assertIs(payload.get("ok"), False, process.stderr or payload)
        self.assertNotIn(KEY, process.stdout + process.stderr)
        self.assertNotIn("upstream fixture detail", process.stdout + process.stderr)

    def test_reads_board_and_debts_with_project_credentials(self):
        board = self.assert_ok(self.call("planning", "show", "--project", PROJECT))
        self.assertEqual(board["projectId"], PROJECT)
        self.assertEqual(self.requests[-1][1].path, BASE)
        self.assertEqual(self.requests[-1][3], KEY)
        listing = self.assert_ok(self.call("debt", "list", "--project", PROJECT, "--q", "导出 & 回归"))
        self.assertEqual(listing["items"][0]["id"], "D-0001")
        self.assertEqual(self.requests[-1][1].path, BASE + "/debts")
        self.assertEqual(parse_qs(self.requests[-1][1].query)["q"], ["导出 & 回归"])
        detail = self.assert_ok(self.call("debt", "show", "D-0001", "--project", PROJECT))
        self.assertEqual(detail["debt"]["id"], "D-0001")
        self.assertEqual(self.requests[-1][1].path, BASE + "/debts/D-0001")

    def test_reads_checkup_for_the_bound_project(self):
        result = self.assert_ok(self.call("debt", "checkup"))
        self.assertEqual(result["summary"]["closed"], 3)
        self.assertEqual(self.requests[-1][1].path, BASE + "/checkup")

    def test_reads_same_handoff_in_machine_and_human_output(self):
        args = ("debt", "brief", "D-0001", "--project", PROJECT)
        self.assertEqual(self.assert_ok(self.call(*args)), BRIEF)
        self.assertEqual(self.requests[-1][0], "GET")
        self.assertEqual(self.requests[-1][1].path, BASE + "/debts/D-0001")
        self.assertEqual(self.requests[-1][3], KEY)
        process, _ = self.call("--human", *args)
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(process.stdout.rstrip("\n"), BRIEF["markdown"])
        self.assertNotIn(KEY, process.stdout + process.stderr)

    def test_missing_handoff_reports_old_server_without_breaking_show(self):
        self.expose_brief = False
        outcome = self.call("debt", "brief", "D-0001", "--project", PROJECT)
        self.assert_error(outcome)
        self.assertRegex(outcome[1]["error"], "接手卡|brief")
        self.assertRegex(outcome[1]["error"], "升级|更新|旧版|不支持|未提供")
        detail = self.assert_ok(self.call("debt", "show", "D-0001", "--project", PROJECT))
        self.assertNotIn("brief", detail)

    def test_handoff_refuses_other_projects_and_missing_read_access(self):
        self.assert_error(self.call("debt", "brief", "D-0001", "--project", "other-project"))
        self.assertEqual(self.requests, [])
        self.permissions.remove("read")
        outcome = self.call("debt", "brief", "D-0001", "--project", PROJECT)
        self.assert_error(outcome)
        self.assertNotIn(BRIEF["markdown"], outcome[0].stdout + outcome[0].stderr)
        self.assertTrue(self.requests)
        self.assertTrue(all(method == "GET" for method, *_rest in self.requests))

    def test_rejects_other_project_and_file_overrides_before_writing(self):
        self.assert_error(self.call("planning", "show", "--project", "other-project"))
        self.assertEqual(self.requests, [])
        self.assert_error(self.submit({**PROPOSAL, "projectId": "other-project"}))
        self.assert_error(self.submit({**PROPOSAL, "host": "https://other.example.invalid"}))
        self.assertFalse(any(method == "POST" for method, *_rest in self.requests))

    def test_rejects_foreign_resource_in_success_response(self):
        self.foreign = True
        self.assert_error(self.call("debt", "list", "--project", PROJECT))
        self.assert_error(self.call("debt", "show", "D-0001", "--project", PROJECT))
        self.assert_error(self.call("debt", "brief", "D-0001", "--project", PROJECT))
        self.assert_error(self.submit(PROPOSAL))

    def test_planning_submit_accepts_a_human_identity_without_falling_back_to_the_key(self):
        outcome = self.call('planning', 'submit', '--file', '-', '--as-user', 'fixture-member')
        self.assert_error(outcome)
        self.assertIn('需要交互终端', outcome[0].stdout)
        self.assertEqual(self.requests, [])

    def test_submission_reports_original_receipt_when_repeated(self):
        first = self.assert_ok(self.submit(PROPOSAL))
        self.assertEqual(self.requests[-1][1].path, BASE + "/commands")
        self.assertEqual(self.requests[-1][2], PROPOSAL)
        self.assertFalse(first["reused"])
        again = self.assert_ok(self.submit(PROPOSAL))
        self.assertTrue(again["reused"])
        self.assertEqual(again["result"]["id"], first["result"]["id"])
        self.assertEqual(len(self.committed), 1)
        self.assert_error(self.submit({**PROPOSAL, "draft": {"title": "不同的提案"}}))

    def test_proposal_create_preserves_metadata_source_and_stable_retry(self):
        arguments = ("proposal", "create", "--kind", "debt", "--title", "补齐导出测试", "--summary", "已确认延后",
                     "--trigger", "ci", "--ref", "ci:pr-42:e2e:export", "--url", "https://example.com/42",
                     "--excerpt", "仅导出场景失败", "--skill", "cds-qa", "--confidence", "0.88",
                     "--decision", "ADR-1", "--priority", "low", "--criterion", "导出用例稳定通过")
        first = self.assert_ok(self.call(*arguments))
        request = self.requests[-1][2]
        self.assertEqual(request, {
            "type": "proposal.submit", "requestId": request["requestId"], "kind": "debt",
            "draft": {"title": "补齐导出测试", "summary": "已确认延后", "decisionId": "ADR-1", "priority": "low",
                      "criteria": ["导出用例稳定通过"]},
            "source": {"type": "test", "ref": "ci:pr-42:e2e:export", "url": "https://example.com/42", "excerpt": "仅导出场景失败"},
            "skill": "cds-qa", "confidence": 0.88,
        })
        retried = self.assert_ok(self.call(*arguments))
        self.assertTrue(retried["reused"])
        self.assertEqual(retried["result"]["id"], first["result"]["id"])

    def test_adr_proposal_links_the_document_and_pull_request(self):
        self.assert_ok(self.call("proposal", "create", "--kind", "decision", "--title", "采用导出任务", "--trigger", "adr-file",
                                 "--ref", "docs/adr/001-export.md@fixture", "--url", "https://example.com/adr.md",
                                 "--pr-url", "https://github.com/org/repo/pull/42", "--target", "/reports?mode=export",
                                 "--target-label", "报表导出"))
        body = self.requests[-1][2]
        self.assertEqual(body["source"]["type"], "adr")
        self.assertEqual(body["draft"]["links"], [{
            "type": "adr", "title": "docs/adr/001-export.md@fixture", "url": "https://example.com/adr.md",
        }])
        self.assertEqual(body["draft"]["pullRequest"], {
            "url": "https://github.com/org/repo/pull/42", "target": {"path": "/reports?mode=export", "label": "报表导出"},
        })

    def test_proposes_revision_or_adoption_for_the_current_decision_version(self):
        for change in ("amended", "accepted"):
            self.assert_ok(self.call("proposal", "create", "--kind", "decision", "--title", "采用异步导出",
                                     "--trigger", "adr-file", "--ref", f"docs/adr/export.md@fixture:{change}",
                                     "--decision", "ADR-1", "--expected-version", "2", "--change", change))
            body = self.requests[-1][2]
            self.assertEqual(body["type"], "proposal.submit")
            self.assertEqual(body["decisionChange"], {"decisionId": "ADR-1", "expectedVersion": 2, "change": change})
            self.assertNotIn("decisionId", body["draft"])

    def test_debt_module_is_supported_in_lists_direct_writes_and_proposals(self):
        module = "导出与报表"
        self.assert_ok(self.call("debt", "list", "--module", module))
        self.assertEqual(parse_qs(self.requests[-1][1].query)["module"], [module])
        self.assert_ok(self.call("debt", "create", "--title", "补齐导出测试", "--source-ref", "fixture:module",
                                 "--request-id", "fixture-debt-module", "--module", module))
        self.assertEqual(self.requests[-1][2]["module"], module)
        self.assert_ok(self.call("proposal", "create", "--kind", "debt", "--title", "补齐导出测试", "--trigger", "review",
                                 "--ref", "fixture:module", "--module", module))
        self.assertEqual(self.requests[-1][2]["draft"]["module"], module)

    def test_debt_duplicate_override_requires_reason_and_can_replay_original_candidates(self):
        candidate = {"id": "D-0001", "title": "报表导出重复网络请求", "status": "open", "similarity": 0.96}
        self.candidates = [candidate]
        title = "报表导出重复网络请求！"
        args = ("debt", "create", "--title", title, "--request-id", "fixture-duplicate", "--source-ref", "review:duplicate")
        refusal = self.call(*args)
        self.assert_error(refusal)
        self.assertEqual(refusal[1]["errorCode"], "possible_duplicate")
        self.assertEqual(refusal[1]["candidates"], [candidate])
        self.assertEqual(self.assert_ok(self.call("debt", "duplicates", "--title", title))["items"], [candidate])

        count = len(self.requests)
        self.assert_error(self.call(*args, "--allow-duplicate"))
        self.assertEqual(len(self.requests), count)
        self.drop_write_response = True
        flags = ("--allow-duplicate", "--reason", "独立接口使用不同队列")
        lost = self.call(*args, *flags)
        self.assert_error(lost)
        self.assertEqual(lost[1]["retry"], {"requestId": "fixture-duplicate", "duplicateIds": ["D-0001"]})
        self.assertEqual([request[0] for request in self.requests[count:]], ["GET", "POST"])
        self.assertEqual(self.requests[-1][2]["distinction"], {"debtIds": ["D-0001"], "reason": "独立接口使用不同队列"})

        self.candidates.append({"id": "D-0002", "title": title, "status": "open", "similarity": 1})
        returned = self.assert_ok(self.call(*args, *flags, "--duplicate-id", "D-0001"))
        self.assertTrue(returned["reused"])
        self.assertEqual(self.requests[-2][2], self.requests[-1][2])
        self.assertEqual(len(self.committed), 1)

    def test_reads_scoped_proposals_decisions_and_pull_requests(self):
        proposed = self.assert_ok(self.call("proposal", "list"))
        self.assertEqual([item["id"] for item in proposed["items"]], ["P-0001"])
        accepted = self.assert_ok(self.call("proposal", "list", "--status", "accepted"))
        self.assertEqual([item["id"] for item in accepted["items"]], ["P-0002"])
        self.assertEqual(len(self.assert_ok(self.call("proposal", "list", "--status", "all"))["items"]), 2)
        decision = self.assert_ok(self.call("decision", "show", "ADR-1"))["decision"]
        self.assertEqual(decision["title"], "采用导出任务")
        pulls = self.assert_ok(self.call("pr", "list", "--decision", "ADR-1"))["items"]
        self.assertEqual([pull["number"] for pull in pulls], [42])
        self.assertEqual(self.assert_ok(self.call("pr", "show", "43"))["number"], 43)
        self.assertTrue(all(request[0] == "GET" for request in self.requests))
        self.foreign = True
        self.assert_error(self.call("proposal", "list"))
        self.assert_error(self.call("pr", "show", "43"))

    def test_response_loss_has_error_receipt_and_same_key_can_be_retried(self):
        self.drop_write_response = True
        self.assert_error(self.submit(PROPOSAL))
        self.assertEqual(len([call for call in self.requests if call[0] == "POST"]), 1)
        receipt = self.assert_ok(self.submit(PROPOSAL))
        self.assertTrue(receipt["reused"])
        self.assertEqual(receipt["result"]["id"], "P-0001")
        self.assertEqual(len(self.committed), 1)

    def test_denied_write_does_not_echo_upstream_details(self):
        self.reject_write = True
        self.assert_error(self.submit(PROPOSAL))
        self.assertFalse(self.committed)


if __name__ == "__main__":
    unittest.main()
