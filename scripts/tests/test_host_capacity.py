#!/usr/bin/env python3
"""Real collector/CLI checks plus deterministic capacity forecast boundaries."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "host-capacity.py"
spec = importlib.util.spec_from_file_location("capacity", SCRIPT)
cap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cap)
GIB = 1024**3


def sample(hour=0, used=50, source=10):
    return {"at": 1800000000 + hour * 3600, "host": "fixture", "errors": [],
            "sources": {"cache": {"path": "/cache", "device": "1", "bytes": source * GIB}},
            "filesystems": {"1": {"totalBytes": 100 * GIB, "usedBytes": used * GIB,
                "availableBytes": (100 - used) * GIB, "totalInodes": 1000, "availableInodes": 900}}}


class CapacityTests(unittest.TestCase):
    def test_forecast_warns_below_watermark_before_reserve_exhaustion(self):
        report = cap.analyze(sample(24, 60, 20), [sample(h, 50 + 10*h/24, 10 + 10*h/24) for h in range(24)], reserve_bytes=6 * GIB)
        self.assertEqual(report["status"], "warning")
        self.assertAlmostEqual(report["filesystems"]["1"]["daysToReserve"], 3.4)
        self.assertEqual(report["sources"]["cache"]["bytesPerDay"], 10 * GIB)
        self.assertIn("reserve-exhaustion-forecast", [a["code"] for a in report["alerts"]])

    def test_recent_acceleration_is_not_hidden_by_week_average(self):
        history = [sample(0, 40), sample(24 * 7, 41)]
        report = cap.analyze(sample(24 * 7 + 1, 42), history)
        self.assertEqual(report["filesystems"]["1"]["bytesPerDay"], 24 * GIB)

    def test_critical_usage_absolute_reserve_and_inodes(self):
        for entry, code in ((sample(1, 90), "bytes-critical"), (sample(1, 95), "reserve-low")):
            report = cap.analyze(entry, [sample()])
            self.assertEqual(report["status"], "critical")
            self.assertIn(code, [a["code"] for a in report["alerts"]])
        entry = sample(1)
        entry["filesystems"]["1"]["availableInodes"] = 10
        self.assertIn("inodes-critical", [a["code"] for a in cap.analyze(entry, [sample()])["alerts"]])

    def test_cleanup_shrink_does_not_predict_exhaustion(self):
        report = cap.analyze(sample(1, 30, 2), [sample()])
        self.assertLess(report["sources"]["cache"]["deltaBytes"], 0)
        self.assertIsNone(report["filesystems"]["1"]["daysToFull"])
        self.assertEqual(report["status"], "ok")

    def test_cold_start_gap_and_clock_reversal_are_visible(self):
        self.assertEqual(cap.analyze(sample(), [])["status"], "unknown")
        self.assertIn("sampling-gap", [a["code"] for a in cap.analyze(sample(24), [sample()])["alerts"]])
        self.assertIn("clock-not-increasing", [a["code"] for a in cap.analyze(sample(), [sample(1)])["alerts"]])

    def test_resize_and_source_change_invalidate_growth(self):
        current = sample(1)
        current["filesystems"]["1"]["totalBytes"] *= 2
        current["sources"]["cache"]["path"] = "/new-cache"
        report = cap.analyze(current, [sample()])
        self.assertIsNone(report["sources"]["cache"]["bytesPerDay"])
        self.assertIsNone(report["filesystems"]["1"]["bytesPerDay"])

    def test_missing_measurement_is_not_zero_or_healthy(self):
        with tempfile.TemporaryDirectory() as root:
            with patch.object(cap, "run", side_effect=subprocess.TimeoutExpired("du", 60)):
                current = cap.collect({"cache": root}, docker=True)
            self.assertIsNone(current["sources"]["cache"]["bytes"])
            self.assertEqual(cap.analyze(current, [])["status"], "unknown")
            self.assertEqual(len(current["errors"]), 2)

    def test_real_du_skips_symlink_and_counts_allocated_bytes(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            source, external = root / "cache", root / "external"
            source.mkdir()
            external.mkdir()
            (source / "cache.bin").write_bytes(b"c" * 8192)
            (external / "business.bin").write_bytes(b"d" * 1024**2)
            (source / "link").symlink_to(external, target_is_directory=True)
            result = cap.collect({"cache": str(source)})
            self.assertFalse(result["errors"])
            self.assertGreaterEqual(result["sources"]["cache"]["bytes"], 8192)
            self.assertLess(result["sources"]["cache"]["bytes"], 1024**2)
            self.assertEqual((external / "business.bin").stat().st_size, 1024**2)

    def test_docker_inventory_cannot_follow_an_inherited_remote_context(self):
        selectors = {"DOCKER_HOST": "tcp://remote.invalid:2376", "DOCKER_CONTEXT": "remote",
                     "DOCKER_TLS": "1", "DOCKER_TLS_VERIFY": "1", "DOCKER_CERT_PATH": "/private-certs",
                     "DOCKER_CONFIG": "/existing-config"}
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, selectors):
            with patch.object(cap, "run", side_effect=["4096\tcache\n", json.dumps(
                {"Type": "Images", "Size": "1GB", "Reclaimable": "0B"})]) as runner:
                result = cap.collect({"cache": root}, docker=True)
            args, options = runner.call_args_list[-1]
            self.assertEqual(args[0][:2], ["docker", "--host=unix:///var/run/docker.sock"])
            self.assertTrue(all(key not in options["env"] for key in selectors if key != "DOCKER_CONFIG"))
            self.assertEqual(options["env"]["DOCKER_CONFIG"], "/existing-config")
            self.assertFalse(result["errors"])
            self.assertEqual(result["docker"][0]["Type"], "Images")

    def test_rejects_nested_alias_and_duplicate_sources(self):
        with tempfile.TemporaryDirectory() as root:
            nested = Path(root) / "nested"
            nested.mkdir()
            for values in ([f"a={root}", f"b={nested}"], [f"a={root}", f"a={nested}"],
                           [f"a={root}", f"b={root}/."]):
                with self.assertRaises(ValueError):
                    cap.roots(values)

    def test_eight_day_history_is_bounded_and_atomic_on_write_failure(self):
        with tempfile.TemporaryDirectory() as root:
            file = Path(root) / "history.json"
            selected = {"cache": "/cache"}
            history = []
            for hour in range(24 * 14):
                cap.save_history(file, selected, history, sample(hour))
                history = cap.load_history(file, selected)
            self.assertEqual(len(history), cap.MAX_SAMPLES)
            self.assertLess(file.stat().st_size, cap.MAX_STATE_BYTES)
            before = file.read_bytes()
            with patch.object(cap.os, "replace", side_effect=OSError("interrupted before commit")):
                with self.assertRaises(OSError):
                    cap.save_history(file, selected, history, sample(24 * 14))
            self.assertEqual(file.read_bytes(), before)
            self.assertFalse((file.parent / "history.pending").exists())
            cap.save_history(file, selected, history, sample(24 * 14))
            self.assertEqual(cap.load_history(file, selected)[-1]["at"], sample(24 * 14)["at"])
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(ValueError):
                cap.load_history(file, {"cache": "/other"})

    def test_frequent_runs_and_clock_reversal_do_not_evict_baseline(self):
        with tempfile.TemporaryDirectory() as root:
            file = Path(root) / "history.json"
            cap.save_history(file, {}, [], sample())
            before = cap.load_history(file, {})
            cap.save_history(file, {}, before, sample(0.1))
            self.assertEqual(cap.load_history(file, {}), before)
            cap.save_history(file, {}, before, sample(-1))
            self.assertEqual(cap.load_history(file, {}), before)

    def test_cli_exit_codes_and_bad_state_are_machine_readable(self):
        with tempfile.TemporaryDirectory() as root:
            source, state = Path(root) / "cache", Path(root) / "state"
            source.mkdir()
            cmd = ["python3", str(SCRIPT), "--source", f"cache={source}", "--state-dir", str(state)]
            first = subprocess.run(cmd, capture_output=True, text=True)
            self.assertEqual(first.returncode, 3)  # first run has no growth baseline
            self.assertEqual(json.loads(first.stdout)["status"], "unknown")
            critical = subprocess.run(cmd + ["--reserve-gib", "1000000"], capture_output=True, text=True)
            self.assertEqual(critical.returncode, 2)
            self.assertEqual(json.loads(critical.stdout)["status"], "critical")
            history = state / "history.json"
            history.write_text("corrupt")
            broken = subprocess.run(cmd, capture_output=True, text=True)
            self.assertEqual(broken.returncode, 3)
            self.assertEqual(json.loads(broken.stdout)["alerts"][0]["code"], "collector-or-state-failed")
            self.assertEqual(history.read_text(), "corrupt")

    def test_parallel_probe_reports_unknown_without_overwriting_history(self):
        import fcntl
        with tempfile.TemporaryDirectory() as root:
            source, state = Path(root) / "cache", Path(root) / "state"
            source.mkdir(); state.mkdir(mode=0o700)
            history = state / "history.json"
            history.write_text("preserve existing evidence")
            with (state / "lock").open("w") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                result = subprocess.run(["python3", str(SCRIPT), "--source", f"cache={source}",
                                         "--state-dir", str(state)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 3)
            self.assertEqual(json.loads(result.stdout)["status"], "unknown")
            self.assertEqual(history.read_text(), "preserve existing evidence")

    def test_corrupt_measurement_is_rejected_without_reset(self):
        with tempfile.TemporaryDirectory() as root:
            file = Path(root) / "history.json"
            cap.save_history(file, {}, [], sample())
            data = json.loads(file.read_text())
            data["samples"][0]["filesystems"]["1"]["totalBytes"] = 0
            file.write_text(json.dumps(data))
            with self.assertRaises(ValueError):
                cap.load_history(file, {})

    def test_insecure_state_directory_is_rejected_before_writing(self):
        with tempfile.TemporaryDirectory() as root:
            source, state = Path(root) / "cache", Path(root) / "state"
            source.mkdir(); state.mkdir(); state.chmod(0o755)
            result = subprocess.run(["python3", str(SCRIPT), "--source", f"cache={source}",
                                     "--state-dir", str(state)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 3)
            self.assertEqual(json.loads(result.stdout)["status"], "unknown")
            self.assertEqual(list(state.iterdir()), [])

    def test_unsafe_pending_files_preserve_history_and_external_bytes(self):
        with tempfile.TemporaryDirectory() as root:
            file, pending, target = (Path(root) / name for name in ("history.json", "history.pending", "sentinel"))
            cap.save_history(file, {}, [], sample())
            original = file.read_bytes()
            target.write_text("protected bytes"); target.chmod(0o600)
            for kind in ("symlink", "hardlink", "public", "fifo"):
                with self.subTest(kind=kind):
                    if kind == "symlink": pending.symlink_to(target)
                    elif kind == "hardlink": os.link(target, pending)
                    elif kind == "public": pending.write_text("public pending"); pending.chmod(0o640)
                    else: os.mkfifo(pending, 0o600)
                    try:
                        with self.assertRaises((ValueError, OSError)):
                            cap.save_history(file, {}, cap.load_history(file, {}), sample(1))
                        self.assertEqual(file.read_bytes(), original)
                        self.assertEqual(target.read_text(), "protected bytes")
                        self.assertTrue(pending.exists())
                    finally:
                        pending.unlink()
            cap.save_history(file, {}, cap.load_history(file, {}), sample(1))
            self.assertEqual(cap.load_history(file, {})[-1]["at"], sample(1)["at"])

    def test_repeated_sigkill_leaves_one_bounded_pending_slot_then_retry_commits(self):
        with tempfile.TemporaryDirectory() as root:
            file = Path(root) / "history.json"
            cap.save_history(file, {}, [], sample())
            original = file.read_bytes()
            code = """import importlib.util,os,signal,sys,json
