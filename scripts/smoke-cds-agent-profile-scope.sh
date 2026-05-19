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

require_match "ListAsync\\(string userId, CancellationToken ct\\)" "prd-api/src/PrdAgent.Core/Interfaces/IInfraAgentRuntimeProfileService.cs" "user-scoped profile list contract"
require_match "ResolveAsync\\(string\\? id, string userId, CancellationToken ct\\)" "prd-api/src/PrdAgent.Core/Interfaces/IInfraAgentRuntimeProfileService.cs" "user-scoped profile resolve contract"
require_match "DeleteAsync\\(string id, string userId, CancellationToken ct\\)" "prd-api/src/PrdAgent.Core/Interfaces/IInfraAgentRuntimeProfileService.cs" "user-scoped profile delete contract"
require_match "TestAsync\\(string id, string userId, CancellationToken ct\\)" "prd-api/src/PrdAgent.Core/Interfaces/IInfraAgentRuntimeProfileService.cs" "user-scoped profile test contract"
require_match "ProfileOwnerFilter\\(userId\\)" "prd-api/src/PrdAgent.Infrastructure/Services/InfraAgentSessions/InfraAgentRuntimeProfileService.cs" "runtime profile owner filter"
require_match "ProfileIdOwnerFilter\\(id, userId\\)" "prd-api/src/PrdAgent.Infrastructure/Services/InfraAgentSessions/InfraAgentRuntimeProfileService.cs" "runtime profile id+owner filter"
require_match "GetRequiredUserId\\(\\)" "prd-api/src/PrdAgent.Api/Controllers/Api/InfraAgentRuntimeProfilesController.cs" "runtime profile controller subject"
require_match "ResolveRuntimeProfileForSessionAsync\\(userId, session.RuntimeProfileId" "prd-api/src/PrdAgent.Infrastructure/Services/InfraAgentSessions/InfraAgentSessionService.cs" "session start scoped profile resolve"
require_match "ResolveRuntimeProfileForSessionAsync\\(session.UserId, session.RuntimeProfileId" "prd-api/src/PrdAgent.Infrastructure/Services/InfraAgentSessions/InfraAgentSessionService.cs" "background scoped profile resolve"
require_match "CreatedByUserId == userId && x.IsDefault" "prd-api/src/PrdAgent.Api/Services/CapsuleExecutor.cs" "workflow scoped default profile"
require_match "Builders<BsonDocument>\\.Filter\\.Eq\\(\"CreatedByUserId\", userId\\)" "prd-api/src/PrdAgent.Api/Services/Toolbox/Adapters/CdsAgentAdapter.cs" "toolbox raw fallback scoped profile"
require_match "GOV-PROFILE-SCOPE\"\\)" "prd-api/tests/PrdAgent.Api.Tests/Services/InfraAgentSessionServiceGovernanceDashboardTests.cs" "governance scope test evidence"
require_absent "Find\\(_ => true\\).*InfraAgentRuntimeProfiles" "prd-api/src/PrdAgent.Api/Services/CapsuleExecutor.cs" "workflow global profile query"

echo "PASS: CDS Agent runtime profile subject-scope static smoke"
