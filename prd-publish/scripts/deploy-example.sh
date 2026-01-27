#!/bin/bash
# ============================================================================
# Example Deploy Script
# ============================================================================
set -e

echo "========================================"
echo "  Deploying: ${PROJECT_NAME:-Example}"
echo "  Version:   $SHORT_HASH"
echo "========================================"

cd "$REPO_PATH"

echo "[1/3] Pulling latest code..."
# git checkout already done by prd-publish

echo "[2/3] Installing dependencies..."
if [ -f "pnpm-lock.yaml" ]; then
    pnpm install --frozen-lockfile
elif [ -f "package-lock.json" ]; then
    npm ci
elif [ -f "yarn.lock" ]; then
    yarn install --frozen-lockfile
fi

echo "[3/3] Building..."
if [ -f "package.json" ]; then
    npm run build 2>/dev/null || echo "No build script, skipping..."
fi

echo "========================================"
echo "  Deploy completed: $SHORT_HASH"
echo "========================================"
