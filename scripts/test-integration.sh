#!/bin/bash
# 集成测试脚本 - 仅运行需要真实外部服务的测试
#
# 用法:
#   ./scripts/test-integration.sh
#
# 需要配置以下环境变量:
#   - TENCENT_COS_BUCKET
#   - TENCENT_COS_REGION
#   - TENCENT_COS_SECRET_ID
#   - TENCENT_COS_SECRET_KEY
#   - TENCENT_COS_TEST_CLEANUP (可选, 设为 true 自动清理测试文件)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "============================================"
echo "运行集成测试（真实外部服务）"
echo "============================================"
echo ""

# 检查必要的环境变量
check_env() {
    if [ -z "${!1}" ]; then
        echo "警告: 环境变量 $1 未设置"
        return 1
    fi
    return 0
}

MISSING_VARS=0
check_env "TENCENT_COS_BUCKET" || MISSING_VARS=1
check_env "TENCENT_COS_REGION" || MISSING_VARS=1
check_env "TENCENT_COS_SECRET_ID" || MISSING_VARS=1
check_env "TENCENT_COS_SECRET_KEY" || MISSING_VARS=1

if [ $MISSING_VARS -eq 1 ]; then
    echo ""
    echo "部分环境变量未设置，某些集成测试可能会跳过"
    echo ""
fi

cd "$PROJECT_ROOT/prd-api"

# 运行集成测试
dotnet test PrdAgent.sln \
    --configuration Release \
    --no-build \
    --verbosity normal \
    --filter "Category=Integration" \
    --logger "console;verbosity=detailed" \
    --results-directory "$PROJECT_ROOT/test-results"

echo ""
echo "============================================"
echo "集成测试完成"
echo "============================================"
