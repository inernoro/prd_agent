#!/usr/bin/env bash
# ============================================
# CDS Agent official SDK S1 run smoke
# ============================================
#
# 默认只做 readiness，不调用 provider，不消耗模型 token。
# 设置 SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 后，才会在默认 runtime profile
# 已兼容 claude-agent-sdk 时创建临时会话并发送只读审查 prompt。
#
# 环境变量:
#   SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1   允许真实调用 provider
#   SMOKE_CDS_AGENT_REQUIRE_COMPATIBLE=1    默认 profile 不兼容时失败；默认跳过
#   SMOKE_CDS_AGENT_REPO=inernoro/prd_agent 目标仓库
#   SMOKE_CDS_AGENT_REF=main                目标 ref
#   SMOKE_CDS_AGENT_POLL_SECONDS=120        等待 assistant 消息/失败状态秒数
# ============================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=smoke-lib.sh
source "$SCRIPT_DIR/smoke-lib.sh"

SMOKE_STEP_TOTAL=8
SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL="${SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL:-}"
SMOKE_CDS_AGENT_REQUIRE_COMPATIBLE="${SMOKE_CDS_AGENT_REQUIRE_COMPATIBLE:-}"
SMOKE_CDS_AGENT_REPO="${SMOKE_CDS_AGENT_REPO:-inernoro/prd_agent}"
SMOKE_CDS_AGENT_REF="${SMOKE_CDS_AGENT_REF:-main}"
SMOKE_CDS_AGENT_POLL_SECONDS="${SMOKE_CDS_AGENT_POLL_SECONDS:-120}"

created_session_id=""
cleanup_session() {
  if [[ -n "$created_session_id" ]]; then
    smoke_post "/api/infra-agent-sessions/${created_session_id}/archive" '{}' >/dev/null 2>&1 || true
  fi
}
trap cleanup_session EXIT

smoke_init "CDS Agent Official SDK S1 Run"

smoke_step "读取 runtime-status official SDK readiness"
runtime_resp=$(smoke_get "/api/infra-agent-sessions/runtime-status?refreshDiscovery=true")
smoke_verbose "$runtime_resp"
smoke_assert_eq "$(printf '%s' "$runtime_resp" | jq -r '.success')" "true" "RuntimeStatus.success"
desired_adapter=$(smoke_get_data "$runtime_resp" '.diagnostics.desiredRuntimeAdapter // ""')
runtime_transport=$(smoke_get_data "$runtime_resp" '.diagnostics.runtimeTransport // ""')
instance_count=$(smoke_get_data "$runtime_resp" '.diagnostics.instanceCount // 0')
healthy_count=$(smoke_get_data "$runtime_resp" '.diagnostics.healthyCount // 0')
smoke_assert_eq "$desired_adapter" "claude-agent-sdk" "diagnostics.desiredRuntimeAdapter"
smoke_assert_eq "$runtime_transport" "sidecar-runtime-adapter" "diagnostics.runtimeTransport"
if (( instance_count <= 0 || healthy_count <= 0 )); then
  blockers=$(smoke_get_data "$runtime_resp" '.diagnostics.blockers // [] | join(" | ")')
  next_actions=$(smoke_get_data "$runtime_resp" '.diagnostics.nextActions // [] | join(" | ")')
  smoke_fail "runtime pool not ready: instanceCount=${instance_count} healthyCount=${healthy_count}; blockers=${blockers}; next=${next_actions}"
fi
smoke_ok "adapter=$desired_adapter transport=$runtime_transport pool=${healthy_count}/${instance_count}"

smoke_step "读取默认 runtime profile 兼容性"
default_profile=$(printf '%s' "$runtime_resp" | jq -c '.data.diagnostics.defaultRuntimeProfile // empty')
smoke_assert_nonempty "$default_profile" "diagnostics.defaultRuntimeProfile"
profile_id=$(printf '%s' "$default_profile" | jq -r '.id // ""')
profile_name=$(printf '%s' "$default_profile" | jq -r '.name // ""')
profile_model=$(printf '%s' "$default_profile" | jq -r '.model // ""')
profile_runtime=$(printf '%s' "$default_profile" | jq -r '.runtime // "claude-sdk"')
profile_compatible=$(printf '%s' "$default_profile" | jq -r 'if has("compatibleWithDesiredRuntimeAdapter") then .compatibleWithDesiredRuntimeAdapter else true end')
smoke_assert_nonempty "$profile_id" "defaultProfile.id"
printf 'Default profile: %s / %s compatible=%s\n' "$profile_name" "$profile_model" "$profile_compatible"
if [[ "$profile_compatible" != "true" ]]; then
  if [[ -n "$SMOKE_CDS_AGENT_REQUIRE_COMPATIBLE" ]]; then
    smoke_fail "default runtime profile is incompatible with claude-agent-sdk"
  fi
  smoke_step "默认 profile 不兼容，跳过 provider run"
  smoke_ok "set Anthropic/Claude-compatible profile before S1 run"
  smoke_step "跳过选择 CDS connection"
  smoke_ok "not applicable"
  smoke_step "跳过创建会话"
  smoke_ok "not applicable"
  smoke_step "跳过启动会话"
  smoke_ok "not applicable"
  smoke_step "跳过发送 S1 prompt"
  smoke_ok "not applicable"
  smoke_step "跳过等待 assistant 结果"
  smoke_ok "not applicable"
  smoke_done
  exit 0
