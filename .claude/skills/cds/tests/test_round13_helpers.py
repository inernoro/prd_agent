"""Bugbot 第十三轮 — cdscli 两个分类/提示 helper 修复回归。

Bug 1 (LOW) `_verify_dependsOn_hint` 把"声明任何 DB depends_on"当作
全部 infra 都已声明,导致 redis 已声明就不再 hint 缺失的 postgres。
应仅按当前 url_keys 候选 infra 判定。

Bug 2 (LOW) `${VAR:-default}` 这种带 fallback 的引用被无条件标 required,
忽略 _classify_env_kind 的 fallback 兼容判定。
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI_DIR = ROOT / "cli"
sys.path.insert(0, str(CLI_DIR))

import cdscli  # noqa: E402


# ── Bug 1: _verify_dependsOn_hint per-candidate suppression ──────────


def test_verify_dependsOn_redis_only_does_not_silence_postgres():
    """关键回归:声明 depends_on:[redis] 不应静音 DATABASE_URL 缺 postgres 的 hint。"""
    app_services = {
        "api": {
            "environment": {
                "DATABASE_URL": "${DATABASE_URL}",
                "REDIS_URL": "redis://redis:6379",
            },
            "depends_on": ["redis"],  # 只声明了 redis
        }
    }
    infra_services = {"postgres": {}, "redis": {}}
    issues = cdscli._verify_dependsOn_hint(app_services, infra_services)
    # 应该 hint postgres 缺(DATABASE_URL 候选 [postgres,mysql,mariadb] 没在 deps 里)
    assert any("postgres" in i["message"] for i in issues), \
        f"应当 hint postgres,但 issues = {issues}"


def test_verify_dependsOn_postgres_declared_silences_database_url_hint():
    """声明了 postgres → DATABASE_URL hint 应静音(命中候选)。"""
    app_services = {
        "api": {
            "environment": {"DATABASE_URL": "${DATABASE_URL}"},
            "depends_on": ["postgres"],
        }
    }
    infra_services = {"postgres": {}}
    issues = cdscli._verify_dependsOn_hint(app_services, infra_services)
    assert not issues, f"声明了 postgres 不应再 hint,但 issues = {issues}"


def test_verify_dependsOn_mysql_declared_silences_database_url_hint():
    """DATABASE_URL 候选 [postgres,mysql,mariadb] —— 声明 mysql 也算命中。"""
    app_services = {
        "api": {
            "environment": {"DATABASE_URL": "mysql://u@mysql:3306/db"},
            "depends_on": ["mysql"],
        }
    }
    infra_services = {"mysql": {}}
    issues = cdscli._verify_dependsOn_hint(app_services, infra_services)
    assert not issues


def test_verify_dependsOn_no_db_dep_hints():
    """没声明任何 DB → 应该 hint。"""
    app_services = {
        "api": {
            "environment": {"DATABASE_URL": "${DATABASE_URL}"},
            "depends_on": [],
        }
    }
    infra_services = {"postgres": {}}
    issues = cdscli._verify_dependsOn_hint(app_services, infra_services)
    assert len(issues) == 1
    assert "postgres" in issues[0]["message"]


# ── Bug 2: classify_env_kind respects fallback default ───────────────


def test_classify_env_kind_with_fallback_default_is_auto():
    """`${LOG_LEVEL:-info}` fallback=info → kind=auto,不该 block 用户。"""
    kind, _ = cdscli._classify_env_kind("LOG_LEVEL", "info", is_password=False)
    assert kind == "auto"


def test_classify_env_kind_secret_key_no_fallback_is_required():
    """无 fallback + secret 关键词 key → required(deploy block 用户必填)。"""
    kind, _ = cdscli._classify_env_kind("SMTP_PASSWORD", None, is_password=False)
    assert kind == "required"
    kind, _ = cdscli._classify_env_kind("OAUTH_SECRET", None, is_password=False)
    assert kind == "required"


def test_classify_env_kind_non_secret_no_fallback_is_auto():
    """非密钥 key 无 fallback → auto,不阻塞 deploy(应用如有内置默认就跑)。"""
    kind, _ = cdscli._classify_env_kind("LOG_LEVEL", None, is_password=False)
    assert kind == "auto"
    kind, _ = cdscli._classify_env_kind("FEATURE_FLAGS", None, is_password=False)
    assert kind == "auto"


def test_classify_env_kind_todo_marker_is_required():
    """fallback=TODO 占位符 → required(用户没填实际值)。"""
    kind, _ = cdscli._classify_env_kind("API_TOKEN", "TODO: 填实际值", is_password=False)
    assert kind == "required"


def test_classify_env_kind_template_ref_is_infra_derived():
    """fallback 含 ${VAR} → infra-derived(由 CDS 推导,不该用户填)。"""
    kind, _ = cdscli._classify_env_kind("DATABASE_URL", "${POSTGRES_URL}", is_password=False)
    assert kind == "infra-derived"
