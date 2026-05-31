"""WS5 — cdscli verify --fix 自愈回归。

验证 `_verify_autofix` 对可自动修复的 issue(env-var-unresolved / depends-on-hint)
产出修补后的 doc + diff,对不可自动修的 issue 降级为建议清单。
SSOT:doc/spec.cds-compose-contract.md § 4.5。
"""
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI_DIR = ROOT / "cli"
sys.path.insert(0, str(CLI_DIR))

import cdscli  # noqa: E402


def _write_compose(text: str) -> str:
    d = tempfile.mkdtemp()
    p = os.path.join(d, "cds-compose.yml")
    with open(p, "w", encoding="utf-8") as f:
        f.write(text)
    return p


def test_env_var_unresolved_autofixed_with_placeholder():
    """缺默认值的 ${VAR} → x-cds-env 补占位,标记需人工复核。"""
    compose = (
        "services:\n"
        "  api:\n"
        "    image: node:20-alpine\n"
        "    ports: ['3000']\n"
        "    volumes: ['./api:/app']\n"
        "    environment:\n"
        "      TOKEN: ${SECRET_TOKEN}\n"
    )
    path = _write_compose(compose)
    doc = {
        "services": {
            "api": {
                "image": "node:20-alpine",
                "ports": ["3000"],
                "volumes": ["./api:/app"],
                "environment": {"TOKEN": "${SECRET_TOKEN}"},
            }
        }
    }
    issues = [{
        "severity": "ERROR", "service": "api", "rule": "env-var-unresolved",
        "message": "...", "fix": "...", "meta": {"var": "SECRET_TOKEN"},
    }]
    heal = cdscli._verify_autofix(path, doc, issues)
    assert len(heal["autoFixed"]) == 1
    assert heal["autoFixed"][0]["rule"] == "env-var-unresolved"
    assert heal["needsReview"] is True  # 占位值需人工
    assert "SECRET_TOKEN: CHANGE_ME" in heal["patchedYaml"]
    assert "SECRET_TOKEN" in heal["diff"]
    assert heal["manual"] == []


def test_depends_on_hint_autofixed_no_review():
    compose = (
        "services:\n"
        "  api:\n"
        "    image: node:20-alpine\n"
        "    ports: ['3000']\n"
        "    volumes: ['./api:/app']\n"
        "    environment:\n"
        "      MONGODB_URL: mongodb://mongodb:27017/app\n"
        "  mongodb:\n"
        "    image: mongo:8.0\n"
    )
    path = _write_compose(compose)
    doc = {
        "services": {
            "api": {
                "image": "node:20-alpine", "ports": ["3000"],
                "volumes": ["./api:/app"],
                "environment": {"MONGODB_URL": "mongodb://mongodb:27017/app"},
            },
            "mongodb": {"image": "mongo:8.0"},
        }
    }
    issues = [{
        "severity": "INFO", "service": "api", "rule": "depends-on-hint",
        "message": "...", "fix": "...", "meta": {"service": "api", "infra": "mongodb"},
    }]
    heal = cdscli._verify_autofix(path, doc, issues)
    assert len(heal["autoFixed"]) == 1
    assert heal["needsReview"] is False
    assert "mongodb" in heal["patchedYaml"]
    # api 服务现在应声明 depends_on
    assert doc_has_depends(heal["patchedYaml"])


def doc_has_depends(yaml_text: str) -> bool:
    import yaml
    d = yaml.safe_load(yaml_text)
    deps = d["services"]["api"].get("depends_on")
    if isinstance(deps, dict):
        return "mongodb" in deps
    return "mongodb" in (deps or [])


def test_non_autofixable_rule_becomes_manual_suggestion():
    """app-ports-missing 需真实端口,不能机器修 → 进 manual 建议清单。"""
    compose = "services:\n  api:\n    image: node:20-alpine\n    volumes: ['./api:/app']\n"
    path = _write_compose(compose)
    doc = {"services": {"api": {"image": "node:20-alpine", "volumes": ["./api:/app"]}}}
    issues = [{
        "severity": "ERROR", "service": "api", "rule": "app-ports-missing",
        "message": "缺 ports", "fix": "加 ports 段",
    }]
    heal = cdscli._verify_autofix(path, doc, issues)
    assert heal["autoFixed"] == []
    assert len(heal["manual"]) == 1
    assert heal["manual"][0]["rule"] == "app-ports-missing"
    assert heal["manual"][0]["fix"] == "加 ports 段"


