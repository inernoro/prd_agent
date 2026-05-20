#!/usr/bin/env bash
# 冒烟测试: CDS Agent branch isolation guard
#
# 目标:
#   1. 本地防复发: prd-agent 的 cds-compose.yml 不允许把 Claude Agent SDK
#      runtime sidecar 写成普通 branch service。
#   2. 可选远程审计: 设置 SMOKE_CDS_AGENT_BRANCH_ISOLATION_REMOTE=1 且 CDS_HOST
#      后，检查远程 prd-agent 分支 services 是否仍含 branch-local sidecar。
#
# 说明:
#   远程现网当前可能仍有历史污染。本脚本默认只跑本地 guard，避免在未清理
#   远程 state 前阻塞其他本地验证；远程检查用于清理完成后的验收。

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/cds-compose.yml"
REMOTE_PROJECT_ID="${SMOKE_CDS_PROJECT_ID:-prd-agent}"

fail() {
  printf '❌ %s\n' "$*" >&2
  exit 1
}

ok() {
  printf '✅ %s\n' "$*"
}

printf '==========================================\n'
printf '冒烟测试: CDS Agent Branch Isolation\n'
printf '==========================================\n'

printf '\n>>> [1/3] 本地 compose 不得声明 branch-local sidecar service\n'
if [[ ! -f "$COMPOSE_FILE" ]]; then
  fail "缺少 $COMPOSE_FILE"
fi

if grep -Eq '^[[:space:]]{2}(claude-agent-sdk-runtime|claude-sidecar|.*sidecar.*runtime).*:' "$COMPOSE_FILE"; then
  grep -En '^[[:space:]]{2}(claude-agent-sdk-runtime|claude-sidecar|.*sidecar.*runtime).*:' "$COMPOSE_FILE" >&2 || true
  fail "cds-compose.yml services 中仍包含 Claude Agent SDK runtime sidecar；它会被 CDS 解析为每个 branch 的 BuildProfile"
fi
ok "cds-compose.yml 未声明 branch-local sidecar service"

printf '\n>>> [2/3] API 环境不得直连 branch-local sidecar alias\n'
if grep -Eq 'CLAUDE_SIDECAR_BASE_URL:[[:space:]]*"?http://claude-agent-sdk-runtime' "$COMPOSE_FILE"; then
  grep -En 'CLAUDE_SIDECAR_BASE_URL' "$COMPOSE_FILE" >&2 || true
  fail "api 环境仍直连 claude-agent-sdk-runtime alias；R0 应来自 shared-service discovery 或显式外部 sidecar"
fi
if grep -Eq 'CLAUDE_SIDECAR_TOKEN:[[:space:]]*"?dev-skip' "$COMPOSE_FILE"; then
  grep -En 'CLAUDE_SIDECAR_TOKEN' "$COMPOSE_FILE" >&2 || true
  fail "api 环境仍配置 branch-local CLAUDE_SIDECAR_TOKEN；这会触发静态 sidecar auto-config"
fi
ok "api 环境未配置 branch-local sidecar alias/token"

printf '\n>>> [3/3] 可选远程分支服务污染审计\n'
if [[ "${SMOKE_CDS_AGENT_BRANCH_ISOLATION_REMOTE:-}" != "1" ]]; then
  ok "跳过远程审计；设置 SMOKE_CDS_AGENT_BRANCH_ISOLATION_REMOTE=1 CDS_HOST=... 后启用"
  printf '\n==========================================\n'
  printf '✅ CDS Agent Branch Isolation 本地 guard 通过\n'
  printf '==========================================\n'
  exit 0
fi

if [[ -z "${CDS_HOST:-}" ]]; then
  fail "远程审计需要 CDS_HOST"
fi
if [[ ! -f "$ROOT_DIR/.claude/skills/cds/cli/cdscli.py" ]]; then
  fail "缺少 .claude/skills/cds/cli/cdscli.py"
fi
if ! command -v jq >/dev/null 2>&1; then
  fail "远程审计需要 jq"
fi

branch_json=$(cd "$ROOT_DIR" && CDS_HOST="$CDS_HOST" python3 .claude/skills/cds/cli/cdscli.py branch list --project "$REMOTE_PROJECT_ID")
contaminated=$(
  printf '%s' "$branch_json" | jq -r '
    [.data.branches[]?
      | {id, branch, services: ((.services // {}) | keys | map(select(test("claude-agent-sdk-runtime|claude-sidecar|sidecar.*runtime"; "i"))))}
      | select((.services | length) > 0)]
  '
)
count=$(printf '%s' "$contaminated" | jq -r 'length')
if [[ "$count" != "0" ]]; then
  printf '%s\n' "$contaminated" >&2
  fail "远程 $REMOTE_PROJECT_ID 仍有 $count 个分支包含 branch-local sidecar service"
fi
ok "远程 $REMOTE_PROJECT_ID 分支 services 未发现 branch-local sidecar"

printf '\n==========================================\n'
printf '✅ CDS Agent Branch Isolation 冒烟测试全部通过\n'
printf '==========================================\n'
