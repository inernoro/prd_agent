"""Bugbot 第十一轮 Bug 1 — 每个 app 只 wait-for 它实际引用的 infra。

历史问题:`schemaful_targets` 是全局扁平列表(所有 schemaful DB + redis/mongo/rabbitmq),
之前每个 app 都被无脑套上 wait-for 全集 + depends_on 全集。frontend 只用 redis 也被
注入 `until nc -z mysql 3306`,白白等死掉的依赖,启动慢且不准确。

修复:`_detect_app_infra_deps(env_dict, explicit_deps, schemaful_targets)` 按
app 实际引用(env 值里的 hostname 或显式 depends_on)裁剪 targets。
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI_DIR = ROOT / "cli"
sys.path.insert(0, str(CLI_DIR))

import cdscli  # noqa: E402  (import after sys.path tweak)


def test_empty_env_falls_back_to_all():
    """app 没 env 也没显式 deps → 保守兜底:全部 targets 仍 wait(避免漏 dep 造成静默崩溃)。"""
    targets = [("mysql", "3306"), ("redis", "6379")]
    deps = cdscli._detect_app_infra_deps({}, [], targets)
    assert deps == targets


def test_no_targets_returns_empty():
    targets = []
    deps = cdscli._detect_app_infra_deps({"DATABASE_URL": "mysql://x@mysql:3306/db"}, [], targets)
    assert deps == []


def test_url_form_matches_hostname():
    targets = [("mysql", "3306"), ("redis", "6379"), ("mongodb", "27017")]
    env = {"DATABASE_URL": "mysql://user:pass@mysql:3306/myapp"}
    deps = cdscli._detect_app_infra_deps(env, [], targets)
    assert ("mysql", "3306") in deps
    assert ("redis", "6379") not in deps
    assert ("mongodb", "27017") not in deps


def test_redis_only_excludes_mysql_and_mongo():
    """frontend 只用 redis → 不应再 wait mysql / mongo(原 spam 的 bug 场景)。"""
    targets = [("mysql", "3306"), ("redis", "6379"), ("mongodb", "27017")]
    env = {"REDIS_URL": "redis://redis:6379"}
    deps = cdscli._detect_app_infra_deps(env, [], targets)
    assert deps == [("redis", "6379")]


def test_ado_net_form_matches():
    """SQL Server ADO.NET 字符串 `Server=mysql,3306;User=...`"""
    targets = [("mysql", "3306")]
    env = {"CONN_STR": "Server=mysql,3306;User=root;Password=pwd"}
    deps = cdscli._detect_app_infra_deps(env, [], targets)
    assert deps == [("mysql", "3306")]


def test_direct_host_form_matches():
    """KEY=hostname 直接形式(MYSQL_HOST=mysql)"""
    targets = [("mysql", "3306"), ("redis", "6379")]
    env = {"MYSQL_HOST": "mysql", "REDIS_HOST": "redis"}
    deps = cdscli._detect_app_infra_deps(env, [], targets)
    assert ("mysql", "3306") in deps
    assert ("redis", "6379") in deps


def test_explicit_depends_on_wins_when_env_misses():
    """env 用 ${VAR} 模板看不到主机名,但显式 depends_on 仍能锚定。"""
    targets = [("postgres", "5432")]
    env = {"DATABASE_URL": "${DATABASE_URL}"}  # 模板,无法静态解析 host
    deps = cdscli._detect_app_infra_deps(env, ["postgres"], targets)
    assert deps == [("postgres", "5432")]


def test_unrelated_substring_not_matched():
    """target 名 'mysql' 不应匹配 'mysqltools' 这种包含子串的环境值。"""
    targets = [("mysql", "3306")]
    env = {"DOC_URL": "https://docs.mysqltools.example/"}
    deps = cdscli._detect_app_infra_deps(env, [], targets)
    assert deps == []


def test_env_present_but_no_match_returns_empty():
    """env 非空但都没引用 infra → 不 wait,不依赖(信任 env 已完整声明)。"""
    targets = [("mysql", "3306"), ("redis", "6379")]
    env = {"PORT": "3000", "NODE_ENV": "production"}
    deps = cdscli._detect_app_infra_deps(env, [], targets)
    assert deps == []
