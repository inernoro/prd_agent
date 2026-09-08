"""plan.cds.service-relations 第一批：生成器按模块扫前缀、verify 接服务端体检、topology 文字树。"""

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "cli"))

import cdscli  # noqa: E402


def _write(base: Path, rel: str, text: str) -> None:
    fp = base / rel
    fp.parent.mkdir(parents=True, exist_ok=True)
    fp.write_text(text, encoding="utf-8")


def test_detect_spring_route_prefixes_from_controllers_skips_probe(tmp_path):
    mod = tmp_path / "admin-api"
    _write(mod, "src/main/java/a/OpenController.java",
           '@RestController\n@RequestMapping("/open")\npublic class OpenController {}\n')
    _write(mod, "src/main/java/a/ApiController.java",
           '@RestController\n@RequestMapping(value = "/api/v1/users")\npublic class ApiController {}\n')
    _write(mod, "src/main/java/a/HealthController.java",
           '@RestController\n@RequestMapping("/health")\npublic class HealthController {}\n')
    _write(mod, "src/main/java/a/NoClassMapping.java",
           '@Controller\npublic class X { @GetMapping("/partner/list") public void a() {} }\n')
    _write(mod, "src/main/java/a/Service.java", 'public class Service {}\n')
    assert cdscli._detect_spring_route_prefixes(str(mod)) == ["/api/", "/open/", "/partner/"]


def test_detect_spring_route_prefixes_context_path_wins(tmp_path):
    mod = tmp_path / "svc"
    _write(mod, "src/main/resources/application.yml", "server:\n  servlet:\n    context-path: /vendor-api\n")
    _write(mod, "src/main/java/a/C.java", '@RestController\n@RequestMapping("/open")\nclass C {}\n')
    assert cdscli._detect_spring_route_prefixes(str(mod)) == ["/vendor-api/"]


def test_detect_spring_route_prefixes_empty_when_no_source(tmp_path):
    assert cdscli._detect_spring_route_prefixes(str(tmp_path / "nothing")) == []


def test_yaml_from_modules_java_prefixes_per_module_no_probe_no_plural_label(tmp_path):
    root = tmp_path / "repo"
    _write(root, "imp-api/src/main/java/a/C.java", '@RestController\n@RequestMapping("/api")\nclass C {}\n')
    _write(root, "imp-api/src/main/java/a/H.java", '@RestController\n@RequestMapping("/actuator")\nclass H {}\n')
    _write(root, "open-api/src/main/java/a/O.java", '@RestController\n@RequestMapping("/open")\nclass O {}\n')
    modules = [
        {"dir": "imp-api", "kind": "java", "image": "maven:3.9-eclipse-temurin-17", "port": "8080", "confidence": "high"},
        {"dir": "open-api", "kind": "java", "image": "maven:3.9-eclipse-temurin-17", "port": "8081", "confidence": "high"},
        {"dir": "bare-api", "kind": "java", "image": "maven:3.9-eclipse-temurin-17", "port": "8082", "confidence": "high"},
    ]
    yaml_text = cdscli._yaml_from_modules(str(root), modules)
    assert 'cds.path-prefixes' not in yaml_text, "复数标签从未被 CDS 解析，不该再生成"
    assert '/health' not in yaml_text and '/actuator' not in yaml_text
    prefix_lines = [ln.strip() for ln in yaml_text.splitlines() if ln.strip().startswith("cds.path-prefix:")]
    assert any('"/api/"' in ln and "扫出" in ln for ln in prefix_lines)
    assert any('"/open/"' in ln for ln in prefix_lines)
    # 没扫到前缀的模块：不是第一个 Java 模块，兜底按名字分前缀并带 TODO，不能和别人共用同一前缀
    bare = [ln for ln in prefix_lines if "TODO" in ln]
    assert len(bare) == 1 and '"/bare-api/"' in bare[0]
    declared = [ln.split('"')[1] for ln in prefix_lines]
    assert len(declared) == len(set(declared))


