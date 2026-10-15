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
    calls: list[tuple[str, str, int]] = []

    def fake_request(method, path, body=None, timeout=15, extra_headers=None,
                     fatal_network_errors=True):
        calls.append((method, path, timeout))
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
        ("POST", "/api/projects/proj-a/access-requests", 30),
        ("GET", "/api/projects/proj-a/access-requests/req1", 10),
        ("GET", "/api/projects/proj-a", 10),
    ]


def test_connect_slug_saves_resolved_project_id(workspace, monkeypatch):
    secret = "cdsp_resolved_secret-never-print"
    calls: list[tuple[str, str]] = []

    def fake_request(method, path, body=None, timeout=15, extra_headers=None,
                     fatal_network_errors=True):
        calls.append((method, path))
        if method == "POST":
            return 201, {
                "requestId": "req-slug",
                "pollToken": "poll-slug",
                "status": "pending",
                "projectId": "project-real-id",
            }, {}
        if path.endswith("/req-slug"):
            return 200, {"status": "approved", "authorizationKey": secret}, {}
        return 200, {"id": "project-real-id"}, {}

    monkeypatch.setattr(cdscli, "_request", fake_request)
    monkeypatch.setattr(cdscli.time, "sleep", lambda _seconds: None)

    code, output = run_command([
        "connect", "--host", "https://cds.example", "--project", "project-slug",
        "--agent", "Codex", "--interval", "1",
    ])

    assert code == 0
    assert secret not in output
    saved = json.loads((workspace / ".cds" / "credentials.json").read_text())
    assert saved["projectId"] == "project-real-id"
    assert calls == [
        ("POST", "/api/projects/project-slug/access-requests"),
        ("GET", "/api/projects/project-slug/access-requests/req-slug"),
        ("GET", "/api/projects/project-real-id"),
    ]


def test_connect_new_project_infers_origin_and_creates_once(workspace, monkeypatch):
    subprocess.run(["git", "remote", "add", "origin", "git@github.com:example/demo.git"], check=True)
    def fake_request(method, path, body=None, **kwargs):
        if method == "POST" and path == "/api/bootstrap-access-requests":
            assert body["requestedProject"] == {"name": "demo", "repository": "git@github.com:example/demo.git"}
            return 201, {"requestId": "r", "pollToken": "poll"}, {}
        if path == "/api/bootstrap-access-requests/r":
            return 200, {"status": "approved", "authorizationKey": "cdsg_secret"}, {}
        if method == "POST" and path == "/api/projects":
            assert body["gitRepoUrl"] == "git@github.com:example/demo.git"
            return 201, {"project": {"id": "proj-demo"}, "issuedProjectKey": {"plaintext": "cdsp_secret"}}, {}
        return 200, {"id": "proj-demo"}, {}
    monkeypatch.setattr(cdscli, "_request", fake_request)
    code, output = run_command(["connect", "--host", "cds.example", "--new-project", "--create-project", "demo"])
    assert code == 0, output
    saved = json.loads((workspace / ".cds/credentials.json").read_text())
    assert saved["projectKey"] == "cdsp_secret" and "bootstrapKey" not in saved
    assert "cdsp_secret" not in output and "cdsg_secret" not in output


@pytest.mark.parametrize("loss", [True, False])
def test_same_new_project_command_recovers_original_project(workspace, monkeypatch, loss):
    subprocess.run(["git", "remote", "add", "origin", "https://github.com/example/demo.git"], check=True)
    cdscli._save_local_credentials(host="https://cds.example", project_id="proj-demo", project_key="cdsp_old")
    if loss:
        (workspace / ".cds/credentials.json").unlink()
    calls = []
    monkeypatch.setattr(cdscli, "_load_user_credential", lambda host: "")
    def fake_request(method, path, body=None, extra_headers=None, **kwargs):
        calls.append((method, path))
        if path == "/api/projects/proj-demo" and extra_headers:
            return 401, {"error": "unauthorized"}, {}
        if method == "POST":
            assert path == "/api/projects/proj-demo/access-requests"
            return 201, {"requestId": "r", "pollToken": "poll", "projectId": "proj-demo"}, {}
        if path.endswith("/access-requests/r"):
            return 200, {"status": "approved", "authorizationKey": "cdsp_new"}, {}
        return 200, {"id": "proj-demo"}, {}
    monkeypatch.setattr(cdscli, "_request", fake_request)
    code, output = run_command(["connect", "--host", "cds.example", "--new-project", "--create-project", "demo"])
    assert code == 0, output
    assert all(path != "/api/projects" and "bootstrap" not in path for _, path in calls)
    assert json.loads((workspace / ".cds/credentials.json").read_text())["projectKey"] == "cdsp_new"
    assert "cdsp_old" not in output and "cdsp_new" not in output
    assert oct((workspace / ".cds/credentials.json").stat().st_mode & 0o777) == "0o600"


