#!/usr/bin/env bash
# ============================================
# CDS Agent one-cycle commercial smoke
# ============================================
#
# Runs the smallest useful CDS Agent cycle in dependency order:
#   doctor -> R0 runtime pool -> sidecar alias stability -> templates -> R1 repair dry-run/apply
#   -> readiness ledger -> S1 official SDK run -> S2/S3 controls -> V1 visual -> N6 non-code boundary
#
# This script does not make provider calls unless the caller explicitly sets
# SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1. R1 only writes a real default profile
# when SMOKE_CDS_AGENT_ANTHROPIC_API_KEY is provided.
#
# Evidence is written under:
#   SMOKE_CDS_AGENT_CYCLE_DIR=/tmp/cds-agent-cycle-<timestamp>
# ============================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=smoke-lib.sh
source "$SCRIPT_DIR/smoke-lib.sh"
smoke_require_tools
smoke_infer_preview_host
export SMOKE_TEST_HOST="$SMOKE_HOST"

CYCLE_ID="$(date +%Y%m%d%H%M%S)"
SMOKE_CDS_AGENT_CYCLE_DIR="${SMOKE_CDS_AGENT_CYCLE_DIR:-/tmp/cds-agent-cycle-$CYCLE_ID}"

mkdir -p "$SMOKE_CDS_AGENT_CYCLE_DIR"

export SMOKE_CDS_AGENT_READINESS_REPORT="${SMOKE_CDS_AGENT_READINESS_REPORT:-$SMOKE_CDS_AGENT_CYCLE_DIR/readiness-report.json}"
export SMOKE_CDS_AGENT_DOCTOR_REPORT="${SMOKE_CDS_AGENT_DOCTOR_REPORT:-$SMOKE_CDS_AGENT_CYCLE_DIR/doctor-report.json}"
export SMOKE_CDS_AGENT_DOCTOR_RETRIES="${SMOKE_CDS_AGENT_DOCTOR_RETRIES:-10}"
export SMOKE_CDS_AGENT_DOCTOR_RETRY_SECONDS="${SMOKE_CDS_AGENT_DOCTOR_RETRY_SECONDS:-3}"
export SMOKE_CDS_AGENT_R1_REPORT="${SMOKE_CDS_AGENT_R1_REPORT:-$SMOKE_CDS_AGENT_CYCLE_DIR/r1-report.json}"
export SMOKE_CDS_AGENT_S1_REPORT="${SMOKE_CDS_AGENT_S1_REPORT:-$SMOKE_CDS_AGENT_CYCLE_DIR/s1-report.json}"
export SMOKE_CDS_AGENT_CONTROLS_REPORT="${SMOKE_CDS_AGENT_CONTROLS_REPORT:-$SMOKE_CDS_AGENT_CYCLE_DIR/controls-report.json}"
export SMOKE_CDS_AGENT_BOUNDARY_REPORT="${SMOKE_CDS_AGENT_BOUNDARY_REPORT:-$SMOKE_CDS_AGENT_CYCLE_DIR/official-sdk-boundary-report.json}"
SMOKE_CDS_AGENT_CYCLE_SUMMARY="${SMOKE_CDS_AGENT_CYCLE_SUMMARY:-$SMOKE_CDS_AGENT_CYCLE_DIR/cycle-summary.json}"

passed_arr=()
failed_arr=()
skipped_arr=()
timing_keys=()
timing_names=()
timing_statuses=()
timing_seconds=()

record_timing() {
  local key="$1"
  local name="$2"
  local status="$3"
  local seconds="$4"
  timing_keys+=("$key")
  timing_names+=("$name")
  timing_statuses+=("$status")
  timing_seconds+=("$seconds")
}

