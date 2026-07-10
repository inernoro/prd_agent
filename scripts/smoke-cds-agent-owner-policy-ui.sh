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

require_match "OwnerPolicies" "prd-api/src/PrdAgent.Core/Interfaces/IInfraAgentSessionService.cs" "governance owner policies contract"
require_match "InfraAgentGovernanceOwnerPolicyView" "prd-api/src/PrdAgent.Core/Interfaces/IInfraAgentSessionService.cs" "governance owner policy view"
require_match "Repository owner" "prd-api/src/PrdAgent.Infrastructure/Services/InfraAgentSessions/InfraAgentSessionService.cs" "repository owner policy"
require_match "Runtime profile owner" "prd-api/src/PrdAgent.Infrastructure/Services/InfraAgentSessions/InfraAgentSessionService.cs" "runtime profile owner policy"
require_match "Approval owner" "prd-api/src/PrdAgent.Infrastructure/Services/InfraAgentSessions/InfraAgentSessionService.cs" "approval owner policy"
require_match "owner-or-team-visible" "prd-api/src/PrdAgent.Infrastructure/Services/InfraAgentSessions/InfraAgentSessionService.cs" "team-aware profile owner state"
require_match "needs-approval-owner" "prd-api/src/PrdAgent.Infrastructure/Services/InfraAgentSessions/InfraAgentSessionService.cs" "approval owner missing state"
require_match "ownerPolicies" "prd-admin/src/services/real/infraAgentSessions.ts" "frontend owner policies type"
require_match "governanceOwnerPolicies" "prd-admin/src/pages/cds-agent/CdsAgentPage.tsx" "frontend owner policies binding"
require_match "policy\\.owner" "prd-admin/src/pages/cds-agent/CdsAgentPage.tsx" "frontend owner policy owner field"
require_match "policy\\.nextAction" "prd-admin/src/pages/cds-agent/CdsAgentPage.tsx" "frontend owner policy next action"
require_match "owner-or-team-visible" "prd-api/tests/PrdAgent.Api.Tests/Services/InfraAgentSessionServiceGovernanceDashboardTests.cs" "owner policy unit evidence"
require_match "P3-5d repository/profile/approval owner UI" "doc/design.cds.agent.commercial-architecture-and-roadmap.md" "roadmap next entry"

echo "PASS: CDS Agent owner policy UI static smoke"