def test_verify_server_lint_maps_findings_and_prefixes_rule(monkeypatch):
    monkeypatch.setenv("CDS_HOST", "cds.example")
    monkeypatch.setattr(cdscli, "_has_cds_auth", lambda: True)
    captured = {}

    def fake_request(method, path, body=None, timeout=15, extra_headers=None, fatal_network_errors=True):
        captured.update({"method": method, "path": path, "body": body, "fatal": fatal_network_errors})
        return 200, {"findings": [
            {"rule": "prefix-conflict", "severity": "error", "services": ["a", "b"], "message": "m", "fix": "f"},
            {"rule": "role-by-name", "severity": "info", "services": ["a"], "message": "m2", "fix": "f2"},
        ], "summary": {"errors": 1, "warnings": 0, "infos": 1}}, {}

    monkeypatch.setattr(cdscli, "_request", fake_request)
    issues = cdscli._verify_server_lint("services:\n  a:\n    build: .\n")
    assert captured["method"] == "POST" and captured["path"] == "/api/compose/lint"
    assert captured["fatal"] is False
    assert issues[0] == {"severity": "ERROR", "service": "a,b", "rule": "topology/prefix-conflict", "message": "m", "fix": "f"}
    assert issues[1]["severity"] == "INFO"


def test_verify_server_lint_skipped_without_connection(monkeypatch):
    monkeypatch.delenv("CDS_HOST", raising=False)
    issues = cdscli._verify_server_lint("services: {}")
    assert [i["rule"] for i in issues] == ["topology-lint-skipped"]
    assert issues[0]["severity"] == "INFO"


def test_verify_server_lint_degrades_on_server_error(monkeypatch):
    monkeypatch.setenv("CDS_HOST", "cds.example")
    monkeypatch.setattr(cdscli, "_has_cds_auth", lambda: True)
    monkeypatch.setattr(cdscli, "_request", lambda *a, **k: (404, {"error": "not_found"}, {}))
    issues = cdscli._verify_server_lint("services: {}")
    assert issues[0]["rule"] == "topology-lint-unavailable" and issues[0]["severity"] == "INFO"


def test_topology_tree_lines_render_sites_internal_and_findings():
    payload = {
        "branch": "main", "branchId": "mdimp-main",
        "graph": {
            "nodes": [
                {"kind": "service", "rawId": "imp-admin", "role": "web", "roleSource": "route"},
                {"kind": "service", "rawId": "imp-api", "role": "api", "roleSource": "name"},
                {"kind": "service", "rawId": "cb-web", "role": "web", "roleSource": "route"},
                {"kind": "service", "rawId": "cb-api", "role": "api", "roleSource": "name"},
                {"kind": "service", "rawId": "seed", "role": "worker", "roleSource": "name"},
            ],
            "edges": [{"from": "service:cb-web", "to": "service:cb-api", "envKeys": ["API_BASE"], "dependsOn": False}],
            "sites": [
                {"kind": "main", "shellId": "imp-admin", "shellSource": "declared", "members": [{"id": "imp-api", "prefixes": ["/api/", "/open/"]}], "conflicts": []},
                {"kind": "subdomain", "subdomain": "cb", "shellId": "cb-web", "shellSource": "declared", "members": [], "conflicts": []},
            ],
            "internal": ["cb-api", "seed"],
        },
        "lint": {"findings": [{"rule": "orphan-service", "severity": "warn", "services": ["seed"], "message": "游离", "fix": "声明 cds.role"}],
                 "summary": {"errors": 0, "warnings": 1, "infos": 0}},
    }
    text = "\n".join(cdscli._topology_tree_lines(payload))
    assert "主域名  壳 imp-admin (WEB, 路由事实)" in text
    assert "/api/ /open/ → imp-api (API, 名字)" in text
    assert "子域 cb  壳 cb-web" in text
    assert "内网 被 cb-web 调用 → cb-api" in text
    assert "内网 游离 → seed (WORKER, 名字)   <警告: orphan-service>" in text
    assert "体检：0 错误 · 1 警告 · 0 建议" in text
    assert "修法：声明 cds.role" in text
