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
#   CDS_AGENT_GOAL_AUDIT_STEP_TIMEOUT_SECONDS=90
#   CDS_AGENT_GOAL_AUDIT_HEARTBEAT_SECONDS=15
#   CDS_AGENT_GOAL_CYCLE_MAX_AGE_SECONDS=86400
# ============================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPORT="${CDS_AGENT_GOAL_AUDIT_REPORT:-}"
AUDIT_DIR="${CDS_AGENT_GOAL_AUDIT_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/cds-agent-goal-audit.XXXXXX")}"
BOUNDARY_REPORT="$AUDIT_DIR/a0-boundary.json"
N6_LOG="$AUDIT_DIR/n6-non-code-compatibility.log"
cycle_summary="${CDS_AGENT_GOAL_CYCLE_SUMMARY:-}"
current_git_branch="$(git -C "$ROOT_DIR" branch --show-current 2>/dev/null || printf '')"
current_git_commit="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || printf '')"
current_git_commit_short="$(git -C "$ROOT_DIR" rev-parse --short=10 HEAD 2>/dev/null || printf '')"

failures=()
timing_names=()
timing_statuses=()
timing_seconds=()
timing_indices=()
CYCLE_GIT_DIFF_PATHS=()
CYCLE_GIT_RUNTIME_DIFF_PATHS=()
TIMING_STEP_TOTAL=2
TIMING_STEP_CURRENT=0
AUDIT_HEARTBEAT_SECONDS="${CDS_AGENT_GOAL_AUDIT_HEARTBEAT_SECONDS:-15}"
AUDIT_STEP_TIMEOUT_SECONDS="${CDS_AGENT_GOAL_AUDIT_STEP_TIMEOUT_SECONDS:-90}"
CYCLE_MAX_AGE_SECONDS="${CDS_AGENT_GOAL_CYCLE_MAX_AGE_SECONDS:-86400}"

run_step() {
  local label="$1"
  shift
  local started ended duration
  TIMING_STEP_CURRENT=$((TIMING_STEP_CURRENT + 1))
  started=$(date +%s)
  printf '>>> [%s/%s] %s\n' "$TIMING_STEP_CURRENT" "$TIMING_STEP_TOTAL" "$label"
  if "$@"; then
    ended=$(date +%s)
    duration=$((ended - started))
    printf 'PASS %s (%ss)\n' "$label" "$duration"
    timing_names+=("$label")
    timing_statuses+=("pass")
    timing_seconds+=("$duration")
    timing_indices+=("$TIMING_STEP_CURRENT")
    return 0
  fi
  ended=$(date +%s)
  duration=$((ended - started))
  printf 'FAIL %s (%ss)\n' "$label" "$duration" >&2
  timing_names+=("$label")
  timing_statuses+=("failed")
  timing_seconds+=("$duration")
  timing_indices+=("$TIMING_STEP_CURRENT")
  failures+=("$label")
  return 1
}

run_step_logged() {
  local label="$1"
  local log="$2"
  shift 2
  local started ended duration pid rc last_heartbeat elapsed timed_out
  TIMING_STEP_CURRENT=$((TIMING_STEP_CURRENT + 1))
  started=$(date +%s)
  last_heartbeat="$started"
  timed_out=false
  printf '>>> [%s/%s] %s\n' "$TIMING_STEP_CURRENT" "$TIMING_STEP_TOTAL" "$label"
  printf '    log: %s\n' "$log"
  "$@" >"$log" 2>&1 &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    sleep 1
    elapsed=$(( $(date +%s) - started ))
    if (( AUDIT_STEP_TIMEOUT_SECONDS > 0 && elapsed >= AUDIT_STEP_TIMEOUT_SECONDS )); then
      timed_out=true
      {
        printf '\nCDS_AGENT_GOAL_AUDIT_TIMEOUT: %s exceeded %ss\n' "$label" "$AUDIT_STEP_TIMEOUT_SECONDS"
        printf 'The audit step was stopped to keep goal verification bounded and observable.\n'
      } >>"$log"
      pkill -TERM -P "$pid" 2>/dev/null || true
      kill -TERM "$pid" 2>/dev/null || true
      sleep 2
      pkill -KILL -P "$pid" 2>/dev/null || true
      kill -KILL "$pid" 2>/dev/null || true
      break
    fi
    if kill -0 "$pid" 2>/dev/null && (( $(date +%s) - last_heartbeat >= AUDIT_HEARTBEAT_SECONDS )); then
      last_heartbeat=$(date +%s)
      printf '    still running · elapsed=%ss · log=%s\n' "$elapsed" "$log"
      tail -n 3 "$log" 2>/dev/null || true
    fi
  done
  set +e
  wait "$pid"
  rc=$?
  set -e
  if [[ "$timed_out" == "true" ]]; then
    rc=124
  fi
  ended=$(date +%s)
  duration=$((ended - started))
  if (( rc == 0 )); then
    printf 'PASS %s (%ss)\n' "$label" "$duration"
    timing_names+=("$label")
    timing_statuses+=("pass")
    timing_seconds+=("$duration")
    timing_indices+=("$TIMING_STEP_CURRENT")
    return 0
  fi
  printf 'FAIL %s (exit=%s, %ss)\n' "$label" "$rc" "$duration" >&2
  tail -n 40 "$log" >&2 || true
  timing_names+=("$label")
  timing_statuses+=("failed")
  timing_seconds+=("$duration")
  timing_indices+=("$TIMING_STEP_CURRENT")
  failures+=("$label")
  return 1
}

