#!/usr/bin/env bash
# ──────────────────────────────────────────────
# branch-tester 部署脚本
#
# 作用：把 branch-tester 源码复制到独立目录运行，
#       与 prd_agent 仓库完全解耦，互不干扰。
#
# 用法：
#   cd prd_agent
#   bash branch-tester/scripts/install.sh          # 使用默认目录 /opt/branch-tester
#   bash branch-tester/scripts/install.sh /my/path  # 自定义安装目录
# ──────────────────────────────────────────────

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SOURCE_DIR="${REPO_ROOT}/branch-tester"
INSTALL_DIR="${1:-/opt/branch-tester}"

echo ""
echo "  Branch Tester 安装"
echo "  ────────────────────"
echo "  源码目录:   ${SOURCE_DIR}"
echo "  安装目录:   ${INSTALL_DIR}"
echo "  仓库根目录: ${REPO_ROOT}"
echo ""

# 1. 创建安装目录
mkdir -p "${INSTALL_DIR}"

# 2. 同步源码（排除 node_modules、dist、.bt 状态文件）
echo "[1/4] 同步源码..."
rsync -a --delete \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='.bt' \
  "${SOURCE_DIR}/" "${INSTALL_DIR}/"

# 3. 生成 bt.config.json（指向真正的仓库）
CONFIG_FILE="${INSTALL_DIR}/bt.config.json"
echo "[2/4] 生成配置 → ${CONFIG_FILE}"
cat > "${CONFIG_FILE}" <<CONF
{
  "repoRoot": "${REPO_ROOT}",
  "worktreeBase": "${REPO_ROOT}/.bt-worktrees",
  "deployDir": "deploy",
  "gateway": {
    "containerName": "prdagent-gateway",
    "port": 5500
  },
  "docker": {
    "network": "prdagent-network",
    "apiDockerfile": "prd-api/Dockerfile",
    "apiImagePrefix": "prdagent-server",
    "containerPrefix": "prdagent-api"
  },
  "mongodb": {
    "containerHost": "mongodb",
    "port": 27017,
    "defaultDbName": "prdagent"
  },
  "redis": {
    "connectionString": "redis:6379"
  },
  "jwt": {
    "secret": "${JWT_SECRET:-dev-only-change-me-32bytes-minimum!!}",
    "issuer": "prdagent"
  },
  "dashboard": {
    "port": 9900
  }
}
CONF

# 4. 安装依赖
echo "[3/4] 安装依赖..."
cd "${INSTALL_DIR}"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

# 5. 完成
echo "[4/4] 安装完成!"
echo ""
echo "  启动方式:"
echo "    cd ${INSTALL_DIR}"
echo "    pnpm dev -- bt.config.json"
echo ""
echo "  或后台运行:"
echo "    cd ${INSTALL_DIR}"
echo "    nohup pnpm dev -- bt.config.json > bt.log 2>&1 &"
echo ""
