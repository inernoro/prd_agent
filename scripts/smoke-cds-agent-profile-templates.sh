#!/usr/bin/env bash
# ============================================
# CDS Agent runtime profile templates smoke
# ============================================
#
# 验证 MAP 后端是 runtime profile 模板的事实源：
#   - 暴露 Anthropic official Claude Agent SDK 模板
#   - 模板协议/baseUrl/model 与官方 SDK adapter 兼容
#
# 环境变量同 scripts/smoke-lib.sh。
# ============================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=smoke-lib.sh
source "$SCRIPT_DIR/smoke-lib.sh"

SMOKE_STEP_TOTAL=3
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

smoke_done
