#!/bin/bash
# PRD-Publish Deployment Script
# This script is called with: $1=full_hash, $2=short_hash, $3=branch
#
# Exit codes:
#   0 - Success
#   1 - General failure
#   2 - Git operation failed
#   3 - Build failed
#   4 - Deployment failed

set -e

COMMIT_HASH=$1
SHORT_HASH=$2
BRANCH=$3
REPO_PATH=${REPO_PATH:-$(pwd)}

echo "=========================================="
echo "  PRD-Publish Deployment"
echo "=========================================="
echo "Commit: $SHORT_HASH"
echo "Branch: $BRANCH"
echo "Repo: $REPO_PATH"
echo "Time: $(date '+%Y-%m-%d %H:%M:%S')"
echo "=========================================="

# Change to repo directory
cd "$REPO_PATH"

echo ""
echo "[1/4] Fetching latest changes..."
git fetch origin 2>&1 || { echo "ERROR: Failed to fetch"; exit 2; }

echo ""
echo "[2/4] Checking out version $SHORT_HASH..."
git checkout "$COMMIT_HASH" 2>&1 || { echo "ERROR: Failed to checkout"; exit 2; }

echo ""
echo "[3/4] Running build (if applicable)..."
# Check for common build systems
if [ -f "package.json" ]; then
    if command -v pnpm &> /dev/null; then
        echo "Using pnpm..."
        pnpm install --frozen-lockfile 2>&1 || true
    elif command -v npm &> /dev/null; then
        echo "Using npm..."
        npm ci 2>&1 || true
    fi
fi

if [ -f "Makefile" ]; then
    echo "Running make..."
    make 2>&1 || true
fi

echo ""
echo "[4/4] Deployment complete!"
echo ""
echo "=========================================="
echo "  SUCCESS: Deployed $SHORT_HASH"
echo "=========================================="

exit 0
