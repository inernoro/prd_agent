#!/usr/bin/env bash
# ============================================
# CDS Agent goal completion audit
# ============================================
#
# Local-first audit for the active CDS Agent objective:
#   - keep MAP/CDS as the control plane
#   - keep the custom loop compressed into official SDK adapters
#   - prefer official SDKs where routable, keep candidates planned-not-routable
#   - preserve one-cycle observability and avoid unnecessary deploy/build loops
#
# This script does not deploy and does not call the model provider. It runs the
# local A0 and N6 guardrails, then emits a machine-readable completion report.
# Commercial completion remains false until R1 and provider-backed S1/S2/S3
# evidence exists.
#
# Optional:
#   CDS_AGENT_GOAL_AUDIT_REPORT=/tmp/cds-agent-goal-audit.json
#   CDS_AGENT_GOAL_CYCLE_SUMMARY=/tmp/cds-agent-cycle-.../cycle-summary.json
# ============================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPORT="${CDS_AGENT_GOAL_AUDIT_REPORT:-}"
AUDIT_DIR="${CDS_AGENT_GOAL_AUDIT_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/cds-agent-goal-audit.XXXXXX")}"
BOUNDARY_REPORT="$AUDIT_DIR/a0-boundary.json"
N6_LOG="$AUDIT_DIR/n6-non-code-compatibility.log"
cycle_summary="${CDS_AGENT_GOAL_CYCLE_SUMMARY:-}"

failures=()
timing_names=()
timing_statuses=()
timing_seconds=()

run_step() {
  local label="$1"
  shift
  local started ended duration
  started=$(date +%s)
  printf '>>> %s\n' "$label"
  if "$@"; then
    ended=$(date +%s)
    duration=$((ended - started))
    printf 'PASS %s (%ss)\n' "$label" "$duration"
    timing_names+=("$label")
    timing_statuses+=("pass")
    timing_seconds+=("$duration")
    return 0
  fi
  ended=$(date +%s)
  duration=$((ended - started))
  printf 'FAIL %s (%ss)\n' "$label" "$duration" >&2
  timing_names+=("$label")
  timing_statuses+=("failed")
  timing_seconds+=("$duration")
  failures+=("$label")
  return 1
}

find_latest_cycle_summary() {
  local latest search_roots
  search_roots=$(printf '%s\n/tmp\n' "${TMPDIR:-/tmp}" | awk '!seen[$0]++')
  latest=$(while IFS= read -r root; do
    [[ -d "$root" ]] || continue
    find "$root" -maxdepth 2 -path '*/cds-agent-cycle-*/cycle-summary.json' -type f -print 2>/dev/null || true
  done <<< "$search_roots" | sort | tail -n 1 || true)
  [[ -n "$latest" ]] && printf '%s' "$latest"
  return 0
}

json_bool() {
  if [[ "$1" == "true" ]]; then
    printf 'true'
  else
    printf 'false'
  fi
}

cd "$ROOT_DIR"
mkdir -p "$AUDIT_DIR"

run_step "A0 official SDK adapter boundary" env SMOKE_CDS_AGENT_BOUNDARY_REPORT="$BOUNDARY_REPORT" bash "$SCRIPT_DIR/smoke-cds-agent-official-sdk-boundary.sh" || true
run_step "N6 non-code and candidate SDK compatibility" bash "$SCRIPT_DIR/smoke-cds-agent-non-code-compatibility.sh" >"$N6_LOG" 2>&1 || true

if [[ -z "$cycle_summary" ]]; then
  cycle_summary=$(find_latest_cycle_summary)
fi

boundary_status="missing"
adapter_lines=0
adapter_max=0
support_lines=0
support_max=0
bridge_total_lines=0
bridge_total_max=0
legacy_lines=0
if [[ -f "$BOUNDARY_REPORT" ]]; then
  boundary_status=$(jq -r '.status // "unknown"' "$BOUNDARY_REPORT")
  adapter_lines=$(jq -r '.officialLoopOwnerEvidence.officialAdapterLines // 0' "$BOUNDARY_REPORT")
  adapter_max=$(jq -r '.officialLoopOwnerEvidence.officialAdapterMaxLines // 0' "$BOUNDARY_REPORT")
  support_lines=$(jq -r '.officialLoopOwnerEvidence.bridgeSupportLines // 0' "$BOUNDARY_REPORT")
  support_max=$(jq -r '.officialLoopOwnerEvidence.bridgeSupportMaxLines // 0' "$BOUNDARY_REPORT")
  bridge_total_lines=$(jq -r '.officialLoopOwnerEvidence.bridgeTotalLines // 0' "$BOUNDARY_REPORT")
  bridge_total_max=$(jq -r '.officialLoopOwnerEvidence.bridgeTotalMaxLines // 0' "$BOUNDARY_REPORT")
  legacy_lines=$(jq -r '.officialLoopOwnerEvidence.legacyLoopLines // 0' "$BOUNDARY_REPORT")
