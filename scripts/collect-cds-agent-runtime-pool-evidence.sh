#!/usr/bin/env bash
# 只读证据采集: CDS Agent runtime pool recovery
#
# 输出一个目录，包含:
#   - recovery plan
#   - branch isolation repair dry-run
#   - remote host pool preparation dry-run
#   - shared-service pool audit
#   - optional goal audit
#   - summary.json / evidence-index.md
#
# 不删除、不重启、不部署。远程检查只在 CDS_HOST 存在时执行。
# 设置 CDS_AGENT_RUNTIME_POOL_UPDATE_STATUS_DOC=1 时，会用同一份 summary
# 刷新 doc/status.cds-agent-current-progress.md。

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${CDS_AGENT_RUNTIME_POOL_EVIDENCE_DIR:-/tmp/cds-agent-runtime-pool-evidence-$(date +%Y%m%d%H%M%S)}"
RUN_GOAL_AUDIT="${CDS_AGENT_RUNTIME_POOL_RUN_GOAL_AUDIT:-1}"
GOAL_AUDIT_TIMEOUT="${CDS_AGENT_RUNTIME_POOL_GOAL_AUDIT_TIMEOUT:-25}"
UPDATE_STATUS_DOC="${CDS_AGENT_RUNTIME_POOL_UPDATE_STATUS_DOC:-0}"
STATUS_DOC="${CDS_AGENT_RUNTIME_POOL_STATUS_DOC:-$ROOT_DIR/doc/status.cds-agent-current-progress.md}"

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
repair_dry_run_log="$OUT_DIR/branch-isolation-repair-dry-run.log"
repair_dry_run_report="$OUT_DIR/branch-isolation-repair-dry-run.json"
remote_host_prepare_log="$OUT_DIR/remote-host-pool-prepare.log"
remote_host_prepare_report="$OUT_DIR/remote-host-pool-prepare.json"
shared_pool_log="$OUT_DIR/shared-service-pool-audit.log"
goal_audit_log="$OUT_DIR/goal-audit.log"
goal_audit_report="$OUT_DIR/goal-audit.json"

# The caller may pin OUT_DIR to a stable location such as
# /tmp/cds-agent-runtime-pool-evidence-current. Remove prior generated
# artifacts up front so a failed fresh probe cannot silently reuse stale JSON.
rm -f \
  "$plan_log" \
  "$repair_dry_run_log" \
  "$repair_dry_run_report" \
  "$remote_host_prepare_log" \
  "$remote_host_prepare_report" \
  "$shared_pool_log" \
  "$goal_audit_log" \
  "$goal_audit_report" \
  "$OUT_DIR/summary.json" \
  "$OUT_DIR/evidence-index.md"

if [[ -n "${CDS_HOST:-}" ]]; then
  run_capture "runtime pool recovery plan" "$plan_log" \
    bash "$ROOT_DIR/scripts/plan-cds-agent-runtime-pool-recovery.sh"
  run_capture "branch isolation repair dry-run" "$repair_dry_run_log" \
    env SMOKE_CDS_AGENT_BRANCH_ISOLATION_REPAIR_REPORT="$repair_dry_run_report" \
        bash "$ROOT_DIR/scripts/repair-cds-agent-branch-isolation.sh"
  run_capture "remote host pool preparation" "$remote_host_prepare_log" \
    env CDS_AGENT_REMOTE_HOST_POOL_REPORT="$remote_host_prepare_report" \
        bash "$ROOT_DIR/scripts/prepare-cds-agent-remote-host-pool.sh"
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

json_file_or_null() {
  local file="$1"
  local parsed
  if [[ -s "$file" ]]; then
    parsed=$(jq -c . "$file" 2>/dev/null || true)
    if [[ -n "$parsed" ]]; then
      printf '%s' "$parsed"
    else
      printf 'null'
    fi
  else
    printf 'null'
  fi
}

json_from_log_or_null() {
  local file="$1"
  local parsed
  if [[ -s "$file" ]]; then
    parsed=$(sed -n '/^{/,$p' "$file" | jq -c . 2>/dev/null || true)
    if [[ -n "$parsed" ]]; then
      printf '%s' "$parsed"
    else
      printf 'null'
    fi
  else
    printf 'null'
  fi
}

