#!/bin/bash
# CI 测试脚本 - 排除集成测试
#
# 用法: ./scripts/test-ci.sh

set -e

cd "$(dirname "$0")/../prd-api"

echo "运行测试（排除集成测试）..."
dotnet test PrdAgent.sln -c Release --no-build --filter "Category!=Integration"
