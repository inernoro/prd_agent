import json
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "rotation_state.py"


def run(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        check=check,
        capture_output=True,
        text=True,
    )


class RotationStateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.state = Path(self.temp.name) / "state.json"

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_exempt_requires_evidence_and_is_reported_separately(self) -> None:
        run("init", "--file", str(self.state), "--items", "database,oauth")
        run(
            "exempt", "--file", str(self.state), "--item", "oauth",
            "--reason", "未进入风险边界",
            "--evidence", "消费者仅从独立的 0600 进程环境文件读取",
        )
        result = run("verify", "--file", str(self.state), check=False)
        report = json.loads(result.stdout)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(report, {"ready": False, "incomplete": ["database"], "exempt": ["oauth"]})
        self.assertEqual(stat.S_IMODE(self.state.stat().st_mode), 0o600)

    def test_exempt_cannot_hide_started_rotation(self) -> None:
        run("init", "--file", str(self.state), "--items", "database")
        run("mark", "--file", str(self.state), "--item", "database", "--stage", "issued")
        result = run(
            "exempt", "--file", str(self.state), "--item", "database",
            "--reason", "不再需要", "--evidence", "复核记录", check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("after rotation started", result.stderr)

    def test_completed_and_exempt_items_make_state_ready(self) -> None:
        run("init", "--file", str(self.state), "--items", "database,oauth")
        run(
            "exempt", "--file", str(self.state), "--item", "oauth",
            "--reason", "未进入风险边界", "--evidence", "独立消费者清单",
        )
        for stage in ("issued", "deployed", "verified", "revoked", "verified_after_revoke"):
            run("mark", "--file", str(self.state), "--item", "database", "--stage", stage)
        result = run("verify", "--file", str(self.state))
        self.assertEqual(
            json.loads(result.stdout),
            {"ready": True, "incomplete": [], "exempt": ["oauth"]},
        )


if __name__ == "__main__":
    unittest.main()
