"""cdscli deploy 触发失败时必须透出服务端 body 里的结构化原因。

issue #1433:项目被暂停时,`POST .../deploy` 返回 423,body 里其实带着
`error: "project_paused"` 与一句可执行的中文 message("已暂停...不建议重试")。
旧实现只报裸 `http_423`,Agent 拿到之后只能瞎猜是不是排队锁,空转重试。
这里锁死:`branch deploy` 与顶层 `deploy` 两个入口在触发失败时都必须把
body 里的 message 透出来,而不是把它扔在地上换成一个无意义的状态码。
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

PAUSED_BODY = {
    "error": "project_paused",
    "message": "项目「prd-agent」已暂停，部署被拦截。请先在项目列表恢复该项目，或附加 ?force=1 强制部署一次。",
    "pausedAt": "2026-08-28T08:00:00.000Z",
    "escapeHatch": {"hint": "附加 ?force=1 query 可绕过暂停强制部署一次（不推荐）。"},
}


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


def test_describe_trigger_failure_prefers_body_message_over_bare_status():
    trigger = {"status": 423, "error": "http_423", "body": PAUSED_BODY}

    reason = cdscli._describe_trigger_failure(trigger)

    assert reason == f"project_paused: {PAUSED_BODY['message']}"
    assert "已暂停" in reason


def test_describe_trigger_failure_falls_back_to_bare_status_without_body():
    trigger = {"status": 500, "error": "http_500", "body": None}

    assert cdscli._describe_trigger_failure(trigger) == "http_500"


def test_branch_deploy_surfaces_paused_project_message(monkeypatch):
    monkeypatch.setattr(cdscli, "_check_blocking_pending_import", lambda _branch_id: None)
    monkeypatch.setattr(cdscli.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(cdscli, "_request_stream_safe", lambda *args, **kwargs: {
        "triggered": True,
        "status": 423,
        "body": PAUSED_BODY,
        "partial": False,
        "error": "http_423",
        "errorType": "HTTPError",
        "headers": {},
    })

    code, payload = call_main(["branch", "deploy", "branch-1", "--timeout", "30"])

    assert code == 2
    assert "已暂停" in payload["error"]
    assert "http_423" not in payload["error"]
    assert payload["data"]["stage"] == "deploy_trigger_failed"


def test_top_level_deploy_surfaces_paused_project_message(monkeypatch):
    monkeypatch.setattr(subprocess, "check_output",
                         lambda args, text=False: "codex/some-branch\n")
    monkeypatch.setattr(subprocess, "run",
                         lambda args, capture_output=False, text=False:
                         subprocess.CompletedProcess(args, 0, "", ""))

    def fake_call(method, path, body=None, timeout=15, quiet=False):
        if method == "GET" and path == "/api/branches":
            return {
                "branches": [
                    {
                        "id": "prd-agent-codex-some-branch",
                        "projectId": "prd-agent",
                        "branch": "codex/some-branch",
                        "status": "running",
                    }
                ]
            }
        if method == "POST" and path == "/api/branches/prd-agent-codex-some-branch/pull":
            return {"ok": True}
        raise AssertionError(f"unexpected _call: {method} {path}")

    monkeypatch.setattr(cdscli, "_call", fake_call)
    monkeypatch.setattr(cdscli, "_request_stream_safe", lambda *args, **kwargs: {
        "triggered": True,
        "status": 423,
        "body": PAUSED_BODY,
        "partial": False,
        "error": "http_423",
        "errorType": "HTTPError",
        "headers": {},
    })

    code, payload = call_main(["deploy", "--no-smoke", "--timeout", "1"])

    assert code == 2
    assert "已暂停" in payload["error"]
    assert "http_423" not in payload["error"]
