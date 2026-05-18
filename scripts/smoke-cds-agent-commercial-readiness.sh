#!/usr/bin/env bash
# ============================================
# CDS Agent commercial readiness audit
# ============================================
#
# This script does not call the model provider. It audits the evidence needed
# before calling S1/S2/S3 provider smokes:
#   R0: MAP/CDS runtime pool can route to claude-agent-sdk.
#   A0: default path remains a thin official SDK adapter, with legacy loop only as explicit fallback.
#   R1: default runtime profile is compatible and has a CDS-managed provider secret.
#   T1: official profile template and adapter compatibility APIs are present,
#       and other official SDK candidates are not silently routable.
#   V1: optional workbench page is reachable.
#
# Set SMOKE_CDS_AGENT_REQUIRE_COMMERCIAL=1 to fail when R1 is not ready.
# Set SMOKE_CDS_AGENT_WORKBENCH_URL to check a specific page URL.
# Set SMOKE_CDS_AGENT_READINESS_REPORT=/path/report.json to write a machine-readable report.
# ============================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=smoke-lib.sh
source "$SCRIPT_DIR/smoke-lib.sh"

SMOKE_STEP_TOTAL=7
SMOKE_CDS_AGENT_REQUIRE_COMMERCIAL="${SMOKE_CDS_AGENT_REQUIRE_COMMERCIAL:-}"
SMOKE_CDS_AGENT_WORKBENCH_URL="${SMOKE_CDS_AGENT_WORKBENCH_URL:-}"
SMOKE_CDS_AGENT_READINESS_REPORT="${SMOKE_CDS_AGENT_READINESS_REPORT:-}"
SMOKE_CDS_AGENT_RUNTIME_STATUS_RETRIES="${SMOKE_CDS_AGENT_RUNTIME_STATUS_RETRIES:-3}"
SMOKE_CDS_AGENT_RUNTIME_STATUS_RETRY_SECONDS="${SMOKE_CDS_AGENT_RUNTIME_STATUS_RETRY_SECONDS:-3}"

audit_pending=()
require_commercial_failed=""
gate_r0_status="unknown"
gate_a0_status="unknown"
gate_r1_status="unknown"
gate_t1_status="unknown"
gate_candidate_status="unknown"
gate_provider_status="unknown"
gate_v1_status="unknown"
page_code="not_checked"
execution_panel="null"
next_cycle_plan="null"
profile_reason_code=""
profile_reason=""
commercial_reason_code=""

mark_pending() {
  audit_pending+=("$1")
  printf 'PENDING: %s\n' "$1"
}

