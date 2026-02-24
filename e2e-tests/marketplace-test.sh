#!/bin/bash

# ============================================================
# 海鲜市场 (Configuration Marketplace) 全链路测试
# ============================================================
#
# 使用方法:
#   export AI_ACCESS_KEY="your-access-key"
#   ./e2e-tests/marketplace-test.sh
#
# 或者:
#   AI_ACCESS_KEY="your-access-key" ./e2e-tests/marketplace-test.sh
#
# ============================================================

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 配置
API_BASE="${API_BASE:-http://localhost:5000}"
ACCESS_KEY="${AI_ACCESS_KEY:-}"

# 测试计数
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0

# 日志函数
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[PASS]${NC} $1"
    ((PASSED_TESTS++))
    ((TOTAL_TESTS++))
}

log_fail() {
    echo -e "${RED}[FAIL]${NC} $1"
    ((FAILED_TESTS++))
    ((TOTAL_TESTS++))
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_section() {
    echo ""
    echo -e "${YELLOW}========================================${NC}"
    echo -e "${YELLOW}$1${NC}"
    echo -e "${YELLOW}========================================${NC}"
}

# 检查环境变量
check_env() {
    log_section "环境检查"

    if [ -z "$ACCESS_KEY" ]; then
        log_fail "AI_ACCESS_KEY 环境变量未设置"
        echo "请设置: export AI_ACCESS_KEY='your-access-key'"
        exit 1
    fi
    log_success "AI_ACCESS_KEY 已设置"

    log_info "API_BASE: $API_BASE"
}

# API 请求函数
api_request() {
    local method="$1"
    local endpoint="$2"
    local data="$3"

    local url="${API_BASE}${endpoint}"
    local headers="-H 'Content-Type: application/json' -H 'Authorization: Bearer $ACCESS_KEY'"

    if [ -n "$data" ]; then
        eval "curl -s -X $method $headers -d '$data' '$url'"
    else
        eval "curl -s -X $method $headers '$url'"
    fi
}

# 检查 JSON 响应是否成功
check_success() {
    local response="$1"
    local test_name="$2"

    local success=$(echo "$response" | jq -r '.success // false')

    if [ "$success" = "true" ]; then
        log_success "$test_name"
        return 0
    else
        local error=$(echo "$response" | jq -r '.error.message // "未知错误"')
        log_fail "$test_name: $error"
        echo "响应: $response"
        return 1
    fi
}

# ============================================================
# 提示词 (Literary Prompts) 测试
# ============================================================

test_prompts() {
    log_section "提示词 (Literary Prompts) 测试"

    # 1. 创建测试提示词
    log_info "1. 创建测试提示词..."
    local create_response=$(api_request POST "/api/literary-agent/prompts" '{
        "title": "测试提示词-海鲜市场",
        "content": "这是一个用于测试海鲜市场功能的提示词模板。\n\n## 要求\n- 测试发布功能\n- 测试下载功能",
        "scenarioType": "article-illustration"
    }')

    if check_success "$create_response" "创建提示词"; then
        PROMPT_ID=$(echo "$create_response" | jq -r '.data.prompt.id')
        log_info "  创建的提示词 ID: $PROMPT_ID"
    else
        return 1
    fi

    # 2. 获取我的提示词列表（验证用户隔离）
    log_info "2. 获取我的提示词列表..."
    local list_response=$(api_request GET "/api/literary-agent/prompts?scenarioType=article-illustration")

    if check_success "$list_response" "获取我的提示词列表"; then
        local count=$(echo "$list_response" | jq '.data.items | length')
        log_info "  我的提示词数量: $count"
    fi

    # 3. 发布到海鲜市场
    log_info "3. 发布提示词到海鲜市场..."
    local publish_response=$(api_request POST "/api/literary-agent/prompts/${PROMPT_ID}/publish")

    if check_success "$publish_response" "发布提示词"; then
        local is_public=$(echo "$publish_response" | jq -r '.data.prompt.isPublic')
        if [ "$is_public" = "true" ]; then
            log_success "  isPublic 已设置为 true"
        else
            log_fail "  isPublic 未正确设置"
        fi
    fi

    # 4. 获取海鲜市场列表
    log_info "4. 获取海鲜市场提示词列表..."
    local marketplace_response=$(api_request GET "/api/literary-agent/prompts/marketplace?sort=new")

    if check_success "$marketplace_response" "获取海鲜市场列表"; then
        local mp_count=$(echo "$marketplace_response" | jq '.data.items | length')
        log_info "  海鲜市场提示词数量: $mp_count"

        # 验证包含我们发布的提示词
        local found=$(echo "$marketplace_response" | jq --arg id "$PROMPT_ID" '.data.items[] | select(.id == $id) | .id')
        if [ -n "$found" ]; then
            log_success "  已发布的提示词在海鲜市场中可见"
        else
            log_fail "  已发布的提示词在海鲜市场中不可见"
        fi
    fi

    # 5. 搜索海鲜市场
    log_info "5. 搜索海鲜市场（关键词: 测试）..."
    local search_response=$(api_request GET "/api/literary-agent/prompts/marketplace?keyword=测试&sort=hot")

    if check_success "$search_response" "搜索海鲜市场"; then
        local search_count=$(echo "$search_response" | jq '.data.items | length')
        log_info "  搜索结果数量: $search_count"
    fi

    # 6. Fork（免费下载）提示词
    log_info "6. Fork（免费下载）提示词..."
    local fork_response=$(api_request POST "/api/literary-agent/prompts/${PROMPT_ID}/fork")

    if check_success "$fork_response" "Fork 提示词"; then
        FORKED_PROMPT_ID=$(echo "$fork_response" | jq -r '.data.prompt.id')
        local forked_from=$(echo "$fork_response" | jq -r '.data.prompt.forkedFromId')
        local forked_user=$(echo "$fork_response" | jq -r '.data.prompt.forkedFromUserName')

        log_info "  Fork 后的提示词 ID: $FORKED_PROMPT_ID"
        log_info "  来源 ID: $forked_from"
        log_info "  来源用户: $forked_user"

        if [ "$forked_from" = "$PROMPT_ID" ]; then
            log_success "  forkedFromId 正确设置"
        else
            log_fail "  forkedFromId 设置错误"
        fi
    fi

    # 7. 验证 Fork 次数增加
    log_info "7. 验证 Fork 次数..."
    local verify_response=$(api_request GET "/api/literary-agent/prompts/marketplace")
    local fork_count=$(echo "$verify_response" | jq --arg id "$PROMPT_ID" '.data.items[] | select(.id == $id) | .forkCount')

    if [ "$fork_count" -ge 1 ]; then
        log_success "Fork 次数已增加: $fork_count"
    else
        log_fail "Fork 次数未增加"
    fi

    # 8. 修改 Fork 后的提示词（验证清除来源信息）
    log_info "8. 修改 Fork 后的提示词..."
    local update_response=$(api_request PUT "/api/literary-agent/prompts/${FORKED_PROMPT_ID}" '{
        "title": "修改后的提示词",
        "content": "内容已被修改"
    }')

    if check_success "$update_response" "修改 Fork 后的提示词"; then
        local modified_flag=$(echo "$update_response" | jq -r '.data.prompt.isModifiedAfterFork')
        local cleared_from=$(echo "$update_response" | jq -r '.data.prompt.forkedFromId')

        if [ "$modified_flag" = "true" ] || [ "$cleared_from" = "null" ]; then
            log_success "  修改后来源信息已清除或标记"
        else
            log_warn "  来源信息状态: forkedFromId=$cleared_from, isModifiedAfterFork=$modified_flag"
        fi
    fi

    # 9. 取消发布
    log_info "9. 取消发布提示词..."
    local unpublish_response=$(api_request POST "/api/literary-agent/prompts/${PROMPT_ID}/unpublish")

    if check_success "$unpublish_response" "取消发布提示词"; then
        local is_public=$(echo "$unpublish_response" | jq -r '.data.prompt.isPublic')
        if [ "$is_public" = "false" ]; then
            log_success "  isPublic 已设置为 false"
        else
            log_fail "  isPublic 未正确设置"
        fi
    fi

    # 10. 清理测试数据
    log_info "10. 清理测试数据..."
    api_request DELETE "/api/literary-agent/prompts/${PROMPT_ID}" > /dev/null 2>&1
    api_request DELETE "/api/literary-agent/prompts/${FORKED_PROMPT_ID}" > /dev/null 2>&1
    log_info "  测试数据已清理"
}

# ============================================================
# 风格图 (Reference Images) 测试
# ============================================================

test_reference_images() {
    log_section "风格图 (Reference Images) 测试"

    # 注意：风格图需要上传图片，这里使用简化测试
    # 实际测试需要准备测试图片

    # 1. 获取我的风格图配置列表
    log_info "1. 获取我的风格图配置列表..."
    local list_response=$(api_request GET "/api/literary-agent/config/reference-images")

    if check_success "$list_response" "获取风格图列表"; then
        local count=$(echo "$list_response" | jq '.data.items | length')
        log_info "  我的风格图数量: $count"

        if [ "$count" -gt 0 ]; then
            REF_IMAGE_ID=$(echo "$list_response" | jq -r '.data.items[0].id')
            log_info "  使用现有风格图进行测试: $REF_IMAGE_ID"

            # 2. 发布风格图
            log_info "2. 发布风格图到海鲜市场..."
            local publish_response=$(api_request POST "/api/literary-agent/config/reference-images/${REF_IMAGE_ID}/publish")
            check_success "$publish_response" "发布风格图"

            # 3. 获取海鲜市场列表
            log_info "3. 获取海鲜市场风格图列表..."
            local marketplace_response=$(api_request GET "/api/literary-agent/config/reference-images/marketplace")
            check_success "$marketplace_response" "获取海鲜市场风格图列表"

            # 4. 取消发布
            log_info "4. 取消发布风格图..."
            local unpublish_response=$(api_request POST "/api/literary-agent/config/reference-images/${REF_IMAGE_ID}/unpublish")
            check_success "$unpublish_response" "取消发布风格图"
        else
            log_warn "没有现有风格图，跳过发布/下载测试"
            log_info "提示：请先通过 UI 上传一张风格图后再运行完整测试"
        fi
    fi
}

# ============================================================
# 水印 (Watermarks) 测试
# ============================================================

test_watermarks() {
    log_section "水印 (Watermarks) 测试"

    # 1. 获取我的水印配置列表
    log_info "1. 获取我的水印配置列表..."
    local list_response=$(api_request GET "/api/watermarks")

    if check_success "$list_response" "获取水印列表"; then
        local count=$(echo "$list_response" | jq '. | length')
        log_info "  我的水印数量: $count"

        if [ "$count" -gt 0 ]; then
            WATERMARK_ID=$(echo "$list_response" | jq -r '.[0].id')
            log_info "  使用现有水印进行测试: $WATERMARK_ID"

            # 2. 发布水印
            log_info "2. 发布水印到海鲜市场..."
            local publish_response=$(api_request POST "/api/watermarks/${WATERMARK_ID}/publish")
            check_success "$publish_response" "发布水印"

            # 3. 获取海鲜市场列表
            log_info "3. 获取海鲜市场水印列表..."
            local marketplace_response=$(api_request GET "/api/watermarks/marketplace")

            if check_success "$marketplace_response" "获取海鲜市场水印列表"; then
                local mp_count=$(echo "$marketplace_response" | jq '.data.items | length')
                log_info "  海鲜市场水印数量: $mp_count"
            fi

            # 4. 搜索海鲜市场
            log_info "4. 搜索海鲜市场水印..."
            local search_response=$(api_request GET "/api/watermarks/marketplace?sort=hot")
            check_success "$search_response" "搜索海鲜市场水印"

            # 5. Fork 水印
            log_info "5. Fork（免费下载）水印..."
            local fork_response=$(api_request POST "/api/watermarks/${WATERMARK_ID}/fork")

            if check_success "$fork_response" "Fork 水印"; then
                FORKED_WATERMARK_ID=$(echo "$fork_response" | jq -r '.data.config.id')
                log_info "  Fork 后的水印 ID: $FORKED_WATERMARK_ID"

                # 清理 fork 的水印
                api_request DELETE "/api/watermarks/${FORKED_WATERMARK_ID}" > /dev/null 2>&1
            fi

            # 6. 取消发布
            log_info "6. 取消发布水印..."
            local unpublish_response=$(api_request POST "/api/watermarks/${WATERMARK_ID}/unpublish")
            check_success "$unpublish_response" "取消发布水印"
        else
            log_warn "没有现有水印配置，跳过发布/下载测试"
            log_info "提示：请先通过 UI 创建一个水印配置后再运行完整测试"
        fi
    fi
}

# ============================================================
# 用户隔离测试
# ============================================================

test_user_isolation() {
    log_section "用户隔离测试"

    log_info "验证私有配置不会出现在海鲜市场..."

    # 创建一个不发布的提示词
    local create_response=$(api_request POST "/api/literary-agent/prompts" '{
        "title": "私有提示词-不应出现在市场",
        "content": "这个提示词不应该出现在海鲜市场中",
        "scenarioType": "article-illustration"
    }')

    if check_success "$create_response" "创建私有提示词"; then
        local private_id=$(echo "$create_response" | jq -r '.data.prompt.id')

        # 检查海鲜市场是否包含此提示词
        local marketplace_response=$(api_request GET "/api/literary-agent/prompts/marketplace")
        local found=$(echo "$marketplace_response" | jq --arg id "$private_id" '.data.items[] | select(.id == $id) | .id')

        if [ -z "$found" ]; then
            log_success "私有提示词未出现在海鲜市场中"
        else
            log_fail "私有提示词错误地出现在海鲜市场中"
        fi

        # 清理
        api_request DELETE "/api/literary-agent/prompts/${private_id}" > /dev/null 2>&1
    fi
}

# ============================================================
# 主函数
# ============================================================

main() {
    echo ""
    echo -e "${GREEN}╔══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║     海鲜市场 (Configuration Marketplace) 全链路测试      ║${NC}"
    echo -e "${GREEN}╚══════════════════════════════════════════════════════════╝${NC}"
    echo ""

    # 环境检查
    check_env

    # 运行测试
    test_prompts
    test_reference_images
    test_watermarks
    test_user_isolation

    # 输出测试结果
    log_section "测试结果汇总"
    echo ""
    echo -e "总测试数: ${TOTAL_TESTS}"
    echo -e "${GREEN}通过: ${PASSED_TESTS}${NC}"
    echo -e "${RED}失败: ${FAILED_TESTS}${NC}"
    echo ""

    if [ "$FAILED_TESTS" -eq 0 ]; then
        echo -e "${GREEN}╔══════════════════════════════════════════════════════════╗${NC}"
        echo -e "${GREEN}║                    所有测试通过！                        ║${NC}"
        echo -e "${GREEN}╚══════════════════════════════════════════════════════════╝${NC}"
        exit 0
    else
        echo -e "${RED}╔══════════════════════════════════════════════════════════╗${NC}"
        echo -e "${RED}║                    存在测试失败！                        ║${NC}"
        echo -e "${RED}╚══════════════════════════════════════════════════════════╝${NC}"
        exit 1
    fi
}

# 运行主函数
main "$@"
