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

require_match "GetScheduleDashboardAsync" "prd-api/src/PrdAgent.Core/Interfaces/IInfraAgentSessionService.cs" "service contract"
require_match "InfraAgentScheduleDashboardView" "prd-api/src/PrdAgent.Core/Interfaces/IInfraAgentSessionService.cs" "schedule DTO"
require_match "BuildScheduleDashboard" "prd-api/src/PrdAgent.Infrastructure/Services/InfraAgentSessions/InfraAgentSessionService.cs" "schedule aggregation"
require_match "WorkflowScheduleWorker" "prd-api/src/PrdAgent.Api/Program.cs" "existing workflow scheduler registration"
require_match "HttpGet\\(\"schedule-dashboard\"\\)" "prd-api/src/PrdAgent.Api/Controllers/Api/InfraAgentSessionsController.cs" "schedule endpoint"
require_match "getInfraAgentScheduleDashboard" "prd-admin/src/services/real/infraAgentSessions.ts" "frontend API client"
require_match "定时巡检 / 知识治理" "prd-admin/src/pages/cds-agent/CdsAgentPage.tsx" "schedule panel"
require_match "kb_list" "prd-api/src/PrdAgent.Infrastructure/Services/AgentTools/Tools/KnowledgeBaseReadonlyTools.cs" "KB list readonly tool"
require_match "kb_search" "prd-api/src/PrdAgent.Infrastructure/Services/AgentTools/Tools/KnowledgeBaseReadonlyTools.cs" "KB search readonly tool"
require_match "kb_read" "prd-api/src/PrdAgent.Infrastructure/Services/AgentTools/Tools/KnowledgeBaseReadonlyTools.cs" "KB read readonly tool"
require_match "cds-agent-schedule-dashboard/v1" "prd-api/tests/PrdAgent.Api.Tests/Services/InfraAgentSessionServiceScheduleDashboardTests.cs" "schedule unit evidence"
require_match "P3-4" "doc/design.cds.agent.commercial-architecture-and-roadmap.md" "roadmap entry"

echo "PASS: CDS Agent schedule dashboard static smoke"
