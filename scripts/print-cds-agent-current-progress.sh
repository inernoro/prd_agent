#!/usr/bin/env bash
# Print the current CDS Agent goal board from local evidence files.
# This is read-only and never prints secret values.

set -euo pipefail

GOAL_AUDIT="${CDS_AGENT_GOAL_AUDIT_REPORT:-/tmp/cds-agent-goal-audit-r0-current.json}"
REMOTE_HOST_SUMMARY="${CDS_AGENT_REMOTE_HOST_SUMMARY:-/tmp/cds-agent-remote-host-pool-current-readonly-live/summary.json}"
HANDOFF_SUMMARY="${CDS_AGENT_REMOTE_HOST_HANDOFF_SUMMARY:-$REMOTE_HOST_SUMMARY}"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || fail "missing dependency: jq"
[[ -f "$GOAL_AUDIT" ]] || fail "goal audit not found: $GOAL_AUDIT"
[[ -f "$REMOTE_HOST_SUMMARY" ]] || fail "remote host summary not found: $REMOTE_HOST_SUMMARY"

jq_read() {
  local file="$1"
  local expr="$2"
  jq -r "$expr" "$file"
}

status=$(jq_read "$GOAL_AUDIT" '.executionPanel.status // .status // "unknown"')
gate=$(jq_read "$GOAL_AUDIT" '.executionPanel.currentBlockingGate // .currentBlockingGate // "unknown"')
gate_status_expr='def gate_status($name):
  if (.gates[$name] | type) == "object" then .gates[$name].status
  elif (.gates[$name] // null) != null then .gates[$name]
  elif (.[$name] | type) == "object" then .[$name].status
  else .[$name] // "unknown"
  end;'
r0=$(jq_read "$GOAL_AUDIT" "$gate_status_expr gate_status(\"R0\")")
a0=$(jq_read "$GOAL_AUDIT" "$gate_status_expr gate_status(\"A0\")")
v1=$(jq_read "$GOAL_AUDIT" "$gate_status_expr gate_status(\"V1\")")
n6=$(jq_read "$GOAL_AUDIT" "$gate_status_expr gate_status(\"N6\")")

verdict=$(jq_read "$REMOTE_HOST_SUMMARY" '.verdict // .status // "unknown"')
enabled_hosts=$(jq_read "$REMOTE_HOST_SUMMARY" '(if has("prepare") and .prepare != null then .prepare.enabledHostCount else .beforeEnabledRemoteHostCount end) // "unknown"')
shared_running=$(jq_read "$REMOTE_HOST_SUMMARY" '.beforeSharedRunning // "unknown"')
ready_deploy=$(jq_read "$REMOTE_HOST_SUMMARY" '.readyForSharedRuntimeDeploy // false')
ready_smoke=$(jq_read "$REMOTE_HOST_SUMMARY" '.readyForProviderSmokes // false')
will_create_host=$(jq_read "$REMOTE_HOST_SUMMARY" '(if has("prepare") and .prepare != null then .prepare.willCreateHost else true end) // true')
target_host_id=$(jq_read "$REMOTE_HOST_SUMMARY" '(if has("prepare") and .prepare != null then .prepare.targetHostId else null end) // "none"')
missing_config=$(jq_read "$REMOTE_HOST_SUMMARY" '((if has("prepare") and .prepare != null then .prepare.missingConfig else [] end) // []) | join(", ")')
invalid_config=$(jq_read "$REMOTE_HOST_SUMMARY" '((if has("prepare") and .prepare != null then .prepare.invalidConfig else [] end) // []) | join(", ")')
total_seconds=$(jq_read "$REMOTE_HOST_SUMMARY" '.totalSeconds // "unknown"')

if [[ -z "$missing_config" ]]; then
  missing_config="none"
fi
if [[ -z "$invalid_config" ]]; then
  invalid_config="none"
fi

cat <<EOF
# CDS Agent Progress Board

Generated: $(date '+%Y-%m-%d %H:%M:%S %Z')
Branch: $(git branch --show-current 2>/dev/null || printf 'unknown')
Goal: keep MAP/CDS as control plane; shrink custom agent loop into official SDK adapters.

## Current State

- Overall status: $status
- Current blocking gate: $gate
- Gate status: A0=$a0, R0=$r0, V1=$v1, N6=$n6
- R0 remote host verdict: $verdict
- Remote hosts enabled: $enabled_hosts
- Shared official SDK runtime running: $shared_running
- Ready for shared runtime deploy: $ready_deploy
- Ready for provider smokes: $ready_smoke
- Evidence refresh cost: ${total_seconds}s

## Task Board

| Step | State | Next action | ETA after prerequisites |
| --- | --- | --- | --- |
| A0 Official SDK adapter boundary | done | Keep legacy loop as explicit fallback only | done |
| R0.1 Branch-local sidecar cleanup | done | Keep branch services api/admin only | done |
| R0.2 Remote host carrier | blocked | Provide/apply remote host SSH config | 1-3 min |
| R0.3 Shared official SDK runtime | blocked | Deploy shared sidecar image on enabled host | 2-5 min |
| R0V Post-check | waiting | Run shared-service pool smoke after R0.2/R0.3 | 15-30 sec |
| R1 Profile repair | pending | Configure official Anthropic/Claude-compatible profile after R0 | 5-15 min |
| S1/S2/S3 One-cycle smokes | pending | Run read-only/approval/cancel cycles after R0/R1 | 10-25 min |
| V1 Visual verification | partial | Use runtime-status/execution panel screenshot after live runtime exists | 3-8 min |

## Current Blockers

- missingConfig: $missing_config
- invalidConfig: $invalid_config
- targetHostId: $target_host_id
- willCreateHost: $will_create_host

## Exact Next Step

Generate the safe handoff command:

\`\`\`bash
scripts/print-cds-agent-remote-host-handoff.sh \\
  $HANDOFF_SUMMARY
\`\`\`

Then fill only placeholders locally. Do not paste private key contents into chat or logs.

## Do Not Spend Time On Now

- Do not repeat normal preview redeploys for this blocker.
- Do not run provider one-cycle before REMOTE_HOST_AVAILABLE and SHARED_POOL_RUNNING pass.
- Do not add claude-agent-sdk-runtime-v2 back into prd-agent branch services.
- Do not treat UI preview running as proof that shared-service runtime pool recovered.

## Evidence Files

- goal audit: $GOAL_AUDIT
- remote host summary: $REMOTE_HOST_SUMMARY
- handoff summary: $HANDOFF_SUMMARY
EOF
