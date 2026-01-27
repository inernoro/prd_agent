#!/bin/bash
# ============================================================================
# PRD-Publish Deploy Script Template
# ============================================================================
#
# Usage: ./deploy-xxx.sh <commit_hash> <short_hash> <branch> <project_id>
#
# Arguments:
#   $1 / $COMMIT_HASH   - Full commit hash (40 chars)
#   $2 / $SHORT_HASH    - Short hash (7 chars)
#   $3 / $BRANCH        - Branch name
#   $4 / $PROJECT_ID    - Project ID
#
# Environment Variables (auto-injected):
#   COMMIT_HASH   - Full commit hash
#   SHORT_HASH    - Short hash
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

# Navigate to repository
cd "$REPO_PATH"

# ============================================================================
# YOUR DEPLOY LOGIC HERE
# ============================================================================

# Example: Node.js project
# echo "[1/3] Installing dependencies..."
# pnpm install --frozen-lockfile
#
# echo "[2/3] Building..."
# pnpm build
#
# echo "[3/3] Restarting service..."
# pm2 restart my-app || pm2 start dist/main.js --name my-app

# Example: Docker project
# echo "[1/2] Building image..."
# docker build -t my-app:$SHORT_HASH .
#
# echo "[2/2] Deploying..."
# docker compose up -d

# Example: Static site
# echo "[1/2] Building..."
# pnpm build
#
# echo "[2/2] Syncing to server..."
# rsync -avz --delete dist/ user@server:/var/www/html/

# ============================================================================

echo "========================================"
echo "  Deploy completed successfully!"
echo "========================================"
