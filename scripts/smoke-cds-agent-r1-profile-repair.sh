#!/usr/bin/env bash
# ============================================
# 冒烟测试: CDS Agent R1 runtime profile repair
# ============================================
#
# 目标:
#   1. 验证 runtime-status 暴露的 R1 修复计划与后端 Anthropic 官方模板一致。
#   2. 未提供 SMOKE_CDS_AGENT_ANTHROPIC_API_KEY 时只做 dry-run，确认不会创建缺 key profile。
#   3. 提供 SMOKE_CDS_AGENT_ANTHROPIC_API_KEY 时，通过官方模板创建默认 Claude profile，
#      再验证 runtime-status 的 R1 gate 变为 pass。
#
# 默认不消耗 provider token；只有显式提供 SMOKE_CDS_AGENT_ANTHROPIC_API_KEY 才会写入
# 一个新的默认 runtime profile。
# ============================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=smoke-lib.sh
source "$SCRIPT_DIR/smoke-lib.sh"

SMOKE_STEP_TOTAL=6
smoke_init "CDS Agent R1 Runtime Profile Repair"

target_template_id="anthropic-official-claude-sonnet-4"

smoke_step "读取 runtime-status R1 修复计划"
runtime_resp=$(smoke_get "/api/infra-agent-sessions/runtime-status?refreshDiscovery=true")
smoke_verbose "$runtime_resp"
smoke_assert_eq "$(printf '%s' "$runtime_resp" | jq -r '.success')" "true" "RuntimeStatus.success"
repair_plan=$(printf '%s' "$runtime_resp" | jq -c '.data.diagnostics.runtimeProfileRepairPlan // empty')
smoke_assert_nonempty "$repair_plan" "diagnostics.runtimeProfileRepairPlan"
smoke_assert_eq "$(printf '%s' "$repair_plan" | jq -r '.gate')" "R1" "runtimeProfileRepairPlan.gate"
smoke_assert_eq "$(printf '%s' "$repair_plan" | jq -r '.targetTemplateId')" "$target_template_id" "runtimeProfileRepairPlan.targetTemplateId"
smoke_assert_eq "$(printf '%s' "$repair_plan" | jq -r '.targetProtocol')" "anthropic" "runtimeProfileRepairPlan.targetProtocol"
smoke_ok "R1 repair plan is backend-owned"

smoke_step "确认目标模板可用"
templates_resp=$(smoke_get "/api/infra-agent-runtime-profiles/templates")
template=$(printf '%s' "$templates_resp" | jq -c --arg id "$target_template_id" '.data.items[]? | select(.id == $id)')
smoke_assert_nonempty "$template" "target runtime profile template"
smoke_assert_eq "$(printf '%s' "$template" | jq -r '.protocol')" "anthropic" "template.protocol"
smoke_assert_eq "$(printf '%s' "$template" | jq -r '.baseUrl')" "https://api.anthropic.com" "template.baseUrl"
smoke_assert_contains "$(printf '%s' "$template" | jq -r '.compatibleRuntimeAdapters[]?')" "claude-agent-sdk" "template.compatibleRuntimeAdapters"
smoke_ok "target template is compatible with claude-agent-sdk"

smoke_step "检查当前 R1 gate"
current_r1=$(printf '%s' "$runtime_resp" | jq -c '.data.diagnostics.commercialReadiness.gates[]? | select(.code == "R1")')
smoke_assert_nonempty "$current_r1" "commercialReadiness.R1"
current_r1_status=$(printf '%s' "$current_r1" | jq -r '.status')
default_profile=$(printf '%s' "$runtime_resp" | jq -c '.data.diagnostics.defaultRuntimeProfile // empty')
if [[ "$current_r1_status" == "pass" ]]; then
  smoke_ok "R1 already pass"
  smoke_step "跳过缺 key dry-run"
  smoke_ok "not applicable"
  smoke_step "跳过创建默认 profile"
  smoke_ok "not applicable"
  smoke_step "跳过修复后验证"
  smoke_ok "not applicable"
  smoke_done
  exit 0
fi
profile_label=$(printf '%s' "$default_profile" | jq -r '"\(.name // "missing") / \(.protocol // "unknown") / \(.model // "unknown")"')
printf 'Current default profile: %s\n' "$profile_label"
smoke_ok "R1 current status=$current_r1_status"

