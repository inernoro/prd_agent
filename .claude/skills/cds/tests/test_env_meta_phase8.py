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
    """postgres infra 的密码字段必须 kind=auto(cdscli 自动生成,Phase 8 命名规范走 CDS_*)。"""
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
        # CDS_POSTGRES_PASSWORD 必须 kind=auto
        meta_match = re.search(
            r"CDS_POSTGRES_PASSWORD:\s*\n\s*kind:\s*(\w+)", yaml_out
        )
        assert meta_match, f"找不到 CDS_POSTGRES_PASSWORD meta:\n{yaml_out}"
        assert meta_match.group(1) == "auto", \
            f"CDS_POSTGRES_PASSWORD 应该 auto,实际 {meta_match.group(1)}"


def test_database_url_marked_infra_derived():
    """CDS_DATABASE_URL = postgresql://...${CDS_POSTGRES_PASSWORD}... 是 infra-derived。"""
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

        # CDS_DATABASE_URL 含 ${} 引用 → infra-derived
        meta_match = re.search(
            r"CDS_DATABASE_URL:\s*\n\s*kind:\s*([\w-]+)", yaml_out
        )
        assert meta_match, f"找不到 CDS_DATABASE_URL meta:\n{yaml_out}"
        assert meta_match.group(1) == "infra-derived", \
            f"CDS_DATABASE_URL 应该 infra-derived,实际 {meta_match.group(1)}"


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


def test_ai_access_key_only_when_app_references_it():
    """Bugbot fix(PR #521 第五轮)— AI_ACCESS_KEY 不再默认注入到所有项目。

    之前 cdscli 把 AI_ACCESS_KEY="TODO: 请填写实际值" 强加到 common_env,
    导致每个项目即使不用 AI 也被 deploy 412 block 必填。修复后只有当用户
    docker-compose 真的引用了 ${AI_ACCESS_KEY} 时,_collect_required_envs
    才会注入它。
    """
    # 场景 1:不引用 → 不应该出现在 yaml 里
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
        assert "AI_ACCESS_KEY" not in yaml_out, \
            f"未引用时不应注入 AI_ACCESS_KEY:\n{yaml_out}"

    # 场景 2:引用 → 自动识别为 required
    with tempfile.TemporaryDirectory() as d:
        compose = """
services:
  app:
    build: .
    environment:
      AI_ACCESS_KEY: ${AI_ACCESS_KEY}
"""
        Path(d, "docker-compose.yml").write_text(compose)
        Path(d, "Dockerfile").write_text("FROM node:20")
        result = run_scan(d)
        yaml_out = result["data"]["yaml"]
        ai_meta = re.search(r"AI_ACCESS_KEY:\s*\n\s*kind:\s*(\w+)", yaml_out)
        assert ai_meta, f"app 引用 ${{AI_ACCESS_KEY}} 时应被识别注入"
        assert ai_meta.group(1) == "required"


def test_jwt_secret_marked_auto():
    """CDS_JWT_SECRET 是 cdscli 自动生成(is_password=True)→ auto(Phase 8 命名规范)。"""
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

        jwt_meta = re.search(r"CDS_JWT_SECRET:\s*\n\s*kind:\s*(\w+)", yaml_out)
        assert jwt_meta, f"找不到 CDS_JWT_SECRET meta"
        assert jwt_meta.group(1) == "auto"


def test_skeleton_yaml_has_env_meta():
    """无 docker-compose 的项目走 skeleton 路径,也必须输出 env-meta。

    Bugbot fix(PR #521 第五轮)— skeleton 也不再默认注入 AI_ACCESS_KEY,
    只保留 CDS_JWT_SECRET(auto-generated,所有项目都用得着 + 不阻塞 deploy)。
    """
    with tempfile.TemporaryDirectory() as d:
        # 完全空目录 → skeleton
        result = run_scan(d)
        yaml_out = result["data"]["yaml"]

        assert "x-cds-env-meta:" in yaml_out, f"skeleton 也要有 env-meta:\n{yaml_out}"
        # CDS_JWT_SECRET 应该 auto(自动生成,不 block deploy)
        assert re.search(r"CDS_JWT_SECRET:\s*\n\s*kind:\s*auto", yaml_out), \
            "skeleton 的 CDS_JWT_SECRET 应该 auto"
        # AI_ACCESS_KEY 不应被默认注入(只有用户引用才注入)
        assert "AI_ACCESS_KEY" not in yaml_out, \
            f"skeleton 不应默认注入 AI_ACCESS_KEY:\n{yaml_out}"


