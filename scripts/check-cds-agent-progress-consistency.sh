#!/usr/bin/env bash
# Verify the CDS Agent R0 progress surfaces agree on the current blocker and
# next action. This is local/read-only; it does not deploy, SSH, or push.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

REFRESH_OUTPUT="${CDS_AGENT_R0_STATUS_REFRESH:-/tmp/cds-agent-r0-status-refresh-current.md}"
PROGRESS_OUTPUT="${CDS_AGENT_R0_PROGRESS_OUTPUT:-/tmp/cds-agent-current-progress-current.md}"
STATUS_DOC="$ROOT_DIR/doc/status.cds-agent-current-progress.md"
RUNTIME_CAPACITY_SUMMARY="${CDS_AGENT_GOAL_RUNTIME_POOL_SUMMARY:-/tmp/cds-agent-runtime-pool-evidence-after-capacity-latest/summary.json}"

# When this check runs inside audit-cds-agent-goal.sh, CDS_AGENT_GOAL_AUDIT_REPORT
# points to the report that is still being generated. The progress board needs a
# completed goal-audit input, so fall back to its default source instead of
# treating the in-progress report path as authoritative.
if [[ -n "${CDS_AGENT_GOAL_AUDIT_REPORT:-}" && ! -f "$CDS_AGENT_GOAL_AUDIT_REPORT" ]]; then
  unset CDS_AGENT_GOAL_AUDIT_REPORT
fi

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_file() {
  local file="$1"
  [[ -f "$file" ]] || fail "missing file: $file"
}

require_text() {
  local file="$1"
  local needle="$2"
  local label="$3"
  if ! grep -Fq "$needle" "$file"; then
    printf 'ERROR: %s missing expected text in %s\n' "$label" "$file" >&2
    printf 'EXPECTED: %s\n' "$needle" >&2
    exit 1
  fi
}

require_absent() {
  local file="$1"
  local needle="$2"
  local label="$3"
  if grep -Fq "$needle" "$file"; then
    printf 'ERROR: %s found forbidden text in %s\n' "$label" "$file" >&2
    printf 'FORBIDDEN: %s\n' "$needle" >&2
    exit 1
  fi
}

"$SCRIPT_DIR/refresh-cds-agent-r0-status.sh" >/dev/null

require_file "$REFRESH_OUTPUT"
require_file "$PROGRESS_OUTPUT"
require_file "$STATUS_DOC"

