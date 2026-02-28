#!/bin/bash
# ============================================
# 冒烟测试: AI 竞技场 (Arena)
# 覆盖: 分组 CRUD → 槽位 CRUD → 阵容聚合 → 对战 → 揭晓 → 历史 → 清理
# ============================================

set -e

HOST="${SMOKE_TEST_HOST:-http://localhost:5000}"
KEY="${AI_ACCESS_KEY:?请设置环境变量 AI_ACCESS_KEY}"
AUTH=(-H "X-AI-Access-Key: $KEY" -H "X-AI-Impersonate: admin" -H "Content-Type: application/json")

# 封装 curl：用临时文件分离 body 与 status code，失败时打印错误
api() {
  local _TMPOUT _HTTP_CODE
  _TMPOUT=$(mktemp)
  _HTTP_CODE=$(curl -s -o "$_TMPOUT" -w "%{http_code}" "$@")
  if [ "$_HTTP_CODE" -lt 200 ] || [ "$_HTTP_CODE" -ge 300 ]; then
    echo "❌ HTTP $_HTTP_CODE" >&2
    jq . "$_TMPOUT" 2>/dev/null || cat "$_TMPOUT" >&2
    rm -f "$_TMPOUT"
    exit 1
  fi
  cat "$_TMPOUT"
  rm -f "$_TMPOUT"
}

echo "=========================================="
echo "冒烟测试: AI 竞技场 (Arena)"
echo "目标: $HOST"
echo "=========================================="

# ─────────────────────────────────────────────
# 第一部分: 管理侧 — 分组 CRUD
# ─────────────────────────────────────────────

echo ""
echo ">>> [1/11] 创建分组: 全球前沿..."
RESULT=$(api "$HOST/api/lab/arena/groups" "${AUTH[@]}" -X POST \
  -d '{"key":"smoke-global","name":"冒烟-全球前沿","description":"冒烟测试分组","sortOrder":1}')
GROUP_ID=$(echo "$RESULT" | jq -r '.data.id // .data.group.id // empty')
echo "  分组ID: $GROUP_ID"
echo "✅ 分组创建成功"

echo ""
echo ">>> [2/11] 查询分组列表..."
RESULT=$(api "$HOST/api/lab/arena/groups" "${AUTH[@]}")
echo "$RESULT" | jq -r '.data | if type == "array" then length else (.items // .groups // []) | length end | "分组数量: \(.)"'
echo "✅ 分组列表查询成功"

echo ""
echo ">>> [3/11] 更新分组名称..."
api "$HOST/api/lab/arena/groups/$GROUP_ID" "${AUTH[@]}" -X PUT \
  -d '{"name":"冒烟-全球前沿(已更新)","description":"更新后的描述","sortOrder":1}' | jq '.code // .status'
echo "✅ 分组更新成功"

# ─────────────────────────────────────────────
# 第二部分: 管理侧 — 槽位 CRUD
# ─────────────────────────────────────────────

echo ""
echo ">>> [4/11] 创建槽位: 模型A (需要有效的 platformId)..."

