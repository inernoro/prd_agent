#!/usr/bin/env bash
# RETIRED 2026-07-09（整组退役，见 doc/debt.cds.agent.acceptance-smoke-drift.md）
# 这批手工取证 smoke 用硬编码文案 grep -Fq 断言，文档改写后已链式漂移失效。
# 按台账「修复或退役」一次性决策：退役。未接 CI，保留文件仅作历史取证参考，
# 不再维护、不作为验收依据。如需同类校验请改用结构化锚点重写并接最小 CI。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INTERFACE_FILE="$ROOT/prd-api/src/PrdAgent.Core/Interfaces/IInfraAgentSessionService.cs"
SESSION_SERVICE_FILE="$ROOT/prd-api/src/PrdAgent.Infrastructure/Services/InfraAgentSessions/InfraAgentSessionService.cs"
CONTROLLER_FILE="$ROOT/prd-api/src/PrdAgent.Api/Controllers/Api/InfraAgentSessionsController.cs"
API_FILE="$ROOT/prd-admin/src/services/api.ts"
CLIENT_FILE="$ROOT/prd-admin/src/services/real/infraAgentSessions.ts"
PAGE_FILE="$ROOT/prd-admin/src/pages/cds-agent/CdsAgentPage.tsx"
DOC_FILE="$ROOT/doc/design.cds.agent.commercial-architecture-and-roadmap.md"

for file in "$INTERFACE_FILE" "$SESSION_SERVICE_FILE" "$CONTROLLER_FILE" "$API_FILE" "$CLIENT_FILE" "$PAGE_FILE" "$DOC_FILE"; do
  test -f "$file"
done

grep -q 'GetTraceBundleAsync' "$INTERFACE_FILE"
grep -q 'InfraAgentTraceBundleView' "$INTERFACE_FILE"
grep -q 'cds-agent-trace-bundle/v1' "$SESSION_SERVICE_FILE"
grep -q 'BuildTraceBundle' "$SESSION_SERVICE_FILE"
grep -q 'EventsTruncated' "$INTERFACE_FILE"
grep -q '\[HttpGet("{id}/trace-bundle")\]' "$CONTROLLER_FILE"
grep -q 'GetTraceBundleAsync(userId, id' "$CONTROLLER_FILE"

grep -q 'traceBundle' "$API_FILE"
grep -q 'getInfraAgentTraceBundle' "$CLIENT_FILE"
grep -q 'InfraAgentTraceBundleView' "$CLIENT_FILE"
grep -q 'getInfraAgentTraceBundle(activeSession.id)' "$PAGE_FILE"
grep -q 'Trace bundle 已导出' "$PAGE_FILE"
grep -q 'Run bundle 已导出' "$PAGE_FILE"

grep -q 'P3-1 trace/artifact bundle' "$DOC_FILE"
grep -q 'scripts/smoke-cds-agent-trace-bundle.sh' "$DOC_FILE"

echo "ok: CDS Agent trace bundle API, client export, and roadmap evidence are wired"
