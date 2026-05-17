#!/usr/bin/env bash
# ============================================
# CDS Agent one-cycle commercial smoke
# ============================================
#
# Runs the smallest useful CDS Agent cycle in dependency order:
#   R0 runtime pool -> templates -> R1 repair dry-run/apply -> readiness ledger
#   -> S1 official SDK run -> S2/S3 controls -> V1 visual -> N6 non-code boundary
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
CYCLE_ID="$(date +%Y%m%d%H%M%S)"
SMOKE_CDS_AGENT_CYCLE_DIR="${SMOKE_CDS_AGENT_CYCLE_DIR:-/tmp/cds-agent-cycle-$CYCLE_ID}"

mkdir -p "$SMOKE_CDS_AGENT_CYCLE_DIR"

export SMOKE_CDS_AGENT_READINESS_REPORT="${SMOKE_CDS_AGENT_READINESS_REPORT:-$SMOKE_CDS_AGENT_CYCLE_DIR/readiness-report.json}"
export SMOKE_CDS_AGENT_S1_REPORT="${SMOKE_CDS_AGENT_S1_REPORT:-$SMOKE_CDS_AGENT_CYCLE_DIR/s1-report.json}"
SMOKE_CDS_AGENT_CYCLE_SUMMARY="${SMOKE_CDS_AGENT_CYCLE_SUMMARY:-$SMOKE_CDS_AGENT_CYCLE_DIR/cycle-summary.json}"

passed_arr=()
failed_arr=()
skipped_arr=()

run_step() {
  local key="$1"
  local name="$2"
  local script="$3"
  local log="$SMOKE_CDS_AGENT_CYCLE_DIR/${key}.log"

  printf '\n>>> %s\n' "$name"
  if bash "$script" >"$log" 2>&1; then
    passed_arr+=("$name")
    tail -n 8 "$log"
    return 0
  fi

  failed_arr+=("$name")
  printf 'Step failed. Log: %s\n' "$log" >&2
  tail -n 40 "$log" >&2
  return 1
}

skip_step() {
  local name="$1"
  local reason="$2"
  printf '\n>>> %s\n' "$name"
  printf 'Skipped: %s\n' "$reason"
  skipped_arr+=("$name")
}

