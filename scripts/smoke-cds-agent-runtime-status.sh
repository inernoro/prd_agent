#!/usr/bin/env bash
# ============================================
# 冒烟测试: CDS Agent runtime pool / official SDK readiness
# ============================================
#
# 目标:
#   1. 验证 MAP /api/infra-agent-sessions/runtime-status 可通过真实鉴权访问
#   2. 验证 MAP 已发现至少一个 sidecar runtime 实例
#   3. 验证 healthyCount > 0，且 healthy 语义来自 /readyz
#   4. 验证期望 adapter 是官方 claude-agent-sdk，并尽量确认实例 loopOwner
#
# 前置:
#   - prd-api 已配置 AI_ACCESS_KEY smoke 鉴权
#   - 已配置共享 CDS discovery，或设置静态 sidecar 旁路:
#       CLAUDE_SIDECAR_BASE_URL=http://127.0.0.1:7400
#       CLAUDE_SIDECAR_TOKEN=<SIDECAR_TOKEN>
#   - sidecar /readyz 返回 agentAdapter=claude-agent-sdk 且 loopOwner=claude-agent-sdk
# ============================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=smoke-lib.sh
source "$SCRIPT_DIR/smoke-lib.sh"

SMOKE_STEP_TOTAL=5
smoke_init "CDS Agent Runtime Status"

smoke_step "GET runtime-status?refreshDiscovery=true"
resp=$(smoke_get "/api/infra-agent-sessions/runtime-status?refreshDiscovery=true")
smoke_verbose "$resp"
success=$(printf '%s' "$resp" | jq -r '.success')
smoke_assert_eq "$success" "true" "ApiResponse.success"
smoke_ok "runtime-status API 可访问"

smoke_step "确认期望 adapter 与 transport"
desired_adapter=$(smoke_get_data "$resp" '.diagnostics.desiredRuntimeAdapter // ""')
runtime_transport=$(smoke_get_data "$resp" '.diagnostics.runtimeTransport // ""')
smoke_assert_eq "$desired_adapter" "claude-agent-sdk" "diagnostics.desiredRuntimeAdapter"
smoke_assert_eq "$runtime_transport" "sidecar-runtime-adapter" "diagnostics.runtimeTransport"
smoke_ok "adapter=$desired_adapter transport=$runtime_transport"

smoke_step "确认 MAP 已发现 sidecar 实例"
instance_count=$(smoke_get_data "$resp" '.diagnostics.instanceCount // 0')
if (( instance_count <= 0 )); then
  blockers=$(smoke_get_data "$resp" '.diagnostics.blockers // [] | join(" | ")')
  next_actions=$(smoke_get_data "$resp" '.diagnostics.nextActions // [] | join(" | ")')
  smoke_fail "instanceCount=$instance_count；blockers=$blockers；next=$next_actions"
fi
smoke_ok "instanceCount=$instance_count"

smoke_step "确认至少一个实例 readyz healthy"
healthy_count=$(smoke_get_data "$resp" '.diagnostics.healthyCount // 0')
if (( healthy_count <= 0 )); then
  blockers=$(smoke_get_data "$resp" '.diagnostics.blockers // [] | join(" | ")')
  readyz=$(smoke_get_data "$resp" '.diagnostics.instances // [] | map({name, httpStatus, ready, readyzBlockers, readyzNextActions})')
  smoke_fail "healthyCount=$healthy_count；blockers=$blockers；readyz=$readyz"
fi
smoke_ok "healthyCount=$healthy_count"

smoke_step "确认实例 loopOwner 指向官方 SDK"
official_instances=$(smoke_get_data "$resp" '[.diagnostics.instances[]? | select((.agentAdapter // "") == "claude-agent-sdk" or (.loopOwner // "") == "claude-agent-sdk")] | length')
if (( official_instances <= 0 )); then
  summary=$(smoke_get_data "$resp" '.diagnostics.instances // [] | map({name, source, agentAdapter, loopOwner, sdkLoopEnabled})')
  smoke_fail "未发现 claude-agent-sdk 实例；instances=$summary"
fi
smoke_ok "officialSdkInstances=$official_instances"

smoke_done
