#!/usr/bin/env bash
# 只读恢复计划: CDS Agent runtime pool / MAP branch isolation
#
# 这个脚本不删除、不重启、不部署。它把当前远程 CDS 状态整理成按顺序执行的
# recovery plan，避免把 shared-service pool 当普通 branch preview 误部署。

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_PROJECT_ID="${SMOKE_CDS_PROJECT_ID:-prd-agent}"
SHARED_POOL_ID="${SMOKE_CDS_SHARED_POOL_ID:-shared-sidecar-pool-mp4anabh}"

fail() {
  printf '❌ %s\n' "$*" >&2
  exit 1
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 || fail "缺少依赖: $1"
}

cds_base_url() {
  local cds_base="${CDS_HOST%/}"
  [[ "$cds_base" == http* ]] || cds_base="https://$cds_base"
  printf '%s' "$cds_base"
}

auth_args=()
build_auth_args() {
  auth_args=()
  if [[ -n "${CDS_PROJECT_KEY:-}" ]]; then
    auth_args=(-H "X-AI-Access-Key: $CDS_PROJECT_KEY")
  elif [[ -n "${AI_ACCESS_KEY:-}" ]]; then
    auth_args=(-H "X-AI-Access-Key: $AI_ACCESS_KEY")
  fi
}

[[ -n "${CDS_HOST:-}" ]] || fail "需要 CDS_HOST"
[[ -f "$ROOT_DIR/.claude/skills/cds/cli/cdscli.py" ]] || fail "缺少 .claude/skills/cds/cli/cdscli.py"
require_tool jq
require_tool curl
build_auth_args

printf '==========================================\n'
printf 'CDS Agent Runtime Pool Recovery Plan\n'
printf 'CDS:          %s\n' "$(cds_base_url)"
printf 'App project:  %s\n' "$APP_PROJECT_ID"
printf 'Shared pool:  %s\n' "$SHARED_POOL_ID"
printf '==========================================\n'

project_json=$(cd "$ROOT_DIR" && CDS_HOST="$CDS_HOST" python3 .claude/skills/cds/cli/cdscli.py project list)
branch_json=$(cd "$ROOT_DIR" && CDS_HOST="$CDS_HOST" python3 .claude/skills/cds/cli/cdscli.py branch list --project "$APP_PROJECT_ID")