finish_cycle() {
  local exit_code="${1:-0}"
  local readiness_overall="unknown"
  local readiness_pending_json="[]"
  local readiness_pending_count=0
  local s1_status="missing"
  local provider_calls_enabled=false
  local r1_repair_apply=false
  local cycle_status="pending"
  local passed_json skipped_json failed_json

  if [[ -f "$SMOKE_CDS_AGENT_READINESS_REPORT" ]]; then
    readiness_overall=$(jq -r '.overall // "unknown"' "$SMOKE_CDS_AGENT_READINESS_REPORT")
    readiness_pending_json=$(jq -c '.pending // []' "$SMOKE_CDS_AGENT_READINESS_REPORT")
    readiness_pending_count=$(jq -r '.pending // [] | length' "$SMOKE_CDS_AGENT_READINESS_REPORT")
  fi

  if [[ -f "$SMOKE_CDS_AGENT_S1_REPORT" ]]; then
    s1_status=$(jq -r '.status // "unknown"' "$SMOKE_CDS_AGENT_S1_REPORT")
  fi

  if [[ "${SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL:-}" == "1" ]]; then
    provider_calls_enabled=true
  fi
  if [[ -n "${SMOKE_CDS_AGENT_ANTHROPIC_API_KEY:-}" ]]; then
    r1_repair_apply=true
  fi

  if (( exit_code != 0 || ${#failed_arr[@]} > 0 )); then
    cycle_status="failed"
  elif [[ "$readiness_overall" == "ready_for_provider_smokes" && "$provider_calls_enabled" == "true" && "$s1_status" == "pass" ]]; then
    cycle_status="provider_smokes_started"
  elif [[ "$readiness_overall" == "ready_for_provider_smokes" && "$provider_calls_enabled" != "true" ]]; then
    cycle_status="ready_for_provider_smokes"
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

  jq -n \
    --arg cycleId "$CYCLE_ID" \
    --arg cycleStatus "$cycle_status" \
    --arg evidenceDir "$SMOKE_CDS_AGENT_CYCLE_DIR" \
    --arg host "${SMOKE_TEST_HOST:-http://localhost:5000}" \
    --arg readinessOverall "$readiness_overall" \
    --arg readinessReport "$SMOKE_CDS_AGENT_READINESS_REPORT" \
    --arg s1Status "$s1_status" \
    --arg s1Report "$SMOKE_CDS_AGENT_S1_REPORT" \
    --arg screenshot "${SMOKE_CDS_AGENT_SCREENSHOT:-}" \
    --argjson providerCallsEnabled "$provider_calls_enabled" \
    --argjson r1RepairApply "$r1_repair_apply" \
    --argjson readinessPending "$readiness_pending_json" \
    --argjson passed "$passed_json" \
    --argjson skipped "$skipped_json" \
    --argjson failed "$failed_json" \
    --argjson exitCode "$exit_code" \
    '{
      cycleId: $cycleId,
      status: $cycleStatus,
      host: $host,
      evidenceDir: $evidenceDir,
      exitCode: $exitCode,
      providerCallsEnabled: $providerCallsEnabled,
      r1RepairApply: $r1RepairApply,
      readiness: {
        overall: $readinessOverall,
        report: $readinessReport,
        pending: $readinessPending
      },
      s1: {
        status: $s1Status,
        report: $s1Report
      },
      visual: {
        screenshot: $screenshot
      },
      steps: {
        passed: $passed,
        skipped: $skipped,
        failed: $failed
      }
    }' > "$SMOKE_CDS_AGENT_CYCLE_SUMMARY"

  printf '\n##########################################\n'
  printf '# CDS Agent one-cycle summary\n'
  printf '##########################################\n'
  printf 'Evidence dir: %s\n' "$SMOKE_CDS_AGENT_CYCLE_DIR"
  printf 'Cycle status: %s\n' "$cycle_status"
  printf 'Readiness overall: %s\n' "$readiness_overall"
  printf 'S1 status: %s\n' "$s1_status"
  printf 'Summary report: %s\n' "$SMOKE_CDS_AGENT_CYCLE_SUMMARY"
  printf 'Passed: %s\n' "${#passed_arr[@]}"
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

  if [[ -f "$SMOKE_CDS_AGENT_S1_REPORT" ]]; then
    printf '\nS1 report:\n'
    jq . "$SMOKE_CDS_AGENT_S1_REPORT"
  fi

  if (( readiness_pending_count > 0 )); then
    printf '\nPending gates:\n'
    jq -r '.[] | "  - " + .' <<< "$readiness_pending_json"
  fi

  printf '\nNext: inspect readiness.log. The goal is not commercially complete until R1 is pass and S1/S2/S3 provider smokes run with SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1.\n'
  exit "$exit_code"
}

printf '##########################################\n'
printf '# CDS Agent one-cycle commercial smoke\n'
printf '##########################################\n'
printf 'Evidence dir: %s\n' "$SMOKE_CDS_AGENT_CYCLE_DIR"
printf 'Host: %s\n' "${SMOKE_TEST_HOST:-http://localhost:5000}"
printf 'Provider calls: %s\n' "${SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL:-0}"
printf 'R1 repair apply: %s\n' "$([[ -n "${SMOKE_CDS_AGENT_ANTHROPIC_API_KEY:-}" ]] && printf yes || printf no)"

run_step "r0-runtime" "R0 runtime pool official SDK ownership" "$SCRIPT_DIR/smoke-cds-agent-runtime-status.sh" || finish_cycle 1
run_step "t1-templates" "T1 official templates and adapter matrix" "$SCRIPT_DIR/smoke-cds-agent-profile-templates.sh" || finish_cycle 1
run_step "r1-repair" "R1 profile repair dry-run or test-before-promote" "$SCRIPT_DIR/smoke-cds-agent-r1-profile-repair.sh" || finish_cycle 1
run_step "readiness" "Commercial readiness ledger" "$SCRIPT_DIR/smoke-cds-agent-commercial-readiness.sh" || finish_cycle 1

run_step "s1-official-sdk-run" "S1 official SDK run evidence" "$SCRIPT_DIR/smoke-cds-agent-official-sdk-run.sh" || finish_cycle 1

run_step "s2-s3-controls" "S2/S3 approval and stop controls" "$SCRIPT_DIR/smoke-cds-agent-official-sdk-controls.sh" || finish_cycle 1

if [[ -n "${SMOKE_CDS_AGENT_ACCESS_TOKEN:-}" \
  || ( -n "${SMOKE_CDS_AGENT_LOGIN_USERNAME:-}" && -n "${SMOKE_CDS_AGENT_LOGIN_PASSWORD:-}" ) ]]; then
  export SMOKE_CDS_AGENT_SCREENSHOT="${SMOKE_CDS_AGENT_SCREENSHOT:-$SMOKE_CDS_AGENT_CYCLE_DIR/workbench-visual.png}"
  run_step "v1-visual" "V1 authenticated workbench visual" "$SCRIPT_DIR/smoke-cds-agent-workbench-visual.sh" || finish_cycle 1
else
  skip_step "V1 authenticated workbench visual" "set SMOKE_CDS_AGENT_ACCESS_TOKEN or login username/password"
fi

run_step "n6-non-code-boundary" "N6 non-code agent compatibility boundary" "$SCRIPT_DIR/smoke-cds-agent-non-code-compatibility.sh" || finish_cycle 1

finish_cycle 0
