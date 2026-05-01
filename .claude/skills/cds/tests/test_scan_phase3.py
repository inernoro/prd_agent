"""Phase 3 cdscli scan 增强测试(2026-05-01)。

跑法:python3 -m pytest .claude/skills/cds/tests/test_scan_phase3.py -v

4 个 fixture 场景:
  1. 已有 cds-compose.yml SSOT → 直读不动
  2. mysql + init.sql + webpack(端口错位)→ volumes carry-over + wait-for + 端口检测
  3. command 已含 wait-for/nc → 不重复添加(幂等)
  4. _gen_password 无 `!` 后缀,无需 url-encode 即可塞进连接串

不测的场景(留给后续 phase / verify 测试覆盖):
  - apply-to-cds POST 链路(Phase 4)
  - ORM migration 命令注入(Phase 4)
  - 复杂 monorepo 子目录扫描(已被 _detect_modules 覆盖,本次未改)
"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

CLI = Path(__file__).resolve().parents[1] / "cli" / "cdscli.py"
assert CLI.exists(), f"cdscli.py 不存在: {CLI}"


def run_scan(root: str) -> dict:
    """跑 cdscli scan,解析 JSON 输出。"""
    proc = subprocess.run(
        [sys.executable, str(CLI), "scan", root],
        capture_output=True, text=True, timeout=30,
    )
    # cdscli ok/die 都打 JSON 到 stdout
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        raise AssertionError(f"cdscli scan 输出不是 JSON\nstdout: {proc.stdout!r}\nstderr: {proc.stderr!r}")


# ─────────────────────────────────────────────────────────
# Scenario 1: cds-compose.yml SSOT 直读
# ─────────────────────────────────────────────────────────

def test_scenario_1_cds_compose_ssot_direct_read():
    """根目录已有 cds-compose.yml → scan 直接 echo,不重新生成。"""
    with tempfile.TemporaryDirectory() as tmp:
        custom_yaml = """\
# 用户手写的 cds-compose,这一行是 SSOT 标记
services:
  custom-app:
    image: my/own:tag
    volumes:
      - "./:/app"
    ports:
      - "9999"
"""
        Path(tmp, "cds-compose.yml").write_text(custom_yaml)

        result = run_scan(tmp)
        assert result["ok"] is True
        assert result["data"]["signals"]["source"] == "cds-compose.yml"
        # 内容应原样返回,标记字符串保留
        yaml_out = result["data"]["yaml"]
        assert "用户手写的 cds-compose,这一行是 SSOT 标记" in yaml_out
        assert "custom-app" in yaml_out
        assert "my/own:tag" in yaml_out


# ─────────────────────────────────────────────────────────
# Scenario 2: mysql + init.sql + 应用所有字段 carry-over
# ─────────────────────────────────────────────────────────

def test_scenario_2_mysql_with_init_sql_and_wait_for():
    """完整 mysql + 应用场景:volumes/wait-for/working_dir/command/depends_on 全部 carry。"""
    with tempfile.TemporaryDirectory() as tmp:
        Path(tmp, "init.sql").write_text("CREATE TABLE users (id INT);")
        Path(tmp, "backend").mkdir()
        Path(tmp, "backend", "package.json").write_text(
            json.dumps({"name": "backend", "scripts": {"dev": "node server.js"}})
        )
        Path(tmp, "docker-compose.yml").write_text("""\
services:
  mysql:
    image: mysql:8.0
    ports:
      - "3306:3306"
    environment:
      MYSQL_ROOT_PASSWORD: dev123
    volumes:
      - "./init.sql:/docker-entrypoint-initdb.d/init.sql:ro"
      - "mysql_data:/var/lib/mysql"
  backend:
    image: node:20
    working_dir: /app
    volumes:
      - "./backend:/app"
    ports:
      - "3000"
    environment:
      DATABASE_URL: mysql://root:dev123@mysql:3306/app
    command: npm run dev
    depends_on:
      - mysql
