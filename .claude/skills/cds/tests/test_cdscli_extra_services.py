"""cdscli branch extra-services 子命令单测(波1 最后一公里)

覆盖 list / set(upsert + --file 整体替换) / remove 的 payload 组装、
--redeploy query、掩码哨兵回传契约、错误场景。全部 monkeypatch _call,
不打真 HTTP。

服务端契约(cds/src/routes/branches.ts PUT /extra-services):
  - PUT 整体替换数组;env merge 不 replace;掩码哨兵 *** 由服务端剥离恢复旧值
  - ?redeploy=1 触发真部署,响应带 redeployTriggered / redeployRejected / removalRolledBack
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


def parse_last(out: str) -> dict:
    return json.loads(out.strip().split("\n")[-1])


class FakeCall:
    """记录 _call 调用序列,按 (method, path 前缀) 返回预置响应。"""

    def __init__(self, existing: list[dict], put_response: dict | None = None):
        self.existing = existing
        self.put_response = put_response
        self.calls: list[tuple[str, str, object]] = []

    def __call__(self, method, path, body=None, timeout=15, quiet=False):
        self.calls.append((method, path, body))
        if method == "GET":
            return {"extraProfiles": self.existing}
        if method == "PUT":
            if self.put_response is not None:
                return self.put_response
            sent = (body or {}).get("extraProfiles", [])
            return {"extraProfiles": sent, "count": len(sent),
                    "redeployTriggered": "redeploy=1" in path}
        raise AssertionError(f"unexpected {method} {path}")


NACOS = {"id": "nacos", "dockerImage": "nacos/nacos-server:v2.3.2",
         "containerPort": 8848, "env": {"MODE": "standalone", "TOKEN": "***"}}


# ── list ──────────────────────────────────────────────────────────────

def test_list_outputs_profiles(monkeypatch):
    fake = FakeCall([NACOS])
    monkeypatch.setattr(cdscli, "_call", fake)
    code, out = call_main(["branch", "extra-services", "list", "br-1"])
    assert code == 0
    payload = parse_last(out)
    assert payload["ok"] is True
    assert payload["data"]["extraProfiles"][0]["id"] == "nacos"
    assert fake.calls == [("GET", "/api/branches/br-1/extra-services", None)]


# ── set: 新建 upsert ─────────────────────────────────────────────────

def test_set_creates_new_service(monkeypatch):
    fake = FakeCall([])
    monkeypatch.setattr(cdscli, "_call", fake)
    code, out = call_main([
        "branch", "extra-services", "set", "br-1",
        "--id", "nacos", "--image", "nacos/nacos-server:v2.3.2",
        "--port", "8848", "--env", "MODE=standalone",
        "--subdomain", "nacos", "--db-scope", "per-branch",
    ])
    assert code == 0
    method, path, body = fake.calls[-1]
    assert method == "PUT"
    assert path == "/api/branches/br-1/extra-services"  # 无 --redeploy 不带 query
    sent = body["extraProfiles"]
    assert len(sent) == 1
    svc = sent[0]
    assert svc["id"] == "nacos"
    assert svc["dockerImage"] == "nacos/nacos-server:v2.3.2"
    assert svc["containerPort"] == 8848
    assert svc["env"] == {"MODE": "standalone"}
    assert svc["subdomain"] == "nacos"
    assert svc["dbScope"] == "per-branch"


def test_set_new_requires_image_and_port(monkeypatch):
    fake = FakeCall([])
    monkeypatch.setattr(cdscli, "_call", fake)
    code, out = call_main(["branch", "extra-services", "set", "br-1",
                           "--id", "nacos", "--port", "8848"])
    assert code == 1
    assert "--image" in parse_last(out)["error"]

    code, out = call_main(["branch", "extra-services", "set", "br-1",
                           "--id", "nacos", "--image", "nacos/nacos-server:v2.3.2"])
    assert code == 1
    assert "--port" in parse_last(out)["error"]


def test_set_requires_id_or_file(monkeypatch):
    fake = FakeCall([])
    monkeypatch.setattr(cdscli, "_call", fake)
    code, out = call_main(["branch", "extra-services", "set", "br-1"])
    assert code == 1
    assert "--id" in parse_last(out)["error"]


# ── set: 更新已有服务(掩码哨兵往返) ──────────────────────────────────

def test_set_updates_existing_preserves_masked_env(monkeypatch):
    """GET 的脱敏 env(***)原样回传 PUT 是安全契约:服务端剥哨兵恢复旧值。
    只改 MODE 时,TOKEN 的 *** 应仍在 payload 里(交由服务端恢复),不被 CLI 丢弃。"""
    fake = FakeCall([dict(NACOS)])
    monkeypatch.setattr(cdscli, "_call", fake)
    code, out = call_main([
        "branch", "extra-services", "set", "br-1",
        "--id", "nacos", "--env", "MODE=cluster",
    ])
    assert code == 0
    _, _, body = fake.calls[-1]
    svc = body["extraProfiles"][0]
    assert svc["env"]["MODE"] == "cluster"      # 新值覆盖
    assert svc["env"]["TOKEN"] == "***"          # 哨兵原样回传,服务端恢复
    assert svc["dockerImage"] == NACOS["dockerImage"]  # 未提及字段继承


def test_set_upsert_keeps_other_services(monkeypatch):
    other = {"id": "kafka", "dockerImage": "bitnami/kafka:3.7",
             "containerPort": 9092}
    fake = FakeCall([other])
    monkeypatch.setattr(cdscli, "_call", fake)
    code, out = call_main([
        "branch", "extra-services", "set", "br-1",
        "--id", "nacos", "--image", "nacos/nacos-server:v2.3.2", "--port", "8848",
    ])
    assert code == 0
    _, _, body = fake.calls[-1]
    ids = {p["id"] for p in body["extraProfiles"]}
    assert ids == {"kafka", "nacos"}


# ── set: --redeploy 与 --file ────────────────────────────────────────

def test_set_redeploy_appends_query(monkeypatch):
    fake = FakeCall([])
    monkeypatch.setattr(cdscli, "_call", fake)
    code, out = call_main([
        "branch", "extra-services", "set", "br-1",
        "--id", "nacos", "--image", "nacos/nacos-server:v2.3.2",
        "--port", "8848", "--redeploy",
    ])
    assert code == 0
    _, path, _ = fake.calls[-1]
    assert path.endswith("?redeploy=1")
    assert parse_last(out)["data"]["redeployTriggered"] is True


def test_set_file_replaces_wholesale(monkeypatch, tmp_path):
    f = tmp_path / "extras.json"
    f.write_text(json.dumps({"extraProfiles": [NACOS]}), encoding="utf-8")
    fake = FakeCall([{"id": "old", "dockerImage": "x", "containerPort": 1}])
    monkeypatch.setattr(cdscli, "_call", fake)
    code, out = call_main(["branch", "extra-services", "set", "br-1",
                           "--file", str(f)])
    assert code == 0
    # --file 整体替换:不做 GET 读改写,直接 PUT 文件内容
    assert fake.calls[0][0] == "PUT"
    assert [p["id"] for p in fake.calls[0][2]["extraProfiles"]] == ["nacos"]


def test_set_file_rejects_non_array(monkeypatch, tmp_path):
    f = tmp_path / "bad.json"
    f.write_text(json.dumps({"foo": 1}), encoding="utf-8")
    fake = FakeCall([])
    monkeypatch.setattr(cdscli, "_call", fake)
    code, out = call_main(["branch", "extra-services", "set", "br-1",
                           "--file", str(f)])
    assert code == 1
    assert "数组" in parse_last(out)["error"]


def test_env_pair_validation(monkeypatch):
    fake = FakeCall([])
    monkeypatch.setattr(cdscli, "_call", fake)
    code, out = call_main([
        "branch", "extra-services", "set", "br-1",
        "--id", "nacos", "--image", "img", "--port", "1",
        "--env", "NOEQUALS",
    ])
    assert code == 1
    assert "KEY=VALUE" in parse_last(out)["error"]


# ── remove ────────────────────────────────────────────────────────────

def test_remove_filters_and_puts(monkeypatch):
    other = {"id": "kafka", "dockerImage": "bitnami/kafka:3.7", "containerPort": 9092}
    fake = FakeCall([dict(NACOS), other])
    monkeypatch.setattr(cdscli, "_call", fake)
    code, out = call_main(["branch", "extra-services", "remove", "br-1", "nacos",
                           "--redeploy"])
    assert code == 0
    method, path, body = fake.calls[-1]
    assert method == "PUT" and path.endswith("?redeploy=1")
    assert [p["id"] for p in body["extraProfiles"]] == ["kafka"]


def test_remove_missing_id_fails(monkeypatch):
    fake = FakeCall([])
    monkeypatch.setattr(cdscli, "_call", fake)
    code, out = call_main(["branch", "extra-services", "remove", "br-1", "ghost"])
    assert code == 2
    assert "ghost" in parse_last(out)["error"]


def test_remove_reports_rollback(monkeypatch):
    fake = FakeCall(
        [dict(NACOS)],
        put_response={
            "extraProfiles": [dict(NACOS)], "count": 1,
            "redeployTriggered": False,
            "redeployRejected": {"status": 503, "message": "owning executor offline"},
            "removalRolledBack": True, "rolledBackServiceIds": ["nacos"],
        },
    )
    monkeypatch.setattr(cdscli, "_call", fake)
    code, out = call_main(["branch", "extra-services", "remove", "br-1", "nacos",
                           "--redeploy"])
    assert code == 0
    payload = parse_last(out)
    assert payload["data"]["removalRolledBack"] is True
    assert "回滚" in payload["note"]
