#!/usr/bin/env bash
# ============================================
# 冒烟测试: CDS Agent R1 runtime profile repair
# ============================================
#
# 目标:
#   1. 验证 runtime-status 暴露的 R1 修复计划与后端 Anthropic 官方模板一致。
#   2. 未提供 SMOKE_CDS_AGENT_ANTHROPIC_API_KEY 时只做 dry-run，确认不会创建缺 key profile。
#   3. 提供 SMOKE_CDS_AGENT_ANTHROPIC_API_KEY 时，先通过官方模板创建非默认候选
#      profile，调用后端 test 验证上游可用，成功后再提升为默认 Claude profile，
#      最后验证 runtime-status 的 R1 gate 变为 pass。
#
# 默认不消耗 provider token；只有显式提供 SMOKE_CDS_AGENT_ANTHROPIC_API_KEY 才会写入
# 一个新的 runtime profile；上游 test 成功前不会提升为默认。
# ============================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=smoke-lib.sh
source "$SCRIPT_DIR/smoke-lib.sh"

SMOKE_STEP_TOTAL=7
smoke_init "CDS Agent R1 Runtime Profile Repair"

target_template_id="anthropic-official-claude-sonnet-4"
candidate_profile_id=""
candidate_promoted=""

cleanup_candidate_profile() {
  if [[ -n "$candidate_profile_id" && -z "$candidate_promoted" ]]; then
    smoke_delete "/api/infra-agent-runtime-profiles/${candidate_profile_id}" >/dev/null 2>&1 || true
  fi
}
trap cleanup_candidate_profile EXIT

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
  smoke_step "跳过创建候选 profile"
  smoke_ok "not applicable"
  smoke_step "跳过上游测试和默认提升"
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

smoke_step "按需创建 Anthropic 官方候选 profile"
if [[ -z "${SMOKE_CDS_AGENT_ANTHROPIC_API_KEY:-}" ]]; then
  smoke_ok "dry-run only: set SMOKE_CDS_AGENT_ANTHROPIC_API_KEY to execute R1 repair"
  smoke_step "跳过上游测试和默认提升"
  smoke_ok "not applicable without SMOKE_CDS_AGENT_ANTHROPIC_API_KEY"
  smoke_step "跳过修复后验证"
  smoke_ok "not applicable without SMOKE_CDS_AGENT_ANTHROPIC_API_KEY"
  smoke_done
  exit 0
fi

repair_body=$(mktemp)
repair_resp_tmp=$(mktemp)
repair_name="Smoke R1 Claude candidate $(date +%Y%m%d%H%M%S)"
SMOKE_R1_REPAIR_NAME="$repair_name" SMOKE_R1_ANTHROPIC_API_KEY="$SMOKE_CDS_AGENT_ANTHROPIC_API_KEY" \
  jq -n '{name: env.SMOKE_R1_REPAIR_NAME, apiKey: env.SMOKE_R1_ANTHROPIC_API_KEY, isDefault: false}' > "$repair_body"
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
candidate_profile_id=$(printf '%s' "$created_profile" | jq -r '.id // ""')
smoke_assert_nonempty "$candidate_profile_id" "createdProfile.id"
smoke_assert_eq "$(printf '%s' "$created_profile" | jq -r '.isDefault')" "false" "createdProfile.isDefault"
smoke_assert_eq "$(printf '%s' "$created_profile" | jq -r '.protocol')" "anthropic" "createdProfile.protocol"
smoke_assert_eq "$(printf '%s' "$created_profile" | jq -r '.hasApiKey')" "true" "createdProfile.hasApiKey"
smoke_ok "created non-default Anthropic candidate profile"

smoke_step "测试候选 profile 并提升为默认"
test_resp=$(smoke_post "/api/infra-agent-runtime-profiles/${candidate_profile_id}/test" '{}')
smoke_verbose "$test_resp"
smoke_assert_eq "$(printf '%s' "$test_resp" | jq -r '.success')" "true" "ProfileTest.response.success"
profile_test_success=$(printf '%s' "$test_resp" | jq -r '.data.result.success')
profile_test_message=$(printf '%s' "$test_resp" | jq -r '.data.result.message // ""')
if [[ "$profile_test_success" != "true" ]]; then
  smoke_fail "candidate profile upstream test failed: $profile_test_message"
fi

promote_body=$(mktemp)
SMOKE_R1_ANTHROPIC_API_KEY="$SMOKE_CDS_AGENT_ANTHROPIC_API_KEY" \
  jq -n \
    --arg name "$(printf '%s' "$created_profile" | jq -r '.name')" \
    --arg runtime "$(printf '%s' "$created_profile" | jq -r '.runtime')" \
    --arg protocol "$(printf '%s' "$created_profile" | jq -r '.protocol')" \
    --arg baseUrl "$(printf '%s' "$created_profile" | jq -r '.baseUrl')" \
    --arg model "$(printf '%s' "$created_profile" | jq -r '.model')" \
    --arg networkPolicy "$(printf '%s' "$created_profile" | jq -r '.networkPolicy')" \
    --argjson resourceCpuCores "$(printf '%s' "$created_profile" | jq -r '.resourceCpuCores')" \
    --argjson resourceMemoryMb "$(printf '%s' "$created_profile" | jq -r '.resourceMemoryMb')" \
    --argjson timeoutSeconds "$(printf '%s' "$created_profile" | jq -r '.timeoutSeconds')" \
    --argjson autoCleanupMinutes "$(printf '%s' "$created_profile" | jq -r '.autoCleanupMinutes')" \
    '{
      name: $name,
      runtime: $runtime,
      protocol: $protocol,
      baseUrl: $baseUrl,
      model: $model,
      apiKey: env.SMOKE_R1_ANTHROPIC_API_KEY,
      resourceCpuCores: $resourceCpuCores,
      resourceMemoryMb: $resourceMemoryMb,
      timeoutSeconds: $timeoutSeconds,
      networkPolicy: $networkPolicy,
      autoCleanupMinutes: $autoCleanupMinutes,
      isDefault: true
    }' > "$promote_body"
promote_resp=$(smoke_put "/api/infra-agent-runtime-profiles/${candidate_profile_id}" "$(cat "$promote_body")")
rm -f "$promote_body"
smoke_verbose "$promote_resp"
smoke_assert_eq "$(printf '%s' "$promote_resp" | jq -r '.success')" "true" "PromoteProfile.success"
promoted_profile=$(printf '%s' "$promote_resp" | jq -c '.data.item // empty')
smoke_assert_nonempty "$promoted_profile" "promoted profile"
smoke_assert_eq "$(printf '%s' "$promoted_profile" | jq -r '.isDefault')" "true" "promotedProfile.isDefault"
candidate_promoted="1"
smoke_ok "candidate profile tested and promoted to default"

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