from pathlib import Path
spec=importlib.util.spec_from_file_location('cap',sys.argv[1]);cap=importlib.util.module_from_spec(spec);spec.loader.exec_module(cap)
def killed(*args): os.kill(os.getpid(),signal.SIGKILL)
cap.os.replace=killed
cap.save_history(Path(sys.argv[2]),{},[],json.loads(sys.argv[3]))
"""
            for _ in range(3):
                result = subprocess.run(["python3", "-c", code, str(SCRIPT), str(file), json.dumps(sample(1))])
                self.assertEqual(result.returncode, -9)
                self.assertEqual(file.read_bytes(), original)
                self.assertEqual(sorted(p.name for p in file.parent.iterdir()), ["history.json", "history.pending"])
                self.assertLessEqual((file.parent / "history.pending").stat().st_size, cap.MAX_STATE_BYTES)
            cap.save_history(file, {}, cap.load_history(file, {}), sample(1))
            self.assertEqual(cap.load_history(file, {})[-1]["at"], sample(1)["at"])
            self.assertFalse((file.parent / "history.pending").exists())

    def test_ci_runs_on_script_only_changes(self):
        workflow = (SCRIPT.parents[1] / ".github/workflows/ci.yml").read_text()
        self.assertIn("- 'scripts/host-capacity.py'", workflow)
        self.assertIn("- 'scripts/capacity-behavior-proof.py'", workflow)
        self.assertIn("for t in scripts/tests/test_*.py", workflow)

    def test_behavior_proof_driver_detects_faults_and_runs_candidate_main(self):
        result = subprocess.run(["python3", str(SCRIPT.with_name("capacity-behavior-proof.py")),
                                 "--baseline-ref", "HEAD"], capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        report = json.loads(result.stdout)
        self.assertEqual(report["verdict"], "PASS")
        self.assertEqual(report["forecast"]["old"]["verdict"], "RED")
        self.assertEqual(report["forecast"]["new"]["verdict"], "GREEN")
        self.assertEqual([entry["verdict"] for entry in report["mutationControls"]], ["PASS", "PASS"])


if __name__ == "__main__":
    unittest.main()
