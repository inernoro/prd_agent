#!/bin/bash
# ============================================================================
# PRD-Publish Deploy Script Template
# ============================================================================
#
# Usage: ./deploy-xxx.sh <commit_hash> <short_hash> <branch> <project_id>
#
# Environment Variables (auto-injected):
#   COMMIT_HASH   - Full commit hash
#   SHORT_HASH    - Short hash (7 chars)
#   BRANCH        - Branch name
#   PROJECT_ID    - Project ID
#   PROJECT_NAME  - Project display name
#   REPO_PATH     - Repository path
#
# Exit codes:
#   0 - Success
#   1 - General error
#   2 - Build failed
#   3 - Deploy failed
#
# ============================================================================

set -e  # Exit on error

echo "========================================"
echo "  PRD-Publish Deploy"
echo "========================================"
echo "Project:  ${PROJECT_NAME:-$PROJECT_ID}"
echo "Version:  $SHORT_HASH"
echo "Branch:   $BRANCH"
echo "Repo:     $REPO_PATH"
echo "Time:     $(date '+%Y-%m-%d %H:%M:%S')"
echo "========================================"

# ============================================================================
# STEP 1: 准备部署目录（使用 git archive，不影响原仓库）
# ============================================================================
#
# 为什么不直接 checkout？
#   - 直接 checkout 会改变原仓库的工作目录
#   - 如果仓库里有 data/ 等运行时数据，会被覆盖或删除
#   - 多人同时部署时会冲突
#
# 推荐方案：git archive 导出到临时目录
#   - 不影响原仓库
#   - 干净的代码副本
#   - 部署完可以删除

DEPLOY_DIR="/tmp/prd-deploy-${PROJECT_ID}-${SHORT_HASH}-$$"

echo "[准备] 导出代码到临时目录: $DEPLOY_DIR"
mkdir -p "$DEPLOY_DIR"

cd "$REPO_PATH"
git archive "$COMMIT_HASH" | tar -x -C "$DEPLOY_DIR"

cd "$DEPLOY_DIR"
echo "[准备] 代码导出完成"

# ============================================================================
# STEP 2: 构建（根据你的项目类型修改）
# ============================================================================

# --- Node.js 项目示例 ---
# echo "[构建] 安装依赖..."
# pnpm install --frozen-lockfile
#
# echo "[构建] 编译..."
# pnpm build

# --- .NET 项目示例 ---
# echo "[构建] 编译..."
# dotnet publish -c Release -o ./publish

# --- Docker 项目示例 ---
# echo "[构建] 构建镜像..."
# docker build -t myapp:$SHORT_HASH .

# ============================================================================
# STEP 3: 部署（根据你的部署方式修改）
# ============================================================================

# --- PM2 部署示例 ---
# echo "[部署] 重启服务..."
# pm2 restart myapp || pm2 start dist/main.js --name myapp

# --- Docker Compose 示例 ---
# echo "[部署] 启动容器..."
# docker compose up -d

# --- 复制到目标目录示例 ---
# echo "[部署] 复制到部署目录..."
# rsync -av --delete ./dist/ /var/www/myapp/

# ============================================================================
# STEP 4: 清理临时目录
# ============================================================================

echo "[清理] 删除临时目录..."
rm -rf "$DEPLOY_DIR"

echo "========================================"
echo "  Deploy completed successfully!"
echo "========================================"
