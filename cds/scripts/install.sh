#!/usr/bin/env bash
# ──────────────────────────────────────────────
# cds 部署脚本
#
# 作用：把 cds 源码复制到独立目录运行，
#       与 prd_agent 仓库完全解耦，互不干扰。
#
# 用法：
#   cd prd_agent
#   bash cds/scripts/install.sh          # 使用默认目录 /opt/cds
#   bash cds/scripts/install.sh /my/path  # 自定义安装目录
# ──────────────────────────────────────────────

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SOURCE_DIR="${REPO_ROOT}/cds"
INSTALL_DIR="${1:-/opt/cds}"

echo ""
echo "  CDS 安装"
echo "  ────────────────────"
echo "  源码目录:   ${SOURCE_DIR}"
echo "  安装目录:   ${INSTALL_DIR}"
echo "  仓库根目录: ${REPO_ROOT}"
echo ""

# 1. Docker 地址池预检
echo "[1/5] Docker 地址池预检..."
bash "${SOURCE_DIR}/scripts/docker-address-pool-preflight.sh" || true

# 2. 创建安装目录
mkdir -p "${INSTALL_DIR}"

# 3. 同步源码（排除 node_modules、dist、.cds 状态文件）
echo "[2/5] 同步源码..."
rsync -a --delete \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='.cds' \
  "${SOURCE_DIR}/" "${INSTALL_DIR}/"

# 4. 生成 cds.config.json（指向真正的仓库）
CONFIG_FILE="${INSTALL_DIR}/cds.config.json"
echo "[3/5] 生成配置 → ${CONFIG_FILE}"
cat > "${CONFIG_FILE}" <<CONF
{
  "repoRoot": "${REPO_ROOT}",
  "worktreeBase": "${REPO_ROOT}/.cds-worktrees",
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

# 5. 安装依赖
echo "[4/5] 安装依赖..."
cd "${INSTALL_DIR}"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

# 6. 完成
echo "[5/5] 安装完成!"
echo ""
echo "  首次初始化:"
echo "    cd ${INSTALL_DIR}"
echo "    ./exec_cds.sh init"
echo ""
echo "  启动 (默认后台):"
echo "    ./exec_cds.sh start"
echo ""
