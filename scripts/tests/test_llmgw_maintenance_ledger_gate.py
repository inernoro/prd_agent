#!/usr/bin/env python3

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
MODULE_PATH = SCRIPTS_DIR / "llmgw-rollout-ledger.py"
EXEC_DEP_PATH = SCRIPTS_DIR.parent / "exec_dep.sh"
SPEC = importlib.util.spec_from_file_location("llmgw_rollout_ledger", MODULE_PATH)
assert SPEC and SPEC.loader
LEDGER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LEDGER)


COMMIT = "a" * 40


def gate_payload(config_authority: dict, runtime_gates: dict) -> dict:
    return {
        "verdict": "pass",
        "shadowReleaseCommit": COMMIT,
        "shadowChecks": [{"label": "chat", "releaseCommit": COMMIT, "ok": True}],
        "configAuthority": config_authority,
        "runtimeGates": runtime_gates,
    }


READY_CONFIG = {
    "required": True,
    "ok": True,
    "status": "ready",
    "mapFallbackObjectsRemaining": 0,
    "activeAppCallerMapFallbackReady": True,
    "activeMissingGatewayPool": 0,
    "activeBoundPoolWithoutUsableMember": 0,
    "readinessPercent": 100,
    "failures": [],
}

READY_RUNTIME = {
    "required": True,
    "ok": True,
    "readyForHttpFull": True,
    "remainingRuntimeGates": [],
    "allowedPendingRuntimeGates": [],
    "selfFinalizingHttpFullLedger": False,
}

SKIPPED_CONFIG = {
    "required": False,
    "ok": None,
    "status": "not-required",
    "mapFallbackObjectsRemaining": None,
    "activeAppCallerMapFallbackReady": None,
    "activeMissingGatewayPool": None,
    "activeBoundPoolWithoutUsableMember": None,
    "readinessPercent": None,
    "failures": [],
}

SKIPPED_RUNTIME = {
    "required": False,
    "ok": None,
    "readyForHttpFull": None,
    "remainingRuntimeGates": [],
    "allowedPendingRuntimeGates": [],
    "selfFinalizingHttpFullLedger": False,
}


