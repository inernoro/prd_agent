"""Phase 8 — env 三色 metadata 验证

cdscli scan 输出必须含 x-cds-env-meta 段,把 env 分成 auto/required/infra-derived 三类:
  - required:用户必填,CDS 弹窗 block deploy 直到全填
  - auto:cdscli 自动生成(密码或字面量默认值)
  - infra-derived:由 ${VAR} 引用其他 infra 推导
"""
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "cli" / "cdscli.py"
assert CLI.exists()


def run_scan(project_dir: str) -> dict:
    """跑 cdscli scan,返回 JSON 输出。"""
    result = subprocess.run(
        [sys.executable, str(CLI), "scan", project_dir],
        capture_output=True, text=True
    )
    assert result.returncode == 0, f"scan 失败: {result.stderr}"
    return json.loads(result.stdout)


def test_postgres_password_marked_auto():
    """postgres infra 的密码字段必须 kind=auto(cdscli 自动生成)。"""
    with tempfile.TemporaryDirectory() as d:
        # 写一个最小 docker-compose 含 postgres
        compose = """
services:
  app:
    build: .
    environment:
      DATABASE_URL: postgresql://postgres:secret@db:5432/app
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: secret
"""
        Path(d, "docker-compose.yml").write_text(compose)
        Path(d, "Dockerfile").write_text("FROM node:20")

        result = run_scan(d)
        yaml_out = result["data"]["yaml"]

        # 必须含 x-cds-env-meta
        assert "x-cds-env-meta:" in yaml_out, f"缺少 env-meta 段:\n{yaml_out}"
        # POSTGRES_PASSWORD 必须 kind=auto
        meta_match = re.search(
            r"POSTGRES_PASSWORD:\s*\n\s*kind:\s*(\w+)", yaml_out
        )
        assert meta_match, f"找不到 POSTGRES_PASSWORD meta:\n{yaml_out}"
        assert meta_match.group(1) == "auto", \
            f"POSTGRES_PASSWORD 应该 auto,实际 {meta_match.group(1)}"


def test_database_url_marked_infra_derived():
    """DATABASE_URL = postgresql://...${POSTGRES_PASSWORD}... 是 infra-derived。"""
    with tempfile.TemporaryDirectory() as d:
        compose = """
services:
  app:
    build: .
  db:
    image: postgres:16
"""
        Path(d, "docker-compose.yml").write_text(compose)
        Path(d, "Dockerfile").write_text("FROM node:20")

        result = run_scan(d)
        yaml_out = result["data"]["yaml"]

        # DATABASE_URL 含 ${} 引用 → infra-derived
        meta_match = re.search(
            r"DATABASE_URL:\s*\n\s*kind:\s*([\w-]+)", yaml_out
        )
        assert meta_match, f"找不到 DATABASE_URL meta:\n{yaml_out}"
        assert meta_match.group(1) == "infra-derived", \
            f"DATABASE_URL 应该 infra-derived,实际 {meta_match.group(1)}"


def test_user_secret_marked_required():
    """app env 引用 ${SMTP_PASSWORD} 但 cdscli 没生成 → 必须标 required。"""
    with tempfile.TemporaryDirectory() as d:
        compose = """
services:
  app:
    build: .
    environment:
      SMTP_PASSWORD: ${SMTP_PASSWORD}
      OAUTH_GITHUB_SECRET: ${OAUTH_GITHUB_SECRET}
  db:
    image: postgres:16
"""
        Path(d, "docker-compose.yml").write_text(compose)
        Path(d, "Dockerfile").write_text("FROM node:20")

        result = run_scan(d)
        yaml_out = result["data"]["yaml"]

        # SMTP_PASSWORD 应该被识别 + 加进 x-cds-env(空值) + meta=required
        assert "SMTP_PASSWORD:" in yaml_out, f"SMTP_PASSWORD 应该被注入到 x-cds-env"
        smtp_meta = re.search(r"SMTP_PASSWORD:\s*\n\s*kind:\s*(\w+)", yaml_out)
        assert smtp_meta, f"找不到 SMTP_PASSWORD meta"
        assert smtp_meta.group(1) == "required", \
            f"SMTP_PASSWORD 应该 required,实际 {smtp_meta.group(1)}"

        oauth_meta = re.search(r"OAUTH_GITHUB_SECRET:\s*\n\s*kind:\s*(\w+)", yaml_out)
        assert oauth_meta, f"找不到 OAUTH_GITHUB_SECRET meta"
        assert oauth_meta.group(1) == "required"


def test_ai_access_key_default_required():
    """AI_ACCESS_KEY 是 cdscli 内置 common_env 里 default='TODO',应该 required。"""
    with tempfile.TemporaryDirectory() as d:
        compose = """
services:
  app:
    build: .
"""
        Path(d, "docker-compose.yml").write_text(compose)
        Path(d, "Dockerfile").write_text("FROM node:20")

        result = run_scan(d)
        yaml_out = result["data"]["yaml"]

        ai_meta = re.search(r"AI_ACCESS_KEY:\s*\n\s*kind:\s*(\w+)", yaml_out)
        assert ai_meta, f"找不到 AI_ACCESS_KEY meta:\n{yaml_out}"
        assert ai_meta.group(1) == "required", \
            f"AI_ACCESS_KEY 应该 required,实际 {ai_meta.group(1)}"


def test_jwt_secret_marked_auto():
    """JWT_SECRET 是 cdscli 自动生成(is_password=True)→ auto。"""
    with tempfile.TemporaryDirectory() as d:
        compose = """
services:
  app:
    build: .
"""
        Path(d, "docker-compose.yml").write_text(compose)
        Path(d, "Dockerfile").write_text("FROM node:20")

        result = run_scan(d)
        yaml_out = result["data"]["yaml"]

        jwt_meta = re.search(r"JWT_SECRET:\s*\n\s*kind:\s*(\w+)", yaml_out)
        assert jwt_meta, f"找不到 JWT_SECRET meta"
        assert jwt_meta.group(1) == "auto"


def test_skeleton_yaml_has_env_meta():
    """无 docker-compose 的项目走 skeleton 路径,也必须输出 env-meta。"""
    with tempfile.TemporaryDirectory() as d:
        # 完全空目录 → skeleton
        result = run_scan(d)
        yaml_out = result["data"]["yaml"]

        assert "x-cds-env-meta:" in yaml_out, f"skeleton 也要有 env-meta:\n{yaml_out}"
        assert re.search(r"AI_ACCESS_KEY:\s*\n\s*kind:\s*required", yaml_out), \
            "skeleton 的 AI_ACCESS_KEY 应该 required"
        assert re.search(r"JWT_SECRET:\s*\n\s*kind:\s*auto", yaml_out), \
            "skeleton 的 JWT_SECRET 应该 auto"


if __name__ == "__main__":
    import pytest
    sys.exit(pytest.main([__file__, "-x", "-v"]))
