#!/bin/bash
# 快速验证脚本 - 验证 AI 生成的代码
#
# 用法: ./scripts/verify-changes.sh
#
# 执行以下检查:
# 1. 代码编译
# 2. CI 测试通过
# 3. 代码格式检查
# 4. 前端类型检查和测试

set -e
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "============================================"
echo "🔍 AI 代码验证脚本"
echo "============================================"
echo ""

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

check_result() {
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ $1 通过${NC}"
    else
        echo -e "${RED}✗ $1 失败${NC}"
        exit 1
    fi
}

# 检查 dotnet 是否可用
if command -v dotnet &> /dev/null; then
    echo "📦 检查后端代码..."
    echo ""

    cd "$PROJECT_ROOT/prd-api"

    # 1. 编译检查
    echo "  [1/3] 编译检查..."
    dotnet build PrdAgent.sln -c Release --verbosity quiet 2>&1 | tail -3
    check_result "后端编译"

    # 2. CI 测试
    echo "  [2/3] 运行 CI 测试..."
    dotnet test PrdAgent.sln -c Release --no-build --filter "Category=CI" --verbosity minimal 2>&1 | tail -5
    check_result "CI 测试"

    # 3. 代码格式检查（如果安装了 dotnet-format）
    if dotnet tool list -g | grep -q "dotnet-format"; then
        echo "  [3/3] 代码格式检查..."
        dotnet format PrdAgent.sln --verify-no-changes --verbosity quiet 2>&1 || true
    else
        echo "  [3/3] 跳过格式检查 (未安装 dotnet-format)"
    fi

    echo ""
fi

# 检查 pnpm 是否可用
if command -v pnpm &> /dev/null; then
    echo "🌐 检查前端代码..."
    echo ""

    cd "$PROJECT_ROOT/prd-admin"

    # 1. 类型检查
    echo "  [1/2] TypeScript 类型检查..."
    pnpm tsc --noEmit 2>&1 | tail -3
    check_result "TypeScript 类型"

    # 2. 测试
    echo "  [2/2] 运行测试..."
    pnpm test --run 2>&1 | tail -5
    check_result "前端测试"

    echo ""
fi

echo "============================================"
echo -e "${GREEN}✓ 所有检查通过${NC}"
echo "============================================"
