#!/usr/bin/env bash
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
