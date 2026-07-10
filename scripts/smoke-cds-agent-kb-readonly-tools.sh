#!/usr/bin/env bash
# RETIRED 2026-07-09（整组退役，见 doc/debt.cds.agent.acceptance-smoke-drift.md）
# 这批手工取证 smoke 用硬编码文案 grep -Fq 断言，文档改写后已链式漂移失效。
# 按台账「修复或退役」一次性决策：退役。未接 CI，保留文件仅作历史取证参考，
# 不再维护、不作为验收依据。如需同类校验请改用结构化锚点重写并接最小 CI。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOL_FILE="$ROOT/prd-api/src/PrdAgent.Infrastructure/Services/AgentTools/Tools/KnowledgeBaseReadonlyTools.cs"
REGISTRY_FILE="$ROOT/prd-api/src/PrdAgent.Infrastructure/Services/AgentTools/AgentToolRegistry.cs"
DOC_FILE="$ROOT/doc/design.cds.agent.commercial-architecture-and-roadmap.md"

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
