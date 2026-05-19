#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL_FILE="$ROOT/prd-api/src/PrdAgent.Core/Models/KnowledgeBaseDraft.cs"
TOOL_FILE="$ROOT/prd-api/src/PrdAgent.Infrastructure/Services/AgentTools/Tools/KnowledgeBaseDraftTools.cs"
REGISTRY_FILE="$ROOT/prd-api/src/PrdAgent.Infrastructure/Services/AgentTools/AgentToolRegistry.cs"
SESSION_SERVICE_FILE="$ROOT/prd-api/src/PrdAgent.Infrastructure/Services/InfraAgentSessions/InfraAgentSessionService.cs"
POLICY_FILE="$ROOT/prd-api/src/PrdAgent.Core/Models/InfraAgentSession.cs"
DB_FILE="$ROOT/prd-api/src/PrdAgent.Infrastructure/Database/MongoDbContext.cs"
DOC_FILE="$ROOT/doc/design.cds-agent-commercial-architecture-and-roadmap.md"

for file in "$MODEL_FILE" "$TOOL_FILE" "$REGISTRY_FILE" "$SESSION_SERVICE_FILE" "$POLICY_FILE" "$DB_FILE" "$DOC_FILE"; do
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

grep -q 'ShouldExposeToolToRuntime' "$SESSION_SERVICE_FILE"
grep -q 'InfraAgentToolPolicies.ShouldExposeToolToRuntime' "$SESSION_SERVICE_FILE"
if awk '/public static bool IsReadonlyTool/,/public static bool IsCodeWritableTool/' "$POLICY_FILE" | grep -Eq 'kb_draft_create|kb_draft_discard|kb_apply|kb_reject|repo_write_file|repo_create_pull_request'; then
  echo "readonly-auto runtime must not expose draft write or repo write tools" >&2
  exit 1
fi

grep -q 'P2-2 KnowledgeBase draft workspace' "$DOC_FILE"
grep -q 'kb_draft_create/read/list/discard' "$DOC_FILE"

echo "ok: CDS Agent KnowledgeBase draft workspace tools are registered and hidden from readonly-auto runtime"
