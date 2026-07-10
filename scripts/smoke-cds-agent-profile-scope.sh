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
require_match "ProfileAccessibleFilter\\(userId, teamIds\\)" "prd-api/src/PrdAgent.Infrastructure/Services/InfraAgentSessions/InfraAgentRuntimeProfileService.cs" "runtime profile owner-or-team accessible filter"
require_match "GetRequiredUserId\\(\\)" "prd-api/src/PrdAgent.Api/Controllers/Api/InfraAgentRuntimeProfilesController.cs" "runtime profile controller subject"
require_match "ResolveRuntimeProfileForSessionAsync\\(userId, session.RuntimeProfileId" "prd-api/src/PrdAgent.Infrastructure/Services/InfraAgentSessions/InfraAgentSessionService.cs" "session start scoped profile resolve"
require_match "ResolveRuntimeProfileForSessionAsync\\(session.UserId, session.RuntimeProfileId" "prd-api/src/PrdAgent.Infrastructure/Services/InfraAgentSessions/InfraAgentSessionService.cs" "background scoped profile resolve"
require_match "ownedProfileFilter & profileBuilder\\.Eq\\(x => x\\.IsDefault, true\\)" "prd-api/src/PrdAgent.Api/Services/CapsuleExecutor.cs" "workflow owned default profile priority"
require_match "sharedProfileFilter & profileBuilder\\.Eq\\(x => x\\.IsDefault, true\\)" "prd-api/src/PrdAgent.Api/Services/CapsuleExecutor.cs" "workflow team-shared default profile fallback"
require_match "builder\\.Eq\\(\"CreatedByUserId\", userId\\)" "prd-api/src/PrdAgent.Api/Services/Toolbox/Adapters/CdsAgentAdapter.cs" "toolbox raw fallback scoped profile"
require_match "GOV-PROFILE-SCOPE\"\\)" "prd-api/tests/PrdAgent.Api.Tests/Services/InfraAgentSessionServiceGovernanceDashboardTests.cs" "governance scope test evidence"
require_absent "Find\\(_ => true\\).*InfraAgentRuntimeProfiles" "prd-api/src/PrdAgent.Api/Services/CapsuleExecutor.cs" "workflow global profile query"

echo "PASS: CDS Agent runtime profile owner/team subject-scope static smoke"