find_latest_cycle_summary() {
  local latest search_roots
  search_roots=$(printf '%s\n/tmp\n/private/tmp\n' "${TMPDIR:-/tmp}" | awk '!seen[$0]++')
  latest=$(while IFS= read -r root; do
    [[ -d "$root" ]] || continue
    find "$root" -maxdepth 2 -path '*/cds-agent-cycle-*/cycle-summary.json' -type f -print 2>/dev/null | while IFS= read -r file; do
      printf '%s\t%s\n' "$(file_mtime "$file")" "$file"
    done || true
  done <<< "$search_roots" | sort -n | tail -n 1 | cut -f2- || true)
  [[ -n "$latest" ]] && printf '%s' "$latest"
  return 0
}

file_mtime() {
  stat -f '%m' "$1" 2>/dev/null || stat -c '%Y' "$1" 2>/dev/null || printf '0'
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

classify_cycle_git_drift() {
  local base_commit="$1"
  local head_commit="$2"
  local diff_output path has_paths=false has_runtime=false
  CYCLE_GIT_DIFF_PATHS=()
  CYCLE_GIT_RUNTIME_DIFF_PATHS=()
  if [[ -z "$base_commit" || -z "$head_commit" ]]; then
    return 1
  fi
  if ! diff_output=$(git -C "$ROOT_DIR" diff --name-only "${base_commit}..${head_commit}" 2>/dev/null); then
    return 1
  fi
  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    has_paths=true
    CYCLE_GIT_DIFF_PATHS+=("$path")
    if ! is_non_runtime_cycle_drift_path "$path"; then
      has_runtime=true
      CYCLE_GIT_RUNTIME_DIFF_PATHS+=("$path")
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
run_step_logged "N6 non-code and candidate SDK compatibility" "$N6_LOG" bash "$SCRIPT_DIR/smoke-cds-agent-non-code-compatibility.sh" || true

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
if [[ -s "$N6_LOG" ]] && grep -Eq 'CDS_AGENT_GOAL_AUDIT_TIMEOUT|MSB1025|System\.Net\.Sockets\.SocketException|Permission denied|NamedPipeServerStream' "$N6_LOG"; then
  n6_status="infra_failed"
elif (( ${#failures[@]} > 0 )) && printf '%s\n' "${failures[@]}" | grep -qx "N6 non-code and candidate SDK compatibility"; then
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
cycle_age_seconds=0
cycle_freshness_status="missing"
cycle_git_branch=""
cycle_git_commit=""
cycle_git_commit_short=""
cycle_git_status="missing"
cycle_git_diff_json='[]'
cycle_git_runtime_diff_json='[]'
r1_report=""
r1_status="missing"
r1_details_json='null'
s1_report=""
s1_status="missing"
s1_details_json='null'
controls_report=""
controls_status="missing"
controls_details_json='null'
if [[ -f "$cycle_summary" ]]; then
  now_epoch=$(date +%s)
  cycle_mtime=$(file_mtime "$cycle_summary")
  cycle_age_seconds=$((now_epoch - cycle_mtime))
  if (( CYCLE_MAX_AGE_SECONDS > 0 && cycle_age_seconds > CYCLE_MAX_AGE_SECONDS )); then
    cycle_freshness_status="stale"
  else
    cycle_freshness_status="fresh"
  fi
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
  cycle_git_branch=$(jq -r '.git.branch // ""' "$cycle_summary")
  cycle_git_commit=$(jq -r '.git.commit // ""' "$cycle_summary")
  cycle_git_commit_short=$(jq -r '.git.commitShort // ""' "$cycle_summary")
  if [[ -z "$cycle_git_commit" ]]; then
    cycle_git_status="unknown"
  elif [[ -n "$current_git_commit" && "$cycle_git_commit" == "$current_git_commit" ]]; then
    cycle_git_status="match"
  elif classify_cycle_git_drift "$cycle_git_commit" "$current_git_commit"; then
    cycle_git_status="compatible_non_runtime_drift"
  else
    drift_rc=$?
    if (( drift_rc == 2 )); then
      cycle_git_status="runtime_mismatch"
    else
      cycle_git_status="mismatch"
    fi
  fi
  if (( ${#CYCLE_GIT_DIFF_PATHS[@]} > 0 )); then
    cycle_git_diff_json=$(printf '%s\n' "${CYCLE_GIT_DIFF_PATHS[@]}" | jq -R . | jq -s .)
  fi
  if (( ${#CYCLE_GIT_RUNTIME_DIFF_PATHS[@]} > 0 )); then
    cycle_git_runtime_diff_json=$(printf '%s\n' "${CYCLE_GIT_RUNTIME_DIFF_PATHS[@]}" | jq -R . | jq -s .)
  fi
  r1_report=$(jq -r '.r1.report // ""' "$cycle_summary")
  s1_report=$(jq -r '.s1.report // ""' "$cycle_summary")
  controls_report=$(jq -r '.controls.report // ""' "$cycle_summary")
fi

if [[ "$boundary_status" == "pass" ]]; then
  gate_a0="pass"
fi
if [[ "$n6_status" == "pass" ]]; then
  gate_n6="pass"
elif [[ "$n6_status" != "missing" ]]; then
  gate_n6="$n6_status"
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
if [[ -n "$s1_report" && -f "$s1_report" ]]; then
  s1_status=$(jq -r '.status // "unknown"' "$s1_report")
  s1_details_json=$(jq -c '{
    status: (.status // "unknown"),
    host: (.host // ""),
    target: (.target // null),
    sessionId: (.sessionId // ""),
    traceId: (.traceId // ""),
    defaultProfile: (.evidence.defaultProfile // null)
  }' "$s1_report")
fi
if [[ -n "$controls_report" && -f "$controls_report" ]]; then
  controls_status=$(jq -r '.status // "unknown"' "$controls_report")
  controls_details_json=$(jq -c '{
    status: (.status // "unknown"),
    host: (.host // ""),
    target: (.target // null),
    defaultProfile: (.evidence.defaultProfile // null)
  }' "$controls_report")
fi

if [[ "$boundary_status" != "pass" ]]; then
  failures+=("A0 boundary did not pass")
fi
if [[ "$n6_status" != "pass" ]]; then
  if [[ "$n6_status" == "infra_failed" ]]; then
    failures+=("N6 guardrail infra failed or timed out; rerun outside sandbox or with dotnet permissions")
  else
    failures+=("N6 compatibility did not pass")
  fi
fi
if [[ "$cycle_freshness_status" == "stale" ]]; then
  failures+=("one-cycle summary is stale; rerun scripts/smoke-cds-agent-one-cycle.sh for current remote/provider evidence")
fi
if [[ "$cycle_git_status" == "runtime_mismatch" || "$cycle_git_status" == "mismatch" ]]; then
  failures+=("one-cycle summary git commit does not match current HEAD; rerun scripts/smoke-cds-agent-one-cycle.sh for this commit")
fi

goal_status="not_complete"
if [[ "$(json_bool "$commercial_complete")" == "true" \
  && "$cycle_freshness_status" == "fresh" \
  && ( "$cycle_git_status" == "match" || "$cycle_git_status" == "compatible_non_runtime_drift" ) \
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
    --arg cycleFreshness "$cycle_freshness_status" \
    --arg cycleGitStatus "$cycle_git_status" \
    '{
      gates: {
        R0: $gateR0,
        A0: $gateA0,
        R1: $gateR1,
        S1: $gateS1,
        S2S3: $gateS2S3,
        V1: $gateV1,
        N6: $gateN6
      },
      cycleFreshness: $cycleFreshness,
      cycleGitStatus: $cycleGitStatus
    } as $root
    | ($root.gates | to_entries | map(select(.value != "pass") | {
      requirement: .key,
      status: .value
    }))
    + (if $root.cycleFreshness == "stale" then [{requirement:"CYCLE_FRESHNESS", status:"stale"}] else [] end)
    + (if ($root.cycleGitStatus == "mismatch" or $root.cycleGitStatus == "runtime_mismatch") then [{requirement:"CYCLE_GIT_MATCH", status:$root.cycleGitStatus}] else [] end)'
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
        --argjson stepIndex "${timing_indices[$i]}" \
        --argjson stepTotal "$TIMING_STEP_TOTAL" \
        --argjson durationSeconds "${timing_seconds[$i]}" \
        '{name:$name,status:$status,stepIndex:$stepIndex,stepTotal:$stepTotal,durationSeconds:$durationSeconds}'
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
    --arg s1Report "$s1_report" \
    --arg controlsReport "$controls_report" \
    --arg cycleStatus "$cycle_status" \
    --arg cycleFreshnessStatus "$cycle_freshness_status" \
    --arg cycleGitBranch "$cycle_git_branch" \
    --arg cycleGitCommit "$cycle_git_commit" \
    --arg cycleGitCommitShort "$cycle_git_commit_short" \
    --arg cycleGitStatus "$cycle_git_status" \
    --arg currentGitBranch "$current_git_branch" \
    --arg currentGitCommit "$current_git_commit" \
    --arg currentGitCommitShort "$current_git_commit_short" \
    --arg currentBlockingGate "$current_blocking_gate" \
    --arg blockingReason "$blocking_reason" \
    --arg deploymentAdvice "$deployment_advice" \
    --arg nextCommand "$next_command" \
    --arg boundaryStatus "$boundary_status" \
    --arg n6Status "$n6_status" \
    --arg r1Status "$r1_status" \
    --arg s1Status "$s1_status" \
    --arg controlsStatus "$controls_status" \
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
    --argjson cycleAgeSeconds "$cycle_age_seconds" \
    --argjson cycleMaxAgeSeconds "$CYCLE_MAX_AGE_SECONDS" \
    --argjson cycleGitDiffPaths "$cycle_git_diff_json" \
    --argjson cycleGitRuntimeDiffPaths "$cycle_git_runtime_diff_json" \
    --argjson cycleSlowest "$cycle_slowest" \
    --argjson localTiming "$timing_json" \
    --argjson localSlowest "$timing_slowest_json" \
    --argjson localTotalSeconds "$timing_total_seconds" \
    --argjson r1Details "$r1_details_json" \
    --argjson s1Details "$s1_details_json" \
    --argjson controlsDetails "$controls_details_json" \
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
        r1Report: (if $r1Report == "" then null else $r1Report end),
        s1Report: (if $s1Report == "" then null else $s1Report end),
        controlsReport: (if $controlsReport == "" then null else $controlsReport end)
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
          compatibilityReasonCode: ($r1Details.defaultProfile.compatibilityReasonCode // null),
          compatibilityReason: ($r1Details.defaultProfile.compatibilityReason // null),
          compatibilityNextActions: ($r1Details.defaultProfile.compatibilityNextActions // []),
          details: $r1Details
        },
        providerBackedRuns: {
          status: (if $gateS1 == "pass" and $gateS2S3 == "pass" then "proved" else "pending" end),
          gates: ["S1", "S2S3"],
          s1Status: $s1Status,
          controlsStatus: $controlsStatus,
          s1: $s1Details,
          controls: $controlsDetails
        },
        visualAndUsabilityEvidence: {
          status: (if $gateV1 == "pass" then "proved" else $gateV1 end),
          gate: "V1"
        },
      oneCycleObservability: {
          status: (if $cycleStatus == "missing" then "missing-cycle-summary" elif $cycleFreshnessStatus == "stale" then "stale-cycle-summary" else "available" end),
          cycleStatus: $cycleStatus,
          freshness: {
            status: $cycleFreshnessStatus,
            ageSeconds: $cycleAgeSeconds,
            maxAgeSeconds: $cycleMaxAgeSeconds
          },
          git: {
            branch: $cycleGitBranch,
            commit: $cycleGitCommit,
            commitShort: $cycleGitCommitShort,
            currentBranch: $currentGitBranch,
            currentCommit: $currentGitCommit,
            currentCommitShort: $currentGitCommitShort,
            status: $cycleGitStatus,
            diffPaths: $cycleGitDiffPaths,
            runtimeDiffPaths: $cycleGitRuntimeDiffPaths
          },
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
      cycleFreshness: {
        status: $cycleFreshnessStatus,
        ageSeconds: $cycleAgeSeconds,
        maxAgeSeconds: $cycleMaxAgeSeconds,
        gitBranch: $cycleGitBranch,
        gitCommitShort: $cycleGitCommitShort,
        currentGitBranch: $currentGitBranch,
        currentGitCommitShort: $currentGitCommitShort,
        gitStatus: $cycleGitStatus,
        diffPaths: $cycleGitDiffPaths,
        runtimeDiffPaths: $cycleGitRuntimeDiffPaths
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
printf 'Cycle freshness: %s age=%ss max=%ss git=%s@%s current=%s@%s match=%s\n' \
  "$cycle_freshness_status" "$cycle_age_seconds" "$CYCLE_MAX_AGE_SECONDS" \
  "${cycle_git_branch:-unknown}" "${cycle_git_commit_short:-unknown}" \
  "${current_git_branch:-unknown}" "${current_git_commit_short:-unknown}" "$cycle_git_status"
if [[ "$cycle_git_status" == "compatible_non_runtime_drift" ]]; then
  printf 'Cycle git drift: compatible non-runtime changes since summary:\n'
  printf '%s\n' "${CYCLE_GIT_DIFF_PATHS[@]}" | sed 's/^/  - /'
elif [[ "$cycle_git_status" == "runtime_mismatch" ]]; then
  printf 'Cycle git runtime drift:\n'
  printf '%s\n' "${CYCLE_GIT_RUNTIME_DIFF_PATHS[@]}" | sed 's/^/  - /'
fi
printf 'Current blocking gate: %s\n' "${current_blocking_gate:-unknown}"
printf 'Blocking reason: %s\n' "$blocking_reason"
if [[ "$r1_details_json" != "null" ]]; then
  printf 'R1 profile: %s / %s / %s compatible=%s hasKey=%s\n' \
    "$(jq -r '.defaultProfile.name // "unknown"' <<< "$r1_details_json")" \
    "$(jq -r '.defaultProfile.protocol // "unknown"' <<< "$r1_details_json")" \
    "$(jq -r '.defaultProfile.model // "unknown"' <<< "$r1_details_json")" \
    "$(jq -r 'if .defaultProfile | has("compatibleWithDesiredRuntimeAdapter") then (.defaultProfile.compatibleWithDesiredRuntimeAdapter | tostring) else "unknown" end' <<< "$r1_details_json")" \
    "$(jq -r 'if .defaultProfile | has("hasApiKey") then (.defaultProfile.hasApiKey | tostring) else "unknown" end' <<< "$r1_details_json")"
  r1_reason_code=$(jq -r '.defaultProfile.compatibilityReasonCode // ""' <<< "$r1_details_json")
  r1_reason=$(jq -r '.defaultProfile.compatibilityReason // .defaultProfile.warning // ""' <<< "$r1_details_json")
  if [[ -n "$r1_reason_code" || -n "$r1_reason" ]]; then
    printf 'R1 profile reason: %s%s%s\n' \
      "${r1_reason_code:-unknown}" \
      "$([[ -n "$r1_reason" ]] && printf ' · ' || true)" \
      "$r1_reason"
  fi
  printf 'R1 target: %s / %s / %s\n' \
    "$(jq -r '.targetTemplateId // "unknown"' <<< "$r1_details_json")" \
    "$(jq -r '.targetTemplate.protocol // "unknown"' <<< "$r1_details_json")" \
    "$(jq -r '.targetTemplate.model // "unknown"' <<< "$r1_details_json")"
fi
if [[ "$s1_details_json" != "null" || "$controls_details_json" != "null" ]]; then
  printf 'Provider smokes: S1=%s S2/S3=%s target=%s@%s\n' \
    "$s1_status" \
    "$controls_status" \
    "$(jq -r '(.target.repo // .target.gitRepository // "unknown")' <<< "$s1_details_json")" \
    "$(jq -r '(.target.ref // .target.gitRef // "unknown")' <<< "$s1_details_json")"
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
