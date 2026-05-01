"""Bugbot 第十二轮 — 三个 cdscli helper 修复回归。

Bug 1 (MED) `_verify_is_app_service` — 必须排除 init script / 配置文件挂载,与
TS 的 isAppSourceMount 对齐。否则 mysql 自带 `./init.sql:/docker-entrypoint-initdb.d/...`
被误归为 app,_verify_schemaful_db_migration 漏检。

Bug 2 (LOW) `_strip_dot_slash` — Python `lstrip("./")` 是按字符集删,不是按
前缀;`'../sibling'.lstrip('./')` 错变 `'sibling'`,丢掉 ../ 路径回溯。
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI_DIR = ROOT / "cli"
sys.path.insert(0, str(CLI_DIR))

import cdscli  # noqa: E402


# ── Bug 2: _strip_dot_slash ──────────────────────────────────────────


def test_strip_dot_slash_normal_prefix():
    assert cdscli._strip_dot_slash("./app") == "app"
    assert cdscli._strip_dot_slash("./api/src") == "api/src"


def test_strip_dot_slash_preserves_double_dot():
    """关键回归:`../sibling` 不能丢 ../"""
    assert cdscli._strip_dot_slash("../sibling") == "../sibling"
    assert cdscli._strip_dot_slash("../../parent") == "../../parent"


def test_strip_dot_slash_preserves_triple_dot():
    """`...hidden` 字符 lstrip 会变 'hidden',前缀剥应保留。"""
    assert cdscli._strip_dot_slash("...hidden") == "...hidden"


def test_strip_dot_slash_no_prefix():
    assert cdscli._strip_dot_slash("app") == "app"
    assert cdscli._strip_dot_slash("/abs/path") == "/abs/path"


def test_strip_dot_slash_empty_and_dot():
    assert cdscli._strip_dot_slash("") == ""
    assert cdscli._strip_dot_slash(".") == "."  # 单点不是 './' 前缀


# ── Bug 1: _verify_is_app_service ────────────────────────────────────


def test_verify_app_service_with_source_mount():
    """普通 ./app:/app 源码挂载 → app。"""
    svc = {"volumes": ["./app:/app"]}
    assert cdscli._verify_is_app_service(svc) is True


def test_verify_not_app_for_init_sql_mount():
    """关键回归:./init.sql:/docker-entrypoint-initdb.d/ 是 infra init 不是 app。"""
    svc = {"volumes": ["./init.sql:/docker-entrypoint-initdb.d/init.sql:ro"]}
    assert cdscli._verify_is_app_service(svc) is False


def test_verify_not_app_for_config_file_mount():
    """./redis.conf:/etc/redis.conf 是配置不是 app。"""
    svc = {"volumes": ["./redis.conf:/etc/redis/redis.conf"]}
    assert cdscli._verify_is_app_service(svc) is False


def test_verify_app_with_mixed_mounts():
    """有 init.sql + 真源码挂载混合 → 是 app(因为有真 source)。"""
    svc = {
        "volumes": [
            "./init.sql:/docker-entrypoint-initdb.d/init.sql:ro",
            "./src:/app/src",
        ]
    }
    assert cdscli._verify_is_app_service(svc) is True


def test_verify_not_app_for_named_volume():
    """命名 volume(mysql_data:/var/lib/mysql)不是相对挂载 → 不是 app。"""
    svc = {"volumes": ["mysql_data:/var/lib/mysql"]}
    assert cdscli._verify_is_app_service(svc) is False


def test_verify_not_app_for_etc_config_target():
    """目标 /etc/ 下的挂载是配置 → 不是 app。"""
    svc = {"volumes": ["./nginx.conf:/etc/nginx/nginx.conf:ro"]}
    assert cdscli._verify_is_app_service(svc) is False


def test_verify_not_app_for_no_volumes():
    svc = {"image": "redis:7"}
    assert cdscli._verify_is_app_service(svc) is False
    svc2 = {"volumes": []}
    assert cdscli._verify_is_app_service(svc2) is False