def test_fixer_without_meta_degrades_to_manual():
    """env-var-unresolved 但 meta 缺失 → fixer 放弃 → 降级建议,不崩。"""
    compose = "services:\n  api:\n    image: x\n    volumes: ['./api:/app']\n    ports: ['3000']\n"
    path = _write_compose(compose)
    doc = {"services": {"api": {"image": "x", "volumes": ["./api:/app"], "ports": ["3000"]}}}
    issues = [{
        "severity": "ERROR", "service": "api", "rule": "env-var-unresolved",
        "message": "...", "fix": "...",  # 无 meta
    }]
    heal = cdscli._verify_autofix(path, doc, issues)
    assert heal["autoFixed"] == []
    assert len(heal["manual"]) == 1


def test_duplicate_env_var_both_counted_as_fixed():
    """同一变量出现两次时,第二条 issue 也应被计为已修而非降级为 manual。"""
    compose = (
        "services:\n"
        "  api:\n"
        "    image: node:20-alpine\n"
        "    ports: ['3000']\n"
        "    volumes: ['./api:/app']\n"
        "    environment:\n"
        "      TOKEN: ${SECRET_TOKEN}\n"
        "    command: sh -c 'echo ${SECRET_TOKEN}'\n"
    )
    path = _write_compose(compose)
    doc = {
        "services": {
            "api": {
                "image": "node:20-alpine", "ports": ["3000"],
                "volumes": ["./api:/app"],
                "environment": {"TOKEN": "${SECRET_TOKEN}"},
                "command": "sh -c 'echo ${SECRET_TOKEN}'",
            }
        }
    }
    # 同一变量被 verify 检测出两条 ERROR(environment + command 各一条)
    issues = [
        {"severity": "ERROR", "service": "api", "rule": "env-var-unresolved",
         "message": "...", "fix": "...", "meta": {"var": "SECRET_TOKEN"}},
        {"severity": "ERROR", "service": "api", "rule": "env-var-unresolved",
         "message": "...", "fix": "...", "meta": {"var": "SECRET_TOKEN"}},
    ]
    heal = cdscli._verify_autofix(path, doc, issues)
    # 两条都应进 autoFixed,manual 为空
    assert len(heal["autoFixed"]) == 2
    assert heal["manual"] == []
    assert "SECRET_TOKEN: CHANGE_ME" in heal["patchedYaml"]


def test_gate_uses_remaining_issues_after_write():
    """--fix --write 后门禁应基于剩余 issue,全部修完则 ERROR 降为 0。"""
    issues = [
        {"severity": "ERROR", "service": None, "rule": "env-var-unresolved",
         "message": "...", "fix": "...", "meta": {"var": "SECRET"}},
        {"severity": "WARNING", "service": "api", "rule": "app-no-healthcheck",
         "message": "...", "fix": "..."},
    ]
    auto_fixed = [{"rule": "env-var-unresolved", "service": None, "applied": "补了 SECRET"}]

    # 模拟 cmd_verify 里 --fix --write 后的过滤逻辑
    fixed_counter: dict = {}
    for fx in auto_fixed:
        k = (fx.get("rule"), fx.get("service"))
        fixed_counter[k] = fixed_counter.get(k, 0) + 1
    remaining = []
    pending = dict(fixed_counter)
    for iss in issues:
        k = (iss.get("rule"), iss.get("service"))
        if pending.get(k, 0) > 0:
            pending[k] -= 1
        else:
            remaining.append(iss)

    assert len(remaining) == 1
    assert remaining[0]["severity"] == "WARNING"

    gate_score = cdscli._verify_score(remaining)
    assert gate_score["score"] == 92   # 100 - 8(WARNING) = 92
    assert gate_score["grade"] == "A"

    gate_errors = sum(1 for i in remaining if i["severity"] == "ERROR")
    assert gate_errors == 0  # ERROR 已修,门禁应通过
