#!/bin/bash
# ============================================================================
# Channel Adapter E2E 测试脚本
#
# 用途：全链路测试通道适配器功能，不参与 CI
# 使用：./scripts/test-channel-adapter-e2e.sh [base_url] [token]
#
# 示例：
#   ./scripts/test-channel-adapter-e2e.sh http://localhost:5000 "your-jwt-token"
# ============================================================================

set -e

# 配置
BASE_URL="${1:-http://localhost:5000}"
TOKEN="${2:-}"
CONTENT_TYPE="Content-Type: application/json"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  Channel Adapter E2E 测试${NC}"
echo -e "${BLUE}  Base URL: ${BASE_URL}${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# 检查 token
if [ -z "$TOKEN" ]; then
    echo -e "${RED}错误: 请提供 JWT Token${NC}"
    echo "用法: $0 [base_url] [token]"
    exit 1
fi

AUTH_HEADER="Authorization: Bearer ${TOKEN}"

# 测试计数
PASSED=0
FAILED=0

# 测试函数
test_api() {
    local name="$1"
    local method="$2"
    local endpoint="$3"
    local data="$4"
    local expected_status="${5:-200}"

    echo -e "${YELLOW}测试: ${name}${NC}"
    echo "  ${method} ${endpoint}"

    if [ -n "$data" ]; then
        response=$(curl -s -w "\n%{http_code}" -X "$method" \
            "${BASE_URL}${endpoint}" \
            -H "$CONTENT_TYPE" \
            -H "$AUTH_HEADER" \
            -d "$data")
    else
        response=$(curl -s -w "\n%{http_code}" -X "$method" \
            "${BASE_URL}${endpoint}" \
            -H "$CONTENT_TYPE" \
            -H "$AUTH_HEADER")
    fi

    # 分离响应体和状态码
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')

    if [ "$http_code" = "$expected_status" ]; then
        echo -e "  ${GREEN}✓ 状态码: ${http_code}${NC}"
        echo "  响应: $(echo "$body" | head -c 200)..."
        ((PASSED++))
    else
        echo -e "  ${RED}✗ 期望状态码: ${expected_status}, 实际: ${http_code}${NC}"
        echo "  响应: $body"
        ((FAILED++))
    fi
    echo ""
}

# 生成唯一标识
UNIQUE_ID=$(date +%s)

echo -e "${BLUE}=== 1. 白名单 API 测试 ===${NC}"
echo ""

# 1.1 获取白名单列表
test_api "获取白名单列表" "GET" "/api/admin/channels/whitelists?page=1&pageSize=10"

# 1.2 创建白名单
WHITELIST_PATTERN="test-${UNIQUE_ID}@e2e-test.com"
test_api "创建白名单" "POST" "/api/admin/channels/whitelists" \
    "{\"channelType\":\"email\",\"identifierPattern\":\"${WHITELIST_PATTERN}\",\"displayName\":\"E2E 测试白名单\",\"dailyQuota\":100}"

# 1.3 按通道类型筛选
test_api "按通道类型筛选白名单" "GET" "/api/admin/channels/whitelists?page=1&pageSize=10&channelType=email"

# 1.4 搜索白名单
test_api "搜索白名单" "GET" "/api/admin/channels/whitelists?page=1&pageSize=10&search=e2e"

echo -e "${BLUE}=== 2. 身份映射 API 测试 ===${NC}"
echo ""

# 2.1 获取身份映射列表
test_api "获取身份映射列表" "GET" "/api/admin/channels/identity-mappings?page=1&pageSize=10"

# 2.2 按通道类型筛选身份映射
test_api "按通道类型筛选身份映射" "GET" "/api/admin/channels/identity-mappings?page=1&pageSize=10&channelType=email"

echo -e "${BLUE}=== 3. 任务 API 测试 ===${NC}"
echo ""

# 3.1 获取任务列表
test_api "获取任务列表" "GET" "/api/admin/channels/tasks?page=1&pageSize=10"

