#!/usr/bin/env bash
# ============================================
# CDS Agent R0 post self-update verification
# ============================================
#
# Run this only after a human has approved and completed the shared CDS
# control-plane self update. This script does not run `cdscli self update`.
#
# Required:
#   CDS_HOST
#
# Optional:
#   SMOKE_CDS_BRANCH_ID                  default: prd-agent-codex-cds-agent-workbench-ui
#   SMOKE_CDS_AGENT_POST_UPDATE_DIR      default: /tmp/cds-agent-post-self-update-<timestamp>
#   SMOKE_CDS_AGENT_RUN_DEPLOY           default: 1
#   SMOKE_CDS_AGENT_DEPLOY_TIMEOUT       default: 900
# ============================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_ID="$(date +%Y%m%d%H%M%S)"
SMOKE_CDS_BRANCH_ID="${SMOKE_CDS_BRANCH_ID:-prd-agent-codex-cds-agent-workbench-ui}"
SMOKE_CDS_AGENT_POST_UPDATE_DIR="${SMOKE_CDS_AGENT_POST_UPDATE_DIR:-/tmp/cds-agent-post-self-update-$RUN_ID}"
SMOKE_CDS_AGENT_RUN_DEPLOY="${SMOKE_CDS_AGENT_RUN_DEPLOY:-1}"
SMOKE_CDS_AGENT_DEPLOY_TIMEOUT="${SMOKE_CDS_AGENT_DEPLOY_TIMEOUT:-900}"
SUMMARY_REPORT="$SMOKE_CDS_AGENT_POST_UPDATE_DIR/post-self-update-summary.json"

mkdir -p "$SMOKE_CDS_AGENT_POST_UPDATE_DIR"

if [[ -z "${CDS_HOST:-}" ]]; then
  printf 'CDS_HOST is required\n' >&2
  exit 1
fi

if [[ ! -f ".claude/skills/cds/cli/cdscli.py" ]]; then
  printf '.claude/skills/cds/cli/cdscli.py not found\n' >&2
  exit 1
fi

step_names=()
step_statuses=()
step_seconds=()
failed_steps=()

record_step() {
  step_names+=("$1")
  step_statuses+=("$2")
  step_seconds+=("$3")
  if [[ "$2" != "passed" && "$2" != "skipped" ]]; then
    failed_steps+=("$1")
  fi
}

run_logged() {
  local name="$1"
  local log="$2"
  shift 2
  local start_ts end_ts duration
  printf '\n>>> %s\n' "$name"
  start_ts=$(date +%s)
  if "$@" >"$log" 2>&1; then
    end_ts=$(date +%s)
    duration=$((end_ts - start_ts))
    record_step "$name" "passed" "$duration"
    printf 'Step duration: %ss\n' "$duration"
    tail -n 20 "$log"
    return 0
  fi
  end_ts=$(date +%s)
  duration=$((end_ts - start_ts))
  record_step "$name" "failed" "$duration"
  printf 'Step failed after %ss. Log: %s\n' "$duration" "$log" >&2
  tail -n 60 "$log" >&2
  return 1
}

