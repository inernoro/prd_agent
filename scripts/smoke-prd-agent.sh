#!/usr/bin/env bash
# ============================================
# 冒烟测试: PRD Agent (会话 + 消息 + SSE 链路)
# ============================================
#
# 验证 PRD 解读 Agent 的黄金路径:
#   POST /api/v1/groups                               创建分组
#   POST /api/v1/groups/:groupId/session              创建会话
#   POST /api/v1/sessions/:sessionId/messages/run     创建 Run (发消息)
#   GET  /api/v1/chat-runs/:runId                     轮询 Run 状态
#   (可选) GET /api/v1/chat-runs/:runId/stream        SSE 流
#
# 若 LLM 响应缓慢,脚本最多等 60 秒,超时即 fail。
# ============================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=smoke-lib.sh
source "$SCRIPT_DIR/smoke-lib.sh"

SMOKE_STEP_TOTAL=5
smoke_init "PRD Agent"

# 冒烟测试专用的分组名 —— 带时间戳以便反复运行时不冲突。创建后
# 最后一步清理,失败也不会残留过多脏数据(只有分组+会话+一条消息)。
STAMP=$(date +%Y%m%d-%H%M%S)
GROUP_NAME="smoke-prd-${STAMP}"

# --- 1. 创建 Group ---------------------------------------------------
smoke_step "创建测试分组 '$GROUP_NAME'"
resp=$(smoke_post /api/v1/groups "{\"groupName\":\"$GROUP_NAME\"}")
GROUP_ID=$(smoke_get_data "$resp" .id)
smoke_assert_nonempty "$GROUP_ID" "groupId"
smoke_ok "Group 创建成功: $GROUP_ID"

# --- 2. 创建 Session -------------------------------------------------
smoke_step "在 Group 内创建 Session"
resp=$(smoke_post "/api/v1/groups/$GROUP_ID/session" '{}')
SESSION_ID=$(smoke_get_data "$resp" .id)
smoke_assert_nonempty "$SESSION_ID" "sessionId"
smoke_ok "Session 创建成功: $SESSION_ID"

# --- 3. 创建 Run (发送消息) ------------------------------------------
smoke_step "POST /api/v1/sessions/:id/messages/run (发送一条极短消息)"
# 故意发一句短 prompt 让 LLM 响应极快 — 只关心"能跑通",不关心结果质量。
# 加 "role":"PM" 明确角色,避免 stage 匹配多解。
resp=$(smoke_post "/api/v1/sessions/$SESSION_ID/messages/run" \
  '{"content":"ping (smoke test, please reply with ok)","role":"PM"}')
RUN_ID=$(smoke_get_data "$resp" .runId)
smoke_assert_nonempty "$RUN_ID" "runId"
smoke_ok "Run 已创建: $RUN_ID (状态应为 Queued/Running)"

# --- 4. 轮询 Run 直到完成 (最多 60 秒) --------------------------------
smoke_step "轮询 Run 状态直至 Completed/Failed (超时 60s)"
deadline=$(( $(date +%s) + 60 ))
final_status=""
while (( $(date +%s) < deadline )); do
  run_resp=$(smoke_get "/api/v1/chat-runs/$RUN_ID")
  cur_status=$(smoke_get_data "$run_resp" .status)
  smoke_verbose "poll status=$cur_status"
  case "$cur_status" in
    Completed|Failed|Canceled)
      final_status="$cur_status"
      break
      ;;
  esac
  sleep 2
done

if [[ -z "$final_status" ]]; then
  smoke_fail "Run $RUN_ID 60 秒内未进入终态 (最后状态=$cur_status) — LLM 网关可能超时"
fi
if [[ "$final_status" == "Failed" ]]; then
  err=$(smoke_get_data "$run_resp" '.errorMessage // "(无错误详情)"')
  smoke_fail "Run 失败: $err"
fi
smoke_ok "Run 终态 = $final_status"

# --- 5. 清理 (best-effort, 失败不阻断冒烟) ---------------------------
smoke_step "清理测试数据 (Group + Session + Messages)"
# 优先走 Group 删除 —— 设计上会级联删 Session 和 Messages。
if smoke_delete "/api/v1/groups/$GROUP_ID" >/dev/null 2>&1; then
  smoke_ok "Group 已删除 (级联清理 Session + Messages)"
else
  printf '⚠ 删除失败 (可能无权限或端点不存在); 残留 groupId=%s 需人工清理\n' "$GROUP_ID" >&2
fi

smoke_done