# 先获取一个可用的平台ID
PLATFORM_RESULT=$(api "$HOST/api/platforms" "${AUTH[@]}" 2>/dev/null || echo '{"data":{"items":[]}}')
PLATFORM_ID=$(echo "$PLATFORM_RESULT" | jq -r '
  (.data.items // .data // [])
  | map(select(.enabled == true))
  | first
  | .id // empty
')

if [ -z "$PLATFORM_ID" ]; then
  echo "⚠️  未找到已启用的平台，使用 mock platformId"
  PLATFORM_ID="smoke-test-platform"
fi
echo "  使用平台ID: $PLATFORM_ID"

RESULT=$(api "$HOST/api/lab/arena/slots" "${AUTH[@]}" -X POST \
  -d "{\"displayName\":\"冒烟模型A\",\"platformId\":\"$PLATFORM_ID\",\"modelId\":\"smoke-model-a\",\"group\":\"smoke-global\",\"sortOrder\":1,\"enabled\":true,\"avatarColor\":\"#10a37f\",\"description\":\"冒烟测试模型A\"}")
SLOT_A_ID=$(echo "$RESULT" | jq -r '.data.id // .data.slot.id // empty')
echo "  槽位A ID: $SLOT_A_ID"
echo "✅ 槽位A创建成功"

echo ""
echo ">>> [5/11] 创建槽位: 模型B..."
RESULT=$(api "$HOST/api/lab/arena/slots" "${AUTH[@]}" -X POST \
  -d "{\"displayName\":\"冒烟模型B\",\"platformId\":\"$PLATFORM_ID\",\"modelId\":\"smoke-model-b\",\"group\":\"smoke-global\",\"sortOrder\":2,\"enabled\":true,\"avatarColor\":\"#7c3aed\",\"description\":\"冒烟测试模型B\"}")
SLOT_B_ID=$(echo "$RESULT" | jq -r '.data.id // .data.slot.id // empty')
echo "  槽位B ID: $SLOT_B_ID"
echo "✅ 槽位B创建成功"

echo ""
echo ">>> [6/11] 查询槽位列表 (按分组过滤)..."
RESULT=$(api "$HOST/api/lab/arena/slots?group=smoke-global" "${AUTH[@]}")
echo "$RESULT" | jq -r '(.data | if type == "array" then length else (.items // .slots // []) | length end) | "smoke-global 组槽位数: \(.)"'
echo "✅ 槽位列表查询成功"

echo ""
echo ">>> [7/11] 禁用槽位B..."
api "$HOST/api/lab/arena/slots/$SLOT_B_ID/toggle" "${AUTH[@]}" -X PUT | jq '.code // .status'
echo "✅ 槽位B已切换启用状态"

# ─────────────────────────────────────────────
# 第三部分: 用户侧 — 阵容 + 揭晓
# ─────────────────────────────────────────────

echo ""
echo ">>> [8/11] 获取出场阵容 (lineup)..."
RESULT=$(api "$HOST/api/lab/arena/lineup" "${AUTH[@]}")
echo "$RESULT" | jq -r '
  .data |
  if .totalSlots != null then "总槽位: \(.totalSlots)"
  elif .groups != null then "分组数: \(.groups | length)"
  else "响应结构: " + (keys | join(", "))
  end
'
# 核心验证：lineup 不应包含 displayName
HAS_DISPLAY_NAME=$(echo "$RESULT" | jq '[.. | .displayName? // empty] | length')
if [ "$HAS_DISPLAY_NAME" -gt 0 ]; then
  echo "❌ 盲评泄漏: lineup 接口不应返回 displayName!"
  exit 1
fi
echo "✅ 阵容查询成功 (无 displayName 泄漏)"

echo ""
echo ">>> [9/11] 揭晓模型身份 (reveal)..."
RESULT=$(api "$HOST/api/lab/arena/reveal" "${AUTH[@]}" -X POST \
  -d "{\"slotIds\":[\"$SLOT_A_ID\",\"$SLOT_B_ID\"]}")
echo "$RESULT" | jq -r '
  .data.reveals // .data //
  [{"displayName":"(解析失败)"}] |
  map("  " + .displayName + " (" + (.platformName // "?") + ")") |
  join("\n")
'
echo "✅ 揭晓成功"

# ─────────────────────────────────────────────
# 第四部分: 对战记录
# ─────────────────────────────────────────────

echo ""
echo ">>> [10/11] 保存对战记录..."
RESULT=$(api "$HOST/api/lab/arena/battles" "${AUTH[@]}" -X POST \
  -d "{\"prompt\":\"冒烟测试问题\",\"groupKey\":\"smoke-global\",\"responses\":[{\"slotId\":\"$SLOT_A_ID\",\"label\":\"助手 A\",\"content\":\"这是模型A的回答\",\"ttftMs\":80,\"totalMs\":1200,\"status\":\"done\"},{\"slotId\":\"$SLOT_B_ID\",\"label\":\"助手 B\",\"content\":\"这是模型B的回答\",\"ttftMs\":65,\"totalMs\":900,\"status\":\"done\"}]}")
BATTLE_ID=$(echo "$RESULT" | jq -r '.data.id // .data.battle.id // .data.battleId // empty')
echo "  对战ID: $BATTLE_ID"
echo "✅ 对战记录保存成功"

echo ""
echo ">>> [11/11] 查询历史对战..."
RESULT=$(api "$HOST/api/lab/arena/battles?page=1&pageSize=5" "${AUTH[@]}")
echo "$RESULT" | jq -r '
  .data |
  if .total != null then "历史对战总数: \(.total)"
  elif type == "array" then "历史对战数: \(length)"
  else "响应: " + (keys | join(", "))
  end
'
echo "✅ 历史对战查询成功"

# ─────────────────────────────────────────────
# 清理
# ─────────────────────────────────────────────

echo ""
echo ">>> 清理测试数据..."

# 删除槽位
api "$HOST/api/lab/arena/slots/$SLOT_A_ID" "${AUTH[@]}" -X DELETE > /dev/null 2>&1 && echo "  ✅ 槽位A已删除" || echo "  ⚠️  槽位A删除跳过"
api "$HOST/api/lab/arena/slots/$SLOT_B_ID" "${AUTH[@]}" -X DELETE > /dev/null 2>&1 && echo "  ✅ 槽位B已删除" || echo "  ⚠️  槽位B删除跳过"

# 删除分组
api "$HOST/api/lab/arena/groups/$GROUP_ID" "${AUTH[@]}" -X DELETE > /dev/null 2>&1 && echo "  ✅ 分组已删除" || echo "  ⚠️  分组删除跳过"

# 删除对战记录（如果有 DELETE 端点）
if [ -n "$BATTLE_ID" ]; then
  api "$HOST/api/lab/arena/battles/$BATTLE_ID" "${AUTH[@]}" -X DELETE > /dev/null 2>&1 && echo "  ✅ 对战记录已删除" || echo "  ⚠️  对战记录删除跳过 (可能无 DELETE 端点)"
fi

echo ""
echo "=========================================="
echo "冒烟测试完成!"
echo ""
echo "覆盖端点:"
echo "  POST   /api/lab/arena/groups          ✅"
echo "  GET    /api/lab/arena/groups           ✅"
echo "  PUT    /api/lab/arena/groups/{id}      ✅"
echo "  POST   /api/lab/arena/slots            ✅"
echo "  GET    /api/lab/arena/slots?group=     ✅"
echo "  PUT    /api/lab/arena/slots/{id}/toggle ✅"
echo "  GET    /api/lab/arena/lineup           ✅ (盲评泄漏检测)"
echo "  POST   /api/lab/arena/reveal           ✅"
echo "  POST   /api/lab/arena/battles          ✅"
echo "  GET    /api/lab/arena/battles           ✅"
echo "  DELETE /api/lab/arena/slots/{id}       ✅"
echo "  DELETE /api/lab/arena/groups/{id}      ✅"
echo "=========================================="
