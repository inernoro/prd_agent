#!/usr/bin/env bash
# 执行面封装: remote host / shared runtime pool preparation with evidence
#
# 默认 dry-run。只有显式设置 CDS_AGENT_REMOTE_HOST_APPLY=1 才会创建 remote host。
# 只有显式设置 CDS_AGENT_REMOTE_HOST_DEPLOY_SIDECAR=1 才会触发 deploy-sidecar。

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${CDS_AGENT_REMOTE_HOST_POOL_RUN_DIR:-/tmp/cds-agent-remote-host-pool-$(date +%Y%m%d%H%M%S)}"
APPLY="${CDS_AGENT_REMOTE_HOST_APPLY:-0}"
DEPLOY_SIDECAR="${CDS_AGENT_REMOTE_HOST_DEPLOY_SIDECAR:-0}"

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
prepare_log="$OUT_DIR/remote-host-prepare.log"
prepare_report="$OUT_DIR/remote-host-prepare.json"
post_shared_pool_log="$OUT_DIR/post-shared-service-pool-audit.log"

printf '==========================================\n'
printf 'CDS Agent Remote Host Pool Runner\n'
printf 'Apply:  %s\n' "$APPLY"
printf 'Deploy: %s\n' "$DEPLOY_SIDECAR"
printf 'Out:    %s\n' "$OUT_DIR"
printf '==========================================\n'

run_capture "pre runtime pool evidence" "$OUT_DIR/pre-evidence.log" \
  env CDS_AGENT_RUNTIME_POOL_EVIDENCE_DIR="$pre_dir" \
      CDS_AGENT_RUNTIME_POOL_RUN_GOAL_AUDIT=0 \
      bash "$ROOT_DIR/scripts/collect-cds-agent-runtime-pool-evidence.sh"

pre_branch_contaminated=0
if [[ -s "$pre_dir/summary.json" ]]; then
  pre_branch_contaminated=$(
    jq -r '[.runtimePoolBlockers[]? | select(.requirement == "BRANCH_LOCAL_SIDECAR_CLEAN")] | length' "$pre_dir/summary.json" 2>/dev/null || printf '0'
  )
fi

if [[ "$APPLY" == "1" && "$pre_branch_contaminated" != "0" ]]; then
  printf 'blocked remote host pool preparation: branch isolation is still contaminated; clean branch-local sidecar residuals first\n'
else
  run_capture "remote host pool preparation" "$prepare_log" \
    env CDS_AGENT_REMOTE_HOST_POOL_REPORT="$prepare_report" \
        bash "$ROOT_DIR/scripts/prepare-cds-agent-remote-host-pool.sh"
fi

if [[ "$APPLY" == "1" && "$pre_branch_contaminated" == "0" ]]; then
  run_capture "post runtime pool evidence" "$OUT_DIR/post-evidence.log" \
    env CDS_AGENT_RUNTIME_POOL_EVIDENCE_DIR="$post_dir" \
        CDS_AGENT_RUNTIME_POOL_RUN_GOAL_AUDIT=0 \
        bash "$ROOT_DIR/scripts/collect-cds-agent-runtime-pool-evidence.sh"
  run_capture "post shared-service pool audit" "$post_shared_pool_log" \
    env SMOKE_CDS_AGENT_SHARED_POOL_REMOTE=1 \
        bash "$ROOT_DIR/scripts/smoke-cds-agent-shared-service-pool.sh"
fi

prepare_json='null'
[[ -s "$prepare_report" ]] && prepare_json=$(jq -c . "$prepare_report" 2>/dev/null || printf 'null')
pre_summary='null'
[[ -s "$pre_dir/summary.json" ]] && pre_summary=$(jq -c . "$pre_dir/summary.json" 2>/dev/null || printf 'null')
post_summary='null'
[[ -s "$post_dir/summary.json" ]] && post_summary=$(jq -c . "$post_dir/summary.json" 2>/dev/null || printf 'null')

