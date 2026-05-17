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

SMOKE_STEP_TOTAL=5
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

smoke_step "输出 blocker 和下一步"
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
profiles_resp=$(smoke_get "/api/infra-agent-runtime-profiles")
smoke_verbose "$profiles_resp"
profiles_success=$(printf '%s' "$profiles_resp" | jq -r '.success')
smoke_assert_eq "$profiles_success" "true" "RuntimeProfiles.success"
default_profile=$(printf '%s' "$profiles_resp" | jq -c '.data.items[]? | select(.isDefault == true) | . ' | head -n 1)
if [[ -z "$default_profile" || "$default_profile" == "null" ]]; then
  printf 'Runtime profile: no default profile configured\n'
else
  profile_name=$(printf '%s' "$default_profile" | jq -r '.name // "unknown"')
  profile_runtime=$(printf '%s' "$default_profile" | jq -r '.runtime // "unknown"')
  profile_protocol=$(printf '%s' "$default_profile" | jq -r '.protocol // "unknown"')
  profile_model=$(printf '%s' "$default_profile" | jq -r '.model // "unknown"')
  profile_has_key=$(printf '%s' "$default_profile" | jq -r '.hasApiKey // false')
  printf 'Default profile: name=%s runtime=%s protocol=%s model=%s hasApiKey=%s\n' \
    "$profile_name" "$profile_runtime" "$profile_protocol" "$profile_model" "$profile_has_key"
  if [[ "$desired_adapter" == "claude-agent-sdk" && "$profile_model" != *claude* && "$profile_model" != anthropic/* ]]; then
    printf 'Profile warning: claude-agent-sdk 通常需要 Claude/Anthropic 兼容模型；当前默认模型可能只适合普通 OpenAI-compatible gateway。\n'
  fi
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
