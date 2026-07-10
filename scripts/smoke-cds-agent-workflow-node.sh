#!/usr/bin/env bash
# RETIRED 2026-07-09（整组退役，见 doc/debt.cds.agent.acceptance-smoke-drift.md）
# 这批手工取证 smoke 用硬编码文案 grep -Fq 断言，文档改写后已链式漂移失效。
# 按台账「修复或退役」一次性决策：退役。未接 CI，保留文件仅作历史取证参考，
# 不再维护、不作为验收依据。如需同类校验请改用结构化锚点重写并接最小 CI。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_EXECUTOR="$ROOT_DIR/prd-api/src/PrdAgent.Api/Services/CapsuleExecutor.cs"
API_REGISTRY="$ROOT_DIR/prd-api/src/PrdAgent.Core/Models/CapsuleTypeRegistry.cs"
WORKFLOW_TEMPLATE="$ROOT_DIR/prd-admin/src/pages/workflow-agent/workflowTemplates.ts"
EXEC_DETAIL="$ROOT_DIR/prd-admin/src/pages/workflow-agent/ExecutionDetailPanel.tsx"
FRONT_REGISTRY="$ROOT_DIR/prd-admin/src/pages/workflow-agent/capsuleRegistry.tsx"
DOC="$ROOT_DIR/doc/design.cds.agent.commercial-architecture-and-roadmap.md"

require_text() {
  local file="$1"
  local needle="$2"
  local label="$3"
  if ! grep -Fq "$needle" "$file"; then
    printf 'missing %s: %s\n' "$label" "$needle" >&2
    printf 'file: %s\n' "$file" >&2
    exit 1
  fi
  printf 'ok %s\n' "$label"
}

printf '==========================================\n'
printf 'smoke: CDS Agent workflow node P1-4\n'
printf '==========================================\n'

require_text "$API_EXECUTOR" 'requestedSessionId' 'session reuse support'
require_text "$API_EXECUTOR" 'readonly-auto' 'readonly default policy'
require_text "$API_EXECUTOR" 'cds-agent-workflow-run' 'workflow run handle kind'
require_text "$API_EXECUTOR" 'eventsCursor' 'events cursor output'
require_text "$API_EXECUTOR" 'workbenchPath' 'CDS workbench deep link'
require_text "$API_REGISTRY" '复用 Session' 'schema exposes reusable session'
require_text "$API_REGISTRY" 'workspaceRoot' 'schema exposes workspace root'
require_text "$API_REGISTRY" 'gitRepository' 'schema exposes git repository'
require_text "$API_REGISTRY" 'cds-agent-run' 'schema exposes run handle slot'
require_text "$API_REGISTRY" 'cds-agent-approval' 'schema exposes approval request slot'
require_text "$API_EXECUTOR" 'workspaceRoot' 'workflow run forwards workspace root'
require_text "$API_EXECUTOR" 'gitRepository' 'workflow run forwards git repository'
require_text "$WORKFLOW_TEMPLATE" 'cds-agent-readonly-review' 'template id'
require_text "$WORKFLOW_TEMPLATE" 'Start -> CdsAgentRun -> Notify' 'template topology label'
require_text "$WORKFLOW_TEMPLATE" "nodeType: 'cds-agent'" 'template contains cds-agent node'
require_text "$WORKFLOW_TEMPLATE" "stopAfterRun: 'true'" 'template defaults to run-once'
require_text "$WORKFLOW_TEMPLATE" "nodeType: 'notification-sender'" 'template contains notify node'
require_text "$EXEC_DETAIL" 'readCdsAgentRunHandle' 'execution detail parses handle'
require_text "$EXEC_DETAIL" 'CDS 面板' 'execution detail workbench link'
require_text "$FRONT_REGISTRY" '只读代码巡检' 'frontend registry scoped to readonly'
require_text "$DOC" 'P1-4' 'authoritative doc contains P1-4 row'

printf '\nCDS Agent workflow node smoke passed.\n'
