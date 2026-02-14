#!/usr/bin/env bash
# ──────────────────────────────────────────────
# Branch Tester 一键启动脚本
#
# 用法：
#   ./exec_branch_tester.sh                # 前台运行
#   ./exec_branch_tester.sh --background   # 后台运行
#
# 环境变量（可选）：
#   BT_USERNAME      — 登录用户名（不设置则不启用认证）
#   BT_PASSWORD      — 登录密码
#   BT_CONFIG        — 配置文件路径（默认 bt.config.json）
#   BT_NGINX_ENABLE  — 设为 1 启用 nginx 转发（端口 58000）
# ──────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

CONFIG_FILE="${BT_CONFIG:-bt.config.json}"
BACKGROUND=false
LOG_FILE="bt.log"
PID_FILE=".bt/bt.pid"

# Parse args
for arg in "$@"; do
  case "$arg" in
    --background|-d) BACKGROUND=true ;;
  esac
done

echo ""
echo "  Branch Tester Startup"
echo "  ─────────────────────"
echo "  Directory:  $SCRIPT_DIR"
echo "  Config:     $CONFIG_FILE"
echo "  Auth:       ${BT_USERNAME:+enabled (user: $BT_USERNAME)}${BT_USERNAME:-disabled}"
echo "  Nginx:      ${BT_NGINX_ENABLE:+enabled (port 58000)}${BT_NGINX_ENABLE:-disabled}"
echo ""

# ── 1. Check dependencies ──
if ! command -v pnpm >/dev/null 2>&1; then
  echo "ERROR: pnpm not found. Install: npm install -g pnpm"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node not found. Install Node.js >= 20"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  echo "ERROR: Node.js >= 20 required (found: v${NODE_VERSION})"
  exit 1
fi

# ── 2. Install dependencies if needed ──
if [ ! -d "node_modules" ]; then
  echo "[1/3] Installing dependencies..."
  pnpm install --frozen-lockfile 2>/dev/null || pnpm install
else
  echo "[1/3] Dependencies OK"
fi

# ── 3. Setup nginx (optional) ──
if [ "${BT_NGINX_ENABLE:-}" = "1" ]; then
  echo "[2/3] Setting up nginx reverse proxy on :58000..."
  NGINX_CONF_DIR="/etc/nginx/conf.d"
  BT_NGINX_CONF="$SCRIPT_DIR/nginx/bt-nginx.conf"

  if [ -f "$BT_NGINX_CONF" ]; then
    if [ -d "$NGINX_CONF_DIR" ]; then
      sudo cp "$BT_NGINX_CONF" "$NGINX_CONF_DIR/bt-branch-tester.conf"
      sudo nginx -t 2>/dev/null && sudo nginx -s reload 2>/dev/null && echo "  Nginx: OK (port 58000)" || echo "  Nginx: config test failed (skipped)"
    else
      echo "  Nginx: $NGINX_CONF_DIR not found (skipped)"
    fi
  fi
else
  echo "[2/3] Nginx: skipped (set BT_NGINX_ENABLE=1 to enable)"
fi

# ── 4. Start branch-tester ──
mkdir -p .bt

echo "[3/3] Starting Branch Tester..."

if [ "$BACKGROUND" = true ]; then
  # Stop any existing instance
  if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
      echo "  Stopping old instance (PID: $OLD_PID)..."
      kill "$OLD_PID" 2>/dev/null || true
      sleep 1
    fi
  fi

  # Start in background
  nohup pnpm dev -- "$CONFIG_FILE" > "$LOG_FILE" 2>&1 &
  BT_PID=$!
  echo "$BT_PID" > "$PID_FILE"

  echo ""
  echo "  Branch Tester started in background"
  echo "  PID:        $BT_PID"
  echo "  Log:        $SCRIPT_DIR/$LOG_FILE"
  echo "  Dashboard:  http://localhost:9900"
  echo "  Gateway:    http://localhost:5500"
  [ "${BT_NGINX_ENABLE:-}" = "1" ] && echo "  Nginx:      http://localhost:58000"
  echo ""
  echo "  Stop: kill \$(cat $PID_FILE)"
  echo "  Logs: tail -f $LOG_FILE"
else
  echo ""
  exec pnpm dev -- "$CONFIG_FILE"
fi