if __name__ == "__main__":
    import pytest
    sys.exit(pytest.main([__file__, "-x", "-v"]))


# Bugbot regression(PR #521 第六轮)— cdscli `_classify_env_kind` 占位符检测
# 必须 case-insensitive,与 state.ts isPlaceholderValue 保持一致。否则跨语言
# boundary 不一致:cdscli 看 "Todo: fill" 不命中 → kind=auto(不 block);
# state.ts 后端看就命中 → 已加占位符进容器,silently 进生产。
def test_classify_env_kind_placeholder_case_insensitive():
    """case-insensitive 占位符检测,不论用户用大小写都能识别。"""
    import sys
    cli_dir = str(ROOT / "cli")
    if cli_dir not in sys.path:
        sys.path.insert(0, cli_dir)
    import cdscli  # noqa

    # 各种大小写变体都应被识别为占位符 → required
    placeholder_variants = [
        "TODO: fill",
        "Todo: fill",
        "todo: fill",
        "tOdO: fill",
        "<your-secret>",
        "<Your-Secret>",
        "<YOUR_SECRET>",
        "请填写实际值",
        "Replace_Me",
        "replace_me",
    ]
    for v in placeholder_variants:
        kind, _ = cdscli._classify_env_kind("SOME_KEY", v, False)
        assert kind == "required", f"{v!r} 应识别为占位符 (required),实际 {kind}"

    # 真实值不应被误判
    real_values = ["sk-abc123", "postgresql://real-host:5432/db", "production-secret"]
    for v in real_values:
        kind, _ = cdscli._classify_env_kind("SOME_KEY", v, False)
        assert kind != "required" or "todo" in v.lower() or "请填写" in v, \
            f"{v!r} 是真实值,不应识别为占位符 (required)"


# Bugbot regression(PR #521,2026-05-01)— _classify_env_kind 之前对所有空 default
# 都返回 ("required", ...),secret 检测是死代码。修复后:secret 关键词命中 →
# required(强制 deploy block);其它空值 → auto(不阻塞 deploy,只软提示)。
def test_classify_env_kind_secret_vs_non_secret_empty_default():
    """直接 import 测试 _classify_env_kind 的分支:空 default 时密钥才 required。"""
    import sys
    cli_dir = str(ROOT / "cli")
    if cli_dir not in sys.path:
        sys.path.insert(0, cli_dir)
    import cdscli  # noqa

    # 密钥关键词命中 → required
    for k in ("SMTP_PASSWORD", "OAUTH_CLIENT_SECRET", "API_KEY", "GITHUB_TOKEN"):
        kind, hint = cdscli._classify_env_kind(k, None, False)
        assert kind == "required", f"{k} 应该 required,实际 {kind}"
        assert "生成" in hint, f"{k} 的 hint 应该提示「生成」按钮,实际 {hint!r}"

    # 非密钥的空值 → auto(不阻塞 deploy)
    for k in ("LOG_LEVEL", "FEATURE_FLAG_X", "DEBUG_MODE", "TIMEZONE"):
        kind, hint = cdscli._classify_env_kind(k, None, False)
        assert kind == "auto", f"{k} 应该 auto(非密钥),实际 {kind}"
        assert "空值" in hint, f"{k} 的 hint 应该提到空值,实际 {hint!r}"

    # is_password=True 仍走 auto(cdscli 自动生成,不需要用户填)
    kind, _ = cdscli._classify_env_kind("X", None, True)
    assert kind == "auto"
