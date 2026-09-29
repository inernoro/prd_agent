#!/usr/bin/env python3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DEPLOY = (ROOT / "exec_dep.sh").read_text(encoding="utf-8")
PROD_STAGE = (ROOT / ".github/workflows/llmgw-prod-stage.yml").read_text(encoding="utf-8")
COMPOSE = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")

assert 'PRD_AGENT_PUBLIC_BASE_URL is required for production deployment' in DEPLOY
assert 'export LLMGW_MAP_HOME_URL="${LLMGW_MAP_HOME_URL:-$PRD_AGENT_PUBLIC_BASE_URL}"' in DEPLOY
assert 'public_base="$PRD_AGENT_PUBLIC_BASE_URL"' in DEPLOY
assert "PRD_AGENT_PUBLIC_BASE_URL:-https://" not in DEPLOY
assert "PRD_AGENT_PUBLIC_BASE_URL: ${{ vars.PRD_AGENT_PUBLIC_BASE_URL || vars.PRD_AGENT_PROD_BASE || '' }}" in PROD_STAGE
assert "LLMGW_MAP_HOME_URL=${LLMGW_MAP_HOME_URL:?" in COMPOSE
# 设计执行服务回调 api 只能走正式域名（它的出口拒绝内网地址），同样由 PRD_AGENT_PUBLIC_BASE_URL 驱动。
assert 'export DESIGN_ARTIFACT_PUBLIC_BASE_URL="${DESIGN_ARTIFACT_PUBLIC_BASE_URL:-$PRD_AGENT_PUBLIC_BASE_URL}"' in DEPLOY
assert "DesignArtifactRuntime__PublicBaseUrl=${DESIGN_ARTIFACT_PUBLIC_BASE_URL:-}" in COMPOSE
assert "DesignRuntime__OpenDesign__BaseUrl=http://design-opendesign:8093" in COMPOSE

print("Production runtime domain contract test: PASS")
