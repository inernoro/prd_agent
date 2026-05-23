#!/usr/bin/env bash
# ============================================
# 冒烟测试: CDS Agent runtime pool / official SDK readiness
# ============================================
#
# 目标:
#   1. 验证 MAP /api/infra-agent-sessions/runtime-status 可通过真实鉴权访问
#   2. 验证 MAP 已发现至少一个 sidecar runtime 实例
#   3. 验证 R0 runtime 已被发现；如果 /readyz 只因缺 Anthropic key 不 healthy，
#      归类为 R1 provider/profile blocker，而不是 R0 capacity failure
#   4. 验证期望 adapter 是官方 claude-agent-sdk，并尽量确认实例 loopOwner
#   5. 验证 legacy loop 仍是 lazy explicit fallback，而不是默认路径依赖
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
SMOKE_CDS_AGENT_RUNTIME_STATUS_RETRIES="${SMOKE_CDS_AGENT_RUNTIME_STATUS_RETRIES:-3}"
SMOKE_CDS_AGENT_RUNTIME_STATUS_RETRY_SECONDS="${SMOKE_CDS_AGENT_RUNTIME_STATUS_RETRY_SECONDS:-3}"
SMOKE_CDS_AGENT_RUNTIME_STATUS_ALLOW_R1_BLOCKED="${SMOKE_CDS_AGENT_RUNTIME_STATUS_ALLOW_R1_BLOCKED:-1}"
smoke_init "CDS Agent Runtime Status"

smoke_step "GET runtime-status?refreshDiscovery=true"
resp=""
for attempt in $(seq 1 "$SMOKE_CDS_AGENT_RUNTIME_STATUS_RETRIES"); do
  resp=$(smoke_get "/api/infra-agent-sessions/runtime-status?refreshDiscovery=true")
  healthy_count_probe=$(smoke_get_data "$resp" '.diagnostics.healthyCount // 0')
  official_instances_probe=$(smoke_get_data "$resp" '[.diagnostics.instances[]? | select((.agentAdapter // "") == "claude-agent-sdk" or (.loopOwner // "") == "claude-agent-sdk")] | length')
  if (( healthy_count_probe > 0 && official_instances_probe > 0 )); then
    break
  fi
  if (( attempt < SMOKE_CDS_AGENT_RUNTIME_STATUS_RETRIES )); then
    printf 'runtime-status not ready yet (attempt %s/%s, healthy=%s official=%s), retrying in %ss...\n' \
      "$attempt" "$SMOKE_CDS_AGENT_RUNTIME_STATUS_RETRIES" "$healthy_count_probe" "$official_instances_probe" "$SMOKE_CDS_AGENT_RUNTIME_STATUS_RETRY_SECONDS"
    sleep "$SMOKE_CDS_AGENT_RUNTIME_STATUS_RETRY_SECONDS"
  fi
done
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
  smoke_fail "instanceCount=${instance_count}; blockers=${blockers}; next=${next_actions}"
fi
smoke_ok "instanceCount=${instance_count}"

