#!/usr/bin/env bash
# 执行面封装: branch-local sidecar repair with pre/post evidence
#
# 默认 dry-run。只有显式设置 SMOKE_CDS_AGENT_BRANCH_ISOLATION_APPLY=1
# 才会调用删除 BuildProfile 的 repair 脚本。

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${CDS_AGENT_BRANCH_ISOLATION_REPAIR_DIR:-/tmp/cds-agent-branch-isolation-repair-$(date +%Y%m%d%H%M%S)}"
APPLY="${SMOKE_CDS_AGENT_BRANCH_ISOLATION_APPLY:-0}"

[[ -n "${CDS_HOST:-}" ]] || {
  printf '❌ 需要 CDS_HOST\n' >&2
  exit 1
}
command -v jq >/dev/null 2>&1 || {
  printf '❌ 缺少依赖: jq\n' >&2
  exit 1
}

mkdir -p "$OUT_DIR"

step_names=""
step_statuses=""
step_seconds=""
step_logs=""
step_exit_codes=""

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
  step_exit_codes=$(append_json_number "$step_exit_codes" "$rc")
  return 0
}

pre_dir="$OUT_DIR/pre"
post_dir="$OUT_DIR/post"
repair_log="$OUT_DIR/repair.log"
repair_report="$OUT_DIR/repair.json"
post_branch_smoke_log="$OUT_DIR/post-branch-isolation-smoke.log"

printf '==========================================\n'
printf 'CDS Agent Branch Isolation Repair Runner\n'
printf 'Apply: %s\n' "$APPLY"
printf 'Out:   %s\n' "$OUT_DIR"
printf '==========================================\n'

run_capture "pre runtime pool evidence" "$OUT_DIR/pre-evidence.log" \
  env CDS_AGENT_RUNTIME_POOL_EVIDENCE_DIR="$pre_dir" \
      CDS_AGENT_RUNTIME_POOL_RUN_GOAL_AUDIT=0 \
      bash "$ROOT_DIR/scripts/collect-cds-agent-runtime-pool-evidence.sh"

run_capture "branch isolation repair" "$repair_log" \
  env SMOKE_CDS_AGENT_BRANCH_ISOLATION_REPAIR_REPORT="$repair_report" \
      SMOKE_CDS_AGENT_BRANCH_ISOLATION_APPLY="$APPLY" \
      bash "$ROOT_DIR/scripts/repair-cds-agent-branch-isolation.sh"

if [[ "$APPLY" == "1" ]]; then
  run_capture "post branch isolation smoke" "$post_branch_smoke_log" \
    env SMOKE_CDS_AGENT_BRANCH_ISOLATION_REMOTE=1 \
        bash "$ROOT_DIR/scripts/smoke-cds-agent-branch-isolation.sh"
  run_capture "post runtime pool evidence" "$OUT_DIR/post-evidence.log" \
    env CDS_AGENT_RUNTIME_POOL_EVIDENCE_DIR="$post_dir" \
        CDS_AGENT_RUNTIME_POOL_RUN_GOAL_AUDIT=0 \
        bash "$ROOT_DIR/scripts/collect-cds-agent-runtime-pool-evidence.sh"
fi

repair_json='null'
[[ -s "$repair_report" ]] && repair_json=$(jq -c . "$repair_report" 2>/dev/null || printf 'null')
pre_summary='null'
[[ -s "$pre_dir/summary.json" ]] && pre_summary=$(jq -c . "$pre_dir/summary.json" 2>/dev/null || printf 'null')
post_summary='null'
[[ -s "$post_dir/summary.json" ]] && post_summary=$(jq -c . "$post_dir/summary.json" 2>/dev/null || printf 'null')