# 3.2 按状态筛选任务
test_api "按状态筛选任务 (pending)" "GET" "/api/admin/channels/tasks?page=1&pageSize=10&status=pending"

# 3.3 按通道类型筛选任务
test_api "按通道类型筛选任务" "GET" "/api/admin/channels/tasks?page=1&pageSize=10&channelType=email"

# 3.4 获取任务统计
test_api "获取任务统计" "GET" "/api/admin/channels/tasks/stats"

# 3.5 按通道获取任务统计
test_api "按通道获取任务统计" "GET" "/api/admin/channels/tasks/stats?channelType=email"

echo -e "${BLUE}=== 4. 通道统计 API 测试 ===${NC}"
echo ""

# 4.1 获取所有通道统计
test_api "获取所有通道统计" "GET" "/api/admin/channels/stats"

echo -e "${BLUE}=== 5. 邮件入站 Webhook 测试 ===${NC}"
echo ""

# 5.1 模拟 SendGrid Inbound Parse (multipart/form-data)
echo -e "${YELLOW}测试: 邮件入站 Webhook${NC}"
echo "  POST /api/channels/email/inbound"
response=$(curl -s -w "\n%{http_code}" -X POST \
    "${BASE_URL}/api/channels/email/inbound" \
    -F "from=Test User <test-${UNIQUE_ID}@example.com>" \
    -F "to=inbox@prdagent.com" \
    -F "subject=[生图] E2E 测试" \
    -F "text=请生成一张风景图片" \
    -F "Message-Id=<test-${UNIQUE_ID}@example.com>")
http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | sed '$d')
if [ "$http_code" = "200" ]; then
    echo -e "  ${GREEN}✓ 状态码: ${http_code}${NC}"
    ((PASSED++))
else
    echo -e "  ${RED}✗ 期望状态码: 200, 实际: ${http_code}${NC}"
    echo "  响应: $body"
    ((FAILED++))
fi
echo ""

# 5.2 测试入站端点 (Development 环境)
echo -e "${YELLOW}测试: 测试入站端点 (仅 Development 环境)${NC}"
echo "  POST /api/channels/email/inbound/test"
response=$(curl -s -w "\n%{http_code}" -X POST \
    "${BASE_URL}/api/channels/email/inbound/test" \
    -H "$CONTENT_TYPE" \
    -d "{\"from\":\"test-${UNIQUE_ID}@example.com\",\"fromName\":\"E2E Test\",\"subject\":\"[缺陷] 测试缺陷\",\"text\":\"发现一个 Bug\"}")
http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | sed '$d')
if [ "$http_code" = "200" ] || [ "$http_code" = "404" ]; then
    echo -e "  ${GREEN}✓ 状态码: ${http_code} (404 表示非 Development 环境)${NC}"
    ((PASSED++))
else
    echo -e "  ${RED}✗ 状态码: ${http_code}${NC}"
    echo "  响应: $body"
    ((FAILED++))
fi
echo ""

echo -e "${BLUE}=== 6. 错误处理测试 ===${NC}"
echo ""

# 6.1 获取不存在的任务
test_api "获取不存在的任务" "GET" "/api/admin/channels/tasks/non-existent-task-id" "" "404"

# 6.2 创建无效的白名单 (空模式)
test_api "创建无效白名单 (空模式)" "POST" "/api/admin/channels/whitelists" \
    "{\"channelType\":\"email\",\"identifierPattern\":\"\",\"displayName\":\"Invalid\"}" "400"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  测试结果汇总${NC}"
echo -e "${BLUE}========================================${NC}"
echo -e "  ${GREEN}通过: ${PASSED}${NC}"
echo -e "  ${RED}失败: ${FAILED}${NC}"
echo ""

if [ $FAILED -gt 0 ]; then
    echo -e "${RED}E2E 测试存在失败项${NC}"
    exit 1
else
    echo -e "${GREEN}所有 E2E 测试通过${NC}"
    exit 0
fi
