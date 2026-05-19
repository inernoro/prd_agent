#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOL_FILE="$ROOT/prd-api/src/PrdAgent.Infrastructure/Services/AgentTools/Tools/KnowledgeBaseReadonlyTools.cs"
REGISTRY_FILE="$ROOT/prd-api/src/PrdAgent.Infrastructure/Services/AgentTools/AgentToolRegistry.cs"
DOC_FILE="$ROOT/doc/design.cds-agent-commercial-architecture-and-roadmap.md"

test -f "$TOOL_FILE"

for tool in kb_list kb_search kb_read; do
  grep -q "Name = \"$tool\"" "$TOOL_FILE"
done

for klass in KbListTool KbSearchTool KbReadTool; do
  grep -q "new $klass" "$REGISTRY_FILE"
done

if grep -Eq 'Name = "kb_(write|create|diff|apply|commit)"' "$TOOL_FILE" "$REGISTRY_FILE"; then
  echo "unexpected knowledge-base write tool registered" >&2
  exit 1
fi

if grep -Eq '\.(Insert|Update|Replace|Delete)(One|Many)?Async\(' "$TOOL_FILE"; then
  echo "knowledge-base readonly tools contain Mongo write calls" >&2
  exit 1
fi

grep -q "kb_list/search/read" "$DOC_FILE"

echo "ok: CDS Agent KnowledgeBase readonly tools are registered without KB write paths"
