#!/usr/bin/env bash
# ============================================
# 冒烟测试总入口 (scripts/smoke-all.sh)
# ============================================
#
# 按依赖顺序串行执行所有 smoke-*.sh:
#   1. smoke-health.sh        — 连通 + 鉴权,失败就不用跑后面
#   2. smoke-cds-agent-runtime-status.sh    — CDS Agent official SDK runtime pool
#   3. smoke-cds-agent-sidecar-alias-stability.sh — API container -> sidecar alias stability
#   4. smoke-cds-agent-official-sdk-boundary.sh — local A0 official SDK adapter boundary
#   5. smoke-cds-agent-branch-isolation.sh — branch-local sidecar 防复发
#   6. smoke-cds-agent-profile-templates.sh — CDS Agent official profile templates
#   7. smoke-cds-agent-r1-profile-repair.sh — CDS Agent R1 repair dry-run / optional apply
#   8. smoke-cds-agent-profile-preflight.sh — CDS Agent profile preflight gate
#   9. smoke-cds-agent-commercial-readiness.sh — CDS Agent commercial readiness ledger
#   10. smoke-cds-agent-official-sdk-run.sh      — CDS Agent S1 readiness / gated run
#   11. smoke-cds-agent-official-sdk-controls.sh — CDS Agent S2/S3 readiness / gated controls
#   12. smoke-cds-agent-workbench-visual.sh — CDS Agent V1 authenticated visual evidence (optional auth)
#   13. smoke-cds-agent-non-code-compatibility.sh — 非代码 agent 兼容边界
#   14. smoke-cds-agent-evidence-index.sh — CDS Agent one-cycle evidence index quality
#   15. smoke-prd-agent.sh     — PRD 会话/Run 链路
#   16. smoke-defect-agent.sh  — 缺陷 CRUD
#   17. smoke-report-agent.sh — 周报 CRUD
#
# 每个子脚本独立返回 0/非 0;本脚本累计失败数,最后汇总。
# 任意子脚本失败不中断后续 —— 让使用者一次跑完能看到所有问题,而
# 不是一个个修完再跑。
#
# 用法:
#   SMOKE_TEST_HOST=https://my-branch.miduo.org \
#   AI_ACCESS_KEY=xxx \
#   SMOKE_USER=admin \
#     bash scripts/smoke-all.sh
#
# 跳过某个子 Agent (例如本地没配周报):
#   SMOKE_SKIP="report"   # 用逗号或空格分隔: health,cds-agent-runtime,cds-agent-sidecar-alias,cds-agent-boundary,cds-agent-branch-isolation,cds-agent-templates,cds-agent-r1-repair,cds-agent-preflight,cds-agent-readiness,cds-agent-s1,cds-agent-controls,cds-agent-visual,cds-agent-non-code-compat,cds-agent-evidence-index,prd-agent,defect,report
#
# CI 环境建议: fail-fast 的话把 SMOKE_FAIL_FAST=1 设上,首次失败即退出。
# ============================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SMOKE_SKIP="${SMOKE_SKIP:-}"
SMOKE_FAIL_FAST="${SMOKE_FAIL_FAST:-}"

# 按顺序声明 (key, script, human_name); 新增子冒烟在这里加一行即可。
declare -a SMOKES=(
  "health|$SCRIPT_DIR/smoke-health.sh|Health & Auth"
  "cds-agent-runtime|$SCRIPT_DIR/smoke-cds-agent-runtime-status.sh|CDS Agent Runtime"
  "cds-agent-sidecar-alias|$SCRIPT_DIR/smoke-cds-agent-sidecar-alias-stability.sh|CDS Agent Sidecar Alias Stability"
  "cds-agent-boundary|$SCRIPT_DIR/smoke-cds-agent-official-sdk-boundary.sh|CDS Agent Official SDK Boundary"
  "cds-agent-branch-isolation|$SCRIPT_DIR/smoke-cds-agent-branch-isolation.sh|CDS Agent Branch Isolation"
  "cds-agent-templates|$SCRIPT_DIR/smoke-cds-agent-profile-templates.sh|CDS Agent Runtime Profile Templates"
  "cds-agent-r1-repair|$SCRIPT_DIR/smoke-cds-agent-r1-profile-repair.sh|CDS Agent R1 Profile Repair"
  "cds-agent-preflight|$SCRIPT_DIR/smoke-cds-agent-profile-preflight.sh|CDS Agent Profile Preflight"
  "cds-agent-readiness|$SCRIPT_DIR/smoke-cds-agent-commercial-readiness.sh|CDS Agent Commercial Readiness"
  "cds-agent-s1|$SCRIPT_DIR/smoke-cds-agent-official-sdk-run.sh|CDS Agent Official SDK S1"
  "cds-agent-controls|$SCRIPT_DIR/smoke-cds-agent-official-sdk-controls.sh|CDS Agent Official SDK Controls"
  "cds-agent-visual|$SCRIPT_DIR/smoke-cds-agent-workbench-visual.sh|CDS Agent Workbench Visual"
  "cds-agent-non-code-compat|$SCRIPT_DIR/smoke-cds-agent-non-code-compatibility.sh|CDS Agent Non-code Compatibility"
  "cds-agent-evidence-index|$SCRIPT_DIR/smoke-cds-agent-evidence-index.sh|CDS Agent Evidence Index"
  "prd-agent|$SCRIPT_DIR/smoke-prd-agent.sh|PRD Agent"
  "defect|$SCRIPT_DIR/smoke-defect-agent.sh|Defect Agent"
  "report|$SCRIPT_DIR/smoke-report-agent.sh|Report Agent"
)

