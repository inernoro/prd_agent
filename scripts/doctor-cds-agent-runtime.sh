#!/usr/bin/env bash
# ============================================
# 诊断: CDS Agent runtime pool / official SDK readiness
# ============================================
#
# 与 smoke-cds-agent-runtime-status.sh 不同，doctor 不把 instanceCount=0
# 当成脚本自身失败。它用于把 runtime-status 的 blocker/nextActions
# 分层输出，方便定位是 MAP 配置、CDS discovery、sidecar readyz、
# provider key 还是 adapter loop ownership 问题。
#
# 环境变量同 smoke-lib.sh:
#   SMOKE_TEST_HOST  目标服务根 URL
#   AI_ACCESS_KEY    prd-api X-AI-Access-Key
#   SMOKE_USER       impersonate 用户，默认 admin
#   SMOKE_VERBOSE=1  额外输出完整 runtime-status JSON
# ============================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=smoke-lib.sh
source "$SCRIPT_DIR/smoke-lib.sh"

SMOKE_STEP_TOTAL=8
smoke_init "CDS Agent Runtime Doctor"

smoke_step "读取 runtime-status"
resp=$(smoke_get "/api/infra-agent-sessions/runtime-status?refreshDiscovery=true")
smoke_verbose "$resp"
success=$(printf '%s' "$resp" | jq -r '.success')
smoke_assert_eq "$success" "true" "ApiResponse.success"
smoke_ok "runtime-status API 可访问"