plan_json=$(json_from_log_or_null "$plan_log")
goal_json=$(json_file_or_null "$goal_audit_report")
repair_json=$(json_file_or_null "$repair_dry_run_report")
remote_host_prepare_json=$(json_file_or_null "$remote_host_prepare_report")

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
  --argjson repair "$repair_json" \
  --argjson remoteHostPrepare "$remote_host_prepare_json" \
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
    branchIsolationRepairDryRun: $repair,
    remoteHostPoolPreparation: $remoteHostPrepare,
    goalStatus: ($goal.goalStatus // null),
    runtimePoolBlockers: (
      $goal.runtimePoolRecovery.blockers //
      [
        (if ($repair == null and $plan == null) then
          {requirement:"BRANCH_LOCAL_SIDECAR_CLEAN", status:"unproved:evidence-unavailable"}
        elif (($repair.contaminatedBranchCount // $plan.contaminatedBranchCount // 0) > 0) then
          {requirement:"BRANCH_LOCAL_SIDECAR_CLEAN", status:("contaminated:" + (($repair.contaminatedBranchCount // $plan.contaminatedBranchCount // 0)|tostring))}
        else empty end),
        (if ($remoteHostPrepare == null and $plan == null) then
          {requirement:"REMOTE_HOST_AVAILABLE", status:"unproved:evidence-unavailable"}
        elif ((($remoteHostPrepare.enabledHostCount // $plan.enabledRemoteHostCount // "unknown") | tostring | test("^[0-9]+$")) and (($remoteHostPrepare.enabledHostCount // $plan.enabledRemoteHostCount | tonumber) <= 0)) then
          {requirement:"REMOTE_HOST_AVAILABLE", status:"missing"}
        else empty end),
        (if ($plan == null) then
          {requirement:"SHARED_POOL_RUNNING", status:"unproved:evidence-unavailable"}
        elif (($plan.sharedRunning // 0) <= 0) then
          {requirement:"SHARED_POOL_RUNNING", status:"missing"}
        else empty end)
      ]
    )
  }
  | .missingOrUnproved = ($goal.missingOrUnproved // .runtimePoolBlockers)
  | .branchIsolation = (
      {
        evidenceCaptured: (.branchIsolationRepairDryRun != null or .plan != null),
        contaminatedBranchCount: (.branchIsolationRepairDryRun.contaminatedBranchCount // .plan.contaminatedBranchCount // null),
        candidateProfileIds: (.branchIsolationRepairDryRun.candidateProfileIds // .plan.contaminatedProfileIds // []),
        confirmProfileId: (.branchIsolationRepairDryRun.confirmProfileId // null),
        repairStatus: (.branchIsolationRepairDryRun.status // "unknown")
      }
      | .clean = (.evidenceCaptured and ((.contaminatedBranchCount // -1) == 0))
      | .verdict = (
          if (.evidenceCaptured | not) then "evidence-unavailable"
          elif .clean then "dry-run-clean"
          else "dry-run-contaminated"
          end
        )
      | .readyForRemoteHostStep = .clean
      | .nextAction = (
          if (.evidenceCaptured | not) then
            "runtime pool evidence was unavailable; rerun with network/auth available before any apply or deploy"
          elif .clean then
            "branch isolation already clean; continue with remote host and shared runtime pool recovery"
          else
            "review candidateProfileIds, then rerun scripts/run-cds-agent-branch-isolation-repair-with-evidence.sh with SMOKE_CDS_AGENT_BRANCH_ISOLATION_APPLY=1 and SMOKE_CDS_AGENT_BRANCH_ISOLATION_CONFIRM_PROFILE_ID set to the unique candidate"
          end
        )
    )
  | .remoteHost = (
      {
        prepareStatus: (.remoteHostPoolPreparation.status // "unknown"),
        evidenceCaptured: (.remoteHostPoolPreparation != null or .plan != null),
        existingHostCount: (.remoteHostPoolPreparation.existingHostCount // .plan.remoteHostCount // null),
        enabledHostCount: (.remoteHostPoolPreparation.enabledHostCount // .plan.enabledRemoteHostCount // null),
        missingConfig: (.remoteHostPoolPreparation.missingConfig // []),
        sharedRunning: (.plan.sharedRunning // null),
        branchIsolationClean: .branchIsolation.clean
      }
      | .verdict = (
          if (.branchIsolationClean | not) then "blocked-branch-isolation"
          elif (.evidenceCaptured | not) then "evidence-unavailable"
          elif ((.prepareStatus // "") == "missing_config") then "dry-run-missing-config"
          elif (((.enabledHostCount | tostring | tonumber?) // 0) > 0) then "dry-run-host-already-available"
          elif ((.prepareStatus // "") == "dry_run_ready") then "dry-run-ready"
          else "dry-run-blocked"
          end
        )
      | .readyForSharedRuntimeDeploy = (.verdict == "dry-run-host-already-available")
      | .readyForProviderSmokes = ((((.sharedRunning // 0) | tostring | tonumber?) // 0) > 0)
      | .nextAction = (
          if .verdict == "blocked-branch-isolation" then
            "clean branch-local sidecar residuals first; do not create remote host or deploy shared runtime yet"
          elif .verdict == "evidence-unavailable" then
            "remote host evidence was unavailable; rerun with network/auth available before shared runtime deploy"
          elif .verdict == "dry-run-missing-config" then
            "provide missing remote host variables, then rerun scripts/run-cds-agent-remote-host-pool-with-evidence.sh"
          elif .verdict == "dry-run-ready" then
            "configuration is sufficient; rerun with CDS_AGENT_REMOTE_HOST_APPLY=1 after branch isolation is clean"
          elif .verdict == "dry-run-host-already-available" then
            "enabled remote host exists; deploy shared official SDK runtime sidecar"
          else
            "inspect remote host preparation and shared-service pool audit before continuing"
          end
        )
    )' > "$summary"

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
  printf '\n## Branch Isolation Repair Dry Run\n\n'
  if [[ "$(jq -r '.branchIsolationRepairDryRun == null' "$summary")" == "true" ]]; then
    printf '%s\n' '- not captured'
  else
    jq -r '"- verdict: `" + (.branchIsolation.verdict // "unknown") + "`",
      "- readyForRemoteHostStep: `" + ((.branchIsolation.readyForRemoteHostStep // false)|tostring) + "`",
      "- nextAction: " + (.branchIsolation.nextAction // ""),
      "- status: `" + (.branchIsolationRepairDryRun.status // "unknown") + "`",
      "- contaminatedBranchCount: `" + ((.branchIsolation.contaminatedBranchCount // 0)|tostring) + "`",
      "- candidateProfileIds: `" + ((.branchIsolation.candidateProfileIds // []) | join(",")) + "`",
      "- confirmProfileId: `" + (.branchIsolation.confirmProfileId // "not-set") + "`"' "$summary"
  fi
  printf '\n## Remote Host Pool Preparation\n\n'
  if [[ "$(jq -r '.remoteHostPoolPreparation == null' "$summary")" == "true" ]]; then
    printf '%s\n' '- not captured'
  else
    jq -r '"- verdict: `" + (.remoteHost.verdict // "unknown") + "`",
      "- readyForSharedRuntimeDeploy: `" + ((.remoteHost.readyForSharedRuntimeDeploy // false)|tostring) + "`",
      "- readyForProviderSmokes: `" + ((.remoteHost.readyForProviderSmokes // false)|tostring) + "`",
      "- nextAction: " + (.remoteHost.nextAction // ""),
      "- status: `" + (.remoteHostPoolPreparation.status // "unknown") + "`",
      "- existingHostCount: `" + ((.remoteHost.existingHostCount // 0)|tostring) + "`",
      "- enabledHostCount: `" + ((.remoteHost.enabledHostCount // 0)|tostring) + "`",
      "- missingConfig: `" + ((.remoteHost.missingConfig // []) | join(",")) + "`"' "$summary"
  fi
  printf '\n## Missing Or Unproved\n\n'
  if [[ "$(jq -r '.missingOrUnproved | length' "$summary")" == "0" ]]; then
    printf '%s\n' '- none'
  else
    jq -r '.missingOrUnproved[] | "- `" + .requirement + "` · " + .status' "$summary"
  fi
} > "$index"

if [[ "$UPDATE_STATUS_DOC" == "1" ]]; then
  branch_name="$(git -C "$ROOT_DIR" branch --show-current 2>/dev/null || printf 'unknown')"
  updated_at="$(TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M Asia/Shanghai')"
  status_line="R0 runtime pool blocked，目标未完成。"
  if [[ "$(jq -r '.runtimePoolBlockers | length' "$summary")" == "0" ]]; then
    status_line="R0 runtime pool 暂无阻塞；继续执行 R1/S1/S2/S3 验证。"
  fi
  mkdir -p "$(dirname "$STATUS_DOC")"
  {
    printf '# CDS Agent 当前进度面板\n\n'
    printf '> 更新时间：%s\n' "$updated_at"
    printf '> 分支：`%s`\n' "$branch_name"
    printf '> 状态：%s\n\n' "$status_line"
    printf '## 当前结论\n\n'
    if [[ "$(jq -r '.runtimePoolBlockers | length' "$summary")" == "0" ]]; then
      printf '当前只读证据没有发现 runtime pool blocker。下一步应重跑 MAP R0/S1/S2/S3/one-cycle，确认 provider 与页面证据。\n\n'
    else
      printf '现在不要做普通 preview redeploy。远程 R0 runtime pool 的结构性阻塞仍存在：\n\n'
      jq -r '.runtimePoolBlockers[] | "- `" + .requirement + " = " + .status + "`"' "$summary"
      printf '\n'
    fi
    printf '最新只读证据目录：\n\n'
    printf -- '- `%s`\n' "$OUT_DIR"
    printf -- '- `summary.json`: `%s`\n' "$summary"
    printf -- '- `evidence-index.md`: `%s`\n\n' "$index"
    printf '本次证据采集总耗时 `%ss`：\n\n' "$(jq -r '.totalSeconds' "$summary")"
    printf '| 步骤 | 状态 | 耗时 |\n'
    printf '| --- | --- | --- |\n'
    jq -r '.steps[] | "| " + .name + " | " + .status + " | " + (.durationSeconds|tostring) + "s |"' "$summary"
    printf '\n## 为什么不是部署问题\n\n'
    printf '当前阻塞不在 `prd-api` 或 `prd-admin` 普通应用代码是否能构建，而在 CDS 远程控制面 state：\n\n'
    printf -- '- `prd-agent` 业务项目仍有 branch-local `claude-agent-sdk-runtime-v2-prd-agent` 残留。\n'
    printf -- '- `shared-sidecar-pool-mp4anabh` 是 `shared-service`，但没有 running service。\n'
    printf -- '- CDS 系统 remote host 列表为空，没有可承载 official SDK runtime 的主机。\n\n'
    printf '普通 preview redeploy 不能创建 shared runtime pool，也不能清理历史 branch-local sidecar residual。继续 redeploy 反而可能让用户以为构建能解决 R0。\n\n'
    printf '## 已完成\n\n'
    printf -- '- MAP/CDS 控制面与官方 SDK adapter 边界已写入后端兼容矩阵。\n'
    printf -- '- `claude-agent-sdk` 路径已作为目标 adapter；`legacy-sidecar` 只允许显式 fallback。\n'
    printf -- '- 其他候选官方 SDK，例如 `codex`、`openai-agents-sdk`、`google-adk`，仍为 `planned-not-routable`，避免误路由。\n'
    printf -- '- 非代码智能体兼容 smoke 已存在，防止 PRD/Defect/Literary/Visual 等智能体被 CDS sidecar runtime pool 污染。\n'
    printf -- '- runtime-status execution panel 已能把 R0 阻塞的下一步收敛到只读证据采集。\n'
    printf -- '- 总证据 summary 已聚合 branch isolation 与 remote host/shared runtime verdict，避免跨多个 `/tmp` 目录人工判断。\n'
    printf -- '- 文档和目标审计已校准到当前 R0 runtime pool 阻塞，而不是旧的“只剩 R1 profile”。\n\n'
    printf '## 下一步\n\n'
    printf '必须按这个顺序处理：\n\n'
    printf '1. 清理 `prd-agent` 的 branch-local sidecar BuildProfile/service residual。\n'
    printf '   - dry-run 证据已确认候选 profile：`%s`\n' "$(jq -r '(.branchIsolationRepairDryRun.candidateProfileIds // []) | join(",") // "unknown"' "$summary")"
    printf '   - verdict：`%s`\n' "$(jq -r '.branchIsolation.verdict // "unknown"' "$summary")"
    printf '   - readyForRemoteHostStep：`%s`\n' "$(jq -r '.branchIsolation.readyForRemoteHostStep // false' "$summary")"
    printf '   - nextAction：%s\n' "$(jq -r '.branchIsolation.nextAction // ""' "$summary")"
    printf '   - apply 确认变量：`SMOKE_CDS_AGENT_BRANCH_ISOLATION_CONFIRM_PROFILE_ID=%s`\n' "$(jq -r '(.branchIsolation.candidateProfileIds // []) | if length == 1 then .[0] else "REVIEW_CANDIDATES" end' "$summary")"
    printf '   - 写远程清理前必须使用 evidence wrapper，并在清理后立即跑 post-check。\n'
    printf '2. 登记至少一个 enabled CDS remote host。\n'
    printf '   - verdict：`%s`\n' "$(jq -r '.remoteHost.verdict // "unknown"' "$summary")"
    printf '   - readyForSharedRuntimeDeploy：`%s`\n' "$(jq -r '.remoteHost.readyForSharedRuntimeDeploy // false' "$summary")"
    printf '   - nextAction：%s\n' "$(jq -r '.remoteHost.nextAction // ""' "$summary")"
    jq -r '(.remoteHostPoolPreparation.missingConfig // [])[]? | "   - 当前缺失：`" + . + "`"' "$summary"
    printf '3. 部署 shared official SDK runtime sidecar。\n'
    printf '   - 需要 sidecar image，例如通过 `CDS_AGENT_SIDECAR_IMAGE` 提供。\n'
    printf '4. 重跑 shared-service pool audit。\n'
    printf '5. R0 通过后，再进入 R1 Anthropic/Claude-compatible profile 和 S1/S2/S3 provider smokes。\n\n'
    printf '## 当前有效命令\n\n'
    printf '只读总证据并刷新本文件：\n\n'
    printf '```bash\n'
    printf 'CDS_HOST=https://cds.miduo.org \\\n'
    printf 'CDS_AGENT_RUNTIME_POOL_RUN_GOAL_AUDIT=0 \\\n'
    printf 'CDS_AGENT_RUNTIME_POOL_UPDATE_STATUS_DOC=1 \\\n'
    printf '  bash scripts/collect-cds-agent-runtime-pool-evidence.sh\n'
    printf '```\n\n'
    printf 'branch 清理 dry-run：\n\n'
    printf '```bash\n'
    printf 'CDS_HOST=https://cds.miduo.org \\\n'
    printf '  bash scripts/run-cds-agent-branch-isolation-repair-with-evidence.sh\n'
    printf '```\n\n'
    printf 'branch 清理 apply 必须精确确认候选 profile：\n\n'
    printf '```bash\n'
    printf 'CDS_HOST=https://cds.miduo.org \\\n'
    printf 'SMOKE_CDS_AGENT_BRANCH_ISOLATION_APPLY=1 \\\n'
    printf 'SMOKE_CDS_AGENT_BRANCH_ISOLATION_CONFIRM_PROFILE_ID=%s \\\n' "$(jq -r '(.branchIsolation.candidateProfileIds // []) | if length == 1 then .[0] else "REVIEW_CANDIDATES" end' "$summary")"
    printf '  bash scripts/run-cds-agent-branch-isolation-repair-with-evidence.sh\n'
    printf '```\n\n'
    printf 'remote host 准备 dry-run：\n\n'
    printf '```bash\n'
    printf 'CDS_HOST=https://cds.miduo.org \\\n'
    printf '  bash scripts/run-cds-agent-remote-host-pool-with-evidence.sh\n'
    printf '```\n\n'
    printf '目标审计：\n\n'
    printf '```bash\n'
    printf 'CDS_AGENT_GOAL_AUDIT_REPORT=/tmp/cds-agent-goal-audit.json \\\n'
    printf '  bash scripts/audit-cds-agent-goal.sh\n'
    printf '```\n'
  } > "$STATUS_DOC"
  printf 'Status doc:   %s\n' "$STATUS_DOC"
fi

printf '\nEvidence dir: %s\n' "$OUT_DIR"
printf 'Summary:      %s\n' "$summary"
printf 'Index:        %s\n' "$index"
jq '{goalStatus,totalSeconds,branchIsolation:{verdict:.branchIsolation.verdict,readyForRemoteHostStep:.branchIsolation.readyForRemoteHostStep,nextAction:.branchIsolation.nextAction},remoteHost:{verdict:.remoteHost.verdict,readyForSharedRuntimeDeploy:.remoteHost.readyForSharedRuntimeDeploy,readyForProviderSmokes:.remoteHost.readyForProviderSmokes,nextAction:.remoteHost.nextAction},runtimePoolBlockers,missingOrUnproved}' "$summary"