finish() {
  local exit_code="${1:-0}"
  local steps_json failed_json total_seconds status
  status="passed"
  if (( exit_code != 0 || ${#failed_steps[@]} > 0 )); then
    status="failed"
  fi

  steps_json='[]'
  total_seconds=0
  if (( ${#step_names[@]} > 0 )); then
    steps_json=$(
      for i in "${!step_names[@]}"; do
        jq -n \
          --arg name "${step_names[$i]}" \
          --arg status "${step_statuses[$i]}" \
          --argjson durationSeconds "${step_seconds[$i]}" \
          '{name:$name,status:$status,durationSeconds:$durationSeconds}'
      done | jq -s .
    )
    total_seconds=$(jq -r '[.[].durationSeconds] | add // 0' <<< "$steps_json")
  fi
  failed_json='[]'
  if (( ${#failed_steps[@]} > 0 )); then
    failed_json=$(printf '%s\n' "${failed_steps[@]}" | jq -R . | jq -s .)
  fi

  jq -n \
    --arg status "$status" \
    --arg host "$CDS_HOST" \
    --arg branchId "$SMOKE_CDS_BRANCH_ID" \
    --arg evidenceDir "$SMOKE_CDS_AGENT_POST_UPDATE_DIR" \
    --argjson steps "$steps_json" \
    --argjson failed "$failed_json" \
    --argjson totalSeconds "$total_seconds" \
    '{
      status: $status,
      host: $host,
      branchId: $branchId,
      evidenceDir: $evidenceDir,
      timing: {
        totalSeconds: $totalSeconds,
        steps: $steps
      },
      failedSteps: $failed
    }' > "$SUMMARY_REPORT"

  printf '\n##########################################\n'
  printf '# CDS Agent R0 post self-update summary\n'
  printf '##########################################\n'
  printf 'Status: %s\n' "$status"
  printf 'Evidence dir: %s\n' "$SMOKE_CDS_AGENT_POST_UPDATE_DIR"
  printf 'Summary report: %s\n' "$SUMMARY_REPORT"
  printf 'Total measured step time: %ss\n' "$total_seconds"
  if (( ${#failed_steps[@]} > 0 )); then
    printf 'Failed steps:\n'
    for step in "${failed_steps[@]}"; do printf '  - %s\n' "$step"; done
  fi
  exit "$exit_code"
}

printf '##########################################\n'
printf '# CDS Agent R0 post self-update verification\n'
printf '##########################################\n'
printf 'Evidence dir: %s\n' "$SMOKE_CDS_AGENT_POST_UPDATE_DIR"
printf 'CDS_HOST: %s\n' "$CDS_HOST"
printf 'Branch: %s\n' "$SMOKE_CDS_BRANCH_ID"
printf 'Run deploy: %s\n' "$SMOKE_CDS_AGENT_RUN_DEPLOY"

run_logged "CDS self branches" "$SMOKE_CDS_AGENT_POST_UPDATE_DIR/self-branches.log" \
  env CDS_HOST="$CDS_HOST" python3 .claude/skills/cds/cli/cdscli.py self branches || finish 1

if [[ "$SMOKE_CDS_AGENT_RUN_DEPLOY" == "1" ]]; then
  run_logged "Redeploy preview branch" "$SMOKE_CDS_AGENT_POST_UPDATE_DIR/branch-deploy.log" \
    env CDS_HOST="$CDS_HOST" python3 .claude/skills/cds/cli/cdscli.py branch deploy "$SMOKE_CDS_BRANCH_ID" --timeout "$SMOKE_CDS_AGENT_DEPLOY_TIMEOUT" || finish 1
else
  record_step "Redeploy preview branch" "skipped" "0"
  printf '\n>>> Redeploy preview branch\nSkipped: SMOKE_CDS_AGENT_RUN_DEPLOY != 1\n'
fi

run_logged "Preview branch status" "$SMOKE_CDS_AGENT_POST_UPDATE_DIR/branch-status.log" \
  env CDS_HOST="$CDS_HOST" python3 .claude/skills/cds/cli/cdscli.py branch status "$SMOKE_CDS_BRANCH_ID" || finish 1

run_logged "R0 sidecar alias stability" "$SMOKE_CDS_AGENT_POST_UPDATE_DIR/sidecar-alias.log" \
  env CDS_HOST="$CDS_HOST" bash "$SCRIPT_DIR/smoke-cds-agent-sidecar-alias-stability.sh" || finish 1

export SMOKE_CDS_AGENT_CYCLE_DIR="$SMOKE_CDS_AGENT_POST_UPDATE_DIR/one-cycle"
run_logged "CDS Agent one-cycle" "$SMOKE_CDS_AGENT_POST_UPDATE_DIR/one-cycle.log" \
  env CDS_HOST="$CDS_HOST" bash "$SCRIPT_DIR/smoke-cds-agent-one-cycle.sh" || finish 1

finish 0
