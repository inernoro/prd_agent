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

require_absent() {
  local pattern="$1"
  local file="$2"
  local label="$3"
  if rg -q "$pattern" "$file"; then
    echo "FAIL: unexpected ${label} in ${file}" >&2
    exit 1
  fi
}

require_match "SharedTeamIds" "prd-api/src/PrdAgent.Core/Models/InfraAgentRuntimeProfile.cs" "runtime profile team-share field"
require_match "IReadOnlyList<string>\\? SharedTeamIds" "prd-api/src/PrdAgent.Core/Interfaces/IInfraAgentRuntimeProfileService.cs" "runtime profile request/view shared team contract"
require_match "string Scope = \"user-owned\"" "prd-api/src/PrdAgent.Core/Interfaces/IInfraAgentRuntimeProfileService.cs" "runtime profile scope view contract"
require_match "OwnerUserId" "prd-api/src/PrdAgent.Core/Interfaces/IInfraAgentRuntimeProfileService.cs" "runtime profile owner view contract"
require_match "SharedTeamNotAccessible" "prd-api/src/PrdAgent.Core/Interfaces/IInfraAgentRuntimeProfileService.cs" "shared team access error code"
require_match "NormalizeSharedTeamIdsAsync" "prd-api/src/PrdAgent.Infrastructure/Services/InfraAgentSessions/InfraAgentRuntimeProfileService.cs" "shared team validation"
require_match "ProfileAccessibleFilter\\(userId, teamIds\\)" "prd-api/src/PrdAgent.Infrastructure/Services/InfraAgentSessions/InfraAgentRuntimeProfileService.cs" "profile list owner-or-team filter"
require_match "ProfileIdOwnerFilter\\(id, userId\\)" "prd-api/src/PrdAgent.Infrastructure/Services/InfraAgentSessions/InfraAgentRuntimeProfileService.cs" "owner-only update/delete guard"
require_match "ProfileIdAccessibleFilter\\(id, userId, teamIds\\)" "prd-api/src/PrdAgent.Infrastructure/Services/InfraAgentSessions/InfraAgentRuntimeProfileService.cs" "explicit resolve owner-or-team guard"
require_match "request.SharedTeamIds == null" "prd-api/src/PrdAgent.Infrastructure/Services/InfraAgentSessions/InfraAgentRuntimeProfileService.cs" "update preserves existing sharing when omitted"
require_match "AnyIn\\(x => x.SharedTeamIds" "prd-api/src/PrdAgent.Api/Services/CapsuleExecutor.cs" "workflow capsule shared profile visibility"
require_match "AnyIn\\(\"SharedTeamIds\"" "prd-api/src/PrdAgent.Api/Services/Toolbox/Adapters/CdsAgentAdapter.cs" "toolbox fallback shared profile visibility"
require_match "TeamSharedRuntimeProfileCount" "prd-api/src/PrdAgent.Core/Interfaces/IInfraAgentSessionService.cs" "governance team-shared profile count"
require_match "enforced-team-aware" "prd-api/src/PrdAgent.Infrastructure/Services/InfraAgentSessions/InfraAgentSessionService.cs" "governance team-aware gate state"
require_match "team-shared profile" "prd-api/tests/PrdAgent.Api.Tests/Services/InfraAgentSessionServiceGovernanceDashboardTests.cs" "team-shared governance unit evidence"
require_match "团队共享" "prd-admin/src/pages/cds-agent/CdsAgentPage.tsx" "frontend team-shared label"
require_match "team shared" "prd-admin/src/pages/cds-agent/CdsAgentPage.tsx" "frontend governance summary hint"
require_absent "Find\\(_ => true\\).*InfraAgentRuntimeProfiles" "prd-api/src/PrdAgent.Api/Services/CapsuleExecutor.cs" "workflow global profile query"

echo "PASS: CDS Agent team-shared runtime profile policy static smoke"