summary="$OUT_DIR/summary.json"
jq -n \
  --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg outDir "$OUT_DIR" \
  --arg apply "$APPLY" \
  --argjson names "[$step_names]" \
  --argjson statuses "[$step_statuses]" \
  --argjson seconds "[$step_seconds]" \
  --argjson logs "[$step_logs]" \
  --argjson exitCodes "[$step_exit_codes]" \
  --argjson repair "$repair_json" \
  --argjson pre "$pre_summary" \
  --argjson post "$post_summary" \
  '{
    createdAt: $createdAt,
    outDir: $outDir,
    apply: ($apply == "1"),
    steps: [range(0; ($names | length)) | {
      name: $names[.],
      status: $statuses[.],
      durationSeconds: $seconds[.],
      exitCode: $exitCodes[.],
      log: $logs[.]
    }],
    totalSeconds: ($seconds | add // 0),
    repair: $repair,
    pre: $pre,
    post: $post,
    beforeContaminatedBranchCount: ($pre.branchIsolationRepairDryRun.contaminatedBranchCount // $pre.plan.contaminatedBranchCount // null),
    afterContaminatedBranchCount: ($post.branchIsolationRepairDryRun.contaminatedBranchCount // $post.plan.contaminatedBranchCount // null)
  }
  | .branchIsolationClean = (
      if .apply then
        ((.afterContaminatedBranchCount // -1) == 0)
      else
        ((.beforeContaminatedBranchCount // -1) == 0)
      end
    )
  | .verdict = (
      if .apply and .branchIsolationClean then "applied-clean"
      elif .apply then "applied-not-clean"
      elif .branchIsolationClean then "dry-run-clean"
      else "dry-run-contaminated"
      end
    )
  | .readyForRemoteHostStep = (.verdict == "applied-clean" or .verdict == "dry-run-clean")
  | .nextAction = (
      if .verdict == "applied-clean" then
        "branch isolation clean; register an enabled remote host and deploy the shared official SDK runtime sidecar"
      elif .verdict == "dry-run-clean" then
        "branch isolation already clean; continue with remote host and shared runtime pool recovery"
      elif .verdict == "dry-run-contaminated" then
        "review candidateProfileIds, then rerun this wrapper with SMOKE_CDS_AGENT_BRANCH_ISOLATION_APPLY=1"
      else
        "apply ran but branch isolation is still contaminated; inspect post smoke/evidence before any redeploy"
      end
    )' > "$summary"

index="$OUT_DIR/evidence-index.md"
{
  printf '# CDS Agent Branch Isolation Repair Evidence\n\n'
  printf '%s\n' "- createdAt: \`$(jq -r '.createdAt' "$summary")\`"
  printf '%s\n' "- apply: \`$(jq -r '.apply' "$summary")\`"
  printf '%s\n' "- totalSeconds: \`$(jq -r '.totalSeconds' "$summary")\`"
  printf '%s\n' "- beforeContaminatedBranchCount: \`$(jq -r '.beforeContaminatedBranchCount // "unknown"' "$summary")\`"
  printf '%s\n' "- afterContaminatedBranchCount: \`$(jq -r '.afterContaminatedBranchCount // "not-run"' "$summary")\`"
  printf '%s\n' "- verdict: \`$(jq -r '.verdict' "$summary")\`"
  printf '%s\n' "- readyForRemoteHostStep: \`$(jq -r '.readyForRemoteHostStep' "$summary")\`"
  printf '%s\n' "- nextAction: $(jq -r '.nextAction' "$summary")"
  printf '%s\n\n' "- summary: \`$summary\`"
  printf '## Steps\n\n'
  jq -r '.steps[] | "- `" + .status + "` " + .name + " · rc=" + (.exitCode|tostring) + " · " + (.durationSeconds|tostring) + "s · `" + .log + "`"' "$summary"
  printf '\n## Repair\n\n'
  jq -r '"- status: `" + (.repair.status // "unknown") + "`",
    "- candidateProfileIds: `" + ((.repair.candidateProfileIds // []) | join(",")) + "`",
    "- deletedProfileIds: `" + ((.repair.deletedProfileIds // []) | join(",")) + "`"' "$summary"
} > "$index"

printf '\nEvidence dir: %s\n' "$OUT_DIR"
printf 'Summary:      %s\n' "$summary"
printf 'Index:        %s\n' "$index"
jq '{apply,totalSeconds,verdict,readyForRemoteHostStep,nextAction,beforeContaminatedBranchCount,afterContaminatedBranchCount,repair:{status:.repair.status,candidateProfileIds:.repair.candidateProfileIds,deletedProfileIds:.repair.deletedProfileIds}}' "$summary"

if [[ "$APPLY" == "1" && "$(jq -r '.branchIsolationClean' "$summary")" != "true" ]]; then
  printf '❌ branch isolation repair apply did not produce a clean post-check; see %s\n' "$index" >&2
  exit 1
fi
