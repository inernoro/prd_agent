"""Phase 16 — cdscli project / branch / onboard CRUD 单测

覆盖新增 4+1 个子命令的 happy path + 错误场景。所有测试都用 monkeypatch 替换
`_call` / `urlopen`,不打真 HTTP,跑得快、与 CDS 状态无关。

新命令清单(SSOT: cdscli.py 的 _build_parser):
  - project create --name X --git-url URL [--slug] [--description]
  - project clone <id>            (SSE 流式)
  - project delete <id>           (级联清理)
  - branch create --project P --branch B   (--project flag 抹平 API field "projectId")
  - onboard <git-url>              (create + clone + envMeta 提示)
  - env set: 兼容 KEY=VALUE 与 --key/--value
"""
import io
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
CLI_DIR = ROOT / "cli"
sys.path.insert(0, str(CLI_DIR))

import cdscli  # noqa: E402


# ── shared fixtures ──────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def reset_globals(monkeypatch):
    """每个 case 起跑前重置全局 + 注入最小环境。"""
    monkeypatch.setenv("CDS_HOST", "cds.test.example")
    monkeypatch.setenv("AI_ACCESS_KEY", "test-key-not-real")
    monkeypatch.delenv("CDS_PROJECT_ID", raising=False)
    monkeypatch.delenv("CDS_PROJECT_KEY", raising=False)
    cdscli._TRACE_ID = "testtrace"
    cdscli._HUMAN = False
    yield


def call_main(argv: list[str]) -> tuple[int, str]:
    """跑 cdscli.main(argv),capture stdout + 退出码。"""
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


def parse_ok(out: str) -> dict:
    """解析 cdscli 默认 JSON 输出,断言 ok=True。"""
    payload = json.loads(out.strip().split("\n")[-1])
    assert payload.get("ok") is True, f"expected ok=true, got {payload}"
    return payload


# ── project create ───────────────────────────────────────────────────


def test_project_create_minimal(monkeypatch):
    """--name 必填,git-url/slug/description 可选。验证 URL + body 正确。"""
    captured: dict = {}

    def fake_call(method, path, body=None, timeout=15, quiet=False):
        captured["method"] = method
        captured["path"] = path
        captured["body"] = body
        return {"project": {"id": "proj-abc", "slug": "demo", "name": "Demo"}}

    monkeypatch.setattr(cdscli, "_call", fake_call)
    code, out = call_main(["project", "create", "--name", "Demo"])
    assert code == 0, out
    assert captured["method"] == "POST"
    assert captured["path"] == "/api/projects"
    assert captured["body"] == {"name": "Demo"}
    payload = parse_ok(out)
    assert payload["data"]["project"]["id"] == "proj-abc"


def test_project_create_with_all_fields(monkeypatch):
    """--git-url + --slug + --description 应被原样传到 body。"""
    captured: dict = {}
    monkeypatch.setattr(cdscli, "_call",
                        lambda m, p, body=None, timeout=15, quiet=False:
                        captured.update(method=m, path=p, body=body) or
                        {"project": {"id": "p-1", "slug": "alpha"}})
    code, _ = call_main([
        "project", "create",
        "--name", "Alpha App",
        "--git-url", "https://github.com/x/alpha.git",
        "--slug", "alpha",
        "--description", "the alpha app",
    ])
    assert code == 0
    assert captured["body"] == {
        "name": "Alpha App",
        "gitRepoUrl": "https://github.com/x/alpha.git",
        "slug": "alpha",
        "description": "the alpha app",
    }


def test_project_create_empty_name_dies(monkeypatch):
    """--name 留空(空白)应 die,不发请求。"""
    called = {"n": 0}

    def fake_call(*a, **kw):
        called["n"] += 1
        return {}

    monkeypatch.setattr(cdscli, "_call", fake_call)
    code, out = call_main(["project", "create", "--name", "   "])
    assert code == 1, f"expected code=1, got {code}: {out}"
    assert called["n"] == 0, "不应该发起 HTTP 请求"
    payload = json.loads(out.strip().split("\n")[-1])
    assert payload["ok"] is False
    assert "--name" in payload["error"]


# ── project clone (SSE) ──────────────────────────────────────────────


class _FakeSSEResponse:
    """模拟 urllib SSE response,iter 返回 bytes 行。"""
    def __init__(self, lines: list[str]):
        # urlopen returned object iterates over byte lines
        self._lines = [(line + "\n").encode("utf-8") for line in lines]

    def __iter__(self):
        return iter(self._lines)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_project_clone_streams_done(monkeypatch):
    """clone 收到 done 事件应正常退出 ok=true,events 全捕获。"""
    sse_lines = [
        "event: progress",
        'data: {"phase":"clone","percent":10}',
        "",
        "event: detect",
        'data: {"step":"detect-stack","stack":"nodejs"}',
        "",
        "event: done",
        'data: {"projectId":"proj-1"}',
        "",
    ]

    def fake_urlopen(req, timeout=300):
        # 校验 URL + method + auth header
        assert req.method == "POST"
        assert "/api/projects/proj-1/clone" in req.full_url
        assert req.headers.get("X-ai-access-key")  # case-insensitive in urllib
        return _FakeSSEResponse(sse_lines)

    monkeypatch.setattr(cdscli.urllib.request, "urlopen", fake_urlopen)
    code, out = call_main(["project", "clone", "proj-1"])
    assert code == 0, out
    payload = parse_ok(out)
    assert payload["data"]["finalEvent"] == "done"
    assert payload["data"]["success"] is True
    # 至少看到 progress / detect / done 三条
    events = payload["data"]["events"]
    seen_events = {e.get("_event") for e in events}
    assert {"progress", "detect", "done"}.issubset(seen_events)