runtime_capacity_available=false
if [[ -f "$RUNTIME_CAPACITY_SUMMARY" ]] && jq -e '
  ((.remoteHost.runtimeCapacityStatus // ([.runtimeCapacity.entries[]? | select(.step == "capacity-after") | .payload.status] | last) // "") == "available")
  or (((.remoteHost.runtimeCapacityRunning // ([.runtimeCapacity.entries[]? | select(.step == "capacity-after") | .payload.runningOfficialSdkRuntimeCount] | last) // 0) | tonumber) > 0)
' "$RUNTIME_CAPACITY_SUMMARY" >/dev/null 2>&1; then
  runtime_capacity_available=true
fi

progress_provider_complete=false
if grep -Fq 'Overall status: provider_smokes_passed' "$PROGRESS_OUTPUT" \
  && grep -Fq 'Current blocking gate: complete' "$PROGRESS_OUTPUT"; then
  progress_provider_complete=true
fi

require_text "$REFRESH_OUTPUT" 'operatorFallbackImageInput: `CDS_AGENT_SIDECAR_IMAGE`' 'refresh fallback image input'
require_text "$REFRESH_OUTPUT" 'runtimeCapacityStatus: `' 'refresh runtime capacity status'
if [[ "$progress_provider_complete" == "true" ]]; then
  require_text "$PROGRESS_OUTPUT" 'Overall status: provider_smokes_passed' 'progress overall status'
  require_text "$PROGRESS_OUTPUT" 'Current blocking gate: complete' 'progress blocking gate'
  require_text "$PROGRESS_OUTPUT" 'Provider cycle: commercialComplete=true; status=provider_smokes_passed' 'progress provider cycle'
  require_text "$PROGRESS_OUTPUT" 'Current provider-backed cycle is complete for the hardened read-only CDS Agent path' 'progress exact next step'
  require_text "$PROGRESS_OUTPUT" 'Do not redeploy or rebuild unless code/profile changes' 'progress no redeploy advice'
elif [[ "$runtime_capacity_available" == "true" ]]; then
  require_text "$REFRESH_OUTPUT" 'nextAction: `R0 pass; continue R1 Claude Code provider-switch profile repair and provider smokes`' 'refresh R1 next action'
  require_text "$REFRESH_OUTPUT" 'R0 is passed by live CDS-managed runtime capacity evidence' 'refresh R0 pass command'
  require_text "$PROGRESS_OUTPUT" 'Overall status: blocked_r1' 'progress overall status'
  require_text "$PROGRESS_OUTPUT" 'Current blocking gate: R1' 'progress blocking gate'
  require_text "$PROGRESS_OUTPUT" 'R0 CDS-managed runtime capacity is available' 'progress exact next step'
else
  require_text "$REFRESH_OUTPUT" 'nextAction: `continue R0.7 CDS-managed runtime live apply before any fallback env handoff`' 'refresh next action'
  require_text "$REFRESH_OUTPUT" 'Continue R0.7 CDS-managed runtime live evidence work' 'refresh R0 design next command'
  require_text "$REFRESH_OUTPUT" 'operator/debug fallback details, not the product path' 'refresh fallback scope'
  require_text "$REFRESH_OUTPUT" 'doc/design.cds.agent.managed-runtime-fact-source.md' 'refresh next command design'
  require_text "$PROGRESS_OUTPUT" 'Overall status: blocked_r0' 'progress overall status'
  require_text "$PROGRESS_OUTPUT" 'Current blocking gate: R0' 'progress blocking gate'
  require_text "$PROGRESS_OUTPUT" 'Continue R0.7 CDS-managed runtime live evidence work' 'progress exact next step'
  require_text "$PROGRESS_OUTPUT" 'operator/debug fallback details, not the product path' 'progress fallback scope'
  require_text "$PROGRESS_OUTPUT" 'doc/design.cds.agent.managed-runtime-fact-source.md' 'progress next command design'
fi
require_text "$PROGRESS_OUTPUT" 'R0 managed runtime capacity: status=' 'progress managed runtime capacity'
require_text "$PROGRESS_OUTPUT" 'Operator fallback remote host verdict:' 'progress fallback host label'
require_absent "$PROGRESS_OUTPUT" 'R0 remote host verdict:' 'progress must not promote remote host as R0 product gate'
require_text "$PROGRESS_OUTPUT" '| D1 Runtime architecture correction | done |' 'progress D1 done'
require_text "$PROGRESS_OUTPUT" '| R0.2 CDS-managed runtime fact source | done |' 'progress R0.2 done'
require_text "$PROGRESS_OUTPUT" '| R0.3 CDS-managed official SDK runtime | done_minimal |' 'progress R0.3 done minimal'
require_text "$PROGRESS_OUTPUT" '| R0.4 MAP session transport smoke | done |' 'progress R0.4 done'
if [[ "$runtime_capacity_available" == "true" ]]; then
  require_text "$PROGRESS_OUTPUT" '| R0V Post-check | done |' 'progress R0V done'
else
  require_text "$PROGRESS_OUTPUT" '| R0V Post-check | done_blocked |' 'progress R0V done blocked'
fi
require_text "$PROGRESS_OUTPUT" '| R0.5 CDS-managed runtime capacity contract | done_minimal |' 'progress R0.5 done minimal'
require_text "$PROGRESS_OUTPUT" '| R0.6 CDS-managed runtime capacity reconciler | done_minimal |' 'progress R0.6 done minimal'
if [[ "$runtime_capacity_available" == "true" ]]; then
  require_text "$PROGRESS_OUTPUT" '| R0.7 CDS-managed runtime live apply | done_live |' 'progress R0.7 done live'
  if [[ "$progress_provider_complete" == "true" ]]; then
    require_text "$PROGRESS_OUTPUT" '| R1 Claude Code provider-switch profile | done_live |' 'progress R1 done live'
    require_text "$PROGRESS_OUTPUT" '| S1/S2/S3 One-cycle smokes | done_live |' 'progress S1/S2/S3 done live'
    require_text "$PROGRESS_OUTPUT" '| V1 Visual verification | pass_live |' 'progress V1 pass live'
  else
    require_text "$PROGRESS_OUTPUT" '| R1 Claude Code provider-switch profile | current_blocker |' 'progress R1 current blocker'
  fi
else
  require_text "$PROGRESS_OUTPUT" '| R0.7 CDS-managed runtime live apply | in_progress |' 'progress R0.7 in progress'
fi
require_text "$PROGRESS_OUTPUT" '| R0.2F Operator fallback host path | fallback |' 'progress fallback demotion'

require_text "$STATUS_DOC" 'Claude SDK Agent 是 CDS-managed runtime/container/sandbox' 'status doc managed runtime'
require_text "$STATUS_DOC" '只能作为 CDS operator/debug fallback，不能作为普通用户主路径' 'status doc fallback scope'
if [[ "$progress_provider_complete" == "true" ]]; then
  require_text "$STATUS_DOC" 'provider_smokes_passed' 'status doc provider complete'
  require_text "$STATUS_DOC" 'Phase 4 P4-1/P4-2/P4-3/P4-4/P4-5' 'status doc phase4 complete'
else
  require_text "$STATUS_DOC" 'doc/plan.cds.agent.runtime-correction-limited.md' 'status doc correction plan'
  require_text "$STATUS_DOC" 'doc/design.cds.agent.managed-runtime-fact-source.md' 'status doc R0 design'
fi

printf 'CDS Agent progress consistency: pass\n'
printf -- '- refresh: %s\n' "$REFRESH_OUTPUT"
printf -- '- progress: %s\n' "$PROGRESS_OUTPUT"
printf -- '- statusDoc: %s\n' "$STATUS_DOC"
