#!/usr/bin/env bash
# 只读证据采集: CDS Agent runtime pool recovery
#
# 输出一个目录，包含:
#   - recovery plan
#   - shared-service pool audit
#   - optional goal audit
#   - summary.json / evidence-index.md
#
# 不删除、不重启、不部署。远程检查只在 CDS_HOST 存在时执行。

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${CDS_AGENT_RUNTIME_POOL_EVIDENCE_DIR:-/tmp/cds-agent-runtime-pool-evidence-$(date +%Y%m%d%H%M%S)}"
RUN_GOAL_AUDIT="${CDS_AGENT_RUNTIME_POOL_RUN_GOAL_AUDIT:-1}"
GOAL_AUDIT_TIMEOUT="${CDS_AGENT_RUNTIME_POOL_GOAL_AUDIT_TIMEOUT:-25}"

mkdir -p "$OUT_DIR"

step_names=""
step_statuses=""
step_seconds=""
step_logs=""

append_json_string() {
  local current="$1"
  local value="$2"
  local encoded
  encoded=$(printf '%s' "$value" | jq -R .)
  if [[ -z "$current" ]]; then
    printf '%s' "$encoded"
  else
    printf '%s,%s' "$current" "$encoded"
  fi
}

append_json_number() {
  local current="$1"
  local value="$2"
  if [[ -z "$current" ]]; then
    printf '%s' "$value"
  else
    printf '%s,%s' "$current" "$value"
  fi
}

run_capture() {
  local name="$1"
  local log="$2"
  shift 2
  local started ended duration rc status
  started=$(date +%s)
  printf '>>> %s\n' "$name"
  "$@" >"$log" 2>&1
  rc=$?
  ended=$(date +%s)
  duration=$((ended - started))
  if (( rc == 0 )); then
    status="pass"
  else
    status="blocked"
  fi
  printf '%s %s (%ss) log=%s\n' "$status" "$name" "$duration" "$log"
  step_names=$(append_json_string "$step_names" "$name")
  step_statuses=$(append_json_string "$step_statuses" "$status")
  step_seconds=$(append_json_number "$step_seconds" "$duration")
  step_logs=$(append_json_string "$step_logs" "$log")
  return 0
}

plan_log="$OUT_DIR/runtime-pool-recovery-plan.log"
shared_pool_log="$OUT_DIR/shared-service-pool-audit.log"
goal_audit_log="$OUT_DIR/goal-audit.log"
goal_audit_report="$OUT_DIR/goal-audit.json"

if [[ -n "${CDS_HOST:-}" ]]; then
  run_capture "runtime pool recovery plan" "$plan_log" \
    bash "$ROOT_DIR/scripts/plan-cds-agent-runtime-pool-recovery.sh"
  run_capture "shared-service pool audit" "$shared_pool_log" \
    env SMOKE_CDS_AGENT_SHARED_POOL_REMOTE=1 bash "$ROOT_DIR/scripts/smoke-cds-agent-shared-service-pool.sh"
else
  run_capture "shared-service pool local guard" "$shared_pool_log" \
    bash "$ROOT_DIR/scripts/smoke-cds-agent-shared-service-pool.sh"
fi

if [[ "$RUN_GOAL_AUDIT" == "1" ]]; then
  run_capture "goal completion audit" "$goal_audit_log" \
    env CDS_AGENT_GOAL_AUDIT_STEP_TIMEOUT_SECONDS="$GOAL_AUDIT_TIMEOUT" \
        CDS_AGENT_GOAL_AUDIT_REPORT="$goal_audit_report" \
        bash "$ROOT_DIR/scripts/audit-cds-agent-goal.sh"
fi

plan_json='null'
if [[ -s "$plan_log" ]]; then
  plan_json=$(sed -n '/^{/,$p' "$plan_log" | jq -c . 2>/dev/null || printf 'null')
fi

goal_json='null'
if [[ -s "$goal_audit_report" ]]; then
  goal_json=$(jq -c . "$goal_audit_report" 2>/dev/null || printf 'null')
fi

summary="$OUT_DIR/summary.json"
jq -n \
  --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg outDir "$OUT_DIR" \
  --arg cdsHost "${CDS_HOST:-}" \
  --argjson names "[$step_names]" \
  --argjson statuses "[$step_statuses]" \
  --argjson seconds "[$step_seconds]" \
  --argjson logs "[$step_logs]" \
  --argjson plan "$plan_json" \
  --argjson goal "$goal_json" \
  '{
    createdAt: $createdAt,
    outDir: $outDir,
    cdsHost: (if $cdsHost == "" then null else $cdsHost end),
    steps: [range(0; ($names | length)) | {
      name: $names[.],
      status: $statuses[.],
      durationSeconds: $seconds[.],
      log: $logs[.]
    }],
    totalSeconds: ($seconds | add // 0),
    plan: $plan,
    goalStatus: ($goal.goalStatus // null),
    runtimePoolBlockers: (
      $goal.runtimePoolRecovery.blockers //
      [
        (if ($plan.contaminatedBranchCount // 0) > 0 then {requirement:"BRANCH_LOCAL_SIDECAR_CLEAN", status:("contaminated:" + (($plan.contaminatedBranchCount // 0)|tostring))} else empty end),
        (if ((($plan.enabledRemoteHostCount // "unknown") | tostring | test("^[0-9]+$")) and (($plan.enabledRemoteHostCount | tonumber) <= 0)) then {requirement:"REMOTE_HOST_AVAILABLE", status:"missing"} else empty end),
        (if ($plan.sharedRunning // 0) <= 0 then {requirement:"SHARED_POOL_RUNNING", status:"missing"} else empty end)
      ]
    )
  } | .missingOrUnproved = ($goal.missingOrUnproved // .runtimePoolBlockers)' > "$summary"

index="$OUT_DIR/evidence-index.md"
{
  printf '# CDS Agent Runtime Pool Evidence\n\n'
  printf '%s\n' "- createdAt: \`$(jq -r '.createdAt' "$summary")\`"
  printf '%s\n' "- totalSeconds: \`$(jq -r '.totalSeconds' "$summary")\`"
  printf '%s\n' "- goalStatus: \`$(jq -r '.goalStatus // "not-run"' "$summary")\`"
  printf '%s\n\n' "- summary: \`$summary\`"
  printf '## Steps\n\n'
  jq -r '.steps[] | "- `" + .status + "` " + .name + " · " + (.durationSeconds|tostring) + "s · `" + .log + "`"' "$summary"
  printf '\n## Runtime Pool Blockers\n\n'
  if [[ "$(jq -r '.runtimePoolBlockers | length' "$summary")" == "0" ]]; then
    printf '%s\n' '- none'
  else
    jq -r '.runtimePoolBlockers[] | "- `" + .requirement + "` · " + .status' "$summary"
  fi
  printf '\n## Missing Or Unproved\n\n'
  if [[ "$(jq -r '.missingOrUnproved | length' "$summary")" == "0" ]]; then
    printf '%s\n' '- none'
  else
    jq -r '.missingOrUnproved[] | "- `" + .requirement + "` · " + .status' "$summary"
  fi
} > "$index"

printf '\nEvidence dir: %s\n' "$OUT_DIR"
printf 'Summary:      %s\n' "$summary"
printf 'Index:        %s\n' "$index"
jq '{goalStatus, totalSeconds, runtimePoolBlockers, missingOrUnproved}' "$summary"