def test_project_clone_streams_error_event(monkeypatch):
    """收到 error 事件应 ok=true 但 finalEvent=error & success=false。"""
    sse_lines = [
        "event: progress",
        'data: {"phase":"clone"}',
        "",
        "event: error",
        'data: {"message":"git clone failed: authentication required"}',
        "",
    ]

    def fake_urlopen(req, timeout=300):
        return _FakeSSEResponse(sse_lines)

    monkeypatch.setattr(cdscli.urllib.request, "urlopen", fake_urlopen)
    code, out = call_main(["project", "clone", "proj-2"])
    # 注意:即使收到 error,流也是正常读完的,我们 ok() 出来,success=false
    assert code == 0, out
    payload = parse_ok(out)
    assert payload["data"]["finalEvent"] == "error"
    assert payload["data"]["success"] is False


# ── project delete ──────────────────────────────────────────────────


def test_project_delete_with_cascade(monkeypatch):
    """DELETE 调用 + cascade 字段透传给用户。"""
    captured: dict = {}

    def fake_call(method, path, body=None, timeout=15, quiet=False):
        captured["method"] = method
        captured["path"] = path
        return {"cascade": {"branches": 3, "buildProfiles": 2,
                             "infraServices": 1, "routingRules": 4}}

    monkeypatch.setattr(cdscli, "_call", fake_call)
    code, out = call_main(["project", "delete", "proj-x"])
    assert code == 0
    assert captured["method"] == "DELETE"
    assert captured["path"] == "/api/projects/proj-x"
    payload = parse_ok(out)
    assert payload["data"]["cascade"]["branches"] == 3
    assert payload["data"]["projectId"] == "proj-x"


# ── branch create (F7 friction:--project → projectId 抹平) ──────────


def test_branch_create_payload_uses_projectId_field(monkeypatch):
    """关键:CLI 用 --project,但 API body 必须是 projectId(F7)。"""
    captured: dict = {}

    def fake_call(method, path, body=None, timeout=15, quiet=False):
        captured.update(method=method, path=path, body=body)
        return {"id": "br-9", "projectId": "proj-1", "branch": "feat/x",
                "status": "pending", "services": {}}

    monkeypatch.setattr(cdscli, "_call", fake_call)
    code, out = call_main([
        "branch", "create", "--project", "proj-1", "--branch", "feat/x",
    ])
    assert code == 0, out
    assert captured["method"] == "POST"
    assert captured["path"] == "/api/branches"
    # F7:body 字段名必须是 projectId,不是 project
    assert "projectId" in captured["body"]
    assert "project" not in captured["body"]
    assert captured["body"] == {"projectId": "proj-1", "branch": "feat/x"}


def test_branch_create_reads_env_project_id(monkeypatch):
    """缺 --project 时回落到 CDS_PROJECT_ID 环境变量。"""
    monkeypatch.setenv("CDS_PROJECT_ID", "proj-from-env")
    captured: dict = {}
    monkeypatch.setattr(cdscli, "_call",
                        lambda m, p, body=None, timeout=15, quiet=False:
                        captured.update(method=m, path=p, body=body) or
                        {"id": "br-y"})
    code, _ = call_main(["branch", "create", "--branch", "fix/typo"])
    assert code == 0
    assert captured["body"]["projectId"] == "proj-from-env"


def test_branch_create_missing_project_dies(monkeypatch):
    """都没给(无 --project + 无 env)→ 立即 die,不打 HTTP。"""
    called = {"n": 0}
    monkeypatch.setattr(cdscli, "_call",
                        lambda *a, **kw: called.update(n=called["n"] + 1) or {})
    code, out = call_main(["branch", "create", "--branch", "xx"])
    assert code == 1
    assert called["n"] == 0
    payload = json.loads(out.strip().split("\n")[-1])
    assert payload["ok"] is False
    assert "CDS_PROJECT_ID" in payload["error"]


# ── env set: KEY=VALUE 兼容 + --key/--value 新形式 ────────────────────


def test_env_set_classic_form(monkeypatch):
    """KEY=VALUE 位置参数应继续工作(向后兼容)。"""
    captured: dict = {}
    monkeypatch.setattr(cdscli, "_call",
                        lambda m, p, body=None, timeout=15, quiet=False:
                        captured.update(method=m, path=p, body=body) or
                        {"value": "v1"})
    code, _ = call_main(["env", "set", "FOO=bar", "--scope", "proj-1"])
    assert code == 0
    assert captured["method"] == "PUT"
    assert "/api/env/FOO" in captured["path"]
    assert "scope=proj-1" in captured["path"]
    assert captured["body"] == {"value": "bar"}


