#!/usr/bin/env bash
# ============================================
# 冒烟测试: CDS Agent runtime profile preflight
# ============================================
#
# 目标:
#   1. 验证 runtime-status 会暴露默认 profile 与 official SDK 兼容性
#   2. 当默认 profile 不兼容 claude-agent-sdk 时，验证 SendMessage 会在写消息/入队前返回
#      runtime_profile_incompatible，而不是进入官方 SDK 后才失败
#   3. 验证被拦截的 prompt 不会写入会话消息列表
#
# 如果默认 profile 已兼容 Claude/Anthropic，本脚本会通过并跳过拦截路径。
# ============================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=smoke-lib.sh
source "$SCRIPT_DIR/smoke-lib.sh"

SMOKE_STEP_TOTAL=6
smoke_init "CDS Agent Runtime Profile Preflight"

created_session_id=""
cleanup_session() {
  if [[ -n "$created_session_id" ]]; then
    smoke_post "/api/infra-agent-sessions/${created_session_id}/archive" '{}' >/dev/null 2>&1 || true
  fi
}
trap cleanup_session EXIT

smoke_step "读取 runtime-status 默认 profile 诊断"
runtime_resp=$(smoke_get "/api/infra-agent-sessions/runtime-status?refreshDiscovery=true")
smoke_verbose "$runtime_resp"
success=$(printf '%s' "$runtime_resp" | jq -r '.success')
smoke_assert_eq "$success" "true" "RuntimeStatus.success"
desired_adapter=$(smoke_get_data "$runtime_resp" '.diagnostics.desiredRuntimeAdapter // ""')
default_profile=$(printf '%s' "$runtime_resp" | jq -c '.data.diagnostics.defaultRuntimeProfile // empty')
smoke_assert_eq "$desired_adapter" "claude-agent-sdk" "diagnostics.desiredRuntimeAdapter"
smoke_assert_nonempty "$default_profile" "diagnostics.defaultRuntimeProfile"
profile_id=$(printf '%s' "$default_profile" | jq -r '.id // ""')
profile_name=$(printf '%s' "$default_profile" | jq -r '.name // ""')
profile_model=$(printf '%s' "$default_profile" | jq -r '.model // ""')
profile_runtime=$(printf '%s' "$default_profile" | jq -r '.runtime // "claude-sdk"')
profile_compatible=$(printf '%s' "$default_profile" | jq -r 'if has("compatibleWithDesiredRuntimeAdapter") then .compatibleWithDesiredRuntimeAdapter else true end')
smoke_assert_nonempty "$profile_id" "defaultProfile.id"
printf 'Default profile: %s / %s compatible=%s\n' "$profile_name" "$profile_model" "$profile_compatible"

if [[ "$profile_compatible" == "true" ]]; then
  smoke_step "默认 profile 已兼容，跳过不兼容拦截验证"
  smoke_ok "default runtime profile is compatible with claude-agent-sdk"
  smoke_step "跳过创建临时会话"
  smoke_ok "not applicable"
  smoke_step "跳过 SendMessage preflight"
  smoke_ok "not applicable"
  smoke_step "跳过消息写入验证"
  smoke_ok "not applicable"
  smoke_step "跳过清理"
  smoke_ok "not applicable"
  smoke_done
  exit 0
fi

smoke_step "选择 active CDS connection"
connections_resp=$(smoke_get "/api/infra-connections")
smoke_verbose "$connections_resp"
connections_success=$(printf '%s' "$connections_resp" | jq -r '.success')
smoke_assert_eq "$connections_success" "true" "InfraConnections.success"
connection_id=$(printf '%s' "$connections_resp" | jq -r '.data.items[]? | select(.status == "active") | .id' | head -n 1)
smoke_assert_nonempty "$connection_id" "active connection id"
smoke_ok "connectionId=$connection_id"

smoke_step "创建临时 idle 会话"
trace="profile-preflight-$(date +%Y%m%d%H%M%S)"
create_body=$(jq -n \
  --arg connectionId "$connection_id" \
  --arg runtime "$profile_runtime" \
  --arg model "$profile_model" \
  --arg runtimeProfileId "$profile_id" \
  --arg traceId "$trace" \
  '{
    connectionId: $connectionId,
    runtime: $runtime,
    model: $model,
    runtimeProfileId: $runtimeProfileId,
    traceId: $traceId,
    title: "profile preflight smoke",
    toolPolicy: "confirm-dangerous",
    gitRepository: "inernoro/prd_agent",
    gitRef: "codex/cds-agent-workbench-ui"
  }')
create_resp=$(smoke_post "/api/infra-agent-sessions" "$create_body")
smoke_verbose "$create_resp"
create_success=$(printf '%s' "$create_resp" | jq -r '.success')
smoke_assert_eq "$create_success" "true" "CreateSession.success"
created_session_id=$(smoke_get_data "$create_resp" '.item.id // ""')
smoke_assert_nonempty "$created_session_id" "created session id"
smoke_ok "sessionId=$created_session_id"

smoke_step "SendMessage 必须被 runtime_profile_incompatible 拦截"
send_body=$(jq -n '{content:"profile preflight smoke should be rejected before queue"}')
send_tmp=$(mktemp)
http_code=$(
  curl --max-time "$SMOKE_TIMEOUT" \
    --show-error \
    --silent \
    -o "$send_tmp" \
    -w '%{http_code}' \
    -X POST \
    "${SMOKE_AUTH[@]}" \
    -d "$send_body" \
    "$SMOKE_HOST/api/infra-agent-sessions/${created_session_id}/messages"
)
send_resp=$(cat "$send_tmp")
rm -f "$send_tmp"
smoke_verbose "$send_resp"
smoke_assert_eq "$http_code" "400" "SendMessage.httpStatus"
send_success=$(printf '%s' "$send_resp" | jq -r '.success')
send_code=$(printf '%s' "$send_resp" | jq -r '.error.code // ""')
smoke_assert_eq "$send_success" "false" "SendMessage.success"
smoke_assert_eq "$send_code" "runtime_profile_incompatible" "SendMessage.error.code"
smoke_ok "SendMessage rejected with runtime_profile_incompatible"

smoke_step "确认被拦截 prompt 没有写入消息"
messages_resp=$(smoke_get "/api/infra-agent-sessions/${created_session_id}/messages?limit=20")
smoke_verbose "$messages_resp"
messages_success=$(printf '%s' "$messages_resp" | jq -r '.success')
smoke_assert_eq "$messages_success" "true" "Messages.success"
message_count=$(printf '%s' "$messages_resp" | jq -r '.data.items | length')
smoke_assert_eq "$message_count" "0" "messages.count"
smoke_ok "messages.count=0"

smoke_step "归档临时会话"
archive_resp=$(smoke_post "/api/infra-agent-sessions/${created_session_id}/archive" '{}')
smoke_verbose "$archive_resp"
archive_success=$(printf '%s' "$archive_resp" | jq -r '.success')
smoke_assert_eq "$archive_success" "true" "Archive.success"
created_session_id=""
smoke_ok "temporary session archived"

smoke_done
