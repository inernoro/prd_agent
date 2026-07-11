#!/usr/bin/env bash
# RETIRED 2026-07-09（整组退役，见 doc/debt.cds.agent.acceptance-smoke-drift.md）
# 这批手工取证 smoke 用硬编码文案 grep -Fq 断言，文档改写后已链式漂移失效。
# 按台账「修复或退役」一次性决策：退役。未接 CI，保留文件仅作历史取证参考，
# 不再维护、不作为验收依据。如需同类校验请改用结构化锚点重写并接最小 CI。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INTERFACE_FILE="$ROOT/prd-api/src/PrdAgent.Core/Interfaces/IInfraAgentRuntimeProfileService.cs"
SERVICE_FILE="$ROOT/prd-api/src/PrdAgent.Infrastructure/Services/InfraAgentSessions/InfraAgentRuntimeProfileService.cs"
CONTROLLER_FILE="$ROOT/prd-api/src/PrdAgent.Api/Controllers/Api/InfraAgentRuntimeProfilesController.cs"
API_FILE="$ROOT/prd-admin/src/services/api.ts"
CLIENT_FILE="$ROOT/prd-admin/src/services/real/infraAgentSessions.ts"
PAGE_FILE="$ROOT/prd-admin/src/pages/cds-agent/CdsAgentPage.tsx"
DOC_FILE="$ROOT/doc/design.cds.agent.commercial-architecture-and-roadmap.md"

for file in "$INTERFACE_FILE" "$SERVICE_FILE" "$CONTROLLER_FILE" "$API_FILE" "$CLIENT_FILE" "$PAGE_FILE" "$DOC_FILE"; do
  test -f "$file"
done

grep -q 'GetAdapterMatrixAsync' "$INTERFACE_FILE"
grep -q 'InfraAgentRuntimeAdapterMatrixView' "$INTERFACE_FILE"
grep -q 'cds-agent-runtime-adapter-matrix/v1' "$INTERFACE_FILE"
grep -q 'BuildMatrix' "$INTERFACE_FILE"
grep -q 'planned-blocked' "$INTERFACE_FILE"
grep -q '\[HttpGet("adapter-matrix")\]' "$CONTROLLER_FILE"
grep -q 'GetAdapterMatrixAsync' "$SERVICE_FILE"

grep -q 'adapterMatrix' "$API_FILE"
grep -q 'getInfraAgentRuntimeAdapterMatrix' "$CLIENT_FILE"
grep -q 'InfraAgentRuntimeAdapterMatrixView' "$CLIENT_FILE"
grep -q 'Adapter matrix' "$PAGE_FILE"
grep -q 'routeState' "$PAGE_FILE"
grep -q 'missingAdapterContracts' "$PAGE_FILE"

grep -q 'P3-2 多运行时 adapter matrix' "$DOC_FILE"
grep -q 'scripts/smoke-cds-agent-adapter-matrix.sh' "$DOC_FILE"

echo "ok: CDS Agent adapter matrix API, client panel, and roadmap evidence are wired"
