#!/usr/bin/env python3

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
EXEC_DEP = ROOT / "exec_dep.sh"


class ReleaseDualKeyContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source = EXEC_DEP.read_text(encoding="utf-8")

    def test_scoped_service_key_falls_back_to_release_gate_key(self) -> None:
        self.assertIn(
            'LLMGW_POST_DEPLOY_SMOKE_KEY="${LLMGW_POST_DEPLOY_SERVICE_KEY:-$gate_key}"',
            self.source,
        )
        self.assertIn('smoke_key="${LLMGW_POST_DEPLOY_SMOKE_KEY:-$gate_key}"', self.source)

    def test_business_smoke_and_protocol_canary_use_scoped_key(self) -> None:
        self.assertIn('GW_BASE="$gate_base" GW_KEY="$smoke_key"', self.source)
        self.assertIn('GW_KEY="$smoke_key" python3 scripts/llmgw-protocol-canary.py', self.source)

    def test_global_runtime_gate_keeps_release_gate_key(self) -> None:
        self.assertIn(
            'GW_KEY="$gate_key" python3 scripts/llmgw-release-gate.py '
            '$args $runtime_gate_expect_arg $protocol_canary_arg --require-runtime-gates',
            self.source,
        )


if __name__ == "__main__":
    unittest.main()
