"""DeploymentVersion CLI consumer tests."""

import io
import json
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
    cdscli._TRACE_ID = "testtrace"
    cdscli._HUMAN = False
    yield


def call_main(argv: list[str]) -> tuple[int, dict]:
    output = io.StringIO()
    code = 0
    previous = sys.stdout
    sys.stdout = output
    try:
        cdscli.main(argv)
    except SystemExit as exc:
        code = exc.code if isinstance(exc.code, int) else 1
    finally:
        sys.stdout = previous
    return code, json.loads(output.getvalue().strip().split("\n")[-1])


def test_deployment_version_list_builds_scoped_query(monkeypatch):
    captured = {}

    def fake_call(method, path, body=None, timeout=15, quiet=False):
        captured.update(method=method, path=path)
        return {"versions": [{"id": "dv_1", "commitSha": "abc1234", "profiles": []}], "total": 1}

    monkeypatch.setattr(cdscli, "_call", fake_call)
    code, payload = call_main([
        "deployment-version", "list", "--project", "p1", "--branch", "b1", "--commit", "abc1234",
    ])

    assert code == 0
    assert captured == {
        "method": "GET",
        "path": "/api/deployment-versions?project=p1&branch=b1&commit=abc1234",
    }
    assert payload["data"]["total"] == 1


def test_deployment_version_deploy_submits_version(monkeypatch):
    captured = {}

    def fake_call(method, path, body=None, timeout=15, quiet=False):
        captured.update(method=method, path=path, body=body)
        return {"accepted": True, "versionId": "dv_1", "runId": "dr_1"}

    monkeypatch.setattr(cdscli, "_call", fake_call)
    code, payload = call_main(["deployment-version", "deploy", "dv_1"])

    assert code == 0
    assert captured == {
        "method": "POST",
        "path": "/api/deployment-versions/dv_1/deploy",
        "body": {},
    }
    assert payload["data"]["runId"] == "dr_1"


def test_branch_rollback_submits_explicit_version(monkeypatch):
    captured = {}

    def fake_call(method, path, body=None, timeout=15, quiet=False):
        captured.update(method=method, path=path, body=body)
        return {"accepted": True, "rollback": True, "versionId": "dv_old", "runId": "dr_2"}

    monkeypatch.setattr(cdscli, "_call", fake_call)
    code, payload = call_main(["branch", "rollback", "b1", "--version", "dv_old"])

    assert code == 0
    assert captured == {
        "method": "POST",
        "path": "/api/branches/b1/rollback",
        "body": {"versionId": "dv_old"},
    }
    assert payload["data"]["rollback"] is True