run_step() {
  local key="$1"
  local name="$2"
  local script="$3"
  local log="$SMOKE_CDS_AGENT_CYCLE_DIR/${key}.log"
  local start_ts end_ts duration

  printf '\n>>> %s\n' "$name"
  start_ts=$(date +%s)
  if bash "$script" >"$log" 2>&1; then
    end_ts=$(date +%s)
    duration=$((end_ts - start_ts))
    passed_arr+=("$name")
    record_timing "$key" "$name" "passed" "$duration"
    printf 'Step duration: %ss\n' "$duration"
    tail -n 8 "$log"
    return 0
  fi

  end_ts=$(date +%s)
  duration=$((end_ts - start_ts))
  failed_arr+=("$name")
  record_timing "$key" "$name" "failed" "$duration"
  printf 'Step failed after %ss. Log: %s\n' "$duration" "$log" >&2
  tail -n 40 "$log" >&2
  return 1
}

skip_step() {
  local name="$1"
  local reason="$2"
  printf '\n>>> %s\n' "$name"
  printf 'Skipped: %s\n' "$reason"
  skipped_arr+=("$name")
  record_timing "skipped-${#skipped_arr[@]}" "$name" "skipped" "0"
}

finish_cycle() {
  local exit_code="${1:-0}"
  local readiness_overall="unknown"
  local readiness_pending_json="[]"
  local readiness_pending_count=0
  local readiness_execution_panel="null"
  local r1_status="missing"
  local s1_status="missing"
  local controls_status="missing"
  local boundary_status="missing"
  local doctor_diagnosis="missing"
  local doctor_next="missing"
  local doctor_alias_status="unknown"
  local provider_calls_enabled=false
  local r1_repair_apply=false
  local cycle_status="pending"
  local next_command=""
  local pending_has_r1=false
  local pending_has_provider=false
  local gate_r0_status="unknown"
  local gate_a0_status="unknown"
  local gate_r1_status="unknown"
  local gate_s1_status="unknown"
  local gate_s2s3_status="unknown"
  local gate_v1_status="skipped"
  local gate_n6_status="pass"
  local commercial_complete=false
  local blocking_reason=""
  local passed_json skipped_json failed_json timing_json slowest_json total_seconds
  local passed_count skipped_count failed_count
  local doctor_log="$SMOKE_CDS_AGENT_CYCLE_DIR/doctor.log"

  if [[ -f "$SMOKE_CDS_AGENT_READINESS_REPORT" ]]; then
    readiness_overall=$(jq -r '.overall // "unknown"' "$SMOKE_CDS_AGENT_READINESS_REPORT")
    readiness_pending_json=$(jq -c '.pending // []' "$SMOKE_CDS_AGENT_READINESS_REPORT")
    readiness_pending_count=$(jq -r '.pending // [] | length' "$SMOKE_CDS_AGENT_READINESS_REPORT")
    readiness_execution_panel=$(jq -c '.executionPanel // null' "$SMOKE_CDS_AGENT_READINESS_REPORT")
  fi

  if [[ -f "$SMOKE_CDS_AGENT_DOCTOR_REPORT" ]]; then
    doctor_diagnosis=$(jq -r '.diagnosis // "unknown"' "$SMOKE_CDS_AGENT_DOCTOR_REPORT")
    doctor_next=$(jq -r '.nextRecommended // "unknown"' "$SMOKE_CDS_AGENT_DOCTOR_REPORT")
    doctor_alias_status=$(jq -r '.aliasCheck.status // "unknown"' "$SMOKE_CDS_AGENT_DOCTOR_REPORT")
  fi

  if [[ -f "$SMOKE_CDS_AGENT_R1_REPORT" ]]; then
    r1_status=$(jq -r '.status // "unknown"' "$SMOKE_CDS_AGENT_R1_REPORT")
    next_command=$(jq -r '.suggestedCommand // ""' "$SMOKE_CDS_AGENT_R1_REPORT")
  fi

  if [[ -f "$SMOKE_CDS_AGENT_S1_REPORT" ]]; then
    s1_status=$(jq -r '.status // "unknown"' "$SMOKE_CDS_AGENT_S1_REPORT")
  fi

  if [[ -f "$SMOKE_CDS_AGENT_CONTROLS_REPORT" ]]; then
    controls_status=$(jq -r '.status // "unknown"' "$SMOKE_CDS_AGENT_CONTROLS_REPORT")
  fi
  if [[ -f "$SMOKE_CDS_AGENT_BOUNDARY_REPORT" ]]; then
    boundary_status=$(jq -r '.status // "unknown"' "$SMOKE_CDS_AGENT_BOUNDARY_REPORT")
  fi

  if [[ "${SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL:-}" == "1" ]]; then
    provider_calls_enabled=true
  fi
  if [[ -n "${SMOKE_CDS_AGENT_ANTHROPIC_API_KEY:-}" ]]; then
    r1_repair_apply=true
  fi

  if jq -e 'any(.[]?; test("R1|Default runtime profile|Anthropic/Claude-compatible"; "i"))' <<< "$readiness_pending_json" >/dev/null; then
    pending_has_r1=true
  fi
  if jq -e 'any(.[]?; test("S1|S2|S3|provider smoke"; "i"))' <<< "$readiness_pending_json" >/dev/null; then
    pending_has_provider=true
  fi

  if printf '%s\n' "${passed_arr[@]:-}" | grep -qx 'R0 runtime pool official SDK ownership'; then
    if [[ -z "${CDS_HOST:-}" ]] || printf '%s\n' "${passed_arr[@]:-}" | grep -qx 'R0 sidecar alias stability from API container'; then
      gate_r0_status="pass"
    fi
  fi
  if printf '%s\n' "${failed_arr[@]:-}" | grep -Eq 'R0 runtime pool official SDK ownership|R0 sidecar alias stability from API container'; then
    gate_r0_status="failed"
  fi
  if [[ "$boundary_status" == "pass" ]]; then
    gate_a0_status="pass"
  elif [[ "$boundary_status" == "failed" ]]; then
    gate_a0_status="failed"
  elif printf '%s\n' "${failed_arr[@]:-}" | grep -qx 'A0 official SDK adapter boundary'; then
    gate_a0_status="failed"
  fi
  if [[ "$r1_status" == "pass" || "$readiness_overall" == "ready_for_provider_smokes" ]]; then
    gate_r1_status="pass"
  elif [[ "$r1_status" == "dry_run_requires_api_key" || "$pending_has_r1" == "true" ]]; then
    gate_r1_status="pending"
  else
    gate_r1_status="unknown"
  fi
  if [[ "$s1_status" == "pass" ]]; then
    gate_s1_status="pass"
  elif [[ "$s1_status" == "readiness_only" || "$s1_status" == skipped_* || "$pending_has_provider" == "true" ]]; then
    gate_s1_status="pending"
  else
    gate_s1_status="unknown"
  fi
  if [[ "$controls_status" == "pass" ]]; then
    gate_s2s3_status="pass"
  elif [[ "$controls_status" == "readiness_only" || "$controls_status" == skipped_* || "$pending_has_provider" == "true" ]]; then
    gate_s2s3_status="pending"
  else
    gate_s2s3_status="unknown"
  fi
  if printf '%s\n' "${passed_arr[@]:-}" | grep -qx 'V1 authenticated workbench visual'; then
    gate_v1_status="pass"
  elif printf '%s\n' "${failed_arr[@]:-}" | grep -qx 'V1 authenticated workbench visual'; then
    gate_v1_status="failed"
  fi
  if printf '%s\n' "${failed_arr[@]:-}" | grep -qx 'N6 non-code agent compatibility boundary'; then
    gate_n6_status="failed"
  elif ! printf '%s\n' "${passed_arr[@]:-}" | grep -qx 'N6 non-code agent compatibility boundary'; then
    gate_n6_status="unknown"
  fi

  if (( exit_code != 0 || ${#failed_arr[@]} > 0 )); then
    cycle_status="failed"
    blocking_reason="At least one script step failed; inspect failed step logs."
    if [[ -f "$doctor_log" ]] && grep -Eq 'preview-not-ready|CDS preview is not ready|status=starting' "$doctor_log"; then
      cycle_status="preview_not_ready"
      blocking_reason="CDS preview is still starting; retry one-cycle after the preview reports ready."
    fi
  elif [[ "$readiness_overall" == "ready_for_provider_smokes" && "$provider_calls_enabled" == "true" && "$s1_status" == "pass" && "$controls_status" == "pass" ]]; then
    cycle_status="provider_smokes_passed"
  elif [[ "$provider_calls_enabled" == "true" ]]; then
    cycle_status="provider_smokes_incomplete"
    blocking_reason="Provider calls were enabled, but S1/S2/S3 did not all pass."
  elif [[ "$readiness_overall" == "ready_for_provider_smokes" && "$provider_calls_enabled" != "true" ]]; then
    cycle_status="ready_for_provider_smokes"
    blocking_reason="R1 passed, but provider-backed S1/S2/S3 were not run."
  elif [[ "$r1_status" == "dry_run_requires_api_key" || "$pending_has_r1" == "true" ]]; then
    cycle_status="blocked_r1"
    blocking_reason="Default runtime profile is not yet proven Anthropic/Claude-compatible with a usable provider key."
  elif [[ "$pending_has_provider" == "true" ]]; then
    cycle_status="blocked_provider_smokes"
    blocking_reason="Provider-backed S1/S2/S3 smokes are still pending."
  fi

  if [[ "$gate_r0_status" == "pass" \
    && "$gate_a0_status" == "pass" \
    && "$gate_r1_status" == "pass" \
    && "$gate_s1_status" == "pass" \
    && "$gate_s2s3_status" == "pass" \
    && "$gate_v1_status" == "pass" \
    && "$gate_n6_status" == "pass" ]]; then
    commercial_complete=true
    blocking_reason=""
  elif [[ -z "$blocking_reason" ]]; then
    blocking_reason="One or more commercial gates are not pass."
  fi

  if [[ -z "$next_command" ]]; then
    case "$cycle_status" in
      failed)
        next_command="Inspect $SMOKE_CDS_AGENT_CYCLE_SUMMARY and failed step logs under $SMOKE_CDS_AGENT_CYCLE_DIR"
        ;;
      preview_not_ready)
        next_command="CDS_HOST=${CDS_HOST:-https://cds.miduo.org} bash scripts/smoke-cds-agent-one-cycle.sh"
        ;;
      blocked_r1)
        next_command="SMOKE_CDS_AGENT_ANTHROPIC_API_KEY=<sk-ant-...> SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 bash scripts/smoke-cds-agent-one-cycle.sh"
        ;;
      ready_for_provider_smokes|blocked_provider_smokes|provider_smokes_incomplete)
        next_command="SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 bash scripts/smoke-cds-agent-one-cycle.sh"
        ;;
      *)
        next_command="Inspect $SMOKE_CDS_AGENT_CYCLE_SUMMARY and pending gates"
        ;;
    esac
  elif [[ "$cycle_status" == "failed" ]]; then
    next_command="Inspect $SMOKE_CDS_AGENT_CYCLE_SUMMARY and failed step logs under $SMOKE_CDS_AGENT_CYCLE_DIR"
  fi

  passed_json='[]'
  if (( ${#passed_arr[@]} > 0 )); then
    passed_json=$(printf '%s\n' "${passed_arr[@]}" | jq -R . | jq -s .)
  fi
  skipped_json='[]'
  if (( ${#skipped_arr[@]} > 0 )); then
    skipped_json=$(printf '%s\n' "${skipped_arr[@]}" | jq -R . | jq -s .)
  fi
  failed_json='[]'
  if (( ${#failed_arr[@]} > 0 )); then
    failed_json=$(printf '%s\n' "${failed_arr[@]}" | jq -R . | jq -s .)
  fi
  passed_count=${#passed_arr[@]}
  skipped_count=${#skipped_arr[@]}
  failed_count=${#failed_arr[@]}

  timing_json='[]'
  slowest_json='[]'
  total_seconds=0
  if (( ${#timing_keys[@]} > 0 )); then
    timing_json=$(
      for i in "${!timing_keys[@]}"; do
        jq -n \
          --arg key "${timing_keys[$i]}" \
          --arg name "${timing_names[$i]}" \
          --arg status "${timing_statuses[$i]}" \
          --argjson durationSeconds "${timing_seconds[$i]}" \
          '{key:$key,name:$name,status:$status,durationSeconds:$durationSeconds}'
      done | jq -s .
    )
    slowest_json=$(jq -c 'sort_by(.durationSeconds) | reverse | .[:3]' <<< "$timing_json")
    total_seconds=$(jq -r '[.[].durationSeconds] | add // 0' <<< "$timing_json")
  fi

  jq -n \
    --arg cycleId "$CYCLE_ID" \
    --arg cycleStatus "$cycle_status" \
    --arg nextCommand "$next_command" \
    --arg blockingReason "$blocking_reason" \
    --arg evidenceDir "$SMOKE_CDS_AGENT_CYCLE_DIR" \
    --arg host "$SMOKE_TEST_HOST" \
    --arg readinessOverall "$readiness_overall" \
    --arg readinessReport "$SMOKE_CDS_AGENT_READINESS_REPORT" \
    --arg doctorDiagnosis "$doctor_diagnosis" \
    --arg doctorNext "$doctor_next" \
    --arg doctorAliasStatus "$doctor_alias_status" \
    --arg doctorReport "$SMOKE_CDS_AGENT_DOCTOR_REPORT" \
    --arg r1Status "$r1_status" \
    --arg r1Report "$SMOKE_CDS_AGENT_R1_REPORT" \
    --arg s1Status "$s1_status" \
    --arg s1Report "$SMOKE_CDS_AGENT_S1_REPORT" \
    --arg controlsStatus "$controls_status" \
    --arg controlsReport "$SMOKE_CDS_AGENT_CONTROLS_REPORT" \
    --arg boundaryStatus "$boundary_status" \
    --arg boundaryReport "$SMOKE_CDS_AGENT_BOUNDARY_REPORT" \
    --arg screenshot "${SMOKE_CDS_AGENT_SCREENSHOT:-}" \
    --arg gateR0 "$gate_r0_status" \
    --arg gateA0 "$gate_a0_status" \
    --arg gateR1 "$gate_r1_status" \
    --arg gateS1 "$gate_s1_status" \
    --arg gateS2S3 "$gate_s2s3_status" \
    --arg gateV1 "$gate_v1_status" \
    --arg gateN6 "$gate_n6_status" \
    --argjson providerCallsEnabled "$provider_calls_enabled" \
    --argjson r1RepairApply "$r1_repair_apply" \
    --argjson commercialComplete "$commercial_complete" \
    --argjson readinessPending "$readiness_pending_json" \
    --argjson readinessExecutionPanel "$readiness_execution_panel" \
    --argjson passed "$passed_json" \
    --argjson skipped "$skipped_json" \
    --argjson failed "$failed_json" \
    --argjson passedCount "$passed_count" \
    --argjson skippedCount "$skipped_count" \
    --argjson failedCount "$failed_count" \
    --argjson timings "$timing_json" \
    --argjson slowest "$slowest_json" \
    --argjson totalSeconds "$total_seconds" \
    --argjson exitCode "$exit_code" \
    '
    {
      R0: {
        status: $gateR0,
        evidence: "runtime-status and sidecar alias prove claude-agent-sdk loop ownership"
      },
      A0: {
        status: $gateA0,
        evidence: "local source guardrail proves default path uses official Claude Agent SDK adapter and legacy loop is explicit fallback"
      },
      R1: {
        status: $gateR1,
        evidence: "default runtime profile is Anthropic/Claude-compatible and keyed"
      },
      S1: {
        status: $gateS1,
        evidence: "provider-backed read-only official SDK repo run"
      },
      S2S3: {
        status: $gateS2S3,
        evidence: "provider-backed MAP approval and SDK stop/cancel controls"
      },
      V1: {
        status: $gateV1,
        evidence: "authenticated workbench screenshot with real runtime state"
      },
      N6: {
        status: $gateN6,
        evidence: "non-code Toolbox agents remain independent from CDS sidecar runtime pool"
      }
    } as $gates |
    ($gates | to_entries | map(select(.value.status != "pass") | {
      gate: .key,
      status: .value.status,
      evidence: .value.evidence
    })) as $gatesNotPass |
    {
      cycleId: $cycleId,
      status: $cycleStatus,
      commercialComplete: $commercialComplete,
      blockingReason: $blockingReason,
      nextCommand: $nextCommand,
      host: $host,
      evidenceDir: $evidenceDir,
      exitCode: $exitCode,
      providerCallsEnabled: $providerCallsEnabled,
      r1RepairApply: $r1RepairApply,
      readiness: {
        overall: $readinessOverall,
        report: $readinessReport,
        pending: $readinessPending,
        backendExecutionPanel: $readinessExecutionPanel
      },
      doctor: {
        diagnosis: $doctorDiagnosis,
        nextRecommended: $doctorNext,
        aliasStatus: $doctorAliasStatus,
        report: $doctorReport
      },
      r1: {
        status: $r1Status,
        report: $r1Report
      },
      s1: {
        status: $s1Status,
        report: $s1Report
      },
      controls: {
        status: $controlsStatus,
        report: $controlsReport
      },
      officialSdkBoundary: {
        status: $boundaryStatus,
        report: $boundaryReport
      },
      visual: {
        screenshot: $screenshot
      },
      commercialGates: $gates,
      commercialGatesNotPass: $gatesNotPass,
      executionPanel: {
        status: $cycleStatus,
        commercialComplete: $commercialComplete,
        blockingReason: $blockingReason,
        nextCommand: $nextCommand,
        currentBlockingGate: (($gatesNotPass | map(select(.status == "pending")) | .[0].gate) // ($gatesNotPass[0].gate // "")),
        stepCounts: {
          passed: $passedCount,
          skipped: $skippedCount,
          failed: $failedCount
        },
        gateCounts: {
          pass: ($gates | to_entries | map(select(.value.status == "pass")) | length),
          pending: ($gates | to_entries | map(select(.value.status == "pending")) | length),
          skipped: ($gates | to_entries | map(select(.value.status == "skipped")) | length),
          failed: ($gates | to_entries | map(select(.value.status == "failed")) | length),
          unknown: ($gates | to_entries | map(select(.value.status == "unknown")) | length)
        },
        totalSeconds: $totalSeconds,
        slowest: $slowest,
        gatesNotPass: $gatesNotPass
      },
      backendExecutionPanel: $readinessExecutionPanel,
      steps: {
        passed: $passed,
        skipped: $skipped,
        failed: $failed
      },
      timing: {
        totalSeconds: $totalSeconds,
        steps: $timings,
        slowest: $slowest
      }
    }' > "$SMOKE_CDS_AGENT_CYCLE_SUMMARY"

  printf '\n##########################################\n'
  printf '# CDS Agent one-cycle summary\n'
  printf '##########################################\n'
  printf 'Evidence dir: %s\n' "$SMOKE_CDS_AGENT_CYCLE_DIR"
  printf 'Cycle status: %s\n' "$cycle_status"
  printf 'Commercial complete: %s\n' "$commercial_complete"
  if [[ -n "$blocking_reason" ]]; then
    printf 'Blocking reason: %s\n' "$blocking_reason"
  fi
  printf 'Next command: %s\n' "$next_command"
  printf 'Readiness overall: %s\n' "$readiness_overall"
  printf 'Doctor diagnosis: %s\n' "$doctor_diagnosis"
  printf 'Doctor next: %s\n' "$doctor_next"
  printf 'Doctor report: %s\n' "$SMOKE_CDS_AGENT_DOCTOR_REPORT"
  printf 'R1 status: %s\n' "$r1_status"
  printf 'S1 status: %s\n' "$s1_status"
  printf 'Controls status: %s\n' "$controls_status"
  printf 'Official SDK boundary status: %s\n' "$boundary_status"
  printf 'Commercial gates: R0=%s A0=%s R1=%s S1=%s S2/S3=%s V1=%s N6=%s\n' \
    "$gate_r0_status" "$gate_a0_status" "$gate_r1_status" "$gate_s1_status" "$gate_s2s3_status" "$gate_v1_status" "$gate_n6_status"
  if [[ "$commercial_complete" != "true" ]]; then
    printf 'Commercial gates not pass:\n'
    [[ "$gate_r0_status" != "pass" ]] && printf '  - R0=%s\n' "$gate_r0_status"
    [[ "$gate_a0_status" != "pass" ]] && printf '  - A0=%s\n' "$gate_a0_status"
    [[ "$gate_r1_status" != "pass" ]] && printf '  - R1=%s\n' "$gate_r1_status"
    [[ "$gate_s1_status" != "pass" ]] && printf '  - S1=%s\n' "$gate_s1_status"
    [[ "$gate_s2s3_status" != "pass" ]] && printf '  - S2/S3=%s\n' "$gate_s2s3_status"
    [[ "$gate_v1_status" != "pass" ]] && printf '  - V1=%s\n' "$gate_v1_status"
    [[ "$gate_n6_status" != "pass" ]] && printf '  - N6=%s\n' "$gate_n6_status"
  fi
  printf 'Summary report: %s\n' "$SMOKE_CDS_AGENT_CYCLE_SUMMARY"
  printf 'Total measured step time: %ss\n' "$total_seconds"
  if (( ${#timing_keys[@]} > 0 )); then
    printf 'Slowest steps:\n'
    jq -r '.[] | "  - " + .name + " · " + (.durationSeconds|tostring) + "s · " + .status' <<< "$slowest_json"
  fi
  printf 'Script steps passed (exit 0; may still be readiness-only): %s\n' "${#passed_arr[@]}"
  if (( ${#passed_arr[@]} > 0 )); then
    for name in "${passed_arr[@]}"; do printf '  - %s\n' "$name"; done
  fi
  printf 'Skipped: %s\n' "${#skipped_arr[@]}"
  if (( ${#skipped_arr[@]} > 0 )); then
    for name in "${skipped_arr[@]}"; do printf '  - %s\n' "$name"; done
  fi
  printf 'Failed: %s\n' "${#failed_arr[@]}"
  if (( ${#failed_arr[@]} > 0 )); then
    for name in "${failed_arr[@]}"; do printf '  - %s\n' "$name"; done
  fi

  if [[ -f "$SMOKE_CDS_AGENT_R1_REPORT" ]]; then
    printf '\nR1 report:\n'
    jq . "$SMOKE_CDS_AGENT_R1_REPORT"
  fi

  if [[ -f "$SMOKE_CDS_AGENT_S1_REPORT" ]]; then
    printf '\nS1 report:\n'
    jq . "$SMOKE_CDS_AGENT_S1_REPORT"
  fi

  if [[ -f "$SMOKE_CDS_AGENT_CONTROLS_REPORT" ]]; then
    printf '\nControls report:\n'
    jq . "$SMOKE_CDS_AGENT_CONTROLS_REPORT"
  fi

  if (( readiness_pending_count > 0 )); then
    printf '\nPending gates:\n'
    jq -r '.[] | "  - " + .' <<< "$readiness_pending_json"
  fi

  printf '\nNext: %s\n' "$next_command"
  printf 'The goal is not commercially complete until R1 is pass and S1/S2/S3 provider smokes run with SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1.\n'
  exit "$exit_code"
}

printf '##########################################\n'
printf '# CDS Agent one-cycle commercial smoke\n'
printf '##########################################\n'
printf 'Evidence dir: %s\n' "$SMOKE_CDS_AGENT_CYCLE_DIR"
printf 'Host: %s\n' "$SMOKE_TEST_HOST"
printf 'Provider calls: %s\n' "${SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL:-0}"
printf 'R1 repair apply: %s\n' "$([[ -n "${SMOKE_CDS_AGENT_ANTHROPIC_API_KEY:-}" ]] && printf yes || printf no)"

run_step "doctor" "Runtime doctor and next action report" "$SCRIPT_DIR/doctor-cds-agent-runtime.sh" || finish_cycle 1

run_step "r0-runtime" "R0 runtime pool official SDK ownership" "$SCRIPT_DIR/smoke-cds-agent-runtime-status.sh" || finish_cycle 1
if [[ -n "${CDS_HOST:-}" ]]; then
  run_step "r0-sidecar-alias" "R0 sidecar alias stability from API container" "$SCRIPT_DIR/smoke-cds-agent-sidecar-alias-stability.sh" || finish_cycle 1
else
  skip_step "R0 sidecar alias stability from API container" "set CDS_HOST to exec inside the remote CDS API container"
fi
run_step "t1-templates" "T1 official templates and adapter matrix" "$SCRIPT_DIR/smoke-cds-agent-profile-templates.sh" || finish_cycle 1
run_step "a0-official-sdk-boundary" "A0 official SDK adapter boundary" "$SCRIPT_DIR/smoke-cds-agent-official-sdk-boundary.sh" || finish_cycle 1
run_step "r1-repair" "R1 profile repair dry-run or test-before-promote" "$SCRIPT_DIR/smoke-cds-agent-r1-profile-repair.sh" || finish_cycle 1
run_step "readiness" "Commercial readiness ledger" "$SCRIPT_DIR/smoke-cds-agent-commercial-readiness.sh" || finish_cycle 1

run_step "s1-official-sdk-run" "S1 official SDK run evidence" "$SCRIPT_DIR/smoke-cds-agent-official-sdk-run.sh" || finish_cycle 1

run_step "s2-s3-controls" "S2/S3 approval and stop controls" "$SCRIPT_DIR/smoke-cds-agent-official-sdk-controls.sh" || finish_cycle 1

if [[ -n "${SMOKE_CDS_AGENT_ACCESS_TOKEN:-}" \
  || ( -n "${SMOKE_CDS_AGENT_LOGIN_USERNAME:-}" && -n "${SMOKE_CDS_AGENT_LOGIN_PASSWORD:-}" ) \
  || -n "${AI_ACCESS_KEY:-}" ]]; then
  export SMOKE_CDS_AGENT_SCREENSHOT="${SMOKE_CDS_AGENT_SCREENSHOT:-$SMOKE_CDS_AGENT_CYCLE_DIR/workbench-visual.png}"
  run_step "v1-visual" "V1 authenticated workbench visual" "$SCRIPT_DIR/smoke-cds-agent-workbench-visual.sh" || finish_cycle 1
else
  skip_step "V1 authenticated workbench visual" "set SMOKE_CDS_AGENT_ACCESS_TOKEN, login username/password, or AI_ACCESS_KEY"
fi

run_step "n6-non-code-boundary" "N6 non-code agent compatibility boundary" "$SCRIPT_DIR/smoke-cds-agent-non-code-compatibility.sh" || finish_cycle 1

finish_cycle 0