summary="$OUT_DIR/summary.json"
jq -n \
  --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg outDir "$OUT_DIR" \
  --arg apply "$APPLY" \
  --arg deploySidecar "$DEPLOY_SIDECAR" \
  --argjson names "[$step_names]" \
  --argjson statuses "[$step_statuses]" \
  --argjson seconds "[$step_seconds]" \
  --argjson logs "[$step_logs]" \
  --argjson exitCodes "[$step_exit_codes]" \
  --argjson prepare "$prepare_json" \
  --argjson pre "$pre_summary" \
  --argjson post "$post_summary" \
  '{
    createdAt: $createdAt,
    outDir: $outDir,
    apply: ($apply == "1"),
    deploySidecar: ($deploySidecar == "1"),
    steps: [range(0; ($names | length)) | {
      name: $names[.],
      status: $statuses[.],
      durationSeconds: $seconds[.],
      exitCode: $exitCodes[.],
      log: $logs[.]
    }],
    totalSeconds: ($seconds | add // 0),
    prepare: $prepare,
    pre: $pre,
    post: $post,
    beforeEnabledRemoteHostCount: ($pre.plan.enabledRemoteHostCount // $pre.remoteHostPoolPreparation.enabledHostCount // null),
    afterEnabledRemoteHostCount: ($post.plan.enabledRemoteHostCount // $post.remoteHostPoolPreparation.enabledHostCount // null),
    beforeSharedRunning: ($pre.plan.sharedRunning // null),
    afterSharedRunning: ($post.plan.sharedRunning // null)
  }
  | .preEvidenceAvailable = ((.pre.branchIsolation.evidenceCaptured // false) == true)
  | .branchIsolationClean = (.preEvidenceAvailable and (([.pre.runtimePoolBlockers[]? | select(.requirement == "BRANCH_LOCAL_SIDECAR_CLEAN")] | length) == 0))
  | .remoteHostConfigReady = ((.prepare.status // "") == "dry_run_ready" or (.prepare.status // "") == "applied")
  | .remoteHostAvailable = (
      if .apply then
        ((.afterEnabledRemoteHostCount // .prepare.enabledHostCount // 0) | tonumber) > 0
      else
        ((.beforeEnabledRemoteHostCount // .prepare.enabledHostCount // 0) | tonumber) > 0
      end
    )
  | .sharedRuntimeRunning = (
      if .apply then
        ((.afterSharedRunning // 0) | tonumber) > 0
      else
        ((.beforeSharedRunning // 0) | tonumber) > 0
      end
    )
  | .verdict = (
      if (.preEvidenceAvailable | not) then "evidence-unavailable"
      elif (.branchIsolationClean | not) then "blocked-branch-isolation"
      elif ((.prepare.status // "") == "missing_config") then "dry-run-missing-config"
      elif (.apply | not) and .remoteHostConfigReady then "dry-run-ready"
      elif (.apply | not) and .remoteHostAvailable and (.deploySidecar | not) then "dry-run-host-already-available"
      elif .apply and .deploySidecar and .sharedRuntimeRunning then "applied-running"
      elif .apply and .deploySidecar then "applied-not-running"
      elif .apply and .remoteHostAvailable then "applied-host-ready"
      elif .apply then "applied-host-missing"
      else "dry-run-blocked"
      end
    )
  | .readyForSharedRuntimeDeploy = (.verdict == "dry-run-host-already-available" or .verdict == "applied-host-ready")
  | .readyForProviderSmokes = (.verdict == "applied-running")
  | .nextAction = (
      if .verdict == "evidence-unavailable" then
        "runtime pool evidence was unavailable; fix network/auth and rerun this wrapper before any apply or deploy"
      elif .verdict == "blocked-branch-isolation" then
        "clean branch-local sidecar residuals first; do not create remote host or deploy shared runtime yet"
      elif .verdict == "dry-run-missing-config" then
        "provide missing remote host variables, then rerun this wrapper"
      elif .verdict == "dry-run-ready" then
        "configuration is sufficient; rerun with CDS_AGENT_REMOTE_HOST_APPLY=1 after branch isolation is clean"
      elif .verdict == "dry-run-host-already-available" then
        "enabled remote host exists; deploy shared official SDK runtime sidecar"
      elif .verdict == "applied-host-ready" then
        "remote host is ready; rerun with CDS_AGENT_REMOTE_HOST_DEPLOY_SIDECAR=1 and CDS_AGENT_SIDECAR_IMAGE"
      elif .verdict == "applied-running" then
        "shared runtime is running; continue with MAP R0/S1/S2/S3 and one-cycle smokes"
      else
        "inspect post evidence and shared-service pool audit before continuing"
      end
    )' > "$summary"

index="$OUT_DIR/evidence-index.md"
{
  printf '# CDS Agent Remote Host Pool Evidence\n\n'
  printf '%s\n' "- createdAt: \`$(jq -r '.createdAt' "$summary")\`"
  printf '%s\n' "- apply: \`$(jq -r '.apply' "$summary")\`"
  printf '%s\n' "- deploySidecar: \`$(jq -r '.deploySidecar' "$summary")\`"
  printf '%s\n' "- totalSeconds: \`$(jq -r '.totalSeconds' "$summary")\`"
  printf '%s\n' "- beforeEnabledRemoteHostCount: \`$(jq -r '.beforeEnabledRemoteHostCount // "unknown"' "$summary")\`"
  printf '%s\n' "- afterEnabledRemoteHostCount: \`$(jq -r '.afterEnabledRemoteHostCount // "not-run"' "$summary")\`"
  printf '%s\n' "- beforeSharedRunning: \`$(jq -r '.beforeSharedRunning // "unknown"' "$summary")\`"
  printf '%s\n' "- afterSharedRunning: \`$(jq -r '.afterSharedRunning // "not-run"' "$summary")\`"
  printf '%s\n' "- verdict: \`$(jq -r '.verdict' "$summary")\`"
  printf '%s\n' "- readyForSharedRuntimeDeploy: \`$(jq -r '.readyForSharedRuntimeDeploy' "$summary")\`"
  printf '%s\n' "- readyForProviderSmokes: \`$(jq -r '.readyForProviderSmokes' "$summary")\`"
  printf '%s\n' "- nextAction: $(jq -r '.nextAction' "$summary")"
  printf '%s\n\n' "- summary: \`$summary\`"
  printf '## Steps\n\n'
  jq -r '.steps[] | "- `" + .status + "` " + .name + " · rc=" + (.exitCode|tostring) + " · " + (.durationSeconds|tostring) + "s · `" + .log + "`"' "$summary"
  printf '\n## Remote Host Preparation\n\n'
  jq -r '"- status: `" + (.prepare.status // "unknown") + "`",
    "- existingHostCount: `" + ((.prepare.existingHostCount // 0)|tostring) + "`",
    "- enabledHostCount: `" + ((.prepare.enabledHostCount // 0)|tostring) + "`",
    "- missingConfig: `" + ((.prepare.missingConfig // []) | join(",")) + "`"' "$summary"
} > "$index"

printf '\nEvidence dir: %s\n' "$OUT_DIR"
printf 'Summary:      %s\n' "$summary"
printf 'Index:        %s\n' "$index"
jq '{apply,deploySidecar,totalSeconds,verdict,readyForSharedRuntimeDeploy,readyForProviderSmokes,nextAction,beforeEnabledRemoteHostCount,afterEnabledRemoteHostCount,beforeSharedRunning,afterSharedRunning,prepare:{status:.prepare.status,existingHostCount:.prepare.existingHostCount,enabledHostCount:.prepare.enabledHostCount,missingConfig:.prepare.missingConfig}}' "$summary"

if [[ "$APPLY" == "1" && "$(jq -r '.branchIsolationClean' "$summary")" != "true" ]]; then
  printf '❌ remote host apply blocked: branch isolation is still contaminated; see %s\n' "$index" >&2
  exit 1
fi
if [[ "$APPLY" == "1" && "$(jq -r '.remoteHostAvailable' "$summary")" != "true" ]]; then
  printf '❌ remote host apply did not produce an enabled remote host; see %s\n' "$index" >&2
  exit 1
fi
if [[ "$APPLY" == "1" && "$DEPLOY_SIDECAR" == "1" && "$(jq -r '.sharedRuntimeRunning' "$summary")" != "true" ]]; then
  printf '❌ shared runtime deploy did not produce a running pool; see %s\n' "$index" >&2
  exit 1
fi
