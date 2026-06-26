#!/usr/bin/env bash
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
