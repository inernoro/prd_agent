#!/bin/bash
# ============================================
# 冒烟测试: workflow-agent (工作流引擎)
# ============================================

set -e

HOST="${SMOKE_TEST_HOST:-http://localhost:5000}"
KEY="${AI_ACCESS_KEY:?请设置环境变量 AI_ACCESS_KEY}"
AUTH=(-H "X-AI-Access-Key: $KEY" -H "X-AI-Impersonate: admin" -H "Content-Type: application/json")

echo "=========================================="
echo "冒烟测试: Workflow Agent"
echo "目标: $HOST"
echo "=========================================="

# --- 1. 舱类型元数据 ---
echo ""
echo ">>> [1/9] 获取舱类型列表..."
RESULT=$(curl -sf "$HOST/api/workflow-agent/capsule-types" "${AUTH[@]}")
echo "$RESULT" | jq -r '.data.items | length | "舱类型数量: \(.)"'
echo "✅ 舱类型查询成功"

# --- 2. 单舱测试 ---
echo ""
echo ">>> [2/9] 单舱测试运行 (manual-trigger)..."
curl -sf "$HOST/api/workflow-agent/capsules/test-run" "${AUTH[@]}" \
  -X POST \
  -d '{"typeKey":"manual-trigger","config":{},"mockInput":{"test":true}}' \
  | jq '.data.result | "状态: " + .status'
echo "✅ 单舱测试通过"

# --- 3. 创建带 DAG 的工作流 ---
echo ""
echo ">>> [3/9] 创建测试工作流 (3节点 DAG)..."
BODY='{"name":"smoke-test-三节点流水线","icon":"🧪","tags":["smoke-test"],"nodes":[{"nodeId":"n1","name":"手动触发","nodeType":"manual-trigger","config":{},"inputSlots":[],"outputSlots":[{"slotId":"s1-out","name":"触发信号","dataType":"json"}]},{"nodeId":"n2","name":"数据抽取","nodeType":"data-extractor","config":{"json_path":"$.variables"},"inputSlots":[{"slotId":"s2-in","name":"输入","dataType":"json"}],"outputSlots":[{"slotId":"s2-out","name":"抽取结果","dataType":"json"}]},{"nodeId":"n3","name":"文件导出","nodeType":"file-exporter","config":{"format":"json","file_name":"smoke-result.json"},"inputSlots":[{"slotId":"s3-in","name":"输入","dataType":"json"}],"outputSlots":[{"slotId":"s3-out","name":"导出文件","dataType":"binary"}]}],"edges":[{"edgeId":"e1","sourceNodeId":"n1","sourceSlotId":"s1-out","targetNodeId":"n2","targetSlotId":"s2-in"},{"edgeId":"e2","sourceNodeId":"n2","sourceSlotId":"s2-out","targetNodeId":"n3","targetSlotId":"s3-in"}],"variables":[]}'
RESULT=$(curl -sf "$HOST/api/workflow-agent/workflows" "${AUTH[@]}" -X POST -d "$BODY")
WF_ID=$(echo "$RESULT" | jq -r '.data.workflow.id')
echo "✅ 创建成功, ID: $WF_ID"

# --- 4. 读取验证 ---
echo ""
echo ">>> [4/9] 读取工作流详情..."
curl -sf "$HOST/api/workflow-agent/workflows/$WF_ID" "${AUTH[@]}" | jq '.data.workflow | "节点: \(.nodes|length) | 边: \(.edges|length)"'
echo "✅ 读取成功"

# --- 5. 触发执行 ---
echo ""
echo ">>> [5/9] 触发执行..."
RESULT=$(curl -sf "$HOST/api/workflow-agent/workflows/$WF_ID/execute" "${AUTH[@]}" -X POST -d '{"variables":{}}')
EXEC_ID=$(echo "$RESULT" | jq -r '.data.execution.id')
echo "  执行ID: $EXEC_ID"
echo "  初始状态: $(echo "$RESULT" | jq -r '.data.execution.status')"
echo "✅ 执行已入队"

# --- 6. 轮询等待完成 ---
echo ""
echo ">>> [6/9] 轮询执行状态 (最多30s)..."
STATUS="queued"
for i in $(seq 1 12); do
  sleep 2.5
  RESULT=$(curl -sf "$HOST/api/workflow-agent/executions/$EXEC_ID" "${AUTH[@]}")
  STATUS=$(echo "$RESULT" | jq -r '.data.execution.status')
  NODES_DONE=$(echo "$RESULT" | jq '[.data.execution.nodeExecutions[] | select(.status == "completed")] | length')
  NODES_TOTAL=$(echo "$RESULT" | jq '.data.execution.nodeExecutions | length')
  echo "  [${i}/12] status=$STATUS nodes=$NODES_DONE/$NODES_TOTAL"
  if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ]; then
    break
  fi
done

echo ""
if [ "$STATUS" = "completed" ]; then
  echo "✅ 执行完成!"
  echo "$RESULT" | jq -r '.data.execution.nodeExecutions[] | "  " + .nodeName + ": " + .status + " (" + ((.durationMs // 0)|tostring) + "ms)"'
elif [ "$STATUS" = "failed" ]; then
  echo "⚠️  执行失败"
  echo "$RESULT" | jq -r '.data.execution.nodeExecutions[] | "  " + .nodeName + ": " + .status + " " + (.errorMessage // "")'
else
  echo "⚠️  超时 (status=$STATUS) — Worker 可能未启动"
fi

# --- 7. 节点日志 ---
echo ""
echo ">>> [7/9] 查看节点日志..."
curl -sf "$HOST/api/workflow-agent/executions/$EXEC_ID/nodes/n1/logs" "${AUTH[@]}" | jq '.data | "节点: " + .nodeName + " | 状态: " + .status'
echo "✅ 节点日志查询成功"

# --- 8. 执行历史 ---
echo ""
echo ">>> [8/9] 查询执行历史..."
curl -sf "$HOST/api/workflow-agent/executions?workflowId=$WF_ID&page=1&pageSize=5" "${AUTH[@]}" | jq '.data | "总执行次数: " + (.total|tostring)'
echo "✅ 执行历史查询成功"

# --- 9. 清理 ---
echo ""
echo ">>> [9/9] 清理测试工作流..."
curl -sf "$HOST/api/workflow-agent/workflows/$WF_ID" "${AUTH[@]}" -X DELETE | jq '.data'
echo "✅ 清理完成"

echo ""
echo "=========================================="
echo "冒烟测试完成!"
echo "=========================================="
