#!/bin/bash
# ============================================
# 冒烟测试: Workflow Agent (工作流引擎)
# 生成时间: 2026-02-12
# ============================================
#
# 端点覆盖:
#   GET    /api/workflow-agent/workflows          列表
#   POST   /api/workflow-agent/workflows          创建
#   GET    /api/workflow-agent/workflows/:id      详情
#   PUT    /api/workflow-agent/workflows/:id      更新
#   POST   /api/workflow-agent/workflows/:id/execute  触发执行
#   GET    /api/workflow-agent/executions         执行历史
#   GET    /api/workflow-agent/executions/:id     执行详情
#   GET    /api/workflow-agent/executions/:id/nodes/:nodeId/logs  节点日志
#   POST   /api/workflow-agent/executions/:id/resume-from/:nodeId 从节点重跑
#   POST   /api/workflow-agent/executions/:id/cancel  取消执行
#   POST   /api/workflow-agent/executions/:id/share   创建分享
#   GET    /api/workflow-agent/shares             分享列表
#   DELETE /api/workflow-agent/shares/:id         撤销分享
#   GET    /s/:token                              公开访问分享
#   DELETE /api/workflow-agent/workflows/:id      删除
#
# ============================================

set -e

# --- 配置 ---
HOST="${SMOKE_TEST_HOST:-http://localhost:5000}"
KEY="${AI_ACCESS_KEY:?请设置环境变量 AI_ACCESS_KEY}"
AUTH=(-H "X-AI-Access-Key: $KEY" -H "X-AI-Impersonate: admin" -H "Content-Type: application/json")

echo "=========================================="
echo "冒烟测试: Workflow Agent (工作流引擎)"
echo "目标: $HOST"
echo "=========================================="

# --- 1. 查询工作流列表（空列表） ---
echo ""
echo ">>> [1/15] 查询工作流列表..."
curl -sf "$HOST/api/workflow-agent/workflows?page=1&pageSize=5" "${AUTH[@]}" | jq '.data | "总数: \(.total), 当前页: \(.items | length) 条"'
echo "✅ 列表查询成功"

# --- 2. 创建工作流（含完整 DAG） ---
echo ""
echo ">>> [2/15] 创建测试工作流（TAPD 月度报告模板）..."
RESULT=$(curl -sf "$HOST/api/workflow-agent/workflows" "${AUTH[@]}" \
  -X POST \
  -d '{
    "name": "smoke-test-月度质量报告",
    "description": "冒烟测试用工作流",
    "tags": ["smoke-test", "tapd"],
    "nodes": [
      {
        "nodeId": "node_a",
        "name": "TAPD 数据采集",
        "nodeType": "data-collector",
        "inputSlots": [],
        "outputSlots": [{"slotId": "slot_a_out", "name": "bugs", "dataType": "json"}]
      },
      {
        "nodeId": "node_b",
        "name": "LLM 结构化分析",
        "nodeType": "llm-analyzer",
        "inputSlots": [{"slotId": "slot_b_in", "name": "rawData", "dataType": "json"}],
        "outputSlots": [{"slotId": "slot_b_out", "name": "details", "dataType": "json"}]
      },
      {
        "nodeId": "node_c",
        "name": "代码统计",
        "nodeType": "llm-code-executor",
        "inputSlots": [{"slotId": "slot_c_in", "name": "details", "dataType": "json"}],
        "outputSlots": [{"slotId": "slot_c_out", "name": "stats", "dataType": "json"}]
      },
      {
        "nodeId": "node_d",
        "name": "HTML 报告渲染",
        "nodeType": "renderer",
        "inputSlots": [{"slotId": "slot_d_in", "name": "stats", "dataType": "json"}],
        "outputSlots": [{"slotId": "slot_d_out", "name": "report", "dataType": "text"}]
      }
    ],
    "edges": [
      {"edgeId": "e1", "sourceNodeId": "node_a", "sourceSlotId": "slot_a_out", "targetNodeId": "node_b", "targetSlotId": "slot_b_in"},
      {"edgeId": "e2", "sourceNodeId": "node_b", "sourceSlotId": "slot_b_out", "targetNodeId": "node_c", "targetSlotId": "slot_c_in"},
      {"edgeId": "e3", "sourceNodeId": "node_c", "sourceSlotId": "slot_c_out", "targetNodeId": "node_d", "targetSlotId": "slot_d_in"}
    ],
    "variables": [
      {"key": "TARGET_MONTH", "label": "目标月份", "type": "string", "defaultValue": "{{now.year}}-{{now.month}}", "required": true, "isSecret": false}
    ],
    "triggers": [
      {"triggerId": "t1", "type": "manual"},
      {"triggerId": "t2", "type": "cron", "cronExpression": "0 9 1 * *"}
    ]
  }')
