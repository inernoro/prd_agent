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

require_match "GetSlaDashboardAsync" "prd-api/src/PrdAgent.Core/Interfaces/IInfraAgentSessionService.cs" "service contract"
require_match "InfraAgentSlaDashboardView" "prd-api/src/PrdAgent.Core/Interfaces/IInfraAgentSessionService.cs" "SLA DTO"
require_match "BuildSlaDashboard" "prd-api/src/PrdAgent.Infrastructure/Services/InfraAgentSessions/InfraAgentSessionService.cs" "SLA aggregation"
require_match "HttpGet\\(\"sla-dashboard\"\\)" "prd-api/src/PrdAgent.Api/Controllers/Api/InfraAgentSessionsController.cs" "SLA endpoint"
require_match "getInfraAgentSlaDashboard" "prd-admin/src/services/real/infraAgentSessions.ts" "frontend API client"
require_match "SLA / 成本" "prd-admin/src/pages/cds-agent/CdsAgentPage.tsx" "SLA panel"
require_match "cds-agent-sla-dashboard/v1" "prd-api/tests/PrdAgent.Api.Tests/Services/InfraAgentSessionServiceSlaDashboardTests.cs" "SLA unit evidence"
require_match "P3-3" "doc/design.cds-agent-commercial-architecture-and-roadmap.md" "roadmap entry"

echo "PASS: CDS Agent SLA dashboard static smoke"
