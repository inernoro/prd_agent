#!/usr/bin/env bash
# RETIRED 2026-07-09（整组退役，见 doc/debt.cds.agent.acceptance-smoke-drift.md）
# 这批手工取证 smoke 用硬编码文案 grep -Fq 断言，文档改写后已链式漂移失效。
# 按台账「修复或退役」一次性决策：退役。未接 CI，保留文件仅作历史取证参考，
# 不再维护、不作为验收依据。如需同类校验请改用结构化锚点重写并接最小 CI。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOL_FILE="$ROOT/prd-api/src/PrdAgent.Infrastructure/Services/AgentTools/Tools/KnowledgeBaseDraftTools.cs"
REGISTRY_FILE="$ROOT/prd-api/src/PrdAgent.Infrastructure/Services/AgentTools/AgentToolRegistry.cs"
CONTROLLER_FILE="$ROOT/prd-api/src/PrdAgent.Api/Controllers/Api/AgentToolsController.cs"
SESSION_SERVICE_FILE="$ROOT/prd-api/src/PrdAgent.Infrastructure/Services/InfraAgentSessions/InfraAgentSessionService.cs"
POLICY_FILE="$ROOT/prd-api/src/PrdAgent.Core/Models/InfraAgentSession.cs"
ADMIN_PAGE_FILE="$ROOT/prd-admin/src/pages/cds-agent/CdsAgentPage.tsx"
DOC_FILE="$ROOT/doc/design.cds.agent.commercial-architecture-and-roadmap.md"

for file in "$TOOL_FILE" "$REGISTRY_FILE" "$CONTROLLER_FILE" "$SESSION_SERVICE_FILE" "$POLICY_FILE" "$ADMIN_PAGE_FILE" "$DOC_FILE"; do
  test -f "$file"
done

for tool in kb_diff kb_apply kb_reject; do
  grep -q "Name = \"$tool\"" "$TOOL_FILE"
done

for klass in KbDiffTool KbApplyTool KbRejectTool; do
  grep -q "new $klass" "$REGISTRY_FILE"
done

grep -q '"kb_apply" => "write"' "$CONTROLLER_FILE"
grep -q 'ApprovalId = req.ApprovalId' "$CONTROLLER_FILE"
grep -q 'kb_apply_approval_required' "$TOOL_FILE"
grep -q 'kb_apply_conflict' "$TOOL_FILE"
grep -q 'BaseContentHash' "$TOOL_FILE"
grep -q 'BaseUpdatedAt' "$TOOL_FILE"
grep -q 'ApplyApprovalId' "$TOOL_FILE"
grep -q 'BuildUnifiedDiff' "$TOOL_FILE"
grep -q 'unifiedDiff' "$ADMIN_PAGE_FILE"
grep -q '知识库 diff' "$ADMIN_PAGE_FILE"
grep -q "case 'kb_apply'" "$ADMIN_PAGE_FILE"

grep -q 'InfraAgentToolPolicies.ShouldExposeToolToRuntime' "$SESSION_SERVICE_FILE"
if awk '/public static bool IsReadonlyTool/,/public static bool IsCodeWritableTool/' "$POLICY_FILE" | grep -Eq 'kb_apply|kb_reject'; then
  echo "readonly-auto runtime must not expose kb_apply/kb_reject" >&2
  exit 1
fi

if ! awk '/public static bool IsReadonlyTool/,/public static bool IsCodeWritableTool/' "$POLICY_FILE" | grep -q 'kb_diff'; then
  echo "readonly-auto runtime should expose readonly kb_diff" >&2
  exit 1
fi

grep -q 'P2-3 KnowledgeBase diff/apply/reject' "$DOC_FILE"
grep -q 'kb_apply.*MAP approval' "$DOC_FILE"

echo "ok: CDS Agent KnowledgeBase diff/apply/reject tools enforce MAP approval and readonly runtime boundaries"