def test_valid_connect_is_reused_and_network_failure_never_creates_request(workspace, monkeypatch):
    cdscli._save_local_credentials(host="https://cds.example", project_id="p", project_key="cdsp_valid")
    for status in [200, 503]:
        calls = []
        def fake_request(method, path, **kwargs):
            calls.append((method, path))
            return status, {"id": "p"}, {}
        monkeypatch.setattr(cdscli, "_request", fake_request)
        code, output = run_command(["connect", "--host", "cds.example", "--project", "p"])
        assert code == (0 if status == 200 else 2)
        assert calls == [("GET", "/api/projects/p")]
        assert "cdsp_valid" not in output


def test_rejected_connect_does_not_write_credentials(workspace, monkeypatch):
    def fake_request(method, path, body=None, timeout=15, extra_headers=None,
                     fatal_network_errors=True):
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


def test_connect_keeps_waiting_after_transient_poll_timeout(workspace, monkeypatch):
    secret = "cdsp_after-timeout"
    poll_count = 0

    def fake_request(method, path, body=None, timeout=15, extra_headers=None,
                     fatal_network_errors=True):
        nonlocal poll_count
        if method == "POST":
            return 201, {"requestId": "req-timeout", "pollToken": "poll-timeout"}, {}
        if path.endswith("/req-timeout"):
            assert fatal_network_errors is False
            poll_count += 1
            if poll_count == 1:
                return 0, {"error": "timeout", "message": "timeout=10s"}, {}
            return 200, {"status": "approved", "authorizationKey": secret}, {}
        return 200, {"id": "proj-a"}, {}

    monkeypatch.setattr(cdscli, "_request", fake_request)
    monkeypatch.setattr(cdscli.time, "sleep", lambda _seconds: None)

    code, output = run_command([
        "connect", "--host", "https://cds.example", "--project", "proj-a",
        "--agent", "Codex", "--interval", "1",
    ])

    assert code == 0
    assert poll_count == 2
    assert secret not in output
    saved = json.loads((workspace / ".cds" / "credentials.json").read_text())
    assert saved["projectKey"] == secret


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
    # 换钥后会用新 key 回读一次项目（自证钥匙真能用），这一跳走 _request。
    monkeypatch.setattr(cdscli, "_request",
                        lambda *args, **kwargs: (200, {"id": "proj-new"}, {}))

    code, output = run_command(["project", "create", "--name", "New"])

    assert code == 0
    assert project_key not in output
    saved = json.loads((workspace / ".cds" / "credentials.json").read_text())
    assert saved["projectId"] == "proj-new"
    assert saved["projectKey"] == project_key
    assert "bootstrapKey" not in saved


def test_auth_inspect_strict_accepts_identical_workspace_and_environment_credentials(workspace, monkeypatch):
    secret = "cdsp_same-project-key"
    cdscli._save_local_credentials(
        host="https://cds.example",
        project_id="proj-a",
        project_key=secret,
    )
    monkeypatch.setenv("CDS_HOST", "cds.example")
    monkeypatch.setenv("CDS_PROJECT_ID", "proj-a")
    monkeypatch.setenv("CDS_PROJECT_KEY", secret)
    monkeypatch.setattr(cdscli, "_EXPLICIT_CREDENTIAL_ENV", {
        "CDS_HOST": "cds.example",
        "CDS_PROJECT_ID": "proj-a",
        "CDS_PROJECT_KEY": secret,
        "AI_ACCESS_KEY": "",
    })

    code, output = run_command(["auth", "inspect", "--strict"])

    assert code == 0, output
    payload = json.loads(output.strip().split("\n")[-1])
    assert payload["data"]["conflicts"] == []
    assert secret not in output


