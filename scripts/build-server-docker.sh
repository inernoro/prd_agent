#!/bin/bash
# 使用 Docker 编译后台代码（适用于没有 .NET SDK 环境的服务器）
# 产物输出到 prd-api/output 目录

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
API_DIR="$REPO_ROOT/prd-api"
OUTPUT_DIR="$API_DIR/output"

cd "$API_DIR"

echo "Building backend code using Docker..."
echo "Output directory: $OUTPUT_DIR"

# 清理旧的输出目录
rm -rf "$OUTPUT_DIR"

# 使用 Docker 构建并输出产物
docker build \
  -f Dockerfile.build \
  -t prdagent-build:local \
  --target build \
  --output "$OUTPUT_DIR" \
  .

echo ""
echo "Build completed! Artifacts are in: $OUTPUT_DIR"
echo ""
echo "To run the compiled app:"
echo "  cd $OUTPUT_DIR"
echo "  dotnet PrdAgent.Api.dll"