smoke_step "汇总运行时边界"
summary=$(printf '%s' "$resp" | jq -r '
  .data.diagnostics as $d |
  [
    "desiredRuntimeAdapter=\($d.desiredRuntimeAdapter // "unknown")",
    "runtimeTransport=\($d.runtimeTransport // "unknown")",
    "instanceCount=\($d.instanceCount // 0)",
    "healthyCount=\($d.healthyCount // 0)"
  ] | join(" ")
')
printf '%s\n' "$summary"
desired_adapter=$(smoke_get_data "$resp" '.diagnostics.desiredRuntimeAdapter // ""')
runtime_instance_count=$(smoke_get_data "$resp" '.diagnostics.instanceCount // 0')
runtime_healthy_count=$(smoke_get_data "$resp" '.diagnostics.healthyCount // 0')

smoke_step "输出 blocker 和 runtime-status 下一步"
blocker_count=$(smoke_get_data "$resp" '.diagnostics.blockers // [] | length')
next_count=$(smoke_get_data "$resp" '.diagnostics.nextActions // [] | length')
if (( blocker_count <= 0 )); then
  smoke_ok "未发现 runtime blocker"
else
  printf 'Blockers:\n'
  printf '%s' "$resp" | jq -r '.data.diagnostics.blockers[]? | "  - " + .'
fi

if (( next_count > 0 )); then
  printf 'Next actions:\n'
  printf '%s' "$resp" | jq -r '.data.diagnostics.nextActions[]? | "  - " + .'
fi

smoke_step "输出实例 readyz 摘要"
instance_count=$(smoke_get_data "$resp" '.diagnostics.instanceCount // 0')
if (( instance_count <= 0 )); then
  printf 'Instances: none\n'
else
  printf '%s' "$resp" | jq -r '
    .data.diagnostics.instances[]? |
    [
      "  - name=\(.name // "unknown")",
      "source=\(.source // "unknown")",
      "ready=\(.ready // false)",
      "http=\(.httpStatus // "n/a")",
      "agentAdapter=\(.agentAdapter // "unknown")",
      "loopOwner=\(.loopOwner // "unknown")",
      "sdkLoopEnabled=\(.sdkLoopEnabled // false)"
    ] | join(" ")
  '
  printf '%s' "$resp" | jq -r '
    .data.diagnostics.instances[]? |
    select((.readyzBlockers // []) | length > 0) |
    "    readyzBlockers(" + (.name // "unknown") + "): " + ((.readyzBlockers // []) | join(" | "))
  '
  printf '%s' "$resp" | jq -r '
    .data.diagnostics.instances[]? |
    select((.readyzNextActions // []) | length > 0) |
    "    readyzNextActions(" + (.name // "unknown") + "): " + ((.readyzNextActions // []) | join(" | "))
  '
fi

smoke_step "检查默认 runtime profile 兼容性"
default_profile=$(printf '%s' "$resp" | jq -c '.data.diagnostics.defaultRuntimeProfile // empty')
if [[ -z "$default_profile" || "$default_profile" == "null" ]]; then
  profiles_resp=$(smoke_get "/api/infra-agent-runtime-profiles")
  smoke_verbose "$profiles_resp"
  profiles_success=$(printf '%s' "$profiles_resp" | jq -r '.success')
  smoke_assert_eq "$profiles_success" "true" "RuntimeProfiles.success"
  default_profile=$(printf '%s' "$profiles_resp" | jq -c '.data.items[]? | select(.isDefault == true) | . ' | head -n 1)
fi
if [[ -z "$default_profile" || "$default_profile" == "null" ]]; then
  printf 'Runtime profile: no default profile configured\n'
  profile_compatible="false"
  profile_has_key="false"
else
  profile_name=$(printf '%s' "$default_profile" | jq -r '.name // "unknown"')
  profile_runtime=$(printf '%s' "$default_profile" | jq -r '.runtime // "unknown"')
  profile_protocol=$(printf '%s' "$default_profile" | jq -r '.protocol // "unknown"')
  profile_model=$(printf '%s' "$default_profile" | jq -r '.model // "unknown"')
  profile_has_key=$(printf '%s' "$default_profile" | jq -r '.hasApiKey // false')
  profile_compatible=$(printf '%s' "$default_profile" | jq -r 'if has("compatibleWithDesiredRuntimeAdapter") then .compatibleWithDesiredRuntimeAdapter else true end')
  profile_warning=$(printf '%s' "$default_profile" | jq -r '.warning // ""')
  printf 'Default profile: name=%s runtime=%s protocol=%s model=%s hasApiKey=%s compatibleWithDesiredRuntimeAdapter=%s\n' \
    "$profile_name" "$profile_runtime" "$profile_protocol" "$profile_model" "$profile_has_key" "$profile_compatible"
  if [[ -n "$profile_warning" ]]; then
    printf 'Profile warning: %s\n' "$profile_warning"
  elif [[ "$desired_adapter" == "claude-agent-sdk" && "$profile_model" != *claude* && "$profile_model" != anthropic/* ]]; then
    printf 'Profile warning: claude-agent-sdk 通常需要 Claude/Anthropic 兼容模型；当前默认模型可能只适合普通 OpenAI-compatible gateway。\n'
  fi
fi

smoke_step "读取官方 profile 模板"
templates_resp=$(smoke_get /api/infra-agent-runtime-profiles/templates)
smoke_verbose "$templates_resp"
smoke_assert_eq "$(printf '%s' "$templates_resp" | jq -r '.success')" "true" "RuntimeProfileTemplates.success"
anthropic_template=$(printf '%s' "$templates_resp" | jq -c '.data.items[]? | select(.id == "anthropic-official-claude-sonnet-4")')
if [[ -z "$anthropic_template" || "$anthropic_template" == "null" ]]; then
  printf 'Anthropic official template: missing\n'
else
  template_id=$(printf '%s' "$anthropic_template" | jq -r '.id')
  template_name=$(printf '%s' "$anthropic_template" | jq -r '.name')
  template_model=$(printf '%s' "$anthropic_template" | jq -r '.model')
  template_base_url=$(printf '%s' "$anthropic_template" | jq -r '.baseUrl')
  template_protocol=$(printf '%s' "$anthropic_template" | jq -r '.protocol')
  template_adapters=$(printf '%s' "$anthropic_template" | jq -r '.compatibleRuntimeAdapters // [] | join(",")')
  printf 'Anthropic official template: id=%s name=%s protocol=%s model=%s baseUrl=%s compatibleAdapters=%s\n' \
    "$template_id" "$template_name" "$template_protocol" "$template_model" "$template_base_url" "$template_adapters"
fi

smoke_step "读取 adapter 兼容矩阵"
compat_resp=$(smoke_get /api/infra-agent-runtime-profiles/adapter-compatibility)
smoke_verbose "$compat_resp"
smoke_assert_eq "$(printf '%s' "$compat_resp" | jq -r '.success')" "true" "AdapterCompatibility.success"
official_adapter=$(printf '%s' "$compat_resp" | jq -c '.data.items[]? | select(.id == "claude-agent-sdk")')
legacy_adapter=$(printf '%s' "$compat_resp" | jq -c '.data.items[]? | select(.id == "legacy-sidecar")')
codex_adapter=$(printf '%s' "$compat_resp" | jq -c '.data.items[]? | select(.id == "codex")')
if [[ -n "$official_adapter" && "$official_adapter" != "null" ]]; then
  printf 'Adapter claude-agent-sdk: status=%s loopOwner=%s mapRole=%s supportedProtocols=%s incompatiblePatterns=%s\n' \
    "$(printf '%s' "$official_adapter" | jq -r '.status // "unknown"')" \
    "$(printf '%s' "$official_adapter" | jq -r '.loopOwner // "unknown"')" \
    "$(printf '%s' "$official_adapter" | jq -r '.mapRole // "unknown"')" \
    "$(printf '%s' "$official_adapter" | jq -r '.supportedProtocols // [] | join(",")')" \
    "$(printf '%s' "$official_adapter" | jq -r '.knownIncompatibleProfilePatterns // [] | join(",")')"
fi
if [[ -n "$legacy_adapter" && "$legacy_adapter" != "null" ]]; then
  printf 'Adapter legacy-sidecar: status=%s loopOwner=%s mapRole=%s\n' \
    "$(printf '%s' "$legacy_adapter" | jq -r '.status // "unknown"')" \
    "$(printf '%s' "$legacy_adapter" | jq -r '.loopOwner // "unknown"')" \
    "$(printf '%s' "$legacy_adapter" | jq -r '.mapRole // "unknown"')"
fi
if [[ -n "$codex_adapter" && "$codex_adapter" != "null" ]]; then
  printf 'Adapter codex: status=%s loopOwner=%s mapRole=%s\n' \
    "$(printf '%s' "$codex_adapter" | jq -r '.status // "unknown"')" \
    "$(printf '%s' "$codex_adapter" | jq -r '.loopOwner // "unknown"')" \
    "$(printf '%s' "$codex_adapter" | jq -r '.mapRole // "unknown"')"
fi

smoke_step "生成最小验收命令"
printf 'Recommended gates:\n'
printf '  - bash scripts/smoke-cds-agent-runtime-status.sh\n'
printf '  - bash scripts/smoke-cds-agent-profile-templates.sh\n'
printf '  - bash scripts/smoke-cds-agent-profile-preflight.sh\n'
printf '  - bash scripts/smoke-all.sh\n'

if [[ "$desired_adapter" != "claude-agent-sdk" ]]; then
  printf 'Next: 先把 MAP 期望 adapter 切到 claude-agent-sdk，再重跑 runtime-status。\n'
elif (( runtime_instance_count <= 0 || runtime_healthy_count <= 0 )); then
  printf 'Next: 先修 CDS sidecar discovery / static sidecar / readyz，再重跑 runtime-status。\n'
elif [[ "$profile_compatible" != "true" || "$profile_has_key" != "true" ]]; then
  printf 'Next: 在 /cds-agent 用 Anthropic official template 创建默认 profile，并填入真实 API key。\n'
  if [[ -n "${template_id:-}" ]]; then
    printf '      Template API: POST /api/infra-agent-runtime-profiles/templates/%s/profiles\n' "$template_id"
  fi
  printf '      配好后运行: SMOKE_CDS_AGENT_REQUIRE_COMPATIBLE=1 bash scripts/smoke-cds-agent-official-sdk-run.sh\n'
else
  printf 'Next: 默认 profile 已兼容；先跑 readiness，再显式打开 provider 调用做 S1/S2/S3。\n'
  printf '      SMOKE_CDS_AGENT_REQUIRE_COMPATIBLE=1 bash scripts/smoke-cds-agent-official-sdk-run.sh\n'
  printf '      SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 SMOKE_CDS_AGENT_REQUIRE_COMPATIBLE=1 bash scripts/smoke-cds-agent-official-sdk-run.sh\n'
  printf '      SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 SMOKE_CDS_AGENT_REQUIRE_COMPATIBLE=1 bash scripts/smoke-cds-agent-official-sdk-controls.sh\n'
fi

printf '\nDiagnosis: '
healthy_count=$(smoke_get_data "$resp" '.diagnostics.healthyCount // 0')
if [[ "$desired_adapter" != "claude-agent-sdk" ]]; then
  printf 'MAP 未期望官方 Claude Agent SDK adapter。\n'
elif (( instance_count <= 0 )); then
  printf 'MAP/CDS 控制面未发现可路由 sidecar 实例。\n'
elif (( healthy_count <= 0 )); then
  printf '已发现 sidecar，但 /readyz 未达到 healthy。\n'
else
  official_instances=$(smoke_get_data "$resp" '[.diagnostics.instances[]? | select((.agentAdapter // "") == "claude-agent-sdk" or (.loopOwner // "") == "claude-agent-sdk")] | length')
  if (( official_instances <= 0 )); then
    printf 'sidecar healthy，但 loopOwner 未证明为官方 SDK。\n'
  else
    printf 'runtime pool 已具备 official SDK adapter 最小运行前置条件。\n'
  fi
fi

smoke_done
