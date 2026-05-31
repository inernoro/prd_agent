"""WS4 — cdscli verify 评分回归。

验证 `_verify_score` / `_verify_grade` 把 ERROR/WARNING/INFO 聚合成 0-100 分 +
字母等级,以及评分对 deductions 的拆分。SSOT:doc/spec.cds-compose-contract.md § 4.4。
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI_DIR = ROOT / "cli"
sys.path.insert(0, str(CLI_DIR))

import cdscli  # noqa: E402


def _issue(sev: str, rule: str = "x"):
    return {"severity": sev, "service": "svc", "rule": rule, "message": "", "fix": ""}


def test_clean_compose_is_full_score_grade_a():
    s = cdscli._verify_score([])
    assert s["score"] == 100
    assert s["grade"] == "A"
    assert s["deductions"] == {"ERROR": 0, "WARNING": 0, "INFO": 0}


def test_single_error_deducts_25():
    s = cdscli._verify_score([_issue("ERROR")])
    assert s["score"] == 75
    assert s["grade"] == "B"
    assert s["deductions"]["ERROR"] == 25


def test_warning_and_info_penalties():
    s = cdscli._verify_score([_issue("WARNING"), _issue("INFO"), _issue("INFO")])
    # 100 - 8 - 2 - 2 = 88
    assert s["score"] == 88
    assert s["grade"] == "B"
    assert s["deductions"] == {"ERROR": 0, "WARNING": 8, "INFO": 4}


def test_many_errors_floor_at_zero_grade_f():
    s = cdscli._verify_score([_issue("ERROR")] * 10)  # 250 扣分,下限 0
    assert s["score"] == 0
    assert s["grade"] == "F"


def test_grade_bands_boundaries():
    assert cdscli._verify_grade(90) == "A"
    assert cdscli._verify_grade(89) == "B"
    assert cdscli._verify_grade(75) == "B"
    assert cdscli._verify_grade(74) == "C"
    assert cdscli._verify_grade(60) == "C"
    assert cdscli._verify_grade(59) == "D"
    assert cdscli._verify_grade(40) == "D"
    assert cdscli._verify_grade(39) == "F"
    assert cdscli._verify_grade(0) == "F"


def test_unknown_severity_ignored():
    s = cdscli._verify_score([_issue("DEBUG"), _issue("ERROR")])
    assert s["score"] == 75  # 只有 ERROR 计分
