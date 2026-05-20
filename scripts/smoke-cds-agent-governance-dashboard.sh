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
require_match "P3-5" "doc/design.cds-agent-commercial-architecture-and-roadmap.md" "roadmap entry"

echo "PASS: CDS Agent governance dashboard static smoke"
