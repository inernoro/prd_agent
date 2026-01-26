#!/bin/bash
# 完整测试脚本 - 运行所有测试（CI + 集成测试）
#
# 用法:
#   ./scripts/test-all.sh
#
# 运行所有测试，包括需要真实外部服务的集成测试

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "============================================"
echo "运行完整测试套件"
echo "============================================"
echo ""

cd "$PROJECT_ROOT/prd-api"

# 运行所有测试
dotnet test PrdAgent.sln \
    --configuration Release \
    --no-build \
    --verbosity normal \
    --logger "console;verbosity=detailed" \
    --results-directory "$PROJECT_ROOT/test-results" \
    --collect:"XPlat Code Coverage"

echo ""
echo "============================================"
echo "完整测试完成"
echo "============================================"
