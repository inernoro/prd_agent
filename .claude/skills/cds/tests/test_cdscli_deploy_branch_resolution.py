"""cdscli deploy branch id resolution tests.

`cdscli deploy` starts from the current git branch, but CDS branch ids may be
prefixed with the project id. These tests keep that deployment hot path from
falling back to a slash-to-dash guess that points at a nonexistent branch.
"""
import io
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
CLI_DIR = ROOT / "cli"
sys.path.insert(0, str(CLI_DIR))

import cdscli  # noqa: E402


@pytest.fixture(autouse=True)
def reset_globals(monkeypatch):
    monkeypatch.setenv("CDS_HOST", "cds.test.example")
    monkeypatch.setenv("AI_ACCESS_KEY", "test-key-not-real")
    monkeypatch.delenv("CDS_PROJECT_ID", raising=False)
    monkeypatch.delenv("CDS_PROJECT_KEY", raising=False)
    cdscli._TRACE_ID = "testtrace"
    cdscli._HUMAN = False
    yield


def call_main(argv: list[str]) -> tuple[int, str]:
    buf = io.StringIO()
    code = 0
    real_stdout = sys.stdout
    sys.stdout = buf
    try:
        cdscli.main(argv)
    except SystemExit as e:
        code = e.code if isinstance(e.code, int) else 1
    finally:
        sys.stdout = real_stdout
    return code, buf.getvalue()


def parse_json(out: str) -> dict:
    return json.loads(out.strip().split("\n")[-1])


def test_resolve_deploy_branch_id_matches_cds_branch_field(monkeypatch):
    def fake_call(method, path, body=None, timeout=15, quiet=False):
        assert method == "GET"
        assert path == "/api/branches"
        return {
            "branches": [
                {
                    "id": "prd-agent-codex-cds-agent-workbench-ui",
                    "projectId": "prd-agent",
                    "branch": "codex/cds-agent-workbench-ui",
                }
            ]
        }

    monkeypatch.setattr(cdscli, "_call", fake_call)

    branch_id = cdscli._resolve_deploy_branch_id("codex/cds-agent-workbench-ui")

    assert branch_id == "prd-agent-codex-cds-agent-workbench-ui"


def test_resolve_deploy_branch_id_uses_project_id_to_disambiguate(monkeypatch):
    monkeypatch.setenv("CDS_PROJECT_ID", "prd-agent")

    def fake_call(method, path, body=None, timeout=15, quiet=False):
        return {
            "branches": [
                {
                    "id": "other-codex-cds-agent-workbench-ui",
                    "projectId": "other",
                    "branch": "codex/cds-agent-workbench-ui",
                },
                {
                    "id": "prd-agent-codex-cds-agent-workbench-ui",
                    "projectId": "prd-agent",
                    "branch": "codex/cds-agent-workbench-ui",
                },
            ]
        }

    monkeypatch.setattr(cdscli, "_call", fake_call)

    branch_id = cdscli._resolve_deploy_branch_id("codex/cds-agent-workbench-ui")

    assert branch_id == "prd-agent-codex-cds-agent-workbench-ui"


def test_deploy_uses_resolved_cds_branch_id_for_pull_deploy_and_status(monkeypatch):
    calls: list[tuple] = []

    def fake_check_output(args, text=False):
        assert args == ["git", "branch", "--show-current"]
        return "codex/cds-agent-workbench-ui\n"

    def fake_run(args, capture_output=False, text=False):
        calls.append(("subprocess.run", tuple(args)))
        return subprocess.CompletedProcess(args, 0, "", "")

    def fake_call(method, path, body=None, timeout=15, quiet=False):
        calls.append(("_call", method, path, timeout, quiet))
        if method == "GET" and path == "/api/branches":
            return {
                "branches": [
                    {
                        "id": "prd-agent-codex-cds-agent-workbench-ui",
                        "projectId": "prd-agent",
                        "branch": "codex/cds-agent-workbench-ui",
                        "status": "running",
                    }
                ]
            }
        if method == "POST" and path == "/api/branches/prd-agent-codex-cds-agent-workbench-ui/pull":
            return {"ok": True}
        raise AssertionError(f"unexpected _call: {method} {path}")

    def fake_request(method, path, body=None, timeout=15, extra_headers=None):
        calls.append(("_request", method, path, timeout))
        assert method == "POST"
        assert path == "/api/branches/prd-agent-codex-cds-agent-workbench-ui/deploy"
        return 202, {"accepted": True}, {}

    monkeypatch.setattr(subprocess, "check_output", fake_check_output)
    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr(cdscli, "_call", fake_call)
    monkeypatch.setattr(cdscli, "_request", fake_request)
    monkeypatch.setattr(cdscli.time, "sleep", lambda _: None)

    code, out = call_main(["deploy", "--no-smoke", "--timeout", "1"])

    assert code == 0, out
    payload = parse_json(out)
    assert payload["data"]["branch"] == "codex/cds-agent-workbench-ui"
    assert payload["data"]["branchId"] == "prd-agent-codex-cds-agent-workbench-ui"
    assert ("subprocess.run", ("git", "push", "-u", "origin", "codex/cds-agent-workbench-ui")) in calls
    assert ("_call", "POST", "/api/branches/prd-agent-codex-cds-agent-workbench-ui/pull", 60, False) in calls
    assert ("_request", "POST", "/api/branches/prd-agent-codex-cds-agent-workbench-ui/deploy", 5) in calls

