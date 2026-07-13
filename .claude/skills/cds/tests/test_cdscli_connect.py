"""CDS 安全接入：页面批准、项目凭据与密钥不出 stdout。"""

import io
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "cli"))

import cdscli  # noqa: E402


@pytest.fixture()
def workspace(tmp_path, monkeypatch):
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    monkeypatch.chdir(tmp_path)
    for key in ("CDS_HOST", "CDS_PROJECT_ID", "CDS_PROJECT_KEY", "AI_ACCESS_KEY"):
        monkeypatch.delenv(key, raising=False)
    cdscli._TRACE_ID = "testtrace"
    cdscli._HUMAN = False
    return tmp_path


def run_command(argv: list[str]) -> tuple[int, str]:
    buf = io.StringIO()
    real_stdout = sys.stdout
    sys.stdout = buf
    code = 0
    try:
        cdscli.main(argv)
    except SystemExit as exc:
        code = exc.code if isinstance(exc.code, int) else 1
    finally:
        sys.stdout = real_stdout
    return code, buf.getvalue()


def test_connect_existing_project_saves_local_credential_without_printing_secret(workspace, monkeypatch):
    secret = "cdsp_demo_secret-never-print"
    calls: list[tuple[str, str]] = []

    def fake_request(method, path, body=None, timeout=15, extra_headers=None):
        calls.append((method, path))
        if method == "POST":
            return 201, {"requestId": "req1", "pollToken": "poll1", "status": "pending"}, {}
        if path.endswith("/req1"):
            assert extra_headers == {"X-Poll-Token": "poll1"}
            return 200, {"status": "approved", "authorizationKey": secret}, {}
        return 200, {"id": "proj-a"}, {}

    monkeypatch.setattr(cdscli, "_request", fake_request)
    monkeypatch.setattr(cdscli.time, "sleep", lambda _seconds: None)

    code, output = run_command([
        "connect", "--host", "https://cds.example", "--project", "proj-a",
        "--agent", "Codex", "--interval", "1",
    ])

    assert code == 0
    assert secret not in output
    saved = json.loads((workspace / ".cds" / "credentials.json").read_text())
    assert saved == {
        "version": 1,
        "host": "https://cds.example",
        "projectId": "proj-a",
        "projectKey": secret,
    }
    assert oct((workspace / ".cds" / "credentials.json").stat().st_mode & 0o777) == "0o600"
    exclude = (workspace / ".git" / "info" / "exclude").read_text()
    assert "/.cds/credentials.json" in exclude
    assert calls == [
        ("POST", "/api/projects/proj-a/access-requests"),
        ("GET", "/api/projects/proj-a/access-requests/req1"),
        ("GET", "/api/projects/proj-a"),
    ]


def test_connect_new_project_uses_bootstrap_request(workspace, monkeypatch):
    secret = "cdsg_bootstrap-secret"

    def fake_request(method, path, body=None, timeout=15, extra_headers=None):
        if method == "POST":
            assert path == "/api/bootstrap-access-requests"
            return 201, {"requestId": "req2", "pollToken": "poll2"}, {}
        if path == "/api/bootstrap-access-requests/req2":
            return 200, {"status": "approved", "authorizationKey": secret}, {}
        assert path == "/api/projects"
        return 200, {"projects": []}, {}

    monkeypatch.setattr(cdscli, "_request", fake_request)
    monkeypatch.setattr(cdscli.time, "sleep", lambda _seconds: None)
    code, output = run_command([
        "connect", "--host", "cds.example", "--new-project", "--agent", "Cursor",
    ])

    assert code == 0
    assert secret not in output
    saved = json.loads((workspace / ".cds" / "credentials.json").read_text())
    assert saved["bootstrapKey"] == secret
    assert "projectKey" not in saved


def test_rejected_connect_does_not_write_credentials(workspace, monkeypatch):
    def fake_request(method, path, body=None, timeout=15, extra_headers=None):
        if method == "POST":
            return 201, {"requestId": "req3", "pollToken": "poll3"}, {}
        return 200, {"status": "rejected", "rejectReason": "测试拒绝"}, {}

    monkeypatch.setattr(cdscli, "_request", fake_request)
    monkeypatch.setattr(cdscli.time, "sleep", lambda _seconds: None)
    code, output = run_command([
        "connect", "--host", "cds.example", "--project", "proj-a",
    ])

    assert code == 2
    assert "测试拒绝" in output
    assert not (workspace / ".cds" / "credentials.json").exists()


def test_project_create_switches_from_bootstrap_to_project_key(workspace, monkeypatch):
    bootstrap = "cdsg_one-time"
    project_key = "cdsp_new-project"
    cdscli._save_local_credentials(host="https://cds.example", bootstrap_key=bootstrap)
    os.environ["CDS_HOST"] = "https://cds.example"
    os.environ["AI_ACCESS_KEY"] = bootstrap
    monkeypatch.setattr(cdscli, "_call", lambda *args, **kwargs: {
        "project": {"id": "proj-new", "slug": "new", "name": "New"},
        "issuedProjectKey": {"keyId": "k1", "plaintext": project_key},
    })

    code, output = run_command(["project", "create", "--name", "New"])

    assert code == 0
    assert project_key not in output
    saved = json.loads((workspace / ".cds" / "credentials.json").read_text())
    assert saved["projectId"] == "proj-new"
    assert saved["projectKey"] == project_key
    assert "bootstrapKey" not in saved
