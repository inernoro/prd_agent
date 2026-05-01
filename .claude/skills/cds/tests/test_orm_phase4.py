"""Phase 4(2026-05-01)— ORM 识别 + migration 注入 + dev/prod 模式测试。

跑法:python3 -m pytest .claude/skills/cds/tests/test_orm_phase4.py -v

7 个 case 覆盖:
  1. _detect_orm 识别 prisma(根目录 schema.prisma)
  2. _detect_orm 识别 ef-core(.csproj 含 Microsoft.EntityFrameworkCore)
  3. _detect_orm 识别 typeorm(package.json 含 typeorm)
  4. _detect_orm 识别 sequelize(package.json 含 sequelize-cli)
  5. _detect_orm 识别 rails(Gemfile 含 rails)
  6. _wrap_with_migration 幂等 — 原 command 已含 migrate 时不重复注入
  7. 端到端 e2e:scan + prisma + mysql 输出含 migration 前缀 + dev/prod 模式
"""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

CLI = Path(__file__).resolve().parents[1] / "cli" / "cdscli.py"


def _load_cdscli():
    """import cdscli 作 module 以测内部 helper。"""
    spec = importlib.util.spec_from_file_location("cdscli", CLI)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ─────────────────────────────────────────────────────────
# Case 1-5: _detect_orm 识别各 ORM
# ─────────────────────────────────────────────────────────

def test_detect_prisma():
    mod = _load_cdscli()
    with tempfile.TemporaryDirectory() as tmp:
        os.makedirs(os.path.join(tmp, "prisma"))
        Path(tmp, "prisma", "schema.prisma").write_text("// prisma schema")
        result = mod._detect_orm(tmp)
        assert result is not None
        assert result["kind"] == "prisma"
        assert result["migrate_cmd"] == "npx prisma migrate deploy"
        assert result["seed_cmd"] == "npx prisma db seed"


def test_detect_ef_core():
    mod = _load_cdscli()
    with tempfile.TemporaryDirectory() as tmp:
        os.makedirs(os.path.join(tmp, "src"))
        Path(tmp, "src", "App.csproj").write_text(
            '<Project>\n  <PackageReference Include="Microsoft.EntityFrameworkCore" Version="8.0.0" />\n</Project>'
        )
        result = mod._detect_orm(tmp)
        assert result is not None
        assert result["kind"] == "ef-core"
        assert "dotnet ef database update" in result["migrate_cmd"]
        assert "dotnet tool restore" in result["migrate_cmd"]


def test_detect_typeorm():
    mod = _load_cdscli()
    with tempfile.TemporaryDirectory() as tmp:
        Path(tmp, "package.json").write_text(json.dumps({
            "name": "api",
            "dependencies": {"typeorm": "^0.3.0"},
            "scripts": {"migration:run": "typeorm migration:run"},
        }))
        result = mod._detect_orm(tmp)
        assert result is not None
        assert result["kind"] == "typeorm"
        assert "npm run migration:run" in result["migrate_cmd"]


def test_detect_sequelize():
    mod = _load_cdscli()
    with tempfile.TemporaryDirectory() as tmp:
        Path(tmp, "package.json").write_text(json.dumps({
            "name": "api",
            "dependencies": {"sequelize-cli": "^6.0.0"},
        }))
        result = mod._detect_orm(tmp)
        assert result is not None
        assert result["kind"] == "sequelize"
        assert result["seed_cmd"] == "npx sequelize-cli db:seed:all"


def test_detect_rails():
    mod = _load_cdscli()
    with tempfile.TemporaryDirectory() as tmp:
        Path(tmp, "Gemfile").write_text("source 'https://rubygems.org'\ngem 'rails', '~> 7.0'\n")
        result = mod._detect_orm(tmp)
        assert result is not None
        assert result["kind"] == "rails"
        assert "rails db:migrate" in result["migrate_cmd"]


def test_detect_no_orm_returns_none():
    """空目录 / 无 ORM 标志返回 None。"""
    mod = _load_cdscli()
    with tempfile.TemporaryDirectory() as tmp:
        # 普通 Node 项目无 ORM
        Path(tmp, "package.json").write_text('{"name": "plain"}')
        result = mod._detect_orm(tmp)
        assert result is None


# ─────────────────────────────────────────────────────────
# Case 6: _wrap_with_migration 幂等
# ─────────────────────────────────────────────────────────

