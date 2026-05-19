#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL_FILE="$ROOT/prd-api/src/PrdAgent.Core/Models/KnowledgeBaseDraft.cs"
TOOL_FILE="$ROOT/prd-api/src/PrdAgent.Infrastructure/Services/AgentTools/Tools/KnowledgeBaseDraftTools.cs"
REGISTRY_FILE="$ROOT/prd-api/src/PrdAgent.Infrastructure/Services/AgentTools/AgentToolRegistry.cs"
SESSION_SERVICE_FILE="$ROOT/prd-api/src/PrdAgent.Infrastructure/Services/InfraAgentSessions/InfraAgentSessionService.cs"
DB_FILE="$ROOT/prd-api/src/PrdAgent.Infrastructure/Database/MongoDbContext.cs"
DOC_FILE="$ROOT/doc/design.cds-agent-commercial-architecture-and-roadmap.md"

for file in "$MODEL_FILE" "$TOOL_FILE" "$REGISTRY_FILE" "$SESSION_SERVICE_FILE" "$DB_FILE" "$DOC_FILE"; do
  test -f "$file"
done

for tool in kb_draft_create kb_draft_read kb_draft_list kb_draft_discard; do
  grep -q "Name = \"$tool\"" "$TOOL_FILE"
done

for klass in KbDraftCreateTool KbDraftReadTool KbDraftListTool KbDraftDiscardTool; do
  grep -q "new $klass" "$REGISTRY_FILE"
done

grep -q 'knowledge_base_drafts' "$DB_FILE"
grep -q 'KnowledgeBaseDraftStatuses.Draft' "$MODEL_FILE"

if grep -Eq 'Name = "kb_(diff|apply|reject)"' "$TOOL_FILE" "$REGISTRY_FILE"; then
  echo "unexpected P2-3 knowledge-base diff/apply/reject tool registered in P2-2" >&2
  exit 1
fi

grep -q 'ShouldExposeToolToRuntime' "$SESSION_SERVICE_FILE"
grep -q '"readonly-auto" or "auto-allow-readonly"' "$SESSION_SERVICE_FILE"
if awk '/policy is "readonly-auto" or "auto-allow-readonly"/,/return true/' "$SESSION_SERVICE_FILE" | grep -Eq 'kb_draft_create|kb_draft_discard|repo_write_file|repo_create_pull_request'; then
  echo "readonly-auto runtime must not expose draft write or repo write tools" >&2
  exit 1
fi

if grep -Eq '_db\.Document(Stores|Entries|s)\.(Insert|Update|Replace|Delete)(One|Many)?Async' "$TOOL_FILE"; then
  echo "P2-2 draft tools must not write formal knowledge-base collections" >&2
  exit 1
fi

grep -q 'P2-2 KnowledgeBase draft workspace' "$DOC_FILE"
grep -q 'kb_draft_create/read/list/discard' "$DOC_FILE"

echo "ok: CDS Agent KnowledgeBase draft workspace tools are registered without formal KB apply paths"
