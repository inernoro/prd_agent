#!/usr/bin/env bash
# 冒烟测试: CDS Agent shared-service runtime pool isolation/readiness
#
# 默认只跑本地 guard，避免在远程 CDS 仍有历史污染时阻塞本地开发。
# 设置 SMOKE_CDS_AGENT_SHARED_POOL_REMOTE=1 CDS_HOST=... 后启用只读远程审计。
#
# 远程验收标准:
#   1. prd-agent 分支服务中不再包含 branch-local agent runtime sidecar。
#   2. shared-sidecar-pool-* 项目存在，且 kind=shared-service。
#   3. shared-service pool 至少有一个 running branch/service 或部署实例。
#   4. CDS 至少登记了一个 remote host，可承载系统级 sidecar deploy。
#   5. 如果提供 CDS_SHARED_POOL_LONG_TOKEN，则直接调用 /api/projects/:id/instances
#      验证 instance discovery 暴露 running instance。

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_APP_PROJECT_ID="${SMOKE_CDS_PROJECT_ID:-prd-agent}"
SHARED_POOL_ID="${SMOKE_CDS_SHARED_POOL_ID:-shared-sidecar-pool-mp4anabh}"
REMOTE="${SMOKE_CDS_AGENT_SHARED_POOL_REMOTE:-0}"

failures=0

fail_later() {
  printf '❌ %s\n' "$*" >&2
  failures=$((failures + 1))
}

fail_now() {
  printf '❌ %s\n' "$*" >&2
  exit 1
}

ok() {
  printf '✅ %s\n' "$*"
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 || fail_now "缺少依赖: $1"
}

cds_base_url() {
  local cds_base="${CDS_HOST%/}"
  [[ "$cds_base" == http* ]] || cds_base="https://$cds_base"
  printf '%s' "$cds_base"
}

printf '==========================================\n'
printf '冒烟测试: CDS Agent Shared-Service Runtime Pool\n'
printf '==========================================\n'

printf '\n>>> [1/5] 本地 branch isolation guard\n'
bash "$ROOT_DIR/scripts/smoke-cds-agent-branch-isolation.sh"

printf '\n>>> [2/5] 本地文档与恢复入口存在\n'
[[ -f "$ROOT_DIR/doc/guide.cds-agent-runtime-pool-recovery.md" ]] \
  || fail_now "缺少 runtime pool recovery runbook"
[[ -f "$ROOT_DIR/doc/report.cds-agent-runtime-pool-contamination-2026-05-18.md" ]] \
  || fail_now "缺少 sidecar contamination report"
if ! grep -Eq 'shared-service|shared-sidecar-pool' "$ROOT_DIR/doc/guide.cds-agent-runtime-pool-recovery.md"; then
  fail_now "runtime pool recovery runbook 未描述 shared-service/shared-sidecar-pool"
fi
ok "runtime pool recovery/report 文档入口存在"

printf '\n>>> [3/5] 可选远程 shared-service pool 审计\n'
if [[ "$REMOTE" != "1" ]]; then
  ok "跳过远程审计；设置 SMOKE_CDS_AGENT_SHARED_POOL_REMOTE=1 CDS_HOST=... 后启用"
  printf '\n==========================================\n'
  printf '✅ CDS Agent Shared-Service Runtime Pool 本地 guard 通过\n'
  printf '==========================================\n'
  exit 0
fi

[[ -n "${CDS_HOST:-}" ]] || fail_now "远程审计需要 CDS_HOST"
[[ -f "$ROOT_DIR/.claude/skills/cds/cli/cdscli.py" ]] || fail_now "缺少 .claude/skills/cds/cli/cdscli.py"
require_tool jq
require_tool curl

project_json=$(cd "$ROOT_DIR" && CDS_HOST="$CDS_HOST" python3 .claude/skills/cds/cli/cdscli.py project list)
project_ok=$(printf '%s' "$project_json" | jq -r '.ok // false')
[[ "$project_ok" == "true" ]] || fail_now "project list 返回失败"

