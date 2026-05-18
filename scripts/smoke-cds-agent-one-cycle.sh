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
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=smoke-lib.sh
source "$SCRIPT_DIR/smoke-lib.sh"
smoke_require_tools
SMOKE_TARGET_SOURCE="default-local"
if [[ -n "${SMOKE_TEST_HOST:-}" ]]; then
  SMOKE_TARGET_SOURCE="explicit-smoke-test-host"
elif [[ -n "${CDS_HOST:-}" ]]; then
  SMOKE_TARGET_SOURCE="cds-preview-inferred"
fi
smoke_infer_preview_host
if [[ -z "${SMOKE_TEST_HOST:-}" && -n "${CDS_HOST:-}" && "$SMOKE_HOST" == "http://localhost:5000" ]]; then
  SMOKE_TARGET_SOURCE="cds-preview-inference-failed"
fi
export SMOKE_TEST_HOST="$SMOKE_HOST"

CYCLE_ID="$(date +%Y%m%d%H%M%S)"
cycle_created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
git_branch="$(git -C "$ROOT_DIR" branch --show-current 2>/dev/null || printf '')"
git_commit="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || printf '')"
git_commit_short="$(git -C "$ROOT_DIR" rev-parse --short=10 HEAD 2>/dev/null || printf '')"
SMOKE_CDS_AGENT_CYCLE_DIR="${SMOKE_CDS_AGENT_CYCLE_DIR:-/tmp/cds-agent-cycle-$CYCLE_ID}"
SMOKE_CDS_BRANCH_ID="${SMOKE_CDS_BRANCH_ID:-prd-agent-codex-cds-agent-workbench-ui}"

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
timing_phases=()
timing_indices=()
timing_totals=()
SMOKE_STEP_TOTAL="${SMOKE_STEP_TOTAL:-11}"
SMOKE_STEP_CURRENT=0

record_timing() {
  local key="$1"
  local name="$2"
  local status="$3"
  local seconds="$4"
  local phase="${5:-unspecified}"
  timing_keys+=("$key")
  timing_names+=("$name")
  timing_statuses+=("$status")
  timing_seconds+=("$seconds")
  timing_phases+=("$phase")
  timing_indices+=("$SMOKE_STEP_CURRENT")
  timing_totals+=("$SMOKE_STEP_TOTAL")
}

read_remote_branch_status() {
  if [[ -z "${CDS_HOST:-}" ]]; then
    return 1
  fi
  if [[ ! -f "$ROOT_DIR/.claude/skills/cds/cli/cdscli.py" ]]; then
    return 1
  fi
  CDS_HOST="$CDS_HOST" python3 "$ROOT_DIR/.claude/skills/cds/cli/cdscli.py" branch status "$SMOKE_CDS_BRANCH_ID" 2>/dev/null || return 1
}