class MaintenanceLedgerGateTests(unittest.TestCase):
    def write_gate(self, directory: Path, payload: dict) -> str:
        path = directory / "gate.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        return str(path)

    def test_audited_maintenance_release_allows_only_explicit_not_required_shape(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            path = self.write_gate(Path(raw), gate_payload(SKIPPED_CONFIG, SKIPPED_RUNTIME))
            LEDGER._require_release_gate_for_commit(
                path,
                "maintenance gate",
                COMMIT,
                require_config_authority=True,
                allow_skipped_runtime_gates=True,
                allow_skipped_config_authority=True,
            )

    def test_audited_maintenance_release_allows_exact_scoped_shadow_skip_shape(self) -> None:
        payload = gate_payload(SKIPPED_CONFIG, SKIPPED_RUNTIME)
        payload["shadowChecks"] = []
        payload["thresholds"] = {
            "skipGlobalCells": True,
            "minTotal": 0,
            "minPerApp": 0,
        }
        with tempfile.TemporaryDirectory() as raw:
            path = self.write_gate(Path(raw), payload)
            LEDGER._require_release_gate_for_commit(
                path,
                "maintenance gate",
                COMMIT,
                require_config_authority=True,
                allow_skipped_runtime_gates=True,
                allow_skipped_config_authority=True,
                allow_skipped_shadow_checks=True,
            )

    def test_audited_maintenance_release_rejects_empty_shadow_without_exact_skip_shape(self) -> None:
        payload = gate_payload(SKIPPED_CONFIG, SKIPPED_RUNTIME)
        payload["shadowChecks"] = []
        payload["thresholds"] = {
            "skipGlobalCells": True,
            "minTotal": 1,
            "minPerApp": 0,
        }
        with tempfile.TemporaryDirectory() as raw:
            path = self.write_gate(Path(raw), payload)
            with self.assertRaises(SystemExit):
                LEDGER._require_release_gate_for_commit(
                    path,
                    "maintenance gate",
                    COMMIT,
                    require_config_authority=True,
                    allow_skipped_runtime_gates=True,
                    allow_skipped_config_authority=True,
                    allow_skipped_shadow_checks=True,
                )

    def test_non_maintenance_release_rejects_skipped_config_authority(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            path = self.write_gate(Path(raw), gate_payload(SKIPPED_CONFIG, SKIPPED_RUNTIME))
            with self.assertRaises(SystemExit):
                LEDGER._require_release_gate_for_commit(
                    path,
                    "full-http gate",
                    COMMIT,
                    require_config_authority=True,
                )

    def test_maintenance_release_rejects_partially_populated_skipped_config(self) -> None:
        malformed = dict(SKIPPED_CONFIG)
        malformed["mapFallbackObjectsRemaining"] = 1
        with tempfile.TemporaryDirectory() as raw:
            path = self.write_gate(Path(raw), gate_payload(malformed, SKIPPED_RUNTIME))
            with self.assertRaises(SystemExit):
                LEDGER._require_release_gate_for_commit(
                    path,
                    "maintenance gate",
                    COMMIT,
                    require_config_authority=True,
                    allow_skipped_runtime_gates=True,
                    allow_skipped_config_authority=True,
                )

    def test_baseline_gate_still_requires_ready_config_and_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            path = self.write_gate(Path(raw), gate_payload(READY_CONFIG, READY_RUNTIME))
            LEDGER._require_release_gate_for_commit(
                path,
                "baseline gate",
                COMMIT,
                require_config_authority=True,
            )

    def test_maintenance_baseline_audit_accepts_explicit_legacy_not_required_gate(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            stage_path = directory / "stage.json"
            stage_path.write_text(json.dumps({
                "verdict": "pass",
                "stage": "http-full",
                "status": "success",
                "commit": COMMIT,
                "mode": "http",
                "disableMapConfigFallbackForActiveAppCallers": True,
                "failures": [],
                "shadowEvidenceCommit": COMMIT,
            }), encoding="utf-8")
            gate_path = self.write_gate(directory, gate_payload(SKIPPED_CONFIG, SKIPPED_RUNTIME))
            ledger_path = directory / "ledger.jsonl"
            ledger_path.write_text(json.dumps({
                "stage": "http-full",
                "status": "success",
                "commit": COMMIT,
                "recordedAt": "2026-07-13T00:00:00Z",
                "evidenceJson": str(stage_path),
                "releaseGateJson": gate_path,
            }) + "\n", encoding="utf-8")
            result = LEDGER.maintenance_baseline(SimpleNamespace(
                commit=COMMIT,
                ledger=str(ledger_path),
                json_out=str(directory / "baseline.json"),
            ))
            self.assertEqual(0, result)
            baseline = json.loads((directory / "baseline.json").read_text(encoding="utf-8"))
            self.assertEqual("pass", baseline["verdict"])

    def test_maintenance_release_inherits_provider_audit_but_video_asr_canary_does_not(self) -> None:
        source = EXEC_DEP_PATH.read_text(encoding="utf-8")
        self.assertIn(
            'if { [ "$mode" = "http" ] && [ "$maintenance_release" != "1" ]; } '
            '|| [ "$canary_stage" = "video-asr" ]; then',
            source,
        )
        self.assertIn(
            "LLM Gateway provider config audit: inherited from audited full-http maintenance baseline",
            source,
        )
        self.assertNotIn(
            'if [ "$mode" = "http" ] || [ "$canary_stage" = "video-asr" ]; then',
            source,
        )

    def test_maintenance_release_skips_only_inherited_global_shadow_cells(self) -> None:
        source = EXEC_DEP_PATH.read_text(encoding="utf-8")
        self.assertIn(
            'args="--base $gate_base --min-total 0 --min-per-app 0 --skip-global-cells"',
            source,
        )
        self.assertIn(
            'args="--base $gate_base --min-total ${LLMGW_GATE_MIN_TOTAL:-30} '
            '--min-per-app ${LLMGW_GATE_MIN_PER_APP:-30}"',
            source,
        )


if __name__ == "__main__":
    unittest.main()
