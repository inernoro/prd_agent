#!/bin/bash
# CI 测试脚本 - 仅运行 CI 分类的测试（内存数据，无外部依赖）
#
# 用法:
#   ./scripts/test-ci.sh
#
# 运行所有标记为 CI 的测试，排除需要真实外部服务的集成测试

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "============================================"
echo "运行 CI 测试（内存数据）"
echo "============================================"
echo ""

cd "$PROJECT_ROOT/prd-api"

# 运行 CI 分类测试，排除集成测试
dotnet test PrdAgent.sln \
    --configuration Release \
    --no-build \
    --verbosity normal \
    --filter "Category=CI" \
    --logger "console;verbosity=detailed" \
    --results-directory "$PROJECT_ROOT/test-results" \
    --collect:"XPlat Code Coverage"

echo ""
echo "============================================"
echo "CI 测试完成"
echo "============================================"