""")
        result = run_scan(tmp)
        assert result["ok"] is True
        yaml_out = result["data"]["yaml"]

        # mysql infra: volumes carry over
        assert "init.sql:/docker-entrypoint-initdb.d/init.sql:ro" in yaml_out
        assert "mysql_data:/var/lib/mysql" in yaml_out
        assert "init.sql 已挂到" in yaml_out

        # 模板替换:image 从 mysql:8.0 → mysql:8(推荐镜像)
        assert "image: mysql:8" in yaml_out

        # x-cds-env 自动生成密码且无 `!` 后缀
        # 抓 MYSQL_PASSWORD 的值
        import re
        m = re.search(r'MYSQL_PASSWORD:\s*"([^"]+)"', yaml_out)
        assert m, "MYSQL_PASSWORD 应该自动生成"
        password = m.group(1)
        assert "!" not in password, f"密码不应该含 `!`(Phase 3 修复),实际: {password!r}"
        # 长度 22 + 仅 url-safe 字符
        assert len(password) == 22, f"token_urlsafe(16) 出 22 字符,实际: {len(password)}"
        assert re.match(r'^[A-Za-z0-9_-]+$', password), f"密码应只含 url-safe 字符,实际: {password!r}"

        # backend app: working_dir / volumes / command / depends_on 全部 carry
        assert "working_dir: /app" in yaml_out
        assert "./backend:/app" in yaml_out
        # wait-for 前缀:nc -z mysql 3306
        assert "until nc -z mysql 3306" in yaml_out
        assert "npm run dev" in yaml_out
        # sh -c 包裹(含 &&;Phase 7 B9 fix 起从 bash 改 sh,POSIX 通用)
        assert "command: sh -c" in yaml_out
        # depends_on
        assert "- mysql" in yaml_out

        # environment:DATABASE_URL 被替换成模板引用
        assert "${DATABASE_URL}" in yaml_out
        # 不再有原 docker-compose 的硬编码密码
        assert "dev123" not in yaml_out, "硬编码密码不应出现在生成的 yaml 里"

        # 端口来源标注
        assert "端口推断来源" in yaml_out


# ─────────────────────────────────────────────────────────
# Scenario 3: command 已含 wait-for → 不重复添加(幂等)
# ─────────────────────────────────────────────────────────

def test_scenario_3_idempotent_wait_for_not_duplicated():
    """用户 docker-compose 已经在 command 里写了 nc -z 等待,scan 不重复加。"""
    with tempfile.TemporaryDirectory() as tmp:
        Path(tmp, "backend").mkdir()
        Path(tmp, "backend", "package.json").write_text("{}")
        Path(tmp, "docker-compose.yml").write_text("""\
services:
  postgres:
    image: postgres:16
    ports:
      - "5432:5432"
    environment:
      POSTGRES_PASSWORD: dev123
  backend:
    image: node:20
    working_dir: /app
    volumes:
      - "./backend:/app"
    ports:
      - "3000"
    command: until nc -z postgres 5432; do sleep 2; done && node server.js
""")
        result = run_scan(tmp)
        assert result["ok"] is True
        yaml_out = result["data"]["yaml"]

        # 应当只出现一次 nc -z postgres,不被前缀两次
        nc_count = yaml_out.count("nc -z postgres")
        assert nc_count == 1, f"wait-for 应幂等只出现 1 次,实际: {nc_count} 次"

        # 用户原 sleep 2 应保留(不被覆盖成 sleep 1)
        assert "sleep 2" in yaml_out
        assert "node server.js" in yaml_out


# ─────────────────────────────────────────────────────────
# Scenario 4: 密码 url-safe + url-encode helper 单测
# ─────────────────────────────────────────────────────────

def test_scenario_4_password_url_safe_no_escape_needed():
    """_gen_password 出来的密码不含 unsafe 字符,直接塞连接串无需 url-encode。"""
    # 直接 import 测 helper(不走 subprocess)
    sys.path.insert(0, str(CLI.parent))
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("cdscli", CLI)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)

        # 多次生成验证不含 url-unsafe
        for _ in range(20):
            pwd = mod._gen_password()
            assert "!" not in pwd, "Phase 3 已移除 ! 后缀"
            assert "@" not in pwd
            assert "/" not in pwd  # token_urlsafe 用 - _ 不用 /
            assert "?" not in pwd
            assert "&" not in pwd
            # 长度稳定 22(token_urlsafe(16) 出 22 字符)
            assert len(pwd) == 22

        # _url_encode_password 对含特殊字符的输入正确编码
        assert mod._url_encode_password("p@ss!w/d") == "p%40ss%21w%2Fd"
        assert mod._url_encode_password("simple") == "simple"
        assert mod._url_encode_password("") == ""
    finally:
        sys.path.pop(0)


# ─────────────────────────────────────────────────────────
# Scenario 5(bonus):端口检测 — 缺 ports 段时从 webpack 推断
# ─────────────────────────────────────────────────────────

def test_scenario_5_port_detect_from_webpack_when_compose_ports_missing():
    """compose 没写 ports → 从应用源码 webpack.config.js 推断真实端口。"""
    with tempfile.TemporaryDirectory() as tmp:
        Path(tmp, "frontend").mkdir()
        Path(tmp, "frontend", "package.json").write_text(
            json.dumps({"name": "fe", "scripts": {"dev": "webpack-dev-server"}})
        )
        Path(tmp, "frontend", "webpack.config.js").write_text("""
module.exports = {
  devServer: {
    port: 8000,
    host: "0.0.0.0"
  }
};
""")
        Path(tmp, "docker-compose.yml").write_text("""\
services:
  frontend:
    image: node:20
    working_dir: /app
    volumes:
      - "./frontend:/app"
    command: pnpm dev
""")
        # 注意:这里故意没写 ports
        result = run_scan(tmp)
        assert result["ok"] is True
        yaml_out = result["data"]["yaml"]

        # 推断结果应该是 8000(从 webpack devServer.port)
        assert '- "8000"' in yaml_out, f"端口应推断为 8000(webpack),实际:\n{yaml_out}"
        assert "端口推断来源: webpack:" in yaml_out


if __name__ == "__main__":
    sys.exit(__import__("pytest").main([__file__, "-v"]))