def test_env_set_kv_with_explicit_flags(monkeypatch):
    """--key + --value 应当与 KEY=VALUE 等价。"""
    captured: dict = {}
    monkeypatch.setattr(cdscli, "_call",
                        lambda m, p, body=None, timeout=15, quiet=False:
                        captured.update(method=m, path=p, body=body) or {})
    # value 含 = 是 motivating 案例(JSON / base64)
    code, _ = call_main([
        "env", "set",
        "--key", "DATABASE_URL",
        "--value", "postgres://u:p=q@h:5432/db?sslmode=require",
    ])
    assert code == 0
    assert captured["body"]["value"] == \
        "postgres://u:p=q@h:5432/db?sslmode=require"


def test_env_set_no_input_dies(monkeypatch):
    """空 invocation 应报错而不是 silently set。"""
    monkeypatch.setattr(cdscli, "_call",
                        lambda *a, **kw: pytest.fail("不应被调用"))
    code, _ = call_main(["env", "set"])
    assert code == 1


# ── onboard 一键命令 ─────────────────────────────────────────────────


def test_onboard_creates_then_clones(monkeypatch):
    """onboard 应先 POST /api/projects,然后 SSE clone,最后 GET /:id。"""
    call_log: list[tuple] = []

    def fake_call(method, path, body=None, timeout=15, quiet=False):
        call_log.append((method, path, body))
        if method == "POST" and path == "/api/projects":
            return {"project": {"id": "proj-onb", "slug": "alpha"}}
        if method == "GET" and path.startswith("/api/projects/"):
            return {"id": "proj-onb",
                    "envMeta": {
                        "OAUTH_CLIENT_SECRET": {"kind": "required"},
                        "CDS_JWT_SECRET": {"kind": "auto"},
                    }}
        return {}

    monkeypatch.setattr(cdscli, "_call", fake_call)

    sse_lines = [
        "event: progress",
        'data: {"phase":"clone","percent":50}',
        "",
        "event: done",
        'data: {"ok":true}',
        "",
    ]
    monkeypatch.setattr(cdscli.urllib.request, "urlopen",
                        lambda req, timeout=300: _FakeSSEResponse(sse_lines))

    code, out = call_main([
        "onboard", "https://github.com/acme/alpha.git",
    ])
    assert code == 0, out
    # 调用链:POST projects → GET projects/:id
    paths = [(m, p) for m, p, _b in call_log]
    assert ("POST", "/api/projects") in paths
    assert any(m == "GET" and "/api/projects/proj-onb" in p
               for m, p in paths), paths
    payload = parse_ok(out)
    assert payload["data"]["projectId"] == "proj-onb"
    assert "OAUTH_CLIENT_SECRET" in payload["data"]["requiredEnvKeys"]
    assert "CDS_JWT_SECRET" not in payload["data"]["requiredEnvKeys"]


def test_onboard_slug_inferred_from_url(monkeypatch):
    """没传 --slug 时,从 URL 末段去 .git 推断。"""
    captured: dict = {}

    def fake_call(method, path, body=None, timeout=15, quiet=False):
        if method == "POST" and path == "/api/projects":
            captured.update(body=body)
            return {"project": {"id": "proj-z"}}
        return {}

    monkeypatch.setattr(cdscli, "_call", fake_call)
    monkeypatch.setattr(cdscli.urllib.request, "urlopen",
                        lambda r, timeout=300: _FakeSSEResponse([
                            "event: done", 'data: {}', ""
                        ]))
    code, _ = call_main([
        "onboard", "git@github.com:acme/My_Cool-App.git",
    ])
    assert code == 0
    body = captured["body"]
    # slugify 大小写 + 下划线 → '-':my-cool-app
    assert body["slug"] == "my-cool-app"
    assert body["gitRepoUrl"] == "git@github.com:acme/My_Cool-App.git"


# ── parser-level guard:确保 --help 全部子命令都注册了 ───────────────


def test_parser_registers_all_new_subcommands():
    parser = cdscli._build_parser()
    project_subs: list[str] = []
    branch_subs: list[str] = []
    top_subs: list[str] = []
    for action in parser._actions:
        if isinstance(action, cdscli.argparse._SubParsersAction):
            top_subs.extend(action.choices.keys())
            for name, sp in action.choices.items():
                for sa in sp._actions:
                    if isinstance(sa, cdscli.argparse._SubParsersAction):
                        if name == "project":
                            project_subs.extend(sa.choices.keys())
                        elif name == "branch":
                            branch_subs.extend(sa.choices.keys())
    assert "create" in project_subs and "clone" in project_subs \
        and "delete" in project_subs, project_subs
    assert "create" in branch_subs, branch_subs
    assert "onboard" in top_subs, top_subs


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-x", "-v"]))
