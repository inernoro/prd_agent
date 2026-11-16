#!/usr/bin/env python3
"""Isolated RED/GREEN capacity proof; stdout is JSON, no production mutation.

Pass --baseline-ref explicitly. Only the percentage monitor is historical;
pending-slot and Docker controls are labelled mutations of the candidate.
"""
import argparse
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/host-capacity.py"
TEST = ROOT / "scripts/tests/test_host_capacity.py"
GIB = 1024**3


def run(argv, **kwargs):
    return subprocess.run(argv, capture_output=True, text=True, timeout=60, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-ref", required=True, help="local Git commit/ref containing the old percentage monitor")
    args = parser.parse_args()
    baseline = run(["git", "rev-parse", "--verify", args.baseline_ref + "^{commit}"], cwd=ROOT)
    baseline.check_returncode()
    baseline = baseline.stdout.strip()
    legacy = run(["git", "show", baseline + ":scripts/llmgw-disk-usage-monitor.sh"], cwd=ROOT)
    legacy.check_returncode()
    candidate = SCRIPT.read_text()
    spec = importlib.util.spec_from_file_location("capacity_proof", SCRIPT)
    cap = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cap)
    with tempfile.TemporaryDirectory(prefix="capacity-proof-") as temporary:
        root = Path(temporary)
        source, state, bin_dir = root / "cache", root / "state", root / "bin"
        for directory in (source, state, bin_dir):
            directory.mkdir(mode=0o700)
        monitor = root / "legacy-monitor.sh"
        monitor.write_text(legacy.stdout)
        df = bin_dir / "df"
        df.write_text("#!/bin/sh\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted_on\\nfixture 104857600 62914560 41943040 60%% /fixture\\n'\n")
        df.chmod(0o700)
        env = {**os.environ, "PATH": str(bin_dir) + os.pathsep + os.environ.get("PATH", "")}
        old = run(["/bin/sh", str(monitor), str(source), "75", "90", "isolated capacity fixture"], env=env)

        def sample(hour):
            used = 50 * GIB + 10 * GIB * hour // 24
            return {"at": 1800000000 + hour * 3600, "host": "isolated-fixture", "errors": [],
                    "sources": {"cache": {"path": str(source), "device": "fixture", "bytes": used - 40 * GIB}},
                    "filesystems": {"fixture": {"totalBytes": 100 * GIB, "usedBytes": used,
                        "availableBytes": 100 * GIB - used, "totalInodes": 1000, "availableInodes": 900}}}

        selected = {"cache": str(source)}
        history = [sample(h) for h in range(24)]
        cap.save_history(state / "history.json", selected, history[:-1], history[-1])
        output = io.StringIO()
        with patch.object(sys, "argv", [str(SCRIPT), "--source", "cache=" + str(source), "--state-dir", str(state)]), \
                patch.object(cap, "collect", return_value=sample(24)), contextlib.redirect_stdout(output):
            code = cap.main()
        report = json.loads(output.getvalue())
        days = report["filesystems"]["fixture"]["daysToReserve"]
        forecast = {
            "assertion": "warn before 7-day reserve exhaustion below percentage watermark",
            "provenance": "deterministic-fixture",
            "input": {"totalGiB": 100, "usedGiB": 60, "growthGiBPerDay": 10, "reserveGiB": 6},
            "baselineCommit": baseline,
            "baselineSourceSha256": hashlib.sha256(legacy.stdout.encode()).hexdigest(),
            "old": {"exit": old.returncode, "stdout": old.stdout, "verdict": "RED" if old.returncode == 0 else "UNEXPECTED"},
            "new": {"exit": code, "report": report, "verdict": "GREEN" if code == 1 and abs(days - 3.4) < 0.000001
                    and any(a["code"] == "reserve-exhaustion-forecast" for a in report["alerts"]) else "FAIL"},
            "boundary": "legacy receives current df capacity; it has no history/forecast input; candidate collector alone is injected, main/state/report/exit wiring is real",
        }
        controls = []
        mutations = [
            ("unique-pending-slot", 'temp = file.parent / "history.pending"',
             'temp = file.parent / ("history.pending." + str(os.getpid()))',
             "test_repeated_sigkill_leaves_one_bounded_pending_slot_then_retry_commits"),
            ("inherited-docker-selector", '["docker", "--host=unix:///var/run/docker.sock", "system",',
             '["docker", "system",', "test_docker_inventory_cannot_follow_an_inherited_remote_context"),
        ]
        for name, original, replacement, test in mutations:
            if candidate.count(original) != 1:
                raise ValueError("mutation anchor drift: " + name)
            copied = root / name / "scripts"
            (copied / "tests").mkdir(parents=True)
            (copied / "tests/test_host_capacity.py").write_text(TEST.read_text())
            (copied / "host-capacity.py").write_text(candidate.replace(original, replacement))
            negative = run([sys.executable, str(copied / "tests/test_host_capacity.py"), "CapacityTests." + test, "-v"])
            positive = run([sys.executable, str(TEST), "CapacityTests." + test, "-v"])
            controls.append({"name": name, "kind": "candidate mutation, NOT a historical production version",
                             "provenance": "deterministic-fixture", "test": test,
                             "faultExit": negative.returncode, "faultLog": negative.stdout + negative.stderr,
                             "candidateExit": positive.returncode, "candidateLog": positive.stdout + positive.stderr,
                             "verdict": "PASS" if negative.returncode == 1 and "FAIL:" in negative.stderr and positive.returncode == 0 else "FAIL"})
        proof = {"candidateSourceSha256": hashlib.sha256(candidate.encode()).hexdigest(), "forecast": forecast,
                 "mutationControls": controls,
                 "verdict": "PASS" if forecast["old"]["verdict"] == "RED" and forecast["new"]["verdict"] == "GREEN"
                     and all(c["verdict"] == "PASS" for c in controls) else "FAIL"}
        print(json.dumps(proof, ensure_ascii=False, indent=2))
        return 0 if proof["verdict"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
