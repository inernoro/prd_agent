"""Exercise reporting boundaries and distribution safety using the public tools."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("check_ledger", ROOT / "scripts/check_ledger.py")
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


def ledger():
    states = sorted(checker.STATES)
    return {
        "schema_version": 1,
        "scope": [{"id": "upstreams", "route": "/upstreams", "goal": "Find an upstream",
                   "frequency": "High; task-inferred", "core_action": "Open connection details",
                   "required_states": states}],
        "cases": [{"page": "upstreams", "state": state, "decision": "retained",
                   "reason": "Manually inspected: necessary status remains readable",
                   "evidence": [{"provenance": "deterministic-fixture", "reference": "evidence.png", "revision": "new"}],
                   "checks": [{"assertion": "Connection details opens and Escape restores focus", "outcome": "pass"}]}
                  for state in states],
    }


class EvidenceBoundaryTests(unittest.TestCase):
    def test_fixture_cannot_be_claimed_as_real_acceptance(self):
        data = ledger()
        self.assertFalse(checker.validate(data)[0])
        self.assertTrue(checker.validate(data, require_live=True)[0])
        for case in data["cases"]:
            case["evidence"][0]["provenance"] = "preview-live"
        self.assertFalse(checker.validate(data, require_live=True, require_complete=True)[0])

    def test_missing_scope_case_and_blocked_path_stay_visible(self):
        data = ledger()
        case = data["cases"].pop()
        self.assertTrue(checker.validate(data)[0])
        case.update(decision="blocked", blocker="HTTP 403; restore authorized test role")
        data["cases"].append(case)
        self.assertFalse(checker.validate(data)[0])
        self.assertTrue(checker.validate(data, require_complete=True)[0])
        data["scope"][0]["required_states"].remove("error")
        self.assertTrue(checker.validate(data)[0])

    def test_failure_cannot_be_filtered_into_complete_acceptance(self):
        data = ledger()
        data["cases"][0]["checks"][0]["outcome"] = "fail"
        errors, counts = checker.validate(data)
        self.assertFalse(errors)
        self.assertEqual(counts["failed_checks"], 1)
        self.assertTrue(checker.validate(data, require_complete=True)[0])

    def test_before_after_must_use_same_conditions_and_referenced_versions(self):
        data = ledger()
        case = data["cases"][0]
        case["decision"] = "fixed"
        before = {"revision": "old", "dataset": "two-rows-v1", "viewport": [390, 844],
                  "theme": "dark", "role": "owner", "first_data_y": 509,
                  "unnecessary_before_px": 80, "task_scroll_px": 110, "task_steps": 3}
        after = dict(before, revision="new", first_data_y=406, unnecessary_before_px=0, task_scroll_px=0)
        case["evidence"].append({"provenance": "deterministic-fixture", "reference": "before.png", "revision": "old"})
        case["comparison"] = {"before": before, "after": after,
                              "old_failure": "Same assertion fails on baseline", "new_pass": "Same assertion passes",
                              "nonessential_reason": "Duplicate maintenance notice delays records", "target": "Data appears at least 60px earlier"}
        self.assertFalse(checker.validate(data)[0])
        for field, value in (("dataset", "other"), ("viewport", [1440, 900]), ("theme", "light"), ("role", "viewer")):
            changed = copy.deepcopy(data)
            changed["cases"][0]["comparison"]["after"][field] = value
            self.assertTrue(checker.validate(changed)[0], field)
        case["evidence"] = case["evidence"][:1]
        self.assertTrue(checker.validate(data)[0])

    def test_malformed_evidence_is_rejected_without_crashing(self):
        data = ledger()
        data["cases"][0]["evidence"][0]["provenance"] = []
        self.assertTrue(checker.validate(data)[0])

    def test_cli_uses_exit_status_and_never_assigns_ux_verdict(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "ledger.json"
            path.write_text(json.dumps(ledger()), encoding="utf-8")
            command = [sys.executable, str(ROOT / "scripts/check_ledger.py"), str(path)]
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["ux_verdict"], "not-assigned")
            self.assertEqual(subprocess.run(command + ["--require-live"], capture_output=True).returncode, 1)


class DistributionTests(unittest.TestCase):
    def test_package_is_reproducible_allowlisted_and_installs_both_hosts(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            digests = []
            for index in (1, 2):
                output = base / f"package-{index}" / "dechrome.zip"
                result = subprocess.run([sys.executable, str(ROOT / "scripts/package_skill.py"), "--output", str(output)], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                digests.append(output.with_suffix(".zip.sha256").read_text().split()[0])
            self.assertEqual(*digests)
            with zipfile.ZipFile(output) as archive:
                names = archive.namelist()
                self.assertEqual(len(names), 6)
                self.assertTrue(all(name.startswith("dechrome/") and ".." not in Path(name).parts for name in names))
                self.assertFalse(any(name.endswith((".png", ".zip", ".json", ".pyc")) for name in names))
                project = base / "project"
                for host in (".claude", ".agents"):
                    destination = project / host / "skills"
                    destination.mkdir(parents=True)
                    archive.extractall(destination)
                    self.assertEqual((destination / "dechrome/SKILL.md").read_bytes(), (ROOT / "SKILL.md").read_bytes())
            rejected = subprocess.run([sys.executable, str(ROOT / "scripts/package_skill.py"), "--output", str(ROOT / "bad.zip")], capture_output=True)
            self.assertEqual(rejected.returncode, 1)
            self.assertFalse((ROOT / "bad.zip").exists())


if __name__ == "__main__":
    unittest.main()