is_non_runtime_cycle_drift_path() {
  local path="$1"
  case "$path" in
    *.md|*.MD|*.txt|*.TXT) return 0 ;;
    CHANGELOG*|changelogs/*|doc/*|.claude/*|.github/*|e2e/*) return 0 ;;
    cds/tests/*|prd-admin/src/*/__tests__/*) return 0 ;;
    scripts/smoke-*|scripts/audit-*|scripts/doctor-*|scripts/preflight-*|scripts/verify-*|scripts/index-*) return 0 ;;
    LICENSE|license|.gitignore|.editorconfig) return 0 ;;
  esac
  return 1
}

classify_remote_runtime_git_drift() {
  local base_commit="$1"
  local head_commit="$2"
  local diff_output path has_paths=false has_runtime=false
  if [[ -z "$base_commit" || -z "$head_commit" ]]; then
    return 1
  fi
  if ! diff_output=$(git -C "$ROOT_DIR" diff --name-only "${base_commit}..${head_commit}" 2>/dev/null); then
    return 1
  fi
  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    has_paths=true
    if ! is_non_runtime_cycle_drift_path "$path"; then
      has_runtime=true
      break
    fi
  done <<< "$diff_output"
  if [[ "$has_runtime" == "true" ]]; then
    return 2
  fi
  if [[ "$has_paths" == "true" ]]; then
    return 0
  fi
  return 3
}

next_step() {
  SMOKE_STEP_CURRENT=$((SMOKE_STEP_CURRENT + 1))
  printf '\n[%02d/%02d] %s · %s\n' "$SMOKE_STEP_CURRENT" "$SMOKE_STEP_TOTAL" "$1" "$2"
}

run_step() {
  local key="$1"
  local name="$2"
  local script="$3"
  local phase="${4:-remote-api}"
  local log="$SMOKE_CDS_AGENT_CYCLE_DIR/${key}.log"
  local start_ts end_ts duration pid rc last_heartbeat elapsed

  next_step "$phase" "$name"
  start_ts=$(date +%s)
  last_heartbeat="$start_ts"
  bash "$script" >"$log" 2>&1 &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    sleep 1
    elapsed=$(( $(date +%s) - start_ts ))
    if kill -0 "$pid" 2>/dev/null && (( $(date +%s) - last_heartbeat >= 15 )); then
      last_heartbeat=$(date +%s)
      printf 'Still running: %s · elapsed=%ss · log=%s\n' "$name" "$elapsed" "$log"
      tail -n 3 "$log" 2>/dev/null || true
    fi
  done
  wait "$pid"
  rc=$?
  if (( rc == 0 )); then
    end_ts=$(date +%s)
    duration=$((end_ts - start_ts))
    passed_arr+=("$name")
    record_timing "$key" "$name" "passed" "$duration" "$phase"
    printf 'Result: passed · duration=%ss · log=%s\n' "$duration" "$log"
    tail -n 8 "$log"
    return 0
  fi

  end_ts=$(date +%s)
  duration=$((end_ts - start_ts))
  failed_arr+=("$name")
  record_timing "$key" "$name" "failed" "$duration" "$phase"
  printf 'Result: failed · exit=%s · duration=%ss · log=%s\n' "$rc" "$duration" "$log" >&2
  tail -n 40 "$log" >&2
  return 1
}

skip_step() {
  local name="$1"
  local reason="$2"
  local phase="${3:-skipped}"
  next_step "$phase" "$name"
  printf 'Result: skipped · reason=%s\n' "$reason"
  skipped_arr+=("$name")
  record_timing "skipped-${#skipped_arr[@]}" "$name" "skipped" "0" "$phase"
}

finish_cycle() {
  local exit_code="${1:-0}"
  local readiness_overall="unknown"
  local readiness_pending_json="[]"
  local readiness_pending_count=0
  local readiness_execution_panel="null"
  local readiness_next_cycle_plan="null"
  local r1_status="missing"
  local s1_status="missing"
  local controls_status="missing"
  local boundary_status="missing"
  local boundary_metrics_json="null"
  local doctor_diagnosis="missing"
  local doctor_next="missing"
  local doctor_alias_status="unknown"
  local r1_details_json="null"
  local s1_details_json="null"
  local controls_details_json="null"
  local provider_calls_enabled=false
  local r1_repair_apply=false
  local provider_prerequisite_status="readiness_only"
  local provider_prerequisite_advice="Provider calls are disabled; set SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 after R1 is pass."
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
  local deployment_advice=""
  local failure_kind="none"
  local failure_advice=""
  local narrow_rerun_command=""
  local remote_branch_status_json="null"
  local remote_branch_observed=false
  local remote_branch_status="skipped"
  local remote_branch_id="$SMOKE_CDS_BRANCH_ID"
  local remote_github_commit=""
  local remote_runtime_commit=""
  local remote_subject=""
  local remote_preview_slug=""
  local remote_deploy_count=""
  local remote_last_deploy_at=""
  local remote_runtime_relation="not_observed"
  local remote_deploy_advice="Set CDS_HOST to include remote CDS branch status in this cycle summary."
  local passed_json skipped_json failed_json timing_json slowest_json total_seconds
  local passed_count skipped_count failed_count
  local doctor_log="$SMOKE_CDS_AGENT_CYCLE_DIR/doctor.log"
  local sidecar_alias_log="$SMOKE_CDS_AGENT_CYCLE_DIR/r0-sidecar-alias.log"

  if [[ -f "$SMOKE_CDS_AGENT_READINESS_REPORT" ]]; then
    readiness_overall=$(jq -r '.overall // "unknown"' "$SMOKE_CDS_AGENT_READINESS_REPORT")
    readiness_pending_json=$(jq -c '.pending // []' "$SMOKE_CDS_AGENT_READINESS_REPORT")
    readiness_pending_count=$(jq -r '.pending // [] | length' "$SMOKE_CDS_AGENT_READINESS_REPORT")
    readiness_execution_panel=$(jq -c '.executionPanel // null' "$SMOKE_CDS_AGENT_READINESS_REPORT")
    readiness_next_cycle_plan=$(jq -c '.nextCyclePlan // null' "$SMOKE_CDS_AGENT_READINESS_REPORT")
  fi

  if [[ -f "$SMOKE_CDS_AGENT_DOCTOR_REPORT" ]]; then
    doctor_diagnosis=$(jq -r '.diagnosis // "unknown"' "$SMOKE_CDS_AGENT_DOCTOR_REPORT")
    doctor_next=$(jq -r '.nextRecommended // "unknown"' "$SMOKE_CDS_AGENT_DOCTOR_REPORT")
    doctor_alias_status=$(jq -r '.aliasCheck.status // "unknown"' "$SMOKE_CDS_AGENT_DOCTOR_REPORT")
  fi

  if [[ -f "$SMOKE_CDS_AGENT_R1_REPORT" ]]; then
    r1_status=$(jq -r '.status // "unknown"' "$SMOKE_CDS_AGENT_R1_REPORT")
    next_command=$(jq -r '.suggestedCommand // ""' "$SMOKE_CDS_AGENT_R1_REPORT")
    r1_details_json=$(jq -c '{
      status: (.status // "unknown"),
      targetTemplateId: (.targetTemplateId // ""),
      suggestedCommand: (.suggestedCommand // ""),
      suggestedRepairCommand: (.suggestedRepairCommand // ""),
      nextCommands: (.nextCommands // null),
      defaultProfile: (.evidence.defaultProfile // null),
      repairPlan: (.evidence.repairPlan // null),
      targetTemplate: (.evidence.targetTemplate // null),
      providerKeyReceived: (.evidence.providerKeyReceived // false)
    }' "$SMOKE_CDS_AGENT_R1_REPORT")
  fi

  if [[ -f "$SMOKE_CDS_AGENT_S1_REPORT" ]]; then
    s1_status=$(jq -r '.status // "unknown"' "$SMOKE_CDS_AGENT_S1_REPORT")
    s1_details_json=$(jq -c '{
      status: (.status // "unknown"),
      sessionId: (.sessionId // ""),
      traceId: (.traceId // ""),
      defaultProfile: (.evidence.defaultProfile // null)
    }' "$SMOKE_CDS_AGENT_S1_REPORT")
  fi

  if [[ -f "$SMOKE_CDS_AGENT_CONTROLS_REPORT" ]]; then
    controls_status=$(jq -r '.status // "unknown"' "$SMOKE_CDS_AGENT_CONTROLS_REPORT")
    controls_details_json=$(jq -c '{
      status: (.status // "unknown"),
      target: (.target // null),
      defaultProfile: (.evidence.defaultProfile // null)
    }' "$SMOKE_CDS_AGENT_CONTROLS_REPORT")
  fi
  if [[ -f "$SMOKE_CDS_AGENT_BOUNDARY_REPORT" ]]; then
    boundary_status=$(jq -r '.status // "unknown"' "$SMOKE_CDS_AGENT_BOUNDARY_REPORT")
    boundary_metrics_json=$(jq -c '.officialLoopOwnerEvidence // null' "$SMOKE_CDS_AGENT_BOUNDARY_REPORT")
  fi

  if [[ "${SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL:-}" == "1" ]]; then
    provider_calls_enabled=true
  fi
  if [[ -n "${SMOKE_CDS_AGENT_ANTHROPIC_API_KEY:-}" ]]; then
    r1_repair_apply=true
  fi
  if [[ "$provider_calls_enabled" == "true" && ( "$r1_status" == "already_pass" || "$r1_status" == "pass" || "$readiness_overall" == "ready_for_provider_smokes" ) ]]; then
    provider_prerequisite_status="provider_profile_ready"
    provider_prerequisite_advice="Provider calls were requested and the default CDS-managed runtime profile is already compatible; no smoke-supplied Anthropic key is required."
  elif [[ "$provider_calls_enabled" == "true" && "$r1_repair_apply" == "true" ]]; then
    provider_prerequisite_status="provider_and_r1_repair_requested"
    provider_prerequisite_advice="This cycle may close R1 and collect S1/S2/S3 only if the smoke-supplied Anthropic key is saved as a CDS-managed profile/secret after backend test-before-promote."
  elif [[ "$provider_calls_enabled" == "true" ]]; then
    provider_prerequisite_status="provider_requested_without_r1_repair_key"
    provider_prerequisite_advice="Provider calls were requested, but no CDS-managed Anthropic profile/secret is available to this smoke; R1 cannot be repaired by this cycle."
  elif [[ "$r1_repair_apply" == "true" ]]; then
    provider_prerequisite_status="r1_repair_key_without_provider_calls"
    provider_prerequisite_advice="A smoke-only Anthropic key was provided for R1 repair, but S1/S2/S3 provider smokes remain disabled until SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1."
  fi

  if remote_status_raw=$(read_remote_branch_status); then
    remote_branch_status_json=$(printf '%s' "$remote_status_raw" | jq -c '.data // null' 2>/dev/null || printf 'null')
    if [[ "$remote_branch_status_json" != "null" ]]; then
      remote_branch_observed=true
      remote_branch_status=$(jq -r '.status // "unknown"' <<< "$remote_branch_status_json")
      remote_branch_id=$(jq -r '.id // "'"$SMOKE_CDS_BRANCH_ID"'"' <<< "$remote_branch_status_json")
      remote_github_commit=$(jq -r '.githubCommitSha // ""' <<< "$remote_branch_status_json")
      remote_runtime_commit=$(jq -r '.commitSha // ""' <<< "$remote_branch_status_json")
      remote_subject=$(jq -r '.subject // ""' <<< "$remote_branch_status_json")
      remote_preview_slug=$(jq -r '.previewSlug // ""' <<< "$remote_branch_status_json")
      remote_deploy_count=$(jq -r '.deployCount // ""' <<< "$remote_branch_status_json")
      remote_last_deploy_at=$(jq -r '.lastDeployAt // ""' <<< "$remote_branch_status_json")
      if [[ -n "$remote_runtime_commit" && -n "$git_commit_short" && "$git_commit_short" == "$remote_runtime_commit"* ]]; then
        remote_runtime_relation="runtime_matches_head"
        remote_deploy_advice="Remote runtime commit matches cycle HEAD; do not redeploy unless provider/profile or visual evidence requires it."
      elif classify_remote_runtime_git_drift "$remote_runtime_commit" "$git_commit"; then
        remote_runtime_relation="runtime_behind_non_runtime_drift"
        remote_deploy_advice="Remote runtime is behind cycle HEAD only by compatible non-runtime drift; do not self update for this state."
      elif (( $? == 2 )); then
        remote_runtime_relation="runtime_behind_runtime_drift"
        remote_deploy_advice="Remote runtime evidence does not cover current runtime-affecting changes; update remote runtime before claiming this cycle for current HEAD."
      elif [[ -n "$remote_runtime_commit" ]]; then
        remote_runtime_relation="runtime_commit_differs_from_cycle_head"
        remote_deploy_advice="Remote runtime commit differs from cycle HEAD and drift could not be classified; inspect git diff before deploying."
      else
        remote_runtime_relation="runtime_commit_missing"
        remote_deploy_advice="Remote branch status did not include a runtime commit; inspect CDS branch status before deploying."
      fi
    fi
  else
    remote_deploy_advice="Set CDS_HOST to include remote CDS branch status in this cycle summary."
  fi

  if jq -e 'any(.[]?; test("R1|Default runtime profile|Anthropic/Claude-compatible"; "i"))' <<< "$readiness_pending_json" >/dev/null; then
    pending_has_r1=true
  fi
  if jq -e 'any(.[]?; test("S1|S2|S3|provider smoke"; "i"))' <<< "$readiness_pending_json" >/dev/null; then
    pending_has_provider=true
  fi

  if printf '%s\n' "${passed_arr[@]:-}" | grep -qx 'R0 runtime pool official SDK ownership'; then
    if [[ -z "${CDS_HOST:-}" ]] \
      || printf '%s\n' "${passed_arr[@]:-}" | grep -qx 'R0 sidecar alias stability from API container' \
      || printf '%s\n' "${skipped_arr[@]:-}" | grep -qx 'R0 sidecar alias stability from API container'; then
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
      failure_kind="preview_not_ready"
      blocking_reason="CDS preview is still starting; retry one-cycle after the preview reports ready."
    elif [[ -f "$doctor_log" ]] && grep -Fq 'Failed to connect to localhost port 5000' "$doctor_log"; then
      failure_kind="local_api_unreachable"
      blocking_reason="The smoke target is default localhost, but no local API is listening on port 5000."
      failure_advice="This is a target selection issue, not evidence that CDS needs a deploy. Start the local API or set CDS_HOST=https://cds.miduo.org to validate the remote preview."
      narrow_rerun_command="CDS_HOST=https://cds.miduo.org bash scripts/smoke-cds-agent-one-cycle.sh"
    elif [[ -f "$doctor_log" ]] && grep -Fq 'Could not resolve host' "$doctor_log"; then
      failure_kind="remote_dns_unreachable"
      blocking_reason="The smoke target host could not be resolved from this environment."
      failure_advice="This is network/DNS reachability, not an application or deploy failure. Rerun with network access to the same CDS preview host."
      narrow_rerun_command="CDS_HOST=${CDS_HOST:-https://cds.miduo.org} bash scripts/smoke-cds-agent-one-cycle.sh"
    elif [[ -f "$doctor_log" ]] && grep -Fq '401' "$doctor_log"; then
      failure_kind="auth_failed"
      blocking_reason="The smoke target rejected the request; check AI_ACCESS_KEY or the authenticated preview session."
      failure_advice="Do not redeploy for auth failures. Fix credentials and rerun the same smoke."
    elif [[ -f "$sidecar_alias_log" ]] && grep -Fq 'No such container:' "$sidecar_alias_log"; then
      failure_kind="remote_branch_idle_or_container_missing"
      blocking_reason="CDS branch exec could not find the remote API container; the preview branch is likely idle/stopped or CDS container state is stale."
      failure_advice="Do not change application code for this state. Check CDS branch status first; if services are stopped, wake or redeploy the existing preview before rerunning only the alias smoke."
      narrow_rerun_command="CDS_HOST=${CDS_HOST:-https://cds.miduo.org} bash scripts/smoke-cds-agent-sidecar-alias-stability.sh"
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
    blocking_reason="Default runtime profile is not yet proven Anthropic/Claude-compatible with a usable CDS-managed provider secret."
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
        if [[ -n "$narrow_rerun_command" ]]; then
          next_command="$narrow_rerun_command"
        else
          next_command="Inspect $SMOKE_CDS_AGENT_CYCLE_SUMMARY and failed step logs under $SMOKE_CDS_AGENT_CYCLE_DIR"
        fi
        ;;
      preview_not_ready)
        next_command="CDS_HOST=${CDS_HOST:-https://cds.miduo.org} bash scripts/smoke-cds-agent-one-cycle.sh"
        ;;
      blocked_r1)
        next_command="CDS_HOST=${CDS_HOST:-https://cds.miduo.org} SMOKE_CDS_AGENT_ANTHROPIC_API_KEY=<sk-ant-...> SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 bash scripts/smoke-cds-agent-one-cycle.sh"
        ;;
      ready_for_provider_smokes|blocked_provider_smokes|provider_smokes_incomplete)
        next_command="CDS_HOST=${CDS_HOST:-https://cds.miduo.org} SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 bash scripts/smoke-cds-agent-one-cycle.sh"
        ;;
      *)
        next_command="Inspect $SMOKE_CDS_AGENT_CYCLE_SUMMARY and pending gates"
        ;;
    esac
  elif [[ "$cycle_status" == "failed" ]]; then
    if [[ -n "$narrow_rerun_command" ]]; then
      next_command="$narrow_rerun_command"
    else
      next_command="Inspect $SMOKE_CDS_AGENT_CYCLE_SUMMARY and failed step logs under $SMOKE_CDS_AGENT_CYCLE_DIR"
    fi
  elif [[ "$commercial_complete" == "true" ]]; then
    next_command="No deploy needed. Re-run only if code/profile changes: CDS_HOST=${CDS_HOST:-https://cds.miduo.org} SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 bash scripts/smoke-cds-agent-one-cycle.sh"
  fi

  case "$cycle_status" in
    blocked_r1)
      deployment_advice="Do not redeploy for this state. The code/runtime plane is already reachable; create or select an Anthropic/Claude-compatible CDS-managed profile/secret and rerun one-cycle with provider calls enabled."
      ;;
    preview_not_ready)
      deployment_advice="Do not change code for this state. Wait for the CDS preview to become ready, then rerun one-cycle against the same branch."
      ;;
    ready_for_provider_smokes|blocked_provider_smokes|provider_smokes_incomplete)
      deployment_advice="Do not redeploy unless code changed. The next useful validation is provider-backed S1/S2/S3 with SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1."
      ;;
    provider_smokes_passed)
      deployment_advice="Provider gates passed. A deploy is only useful after a new code change or when promoting the validated branch."
      ;;
    failed)
      if [[ -n "$failure_advice" ]]; then
        deployment_advice="$failure_advice"
      else
        deployment_advice="Do not deploy to fix an unknown failure. Inspect the failed step log first, reproduce locally when the failed phase is local or static, then rerun the narrow smoke."
      fi
      ;;
    *)
      deployment_advice="Prefer local/static smokes first. Deploy only when validating remote runtime behavior, auth, container networking, or visual evidence."
      ;;
  esac

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
          --arg phase "${timing_phases[$i]}" \
          --argjson stepIndex "${timing_indices[$i]}" \
          --argjson stepTotal "${timing_totals[$i]}" \
          --argjson durationSeconds "${timing_seconds[$i]}" \
          '{
            key:$key,
            name:$name,
            status:$status,
            phase:$phase,
            stepIndex:$stepIndex,
            stepTotal:$stepTotal,
            durationSeconds:$durationSeconds
          }'
      done | jq -s .
    )
    slowest_json=$(jq -c 'sort_by(.durationSeconds) | reverse | .[:3]' <<< "$timing_json")
    total_seconds=$(jq -r '[.[].durationSeconds] | add // 0' <<< "$timing_json")
  fi

  jq -n \
    --arg cycleId "$CYCLE_ID" \
    --arg createdAt "$cycle_created_at" \
    --arg gitBranch "$git_branch" \
    --arg gitCommit "$git_commit" \
    --arg gitCommitShort "$git_commit_short" \
    --arg cycleStatus "$cycle_status" \
    --arg nextCommand "$next_command" \
    --arg blockingReason "$blocking_reason" \
    --arg deploymentAdvice "$deployment_advice" \
    --arg failureKind "$failure_kind" \
    --arg failureAdvice "$failure_advice" \
    --arg narrowRerunCommand "$narrow_rerun_command" \
    --arg providerPrerequisiteStatus "$provider_prerequisite_status" \
    --arg providerPrerequisiteAdvice "$provider_prerequisite_advice" \
    --arg remoteBranchObserved "$remote_branch_observed" \
    --arg remoteBranchId "$remote_branch_id" \
    --arg remoteBranchStatus "$remote_branch_status" \
    --arg remoteGithubCommit "$remote_github_commit" \
    --arg remoteRuntimeCommit "$remote_runtime_commit" \
    --arg remoteSubject "$remote_subject" \
    --arg remotePreviewSlug "$remote_preview_slug" \
    --arg remoteDeployCount "$remote_deploy_count" \
    --arg remoteLastDeployAt "$remote_last_deploy_at" \
    --arg remoteRuntimeRelation "$remote_runtime_relation" \
    --arg remoteDeployAdvice "$remote_deploy_advice" \
    --arg evidenceDir "$SMOKE_CDS_AGENT_CYCLE_DIR" \
    --arg host "$SMOKE_TEST_HOST" \
    --arg targetSource "$SMOKE_TARGET_SOURCE" \
    --arg readinessOverall "$readiness_overall" \
    --arg readinessReport "$SMOKE_CDS_AGENT_READINESS_REPORT" \
    --arg doctorDiagnosis "$doctor_diagnosis" \
    --arg doctorNext "$doctor_next" \
    --arg doctorAliasStatus "$doctor_alias_status" \
    --arg doctorReport "$SMOKE_CDS_AGENT_DOCTOR_REPORT" \
    --arg r1Status "$r1_status" \
    --arg r1Report "$SMOKE_CDS_AGENT_R1_REPORT" \
    --argjson r1Details "$r1_details_json" \
    --arg s1Status "$s1_status" \
    --arg s1Report "$SMOKE_CDS_AGENT_S1_REPORT" \
    --argjson s1Details "$s1_details_json" \
    --arg controlsStatus "$controls_status" \
    --arg controlsReport "$SMOKE_CDS_AGENT_CONTROLS_REPORT" \
    --argjson controlsDetails "$controls_details_json" \
    --arg boundaryStatus "$boundary_status" \
    --arg boundaryReport "$SMOKE_CDS_AGENT_BOUNDARY_REPORT" \
    --argjson boundaryMetrics "$boundary_metrics_json" \
    --argjson remoteBranchStatusRaw "$remote_branch_status_json" \
    --arg screenshot "${SMOKE_CDS_AGENT_SCREENSHOT:-}" \
    --arg textDump "${SMOKE_CDS_AGENT_TEXT_DUMP:-}" \
    --arg visualCoverage "${SMOKE_CDS_AGENT_VISUAL_COVERAGE:-}" \
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
    --argjson readinessNextCyclePlan "$readiness_next_cycle_plan" \
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
        evidence: "default runtime profile is Anthropic/Claude-compatible and has a CDS-managed provider secret"
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
        evidence: "non-code Toolbox agents remain independent from CDS sidecar runtime pool; codex/openai-agents-sdk/google-adk remain planned-not-routable until adapter contracts and provider smokes pass"
      }
    } as $gates |
    ($gates | to_entries | map(select(.value.status != "pass") | {
      gate: .key,
      status: .value.status,
      evidence: .value.evidence
    })) as $gatesNotPass |
    {
      cycleId: $cycleId,
      createdAt: $createdAt,
      git: {
        branch: $gitBranch,
        commit: $gitCommit,
        commitShort: $gitCommitShort
      },
      status: $cycleStatus,
      commercialComplete: $commercialComplete,
      blockingReason: $blockingReason,
      deploymentAdvice: $deploymentAdvice,
      failure: {
        kind: $failureKind,
        advice: $failureAdvice,
        narrowRerunCommand: $narrowRerunCommand
      },
      nextCommand: $nextCommand,
      host: $host,
      target: {
        host: $host,
        source: $targetSource
      },
      remoteCdsBranch: {
        observed: ($remoteBranchObserved == "true"),
        branchId: $remoteBranchId,
        status: $remoteBranchStatus,
        githubCommitSha: (if $remoteGithubCommit == "" then null else $remoteGithubCommit end),
        runtimeCommitSha: (if $remoteRuntimeCommit == "" then null else $remoteRuntimeCommit end),
        subject: (if $remoteSubject == "" then null else $remoteSubject end),
        previewSlug: (if $remotePreviewSlug == "" then null else $remotePreviewSlug end),
        deployCount: (if $remoteDeployCount == "" then null else ($remoteDeployCount | tonumber) end),
        lastDeployAt: (if $remoteLastDeployAt == "" then null else $remoteLastDeployAt end),
        runtimeRelation: $remoteRuntimeRelation,
        deployAdvice: $remoteDeployAdvice,
        raw: $remoteBranchStatusRaw
      },
      evidenceDir: $evidenceDir,
      exitCode: $exitCode,
      providerCallsEnabled: $providerCallsEnabled,
      r1RepairApply: $r1RepairApply,
      providerPrerequisites: {
        status: $providerPrerequisiteStatus,
        advice: $providerPrerequisiteAdvice,
        providerCallsRequested: $providerCallsEnabled,
        r1RepairKeyProvided: $r1RepairApply,
        canAttemptR1Repair: $r1RepairApply,
        canCollectProviderSmokes: ($providerCallsEnabled and ($gateR1 == "pass"))
      },
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
        report: $r1Report,
        details: $r1Details
      },
      providerReadiness: {
        status: $gateR1,
        reportStatus: $r1Status,
        defaultProfile: ($r1Details.defaultProfile // null),
        compatibilityReasonCode: ($r1Details.defaultProfile.compatibilityReasonCode // null),
        compatibilityReason: ($r1Details.defaultProfile.compatibilityReason // $r1Details.defaultProfile.warning // null),
        compatibilityNextActions: ($r1Details.defaultProfile.compatibilityNextActions // []),
        targetTemplate: ($r1Details.targetTemplate // null),
        targetTemplateId: ($r1Details.targetTemplateId // "")
      },
      s1: {
        status: $s1Status,
        report: $s1Report,
        details: $s1Details
      },
      controls: {
        status: $controlsStatus,
        report: $controlsReport,
        details: $controlsDetails
      },
      officialSdkBoundary: {
        status: $boundaryStatus,
        report: $boundaryReport,
        metrics: $boundaryMetrics
      },
      visual: {
        screenshot: $screenshot,
        textDump: (if $textDump == "" then null else $textDump end),
        coverage: (if $visualCoverage == "" then null else $visualCoverage end)
      },
      commercialGates: $gates,
      commercialGatesNotPass: $gatesNotPass,
      executionPanel: {
        status: $cycleStatus,
        commercialComplete: $commercialComplete,
        blockingReason: $blockingReason,
        deploymentAdvice: $deploymentAdvice,
        nextCommand: $nextCommand,
        failureKind: $failureKind,
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
        officialSdkBoundary: $boundaryMetrics,
        gatesNotPass: $gatesNotPass
      },
      backendExecutionPanel: $readinessExecutionPanel,
      nextCyclePlan: $readinessNextCyclePlan,
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

  if [[ -x "$SCRIPT_DIR/index-cds-agent-cycle-evidence.sh" || -f "$SCRIPT_DIR/index-cds-agent-cycle-evidence.sh" ]]; then
    bash "$SCRIPT_DIR/index-cds-agent-cycle-evidence.sh" "$SMOKE_CDS_AGENT_CYCLE_SUMMARY" >/dev/null 2>&1 || true
  fi

  printf '\n##########################################\n'
  printf '# CDS Agent one-cycle summary\n'
  printf '##########################################\n'
  printf 'Evidence dir: %s\n' "$SMOKE_CDS_AGENT_CYCLE_DIR"
  printf 'Cycle status: %s\n' "$cycle_status"
  printf 'Commercial complete: %s\n' "$commercial_complete"
  printf 'Provider prerequisites: %s · %s\n' "$provider_prerequisite_status" "$provider_prerequisite_advice"
  if [[ -n "$blocking_reason" ]]; then
    printf 'Blocking reason: %s\n' "$blocking_reason"
  fi
  printf 'Deploy/build advice: %s\n' "$deployment_advice"
  if [[ "$remote_branch_observed" == "true" ]]; then
    printf 'Remote CDS branch: %s status=%s github=%s runtime=%s deployCount=%s lastDeployAt=%s\n' \
      "$remote_branch_id" \
      "${remote_branch_status:-unknown}" \
      "${remote_github_commit:-unknown}" \
      "${remote_runtime_commit:-unknown}" \
      "${remote_deploy_count:-unknown}" \
      "${remote_last_deploy_at:-unknown}"
    printf 'Remote runtime relation: %s\n' "$remote_runtime_relation"
    printf 'Remote deploy advice: %s\n' "$remote_deploy_advice"
  else
    printf 'Remote CDS branch: not observed (%s)\n' "$remote_deploy_advice"
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
  if [[ "$boundary_metrics_json" != "null" ]]; then
    jq -r '"Official SDK bridge budget: adapter=" + (.officialAdapterLines|tostring) + "/" + (.officialAdapterMaxLines|tostring) + " support=" + (.bridgeSupportLines|tostring) + "/" + (.bridgeSupportMaxLines|tostring) + " total=" + (.bridgeTotalLines|tostring) + "/" + (.bridgeTotalMaxLines|tostring)' <<< "$boundary_metrics_json"
  fi
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
  if [[ -f "$SMOKE_CDS_AGENT_CYCLE_DIR/evidence-index.md" ]]; then
    printf 'Evidence index: %s\n' "$SMOKE_CDS_AGENT_CYCLE_DIR/evidence-index.md"
  fi
  printf 'Total measured step time: %ss\n' "$total_seconds"
  if (( ${#timing_keys[@]} > 0 )); then
    printf 'Slowest steps:\n'
    jq -r '.[] | "  - [" + .phase + "] " + .name + " · " + (.durationSeconds|tostring) + "s · " + .status' <<< "$slowest_json"
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
  if [[ "$commercial_complete" == "true" ]]; then
    printf 'Commercial gate summary: complete for the current hardened read-only CDS Agent path.\n'
  else
    printf 'The goal is not commercially complete until R1 is pass and S1/S2/S3 provider smokes run with SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1.\n'
  fi
  exit "$exit_code"
}

printf '##########################################\n'
printf '# CDS Agent one-cycle commercial smoke\n'
printf '##########################################\n'
printf 'Evidence dir: %s\n' "$SMOKE_CDS_AGENT_CYCLE_DIR"
printf 'Host: %s\n' "$SMOKE_TEST_HOST"
printf 'Provider calls: %s\n' "${SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL:-0}"
printf 'R1 repair apply: %s\n' "$([[ -n "${SMOKE_CDS_AGENT_ANTHROPIC_API_KEY:-}" ]] && printf yes || printf no)"
printf 'Step panel: total=%s, phases=local-static/remote-api/remote-container/provider-gated/visual\n' "$SMOKE_STEP_TOTAL"

run_step "doctor" "Runtime doctor and next action report" "$SCRIPT_DIR/doctor-cds-agent-runtime.sh" "remote-api" || finish_cycle 1

run_step "r0-runtime" "R0 runtime pool official SDK ownership" "$SCRIPT_DIR/smoke-cds-agent-runtime-status.sh" "remote-api" || finish_cycle 1
if [[ -n "${CDS_HOST:-}" ]]; then
  sidecar_alias="${SMOKE_CDS_AGENT_SIDECAR_ALIAS:-claude-agent-sdk-runtime-v2-prd-agent}"
  if [[ "$sidecar_alias" =~ (^|[-_])claude-agent-sdk-runtime ]] \
    && [[ "${SMOKE_CDS_AGENT_ALLOW_BRANCH_LOCAL_ALIAS_PROBE:-0}" != "1" ]]; then
    skip_step "R0 sidecar alias stability from API container" "branch-local sidecar alias is legacy contamination diagnostics only; R0 now uses CDS-managed runtime capacity evidence" "remote-container"
  else
    run_step "r0-sidecar-alias" "R0 sidecar alias stability from API container" "$SCRIPT_DIR/smoke-cds-agent-sidecar-alias-stability.sh" "remote-container" || finish_cycle 1
  fi
else
  skip_step "R0 sidecar alias stability from API container" "set CDS_HOST to exec inside the remote CDS API container" "remote-container"
fi
run_step "t1-templates" "T1 official templates and adapter matrix" "$SCRIPT_DIR/smoke-cds-agent-profile-templates.sh" "remote-api" || finish_cycle 1
run_step "a0-official-sdk-boundary" "A0 official SDK adapter boundary" "$SCRIPT_DIR/smoke-cds-agent-official-sdk-boundary.sh" "local-static" || finish_cycle 1
run_step "r1-repair" "R1 profile repair dry-run or test-before-promote" "$SCRIPT_DIR/smoke-cds-agent-r1-profile-repair.sh" "remote-api" || finish_cycle 1
run_step "readiness" "Commercial readiness ledger" "$SCRIPT_DIR/smoke-cds-agent-commercial-readiness.sh" "remote-api" || finish_cycle 1

r1_report_status="missing"
if [[ -f "$SMOKE_CDS_AGENT_R1_REPORT" ]]; then
  r1_report_status=$(jq -r '.status // "unknown"' "$SMOKE_CDS_AGENT_R1_REPORT")
fi
if [[ "${SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL:-0}" != "1" ]]; then
  skip_step "S1 official SDK run evidence" "provider calls are disabled; set SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 after R1 passes" "provider-gated"
  skip_step "S2/S3 approval and stop controls" "provider calls are disabled; set SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 after R1 passes" "provider-gated"
elif [[ "$r1_report_status" == "dry_run_requires_api_key" || "$r1_report_status" == "invalid_anthropic_key_format" ]]; then
  skip_step "S1 official SDK run evidence" "blocked until R1 Anthropic/Claude-compatible profile has a CDS-managed provider secret and is promoted" "provider-gated"
  skip_step "S2/S3 approval and stop controls" "blocked until R1 Anthropic/Claude-compatible profile has a CDS-managed provider secret and is promoted" "provider-gated"
else
  run_step "s1-official-sdk-run" "S1 official SDK run evidence" "$SCRIPT_DIR/smoke-cds-agent-official-sdk-run.sh" "provider-gated" || finish_cycle 1
  run_step "s2-s3-controls" "S2/S3 approval and stop controls" "$SCRIPT_DIR/smoke-cds-agent-official-sdk-controls.sh" "provider-gated" || finish_cycle 1
fi

if [[ -n "${SMOKE_CDS_AGENT_ACCESS_TOKEN:-}" \
  || ( -n "${SMOKE_CDS_AGENT_LOGIN_USERNAME:-}" && -n "${SMOKE_CDS_AGENT_LOGIN_PASSWORD:-}" ) \
  || -n "${AI_ACCESS_KEY:-}" ]]; then
  export SMOKE_CDS_AGENT_SCREENSHOT="${SMOKE_CDS_AGENT_SCREENSHOT:-$SMOKE_CDS_AGENT_CYCLE_DIR/workbench-visual.png}"
  export SMOKE_CDS_AGENT_TEXT_DUMP="${SMOKE_CDS_AGENT_TEXT_DUMP:-$SMOKE_CDS_AGENT_CYCLE_DIR/workbench-visual.txt}"
  export SMOKE_CDS_AGENT_VISUAL_COVERAGE="${SMOKE_CDS_AGENT_VISUAL_COVERAGE:-$SMOKE_CDS_AGENT_CYCLE_DIR/workbench-visual.coverage.json}"
  run_step "v1-visual" "V1 authenticated workbench visual" "$SCRIPT_DIR/smoke-cds-agent-workbench-visual.sh" "visual" || finish_cycle 1
else
  skip_step "V1 authenticated workbench visual" "set SMOKE_CDS_AGENT_ACCESS_TOKEN, login username/password, or AI_ACCESS_KEY" "visual"
fi

run_step "n6-non-code-boundary" "N6 non-code agent compatibility boundary" "$SCRIPT_DIR/smoke-cds-agent-non-code-compatibility.sh" "local-static" || finish_cycle 1

finish_cycle 0
