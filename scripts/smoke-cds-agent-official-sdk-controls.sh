#!/usr/bin/env bash
# ============================================
# CDS Agent official SDK S2/S3 control smoke
# ============================================
#
# 默认只做 readiness，不调用 provider，不消耗模型 token。
# 设置 SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 后，才会在默认 runtime profile
# 已兼容 claude-agent-sdk 时执行:
#   S2: 默认 hardened 只读模式下确认危险工具不会进入审批/执行；
#       若运行时显式暴露写工具，则触发危险工具审批，拒绝该审批，并确认 MAP 写入 tool_result
#   S3: 启动长任务后调用 stop，确认 session 进入 stopped/stopping
#
# 环境变量:
#   SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1
#   SMOKE_CDS_AGENT_REQUIRE_COMPATIBLE=1
#   SMOKE_CDS_AGENT_REPO=inernoro/prd_agent
#   SMOKE_CDS_AGENT_REF=main
#   SMOKE_CDS_AGENT_POLL_SECONDS=120
#   SMOKE_CDS_AGENT_CONTROLS_REPORT=/tmp/controls.json
# ============================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=smoke-lib.sh
source "$SCRIPT_DIR/smoke-lib.sh"

SMOKE_STEP_TOTAL=10
SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL="${SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL:-}"
SMOKE_CDS_AGENT_REQUIRE_COMPATIBLE="${SMOKE_CDS_AGENT_REQUIRE_COMPATIBLE:-}"
SMOKE_CDS_AGENT_REPO="${SMOKE_CDS_AGENT_REPO:-inernoro/prd_agent}"
SMOKE_CDS_AGENT_REF="${SMOKE_CDS_AGENT_REF:-main}"
SMOKE_CDS_AGENT_POLL_SECONDS="${SMOKE_CDS_AGENT_POLL_SECONDS:-120}"
SMOKE_CDS_AGENT_CONTROLS_REPORT="${SMOKE_CDS_AGENT_CONTROLS_REPORT:-}"
SMOKE_CDS_AGENT_RUNTIME_STATUS_RETRIES="${SMOKE_CDS_AGENT_RUNTIME_STATUS_RETRIES:-3}"
SMOKE_CDS_AGENT_RUNTIME_STATUS_RETRY_SECONDS="${SMOKE_CDS_AGENT_RUNTIME_STATUS_RETRY_SECONDS:-3}"
SMOKE_CDS_AGENT_PROVIDER_POST_RETRIES="${SMOKE_CDS_AGENT_PROVIDER_POST_RETRIES:-3}"
SMOKE_CDS_AGENT_PROVIDER_POST_RETRY_SECONDS="${SMOKE_CDS_AGENT_PROVIDER_POST_RETRY_SECONDS:-3}"