shared_project=$(printf '%s' "$project_json" | jq -c --arg id "$SHARED_POOL_ID" '
  .data[]? | select(.id == $id or (.kind == "shared-service" and (.slug == $id or .name == "Claude SDK Sidecar Pool")))
' | head -n 1)
if [[ -z "$shared_project" ]]; then
  shared_kind="missing"
  shared_running=0
  shared_branch_count=0
else
  shared_kind=$(printf '%s' "$shared_project" | jq -r '.kind // "unknown"')
  shared_branch_count=$(printf '%s' "$shared_project" | jq -r '.branchCount // 0')
  shared_running=$(printf '%s' "$shared_project" | jq -r '(.runningBranchCount // 0) + (.runningServiceCount // 0) + (.runningInfraServiceCount // 0)')
fi

contaminated=$(
  printf '%s' "$branch_json" | jq -c '
    [.data.branches[]?
      | {id, branch, services: ((.services // {}) | keys | map(select(test("claude-agent-sdk-runtime|claude-sidecar|sidecar.*runtime"; "i"))))}
      | select((.services | length) > 0)]
  '
)
contaminated_count=$(printf '%s' "$contaminated" | jq -r 'length')
profile_ids=$(printf '%s' "$contaminated" | jq -r '.[].services[]?' | sort -u | paste -sd ',' -)

host_count="unknown"
enabled_host_count="unknown"
if (( ${#auth_args[@]} > 0 )); then
  hosts_json=$(curl --max-time 20 --show-error --silent --fail-with-body \
    -H "Accept: application/json" \
    "${auth_args[@]}" \
    "$(cds_base_url)/api/cds-system/remote-hosts")
  host_count=$(printf '%s' "$hosts_json" | jq -r '.hosts | length')
  enabled_host_count=$(printf '%s' "$hosts_json" | jq -r '[.hosts[]? | select(.isEnabled != false)] | length')
fi

printf '\n当前状态:\n'
printf '  - sharedPool.kind=%s branchCount=%s runningTotal=%s\n' "$shared_kind" "$shared_branch_count" "$shared_running"
printf '  - appBranchLocalSidecarBranches=%s profiles=%s\n' "$contaminated_count" "${profile_ids:-none}"
printf '  - remoteHosts=%s enabled=%s\n' "$host_count" "$enabled_host_count"

printf '\n行动顺序:\n'
step=1
if (( contaminated_count > 0 )); then
  printf '  %s. 清理 %s 的 branch-local sidecar BuildProfile/service 残留: %s\n' "$step" "$APP_PROJECT_ID" "${profile_ids:-unknown}"
  printf '     命令: CDS_HOST=%s SMOKE_CDS_AGENT_BRANCH_ISOLATION_APPLY=1 bash scripts/repair-cds-agent-branch-isolation.sh\n' "$(cds_base_url)"
  step=$((step + 1))
fi

if [[ "$shared_kind" != "shared-service" ]]; then
  printf '  %s. 修复 shared pool project 类型: 目标必须是 kind=shared-service，不是普通 git branch 项目\n' "$step"
  step=$((step + 1))
fi

if [[ "$enabled_host_count" == "unknown" ]]; then
  printf '  %s. 设置 AI_ACCESS_KEY 或 CDS_PROJECT_KEY 后重跑本脚本，以确认 remote host 承载能力\n' "$step"
  step=$((step + 1))
elif (( enabled_host_count <= 0 )); then
  printf '  %s. 在 CDS 系统侧登记至少一个 enabled remote host，再通过 /api/cds-system/remote-hosts/:id/deploy-sidecar 部署官方 SDK runtime\n' "$step"
  step=$((step + 1))
fi

if (( shared_running <= 0 )); then
  printf '  %s. 恢复 shared-service runtime pool 的 running 实例，然后跑 scripts/smoke-cds-agent-shared-service-pool.sh\n' "$step"
  step=$((step + 1))
fi

printf '  %s. shared pool 和 branch isolation 都通过后，再跑 MAP R0/S1/S2/S3/one-cycle\n' "$step"

printf '\n禁止路径:\n'
printf '  - 不要用 cdscli branch create/deploy %s main 来恢复 runtime pool。\n' "$SHARED_POOL_ID"
printf '  - 不要把 CLAUDE_SIDECAR_BASE_URL 指回 %s 的 branch-local alias。\n' "$APP_PROJECT_ID"
printf '  - 不要把 claude-agent-sdk-runtime 写回 %s 的 cds-compose.yml services。\n' "$APP_PROJECT_ID"

printf '\n机器可读摘要:\n'
jq -n \
  --arg sharedPoolId "$SHARED_POOL_ID" \
  --arg sharedKind "$shared_kind" \
  --argjson sharedBranchCount "$shared_branch_count" \
  --argjson sharedRunning "$shared_running" \
  --argjson contaminatedCount "$contaminated_count" \
  --arg profileIds "${profile_ids:-}" \
  --arg hostCount "$host_count" \
  --arg enabledHostCount "$enabled_host_count" \
  '{
    sharedPoolId: $sharedPoolId,
    sharedKind: $sharedKind,
    sharedBranchCount: $sharedBranchCount,
    sharedRunning: $sharedRunning,
    contaminatedBranchCount: $contaminatedCount,
    contaminatedProfileIds: ($profileIds | split(",") | map(select(length > 0))),
    remoteHostCount: $hostCount,
    enabledRemoteHostCount: $enabledHostCount,
    branchDeploySharedPoolAllowed: false
  }'