def test_auth_inspect_strict_rejects_different_workspace_and_environment_keys(workspace, monkeypatch):
    cdscli._save_local_credentials(
        host="https://cds.example",
        project_id="proj-a",
        project_key="cdsp_workspace-key",
    )
    monkeypatch.setenv("CDS_HOST", "https://cds.example")
    monkeypatch.setenv("CDS_PROJECT_ID", "proj-a")
    monkeypatch.setenv("CDS_PROJECT_KEY", "cdsp_other-key")
    monkeypatch.setattr(cdscli, "_EXPLICIT_CREDENTIAL_ENV", {
        "CDS_HOST": "https://cds.example",
        "CDS_PROJECT_ID": "proj-a",
        "CDS_PROJECT_KEY": "cdsp_other-key",
        "AI_ACCESS_KEY": "",
    })

    code, output = run_command(["auth", "inspect", "--strict"])

    assert code == 2
    payload = json.loads(output.strip().split("\n")[-1])
    assert payload["credentialSummary"]["conflicts"] == ["projectKeySource"]
    assert "cdsp_workspace-key" not in output
    assert "cdsp_other-key" not in output


def test_declared_origin_does_not_send_embedded_credentials():
    assert cdscli._safe_repository_url("https://user:secret@github.com/acme/demo.git?token=secret#x") == "https://github.com/acme/demo.git"
    assert cdscli._safe_repository_url("git@github.com:acme/demo.git") == "git@github.com:acme/demo.git"


@pytest.mark.parametrize("change", [{"name": "Second"}, {"slug": "second"}, {"repository": "https://github.com/example/second"}])
def test_explicit_different_creation_target_is_not_silently_reused(workspace, monkeypatch, change):
    subprocess.run(["git", "remote", "add", "origin", "https://github.com/example/demo"], check=True)
    cdscli._save_local_credentials(host="https://cds.example", project_id="p", project_key="cdsp_keep",
                                   project_name="Demo", project_slug="demo")
    calls = []
    def request(method, path, body=None, **kwargs):
        calls.append((method, path))
        if path == "/api/bootstrap-access-requests":
            assert body["requestedProject"]["name"] == change.get("name", "Demo")
            return 201, {"requestId": "r", "pollToken": "poll"}, {}
        if path.endswith("/r"):
            return 200, {"status": "rejected", "rejectReason": "fixture"}, {}
        raise AssertionError("新目标不能复用原项目")
    monkeypatch.setattr(cdscli, "_request", request)
    args = ["connect", "--host", "cds.example", "--new-project", "--create-project", change.get("name", "Demo")]
    if change.get("slug"): args += ["--slug", change["slug"]]
    if change.get("repository"): args += ["--git-url", change["repository"]]
    code, output = run_command(args)
    assert code == 2 and "fixture" in output
    assert json.loads((workspace / ".cds/credentials.json").read_text())["projectKey"] == "cdsp_keep"
    assert "cdsp_keep" not in output


def test_legacy_context_name_is_learned_without_new_approval(workspace, monkeypatch):
    subprocess.run(["git", "remote", "add", "origin", "https://github.com/example/demo"], check=True)
    cdscli._save_local_credentials(host="https://cds.example", project_id="p", project_key="cdsp_keep")
    def request(method, path, **kwargs):
        assert method == "GET" and path == "/api/projects/p"
        return 200, {"id": "p", "name": "Demo", "slug": "demo"}, {}
    monkeypatch.setattr(cdscli, "_request", request)
    code, output = run_command(["connect", "--host", "cds.example", "--new-project", "--create-project", "Demo"])
    assert code == 0, output
    assert json.loads((workspace / ".cds/connection.json").read_text())["projectName"] == "Demo"


def test_display_rename_keeps_original_creation_command_reusable(workspace, monkeypatch):
    subprocess.run(["git", "remote", "add", "origin", "https://github.com/example/demo"], check=True)
    cdscli._save_local_credentials(host="https://cds.example", project_id="p", project_key="cdsp_keep", project_name="Demo", project_slug="demo")
    def request(method, path, **kwargs):
        assert method == "GET" and path == "/api/projects/p"
        return 200, {"id": "p", "name": "Renamed", "slug": "renamed"}, {}
    monkeypatch.setattr(cdscli, "_request", request)
    args = ["connect", "--host", "cds.example", "--new-project", "--create-project", "Demo", "--slug", "Demo"]
    for _ in range(2):
        code, output = run_command(args)
        assert code == 0, output
    context = json.loads((workspace / ".cds/connection.json").read_text())
    assert context["projectName"] == "Renamed" and context["creationName"] == "Demo"
    assert context["creationSlug"] == "demo"
