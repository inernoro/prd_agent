#!/usr/bin/env bash
# ============================================
# CDS Agent commercial readiness audit
# ============================================
#
# This script does not call the model provider. It audits the evidence needed
# before calling S1/S2/S3 provider smokes:
#   R0: MAP/CDS runtime pool can route to claude-agent-sdk.
#   R1: default runtime profile is compatible and has an API key.
#   T1: official profile template and adapter compatibility APIs are present.
#   V1: optional workbench page is reachable.
#
# Set SMOKE_CDS_AGENT_REQUIRE_COMMERCIAL=1 to fail when R1 is not ready.
# Set SMOKE_CDS_AGENT_WORKBENCH_URL to check a specific page URL.
# ============================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=smoke-lib.sh
source "$SCRIPT_DIR/smoke-lib.sh"

SMOKE_STEP_TOTAL=6
SMOKE_CDS_AGENT_REQUIRE_COMMERCIAL="${SMOKE_CDS_AGENT_REQUIRE_COMMERCIAL:-}"
SMOKE_CDS_AGENT_WORKBENCH_URL="${SMOKE_CDS_AGENT_WORKBENCH_URL:-}"

audit_pending=()

mark_pending() {
  audit_pending+=("$1")
  printf 'PENDING: %s\n' "$1"
}

smoke_init "CDS Agent Commercial Readiness"

smoke_step "R0 runtime pool official SDK loop ownership"
runtime_resp=$(smoke_get "/api/infra-agent-sessions/runtime-status?refreshDiscovery=true")
smoke_verbose "$runtime_resp"
smoke_assert_eq "$(printf '%s' "$runtime_resp" | jq -r '.success')" "true" "RuntimeStatus.success"
desired_adapter=$(smoke_get_data "$runtime_resp" '.diagnostics.desiredRuntimeAdapter // ""')
runtime_transport=$(smoke_get_data "$runtime_resp" '.diagnostics.runtimeTransport // ""')
instance_count=$(smoke_get_data "$runtime_resp" '.diagnostics.instanceCount // 0')
healthy_count=$(smoke_get_data "$runtime_resp" '.diagnostics.healthyCount // 0')
official_instances=$(smoke_get_data "$runtime_resp" '[.diagnostics.instances[]? | select((.agentAdapter // "") == "claude-agent-sdk" or (.loopOwner // "") == "claude-agent-sdk")] | length')
smoke_assert_eq "$desired_adapter" "claude-agent-sdk" "diagnostics.desiredRuntimeAdapter"
smoke_assert_eq "$runtime_transport" "sidecar-runtime-adapter" "diagnostics.runtimeTransport"
if (( instance_count <= 0 || healthy_count <= 0 || official_instances <= 0 )); then
  blockers=$(smoke_get_data "$runtime_resp" '.diagnostics.blockers // [] | join(" | ")')
  next_actions=$(smoke_get_data "$runtime_resp" '.diagnostics.nextActions // [] | join(" | ")')
  smoke_fail "R0 not ready: instanceCount=${instance_count} healthyCount=${healthy_count} officialInstances=${official_instances}; blockers=${blockers}; next=${next_actions}"
fi
smoke_ok "R0 ready: pool=${healthy_count}/${instance_count} officialInstances=${official_instances}"

smoke_step "R1 default runtime profile compatibility"
default_profile=$(printf '%s' "$runtime_resp" | jq -c '.data.diagnostics.defaultRuntimeProfile // empty')
smoke_assert_nonempty "$default_profile" "diagnostics.defaultRuntimeProfile"
profile_name=$(printf '%s' "$default_profile" | jq -r '.name // "unknown"')
profile_protocol=$(printf '%s' "$default_profile" | jq -r '.protocol // "unknown"')
profile_model=$(printf '%s' "$default_profile" | jq -r '.model // "unknown"')
profile_has_key=$(printf '%s' "$default_profile" | jq -r '.hasApiKey // false')
profile_compatible=$(printf '%s' "$default_profile" | jq -r 'if has("compatibleWithDesiredRuntimeAdapter") then .compatibleWithDesiredRuntimeAdapter else true end')
printf 'Default profile: name=%s protocol=%s model=%s hasApiKey=%s compatible=%s\n' \
  "$profile_name" "$profile_protocol" "$profile_model" "$profile_has_key" "$profile_compatible"
if [[ "$profile_compatible" != "true" || "$profile_has_key" != "true" ]]; then
  mark_pending "R1: create a default Anthropic/Claude-compatible runtime profile with API key"
  if [[ -n "$SMOKE_CDS_AGENT_REQUIRE_COMMERCIAL" ]]; then
    smoke_fail "R1 not ready and SMOKE_CDS_AGENT_REQUIRE_COMMERCIAL is set"
  fi
else
  smoke_ok "R1 ready: default profile can be used by claude-agent-sdk"
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
smoke_ok "T1 ready: template and compatibility matrix are backend-owned"

smoke_step "S1/S2/S3 provider-run gate status"
if [[ "$profile_compatible" == "true" && "$profile_has_key" == "true" ]]; then
  printf 'Next commands:\n'
  printf '  SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 SMOKE_CDS_AGENT_REQUIRE_COMPATIBLE=1 bash scripts/smoke-cds-agent-official-sdk-run.sh\n'
  printf '  SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 SMOKE_CDS_AGENT_REQUIRE_COMPATIBLE=1 bash scripts/smoke-cds-agent-official-sdk-controls.sh\n'
  smoke_ok "S1/S2/S3 provider smokes are unblocked"
else
  mark_pending "S1/S2/S3: blocked until R1 profile is compatible and keyed"
fi

smoke_step "V1 workbench page reachability"
if [[ -z "$SMOKE_CDS_AGENT_WORKBENCH_URL" ]]; then
  if [[ "$SMOKE_HOST" == http://localhost:5000 || "$SMOKE_HOST" == http://127.0.0.1:5000 ]]; then
    mark_pending "V1: set SMOKE_CDS_AGENT_WORKBENCH_URL to verify the UI page"
  else
    SMOKE_CDS_AGENT_WORKBENCH_URL="${SMOKE_HOST%/}/cds-agent"
  fi
fi
if [[ -n "$SMOKE_CDS_AGENT_WORKBENCH_URL" ]]; then
  page_code=$(curl --max-time "$SMOKE_TIMEOUT" --show-error --silent --output /dev/null --write-out '%{http_code}' -I "$SMOKE_CDS_AGENT_WORKBENCH_URL" || true)
  if [[ "$page_code" != "200" ]]; then
    mark_pending "V1: workbench page did not return HTTP 200 (${page_code}) at ${SMOKE_CDS_AGENT_WORKBENCH_URL}"
  else
    smoke_ok "V1 reachable: ${SMOKE_CDS_AGENT_WORKBENCH_URL}"
  fi
fi

smoke_step "Commercial readiness summary"
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
