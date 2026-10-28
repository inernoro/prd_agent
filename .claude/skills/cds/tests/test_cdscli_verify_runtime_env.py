"""CDS compose 校验器必须识别平台在部署时注入的版本变量。"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI_DIR = ROOT / "cli"
sys.path.insert(0, str(CLI_DIR))

import cdscli  # noqa: E402


def test_commit_and_branch_runtime_variables_are_not_reported_as_unresolved():
    issues = cdscli._verify_env_resolves(
        "api",
        {
            "environment": {
                "IMP_TARGET_SHA": "${CDS_COMMIT_SHA}",
                "IMAGE_TAG": "branch-${CDS_BRANCH_SLUG}",
            },
        },
        set(),
    )

    assert not [issue for issue in issues if issue["severity"] == "ERROR"]
    assert {issue["rule"] for issue in issues} == {"env-var-cds-runtime"}
    assert len(issues) == 2


def test_unknown_cds_variable_still_requires_an_explicit_definition():
    issues = cdscli._verify_env_resolves(
        "api",
        {"environment": {"TOKEN": "${CDS_UNDECLARED_SECRET}"}},
        set(),
    )

    assert len(issues) == 1
    assert issues[0]["severity"] == "ERROR"
    assert issues[0]["rule"] == "env-var-unresolved"