fi
smoke_ok "default runtime profile is compatible"

smoke_step "确认是否允许真实 provider 调用"
if [[ "$SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL" != "1" ]]; then
  smoke_ok "readiness only; set SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 to run S1"
  smoke_step "跳过选择 CDS connection"
  smoke_ok "not applicable"
  smoke_step "跳过创建会话"
  smoke_ok "not applicable"
  smoke_step "跳过启动会话"
  smoke_ok "not applicable"
  smoke_step "跳过发送 S1 prompt"
  smoke_ok "not applicable"
  smoke_step "跳过等待 assistant 结果"
  smoke_ok "not applicable"
  smoke_done
  exit 0
fi
smoke_ok "provider call enabled"

smoke_step "选择 active CDS connection"
connections_resp=$(smoke_get "/api/infra-connections")
smoke_verbose "$connections_resp"
smoke_assert_eq "$(printf '%s' "$connections_resp" | jq -r '.success')" "true" "InfraConnections.success"
connection_id=$(printf '%s' "$connections_resp" | jq -r '.data.items[]? | select(.status == "active") | .id' | head -n 1)
smoke_assert_nonempty "$connection_id" "active connection id"
smoke_ok "connectionId=$connection_id"

smoke_step "创建临时 S1 只读会话"
trace="official-sdk-s1-$(date +%Y%m%d%H%M%S)"
create_body=$(jq -n \
  --arg connectionId "$connection_id" \
  --arg runtime "$profile_runtime" \
  --arg model "$profile_model" \
  --arg runtimeProfileId "$profile_id" \
  --arg traceId "$trace" \
  --arg repo "$SMOKE_CDS_AGENT_REPO" \
  --arg ref "$SMOKE_CDS_AGENT_REF" \
  '{
    connectionId: $connectionId,
    runtime: $runtime,
    model: $model,
    runtimeProfileId: $runtimeProfileId,
    traceId: $traceId,
    title: "official SDK S1 readonly smoke",
    toolPolicy: "confirm-dangerous",
    gitRepository: $repo,
    gitRef: $ref
  }')
create_resp=$(smoke_post "/api/infra-agent-sessions" "$create_body")
smoke_verbose "$create_resp"
smoke_assert_eq "$(printf '%s' "$create_resp" | jq -r '.success')" "true" "CreateSession.success"
created_session_id=$(smoke_get_data "$create_resp" '.item.id // ""')
smoke_assert_nonempty "$created_session_id" "created session id"
smoke_ok "sessionId=$created_session_id trace=$trace"

smoke_step "启动会话"
start_resp=$(smoke_post "/api/infra-agent-sessions/${created_session_id}/start" '{}')
smoke_verbose "$start_resp"
smoke_assert_eq "$(printf '%s' "$start_resp" | jq -r '.success')" "true" "StartSession.success"
smoke_ok "session started"

smoke_step "发送 S1 只读审查 prompt"
prompt='只读审查当前仓库。不要修改文件，不要创建 PR。请读取 README、最近提交或项目结构后，用 5 条以内说明：1) 你确认的仓库/ref；2) 你检查了哪些文件；3) 一个最高风险问题或没有发现高风险问题；4) 下一步建议。'
send_body=$(jq -n --arg content "$prompt" '{content:$content}')
send_resp=$(smoke_post "/api/infra-agent-sessions/${created_session_id}/messages" "$send_body")
smoke_verbose "$send_resp"
smoke_assert_eq "$(printf '%s' "$send_resp" | jq -r '.success')" "true" "SendMessage.success"
smoke_ok "S1 prompt sent"

smoke_step "等待 assistant 消息或失败状态"
deadline=$(( $(date +%s) + SMOKE_CDS_AGENT_POLL_SECONDS ))
last_status=""
last_error=""
assistant_count=0
while (( $(date +%s) < deadline )); do
  session_resp=$(smoke_get "/api/infra-agent-sessions/${created_session_id}")
  last_status=$(printf '%s' "$session_resp" | jq -r '.data.item.status // ""')
  last_error=$(printf '%s' "$session_resp" | jq -r '.data.item.lastError // ""')
  messages_resp=$(smoke_get "/api/infra-agent-sessions/${created_session_id}/messages?limit=20")
  assistant_count=$(printf '%s' "$messages_resp" | jq -r '[.data.items[]? | select(.role == "assistant")] | length')
  if (( assistant_count > 0 )); then
    smoke_ok "assistant messages=$assistant_count status=$last_status"
    created_session_id=""
    smoke_done
    exit 0
  fi
  if [[ "$last_status" == "failed" ]]; then
    smoke_fail "session failed before assistant response: ${last_error}"
  fi
  sleep 5
done

smoke_fail "timed out waiting for assistant response; status=${last_status} assistantMessages=${assistant_count} lastError=${last_error}"
