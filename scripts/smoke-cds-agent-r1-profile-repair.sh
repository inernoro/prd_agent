#!/usr/bin/env bash
# ============================================
# 冒烟测试: CDS Agent R1 runtime profile repair
# ============================================
#
# 目标:
#   1. 验证 runtime-status 暴露的 R1 修复计划与后端 Anthropic 官方模板一致。
#   2. 未提供 SMOKE_CDS_AGENT_ANTHROPIC_API_KEY 时只做 dry-run，确认不会创建缺 key
#      profile，且非 Anthropic 官方 key 形态会被后端拒绝。
#   3. 提供 SMOKE_CDS_AGENT_ANTHROPIC_API_KEY 时，调用后端专用入口，由 MAP 后端
#      创建非默认候选 profile、调用 test 验证上游可用、成功后提升为默认 Claude
#      profile，最后验证 runtime-status 的 R1 gate 变为 pass。
#
# 默认不消耗 provider token；只有显式提供 SMOKE_CDS_AGENT_ANTHROPIC_API_KEY 才会写入
# 一个新的 runtime profile；后端上游 test 成功前不会提升为默认。
#
# 环境变量:
#   SMOKE_CDS_AGENT_R1_REPORT=/tmp/r1.json  可选: 输出 R1 修复证据 JSON
# ============================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=smoke-lib.sh
source "$SCRIPT_DIR/smoke-lib.sh"

SMOKE_STEP_TOTAL=9
smoke_init "CDS Agent R1 Runtime Profile Repair"

target_template_id="anthropic-official-claude-sonnet-4"
candidate_profile_id=""
candidate_promoted=""
SMOKE_CDS_AGENT_R1_REPORT="${SMOKE_CDS_AGENT_R1_REPORT:-}"

write_r1_report() {
  [[ -z "$SMOKE_CDS_AGENT_R1_REPORT" ]] && return
  local status="$1"
  local evidence_json="${2:-{}}"
  local remote_prefix=""
  if [[ -n "${CDS_HOST:-}" ]]; then
    remote_prefix="CDS_HOST=${CDS_HOST} "
  fi
  jq -n \
    --arg status "$status" \
    --arg host "$SMOKE_HOST" \
    --arg targetTemplateId "$target_template_id" \
    --arg dryRunCommand "${remote_prefix}bash scripts/smoke-cds-agent-r1-profile-repair.sh" \
    --arg repairOnlyCommand "${remote_prefix}SMOKE_CDS_AGENT_ANTHROPIC_API_KEY=<sk-ant-...> bash scripts/smoke-cds-agent-r1-profile-repair.sh" \
    --arg repairAndProviderCycleCommand "${remote_prefix}SMOKE_CDS_AGENT_ANTHROPIC_API_KEY=<sk-ant-...> SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 bash scripts/smoke-cds-agent-one-cycle.sh" \
    --arg evidenceRaw "$evidence_json" \
    '{
      status: $status,
      host: $host,
      targetTemplateId: $targetTemplateId,
      suggestedCommand: $repairAndProviderCycleCommand,
      suggestedRepairCommand: $repairOnlyCommand,
      nextCommands: {
        dryRun: $dryRunCommand,
        repairOnly: $repairOnlyCommand,
        repairAndProviderCycle: $repairAndProviderCycleCommand
      },
      evidence: (
        $evidenceRaw
        | fromjson?
          // (sub("}$"; "") | fromjson?)
          // { reportError: "invalid evidence json", rawEvidence: $evidenceRaw }
      )
    }' > "$SMOKE_CDS_AGENT_R1_REPORT"
  smoke_assert_contains "$(jq -r '.nextCommands.dryRun // ""' "$SMOKE_CDS_AGENT_R1_REPORT")" "bash scripts/smoke-cds-agent-r1-profile-repair.sh" "R1Report.nextCommands.dryRun"
  smoke_assert_contains "$(jq -r '.nextCommands.repairOnly // ""' "$SMOKE_CDS_AGENT_R1_REPORT")" "SMOKE_CDS_AGENT_ANTHROPIC_API_KEY" "R1Report.nextCommands.repairOnly"
  smoke_assert_contains "$(jq -r '.nextCommands.repairOnly // ""' "$SMOKE_CDS_AGENT_R1_REPORT")" "smoke-cds-agent-r1-profile-repair.sh" "R1Report.nextCommands.repairOnly"
  smoke_assert_contains "$(jq -r '.nextCommands.repairAndProviderCycle // ""' "$SMOKE_CDS_AGENT_R1_REPORT")" "SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1" "R1Report.nextCommands.repairAndProviderCycle"
  smoke_assert_contains "$(jq -r '.nextCommands.repairAndProviderCycle // ""' "$SMOKE_CDS_AGENT_R1_REPORT")" "smoke-cds-agent-one-cycle.sh" "R1Report.nextCommands.repairAndProviderCycle"
  printf 'R1 report: %s\n' "$SMOKE_CDS_AGENT_R1_REPORT"
}

