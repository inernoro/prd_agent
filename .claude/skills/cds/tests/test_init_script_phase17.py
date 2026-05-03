"""Phase 17 (F13/F14) — verify init script 识别 + schemaful-db-no-migration 收敛。

F13:`/docker-entrypoint-initdb.d/` 路径下的 init script 挂载在 verify 阶段
    有 INFO 级别确认提示(`infra-init-script-detected`),用户能看到 cdscli
    已经识别到 init.sql。

F14:`schemaful-db-no-migration` WARNING 在以下情况之一时不再报:
    a. 仓库里没 schemaful DB(原行为)
    b. 任意 infra service 已挂 init script 到 /docker-entrypoint-initdb.d/
       → 用户走"建表脚本注入"路径,不一定要 ORM migration

历史:用户 demo 故意走 init.sql,但 verify 一直 WARN 让用户以为漏配 ORM。
本 phase 让 cdscli 学会"init.sql 是合法的 schema 引导路径"。
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI_DIR = ROOT / "cli"
sys.path.insert(0, str(CLI_DIR))

import cdscli  # noqa: E402


# ── helper sample compose docs ───────────────────────────────────────


def _mysql_with_init_sql_doc():
    """MySQL infra 挂 init.sql + 一个不带 migration 的 app。"""
    return {
        "services": {
            "db": {
                "image": "mysql:8",
                "environment": {
                    "MYSQL_ROOT_PASSWORD": "${MYSQL_ROOT_PASSWORD}",
                    "MYSQL_DATABASE": "${MYSQL_DATABASE}",
                },
                "volumes": [
                    "./init.sql:/docker-entrypoint-initdb.d/init.sql:ro",
                    "mysql_data:/var/lib/mysql",
                ],
            },
            "app": {
                "image": "node:20",
                "ports": ["3000"],
                "command": "node server.js",
                "volumes": ["./app:/app"],
            },
        },
        "x-cds-env": {
            "MYSQL_ROOT_PASSWORD": "rootpw",
            "MYSQL_DATABASE": "app_db",
        },
    }


def _mysql_no_init_no_migration_doc():
    """MySQL infra 不挂 init script 且 app 不含 migration 关键词 → 应 WARN。"""
    return {
        "services": {
            "db": {
                "image": "mysql:8",
                "environment": {
                    "MYSQL_ROOT_PASSWORD": "${MYSQL_ROOT_PASSWORD}",
                    "MYSQL_DATABASE": "${MYSQL_DATABASE}",
                },
                "volumes": ["mysql_data:/var/lib/mysql"],
            },
            "app": {
                "image": "node:20",
                "ports": ["3000"],
                "command": "node server.js",
                "volumes": ["./app:/app"],
            },
        },
        "x-cds-env": {
            "MYSQL_ROOT_PASSWORD": "rootpw",
            "MYSQL_DATABASE": "app_db",
        },
    }


def _postgres_with_init_sql_doc():
    """Postgres infra 挂 init.sql,验证不限于 mysql。"""
    return {
        "services": {
            "db": {
                "image": "postgres:16",
                "environment": {"POSTGRES_PASSWORD": "${POSTGRES_PASSWORD}"},
                "volumes": ["./schema.sql:/docker-entrypoint-initdb.d/01-schema.sql:ro"],
            },
            "app": {
                "image": "python:3.12",
                "ports": ["8000"],
                "command": "python main.py",
                "volumes": ["./app:/app"],
            },
        },
        "x-cds-env": {"POSTGRES_PASSWORD": "secret"},
    }


def _no_db_doc():
    """没 schemaful DB,确保两个新规则都静默。"""
    return {
        "services": {
            "redis": {"image": "redis:7", "volumes": []},
            "app": {
                "image": "node:20",
                "ports": ["3000"],
                "command": "node server.js",
                "volumes": ["./app:/app"],
            },
        },
    }


# ── F14:schemaful-db-no-migration WARNING 收敛 ────────────────────────


def test_schemaful_db_warning_silenced_when_init_sql_mounted():
    """关键回归:有 init.sql 挂载时不再 WARN(原本会误报)。"""
    doc = _mysql_with_init_sql_doc()
    issues = cdscli._verify_run_all(doc, "/tmp")
    rules = [i["rule"] for i in issues]
    assert "schemaful-db-no-migration" not in rules, \
        f"挂了 init.sql 后不应再报 schemaful-db-no-migration,实际 issues: {issues}"


def test_schemaful_db_warning_still_fires_without_any_schema_source():
    """没 init script + 没 migration 关键词 → 仍然 WARN。"""
    doc = _mysql_no_init_no_migration_doc()
    issues = cdscli._verify_run_all(doc, "/tmp")
    rules = [i["rule"] for i in issues]
    assert "schemaful-db-no-migration" in rules


def test_schemaful_db_warning_silenced_for_postgres_with_init_sql():
    """Postgres + init.sql 同样不报。"""
    doc = _postgres_with_init_sql_doc()
    issues = cdscli._verify_run_all(doc, "/tmp")
    rules = [i["rule"] for i in issues]
    assert "schemaful-db-no-migration" not in rules


def test_no_db_no_schemaful_warning_at_all():
    """没 schemaful DB → 必然不报。"""
    doc = _no_db_doc()
    issues = cdscli._verify_run_all(doc, "/tmp")
    rules = [i["rule"] for i in issues]
    assert "schemaful-db-no-migration" not in rules


def test_schemaful_db_warning_message_offers_init_sql_alternative():
    """WARN 时 fix 文案应同时给 ORM migration 和 init.sql 两条路径。"""
    doc = _mysql_no_init_no_migration_doc()
    issues = cdscli._verify_run_all(doc, "/tmp")
    warn = [i for i in issues if i["rule"] == "schemaful-db-no-migration"]
    assert warn, "应该有 WARN"
    fix = warn[0]["fix"]
    assert "migration" in fix.lower()
    assert "init" in fix.lower()


# ── F13:init script 识别 INFO ────────────────────────────────────────


def test_init_script_info_emitted_when_mounted():
    """挂 init.sql 时 INFO 提示用户 cdscli 已识别。"""
    doc = _mysql_with_init_sql_doc()
    issues = cdscli._verify_run_all(doc, "/tmp")
    info = [i for i in issues if i["rule"] == "infra-init-script-detected"]
    assert len(info) == 1, f"期望 1 条 INFO,实际 {len(info)}: {info}"
    assert info[0]["severity"] == "INFO"
    assert info[0]["service"] == "db"
    assert "./init.sql" in info[0]["message"]
    assert "/docker-entrypoint-initdb.d/" in info[0]["message"]


def test_init_script_info_aggregates_multiple_scripts_per_service():
    """同 service 多条 init script 聚合成一行(避免噪音)。"""
    doc = {
        "services": {
            "db": {
                "image": "postgres:16",
                "environment": {"POSTGRES_PASSWORD": "${POSTGRES_PASSWORD}"},
                "volumes": [
                    "./schema.sql:/docker-entrypoint-initdb.d/01-schema.sql:ro",
                    "./seed.sql:/docker-entrypoint-initdb.d/02-seed.sql:ro",
                ],
            },
            "app": {
                "image": "python:3.12",
                "ports": ["8000"],
                "command": "python main.py",
                "volumes": ["./app:/app"],
            },
        },
        "x-cds-env": {"POSTGRES_PASSWORD": "secret"},
    }
    issues = cdscli._verify_run_all(doc, "/tmp")
    info = [i for i in issues if i["rule"] == "infra-init-script-detected"]
    assert len(info) == 1, "同 service 多脚本应聚合为一行"
    assert "./schema.sql" in info[0]["message"]
    assert "./seed.sql" in info[0]["message"]


def test_init_script_info_silent_when_no_mount():
    """没挂任何 init script → 不要噪音。"""
    doc = _no_db_doc()
    issues = cdscli._verify_run_all(doc, "/tmp")
    info = [i for i in issues if i["rule"] == "infra-init-script-detected"]
    assert info == []


def test_init_script_info_skips_unrelated_volumes():
    """普通 data volume 不应该触发 INFO。"""
    doc = {
        "services": {
            "db": {
                "image": "mysql:8",
                "environment": {"MYSQL_ROOT_PASSWORD": "p"},
                "volumes": ["mysql_data:/var/lib/mysql"],
            },
            "app": {
                "image": "node:20",
                "ports": ["3000"],
                "command": "npm run migrate && node server.js",
                "volumes": ["./app:/app"],
            },
        },
    }
    issues = cdscli._verify_run_all(doc, "/tmp")
    info = [i for i in issues if i["rule"] == "infra-init-script-detected"]
    assert info == []


# ── 直接测 helper ────────────────────────────────────────────────────


def test_collect_init_script_mounts_returns_pairs():
    infra = {
        "db": {
            "image": "mysql:8",
            "volumes": [
                "./init.sql:/docker-entrypoint-initdb.d/init.sql:ro",
                "mysql_data:/var/lib/mysql",
            ],
        },
        "redis": {"image": "redis:7", "volumes": []},
    }
    out = cdscli._collect_init_script_mounts(infra)
    assert ("db", "./init.sql") in out
    # 数据卷不算 init script
    assert all(src.startswith("./") or src == "." for _svc, src in out)
    assert len(out) == 1


def test_collect_init_script_mounts_handles_missing_or_bad_volumes():
    """缺 volumes / 非 list / 非 str 元素都要安全处理。"""
    infra_a: dict = {"db": {"image": "mysql:8"}}
    assert cdscli._collect_init_script_mounts(infra_a) == []
    infra_b: dict = {"db": {"image": "mysql:8", "volumes": "not-a-list"}}
    assert cdscli._collect_init_script_mounts(infra_b) == []
    infra_c: dict = {"db": {"image": "mysql:8", "volumes": [None, 42]}}
    assert cdscli._collect_init_script_mounts(infra_c) == []


# ── Bugbot fix(2026-05-04 PR #523)— 窄前缀: 只算真 DB init script ──


def test_collect_init_script_mounts_excludes_etc_config():
    """关键回归:挂 `./redis.conf:/etc/redis/redis.conf` 不算 DB init script
    (虽然 /etc/ 在 _is_app_source_mount 的 _INIT_SCRIPT_TARGET_PREFIXES 里)。"""
    infra = {
        "redis": {
            "image": "redis:7",
            "volumes": ["./redis.conf:/etc/redis/redis.conf:ro"],
        },
    }
    assert cdscli._collect_init_script_mounts(infra) == []


def test_collect_init_script_mounts_excludes_usr_local_etc():
    """同上,/usr/local/etc/ 也不算 DB init。"""
    infra = {
        "x": {"image": "img:1", "volumes": ["./conf:/usr/local/etc/x/x.conf:ro"]},
    }
    assert cdscli._collect_init_script_mounts(infra) == []


def test_collect_init_script_mounts_excludes_init_dir():
    """/init/ 是自定义 init 路径(_is_app_source_mount 用),不算 DB schema init。"""
    infra = {
        "x": {"image": "img:1", "volumes": ["./bootstrap.sh:/init/bootstrap.sh:ro"]},
    }
    assert cdscli._collect_init_script_mounts(infra) == []


def test_schemaful_db_warning_still_fires_when_only_redis_conf_mounted():
    """关键回归:mysql + 单独挂 redis.conf 到 /etc/(非 DB init)→ 仍应 WARN。

    之前用宽前缀时,redis.conf 在 /etc/ 会误命中 init script 检测,
    F14 short-circuit 触发,WARN 被错误抑制。窄前缀修复后应恢复 WARN。
    """
    doc = {
        "services": {
            "db": {
                "image": "mysql:8",
                "environment": {"MYSQL_ROOT_PASSWORD": "${MYSQL_ROOT_PASSWORD}"},
                "volumes": ["mysql_data:/var/lib/mysql"],  # 仅 data volume,无 init.sql
            },
            "redis": {
                "image": "redis:7",
                "volumes": ["./redis.conf:/etc/redis/redis.conf:ro"],  # 配置 ≠ init
            },
            "app": {
                "image": "node:20",
                "ports": ["3000"],
                "command": "node server.js",
                "volumes": ["./app:/app"],
            },
        },
        "x-cds-env": {"MYSQL_ROOT_PASSWORD": "p"},
    }
    issues = cdscli._verify_run_all(doc, "/tmp")
    rules = [i["rule"] for i in issues]
    assert "schemaful-db-no-migration" in rules, \
        "redis.conf 不算 DB init script,WARN 应仍然触发"


def test_init_script_info_only_for_db_initdb_path():
    """F13 INFO 只对 /docker-entrypoint-initdb.d/ 触发,不对 /etc/ 等触发。"""
    doc = {
        "services": {
            "db": {
                "image": "mysql:8",
                "environment": {"MYSQL_ROOT_PASSWORD": "p"},
                "volumes": [
                    "./init.sql:/docker-entrypoint-initdb.d/init.sql:ro",  # 真 init
                    "./my.cnf:/etc/mysql/my.cnf:ro",                        # 配置,不该触发
                ],
            },
        },
    }
    issues = cdscli._verify_run_all(doc, "/tmp")
    info = [i for i in issues if i["rule"] == "infra-init-script-detected"]
    assert len(info) == 1
    # message 里只应提到 init.sql,不应提到 my.cnf
    assert "init.sql" in info[0]["message"]
    assert "my.cnf" not in info[0]["message"]


# ── Bugbot 第五轮 fix(2026-05-04 PR #523):F14 short-circuit 必须按 DB 区分 ──


def test_f14_warning_fires_when_only_mongo_has_init_but_mysql_doesnt():
    """关键回归:mysql(无 init)+ mongodb(有 init.js)同存,mysql 仍应 WARN。

    之前 _verify_schemaful_db_migration 用 _collect_init_script_mounts(全部 infra)
    short-circuit,mongodb 的 init.js 让 short-circuit 触发,mysql 的 WARN
    被错误抑制。本 fix 改成只看 schemaful DB(mysql/postgres 等)自身的 init mount。
    """
    doc = {
        "services": {
            "mysql": {  # schemaful,无 init
                "image": "mysql:8",
                "environment": {"MYSQL_ROOT_PASSWORD": "${MYSQL_ROOT_PASSWORD}"},
                "volumes": ["mysql_data:/var/lib/mysql"],
            },
            "mongodb": {  # schemaless,有 init.js — 不应抑制 mysql 的 WARN
                "image": "mongo:7",
                "volumes": ["./mongo-init.js:/docker-entrypoint-initdb.d/init.js:ro"],
            },
            "app": {
                "image": "node:20",
                "ports": ["3000"],
                "command": "node server.js",
                "volumes": ["./app:/app"],
            },
        },
        "x-cds-env": {"MYSQL_ROOT_PASSWORD": "p"},
    }
    issues = cdscli._verify_run_all(doc, "/tmp")
    rules = [i["rule"] for i in issues]
    assert "schemaful-db-no-migration" in rules, \
        "mysql 自身没 init.sql,不能因 mongodb 的 init.js 就免 WARN"


def test_f14_warning_silenced_when_mysql_has_init_even_with_mongo():
    """对照测试:mysql 自己挂了 init.sql + mongodb 也有 init.js → 正确抑制。"""
    doc = {
        "services": {
            "mysql": {
                "image": "mysql:8",
                "environment": {"MYSQL_ROOT_PASSWORD": "${MYSQL_ROOT_PASSWORD}"},
                "volumes": [
                    "./init.sql:/docker-entrypoint-initdb.d/init.sql:ro",
                    "mysql_data:/var/lib/mysql",
                ],
            },
            "mongodb": {
                "image": "mongo:7",
                "volumes": ["./mongo-init.js:/docker-entrypoint-initdb.d/init.js:ro"],
            },
            "app": {
                "image": "node:20",
                "ports": ["3000"],
                "command": "node server.js",
                "volumes": ["./app:/app"],
            },
        },
        "x-cds-env": {"MYSQL_ROOT_PASSWORD": "p"},
    }
    issues = cdscli._verify_run_all(doc, "/tmp")
    rules = [i["rule"] for i in issues]
    assert "schemaful-db-no-migration" not in rules


def test_f14_warning_fires_when_mongo_has_init_but_postgres_doesnt():
    """同上但 schemaful DB 是 postgres(确认 mysql 不是 schemaful 的唯一定义)。"""
    doc = {
        "services": {
            "postgres": {
                "image": "postgres:16",
                "environment": {"POSTGRES_PASSWORD": "${POSTGRES_PASSWORD}"},
                "volumes": ["pgdata:/var/lib/postgresql/data"],
            },
            "mongodb": {
                "image": "mongo:7",
                "volumes": ["./mongo-init.js:/docker-entrypoint-initdb.d/init.js:ro"],
            },
            "app": {
                "image": "python:3.12",
                "ports": ["8000"],
                "command": "python main.py",
                "volumes": ["./app:/app"],
            },
        },
        "x-cds-env": {"POSTGRES_PASSWORD": "p"},
    }
    issues = cdscli._verify_run_all(doc, "/tmp")
    rules = [i["rule"] for i in issues]
    assert "schemaful-db-no-migration" in rules


def test_is_schemaful_db_image_helper():
    """新 helper 直接测:image 字符串识别 schemaful DB 家族(substring 匹配)。"""
    assert cdscli._is_schemaful_db_image("mysql:8") is True
    assert cdscli._is_schemaful_db_image("mariadb:11") is True
    assert cdscli._is_schemaful_db_image("postgres:16") is True
    assert cdscli._is_schemaful_db_image("postgresql:16") is True
    assert cdscli._is_schemaful_db_image("mcr.microsoft.com/mssql/server") is True
    assert cdscli._is_schemaful_db_image("oracle/database:21") is True
    assert cdscli._is_schemaful_db_image("ibmcom/db2:latest") is True
    # schemaless / 非 DB
    assert cdscli._is_schemaful_db_image("mongo:7") is False
    assert cdscli._is_schemaful_db_image("redis:7") is False
    assert cdscli._is_schemaful_db_image("nginx:alpine") is False
    # 异常输入
    assert cdscli._is_schemaful_db_image(None) is False
    assert cdscli._is_schemaful_db_image(123) is False
    assert cdscli._is_schemaful_db_image("") is False
