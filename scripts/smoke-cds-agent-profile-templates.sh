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

smoke_step "确认官方 SDK 与其他候选 adapter 边界"
official=$(printf '%s' "$compat_resp" | jq -c '.data.items[]? | select(.id == "claude-agent-sdk")')
smoke_assert_nonempty "$official" "claude-agent-sdk compatibility"
smoke_assert_eq "$(printf '%s' "$official" | jq -r '.loopOwner')" "claude-agent-sdk" "official.loopOwner"
smoke_assert_eq "$(printf '%s' "$official" | jq -r '.mapRole')" "control-plane-only" "official.mapRole"
smoke_assert_eq "$(printf '%s' "$official" | jq -r '.routableByDefault')" "true" "official.routableByDefault"
smoke_assert_contains "$(printf '%s' "$official" | jq -r '.requiredEvidenceGates[]?')" "S1" "official.requiredEvidenceGates"
incompatible_count=$(printf '%s' "$official" | jq -r '[.knownIncompatibleProfilePatterns[]? | select(test("deepseek"; "i"))] | length')
smoke_assert_eq "$incompatible_count" "1" "official.deepseekIncompatiblePattern"
codex=$(printf '%s' "$compat_resp" | jq -c '.data.items[]? | select(.id == "codex")')
smoke_assert_nonempty "$codex" "codex compatibility"
smoke_assert_eq "$(printf '%s' "$codex" | jq -r '.status')" "planned-not-routable" "codex.status"
smoke_assert_eq "$(printf '%s' "$codex" | jq -r '.routableByDefault')" "false" "codex.routableByDefault"
smoke_assert_contains "$(printf '%s' "$codex" | jq -r '.missingAdapterContracts[]?')" "tool-approval" "codex.missingAdapterContracts"
openai_agents=$(printf '%s' "$compat_resp" | jq -c '.data.items[]? | select(.id == "openai-agents-sdk")')
smoke_assert_nonempty "$openai_agents" "openai-agents-sdk compatibility"
smoke_assert_eq "$(printf '%s' "$openai_agents" | jq -r '.status')" "planned-not-routable" "openai-agents-sdk.status"
smoke_assert_eq "$(printf '%s' "$openai_agents" | jq -r '.mapRole')" "control-plane-only" "openai-agents-sdk.mapRole"
smoke_assert_eq "$(printf '%s' "$openai_agents" | jq -r '.routableByDefault')" "false" "openai-agents-sdk.routableByDefault"
smoke_assert_contains "$(printf '%s' "$openai_agents" | jq -r '.supportedTaskKinds[]?')" "non-code-orchestration-candidate" "openai-agents-sdk.supportedTaskKinds"
smoke_assert_contains "$(printf '%s' "$openai_agents" | jq -r '.missingAdapterContracts[]?')" "map-approval-bridge" "openai-agents-sdk.missingAdapterContracts"
openai_actions=$(printf '%s' "$openai_agents" | jq -r '.nextActions[]?')
smoke_assert_contains "$openai_actions" "S1/S2/S3" "openai-agents-sdk.nextActions"
google_adk=$(printf '%s' "$compat_resp" | jq -c '.data.items[]? | select(.id == "google-adk")')
smoke_assert_nonempty "$google_adk" "google-adk compatibility"
smoke_assert_eq "$(printf '%s' "$google_adk" | jq -r '.status')" "planned-not-routable" "google-adk.status"
smoke_assert_eq "$(printf '%s' "$google_adk" | jq -r '.loopOwner')" "google-adk" "google-adk.loopOwner"
smoke_assert_eq "$(printf '%s' "$google_adk" | jq -r '.routableByDefault')" "false" "google-adk.routableByDefault"
smoke_assert_contains "$(printf '%s' "$google_adk" | jq -r '.missingAdapterContracts[]?')" "artifact" "google-adk.missingAdapterContracts"
google_actions=$(printf '%s' "$google_adk" | jq -r '.nextActions[]?')
smoke_assert_contains "$google_actions" "不要把代码审查任务默认路由到 google-adk" "google-adk.nextActions"
smoke_ok "official SDK default-supported; codex/openai-agents-sdk/google-adk planned-not-routable"

smoke_done