fi

n6_status="pass"
if (( ${#failures[@]} > 0 )) && printf '%s\n' "${failures[@]}" | grep -qx "N6 non-code and candidate SDK compatibility"; then
  n6_status="failed"
elif [[ ! -s "$N6_LOG" ]]; then
  n6_status="missing"
fi

cycle_status="missing"
commercial_complete=false
current_blocking_gate=""
blocking_reason="No one-cycle summary found; run scripts/smoke-cds-agent-one-cycle.sh for remote/provider gate evidence."
deployment_advice="Prefer local/static smokes first. Deploy only when validating remote runtime behavior, auth, container networking, visual evidence, or promotion."
next_command="CDS_HOST=https://cds.miduo.org bash scripts/smoke-cds-agent-one-cycle.sh"
gate_r0="unknown"
gate_a0="$boundary_status"
gate_r1="unknown"
gate_s1="unknown"
gate_s2s3="unknown"
gate_v1="unknown"
gate_n6="$n6_status"
cycle_total_seconds=0
cycle_slowest='[]'
r1_report=""
r1_status="missing"
r1_details_json='null'
if [[ -f "$cycle_summary" ]]; then
  cycle_status=$(jq -r '.status // "unknown"' "$cycle_summary")
  commercial_complete=$(jq -r '.commercialComplete // false' "$cycle_summary")
  current_blocking_gate=$(jq -r '.executionPanel.currentBlockingGate // ""' "$cycle_summary")
  blocking_reason=$(jq -r '.blockingReason // ""' "$cycle_summary")
  deployment_advice=$(jq -r '.deploymentAdvice // ""' "$cycle_summary")
  next_command=$(jq -r '.nextCommand // ""' "$cycle_summary")
  gate_r0=$(jq -r '.commercialGates.R0.status // "unknown"' "$cycle_summary")
  gate_a0=$(jq -r '.commercialGates.A0.status // "'"$boundary_status"'"' "$cycle_summary")
  gate_r1=$(jq -r '.commercialGates.R1.status // "unknown"' "$cycle_summary")
  gate_s1=$(jq -r '.commercialGates.S1.status // "unknown"' "$cycle_summary")
  gate_s2s3=$(jq -r '.commercialGates.S2S3.status // "unknown"' "$cycle_summary")
  gate_v1=$(jq -r '.commercialGates.V1.status // "unknown"' "$cycle_summary")
  gate_n6=$(jq -r '.commercialGates.N6.status // "'"$n6_status"'"' "$cycle_summary")
  cycle_total_seconds=$(jq -r '.timing.totalSeconds // 0' "$cycle_summary")
  cycle_slowest=$(jq -c '.timing.slowest // []' "$cycle_summary")
  r1_report=$(jq -r '.r1.report // ""' "$cycle_summary")
fi

if [[ "$boundary_status" == "pass" ]]; then
  gate_a0="pass"
fi
if [[ "$n6_status" == "pass" ]]; then
  gate_n6="pass"
fi
if [[ -n "$r1_report" && -f "$r1_report" ]]; then
  r1_status=$(jq -r '.status // "unknown"' "$r1_report")
  r1_details_json=$(jq -c '{
    status: (.status // "unknown"),
    targetTemplateId: (.targetTemplateId // ""),
    suggestedCommand: (.suggestedCommand // ""),
    defaultProfile: (.evidence.defaultProfile // null),
    repairPlan: (.evidence.repairPlan // null),
    targetTemplate: (.evidence.targetTemplate // null),
    missingKeyGuard: (.evidence.missingKeyGuard // null),
    providerKeyReceived: (.evidence.providerKeyReceived // false)
  }' "$r1_report")
fi

if [[ "$boundary_status" != "pass" ]]; then
  failures+=("A0 boundary did not pass")
fi
if [[ "$n6_status" != "pass" ]]; then
  failures+=("N6 compatibility did not pass")
fi

goal_status="not_complete"
if [[ "$(json_bool "$commercial_complete")" == "true" \
  && "$boundary_status" == "pass" \
  && "$n6_status" == "pass" \
  && "$gate_r0" == "pass" \
  && "$gate_r1" == "pass" \
  && "$gate_s1" == "pass" \
  && "$gate_s2s3" == "pass" \
  && "$gate_v1" == "pass" ]]; then
  goal_status="complete"
fi

missing_json=$(
  jq -n \
    --arg gateR0 "$gate_r0" \
    --arg gateA0 "$gate_a0" \
    --arg gateR1 "$gate_r1" \
    --arg gateS1 "$gate_s1" \
    --arg gateS2S3 "$gate_s2s3" \
    --arg gateV1 "$gate_v1" \
    --arg gateN6 "$gate_n6" \
    '{
      gates: {
        R0: $gateR0,
        A0: $gateA0,
        R1: $gateR1,
        S1: $gateS1,
        S2S3: $gateS2S3,
        V1: $gateV1,
        N6: $gateN6
      }
    } | .gates | to_entries | map(select(.value != "pass") | {
      requirement: .key,
      status: .value
    })'
)
failures_json='[]'
if (( ${#failures[@]} > 0 )); then
  failures_json=$(printf '%s\n' "${failures[@]}" | jq -R . | jq -s .)
fi
timing_json='[]'
timing_slowest_json='[]'
timing_total_seconds=0
if (( ${#timing_names[@]} > 0 )); then
  timing_json=$(
    for i in "${!timing_names[@]}"; do
      jq -n \
        --arg name "${timing_names[$i]}" \
        --arg status "${timing_statuses[$i]}" \
        --argjson durationSeconds "${timing_seconds[$i]}" \
        '{name:$name,status:$status,durationSeconds:$durationSeconds}'
    done | jq -s .
  )
  timing_slowest_json=$(jq -c 'sort_by(.durationSeconds) | reverse | .[:3]' <<< "$timing_json")
  timing_total_seconds=$(jq -r '[.[].durationSeconds] | add // 0' <<< "$timing_json")
fi

audit_json=$(
  jq -n \
    --arg goalStatus "$goal_status" \
    --arg auditDir "$AUDIT_DIR" \
    --arg boundaryReport "$BOUNDARY_REPORT" \
    --arg n6Log "$N6_LOG" \
    --arg cycleSummary "$cycle_summary" \
    --arg r1Report "$r1_report" \
    --arg cycleStatus "$cycle_status" \
    --arg currentBlockingGate "$current_blocking_gate" \
    --arg blockingReason "$blocking_reason" \
    --arg deploymentAdvice "$deployment_advice" \
    --arg nextCommand "$next_command" \
    --arg boundaryStatus "$boundary_status" \
    --arg n6Status "$n6_status" \
    --arg r1Status "$r1_status" \
    --arg gateR0 "$gate_r0" \
    --arg gateA0 "$gate_a0" \
    --arg gateR1 "$gate_r1" \
    --arg gateS1 "$gate_s1" \
    --arg gateS2S3 "$gate_s2s3" \
    --arg gateV1 "$gate_v1" \
    --arg gateN6 "$gate_n6" \
    --argjson commercialComplete "$(json_bool "$commercial_complete")" \
    --argjson adapterLines "$adapter_lines" \
    --argjson adapterMax "$adapter_max" \
    --argjson supportLines "$support_lines" \
    --argjson supportMax "$support_max" \
    --argjson bridgeTotalLines "$bridge_total_lines" \
    --argjson bridgeTotalMax "$bridge_total_max" \
    --argjson legacyLines "$legacy_lines" \
    --argjson cycleTotalSeconds "$cycle_total_seconds" \
    --argjson cycleSlowest "$cycle_slowest" \
    --argjson localTiming "$timing_json" \
    --argjson localSlowest "$timing_slowest_json" \
    --argjson localTotalSeconds "$timing_total_seconds" \
    --argjson r1Details "$r1_details_json" \
    --argjson missing "$missing_json" \
    --argjson failures "$failures_json" \
    '{
      goalStatus: $goalStatus,
      commercialComplete: $commercialComplete,
      auditDir: $auditDir,
      artifacts: {
        boundaryReport: $boundaryReport,
        nonCodeCompatibilityLog: $n6Log,
        cycleSummary: (if $cycleSummary == "" then null else $cycleSummary end),
        r1Report: (if $r1Report == "" then null else $r1Report end)
      },
      localTiming: {
        totalSeconds: $localTotalSeconds,
        steps: $localTiming,
        slowest: $localSlowest
      },
      requirements: {
        mapCdsControlPlane: {
          status: (if $gateR0 == "pass" then "proved" else "needs-remote-evidence" end),
          gate: "R0"
        },
        officialSdkAdapterBoundary: {
          status: (if $boundaryStatus == "pass" then "proved" else "failed" end),
          gate: "A0",
          adapterLines: $adapterLines,
          adapterMaxLines: $adapterMax,
          bridgeSupportLines: $supportLines,
          bridgeSupportMaxLines: $supportMax,
          bridgeTotalLines: $bridgeTotalLines,
          bridgeTotalMaxLines: $bridgeTotalMax,
          legacyLoopLines: $legacyLines
        },
        otherAgentCompatibility: {
          status: (if $n6Status == "pass" then "proved" else $n6Status end),
          gate: "N6",
          evidence: "non-code Toolbox agents stay independent; codex/openai-agents-sdk/google-adk remain planned-not-routable"
        },
        providerReadiness: {
          status: (if $gateR1 == "pass" then "proved" else "pending" end),
          gate: "R1",
          reportStatus: $r1Status,
          details: $r1Details
        },
        providerBackedRuns: {
          status: (if $gateS1 == "pass" and $gateS2S3 == "pass" then "proved" else "pending" end),
          gates: ["S1", "S2S3"]
        },
        visualAndUsabilityEvidence: {
          status: (if $gateV1 == "pass" then "proved" else $gateV1 end),
          gate: "V1"
        },
        oneCycleObservability: {
          status: (if $cycleStatus == "missing" then "missing-cycle-summary" else "available" end),
          cycleStatus: $cycleStatus,
          totalSeconds: $cycleTotalSeconds,
          slowest: $cycleSlowest
        }
      },
      gates: {
        R0: $gateR0,
        A0: $gateA0,
        R1: $gateR1,
        S1: $gateS1,
        S2S3: $gateS2S3,
        V1: $gateV1,
        N6: $gateN6
      },
      missingOrUnproved: $missing,
      executionPanel: {
        status: $cycleStatus,
        commercialComplete: $commercialComplete,
        currentBlockingGate: $currentBlockingGate,
        blockingReason: $blockingReason,
        deploymentAdvice: $deploymentAdvice,
        nextCommand: $nextCommand
      },
      failures: $failures
    }'
)

if [[ -n "$REPORT" ]]; then
  mkdir -p "$(dirname "$REPORT")"
  printf '%s\n' "$audit_json" > "$REPORT"
fi

printf '\n##########################################\n'
printf '# CDS Agent goal completion audit\n'
printf '##########################################\n'
printf 'Goal status: %s\n' "$goal_status"
printf 'Commercial complete: %s\n' "$commercial_complete"
printf 'A0 boundary: %s adapter=%s/%s support=%s/%s total=%s/%s legacy=%s\n' \
  "$boundary_status" "$adapter_lines" "$adapter_max" "$support_lines" "$support_max" "$bridge_total_lines" "$bridge_total_max" "$legacy_lines"
printf 'N6 compatibility: %s\n' "$n6_status"
printf 'Cycle status: %s\n' "$cycle_status"
printf 'Current blocking gate: %s\n' "${current_blocking_gate:-unknown}"
printf 'Blocking reason: %s\n' "$blocking_reason"
if [[ "$r1_details_json" != "null" ]]; then
  printf 'R1 profile: %s / %s / %s compatible=%s hasKey=%s\n' \
    "$(jq -r '.defaultProfile.name // "unknown"' <<< "$r1_details_json")" \
    "$(jq -r '.defaultProfile.protocol // "unknown"' <<< "$r1_details_json")" \
    "$(jq -r '.defaultProfile.model // "unknown"' <<< "$r1_details_json")" \
    "$(jq -r 'if .defaultProfile | has("compatibleWithDesiredRuntimeAdapter") then (.defaultProfile.compatibleWithDesiredRuntimeAdapter | tostring) else "unknown" end' <<< "$r1_details_json")" \
    "$(jq -r 'if .defaultProfile | has("hasApiKey") then (.defaultProfile.hasApiKey | tostring) else "unknown" end' <<< "$r1_details_json")"
  printf 'R1 target: %s / %s / %s\n' \
    "$(jq -r '.targetTemplateId // "unknown"' <<< "$r1_details_json")" \
    "$(jq -r '.targetTemplate.protocol // "unknown"' <<< "$r1_details_json")" \
    "$(jq -r '.targetTemplate.model // "unknown"' <<< "$r1_details_json")"
fi
printf 'Deploy/build advice: %s\n' "$deployment_advice"
printf 'Next command: %s\n' "$next_command"
printf 'Gates: R0=%s A0=%s R1=%s S1=%s S2/S3=%s V1=%s N6=%s\n' \
  "$gate_r0" "$gate_a0" "$gate_r1" "$gate_s1" "$gate_s2s3" "$gate_v1" "$gate_n6"
printf 'Local guardrail time: %ss\n' "$timing_total_seconds"
if (( ${#timing_names[@]} > 0 )); then
  printf 'Slowest local guardrails:\n'
  jq -r '.[] | "  - " + .name + " · " + (.durationSeconds|tostring) + "s · " + .status' <<< "$timing_slowest_json"
fi
printf 'Audit dir: %s\n' "$AUDIT_DIR"
if [[ -n "$REPORT" ]]; then
  printf 'Audit report: %s\n' "$REPORT"
fi

if (( ${#failures[@]} > 0 )); then
  printf 'Audit guardrail failures:\n' >&2
  for failure in "${failures[@]}"; do
    printf '  - %s\n' "$failure" >&2
  done
  exit 1
fi
