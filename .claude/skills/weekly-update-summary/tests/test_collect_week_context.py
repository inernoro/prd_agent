"""collect_week_context.py 的判据回归。

跑法（本仓库的技能级 pytest 未接 CI，需手动跑）：
    python3 -m pytest .claude/skills/weekly-update-summary/tests -q

这里锁死的都是**曾经真的错过**的判据。每条 case 后面的注释写清「删掉这条守卫会
退化成什么」——按 .claude/rules/predicate-and-wiring-discipline.md：改动删掉后测试
仍全绿的地方，就是需要一条守卫的地方。
"""
import datetime as dt
import importlib.util
import pathlib
import sys

import pytest

_SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "collect_week_context.py"


@pytest.fixture(scope="module")
def m():
    spec = importlib.util.spec_from_file_location("collect_week_context", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    saved, sys.argv = sys.argv, ["collect_week_context"]
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.argv = saved
    return mod


def _d(n):
    return (dt.date.today() - dt.timedelta(days=n)).isoformat()


# --- 保留窗口边界 -----------------------------------------------------------

def test_start_exactly_at_retention_boundary_is_incomplete(m):
    """CDS 的淘汰线是滚动的 90*24h，这里只有日期粒度：起点正好第 90 天时，
    当天清晨的 run 已可被删。用 `>` 会漏判成 complete，必须 `>=`。"""
    c = m._release_coverage([], [], _d(90), _d(84))
    assert c["complete"] is False
    assert c["warnings"]


def test_start_inside_retention_window_is_complete(m):
    c = m._release_coverage([], [], _d(89), _d(83))
    assert c["complete"] is True
    assert not c["warnings"]


# --- 条数闸只作提示，不作丢数判据 -------------------------------------------

def test_cap_reached_is_advisory_not_incompleteness(m):
    """新目标恰好攒满 100 条合法 run —— 第 101 条从未存在，什么都没被淘汰。
    以前把它记进 warnings，会把准确数据标成「下限」，逼报告写错口径。"""
    runs = [{"targetId": "t1", "startedAt": _d(10) + "T00:00:00Z"} for _ in range(100)]
    c = m._release_coverage(runs, [], _d(30), _d(24))
    assert c["complete"] is True, "条数触顶不等于发生过淘汰，不能打成不完整"
    assert len(c["advisories"]) == 1, "但要照常提示读者"


def test_normal_project_has_no_noise(m):
    c = m._release_coverage([{"targetId": "t1", "startedAt": _d(40) + "T00:00:00Z"}],
                            [], _d(30), _d(24))
    assert c["complete"] is True
    assert not c["warnings"] and not c["advisories"]


# --- 项目标识：id / slug / name 三种写法都要认 ------------------------------

def test_identity_set_matches_any_spelling(m, monkeypatch):
    """/api/releases/runs 存的是 slug（实测 prd-agent），cdscli project list 给的是
    id。先前归一成单一 id 再比对，W30 的 39 条 run 被全部滤掉却仍报 available=true。"""
    monkeypatch.setattr(m, "_cdscli", lambda *a, **k: {
        "ok": True,
        "data": {"projects": [{"id": "defd4695ab5f", "slug": "mdimp", "name": "IMP"},
                              {"id": "prd-agent", "slug": "prd-agent", "name": "MAP"}]},
    })
    for spelling in ("prd-agent", "MAP", "map"):
        ident, canonical, warn = m._resolve_project_identity(spelling)
        assert warn is None
        assert {"prd-agent", "map"} <= ident, f"{spelling} 应解析出全部等价写法"
        assert canonical == "prd-agent", "服务端 ?project= 必须用规范 id，否则项目级凭据下 403"


def test_identity_unknown_project_falls_back_with_warning(m, monkeypatch):
    monkeypatch.setattr(m, "_cdscli", lambda *a, **k: {"ok": True, "data": {"projects": []}})
    ident, canonical, warn = m._resolve_project_identity("nope")
    assert ident == {"nope"} and warn and canonical is None


# --- 过滤器滤空必须喊出来，不许伪装成「本周未发布」 ------------------------

def _fake_ledger(m, monkeypatch, rows, honors_scope=True):
    """模拟 /api/releases/runs：honors_scope=True 时按 ?project= 服务端过滤。"""
    def api(path):
        if "?project=" in path:
            want = path.split("?project=", 1)[1]
            if not honors_scope:
                return {"runs": []}          # 服务端不认这个写法 -> 空
            return {"runs": [r for r in rows if r.get("projectId") == want]}
        return {"runs": rows}
    monkeypatch.setattr(m, "_cds_api", api)


def test_project_with_zero_releases_is_available_not_unavailable(m, monkeypatch):
    """曾经的误报：台账里有别的项目的 run，本项目一次没发过，被判成「数据不可用」。
    实测 mdimp 就是这种情况——那 136 条属于 prd-agent，mdimp 的正确答案是 0 次。
    服务端 ?project= 过滤后空结果就是**真的 0**，必须如实报 available=true。"""
    monkeypatch.setattr(m, "_resolve_project_identity", lambda p: ({"mdimp"}, "mdimp", None))
    _fake_ledger(m, monkeypatch, [
        {"releaseId": "r1", "projectId": "prd-agent", "status": "success",
         "startedAt": "2026-07-21T10:00:00Z"},
    ])
    out = m.collect_releases("mdimp", "2026-07-20", "2026-07-26")
    assert out["available"] is True, "本项目真的没发过，不能报成数据不可用"
    assert out["attempts"] == 0


def test_unrecognized_scope_spelling_falls_back_to_client_match(m, monkeypatch):
    """端点只认 run 里存的 projectId 字面量：传项目名/hex id 会返回 0。
    直接信这个 0 等于把静默错误搬到服务端，故必须交叉验证并回退。"""
    monkeypatch.setattr(m, "_resolve_project_identity", lambda p: ({"prd-agent", "map"}, "prd-agent", None))
    _fake_ledger(m, monkeypatch, [
        {"releaseId": "a", "projectId": "prd-agent", "status": "success",
         "startedAt": "2026-07-21T10:00:00Z"},
    ], honors_scope=False)
    out = m.collect_releases("MAP", "2026-07-20", "2026-07-26")
    assert out["available"] is True
    assert out["attempts"] == 1, "回退到客户端匹配后应拿到真实数字，而不是 0"
    assert any("未命中" in a for a in out["coverage"]["advisories"]), "回退要告警"


def test_matching_runs_are_counted(m, monkeypatch):
    monkeypatch.setattr(m, "_resolve_project_identity", lambda p: ({"prd-agent"}, "prd-agent", None))
    _fake_ledger(m, monkeypatch, [
        {"releaseId": "a", "projectId": "prd-agent", "status": "success",
         "startedAt": "2026-07-21T10:00:00Z"},
        {"releaseId": "b", "projectId": "prd-agent", "status": "failed",
         "startedAt": "2026-07-22T10:00:00Z"},
        {"releaseId": "c", "projectId": "prd-agent", "status": "running",
         "startedAt": "2026-07-23T10:00:00Z"},   # 在途，不进分母
        {"releaseId": "d", "projectId": "other", "status": "success",
         "startedAt": "2026-07-24T10:00:00Z"},   # 他项目
    ])
    out = m.collect_releases("prd-agent", "2026-07-20", "2026-07-26")
    assert out["available"] is True
    assert (out["attempts"], out["success"], out["failed"], out["inFlight"]) == (2, 1, 1, 1)
    assert out["successRate"] == 50.0


def test_scoped_query_failure_falls_back_instead_of_killing_source(m, monkeypatch):
    """项目级凭据下 CDS 把 ?project= 与 key 绑定的 projectId 精确比对，不一致直接 403。
    403 会让 _cds_api 抛错——若不接住，整个发布来源变不可用，连交叉验证都跑不到。"""
    monkeypatch.setattr(m, "_resolve_project_identity",
                        lambda p: ({"prd-agent"}, "prd-agent", None))

    def api(path):
        if "?project=" in path:
            raise RuntimeError("CDS /api/releases/runs 返回 403")
        return {"runs": [{"releaseId": "a", "projectId": "prd-agent", "status": "success",
                          "startedAt": "2026-07-21T10:00:00Z"}]}
    monkeypatch.setattr(m, "_cds_api", api)

    out = m.collect_releases("prd-agent", "2026-07-20", "2026-07-26")
    assert out["available"] is True, "scope 查询失败不该拖垮整个来源"
    assert out["attempts"] == 1, "应回退到全量查询 + 客户端匹配拿到真实数字"
    assert any("回退" in a for a in out["coverage"]["advisories"]), "回退要如实告警"


def test_unresolved_identity_with_zero_match_refuses_to_certify_zero(m, monkeypatch):
    """标识没解析成功时 ident 只剩入参原值；入参若是别名（项目名 MAP），
    台账里存的 prd-agent 既不会被服务端 scope 命中也不会被客户端匹配命中。
    此时的 0 是「没找着」不是「没发过」，不能盖章认证成 available=true。"""
    monkeypatch.setattr(m, "_resolve_project_identity",
                        lambda p: ({"map"}, None, "项目列表不可用，仅按入参原值过滤"))
    monkeypatch.setattr(m, "_cds_api", lambda path: (
        {"runs": []} if "?project=" in path else
        {"runs": [{"releaseId": "a", "projectId": "prd-agent", "status": "success",
                   "startedAt": "2026-07-21T10:00:00Z"}]}))
    out = m.collect_releases("MAP", "2026-07-20", "2026-07-26")
    assert out["available"] is False, "解析失败 + 零匹配 = 无法区分两种零，不能认证"
    assert out["coverage"]["complete"] is False


def test_resolved_identity_with_real_zero_stays_available(m, monkeypatch):
    """反向：解析成功时的 0 是可信的真实零发布（mdimp），不能被上面那条误伤。"""
    monkeypatch.setattr(m, "_resolve_project_identity", lambda p: ({"mdimp"}, "mdimp", None))
    _fake_ledger(m, monkeypatch, [
        {"releaseId": "a", "projectId": "prd-agent", "status": "success",
         "startedAt": "2026-07-21T10:00:00Z"}])
    out = m.collect_releases("mdimp", "2026-07-20", "2026-07-26")
    assert out["available"] is True and out["attempts"] == 0