def test_wrap_with_migration_idempotent():
    """原 command 已含 prisma migrate 字样时不重复注入。"""
    mod = _load_cdscli()
    prisma = {"kind": "prisma", "migrate_cmd": "npx prisma migrate deploy"}

    # 命中 — 注入
    out1 = mod._wrap_with_migration("npm run dev", prisma)
    assert out1 == "npx prisma migrate deploy && npm run dev"

    # 已含 prisma migrate — 不重复
    out2 = mod._wrap_with_migration("npx prisma migrate deploy && npm run dev", prisma)
    assert out2 == "npx prisma migrate deploy && npm run dev"  # 原样

    # 已含 dotnet ef — 不重复(即使是其它 ORM 命令)
    ef = {"kind": "ef-core", "migrate_cmd": "dotnet tool restore && dotnet ef database update"}
    out3 = mod._wrap_with_migration("dotnet ef database update && dotnet run", ef)
    assert out3 == "dotnet ef database update && dotnet run"

    # ORM 为 None — 原样
    out4 = mod._wrap_with_migration("npm run dev", None)
    assert out4 == "npm run dev"

    # ORM 无 migrate_cmd(如 flyway)— 原样
    flyway = {"kind": "flyway", "migrate_cmd": None}
    out5 = mod._wrap_with_migration("npm run dev", flyway)
    assert out5 == "npm run dev"


# ─────────────────────────────────────────────────────────
# Case 7: e2e — scan prisma + mysql 完整链路
# ─────────────────────────────────────────────────────────

def _run_scan(root: str) -> dict:
    proc = subprocess.run(
        [sys.executable, str(CLI), "scan", root],
        capture_output=True, text=True, timeout=30,
    )
    return json.loads(proc.stdout)


def test_e2e_prisma_mysql_full_pipeline():
    """端到端:Prisma + MySQL 项目 → wait-for + migrate + 原 command + dev/prod 模式。"""
    with tempfile.TemporaryDirectory() as tmp:
        # Prisma 项目结构
        os.makedirs(os.path.join(tmp, "backend", "prisma"))
        Path(tmp, "backend", "prisma", "schema.prisma").write_text(
            'generator client { provider = "prisma-client-js" }\n'
            'datasource db { provider = "mysql"; url = env("DATABASE_URL") }\n'
        )
        Path(tmp, "backend", "package.json").write_text(json.dumps({
            "name": "backend",
            "scripts": {"dev": "node server.js"},
            "prisma": {"seed": "node prisma/seed.js"},
        }))
        Path(tmp, "docker-compose.yml").write_text("""\
services:
  mysql:
    image: mysql:8
    ports: ['3306']
    environment:
      MYSQL_ROOT_PASSWORD: dev
  backend:
    image: node:20
    working_dir: /app
    volumes: ['./backend:/app']
    ports: ['3000']
    environment:
      DATABASE_URL: mysql://root:dev@mysql:3306/app
    command: npm run dev
""")

        result = _run_scan(tmp)
        assert result["ok"] is True
        signals = result["data"]["signals"]
        yaml_out = result["data"]["yaml"]

        # signal 字段
        assert signals["orms"] == {"backend": "prisma"}
        assert "mysql" in signals["schemafulInfra"]
        assert "backend" in signals["deployModes"]

        # base command:wait-for + migrate + 原(prod 友好,无 seed)
        assert "until nc -z mysql 3306" in yaml_out
        assert "npx prisma migrate deploy" in yaml_out
        assert "npm run dev" in yaml_out
        # 不应在 base command 出现 seed
        # 检查方式:prod 模式下的 base 不含 db seed
        # 但 dev mode 段应该含
        assert "x-cds-deploy-modes:" in yaml_out
        assert "Dev(含 seed 数据库种子)" in yaml_out
        assert "npx prisma db seed" in yaml_out  # 在 dev mode 段

        # 注释提示带文档链接
        assert "Prisma ORM" in yaml_out
        assert "prisma.io" in yaml_out


def test_e2e_no_orm_no_migration_no_dev_mode():
    """没 ORM 的项目:不注入 migrate,不输出 deploy-modes。"""
    with tempfile.TemporaryDirectory() as tmp:
        os.makedirs(os.path.join(tmp, "backend"))
        Path(tmp, "backend", "package.json").write_text('{"name": "backend"}')
        Path(tmp, "docker-compose.yml").write_text("""\
services:
  redis:
    image: redis:7
    ports: ['6379']
  backend:
    image: node:20
    working_dir: /app
    volumes: ['./backend:/app']
    ports: ['3000']
    command: npm start
""")
        result = _run_scan(tmp)
        assert result["ok"] is True
        yaml_out = result["data"]["yaml"]
        signals = result["data"]["signals"]

        assert not signals.get("orms")  # 无 ORM
        assert not signals.get("deployModes")
        assert "x-cds-deploy-modes:" not in yaml_out
        # 但 redis 仍应触发 wait-for(redis 也在 schemaful_targets 里)
        assert "until nc -z redis 6379" in yaml_out
        assert "npm start" in yaml_out
        # 不含任何 ORM migration 命令
        assert "prisma migrate" not in yaml_out
        assert "dotnet ef" not in yaml_out


if __name__ == "__main__":
    sys.exit(__import__("pytest").main([__file__, "-v"]))