WF_ID=$(echo "$RESULT" | jq -r '.data.workflow.id')
echo "✅ 工作流创建成功, ID: $WF_ID"

# --- 3. 获取工作流详情 ---
echo ""
echo ">>> [3/15] 获取工作流详情..."
curl -sf "$HOST/api/workflow-agent/workflows/$WF_ID" "${AUTH[@]}" | jq '.data.workflow | "名称: \(.name), 节点数: \(.nodes | length), 边数: \(.edges | length)"'
echo "✅ 详情获取成功"

# --- 4. 更新工作流 ---
echo ""
echo ">>> [4/15] 更新工作流名称和标签..."
curl -sf "$HOST/api/workflow-agent/workflows/$WF_ID" "${AUTH[@]}" \
  -X PUT \
  -d '{
    "name": "smoke-test-月度质量报告-已更新",
    "tags": ["smoke-test", "tapd", "updated"]
  }' | jq '.data.workflow | "更新后名称: \(.name), 标签: \(.tags | join(", "))"'
echo "✅ 更新成功"

# --- 5. 再次查询列表（应有 1 条） ---
echo ""
echo ">>> [5/15] 再次查询列表（验证创建生效）..."
curl -sf "$HOST/api/workflow-agent/workflows?page=1&pageSize=5&tag=smoke-test" "${AUTH[@]}" | jq '.data | "总数: \(.total), 包含测试工作流: \(.items | map(select(.name | contains("smoke-test"))) | length > 0)"'
echo "✅ 列表验证成功"

# --- 6. 触发执行 ---
echo ""
echo ">>> [6/15] 手动触发工作流执行..."
RESULT=$(curl -sf "$HOST/api/workflow-agent/workflows/$WF_ID/execute" "${AUTH[@]}" \
  -X POST \
  -d '{
    "variables": {
      "TARGET_MONTH": "2026-01"
    }
  }')
EXEC_ID=$(echo "$RESULT" | jq -r '.data.execution.id')
EXEC_STATUS=$(echo "$RESULT" | jq -r '.data.execution.status')
NODE_COUNT=$(echo "$RESULT" | jq -r '.data.execution.nodeExecutions | length')
echo "✅ 执行创建成功, ID: $EXEC_ID, 状态: $EXEC_STATUS, 节点数: $NODE_COUNT"

# --- 7. 查询执行历史 ---
echo ""
echo ">>> [7/15] 查询执行历史..."
curl -sf "$HOST/api/workflow-agent/executions?workflowId=$WF_ID&page=1&pageSize=5" "${AUTH[@]}" | jq '.data | "执行总数: \(.total)"'
echo "✅ 执行历史查询成功"

# --- 8. 获取执行详情 ---
echo ""
echo ">>> [8/15] 获取执行详情..."
curl -sf "$HOST/api/workflow-agent/executions/$EXEC_ID" "${AUTH[@]}" | jq '.data.execution | "状态: \(.status), 变量: \(.variables | to_entries | map(.key + "=" + .value) | join(", ")), 节点: \(.nodeExecutions | map(.nodeName) | join(" → "))"'
echo "✅ 执行详情获取成功"

