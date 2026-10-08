"""CDS verify runtime credential alias regressions."""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI_DIR = ROOT / "cli"
sys.path.insert(0, str(CLI_DIR))

import cdscli  # noqa: E402


def _app_with_redis_credentials() -> dict:
    return {
        "image": "example/app:latest",
        "volumes": [".:/repo"],
        "environment": {
            "Redis__ConnectionString": (
                "${CDS_HOST}:${CDS_REDIS_PORT},"
                "user=${CDS_REDIS_USER},password=${CDS_REDIS_PASSWORD}"
            ),
        },
    }


def test_declared_infra_runtime_credentials_are_not_unresolved():
    document = {
        "services": {
            "api": _app_with_redis_credentials(),
            "redis": {"image": "redis:7-alpine"},
        },
    }

    issues = cdscli._verify_run_all(document, ".")

    unresolved = [
        issue for issue in issues
        if issue.get("rule") == "env-var-unresolved"
        and issue.get("meta", {}).get("var") in {
            "CDS_REDIS_USER",
            "CDS_REDIS_PASSWORD",
        }
    ]
    runtime_infos = [
        issue for issue in issues
        if issue.get("rule") == "env-var-cds-runtime"
    ]
    assert unresolved == []
    assert {"CDS_REDIS_USER", "CDS_REDIS_PASSWORD"}.issubset({
        var
        for issue in runtime_infos
        for var in cdscli._verify_extract_var_refs(issue.get("message", ""))
    })
    credential_infos = [
        issue for issue in runtime_infos
        if "CDS_REDIS_USER" in issue.get("message", "")
        or "CDS_REDIS_PASSWORD" in issue.get("message", "")
    ]
    assert all("localhost" not in issue.get("fix", "") for issue in credential_infos)
    assert all("项目 env" in issue.get("fix", "") for issue in credential_infos)


def test_unknown_runtime_credential_alias_still_fails():
    document = {
        "services": {
            "api": _app_with_redis_credentials(),
        },
    }

    issues = cdscli._verify_run_all(document, ".")

    unresolved_vars = {
        issue.get("meta", {}).get("var")
        for issue in issues
        if issue.get("rule") == "env-var-unresolved"
    }
    assert "CDS_REDIS_USER" in unresolved_vars
    assert "CDS_REDIS_PASSWORD" in unresolved_vars


def test_hyphenated_infra_id_matches_server_alias_derivation():
    aliases = cdscli._verify_runtime_credential_vars({"redis-2": {}})

    assert aliases == {"CDS_REDIS_2_USER", "CDS_REDIS_2_PASSWORD"}
