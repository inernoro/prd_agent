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
        ident, warn = m._resolve_project_identity(spelling)
        assert warn is None
        assert {"prd-agent", "map"} <= ident, f"{spelling} 应解析出全部等价写法"


def test_identity_unknown_project_falls_back_with_warning(m, monkeypatch):
    monkeypatch.setattr(m, "_cdscli", lambda *a, **k: {"ok": True, "data": {"projects": []}})
    ident, warn = m._resolve_project_identity("nope")
    assert ident == {"nope"} and warn


# --- 过滤器滤空必须喊出来，不许伪装成「本周未发布」 ------------------------

def test_filter_dropping_everything_reports_unavailable(m, monkeypatch):
    """最危险的静默错误：台账有 136 条，项目过滤器一条没留，却以
    available=true + attempts=0 输出，读者会读成「本周一次都没发布」。"""
    monkeypatch.setattr(m, "_resolve_project_identity", lambda p: ({"wrong-id"}, None))
    monkeypatch.setattr(m, "_cds_api", lambda path: {"runs": [
        {"releaseId": "r1", "projectId": "prd-agent", "status": "success",
         "startedAt": "2026-07-21T10:00:00Z"},
    ]})
    out = m.collect_releases("whatever", "2026-07-20", "2026-07-26")
    assert out["available"] is False
    assert out["coverage"]["complete"] is False
    assert "prd-agent" in out["reason"], "要把实际取到的写法示例给出来，便于定位"


def test_matching_runs_are_counted(m, monkeypatch):
    monkeypatch.setattr(m, "_resolve_project_identity", lambda p: ({"prd-agent"}, None))
    monkeypatch.setattr(m, "_cds_api", lambda path: {"runs": [
        {"releaseId": "a", "projectId": "prd-agent", "status": "success",
         "startedAt": "2026-07-21T10:00:00Z"},
        {"releaseId": "b", "projectId": "prd-agent", "status": "failed",
         "startedAt": "2026-07-22T10:00:00Z"},
        {"releaseId": "c", "projectId": "prd-agent", "status": "running",
         "startedAt": "2026-07-23T10:00:00Z"},   # 在途，不进分母
        {"releaseId": "d", "projectId": "other", "status": "success",
         "startedAt": "2026-07-24T10:00:00Z"},   # 他项目
    ]})
    out = m.collect_releases("prd-agent", "2026-07-20", "2026-07-26")
    assert out["available"] is True
    assert (out["attempts"], out["success"], out["failed"], out["inFlight"]) == (2, 1, 1, 1)
    assert out["successRate"] == 50.0