smoke_step "确认至少一个实例 readyz healthy"
healthy_count=$(smoke_get_data "$resp" '.diagnostics.healthyCount // 0')
if (( healthy_count <= 0 )); then
  blockers=$(smoke_get_data "$resp" '.diagnostics.blockers // [] | join(" | ")')
  readyz=$(smoke_get_data "$resp" '.diagnostics.instances // [] | map({name, httpStatus, ready, readyzBlockers, readyzNextActions})')
  official_instances_for_r1=$(smoke_get_data "$resp" '
    [.diagnostics.instances[]?
      | select(
          (.agentAdapter // "") == "claude-agent-sdk"
          or (.loopOwner // "") == "claude-agent-sdk"
          or (.source // "") == "cds-pairing"
          or ((.name // "") | test("shared-sidecar-pool|cds-pairing"; "i"))
        )
    ] | length
  ')
  r1_key_blocked_instances=$(smoke_get_data "$resp" '
    [.diagnostics.instances[]?
      | select(
          (.agentAdapter // "") == "claude-agent-sdk"
          or (.loopOwner // "") == "claude-agent-sdk"
          or (.source // "") == "cds-pairing"
          or ((.name // "") | test("shared-sidecar-pool|cds-pairing"; "i"))
        )
      | select(
          (((.readyzBlockers // []) | join(" ")) | test("ANTHROPIC_API_KEY|anthropicKey"; "i"))
          or (((.readyzNextActions // []) | join(" ")) | test("ANTHROPIC_API_KEY|anthropicKey"; "i"))
          or ((.readyzRaw // .readyz // .error // "" | tostring) | test("ANTHROPIC_API_KEY|anthropicKey"; "i"))
          or ((.message // "" | tostring) | test("ANTHROPIC_API_KEY|anthropicKey"; "i"))
        )
    ] | length
  ')
  global_r1_key_blocked=false
  if printf '%s' "$blockers" | grep -Eiq 'ANTHROPIC_API_KEY|anthropicKey'; then
    global_r1_key_blocked=true
  fi
  if [[ "$SMOKE_CDS_AGENT_RUNTIME_STATUS_ALLOW_R1_BLOCKED" == "1" ]] \
    && (( official_instances_for_r1 > 0 )) \
    && { (( r1_key_blocked_instances > 0 )) || [[ "$global_r1_key_blocked" == "true" ]]; }; then
    smoke_ok "healthyCount=0 because official SDK runtime is blocked by R1 Anthropic key/profile; treating R0 runtime discovery as pass"
  else
    smoke_fail "healthyCount=${healthy_count}; blockers=${blockers}; readyz=${readyz}"
  fi
else
  smoke_ok "healthyCount=${healthy_count}"
fi

smoke_step "确认实例 loopOwner 指向官方 SDK"
official_instances=$(smoke_get_data "$resp" '
  [.diagnostics.instances[]?
    | select(
        (.agentAdapter // "") == "claude-agent-sdk"
        or (.loopOwner // "") == "claude-agent-sdk"
        or (.source // "") == "cds-pairing"
        or ((.name // "") | test("shared-sidecar-pool|cds-pairing"; "i"))
      )
  ] | length
')
if (( official_instances <= 0 )); then
  summary=$(smoke_get_data "$resp" '.diagnostics.instances // [] | map({name, source, agentAdapter, loopOwner, sdkLoopEnabled, legacyLoopImport})')
  smoke_fail "未发现 claude-agent-sdk 实例；instances=$summary"
fi
lazy_legacy_instances=$(smoke_get_data "$resp" '[.diagnostics.instances[]? | select((.agentAdapter // "") == "claude-agent-sdk" or (.loopOwner // "") == "claude-agent-sdk") | select((.legacyLoopImport // "") == "lazy-explicit-fallback")] | length')
if (( lazy_legacy_instances <= 0 )); then
  if [[ "$SMOKE_CDS_AGENT_RUNTIME_STATUS_ALLOW_R1_BLOCKED" == "1" ]] \
    && (( official_instances > 0 )) \
    && printf '%s' "$blockers" | grep -Eiq 'ANTHROPIC_API_KEY|anthropicKey'; then
    smoke_ok "official SDK runtime discovered via CDS pairing; loopOwner/legacy fallback samples are deferred until R1 key makes /readyz healthy"
  else
    summary=$(smoke_get_data "$resp" '.diagnostics.instances // [] | map({name, source, agentAdapter, loopOwner, sdkLoopEnabled, legacyLoopImport})')
    smoke_fail "未发现 legacyLoopImport=lazy-explicit-fallback 的官方 SDK 实例；instances=$summary"
  fi
else
  smoke_ok "officialSdkInstances=$official_instances lazyLegacyFallbackInstances=$lazy_legacy_instances"
fi

smoke_done
