#!/usr/bin/env bash
# ============================================
# 冒烟测试: Defect Agent (缺陷管理)
# ============================================
#
# 端点黄金路径:
#   POST /api/defect-agent/defects             创建缺陷
#   GET  /api/defect-agent/defects/:id         读取详情
#   POST /api/defect-agent/defects/:id/messages 追加讨论消息
#   DELETE /api/defect-agent/defects/:id       清理 (best-effort)
#
# 只保证"能发能读能评论",不测 AI 分析结果质量。
# ============================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=smoke-lib.sh
source "$SCRIPT_DIR/smoke-lib.sh"

SMOKE_STEP_TOTAL=5
smoke_init "Defect Agent"

STAMP=$(date +%Y%m%d-%H%M%S)
TITLE="smoke-defect-${STAMP}"

# --- 1. 创建 Defect --------------------------------------------------
smoke_step "创建缺陷 '$TITLE'"
body=$(jq -n \
  --arg title "$TITLE" \
  --arg content "冒烟测试自动创建的缺陷报告。时间戳: $STAMP。该缺陷将在测试结束时被自动删除。" \
  --arg severity "S4" \
  --arg priority "Low" \
  '{title:$title, content:$content, severity:$severity, priority:$priority}')
resp=$(smoke_post /api/defect-agent/defects "$body")
DEFECT_ID=$(smoke_get_data "$resp" .id)
DEFECT_NO=$(smoke_get_data "$resp" '.defectNo // "?"')
smoke_assert_nonempty "$DEFECT_ID" "defectId"
smoke_ok "Defect 创建成功: $DEFECT_ID (编号 $DEFECT_NO)"

# --- 2. 读取详情 -----------------------------------------------------
smoke_step "GET /api/defect-agent/defects/:id"
resp=$(smoke_get "/api/defect-agent/defects/$DEFECT_ID")
got_title=$(smoke_get_data "$resp" .title)
got_severity=$(smoke_get_data "$resp" .severity)
smoke_assert_eq "$got_title" "$TITLE" "title"
smoke_assert_eq "$got_severity" "S4" "severity"
smoke_ok "详情字段一致 (title=$got_title, severity=$got_severity)"

# --- 3. 追加讨论消息 (触发 AI 分析链路) ------------------------------
smoke_step "追加一条讨论消息 (冒烟 AI 分析触发链路)"
msg_body=$(jq -n \
  --arg content "这是冒烟测试追加的讨论消息。请 AI Agent 忽略,直接回复 ok。" \
  '{content:$content}')
resp=$(smoke_post "/api/defect-agent/defects/$DEFECT_ID/messages" "$msg_body" || true)
msg_id=$(printf '%s' "$resp" | jq -r '.data.id // .data.messageId // ""' 2>/dev/null || echo "")
if [[ -n "$msg_id" ]]; then
  smoke_ok "消息已追加: $msg_id (AI 分析异步进行,不等)"
else
  # 某些版本端点直接返回 204/无 body; 只要没抛 4xx/5xx 就算通过
  smoke_ok "消息追加端点返回(可能为 204/无 body)"
fi

# --- 4. 验证消息出现在详情里 ------------------------------------------
smoke_step "再次 GET 详情,确认消息已落库"
resp=$(smoke_get "/api/defect-agent/defects/$DEFECT_ID")
msg_count=$(printf '%s' "$resp" | jq -r '.data.messages | length' 2>/dev/null || echo "0")
if [[ "${msg_count:-0}" -lt 1 ]]; then
  smoke_fail "detail.messages 应至少有一条,实际 $msg_count"
fi
smoke_ok "详情里 messages 数 = $msg_count"

# --- 5. 清理 ---------------------------------------------------------
smoke_step "清理测试缺陷 $DEFECT_ID"
if smoke_delete "/api/defect-agent/defects/$DEFECT_ID" >/dev/null 2>&1; then
  smoke_ok "缺陷已删除"
else
  printf '⚠ 删除失败 (无权限或端点不存在); 残留 defectId=%s 需人工清理\n' "$DEFECT_ID" >&2
fi

smoke_done
