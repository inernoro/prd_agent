#!/usr/bin/env python3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DEPLOY = (ROOT / "exec_dep.sh").read_text(encoding="utf-8")
COMPOSE = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")

assert 'PRD_AGENT_PUBLIC_BASE_URL is required for production deployment' in DEPLOY
assert 'export LLMGW_MAP_HOME_URL="${LLMGW_MAP_HOME_URL:-$PRD_AGENT_PUBLIC_BASE_URL}"' in DEPLOY
assert 'public_base="$PRD_AGENT_PUBLIC_BASE_URL"' in DEPLOY
assert "PRD_AGENT_PUBLIC_BASE_URL:-https://" not in DEPLOY
assert "LLMGW_MAP_HOME_URL=${LLMGW_MAP_HOME_URL:?" in COMPOSE

print("Production runtime domain contract test: PASS")