smoke_step "缺 API key 时模板创建必须失败"
missing_key_tmp=$(mktemp)
missing_key_code=$(
  curl --max-time "$SMOKE_TIMEOUT" \
    --show-error \
    --silent \
    -o "$missing_key_tmp" \
    -w '%{http_code}' \
    -X POST \
    "${SMOKE_AUTH[@]}" \
    -d '{"name":"Smoke R1 repair missing key","isDefault":true}' \
    "$SMOKE_HOST/api/infra-agent-runtime-profiles/templates/${target_template_id}/profiles"
)
missing_key_resp=$(cat "$missing_key_tmp")
rm -f "$missing_key_tmp"
smoke_assert_eq "$missing_key_code" "400" "CreateFromTemplateWithoutKey.httpStatus"
smoke_assert_eq "$(printf '%s' "$missing_key_resp" | jq -r '.success')" "false" "CreateFromTemplateWithoutKey.success"
smoke_assert_eq "$(printf '%s' "$missing_key_resp" | jq -r '.error.code // ""')" "api_key_required" "CreateFromTemplateWithoutKey.error.code"
smoke_ok "missing API key is rejected before profile creation"

smoke_step "按需创建 Anthropic 官方默认 profile"
if [[ -z "${SMOKE_CDS_AGENT_ANTHROPIC_API_KEY:-}" ]]; then
  smoke_ok "dry-run only: set SMOKE_CDS_AGENT_ANTHROPIC_API_KEY to execute R1 repair"
  smoke_step "跳过修复后验证"
  smoke_ok "not applicable without SMOKE_CDS_AGENT_ANTHROPIC_API_KEY"
  smoke_done
  exit 0
fi

repair_body=$(mktemp)
repair_resp_tmp=$(mktemp)
repair_name="Smoke R1 Claude default $(date +%Y%m%d%H%M%S)"
SMOKE_R1_REPAIR_NAME="$repair_name" SMOKE_R1_ANTHROPIC_API_KEY="$SMOKE_CDS_AGENT_ANTHROPIC_API_KEY" \
  jq -n '{name: env.SMOKE_R1_REPAIR_NAME, apiKey: env.SMOKE_R1_ANTHROPIC_API_KEY, isDefault: true}' > "$repair_body"
repair_code=$(
  curl --max-time "$SMOKE_TIMEOUT" \
    --show-error \
    --silent \
    -o "$repair_resp_tmp" \
    -w '%{http_code}' \
    -X POST \
    "${SMOKE_AUTH[@]}" \
    --data-binary @"$repair_body" \
    "$SMOKE_HOST/api/infra-agent-runtime-profiles/templates/${target_template_id}/profiles"
)
rm -f "$repair_body"
repair_resp=$(cat "$repair_resp_tmp")
rm -f "$repair_resp_tmp"
smoke_assert_eq "$repair_code" "201" "CreateFromTemplate.httpStatus"
smoke_assert_eq "$(printf '%s' "$repair_resp" | jq -r '.success')" "true" "CreateFromTemplate.success"
created_profile=$(printf '%s' "$repair_resp" | jq -c '.data.item // empty')
smoke_assert_nonempty "$created_profile" "created profile"
smoke_assert_eq "$(printf '%s' "$created_profile" | jq -r '.isDefault')" "true" "createdProfile.isDefault"
smoke_assert_eq "$(printf '%s' "$created_profile" | jq -r '.protocol')" "anthropic" "createdProfile.protocol"
smoke_assert_eq "$(printf '%s' "$created_profile" | jq -r '.hasApiKey')" "true" "createdProfile.hasApiKey"
smoke_ok "created default Anthropic profile"

smoke_step "验证 R1 gate 已修复"
after_resp=$(smoke_get "/api/infra-agent-sessions/runtime-status?refreshDiscovery=true")
after_r1=$(printf '%s' "$after_resp" | jq -c '.data.diagnostics.commercialReadiness.gates[]? | select(.code == "R1")')
smoke_assert_nonempty "$after_r1" "commercialReadiness.R1.afterRepair"
smoke_assert_eq "$(printf '%s' "$after_r1" | jq -r '.status')" "pass" "R1.status.afterRepair"
after_default=$(printf '%s' "$after_resp" | jq -c '.data.diagnostics.defaultRuntimeProfile // empty')
smoke_assert_eq "$(printf '%s' "$after_default" | jq -r '.protocol')" "anthropic" "defaultProfile.protocol.afterRepair"
smoke_assert_eq "$(printf '%s' "$after_default" | jq -r '.hasApiKey')" "true" "defaultProfile.hasApiKey.afterRepair"
smoke_assert_eq "$(printf '%s' "$after_default" | jq -r '.compatibleWithDesiredRuntimeAdapter')" "true" "defaultProfile.compatible.afterRepair"
smoke_ok "R1 default profile is ready for provider smokes"

smoke_done