write_invalid_key_report() {
  [[ -z "$SMOKE_CDS_AGENT_R1_REPORT" ]] && return
  local evidence_json
  evidence_json=$(jq -n \
    --argjson currentR1 "$current_r1" \
    --argjson defaultProfile "$default_profile" \
    --argjson repairPlan "$repair_plan" \
    --argjson template "$template" \
    '{
      currentR1: $currentR1,
      defaultProfile: $defaultProfile,
      repairPlan: $repairPlan,
      targetTemplate: {
        id: ($template.id // ""),
        name: ($template.name // ""),
        protocol: ($template.protocol // ""),
        baseUrl: ($template.baseUrl // ""),
        model: ($template.model // ""),
        compatibleRuntimeAdapters: ($template.compatibleRuntimeAdapters // [])
      },
      providerKeyReceived: true,
      providerKeyFormat: {
        checked: true,
        accepted: false,
        requiredPrefix: "sk-ant-",
        message: "SMOKE_CDS_AGENT_ANTHROPIC_API_KEY must be an Anthropic API key beginning with sk-ant-. Do not use OpenRouter/OpenAI-compatible keys or MAP/CDS management credentials."
      }
    }')
  write_r1_report "invalid_anthropic_key_format" "$evidence_json"
}

assert_anthropic_key_shape() {
  local key="${SMOKE_CDS_AGENT_ANTHROPIC_API_KEY:-}"
  if [[ -z "$key" ]]; then
    return 0
  fi
  if [[ "$key" != sk-ant-* ]]; then
    write_invalid_key_report
    smoke_fail "SMOKE_CDS_AGENT_ANTHROPIC_API_KEY must start with sk-ant-; refusing to send a non-Anthropic key to the R1 test-before-promote endpoint"
  fi
}

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
  already_ready_evidence=$(jq -n \
    --argjson currentR1 "$current_r1" \
    --argjson defaultProfile "$default_profile" \
    --argjson repairPlan "$repair_plan" \
    '{currentR1:$currentR1, defaultProfile:$defaultProfile, repairPlan:$repairPlan}')
  write_r1_report "already_pass" "$already_ready_evidence"
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
    "$SMOKE_HOST/api/infra-agent-runtime-profiles/templates/${target_template_id}/default-profile"
)
missing_key_resp=$(cat "$missing_key_tmp")
rm -f "$missing_key_tmp"
smoke_assert_eq "$missing_key_code" "400" "CreateFromTemplateWithoutKey.httpStatus"
smoke_assert_eq "$(printf '%s' "$missing_key_resp" | jq -r '.success')" "false" "CreateFromTemplateWithoutKey.success"
smoke_assert_eq "$(printf '%s' "$missing_key_resp" | jq -r '.error.code // ""')" "api_key_required" "CreateFromTemplateWithoutKey.error.code"
smoke_ok "missing API key is rejected before profile creation"

smoke_step "非 Anthropic 官方 key 形态必须被后端拒绝"
invalid_key_tmp=$(mktemp)
invalid_key_code=$(
  curl --max-time "$SMOKE_TIMEOUT" \
    --show-error \
    --silent \
    -o "$invalid_key_tmp" \
    -w '%{http_code}' \
    -X POST \
    "${SMOKE_AUTH[@]}" \
    -d '{"name":"Smoke R1 repair invalid key","apiKey":"sk-or-v1-not-anthropic","isDefault":true}' \
    "$SMOKE_HOST/api/infra-agent-runtime-profiles/templates/${target_template_id}/default-profile"
)
invalid_key_resp=$(cat "$invalid_key_tmp")
rm -f "$invalid_key_tmp"
smoke_assert_eq "$invalid_key_code" "400" "CreateFromTemplateInvalidKey.httpStatus"
smoke_assert_eq "$(printf '%s' "$invalid_key_resp" | jq -r '.success')" "false" "CreateFromTemplateInvalidKey.success"
smoke_assert_eq "$(printf '%s' "$invalid_key_resp" | jq -r '.error.code // ""')" "api_key_format_invalid" "CreateFromTemplateInvalidKey.error.code"
smoke_assert_contains "$(printf '%s' "$invalid_key_resp" | jq -r '.error.message // ""')" "sk-ant-" "CreateFromTemplateInvalidKey.error.message"
smoke_ok "non-Anthropic key shape is rejected before profile creation"

smoke_step "直接创建官方 Anthropic profile 也必须拒绝非官方 key"
direct_invalid_key_tmp=$(mktemp)
direct_invalid_key_code=$(
  curl --max-time "$SMOKE_TIMEOUT" \
    --show-error \
    --silent \
    -o "$direct_invalid_key_tmp" \
    -w '%{http_code}' \
    -X POST \
    "${SMOKE_AUTH[@]}" \
    -d '{"name":"Smoke direct invalid Anthropic key","runtime":"claude-sdk","protocol":"anthropic","baseUrl":"https://api.anthropic.com","model":"claude-sonnet-4-20250514","apiKey":"sk-or-v1-not-anthropic","isDefault":true}' \
    "$SMOKE_HOST/api/infra-agent-runtime-profiles"
)
direct_invalid_key_resp=$(cat "$direct_invalid_key_tmp")
rm -f "$direct_invalid_key_tmp"
smoke_assert_eq "$direct_invalid_key_code" "400" "CreateDirectInvalidAnthropicKey.httpStatus"
smoke_assert_eq "$(printf '%s' "$direct_invalid_key_resp" | jq -r '.success')" "false" "CreateDirectInvalidAnthropicKey.success"
smoke_assert_eq "$(printf '%s' "$direct_invalid_key_resp" | jq -r '.error.code // ""')" "api_key_format_invalid" "CreateDirectInvalidAnthropicKey.error.code"
smoke_assert_contains "$(printf '%s' "$direct_invalid_key_resp" | jq -r '.error.message // ""')" "sk-ant-" "CreateDirectInvalidAnthropicKey.error.message"
smoke_ok "direct official Anthropic profile creation rejects non-Anthropic key shape"

smoke_step "按需调用后端 R1 test-before-promote 入口"
if [[ -z "${SMOKE_CDS_AGENT_ANTHROPIC_API_KEY:-}" ]]; then
  dry_run_evidence=$(jq -n \
    --argjson currentR1 "$current_r1" \
    --argjson defaultProfile "$default_profile" \
    --argjson repairPlan "$repair_plan" \
    --argjson template "$template" \
    --argjson missingKeyResponse "$missing_key_resp" \
    --argjson invalidKeyResponse "$invalid_key_resp" \
    --argjson directInvalidKeyResponse "$direct_invalid_key_resp" \
    '{
      currentR1: $currentR1,
      defaultProfile: $defaultProfile,
      repairPlan: $repairPlan,
      targetTemplate: {
        id: ($template.id // ""),
        name: ($template.name // ""),
        protocol: ($template.protocol // ""),
        baseUrl: ($template.baseUrl // ""),
        model: ($template.model // ""),
        compatibleRuntimeAdapters: ($template.compatibleRuntimeAdapters // [])
      },
      missingKeyGuard: {
        success: ($missingKeyResponse.success // null),
        errorCode: ($missingKeyResponse.error.code // "")
      },
      invalidKeyGuard: {
        success: ($invalidKeyResponse.success // null),
        errorCode: ($invalidKeyResponse.error.code // ""),
        message: ($invalidKeyResponse.error.message // "")
      },
      directInvalidKeyGuard: {
        success: ($directInvalidKeyResponse.success // null),
        errorCode: ($directInvalidKeyResponse.error.code // ""),
        message: ($directInvalidKeyResponse.error.message // "")
      },
      providerKeyReceived: false
    }')
  write_r1_report "dry_run_requires_api_key" "$dry_run_evidence"
  smoke_ok "dry-run only: set SMOKE_CDS_AGENT_ANTHROPIC_API_KEY to execute R1 repair"
  smoke_step "跳过后端上游测试和默认提升"
  smoke_ok "not applicable without SMOKE_CDS_AGENT_ANTHROPIC_API_KEY"
  smoke_step "跳过修复后验证"
  smoke_ok "not applicable without SMOKE_CDS_AGENT_ANTHROPIC_API_KEY"
  smoke_done
  exit 0
fi
assert_anthropic_key_shape

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
    "$SMOKE_HOST/api/infra-agent-runtime-profiles/templates/${target_template_id}/default-profile"
)
rm -f "$repair_body"
repair_resp=$(cat "$repair_resp_tmp")
rm -f "$repair_resp_tmp"
smoke_assert_eq "$repair_code" "201" "CreateDefaultFromTemplateAfterTest.httpStatus"
smoke_assert_eq "$(printf '%s' "$repair_resp" | jq -r '.success')" "true" "CreateDefaultFromTemplateAfterTest.success"
created_profile=$(printf '%s' "$repair_resp" | jq -c '.data.item // empty')
smoke_assert_nonempty "$created_profile" "created profile"
candidate_profile_id=$(printf '%s' "$created_profile" | jq -r '.id // ""')
smoke_assert_nonempty "$candidate_profile_id" "createdProfile.id"
smoke_assert_eq "$(printf '%s' "$created_profile" | jq -r '.isDefault')" "true" "createdProfile.isDefault"
smoke_assert_eq "$(printf '%s' "$created_profile" | jq -r '.protocol')" "anthropic" "createdProfile.protocol"
smoke_assert_eq "$(printf '%s' "$created_profile" | jq -r '.hasApiKey')" "true" "createdProfile.hasApiKey"
profile_test=$(printf '%s' "$repair_resp" | jq -c '.data.test // empty')
smoke_assert_nonempty "$profile_test" "profile test"
smoke_assert_eq "$(printf '%s' "$profile_test" | jq -r '.success')" "true" "profileTest.success"
candidate_promoted="1"
smoke_ok "backend tested and promoted default Anthropic profile"

smoke_step "确认后端返回上游测试结果"
smoke_assert_eq "$(printf '%s' "$profile_test" | jq -r '.protocol')" "anthropic" "profileTest.protocol"
smoke_assert_eq "$(printf '%s' "$profile_test" | jq -r '.model')" "claude-sonnet-4-20250514" "profileTest.model"
smoke_ok "profile test evidence is returned by backend"

smoke_step "验证 R1 gate 已修复"
after_resp=$(smoke_get "/api/infra-agent-sessions/runtime-status?refreshDiscovery=true")
after_r1=$(printf '%s' "$after_resp" | jq -c '.data.diagnostics.commercialReadiness.gates[]? | select(.code == "R1")')
smoke_assert_nonempty "$after_r1" "commercialReadiness.R1.afterRepair"
smoke_assert_eq "$(printf '%s' "$after_r1" | jq -r '.status')" "pass" "R1.status.afterRepair"
after_default=$(printf '%s' "$after_resp" | jq -c '.data.diagnostics.defaultRuntimeProfile // empty')
smoke_assert_eq "$(printf '%s' "$after_default" | jq -r '.protocol')" "anthropic" "defaultProfile.protocol.afterRepair"
smoke_assert_eq "$(printf '%s' "$after_default" | jq -r '.hasApiKey')" "true" "defaultProfile.hasApiKey.afterRepair"
smoke_assert_eq "$(printf '%s' "$after_default" | jq -r '.compatibleWithDesiredRuntimeAdapter')" "true" "defaultProfile.compatible.afterRepair"
pass_evidence=$(jq -n \
  --argjson beforeR1 "$current_r1" \
  --argjson beforeDefault "$default_profile" \
  --argjson createdProfile "$created_profile" \
  --argjson profileTest "$profile_test" \
  --argjson afterR1 "$after_r1" \
  --argjson afterDefault "$after_default" \
  '{
    beforeR1: $beforeR1,
    beforeDefaultProfile: $beforeDefault,
    createdProfile: {
      id: ($createdProfile.id // ""),
      name: ($createdProfile.name // ""),
      protocol: ($createdProfile.protocol // ""),
      model: ($createdProfile.model // ""),
      isDefault: ($createdProfile.isDefault // false),
      hasApiKey: ($createdProfile.hasApiKey // false)
    },
    profileTest: {
      success: ($profileTest.success // false),
      protocol: ($profileTest.protocol // ""),
      model: ($profileTest.model // "")
    },
    afterR1: $afterR1,
    afterDefaultProfile: $afterDefault
  }')
write_r1_report "pass" "$pass_evidence"
smoke_ok "R1 default profile is ready for provider smokes"

smoke_done