skipped_arr=()
failed_arr=()
passed_arr=()
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

# 判断一个 key 是否被 SMOKE_SKIP 排除。允许逗号/空格分隔。
is_skipped() {
  local key="$1"
  [[ -z "$SMOKE_SKIP" ]] && return 1
  local normalized="${SMOKE_SKIP//,/ }"
  for s in $normalized; do
    [[ "$s" == "$key" ]] && return 0
  done
  return 1
}

total_start=$(date +%s)

printf '##########################################\n'
printf '# PRD Agent 大全套冒烟测试 (smoke-all.sh)\n'
printf '##########################################\n'

for entry in "${SMOKES[@]}"; do
  IFS='|' read -r key script human <<< "$entry"
  if is_skipped "$key"; then
    printf '\n··· 跳过 %s (SMOKE_SKIP 命中)\n' "$human"
    skipped_arr+=("$human")
    record_timing "$key" "$human" "skipped" "0"
    continue
  fi
  if [[ "$key" == "cds-agent-visual" \
    && -z "${SMOKE_CDS_AGENT_ACCESS_TOKEN:-}" \
    && ( -z "${SMOKE_CDS_AGENT_LOGIN_USERNAME:-}" || -z "${SMOKE_CDS_AGENT_LOGIN_PASSWORD:-}" ) ]]; then
    printf '\n··· 跳过 %s (未提供 SMOKE_CDS_AGENT_ACCESS_TOKEN 或登录用户名/密码)\n' "$human"
    skipped_arr+=("$human")
    record_timing "$key" "$human" "skipped" "0"
    continue
  fi
  if [[ "$key" == "cds-agent-sidecar-alias" && -z "${CDS_HOST:-}" ]]; then
    printf '\n··· 跳过 %s (未提供 CDS_HOST，无法远程 exec API 容器)\n' "$human"
    skipped_arr+=("$human")
    record_timing "$key" "$human" "skipped" "0"
    continue
  fi
  step_start=$(date +%s)
  if [[ ! -x "$script" ]]; then
    # 脚本未打执行位 —— 退化为 bash 直跑,不给调用者额外负担。
    bash "$script"
  else
    "$script"
  fi
  rc=$?
  step_elapsed=$(( $(date +%s) - step_start ))
  if [[ $rc -eq 0 ]]; then
    passed_arr+=("$human")
    record_timing "$key" "$human" "passed" "$step_elapsed"
  else
    failed_arr+=("$human")
    record_timing "$key" "$human" "failed" "$step_elapsed"
    if [[ -n "$SMOKE_FAIL_FAST" ]]; then
      printf '\n⛔ SMOKE_FAIL_FAST 生效,首次失败即中止\n'
      break
    fi
  fi
done

total_elapsed=$(( $(date +%s) - total_start ))
timing_json='[]'
slowest_json='[]'
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
  slowest_json=$(jq -c '. as $all | [.[] | select(.status != "skipped")] | if length > 0 then . else $all end | sort_by(.durationSeconds) | reverse | .[:5]' <<< "$timing_json")
fi

# --- 汇总 ------------------------------------------------------------

printf '\n##########################################\n'
printf '# 冒烟测试汇总 (总耗时 %s 秒)\n' "$total_elapsed"
printf '##########################################\n'
printf '✅ 通过: %s 项\n' "${#passed_arr[@]}"
if [[ "${#passed_arr[@]}" -gt 0 ]]; then
  for name in "${passed_arr[@]}"; do printf '    · %s\n' "$name"; done
fi
printf '❌ 失败: %s 项\n' "${#failed_arr[@]}"
if [[ "${#failed_arr[@]}" -gt 0 ]]; then
  for name in "${failed_arr[@]}"; do printf '    · %s\n' "$name"; done
fi
printf '⏭  跳过: %s 项\n' "${#skipped_arr[@]}"
if [[ "${#skipped_arr[@]}" -gt 0 ]]; then
  for name in "${skipped_arr[@]}"; do printf '    · %s\n' "$name"; done
fi
if (( ${#timing_keys[@]} > 0 )); then
  printf '⏱  最慢步骤:\n'
  jq -r '.[] | "    · " + .name + " · " + (.durationSeconds|tostring) + "s · " + .status' <<< "$slowest_json"
fi

if [[ "${#failed_arr[@]}" -gt 0 ]]; then
  exit 1
fi
exit 0
