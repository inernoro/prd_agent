#!/usr/bin/env bash
# ============================================
# 冒烟测试总入口 (scripts/smoke-all.sh)
# ============================================
#
# 按依赖顺序串行执行所有 smoke-*.sh:
#   1. smoke-health.sh        — 连通 + 鉴权,失败就不用跑后面
#   2. smoke-prd-agent.sh     — PRD 会话/Run 链路
#   3. smoke-defect-agent.sh  — 缺陷 CRUD
#   4. smoke-report-agent.sh  — 周报 CRUD
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
#   SMOKE_SKIP="report"   # 用逗号或空格分隔: health,prd-agent,defect,report
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
  "prd-agent|$SCRIPT_DIR/smoke-prd-agent.sh|PRD Agent"
  "defect|$SCRIPT_DIR/smoke-defect-agent.sh|Defect Agent"
  "report|$SCRIPT_DIR/smoke-report-agent.sh|Report Agent"
)

skipped_arr=()
failed_arr=()
passed_arr=()

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
    continue
  fi
  if [[ ! -x "$script" ]]; then
    # 脚本未打执行位 —— 退化为 bash 直跑,不给调用者额外负担。
    bash "$script"
  else
    "$script"
  fi
  rc=$?
  if [[ $rc -eq 0 ]]; then
    passed_arr+=("$human")
  else
    failed_arr+=("$human")
    if [[ -n "$SMOKE_FAIL_FAST" ]]; then
      printf '\n⛔ SMOKE_FAIL_FAST 生效,首次失败即中止\n'
      break
    fi
  fi
done

total_elapsed=$(( $(date +%s) - total_start ))

# --- 汇总 ------------------------------------------------------------

printf '\n##########################################\n'
printf '# 冒烟测试汇总 (总耗时 %s 秒)\n' "$total_elapsed"
printf '##########################################\n'
printf '✅ 通过: %s 项\n' "${#passed_arr[@]}"
for name in "${passed_arr[@]}"; do printf '    · %s\n' "$name"; done
printf '❌ 失败: %s 项\n' "${#failed_arr[@]}"
for name in "${failed_arr[@]}"; do printf '    · %s\n' "$name"; done
printf '⏭  跳过: %s 项\n' "${#skipped_arr[@]}"
for name in "${skipped_arr[@]}"; do printf '    · %s\n' "$name"; done

if [[ "${#failed_arr[@]}" -gt 0 ]]; then
  exit 1
fi
exit 0
