#!/usr/bin/env bash
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
