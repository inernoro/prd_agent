#!/usr/bin/env python3
"""生产镜像拉取超时合同守卫。"""

from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]
EXEC_DEP = (ROOT / "exec_dep.sh").read_text(encoding="utf-8")
FAST = (ROOT / "fast.sh").read_text(encoding="utf-8")


def default_seconds(source: str, variable: str) -> int:
    match = re.search(rf'\$\{{{variable}:-([0-9]+)\}}', source)
    if match is None:
        raise AssertionError(f"没有找到 {variable} 的默认值")
    return int(match.group(1))


class ReleaseImagePullTimeoutContractTests(unittest.TestCase):
    def test_authoritative_pull_budget_matches_calibrated_total_budget(self) -> None:
        self.assertEqual(default_seconds(FAST, "FAST_PULL_TIMEOUT_SECONDS"), 180)
        self.assertEqual(default_seconds(FAST, "FAST_PULL_TOTAL_TIMEOUT_SECONDS"), 420)
        self.assertEqual(
            default_seconds(EXEC_DEP, "API_PULL_TIMEOUT_SECONDS"),
            default_seconds(FAST, "FAST_PULL_TOTAL_TIMEOUT_SECONDS"),
        )
        self.assertGreater(
            default_seconds(EXEC_DEP, "API_PULL_TIMEOUT_SECONDS"),
            default_seconds(FAST, "FAST_PULL_TIMEOUT_SECONDS"),
        )

    def test_operator_sees_budget_and_immutable_failure_still_blocks_cutover(self) -> None:
        self.assertIn(
            'echo "Release image pull timeout budget: ${pull_timeout_seconds}s"',
            EXEC_DEP,
        )
        self.assertRegex(
            EXEC_DEP,
            r'ERROR: immutable release image pull failed[^\n]+\n\s*exit 1',
        )


if __name__ == "__main__":
    unittest.main()