write_report() {
  [[ -z "$SMOKE_CDS_AGENT_READINESS_REPORT" ]] && return

  local pending_json overall elapsed
  if (( ${#audit_pending[@]} == 0 )); then
    pending_json='[]'
    overall='ready_for_provider_smokes'
  else
    pending_json=$(printf '%s\n' "${audit_pending[@]}" | jq -R . | jq -s .)
    overall='pending'
  fi
  elapsed=$(( $(date +%s) - SMOKE_STARTED_AT ))

  jq -n \
    --arg overall "$overall" \
    --arg host "$SMOKE_HOST" \
    --arg user "$SMOKE_USER" \
    --arg desiredAdapter "${desired_adapter:-unknown}" \
    --arg runtimeTransport "${runtime_transport:-unknown}" \
    --arg profileName "${profile_name:-unknown}" \
    --arg profileProtocol "${profile_protocol:-unknown}" \
    --arg profileModel "${profile_model:-unknown}" \
    --arg profileReasonCode "${profile_reason_code:-}" \
    --arg profileReason "${profile_reason:-}" \
    --arg commercialReasonCode "${commercial_reason_code:-}" \
    --arg workbenchUrl "${SMOKE_CDS_AGENT_WORKBENCH_URL:-}" \
    --arg pageCode "$page_code" \
    --arg gateR0 "$gate_r0_status" \
    --arg gateA0 "$gate_a0_status" \
    --arg gateR1 "$gate_r1_status" \
    --arg gateT1 "$gate_t1_status" \
    --arg gateCandidates "$gate_candidate_status" \
    --arg gateProvider "$gate_provider_status" \
    --arg gateV1 "$gate_v1_status" \
    --argjson instanceCount "${instance_count:-0}" \
    --argjson healthyCount "${healthy_count:-0}" \
    --argjson officialInstances "${official_instances:-0}" \
    --argjson profileHasKey "${profile_has_key:-false}" \
    --argjson profileCompatible "${profile_compatible:-false}" \
    --argjson executionPanel "${execution_panel:-null}" \
    --argjson nextCyclePlan "${next_cycle_plan:-null}" \
    --argjson pending "$pending_json" \
    --argjson elapsedSeconds "$elapsed" \
    '{
      overall: $overall,
      host: $host,
      user: $user,
      elapsedSeconds: $elapsedSeconds,
      runtime: {
        desiredAdapter: $desiredAdapter,
        transport: $runtimeTransport,
        instanceCount: $instanceCount,
        healthyCount: $healthyCount,
        officialInstances: $officialInstances
      },
      defaultProfile: {
        name: $profileName,
        protocol: $profileProtocol,
        model: $profileModel,
        hasApiKey: $profileHasKey,
        compatibleWithDesiredRuntimeAdapter: $profileCompatible,
        compatibilityReasonCode: $profileReasonCode,
        compatibilityReason: $profileReason
      },
      providerReadiness: {
        reasonCode: $commercialReasonCode
      },
      workbench: {
        url: $workbenchUrl,
        httpStatus: $pageCode
      },
      gates: {
        R0: $gateR0,
        A0: $gateA0,
        R1: $gateR1,
        T1: $gateT1,
        candidates: $gateCandidates,
        S1S2S3: $gateProvider,
        V1: $gateV1
      },
      executionPanel: $executionPanel,
      nextCyclePlan: $nextCyclePlan,
      pending: $pending
    }' > "$SMOKE_CDS_AGENT_READINESS_REPORT"
  printf 'Readiness report: %s\n' "$SMOKE_CDS_AGENT_READINESS_REPORT"
}

smoke_init "CDS Agent Commercial Readiness"

smoke_step "R0 runtime pool official SDK loop ownership"
runtime_resp=""
for attempt in $(seq 1 "$SMOKE_CDS_AGENT_RUNTIME_STATUS_RETRIES"); do
  runtime_resp=$(smoke_get "/api/infra-agent-sessions/runtime-status?refreshDiscovery=true")
  healthy_count_probe=$(smoke_get_data "$runtime_resp" '.diagnostics.healthyCount // 0')
  official_instances_probe=$(smoke_get_data "$runtime_resp" '
    [.diagnostics.instances[]?
      | select(
          (.agentAdapter // "") == "claude-agent-sdk"
          or (.loopOwner // "") == "claude-agent-sdk"
          or (.source // "") == "cds-pairing"
          or ((.name // "") | test("shared-sidecar-pool|cds-pairing"; "i"))
        )
    ] | length
  ')
  if (( healthy_count_probe > 0 && official_instances_probe > 0 )); then
    break
  fi
  if (( attempt < SMOKE_CDS_AGENT_RUNTIME_STATUS_RETRIES )); then
    printf 'runtime-status not ready yet (attempt %s/%s, healthy=%s official=%s), retrying in %ss...\n' \
      "$attempt" "$SMOKE_CDS_AGENT_RUNTIME_STATUS_RETRIES" "$healthy_count_probe" "$official_instances_probe" "$SMOKE_CDS_AGENT_RUNTIME_STATUS_RETRY_SECONDS"
    sleep "$SMOKE_CDS_AGENT_RUNTIME_STATUS_RETRY_SECONDS"
  fi
done
smoke_verbose "$runtime_resp"
smoke_assert_eq "$(printf '%s' "$runtime_resp" | jq -r '.success')" "true" "RuntimeStatus.success"
desired_adapter=$(smoke_get_data "$runtime_resp" '.diagnostics.desiredRuntimeAdapter // ""')
runtime_transport=$(smoke_get_data "$runtime_resp" '.diagnostics.runtimeTransport // ""')
instance_count=$(smoke_get_data "$runtime_resp" '.diagnostics.instanceCount // 0')
healthy_count=$(smoke_get_data "$runtime_resp" '.diagnostics.healthyCount // 0')
official_instances=$(smoke_get_data "$runtime_resp" '
  [.diagnostics.instances[]?
    | select(
        (.agentAdapter // "") == "claude-agent-sdk"
        or (.loopOwner // "") == "claude-agent-sdk"
        or (.source // "") == "cds-pairing"
        or ((.name // "") | test("shared-sidecar-pool|cds-pairing"; "i"))
      )
  ] | length
')
smoke_assert_eq "$desired_adapter" "claude-agent-sdk" "diagnostics.desiredRuntimeAdapter"
smoke_assert_eq "$runtime_transport" "sidecar-runtime-adapter" "diagnostics.runtimeTransport"
if (( instance_count <= 0 || healthy_count <= 0 || official_instances <= 0 )); then
  blockers=$(smoke_get_data "$runtime_resp" '.diagnostics.blockers // [] | join(" | ")')
  next_actions=$(smoke_get_data "$runtime_resp" '.diagnostics.nextActions // [] | join(" | ")')
  if (( instance_count > 0 && official_instances > 0 )) && printf '%s' "$blockers" | grep -Eiq 'ANTHROPIC_API_KEY|anthropicKey'; then
    gate_r0_status="pass"
    smoke_ok "R0 capacity/ownership present; /readyz is blocked by R1 provider-switch profile, not R0 runtime capacity"
  else
    smoke_fail "R0 not ready: instanceCount=${instance_count} healthyCount=${healthy_count} officialInstances=${official_instances}; blockers=${blockers}; next=${next_actions}"
  fi
else
  gate_r0_status="pass"
  smoke_ok "R0 ready: pool=${healthy_count}/${instance_count} officialInstances=${official_instances}"
fi

smoke_step "A0 official SDK adapter boundary"
commercial_readiness=$(printf '%s' "$runtime_resp" | jq -c '.data.diagnostics.commercialReadiness // empty')
smoke_assert_nonempty "$commercial_readiness" "diagnostics.commercialReadiness"
a0_gate=$(printf '%s' "$commercial_readiness" | jq -c '.gates[]? | select(.code == "A0")')
smoke_assert_nonempty "$a0_gate" "commercialReadiness.A0"
smoke_assert_eq "$(printf '%s' "$a0_gate" | jq -r '.status')" "pass" "commercialReadiness.A0.status"
smoke_assert_contains "$(printf '%s' "$a0_gate" | jq -r '.message')" "claude-agent-sdk" "commercialReadiness.A0.message"
execution_panel=$(printf '%s' "$runtime_resp" | jq -c '.data.diagnostics.executionPanel // empty')
smoke_assert_nonempty "$execution_panel" "diagnostics.executionPanel"
smoke_assert_eq "$(printf '%s' "$execution_panel" | jq -r '.gateCounts.pass >= 1')" "true" "executionPanel.gateCounts.pass"
gate_a0_status="pass"
smoke_ok "A0 ready: official SDK adapter boundary is backend-visible"

smoke_step "R1 default runtime profile compatibility"
r1_gate=$(printf '%s' "$commercial_readiness" | jq -c '.gates[]? | select(.code == "R1")')
s1_gate=$(printf '%s' "$commercial_readiness" | jq -c '.gates[]? | select(.code == "S1")')
s2_gate=$(printf '%s' "$commercial_readiness" | jq -c '.gates[]? | select(.code == "S2")')
s3_gate=$(printf '%s' "$commercial_readiness" | jq -c '.gates[]? | select(.code == "S3")')
smoke_assert_nonempty "$r1_gate" "commercialReadiness.R1"
smoke_assert_nonempty "$s1_gate" "commercialReadiness.S1"
smoke_assert_nonempty "$s2_gate" "commercialReadiness.S2"
smoke_assert_nonempty "$s3_gate" "commercialReadiness.S3"
default_profile=$(printf '%s' "$runtime_resp" | jq -c '.data.diagnostics.defaultRuntimeProfile // empty')
smoke_assert_nonempty "$default_profile" "diagnostics.defaultRuntimeProfile"
repair_plan=$(printf '%s' "$runtime_resp" | jq -c '.data.diagnostics.runtimeProfileRepairPlan // empty')
smoke_assert_nonempty "$repair_plan" "diagnostics.runtimeProfileRepairPlan"
smoke_assert_eq "$(printf '%s' "$repair_plan" | jq -r '.gate')" "R1" "runtimeProfileRepairPlan.gate"
smoke_assert_eq "$(printf '%s' "$repair_plan" | jq -r '.targetTemplateId')" "anthropic-official-claude-sonnet-4" "runtimeProfileRepairPlan.targetTemplateId"
smoke_assert_eq "$(printf '%s' "$repair_plan" | jq -r '.targetProtocol')" "anthropic" "runtimeProfileRepairPlan.targetProtocol"
next_cycle_plan=$(printf '%s' "$runtime_resp" | jq -c '.data.diagnostics.nextCyclePlan // empty')
smoke_assert_nonempty "$next_cycle_plan" "diagnostics.nextCyclePlan"
smoke_assert_eq "$(printf '%s' "$next_cycle_plan" | jq -r '.cycle')" "official-sdk-provider-closure" "nextCyclePlan.cycle"
smoke_assert_eq "$(printf '%s' "$next_cycle_plan" | jq -r '[.items[]? | select(.code == "N1")] | length')" "1" "nextCyclePlan.N1"
smoke_assert_eq "$(printf '%s' "$next_cycle_plan" | jq -r '[.items[]? | select(.code == "N6")] | length')" "1" "nextCyclePlan.N6"
n6_evidence=$(printf '%s' "$next_cycle_plan" | jq -r '.items[]? | select(.code == "N6") | .evidence')
smoke_assert_contains "$n6_evidence" "源码扫描" "nextCyclePlan.N6.evidence"
smoke_assert_contains "$n6_evidence" "构造函数反射" "nextCyclePlan.N6.evidence"
smoke_assert_contains "$n6_evidence" "最小业务路径" "nextCyclePlan.N6.evidence"
smoke_assert_contains "$n6_evidence" "planned-not-routable" "nextCyclePlan.N6.evidence"
smoke_assert_contains "$(printf '%s' "$next_cycle_plan" | jq -r '.stopConditions[]?')" "N1-N5" "nextCyclePlan.stopConditions"
smoke_assert_eq "$(printf '%s' "$execution_panel" | jq -r '.commercialComplete')" "false" "executionPanel.commercialComplete"
smoke_assert_eq "$(printf '%s' "$execution_panel" | jq -r '.stepTotal')" "6" "executionPanel.stepTotal"
smoke_assert_eq "$(printf '%s' "$execution_panel" | jq -r '.currentStep.code // ""')" "N1" "executionPanel.currentStep.code"
smoke_assert_eq "$(printf '%s' "$execution_panel" | jq -r '[.timeline[]? | select(.code == "N6")] | length')" "1" "executionPanel.timeline.N6"
profile_name=$(printf '%s' "$default_profile" | jq -r '.name // "unknown"')
profile_protocol=$(printf '%s' "$default_profile" | jq -r '.protocol // "unknown"')
profile_model=$(printf '%s' "$default_profile" | jq -r '.model // "unknown"')
profile_has_key=$(printf '%s' "$default_profile" | jq -r '.hasApiKey // false')
profile_compatible=$(printf '%s' "$default_profile" | jq -r 'if has("compatibleWithDesiredRuntimeAdapter") then .compatibleWithDesiredRuntimeAdapter else true end')
profile_reason_code=$(printf '%s' "$default_profile" | jq -r '.compatibilityReasonCode // ""')
profile_reason=$(printf '%s' "$default_profile" | jq -r '.compatibilityReason // ""')
commercial_reason_code=$(printf '%s' "$r1_gate" | jq -r '.reasonCode // ""')
printf 'Default profile: name=%s protocol=%s model=%s hasApiKey=%s compatible=%s reason=%s\n' \
  "$profile_name" "$profile_protocol" "$profile_model" "$profile_has_key" "$profile_compatible" "${profile_reason_code:-none}"
if [[ "$profile_compatible" != "true" || "$profile_has_key" != "true" ]]; then
  gate_r1_status="pending"
  smoke_assert_eq "$(printf '%s' "$r1_gate" | jq -r '.status')" "pending" "commercialReadiness.R1.status"
  if [[ "$profile_compatible" != "true" ]]; then
    smoke_assert_nonempty "$profile_reason_code" "defaultProfile.compatibilityReasonCode"
    smoke_assert_nonempty "$profile_reason" "defaultProfile.compatibilityReason"
    smoke_assert_contains "$profile_reason" "claude-agent-sdk" "defaultProfile.compatibilityReason"
    smoke_assert_eq "$commercial_reason_code" "$profile_reason_code" "commercialReadiness.R1.reasonCode"
    smoke_assert_eq "$(printf '%s' "$s1_gate" | jq -r '.reasonCode // ""')" "$profile_reason_code" "commercialReadiness.S1.reasonCode"
    smoke_assert_eq "$(printf '%s' "$s2_gate" | jq -r '.reasonCode // ""')" "$profile_reason_code" "commercialReadiness.S2.reasonCode"
    smoke_assert_eq "$(printf '%s' "$s3_gate" | jq -r '.reasonCode // ""')" "$profile_reason_code" "commercialReadiness.S3.reasonCode"
    smoke_assert_contains "$(printf '%s' "$s1_gate" | jq -r '.message')" "$profile_reason" "commercialReadiness.S1.message"
  fi
  smoke_assert_eq "$(printf '%s' "$repair_plan" | jq -r '.state')" "blocked" "runtimeProfileRepairPlan.state"
  smoke_assert_eq "$(printf '%s' "$next_cycle_plan" | jq -r '.state')" "profile-blocked" "nextCyclePlan.state"
  smoke_assert_eq "$(printf '%s' "$next_cycle_plan" | jq -r '.items[]? | select(.code == "N2") | .blockedBy')" "R1" "nextCyclePlan.N2.blockedBy"
  repair_actions=$(printf '%s' "$repair_plan" | jq -r '.nextActions[]?')
  smoke_assert_contains "$repair_actions" "claude-sdk runtime + anthropic protocol" "runtimeProfileRepairPlan.nextActions"
  mark_pending "R1: ${profile_reason_code:-profile-not-ready} · ${profile_reason:-create a default Claude Code provider-switch runtime profile with provider secret}"
  smoke_assert_eq "$(printf '%s' "$execution_panel" | jq -r '.currentBlockingGate')" "R1" "executionPanel.currentBlockingGate"
  smoke_assert_contains "$(printf '%s' "$execution_panel" | jq -r '.nextCommand')" "smoke-cds-agent-r1-profile-repair.sh" "executionPanel.nextCommand"
  if [[ -n "$SMOKE_CDS_AGENT_REQUIRE_COMMERCIAL" ]]; then
    require_commercial_failed="R1 not ready and SMOKE_CDS_AGENT_REQUIRE_COMMERCIAL is set"
  fi
else
  gate_r1_status="pass"
  smoke_assert_eq "$(printf '%s' "$r1_gate" | jq -r '.status')" "pass" "commercialReadiness.R1.status"
  smoke_ok "R1 ready: default profile can be used by claude-agent-sdk"
fi

if [[ -n "$require_commercial_failed" ]]; then
  write_report
  smoke_fail "$require_commercial_failed"
fi

smoke_step "T1 official template and adapter compatibility APIs"
templates_resp=$(smoke_get /api/infra-agent-runtime-profiles/templates)
smoke_assert_eq "$(printf '%s' "$templates_resp" | jq -r '.success')" "true" "RuntimeProfileTemplates.success"
template=$(printf '%s' "$templates_resp" | jq -c '.data.items[]? | select(.id == "anthropic-official-claude-sonnet-4")')
smoke_assert_nonempty "$template" "anthropic official template"
smoke_assert_eq "$(printf '%s' "$template" | jq -r '.protocol')" "anthropic" "template.protocol"
template_adapter_count=$(printf '%s' "$template" | jq -r '[.compatibleRuntimeAdapters[]? | select(. == "claude-agent-sdk")] | length')
smoke_assert_eq "$template_adapter_count" "1" "template.compatibleRuntimeAdapters"
compat_resp=$(smoke_get /api/infra-agent-runtime-profiles/adapter-compatibility)
smoke_assert_eq "$(printf '%s' "$compat_resp" | jq -r '.success')" "true" "AdapterCompatibility.success"
official_adapter=$(printf '%s' "$compat_resp" | jq -c '.data.items[]? | select(.id == "claude-agent-sdk")')
smoke_assert_nonempty "$official_adapter" "claude-agent-sdk compatibility"
smoke_assert_eq "$(printf '%s' "$official_adapter" | jq -r '.loopOwner')" "claude-agent-sdk" "official.loopOwner"
smoke_assert_eq "$(printf '%s' "$official_adapter" | jq -r '.mapRole')" "control-plane-only" "official.mapRole"
codex_adapter=$(printf '%s' "$compat_resp" | jq -c '.data.items[]? | select(.id == "codex")')
smoke_assert_nonempty "$codex_adapter" "codex compatibility"
smoke_assert_eq "$(printf '%s' "$codex_adapter" | jq -r '.status')" "planned-not-routable" "codex.status"
openai_agents_adapter=$(printf '%s' "$compat_resp" | jq -c '.data.items[]? | select(.id == "openai-agents-sdk")')
smoke_assert_nonempty "$openai_agents_adapter" "openai-agents-sdk compatibility"
smoke_assert_eq "$(printf '%s' "$openai_agents_adapter" | jq -r '.status')" "planned-not-routable" "openai-agents-sdk.status"
openai_agents_next=$(printf '%s' "$openai_agents_adapter" | jq -r '.nextActions[]?')
smoke_assert_contains "$openai_agents_next" "S1/S2/S3" "openai-agents-sdk.nextActions"
google_adk_adapter=$(printf '%s' "$compat_resp" | jq -c '.data.items[]? | select(.id == "google-adk")')
smoke_assert_nonempty "$google_adk_adapter" "google-adk compatibility"
smoke_assert_eq "$(printf '%s' "$google_adk_adapter" | jq -r '.status')" "planned-not-routable" "google-adk.status"
google_adk_next=$(printf '%s' "$google_adk_adapter" | jq -r '.nextActions[]?')
smoke_assert_contains "$google_adk_next" "不要把代码审查任务默认路由到 google-adk" "google-adk.nextActions"
gate_t1_status="pass"
gate_candidate_status="pass"
smoke_ok "T1 ready: template and compatibility matrix are backend-owned; other SDK candidates are planned-not-routable"

smoke_step "S1/S2/S3 provider-run gate status"
if [[ "$profile_compatible" == "true" && "$profile_has_key" == "true" ]]; then
  printf 'Next commands:\n'
  printf '  SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 SMOKE_CDS_AGENT_REQUIRE_COMPATIBLE=1 bash scripts/smoke-cds-agent-official-sdk-run.sh\n'
  printf '  SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 SMOKE_CDS_AGENT_REQUIRE_COMPATIBLE=1 bash scripts/smoke-cds-agent-official-sdk-controls.sh\n'
  gate_provider_status="unblocked"
  smoke_ok "S1/S2/S3 provider smokes are unblocked"
else
  gate_provider_status="pending"
  mark_pending "S1/S2/S3: ${profile_reason_code:-blocked-until-r1} · blocked until R1 Claude Code provider-switch profile is compatible and has a CDS-managed provider secret"
fi

smoke_step "V1 workbench page reachability"
if [[ -z "$SMOKE_CDS_AGENT_WORKBENCH_URL" ]]; then
  if [[ "$SMOKE_HOST" == http://localhost:5000 || "$SMOKE_HOST" == http://127.0.0.1:5000 ]]; then
    gate_v1_status="pending"
    mark_pending "V1: set SMOKE_CDS_AGENT_WORKBENCH_URL to verify the UI page"
  else
    SMOKE_CDS_AGENT_WORKBENCH_URL="${SMOKE_HOST%/}/cds-agent"
  fi
fi
if [[ -n "$SMOKE_CDS_AGENT_WORKBENCH_URL" ]]; then
  page_code=$(curl --max-time "$SMOKE_TIMEOUT" --show-error --silent --output /dev/null --write-out '%{http_code}' -I "$SMOKE_CDS_AGENT_WORKBENCH_URL" || true)
  if [[ "$page_code" != "200" ]]; then
    gate_v1_status="pending"
    mark_pending "V1: workbench page did not return HTTP 200 (${page_code}) at ${SMOKE_CDS_AGENT_WORKBENCH_URL}"
  else
    gate_v1_status="pass"
    smoke_ok "V1 reachable: ${SMOKE_CDS_AGENT_WORKBENCH_URL}"
  fi
fi

smoke_step "Commercial readiness summary"
write_report
if (( ${#audit_pending[@]} == 0 )); then
  smoke_ok "All non-provider readiness gates are green; run S1/S2/S3 provider smokes next"
  smoke_done
else
  printf 'Pending gates:\n'
  for item in "${audit_pending[@]}"; do
    printf '  - %s\n' "$item"
  done
  printf 'Current state: not commercially complete until pending gates and S1/S2/S3 provider smokes pass.\n'
  elapsed=$(( $(date +%s) - SMOKE_STARTED_AT ))
  printf '\n==========================================\n'
  printf '⚠️  %s 审计完成，但尚未商业级就绪 (%s 步, 耗时 %ss)\n' "$SMOKE_AGENT_NAME" "$SMOKE_STEP_COUNT" "$elapsed"
  printf '==========================================\n'
fi