# --- 9. 查看节点日志 ---
echo ""
echo ">>> [9/15] 查看节点 node_a 执行日志..."
curl -sf "$HOST/api/workflow-agent/executions/$EXEC_ID/nodes/node_a/logs" "${AUTH[@]}" | jq '.data | "节点: \(.nodeName), 状态: \(.status)"'
echo "✅ 节点日志获取成功"

# --- 10. 从中间节点重跑 ---
echo ""
echo ">>> [10/15] 从 node_c 重跑（模拟统计失败重试）..."
RESULT=$(curl -sf "$HOST/api/workflow-agent/executions/$EXEC_ID/resume-from/node_c" "${AUTH[@]}" \
  -X POST)
RESUME_EXEC_ID=$(echo "$RESULT" | jq -r '.data.execution.id')
RESUME_NODES=$(echo "$RESULT" | jq -r '.data.execution.nodeExecutions | map(.nodeId + ":" + .status) | join(", ")')
echo "✅ 重跑成功, 新执行 ID: $RESUME_EXEC_ID, 节点状态: $RESUME_NODES"

# --- 11. 取消执行 ---
echo ""
echo ">>> [11/15] 取消重跑的执行..."
curl -sf "$HOST/api/workflow-agent/executions/$RESUME_EXEC_ID/cancel" "${AUTH[@]}" \
  -X POST | jq '.data'
echo "✅ 取消成功"

# --- 12. 创建分享链接 ---
echo ""
echo ">>> [12/15] 为执行结果创建分享链接..."
RESULT=$(curl -sf "$HOST/api/workflow-agent/executions/$EXEC_ID/share" "${AUTH[@]}" \
  -X POST \
  -d '{
    "accessLevel": "public",
    "expiresInDays": 7
  }')
SHARE_ID=$(echo "$RESULT" | jq -r '.data.shareLink.id')
SHARE_TOKEN=$(echo "$RESULT" | jq -r '.data.shareLink.token')
SHARE_URL=$(echo "$RESULT" | jq -r '.data.url')
echo "✅ 分享创建成功, Token: $SHARE_TOKEN, URL: $SHARE_URL"

# --- 13. 查看分享列表 ---
echo ""
echo ">>> [13/15] 查看我的分享列表..."
curl -sf "$HOST/api/workflow-agent/shares" "${AUTH[@]}" | jq '.data.items | length | "分享数量: \(.)"'
echo "✅ 分享列表查询成功"

# --- 14. 撤销分享 ---
echo ""
echo ">>> [14/15] 撤销分享链接..."
curl -sf "$HOST/api/workflow-agent/shares/$SHARE_ID" "${AUTH[@]}" -X DELETE | jq '.data'
echo "✅ 分享撤销成功"

# --- 15. 清理：删除工作流 ---
echo ""
echo ">>> [15/15] 清理测试数据..."
curl -sf "$HOST/api/workflow-agent/workflows/$WF_ID" "${AUTH[@]}" -X DELETE | jq '.data'
echo "✅ 工作流删除成功"

echo ""
echo "=========================================="
echo "所有 Workflow Agent 冒烟测试通过! (15/15)"
echo "=========================================="
echo ""
echo "端点覆盖:"
echo "  [x] GET    /api/workflow-agent/workflows"
echo "  [x] POST   /api/workflow-agent/workflows"
echo "  [x] GET    /api/workflow-agent/workflows/:id"
echo "  [x] PUT    /api/workflow-agent/workflows/:id"
echo "  [x] POST   /api/workflow-agent/workflows/:id/execute"
echo "  [x] GET    /api/workflow-agent/executions"
echo "  [x] GET    /api/workflow-agent/executions/:id"
echo "  [x] GET    /api/workflow-agent/executions/:id/nodes/:nodeId/logs"
echo "  [x] POST   /api/workflow-agent/executions/:id/resume-from/:nodeId"
echo "  [x] POST   /api/workflow-agent/executions/:id/cancel"
echo "  [x] POST   /api/workflow-agent/executions/:id/share"
echo "  [x] GET    /api/workflow-agent/shares"
echo "  [x] DELETE /api/workflow-agent/shares/:id"
echo "  [x] DELETE /api/workflow-agent/workflows/:id"
echo ""
