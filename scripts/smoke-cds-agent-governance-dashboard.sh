#!/usr/bin/env bash
# RETIRED 2026-07-09（整组退役，见 doc/debt.cds.agent.acceptance-smoke-drift.md）
# 这批手工取证 smoke 用硬编码文案 grep -Fq 断言，文档改写后已链式漂移失效。
# 按台账「修复或退役」一次性决策：退役。未接 CI，保留文件仅作历史取证参考，
# 不再维护、不作为验收依据。如需同类校验请改用结构化锚点重写并接最小 CI。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

require_match() {
  local pattern="$1"
  local file="$2"
  local label="$3"
  if ! rg -q "$pattern" "$file"; then
    echo "FAIL: missing ${label} in ${file}" >&2
    exit 1
  fi
}

require_match "GetGovernanceDashboardAsync" "prd-api/src/PrdAgent.Core/Interfaces/IInfraAgentSessionService.cs" "governance service contract"
require_match "InfraAgentGovernanceDashboardView" "prd-api/src/PrdAgent.Core/Interfaces/IInfraAgentSessionService.cs" "governance DTO"
require_match "BuildGovernanceDashboard" "prd-api/src/PrdAgent.Infrastructure/Services/InfraAgentSessions/InfraAgentSessionService.cs" "governance aggregation"
require_match "HttpGet\\(\"governance-dashboard\"\\)" "prd-api/src/PrdAgent.Api/Controllers/Api/InfraAgentSessionsController.cs" "governance endpoint"
require_match "getInfraAgentGovernanceDashboard" "prd-admin/src/services/real/infraAgentSessions.ts" "frontend API client"
require_match "权限 / 组织治理" "prd-admin/src/pages/cds-agent/CdsAgentPage.tsx" "governance panel"
require_match "GOV-KB-READONLY" "prd-api/tests/PrdAgent.Api.Tests/Services/InfraAgentSessionServiceGovernanceDashboardTests.cs" "governance unit evidence"
require_match "GOV-PROFILE-SCOPE" "prd-api/src/PrdAgent.Infrastructure/Services/InfraAgentSessions/InfraAgentSessionService.cs" "profile gate"
require_match "Runtime profile list/resolve are owner-or-team-scoped; update/delete remain owner-only" "prd-api/src/PrdAgent.Infrastructure/Services/InfraAgentSessions/InfraAgentSessionService.cs" "team-aware profile gate copy"
require_match "InfraAgentGovernanceOwnerPolicyView" "prd-api/src/PrdAgent.Core/Interfaces/IInfraAgentSessionService.cs" "owner policy DTO"
require_match "P3-5" "doc/design.cds.agent.commercial-architecture-and-roadmap.md" "roadmap entry"

echo "PASS: CDS Agent governance dashboard static smoke"
