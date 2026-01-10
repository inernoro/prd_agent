#!/bin/bash

# 开放平台集成测试脚本

set -e

API_BASE="http://localhost:5000/api/v1/open-platform/v1"
TEST_KEY="sk-test-permanent-key-for-testing-only"

echo "========================================="
echo "开放平台 API 集成测试"
echo "========================================="
echo ""

# 颜色输出
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

test_passed=0
test_failed=0

# 测试函数
run_test() {
    local test_name="$1"
    local expected_status="$2"
    shift 2
    
    echo -n "测试: $test_name ... "
    
    response=$(curl -s -w "\n%{http_code}" "$@")
    status_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')
    
    if [ "$status_code" = "$expected_status" ]; then
        echo -e "${GREEN}通过${NC} (HTTP $status_code)"
        ((test_passed++))
        return 0
    else
        echo -e "${RED}失败${NC} (期望 HTTP $expected_status, 实际 HTTP $status_code)"
        echo "响应: $body"
        ((test_failed++))
        return 1
    fi
}

echo "1. 认证测试"
echo "----------------------------------------"

# 测试 1.1: 无 API Key
run_test "无 API Key" "401" \
    -X POST "$API_BASE/chat/completions" \
    -H "Content-Type: application/json" \
    -d '{"model":"gpt-4","messages":[{"role":"user","content":"test"}]}'

# 测试 1.2: 无效 API Key
run_test "无效 API Key" "401" \
    -X POST "$API_BASE/chat/completions" \
    -H "Authorization: Bearer sk-invalid-key" \
    -H "Content-Type: application/json" \
    -d '{"model":"gpt-4","messages":[{"role":"user","content":"test"}]}'

# 测试 1.3: 格式错误的 API Key
run_test "格式错误的 API Key" "401" \
    -X POST "$API_BASE/chat/completions" \
    -H "Authorization: Bearer invalid-format" \
    -H "Content-Type: application/json" \
    -d '{"model":"gpt-4","messages":[{"role":"user","content":"test"}]}'

# 测试 1.4: 测试 Key 认证
run_test "测试 Key 认证" "200" \
    -X POST "$API_BASE/chat/completions" \
    -H "Authorization: Bearer $TEST_KEY" \
    -H "Content-Type: application/json" \
    -d '{"model":"gpt-4","messages":[{"role":"user","content":"你好"}]}' \
    --max-time 30

echo ""
echo "2. LLM 代理模式测试"
echo "----------------------------------------"

# 测试 2.1: 基础对话
echo -n "测试: LLM 代理模式 - 基础对话 ... "
response=$(curl -s -N \
    -X POST "$API_BASE/chat/completions" \
    -H "Authorization: Bearer $TEST_KEY" \
    -H "Content-Type: application/json" \
    -d '{"model":"gpt-4","messages":[{"role":"user","content":"1+1=?"}],"stream":true}' \
    --max-time 30)

if echo "$response" | grep -q "data: \[DONE\]"; then
    echo -e "${GREEN}通过${NC} (收到完整 SSE 流)"
    ((test_passed++))
else
    echo -e "${RED}失败${NC} (未收到完整响应)"
    echo "响应: $response"
    ((test_failed++))
fi

# 测试 2.2: 不同模型名
echo -n "测试: LLM 代理模式 - 自定义模型名 ... "
response=$(curl -s -N \
    -X POST "$API_BASE/chat/completions" \
    -H "Authorization: Bearer $TEST_KEY" \
    -H "Content-Type: application/json" \
    -d '{"model":"my-custom-model","messages":[{"role":"user","content":"test"}],"stream":true}' \
    --max-time 30)

if echo "$response" | grep -q "my-custom-model"; then
    echo -e "${GREEN}通过${NC} (模型名正确返回)"
    ((test_passed++))
else
    echo -e "${RED}失败${NC} (模型名不匹配)"
    ((test_failed++))
fi

echo ""
echo "3. PRD 问答模式测试"
echo "----------------------------------------"

# 测试 3.1: 缺少 groupId
run_test "PRD 模式 - 缺少 groupId" "400" \
    -X POST "$API_BASE/chat/completions" \
    -H "Authorization: Bearer $TEST_KEY" \
    -H "Content-Type: application/json" \
    -d '{"model":"prdagent","messages":[{"role":"user","content":"test"}]}'

echo ""
echo "4. 错误处理测试"
echo "----------------------------------------"

# 测试 4.1: 空消息
run_test "空消息" "400" \
    -X POST "$API_BASE/chat/completions" \
    -H "Authorization: Bearer $TEST_KEY" \
    -H "Content-Type: application/json" \
    -d '{"model":"gpt-4","messages":[]}'

echo ""
echo "========================================="
echo "测试结果汇总"
echo "========================================="
echo -e "通过: ${GREEN}$test_passed${NC}"
echo -e "失败: ${RED}$test_failed${NC}"
echo "总计: $((test_passed + test_failed))"
echo ""

if [ $test_failed -eq 0 ]; then
    echo -e "${GREEN}所有测试通过！${NC}"
    exit 0
else
    echo -e "${RED}部分测试失败${NC}"
    exit 1
fi