shared_project=$(printf '%s' "$project_json" | jq -c --arg id "$SHARED_POOL_ID" '
  .data[]? | select(.id == $id or (.kind == "shared-service" and (.slug == $id or .name == "Claude SDK Sidecar Pool")))
' | head -n 1)
if [[ -z "$shared_project" ]]; then
  fail_later "未找到 shared-service pool project: $SHARED_POOL_ID"
else
  shared_id=$(printf '%s' "$shared_project" | jq -r '.id')
  shared_kind=$(printf '%s' "$shared_project" | jq -r '.kind // ""')
  shared_branch_count=$(printf '%s' "$shared_project" | jq -r '.branchCount // 0')
  shared_running_branch_count=$(printf '%s' "$shared_project" | jq -r '.runningBranchCount // 0')
  shared_running_service_count=$(printf '%s' "$shared_project" | jq -r '.runningServiceCount // 0')
  shared_running_infra_count=$(printf '%s' "$shared_project" | jq -r '.runningInfraServiceCount // 0')
  if [[ "$shared_kind" != "shared-service" ]]; then
    fail_later "$shared_id kind=$shared_kind，不是 shared-service"
  else
    ok "$shared_id kind=shared-service"
  fi
  if (( shared_running_branch_count <= 0 && shared_running_service_count <= 0 && shared_running_infra_count <= 0 )); then
    fail_later "$shared_id 没有 running runtime 实例: branchCount=$shared_branch_count runningBranch=$shared_running_branch_count runningService=$shared_running_service_count runningInfra=$shared_running_infra_count"
  else
    ok "$shared_id runningBranch=$shared_running_branch_count runningService=$shared_running_service_count runningInfra=$shared_running_infra_count"
  fi
fi

app_sidecars=$(printf '%s' "$project_json" | jq -r --arg id "$REMOTE_APP_PROJECT_ID" '
  [.data[]? | select(.id == $id) | .appServices[]? | select((.id // "") | test("claude-agent-sdk-runtime|claude-sidecar|sidecar.*runtime"; "i"))] | length
')
if (( app_sidecars > 0 )); then
  app_summary=$(printf '%s' "$project_json" | jq -c --arg id "$REMOTE_APP_PROJECT_ID" '
    [.data[]? | select(.id == $id) | .appServices[]? | select((.id // "") | test("claude-agent-sdk-runtime|claude-sidecar|sidecar.*runtime"; "i")) | {id, branch, status}]
  ')
  fail_later "$REMOTE_APP_PROJECT_ID project list 仍显示 branch-local sidecar appServices: $app_summary"
else
  ok "$REMOTE_APP_PROJECT_ID project list 未显示 running branch-local sidecar appServices"
fi

branch_json=$(cd "$ROOT_DIR" && CDS_HOST="$CDS_HOST" python3 .claude/skills/cds/cli/cdscli.py branch list --project "$REMOTE_APP_PROJECT_ID")
contaminated=$(
  printf '%s' "$branch_json" | jq -c '
    [.data.branches[]?
      | {id, branch, services: ((.services // {}) | keys | map(select(test("claude-agent-sdk-runtime|claude-sidecar|sidecar.*runtime"; "i"))))}
      | select((.services | length) > 0)]
  '
)
contaminated_count=$(printf '%s' "$contaminated" | jq -r 'length')
if (( contaminated_count > 0 )); then
  fail_later "$REMOTE_APP_PROJECT_ID 仍有 $contaminated_count 个分支包含 branch-local sidecar service: $contaminated"
else
  ok "$REMOTE_APP_PROJECT_ID branch services 未发现 branch-local sidecar"
fi

printf '\n>>> [4/5] 远程 remote host 承载能力审计\n'
auth_args=()
if [[ -n "${CDS_PROJECT_KEY:-}" ]]; then
  auth_args=(-H "X-AI-Access-Key: $CDS_PROJECT_KEY")
elif [[ -n "${AI_ACCESS_KEY:-}" ]]; then
  auth_args=(-H "X-AI-Access-Key: $AI_ACCESS_KEY")
fi
if (( ${#auth_args[@]} == 0 )); then
  fail_later "缺少 AI_ACCESS_KEY 或 CDS_PROJECT_KEY，无法审计 /api/cds-system/remote-hosts"
else
  hosts_json=$(curl --max-time 20 --show-error --silent --fail-with-body \
    -H "Accept: application/json" \
    "${auth_args[@]}" \
    "$(cds_base_url)/api/cds-system/remote-hosts")
  host_count=$(printf '%s' "$hosts_json" | jq -r '.hosts | length')
  enabled_host_count=$(printf '%s' "$hosts_json" | jq -r '[.hosts[]? | select(.isEnabled != false)] | length')
  if (( host_count <= 0 || enabled_host_count <= 0 )); then
    fail_later "CDS remote hosts 为空或无 enabled host: hostCount=${host_count} enabled=${enabled_host_count}; shared-service pool 没有系统级 sidecar 承载目标"
  else
    ok "remoteHosts hostCount=${host_count} enabled=${enabled_host_count}"
  fi
fi

printf '\n>>> [5/5] 可选 long-token instance discovery 验证\n'
if [[ -z "${CDS_SHARED_POOL_LONG_TOKEN:-}" ]]; then
  ok "跳过 /api/projects/:id/instances 直连验证；设置 CDS_SHARED_POOL_LONG_TOKEN 后启用"
else
  instance_json=$(curl --max-time 20 --show-error --silent --fail-with-body \
    -H "Accept: application/json" \
    -H "Authorization: Bearer $CDS_SHARED_POOL_LONG_TOKEN" \
    "$(cds_base_url)/api/projects/$SHARED_POOL_ID/instances")
  instance_count=$(printf '%s' "$instance_json" | jq -r '.instances | length')
  running_branch_services=$(printf '%s' "$instance_json" | jq -r '.discovery.runningBranchServiceCount // 0')
  runtime_branch_services=$(printf '%s' "$instance_json" | jq -r '.discovery.runtimeBranchServiceCount // 0')
  if (( instance_count <= 0 )); then
    fail_later "/api/projects/$SHARED_POOL_ID/instances 返回空: discovery=$(printf '%s' "$instance_json" | jq -c '.discovery')"
  else
    ok "instanceDiscovery instances=$instance_count runningBranchServices=$running_branch_services runtimeBranchServices=$runtime_branch_services"
  fi
fi

if (( failures > 0 )); then
  printf '\n==========================================\n' >&2
  printf '❌ CDS Agent Shared-Service Runtime Pool 审计失败: %s 个问题\n' "$failures" >&2
  printf '==========================================\n' >&2
  exit 1
fi

printf '\n==========================================\n'
printf '✅ CDS Agent Shared-Service Runtime Pool 远程审计通过\n'
printf '==========================================\n'
