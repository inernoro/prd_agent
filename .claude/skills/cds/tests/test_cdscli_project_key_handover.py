"""建项目时的钥匙交接：换钥、自证与「只有一处实现」。

背景（2026-08-25 线上复测后）：零凭据接入链路的最后一步是「一次性 create-only
钥匙 → 建项目 → 换成该项目的长期钥匙」。后端一旦签发项目级钥匙就会立刻吊销那把
一次性钥匙，而明文只发一次——**换钥错过即不可逆**。所以这一步必须是代码级的，
不能靠上层（尤其是大模型按提示词）自己拼命令、自己保存。

这批用例钉住三件事：
  1. 建项目的入口只有一个实现，任何新入口都必须走它（防再次分裂）；
  2. 换钥之后要用新钥匙回读一次、并确认本地不再持有一次性钥匙；
  3. 拿一次性身份建项目却没换到钥匙时，必须显式失败，不许留半成品。
"""

import io
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "cli"))

import cdscli  # noqa: E402

CLI_SOURCE = (ROOT / "cli" / "cdscli.py").read_text(encoding="utf-8")


@pytest.fixture()
def workspace(tmp_path, monkeypatch):
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    monkeypatch.chdir(tmp_path)
    for key in ("CDS_HOST", "CDS_PROJECT_ID", "CDS_PROJECT_KEY", "AI_ACCESS_KEY"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("CDS_HOST", "https://cds.example")
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


def read_credentials(workspace: Path) -> dict:
    path = workspace / ".cds" / "credentials.json"
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


PROJECT_KEY = "cdsp_demo_never-print-this"


def make_request(recorder: list, *, issue_key: bool = True, verify_status: int = 200):
    """伪造后端：POST /api/projects 建项目（可选签发项目级 key），GET 回读。"""

    def fake_request(method, path, body=None, timeout=15, extra_headers=None,
                     fatal_network_errors=True):
        recorder.append((method, path))
        if method == "POST" and path == "/api/projects":
            payload = {"project": {"id": "proj-new", "slug": "demo", "name": "demo"}}
            if issue_key:
                payload["issuedProjectKey"] = {
                    "keyId": "k1", "preview": "cdsp_demo_…", "plaintext": PROJECT_KEY,
                }
            return 201, payload, {}
        if method == "GET" and path.startswith("/api/projects/"):
            return verify_status, {"id": "proj-new"}, {}
        return 200, {}, {}

    return fake_request


def test_create_adopts_issued_key_and_drops_bootstrap(workspace, monkeypatch):
    """用一次性钥匙建项目 → 本地换成项目级钥匙，一次性钥匙不再留存。"""
    monkeypatch.setenv("AI_ACCESS_KEY", "cdsg_one_time_never-print")
    cdscli._save_local_credentials(host="https://cds.example",
                                   bootstrap_key="cdsg_one_time_never-print")
    calls: list = []
    monkeypatch.setattr(cdscli, "_request", make_request(calls))

    code, output = run_command(["project", "create", "--name", "demo"])
    assert code == 0, output

    saved = read_credentials(workspace)
    assert saved.get("projectId") == "proj-new"
    assert saved.get("projectKey") == PROJECT_KEY
    assert "bootstrapKey" not in saved, "换钥必须是替换，不能与一次性钥匙并存"
    assert PROJECT_KEY not in output, "密钥明文不得进 stdout"
    # 自证：换钥之后用新钥匙回读了一次项目
    assert ("GET", "/api/projects/proj-new") in calls


def test_onboard_also_adopts_issued_key(workspace, monkeypatch):
    """onboard 曾经自己 POST 然后丢掉返回的钥匙——项目建好、钥匙作废、clone 401。"""
    monkeypatch.setenv("AI_ACCESS_KEY", "cdsg_one_time_never-print")
    cdscli._save_local_credentials(host="https://cds.example",
                                   bootstrap_key="cdsg_one_time_never-print")
    calls: list = []
    base = make_request(calls)

    def fake_request(method, path, body=None, timeout=15, extra_headers=None,
                     fatal_network_errors=True):
        if method == "GET" and path == "/api/config":
            return 200, {"reposBase": "/tmp/repos"}, {}
        return base(method, path, body, timeout, extra_headers, fatal_network_errors)

    monkeypatch.setattr(cdscli, "_request", fake_request)
    # clone 是 SSE 流，这里只验建项目那一段，直接让 clone 之后的流程短路
    monkeypatch.setattr(cdscli, "_HUMAN", False)

    called = {}

    def fake_die(msg, *, code=1, extra=None):
        called["die"] = msg
        raise SystemExit(code)

    monkeypatch.setattr(cdscli, "die", fake_die)
    run_command(["onboard", "https://example.com/demo.git"])

    saved = read_credentials(workspace)
    assert saved.get("projectKey") == PROJECT_KEY, (
        "onboard 建完项目必须同样换成项目级钥匙；换钥丢了就是不可逆的死局"
    )
    assert "bootstrapKey" not in saved


def test_bootstrap_identity_without_issued_key_fails_loudly(workspace, monkeypatch):
    """拿一次性身份建项目却没换到钥匙 = 死局，必须显式失败而不是继续往下跑。"""
    monkeypatch.setenv("AI_ACCESS_KEY", "cdsg_one_time_never-print")
    # 一次性身份的判据是凭据文件里存着 bootstrapKey（页面批准换来的那把），
    # 不是环境里有没有 AI_ACCESS_KEY —— 静态 key 与全权 key 建项目本就不签发新钥匙。
    cdscli._save_local_credentials(host="https://cds.example",
                                   bootstrap_key="cdsg_one_time_never-print")
    calls: list = []
    monkeypatch.setattr(cdscli, "_request", make_request(calls, issue_key=False))

    code, output = run_command(["project", "create", "--name", "demo"])
    assert code == 2, output
    assert "未返回项目级 Key" in output
    assert "proj-new" in output, "失败信息里要带上已经建出来的项目 id，便于人工收尾"


def test_adopted_key_that_cannot_read_back_fails(workspace, monkeypatch):
    """换钥不能只看「存下来了」，要用新钥匙真读一次；读不回来就是没换成。"""
    monkeypatch.setenv("AI_ACCESS_KEY", "cdsg_one_time_never-print")
    cdscli._save_local_credentials(host="https://cds.example",
                                   bootstrap_key="cdsg_one_time_never-print")
    calls: list = []
    monkeypatch.setattr(cdscli, "_request",
                        make_request(calls, verify_status=403))

    code, output = run_command(["project", "create", "--name", "demo"])
    assert code == 2, output
    assert "回读项目被拒" in output


def test_connect_can_create_project_in_one_command(workspace, monkeypatch):
    """--create-project：申请 → 批准 → 一次性钥匙 → 建项目 → 换钥，一条命令走完。"""
    calls: list = []

    def fake_request(method, path, body=None, timeout=15, extra_headers=None,
                     fatal_network_errors=True):
        calls.append((method, path))
        if method == "POST" and path == "/api/bootstrap-access-requests":
            return 201, {"requestId": "req1", "pollToken": "poll1", "status": "pending"}, {}
        if method == "GET" and path.startswith("/api/bootstrap-access-requests/"):
            return 200, {"status": "approved",
                         "authorizationKey": "cdsg_one_time_never-print"}, {}
        if method == "POST" and path == "/api/projects":
            return 201, {"project": {"id": "proj-new", "slug": "demo"},
                         "issuedProjectKey": {"keyId": "k1", "plaintext": PROJECT_KEY}}, {}
        if method == "GET" and path == "/api/projects":
            return 200, {"projects": []}, {}
        if method == "GET" and path.startswith("/api/projects/"):
            return 200, {"id": "proj-new"}, {}
        return 200, {}, {}

    monkeypatch.setattr(cdscli, "_request", fake_request)
    monkeypatch.setattr(cdscli.time, "sleep", lambda _seconds: None)

    code, output = run_command([
        "connect", "--host", "https://cds.example", "--new-project",
        "--create-project", "demo", "--agent", "TestAgent",
    ])
    assert code == 0, output

    saved = read_credentials(workspace)
    assert saved.get("projectId") == "proj-new"
    assert saved.get("projectKey") == PROJECT_KEY
    assert "bootstrapKey" not in saved
    assert PROJECT_KEY not in output and "cdsg_one_time" not in output


def test_only_one_place_creates_projects(workspace):
    """防再次分裂：全 CLI 里「POST 到 /api/projects」只允许出现在换钥实现里。

    判据不能是精确子串——换个引号、写成 f-string、或把路径提成变量就绕过去了
    （守卫太窄本身就是这次要修的那类问题）。这里同时扫两种形状：
    带 POST 字样的同一行里出现 /api/projects，以及任何形式的 /api/projects 字面量。
    """
    # 只认「真的发起了一次 POST /api/projects」的调用形状：带引号的 POST 方法参数
    # 紧跟带引号（或 f-string）的 /api/projects 路径。docstring、help 文案、注释里
    # 出现的 POST /api/projects 是说明文字，不是调用。
    call_re = re.compile(r"""['"]POST['"]\s*,\s*f?['"]/api/projects(?![\w/-])""")
    post_hits = [ln.strip() for ln in CLI_SOURCE.splitlines() if call_re.search(ln)]
    assert len(post_hits) == 1, (
        "建项目出现了第二处实现——钥匙交接会在那条路上丢掉。命中：\n" + "\n".join(post_hits)
    )
    assert "_create_project_and_adopt_key" in CLI_SOURCE
    # 反向确认守卫盯的就是那一处（而不是碰巧只匹配到别的东西）
    assert "/api/projects" in post_hits[0] and "POST" in post_hits[0]
    # 换个引号、写成 f-string 都要被同一条判据抓住
    assert call_re.search("x = _call('POST', '/api/projects', body=p)")
    assert call_re.search('y = _call("POST", f"/api/projects", body=p)')


def test_non_bootstrap_identity_without_issued_key_is_fine(workspace, monkeypatch):
    """静态 AI key / 全权 key 建项目本来就不签发新钥匙，不能被误判成死局。"""
    monkeypatch.setenv("AI_ACCESS_KEY", "static-platform-key")
    calls: list = []
    monkeypatch.setattr(cdscli, "_request", make_request(calls, issue_key=False))

    code, output = run_command(["project", "create", "--name", "demo"])
    assert code == 0, output
    assert "proj-new" in output


def test_create_project_argument_errors_happen_before_any_approval(workspace, monkeypatch):
    """参数错在发起申请之前就要报出来，不能让用户白批一次。"""
    seen: list = []

    def fake_request(method, path, body=None, timeout=15, extra_headers=None,
                     fatal_network_errors=True):
        seen.append((method, path))
        return 201, {"requestId": "req1", "pollToken": "poll1", "status": "pending"}, {}

    monkeypatch.setattr(cdscli, "_request", fake_request)

    code, output = run_command([
        "connect", "--host", "https://cds.example", "--project", "proj-a",
        "--create-project", "demo",
    ])
    assert code == 1, output
    assert "只能与 --new-project 搭配使用" in output
    assert seen == [], "报错之前不许发起任何授权申请"

    code, output = run_command([
        "connect", "--host", "https://cds.example", "--new-project",
        "--create-project", "   ",
    ])
    assert code == 1, output
    assert "非空项目名称" in output
    assert seen == []


def test_verify_hiccup_does_not_discard_completed_handover(workspace, monkeypatch):
    """回读那一跳网络抖动 ≠ 换钥失败：钥匙已在本地，不能再报一次失败诱导重跑。"""
    cdscli._save_local_credentials(host="https://cds.example",
                                   bootstrap_key="cdsg_one_time_never-print")
    calls: list = []

    def fake_request(method, path, body=None, timeout=15, extra_headers=None,
                     fatal_network_errors=True):
        calls.append((method, path))
        if method == "POST" and path == "/api/projects":
            return 201, {"project": {"id": "proj-new", "slug": "demo"},
                         "issuedProjectKey": {"keyId": "k1", "plaintext": PROJECT_KEY}}, {}
        if method == "GET" and path.startswith("/api/projects/"):
            return 0, {"error": "timeout"}, {}   # 网络抖动
        return 200, {}, {}

    monkeypatch.setattr(cdscli, "_request", fake_request)

    code, output = run_command(["project", "create", "--name", "demo"])
    assert code == 0, output
    saved = read_credentials(workspace)
    assert saved.get("projectKey") == PROJECT_KEY
    assert "bootstrapKey" not in saved


def test_stale_bootstrap_key_with_explicit_full_key_is_not_a_dead_end(workspace, monkeypatch):
    """残留 bootstrapKey + 显式全权 AI_ACCESS_KEY：本次请求发出去的不是那把一次性钥匙。

    判据必须比对「实际发出去的凭据」，只看文件里存没存会把全权身份误判成一次性身份，
    于是在项目**已经建好之后**报死局，诱导重试、建出重复项目。
    """
    cdscli._save_local_credentials(host="https://cds.example",
                                   bootstrap_key="cdsg_one_time_never-print")
    monkeypatch.setenv("AI_ACCESS_KEY", "static-platform-key")   # 显式全权身份
    calls: list = []
    monkeypatch.setattr(cdscli, "_request", make_request(calls, issue_key=False))

    code, output = run_command(["project", "create", "--name", "demo"])
    assert code == 0, output
    assert "proj-new" in output


def test_stale_bootstrap_key_does_not_break_normal_create(workspace, monkeypatch):
    """工作区残留一把过期的一次性钥匙，不该让正常的项目级建项目误报死局。"""
    cdscli._save_local_credentials(host="https://cds.example",
                                   project_id="proj-old",
                                   project_key="cdsp_existing_never-print")
    # 手工塞一把残留的 bootstrapKey，模拟老工作区
    import json as _json
    path = workspace / ".cds" / "credentials.json"
    payload = _json.loads(path.read_text(encoding="utf-8"))
    payload["bootstrapKey"] = "cdsg_stale_never-print"
    path.write_text(_json.dumps(payload), encoding="utf-8")
    monkeypatch.setenv("CDS_PROJECT_KEY", "cdsp_existing_never-print")

    calls: list = []
    monkeypatch.setattr(cdscli, "_request", make_request(calls, issue_key=False))

    code, output = run_command(["project", "create", "--name", "demo"])
    assert code == 0, output
