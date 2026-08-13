import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "cli"))

import cdscli  # noqa: E402


def _service(labels):
    return {"image": "node:20", "build": ".", "ports": ["8000"], "labels": labels}


def test_verify_rejects_health_page_as_user_entry():
    issues = cdscli._verify_web_entries({
        "web": _service({
            "cds.path-prefix": "/",
            "cds.web-entry-name": "管理端",
            "cds.web-entry-path": "/healthz",
            "cds.readiness-path": "/healthz",
        }),
    })
    assert [issue["rule"] for issue in issues] == ["web-entry-path-not-page"]


def test_verify_accepts_one_inferred_primary_and_named_secondary():
    issues = cdscli._verify_web_entries({
        "web": _service({
            "cds.path-prefix": "/",
            "cds.web-entry-name": "管理端",
        }),
        "help": _service({
            "cds.subdomain": "help",
            "cds.web-entry-name": "帮助中心",
            "cds.web-entry-path": "/guide",
        }),
    })
    assert issues == []


def test_verify_rejects_multiple_explicit_primary_entries():
    issues = cdscli._verify_web_entries({
        "admin": _service({
            "cds.web-entry-name": "管理端",
            "cds.web-entry-primary": "true",
        }),
        "open": _service({
            "cds.web-entry-name": "开放平台",
            "cds.web-entry-primary": "true",
        }),
    })
    assert any(issue["rule"] == "web-entry-primary-duplicate" for issue in issues)


def test_verify_accepts_secret_declared_only_in_env_meta():
    assert cdscli._verify_collect_env_keys({
        "x-cds-env": {"PUBLIC_DEFAULT": "value"},
        "x-cds-env-meta": {"SECRET_FROM_CDS_SCOPE": {"kind": "required"}},
    }) == {"PUBLIC_DEFAULT", "SECRET_FROM_CDS_SCOPE"}
