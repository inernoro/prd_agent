#!/usr/bin/env bash
# ============================================
# CDS Agent runtime profile templates smoke
# ============================================
#
# 验证 MAP 后端是 runtime profile 模板的事实源：
#   - 暴露 Anthropic official Claude Agent SDK 模板
#   - 模板协议/baseUrl/model 与官方 SDK adapter 兼容
#   - 模板创建入口缺 API key 时必须失败，不能创建半成品 profile
#   - 暴露 adapter 兼容矩阵，避免把普通 OpenAI-compatible profile 误路由到官方 SDK
#
# 环境变量同 scripts/smoke-lib.sh。
# ============================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=smoke-lib.sh
source "$SCRIPT_DIR/smoke-lib.sh"

SMOKE_STEP_TOTAL=6
smoke_init "CDS Agent Runtime Profile Templates"

smoke_step "GET runtime profile templates"
resp=$(smoke_get /api/infra-agent-runtime-profiles/templates)
smoke_assert_eq "$(printf '%s' "$resp" | jq -r '.success')" "true" "success"
smoke_ok "templates API 可访问"

smoke_step "确认 Anthropic 官方 Claude Agent SDK 模板"
template=$(printf '%s' "$resp" | jq -c '.data.items[]? | select(.id == "anthropic-official-claude-sonnet-4")')
smoke_assert_nonempty "$template" "anthropic official template"
smoke_assert_eq "$(printf '%s' "$template" | jq -r '.protocol')" "anthropic" "template.protocol"
smoke_assert_eq "$(printf '%s' "$template" | jq -r '.baseUrl')" "https://api.anthropic.com" "template.baseUrl"
model=$(printf '%s' "$template" | jq -r '.model')
if [[ "$model" != claude-* ]]; then
  smoke_fail "template.model 不是 Claude 官方模型形态: $model"
fi
smoke_ok "template=$model"

smoke_step "确认模板声明兼容 claude-agent-sdk"
compatible_count=$(printf '%s' "$template" | jq -r '[.compatibleRuntimeAdapters[]? | select(. == "claude-agent-sdk")] | length')
smoke_assert_eq "$compatible_count" "1" "compatibleRuntimeAdapters.claude-agent-sdk"
smoke_ok "compatibleRuntimeAdapters includes claude-agent-sdk"

smoke_step "模板创建入口缺 API key 必须失败"
create_tmp=$(mktemp)
create_code=$(
  curl --max-time "$SMOKE_TIMEOUT" \
    --show-error \
    --silent \
    -o "$create_tmp" \
    -w '%{http_code}' \
    -X POST \
    "${SMOKE_AUTH[@]}" \
    -d '{"name":"Smoke missing key from official template"}' \
    "$SMOKE_HOST/api/infra-agent-runtime-profiles/templates/anthropic-official-claude-sonnet-4/profiles"
)
create_resp=$(cat "$create_tmp")
rm -f "$create_tmp"
smoke_assert_eq "$create_code" "400" "CreateFromTemplate.httpStatus"
smoke_assert_eq "$(printf '%s' "$create_resp" | jq -r '.success')" "false" "CreateFromTemplate.success"
smoke_assert_eq "$(printf '%s' "$create_resp" | jq -r '.error.code // ""')" "api_key_required" "CreateFromTemplate.error.code"
smoke_ok "missing API key rejected before profile creation"

smoke_step "GET adapter compatibility"
compat_resp=$(smoke_get /api/infra-agent-runtime-profiles/adapter-compatibility)
smoke_assert_eq "$(printf '%s' "$compat_resp" | jq -r '.success')" "true" "success"
smoke_ok "adapter compatibility API 可访问"

smoke_step "确认官方 SDK 与 Codex-like 边界"
official=$(printf '%s' "$compat_resp" | jq -c '.data.items[]? | select(.id == "claude-agent-sdk")')
smoke_assert_nonempty "$official" "claude-agent-sdk compatibility"
smoke_assert_eq "$(printf '%s' "$official" | jq -r '.loopOwner')" "claude-agent-sdk" "official.loopOwner"
smoke_assert_eq "$(printf '%s' "$official" | jq -r '.mapRole')" "control-plane-only" "official.mapRole"
incompatible_count=$(printf '%s' "$official" | jq -r '[.knownIncompatibleProfilePatterns[]? | select(test("deepseek"; "i"))] | length')
smoke_assert_eq "$incompatible_count" "1" "official.deepseekIncompatiblePattern"
codex=$(printf '%s' "$compat_resp" | jq -c '.data.items[]? | select(.id == "codex")')
smoke_assert_nonempty "$codex" "codex compatibility"
smoke_assert_eq "$(printf '%s' "$codex" | jq -r '.status')" "planned-not-routable" "codex.status"
smoke_ok "official SDK default-supported; codex planned-not-routable"

smoke_done