created_session_ids=()
cleanup_sessions() {
  if (( ${#created_session_ids[@]} == 0 )); then
    return
  fi
  for sid in "${created_session_ids[@]}"; do
    [[ -n "$sid" ]] && smoke_post "/api/infra-agent-sessions/${sid}/archive" '{}' >/dev/null 2>&1 || true
  done
}
trap cleanup_sessions EXIT

write_controls_report() {
  [[ -z "$SMOKE_CDS_AGENT_CONTROLS_REPORT" ]] && return
  local status="$1"
  local evidence_json="${2:-{}}"
  jq -n \
    --arg status "$status" \
    --arg host "$SMOKE_HOST" \
    --arg repo "$SMOKE_CDS_AGENT_REPO" \
    --arg ref "$SMOKE_CDS_AGENT_REF" \
    --arg evidenceRaw "$evidence_json" \
    '{
      status: $status,
      host: $host,
      target: { repo: $repo, ref: $ref },
      evidence: (
        $evidenceRaw
        | fromjson?
          // (sub("}$"; "") | fromjson?)
          // { reportError: "invalid evidence json", rawEvidence: $evidenceRaw }
      )
    }' > "$SMOKE_CDS_AGENT_CONTROLS_REPORT"
  printf 'Controls report: %s\n' "$SMOKE_CDS_AGENT_CONTROLS_REPORT"
}

post_with_retries() {
  local path="$1"
  local body="$2"
  local label="$3"
  local resp=""
  local rc=0
  for attempt in $(seq 1 "$SMOKE_CDS_AGENT_PROVIDER_POST_RETRIES"); do
    if resp=$(smoke_post "$path" "$body" 2>&1); then
      printf '%s' "$resp"
      return 0
    else
      rc=$?
    fi
    if (( attempt < SMOKE_CDS_AGENT_PROVIDER_POST_RETRIES )); then
      printf '%s failed (attempt %s/%s, rc=%s), retrying in %ss...\n' \
        "$label" "$attempt" "$SMOKE_CDS_AGENT_PROVIDER_POST_RETRIES" "$rc" "$SMOKE_CDS_AGENT_PROVIDER_POST_RETRY_SECONDS" >&2
      sleep "$SMOKE_CDS_AGENT_PROVIDER_POST_RETRY_SECONDS"
    fi
  done
  printf '%s' "$resp"
  return "$rc"
}

smoke_init "CDS Agent Official SDK S2/S3 Controls"

smoke_step "读取 runtime-status official SDK readiness"
runtime_resp=""
for attempt in $(seq 1 "$SMOKE_CDS_AGENT_RUNTIME_STATUS_RETRIES"); do
  runtime_resp=$(smoke_get "/api/infra-agent-sessions/runtime-status?refreshDiscovery=true")
  instance_count_probe=$(smoke_get_data "$runtime_resp" '.diagnostics.instanceCount // 0')
  healthy_count_probe=$(smoke_get_data "$runtime_resp" '.diagnostics.healthyCount // 0')
  if (( instance_count_probe > 0 && healthy_count_probe > 0 )); then
    break
  fi
  if (( attempt < SMOKE_CDS_AGENT_RUNTIME_STATUS_RETRIES )); then
    printf 'runtime-status not ready yet (attempt %s/%s, instances=%s healthy=%s), retrying in %ss...\n' \
      "$attempt" "$SMOKE_CDS_AGENT_RUNTIME_STATUS_RETRIES" "$instance_count_probe" "$healthy_count_probe" "$SMOKE_CDS_AGENT_RUNTIME_STATUS_RETRY_SECONDS"
    sleep "$SMOKE_CDS_AGENT_RUNTIME_STATUS_RETRY_SECONDS"
  fi
done
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
profile_evidence=$(printf '%s' "$default_profile" | jq -c '{
  defaultProfile: {
    id: (.id // ""),
    name: (.name // ""),
    model: (.model // ""),
    runtime: (.runtime // "claude-sdk"),
    protocol: (.protocol // ""),
    hasApiKey: (.hasApiKey // false),
    compatibleWithDesiredRuntimeAdapter: (if has("compatibleWithDesiredRuntimeAdapter") then .compatibleWithDesiredRuntimeAdapter else true end),
    compatibilityReasonCode: (.compatibilityReasonCode // ""),
    compatibilityReason: (.compatibilityReason // .warning // ""),
    compatibilityNextActions: (.compatibilityNextActions // [])
  }
}')
if [[ "$profile_compatible" != "true" ]]; then
  if [[ -n "$SMOKE_CDS_AGENT_REQUIRE_COMPATIBLE" ]]; then
    write_controls_report "failed_incompatible_profile" "$profile_evidence"
    smoke_fail "default runtime profile is incompatible with claude-agent-sdk"
  fi
  for label in "默认 profile 不兼容，跳过 provider control run" "跳过选择 CDS connection" "跳过 S2 创建会话" "跳过 S2 发送审批 prompt" "跳过 S2 等待审批" "跳过 S2 拒绝审批" "跳过 S3 创建会话" "跳过 S3 stop"; do
    smoke_step "$label"
    smoke_ok "not applicable"
  done
  write_controls_report "skipped_incompatible_profile" "$profile_evidence"
  smoke_done
  exit 0
fi
smoke_ok "default runtime profile is compatible"

smoke_step "确认是否允许真实 provider 调用"
if [[ "$SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL" != "1" ]]; then
  smoke_ok "readiness only; set SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 to run S2/S3"
  for label in "跳过选择 CDS connection" "跳过 S2 创建会话" "跳过 S2 发送审批 prompt" "跳过 S2 等待审批" "跳过 S2 拒绝审批" "跳过 S3 创建会话" "跳过 S3 stop"; do
    smoke_step "$label"
    smoke_ok "not applicable"
  done
  write_controls_report "readiness_only" "$profile_evidence"
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

create_session() {
  local trace="$1"
  local title="$2"
  local body
  body=$(jq -n \
    --arg connectionId "$connection_id" \
    --arg runtime "$profile_runtime" \
    --arg model "$profile_model" \
    --arg runtimeProfileId "$profile_id" \
    --arg traceId "$trace" \
    --arg repo "$SMOKE_CDS_AGENT_REPO" \
    --arg ref "$SMOKE_CDS_AGENT_REF" \
    --arg title "$title" \
    '{
      connectionId: $connectionId,
      runtime: $runtime,
      model: $model,
      runtimeProfileId: $runtimeProfileId,
      traceId: $traceId,
      title: $title,
      toolPolicy: "confirm-dangerous",
      gitRepository: $repo,
      gitRef: $ref
    }')
  local resp
  resp=$(post_with_retries "/api/infra-agent-sessions" "$body" "CreateSession") \
    || smoke_fail "CreateSession request failed after retries: ${resp}"
  smoke_verbose "$resp"
  smoke_assert_eq "$(printf '%s' "$resp" | jq -r '.success')" "true" "CreateSession.success"
  smoke_get_data "$resp" '.item.id // ""'
}

send_prompt() {
  local session_id="$1"
  local prompt="$2"
  local body resp
  body=$(jq -n --arg content "$prompt" '{content:$content}')
  resp=$(post_with_retries "/api/infra-agent-sessions/${session_id}/messages" "$body" "SendMessage") \
    || smoke_fail "SendMessage request failed after retries: ${resp}"
  smoke_verbose "$resp"
  smoke_assert_eq "$(printf '%s' "$resp" | jq -r '.success')" "true" "SendMessage.success"
}

smoke_step "S2 创建审批会话并启动"
s2_session_id=$(create_session "official-sdk-s2-$(date +%Y%m%d%H%M%S)" "official SDK S2 approval smoke")
smoke_assert_nonempty "$s2_session_id" "S2 session id"
created_session_ids+=("$s2_session_id")
start_resp=$(post_with_retries "/api/infra-agent-sessions/${s2_session_id}/start" '{}' "S2 StartSession") \
  || smoke_fail "S2 StartSession request failed after retries: ${start_resp}"
smoke_verbose "$start_resp"
smoke_assert_eq "$(printf '%s' "$start_resp" | jq -r '.success')" "true" "S2 StartSession.success"
smoke_ok "s2SessionId=$s2_session_id"

smoke_step "S2 发送危险工具审批 prompt"
send_prompt "$s2_session_id" '只做一次危险工具边界测试：尝试调用 Bash 工具运行 `pwd` 一次，不要修改文件。无论得到等待审批、工具不可用或被拒绝的结果，都必须立即最终回答；不要调用 Read/Grep/Glob，不要重试。'
smoke_ok "S2 prompt sent"

smoke_step "S2 等待 MAP approval request 或 hardened 只读完成"
deadline=$(( $(date +%s) + SMOKE_CDS_AGENT_POLL_SECONDS ))
approval_id=""
s2_mode=""
assistant_count=0
dangerous_approval_count=0
dangerous_builtin_count=0
denied_dangerous_builtin_count=0
while (( $(date +%s) < deadline )); do
  events_resp=$(smoke_get "/api/infra-agent-sessions/${s2_session_id}/events?afterSeq=0&limit=500")
  approval_id=$(printf '%s' "$events_resp" | jq -r '.data.items[]? | select(.type == "tool_call") | (.payloadJson | fromjson? // {}) | select(.status == "waiting" and (.approvalId // "") != "") | .approvalId' | head -n 1)
  if [[ -n "$approval_id" ]]; then
    s2_mode="approval"
    smoke_ok "approvalId=$approval_id"
    break
  fi
  messages_resp=$(smoke_get "/api/infra-agent-sessions/${s2_session_id}/messages?limit=20")
  assistant_count=$(printf '%s' "$messages_resp" | jq -r '[.data.items[]? | select(.role == "assistant")] | length')
  dangerous_approval_count=$(printf '%s' "$events_resp" | jq -r '
    [
      .data.items[]?
      | select(.type == "tool_call")
      | (.payloadJson | fromjson? // {})
      | select((.status // "") == "waiting")
      | select((.toolName // "" | ascii_downcase) | test("bash|edit|write"))
    ] | length
  ')
  dangerous_builtin_count=$(printf '%s' "$events_resp" | jq -r '
    [
      .data.items[]?
      | (.payloadJson | fromjson? // {})
      | select((.source // "") == "claude-agent-sdk")
      | select((.payload.type // "") == "tool_use")
      | select((.payload.tool_name // "" | ascii_downcase) | test("^(bash|edit|write)$"))
    ] | length
  ')
  denied_dangerous_builtin_count=$(printf '%s' "$events_resp" | jq -r '
    [
      .data.items[]?
      | select(.type == "tool_result")
      | (.payloadJson | fromjson? // {})
      | select((.source // "") == "claude-agent-sdk")
      | select((.content // "") | test("No such tool available|not enabled"; "i"))
    ] | length
  ')
  if (( assistant_count > 0 )); then
    s2_mode="hardened-readonly"
    smoke_ok "assistant completed without approval; dangerousApprovals=${dangerous_approval_count} dangerousBuiltinTools=${dangerous_builtin_count} deniedDangerousBuiltinTools=${denied_dangerous_builtin_count}"
    break
  fi
  session_resp=$(smoke_get "/api/infra-agent-sessions/${s2_session_id}")
  status=$(printf '%s' "$session_resp" | jq -r '.data.item.status // ""')
  last_error=$(printf '%s' "$session_resp" | jq -r '.data.item.lastError // ""')
  [[ "$status" == "failed" ]] && smoke_fail "S2 session failed before approval: $last_error"
  sleep 5
done
smoke_assert_nonempty "$s2_mode" "S2 mode"

smoke_step "S2 验证审批或 hardened 只读结果"
decision_count=0
if [[ "$s2_mode" == "approval" ]]; then
  deny_resp=$(post_with_retries "/api/infra-agent-sessions/${s2_session_id}/tool-approvals/${approval_id}" '{"decision":"deny"}' "ApproveTool") \
    || smoke_fail "ApproveTool request failed after retries: ${deny_resp}"
  smoke_verbose "$deny_resp"
  smoke_assert_eq "$(printf '%s' "$deny_resp" | jq -r '.success')" "true" "ApproveTool.success"
  events_resp=$(smoke_get "/api/infra-agent-sessions/${s2_session_id}/events?afterSeq=0&limit=500")
  decision_count=$(printf '%s' "$events_resp" | jq -r --arg approvalId "$approval_id" '[.data.items[]? | select(.type == "tool_result") | (.payloadJson | fromjson? // {}) | select(.approvalId == $approvalId and .source == "map-tool-approval")] | length')
  if (( decision_count <= 0 )); then
    smoke_fail "approval decision tool_result not found for approvalId=$approval_id"
  fi
  smoke_ok "approval denied and audited"
else
  smoke_assert_eq "$dangerous_approval_count" "0" "S2 dangerous approval count"
  if (( dangerous_builtin_count > denied_dangerous_builtin_count )); then
    smoke_fail "dangerous builtin tool attempts were not all denied: attempts=${dangerous_builtin_count} denied=${denied_dangerous_builtin_count}"
  fi
  smoke_ok "hardened read-only mode blocked dangerous tools before approval"
fi

smoke_step "S3 创建长任务会话并发送 prompt"
s3_session_id=$(create_session "official-sdk-s3-$(date +%Y%m%d%H%M%S)" "official SDK S3 stop smoke")
smoke_assert_nonempty "$s3_session_id" "S3 session id"
created_session_ids+=("$s3_session_id")
start_resp=$(post_with_retries "/api/infra-agent-sessions/${s3_session_id}/start" '{}' "S3 StartSession") \
  || smoke_fail "S3 StartSession request failed after retries: ${start_resp}"
smoke_verbose "$start_resp"
smoke_assert_eq "$(printf '%s' "$start_resp" | jq -r '.success')" "true" "S3 StartSession.success"
send_prompt "$s3_session_id" '请执行一个长时间只读任务：每 5 秒报告一次当前检查进度，持续 2 分钟。不要修改文件。'
smoke_ok "s3SessionId=$s3_session_id"

smoke_step "S3 stop 必须能停止会话"
sleep 10
stop_resp=$(post_with_retries "/api/infra-agent-sessions/${s3_session_id}/stop" '{}' "StopSession") \
  || smoke_fail "StopSession request failed after retries: ${stop_resp}"
smoke_verbose "$stop_resp"
smoke_assert_eq "$(printf '%s' "$stop_resp" | jq -r '.success')" "true" "StopSession.success"
final_status=$(printf '%s' "$stop_resp" | jq -r '.data.item.status // ""')
if [[ "$final_status" != "stopped" && "$final_status" != "stopping" ]]; then
  smoke_fail "unexpected stop status: $final_status"
fi
pass_evidence=$(jq -n \
  --arg runtimeAdapter "claude-agent-sdk" \
  --arg s2SessionId "$s2_session_id" \
  --arg approvalId "$approval_id" \
  --arg s2Mode "$s2_mode" \
  --argjson approvalDecisionResults "$decision_count" \
  --argjson dangerousApprovals "$dangerous_approval_count" \
  --argjson dangerousBuiltinTools "$dangerous_builtin_count" \
  --arg s3SessionId "$s3_session_id" \
  --arg stopStatus "$final_status" \
  '{
    runtimeAdapter: $runtimeAdapter,
    s2: {
      sessionId: $s2SessionId,
      mode: $s2Mode,
      approvalId: $approvalId,
      approvalDecisionResults: $approvalDecisionResults,
      dangerousApprovals: $dangerousApprovals,
      dangerousBuiltinTools: $dangerousBuiltinTools,
      mapApprovalSource: "map-tool-approval"
    },
    s3: {
      sessionId: $s3SessionId,
      stopStatus: $stopStatus
    }
  }')
write_controls_report "pass" "$pass_evidence"
smoke_ok "S3 stop accepted status=$final_status"

smoke_done
