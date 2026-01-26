#!/bin/bash
# 集成测试 - 需要真实外部服务
#
# 用法: ./scripts/test-integration.sh
# 需配置: TENCENT_COS_* 环境变量

set -e

cd "$(dirname "$0")/../prd-api"

echo "运行集成测试..."
dotnet test PrdAgent.sln -c Release --no-build --filter "Category=Integration"
