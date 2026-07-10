"""DeploymentRun CLI consumer tests."""

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
    monkeypatch.delenv("CDS_PROJECT_KEY", raising=False)
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


def test_branch_deploy_follows_returned_run_id(monkeypatch):
    calls: list[tuple[str, str]] = []

    monkeypatch.setattr(cdscli, "_check_blocking_pending_import", lambda _branch_id: None)
    monkeypatch.setattr(cdscli.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(cdscli, "_request_stream_safe", lambda *args, **kwargs: {
        "triggered": True,
        "status": 200,
        "body": "event: deployment-run",
        "partial": False,
        "error": None,
        "errorType": None,
        "headers": {"X-Cds-Deployment-Run-Id": "dr_test"},
    })

    def fake_call(method, path, body=None, timeout=15, quiet=False):
        calls.append((method, path))
        assert path == "/api/deployment-runs/dr_test"
        return {
            "run": {
                "id": "dr_test",
                "branchId": "branch-1",
                "status": "running",
                "phase": "complete",
                "commitSha": "abc1234",
                "events": [{"seq": 1}],
            }
        }

    monkeypatch.setattr(cdscli, "_call", fake_call)

    code, payload = call_main(["branch", "deploy", "branch-1", "--timeout", "30"])

    assert code == 0
    assert calls == [("GET", "/api/deployment-runs/dr_test")]
    assert payload["data"]["deploymentRunId"] == "dr_test"
    assert payload["data"]["deploymentRunStatus"] == "running"
    assert payload["data"]["stage"] == "deployed"


def test_branch_deploy_surfaces_structured_run_failure(monkeypatch):
    monkeypatch.setattr(cdscli, "_check_blocking_pending_import", lambda _branch_id: None)
    monkeypatch.setattr(cdscli.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(cdscli, "_request_stream_safe", lambda *args, **kwargs: {
        "triggered": True,
        "status": 200,
        "body": None,
        "partial": False,
        "error": None,
        "errorType": None,
        "headers": {"x-cds-deployment-run-id": "dr_failed"},
    })
    monkeypatch.setattr(cdscli, "_call", lambda *args, **kwargs: {
        "run": {
            "id": "dr_failed",
            "branchId": "branch-1",
            "status": "failed",
            "phase": "ready",
            "events": [],
            "failure": {"summary": "服务端口未就绪", "owner": "code", "retryable": False},
        }
    })

    code, payload = call_main(["branch", "deploy", "branch-1", "--timeout", "30"])

    assert code == 2
    assert "服务端口未就绪" in payload["error"]
    assert payload["data"]["deploymentRunId"] == "dr_failed"
    assert payload["data"]["failure"]["owner"] == "code"


def test_deployment_run_list_builds_scoped_query(monkeypatch):
    captured: dict[str, object] = {}

    def fake_call(method, path, body=None, timeout=15, quiet=False):
        captured.update(method=method, path=path)
        return {"runs": [{"id": "dr_1", "status": "failed"}], "total": 1}

    monkeypatch.setattr(cdscli, "_call", fake_call)

    code, payload = call_main([
        "deployment-run", "list",
        "--project", "p1",
        "--branch", "b1",
        "--status", "failed",
        "--limit", "5",
    ])

    assert code == 0
    assert captured["method"] == "GET"
    assert captured["path"] == "/api/deployment-runs?project=p1&branch=b1&status=failed&limit=5"
    assert payload["data"]["total"] == 1


def test_deployment_run_diagnose_reads_structured_facts(monkeypatch):
    captured = {}

    def fake_call(method, path, body=None, timeout=15, quiet=False):
        captured.update(method=method, path=path)
        return {"diagnosis": {"runId": "dr_1", "failure": {"code": "build.compile.typescript"}}}

    monkeypatch.setattr(cdscli, "_call", fake_call)
    code, payload = call_main(["deployment-run", "diagnose", "dr_1"])

    assert code == 0
    assert captured == {"method": "GET", "path": "/api/deployment-runs/dr_1/diagnosis"}
    assert payload["data"]["diagnosis"]["failure"]["code"] == "build.compile.typescript"


def test_deployment_run_diagnose_ai_consumes_complete_sse_event(monkeypatch):
    monkeypatch.setattr(cdscli, "_request", lambda *args, **kwargs: (
        200,
        "event: facts-ready\ndata: {\"runId\":\"dr_1\"}\n\n"
        "event: ai-stage\ndata: {\"stage\":\"explaining\"}\n\n"
        "event: complete\ndata: {\"runId\":\"dr_1\",\"ai\":{\"status\":\"ready\",\"explanation\":{\"summary\":\"类型错误\",\"actions\":[]}}}\n\n",
        {},
    ))

    code, payload = call_main(["deployment-run", "diagnose", "dr_1", "--ai"])

    assert code == 0
    assert payload["data"]["diagnosis"]["ai"]["explanation"]["summary"] == "类型错误"
