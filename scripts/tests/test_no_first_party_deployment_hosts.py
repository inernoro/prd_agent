#!/usr/bin/env python3
"""Guard first-party deployment addresses and secret fallbacks out of runtime source."""

from __future__ import annotations

import pathlib
import re


REPO = pathlib.Path(__file__).resolve().parents[2]
RUNTIME_ROOTS = (
    REPO / "prd-admin" / "src",
    REPO / "prd-api" / "src",
    REPO / "prd-desktop" / "src",
    REPO / "prd-desktop" / "src-tauri" / "src",
    REPO / "llmgw" / "web" / "src",
)
TEXT_SUFFIXES = {".cs", ".json", ".ts", ".tsx"}
FORBIDDEN = {
    "first-party deployment domain": re.compile(
        r"(?:miduo\.org|ebcone\.(?:net|cn|com)|miduonet\.com)", re.IGNORECASE
    ),
    "private infrastructure address": re.compile(r"\b192\.168\.5\.\d{1,3}\b"),
}


def test_runtime_source_contains_no_first_party_deployment_hosts() -> None:
    failures: list[str] = []
    for root in RUNTIME_ROOTS:
        for path in root.rglob("*"):
            if not path.is_file() or path.suffix not in TEXT_SUFFIXES:
                continue
            relative_parts = path.relative_to(root).parts
            if any(part in {"__tests__", "bin", "obj", "tests"} for part in relative_parts):
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
            for label, pattern in FORBIDDEN.items():
                if match := pattern.search(text):
                    line = text.count("\n", 0, match.start()) + 1
                    failures.append(f"{path.relative_to(REPO)}:{line}: {label}")

    assert not failures, (
        "部署地址必须由运行时或构建配置注入，不得写回生产源码:\n  "
        + "\n  ".join(failures)
    )


def test_cds_compose_contains_no_internal_key_fallback() -> None:
    compose = (REPO / "cds-compose.yml").read_text(encoding="utf-8")
    assert "${LLMGW_SERVE_API_KEY:-" not in compose
    assert re.search(r'LlmGwServe__ApiKey:\s*"\$\{LLMGW_SERVE_API_KEY\}"', compose)


def test_admin_public_configuration_is_deployment_injected() -> None:
    dockerfile = (REPO / "prd-admin" / "Dockerfile").read_text(encoding="utf-8")
    compose = (REPO / "cds-compose.yml").read_text(encoding="utf-8")
    public_variables = (
        "VITE_CONTACT_EMAIL",
        "VITE_FRONT_END_PDA_LINKS_JSON",
        "VITE_FRONT_END_PROJECT_REGISTRY_JSON",
        "VITE_PA_LEARN_MORE_URL",
        "VITE_PUBLIC_DOCS_URL",
    )
    for variable in public_variables:
        assert f'ARG {variable}=""' in dockerfile
        assert f'{variable}: "${{{variable}:-}}"' in compose

    startup_script = (REPO / "prd-admin" / "scripts" / "start-static.mjs").read_text(
        encoding="utf-8"
    )
    index_html = (REPO / "prd-admin" / "index.html").read_text(encoding="utf-8")
    assert "runtime-config.js" in startup_script
    assert '<script src="/runtime-config.js"></script>' in index_html


def test_desktop_release_configuration_is_deployment_injected() -> None:
    workflow = (REPO / ".github" / "workflows" / "desktop-release.yml").read_text(
        encoding="utf-8"
    )
    assert "VITE_DESKTOP_API_BASE_URL: ${{ vars.PRD_AGENT_API_BASE_URL }}" in workflow
    assert "PRD_AGENT_API_BASE_URL: ${{ vars.PRD_AGENT_API_BASE_URL }}" in workflow
    assert "VITE_DESKTOP_PRESET_SERVERS_JSON: ${{ vars.PRD_AGENT_DESKTOP_PRESET_SERVERS_JSON }}" in workflow
    assert "repository variable PRD_AGENT_API_BASE_URL is required" in workflow


if __name__ == "__main__":
    test_runtime_source_contains_no_first_party_deployment_hosts()
    test_cds_compose_contains_no_internal_key_fallback()
    test_admin_public_configuration_is_deployment_injected()
    test_desktop_release_configuration_is_deployment_injected()
    print("deployment host and key fallback guard: pass")
