#!/usr/bin/env bash
# RETIRED 2026-07-09（整组退役，见 doc/debt.cds.agent.acceptance-smoke-drift.md）
# 这批手工取证 smoke 用硬编码文案 grep -Fq 断言，文档改写后已链式漂移失效。
# 按台账「修复或退役」一次性决策：退役。未接 CI，保留文件仅作历史取证参考，
# 不再维护、不作为验收依据。如需同类校验请改用结构化锚点重写并接最小 CI。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
POLICY_FILE="$ROOT/prd-api/src/PrdAgent.Core/Models/InfraAgentSession.cs"
SESSION_SERVICE_FILE="$ROOT/prd-api/src/PrdAgent.Infrastructure/Services/InfraAgentSessions/InfraAgentSessionService.cs"
CONTROLLER_FILE="$ROOT/prd-api/src/PrdAgent.Api/Controllers/Api/AgentToolsController.cs"
REGISTRY_FILE="$ROOT/prd-api/src/PrdAgent.Core/Models/CapsuleTypeRegistry.cs"
INFRA_PAGE_FILE="$ROOT/prd-admin/src/pages/infra-services/InfraServicesPage.tsx"
DOC_FILE="$ROOT/doc/design.cds.agent.commercial-architecture-and-roadmap.md"

for file in "$POLICY_FILE" "$SESSION_SERVICE_FILE" "$CONTROLLER_FILE" "$REGISTRY_FILE" "$INFRA_PAGE_FILE" "$DOC_FILE"; do
  test -f "$file"
done

grep -q 'CodeWritableConfirm = "code-writable-confirm"' "$POLICY_FILE"
grep -q 'IsCodeWritableTool' "$POLICY_FILE"
grep -q 'repo_write_file' "$POLICY_FILE"
grep -q 'repo_run_command' "$POLICY_FILE"
grep -q 'repo_create_pull_request' "$POLICY_FILE"
grep -q 'normalized == CodeWritableConfirm' "$POLICY_FILE"

grep -q 'InfraAgentToolPolicies.ShouldExposeToolToRuntime' "$SESSION_SERVICE_FILE"
grep -q 'InfraAgentToolPolicies.Normalize' "$SESSION_SERVICE_FILE"
grep -q 'InfraAgentToolPolicies.AllowsToolInvocation' "$CONTROLLER_FILE"
grep -q 'tool_denied_by_writable_profile' "$CONTROLLER_FILE"

grep -q 'code-writable-confirm' "$REGISTRY_FILE"
grep -q 'code-writable-confirm' "$INFRA_PAGE_FILE"
grep -q '代码 writable profile' "$DOC_FILE"

if awk '/if \(normalized is ReadonlyAuto or AutoAllowReadonly\)/,/if \(normalized == CodeWritableConfirm\)/' "$POLICY_FILE" | grep -Eq 'repo_write_file|repo_run_command|repo_create_pull_request|Bash|Edit|Write'; then
  echo "readonly-auto policy must not expose code write tools" >&2
  exit 1
fi

if awk '/if \(IsCodeWritableTool\(toolName\)\)/,/return normalized is ConfirmDangerous or ManualAll/' "$POLICY_FILE" | grep -q 'return false'; then
  echo "ok: legacy dangerous policies no longer expose code write tools"
else
  echo "confirm-dangerous/manual-all must not expose code write tools without code-writable-confirm" >&2
  exit 1
fi

echo "ok: CDS Agent code writable tools require explicit code-writable-confirm profile and MAP approval gate"
