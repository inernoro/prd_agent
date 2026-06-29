#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_EXECUTOR="$ROOT_DIR/prd-api/src/PrdAgent.Api/Services/CapsuleExecutor.cs"
API_WORKER="$ROOT_DIR/prd-api/src/PrdAgent.Api/Services/WorkflowRunWorker.cs"
API_CONTROLLER="$ROOT_DIR/prd-api/src/PrdAgent.Api/Controllers/Api/WorkflowAgentController.cs"
API_MODELS="$ROOT_DIR/prd-api/src/PrdAgent.Core/Models/WorkflowModels.cs"
API_REGISTRY="$ROOT_DIR/prd-api/src/PrdAgent.Core/Models/CapsuleTypeRegistry.cs"
EXEC_DETAIL="$ROOT_DIR/prd-admin/src/pages/workflow-agent/ExecutionDetailPanel.tsx"
EXEC_LIST="$ROOT_DIR/prd-admin/src/pages/workflow-agent/ExecutionListPanel.tsx"
CONTRACTS="$ROOT_DIR/prd-admin/src/services/contracts/workflowAgent.ts"
TEMPLATE="$ROOT_DIR/prd-admin/src/pages/workflow-agent/workflowTemplates.ts"
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
printf 'smoke: CDS Agent workflow approval P2-4\n'
printf '==========================================\n'

require_text "$API_MODELS" 'WaitingApproval = "waiting_approval"' 'workflow waiting_approval status'
require_text "$API_MODELS" 'TimedOut = "timed_out"' 'workflow timed_out status'
require_text "$API_EXECUTOR" 'workflowApprovalMode' 'cds-agent approval mode config'
require_text "$API_EXECUTOR" 'approvalTimeoutSeconds' 'approval timeout config'
require_text "$API_EXECUTOR" 'approvalToolName' 'approval tool config'
require_text "$API_EXECUTOR" 'kb_apply' 'kb_apply approval default'
require_text "$API_EXECUTOR" 'cds-agent-approval' 'approval artifact emitted'
require_text "$API_EXECUTOR" 'continuePath' 'continue path in approval artifact'
require_text "$API_EXECUTOR" 'rejectPath' 'reject path in approval artifact'
require_text "$API_WORKER" 'execution-waiting-approval' 'workflow emits waiting approval event'
require_text "$API_WORKER" 'NodeExecutionStatus.WaitingApproval' 'node waiting approval persisted'
require_text "$API_CONTROLLER" 'reject-approval' 'reject approval endpoint'
require_text "$API_CONTROLLER" 'ToolApprovalRequest("deny")' 'reject sends deny decision'
require_text "$API_CONTROLLER" 'APPROVAL_TIMEOUT' 'timeout guard'
require_text "$API_REGISTRY" 'approvalTimeoutSeconds' 'registry exposes approval timeout'
require_text "$API_REGISTRY" 'cds-agent-approval' 'registry exposes approval output slot'
require_text "$CONTRACTS" "waiting_approval: '等待审批'" 'frontend status label'
require_text "$CONTRACTS" "timed_out: '已超时'" 'frontend timeout label'
require_text "$EXEC_DETAIL" 'execution-waiting-approval' 'detail panel handles waiting event'
require_text "$EXEC_DETAIL" 'rejectApproval' 'detail panel rejects approval'
require_text "$EXEC_DETAIL" 'readCdsAgentApproval' 'detail panel renders approval artifact'
require_text "$EXEC_LIST" 'waiting_approval' 'list panel filters waiting approval'
require_text "$TEMPLATE" 'cds-agent-approval-review' 'approval workflow template'
require_text "$TEMPLATE" "approvalToolName: 'kb_apply'" 'template uses kb_apply approval'
require_text "$DOC" 'P2-4 工作流审批暂停/恢复' 'authoritative doc contains P2-4'

printf '\nCDS Agent workflow approval smoke passed.\n'
