#!/usr/bin/env bash
# ──────────────────────────────────────────────
# CDS 一键启动脚本
#
# 用法：
#   ./exec_cds.sh                # 前台运行
#   ./exec_cds.sh --background   # 后台运行
#
# 环境变量（可选）：
#   CDS_USERNAME       — 登录用户名（不设置则不启用认证）
#   CDS_PASSWORD       — 登录密码
#   CDS_JWT_SECRET     — JWT 签名密钥（>= 32 字节）
#   CDS_SWITCH_DOMAIN  — 分支切换域名
#   CDS_MAIN_DOMAIN    — 主域名
#   CDS_PREVIEW_DOMAIN — 预览域名后缀
#   CDS_CONFIG         — 配置文件路径（默认 cds.config.json）
#   CDS_NGINX_ENABLE   — 设为 1 启用 nginx 转发（端口 58000）
# ──────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

CONFIG_FILE="${CDS_CONFIG:-${BT_CONFIG:-cds.config.json}}"
BACKGROUND=false
LOG_FILE="cds.log"
PID_FILE=".cds/cds.pid"

# Parse args
for arg in "$@"; do
  case "$arg" in
    --background|-d) BACKGROUND=true ;;
  esac
done

echo ""
echo "  CDS Startup"
echo "  ─────────────────────"
echo "  Directory:  $SCRIPT_DIR"
echo "  Config:     $CONFIG_FILE"
CDS_AUTH_USER="${CDS_USERNAME:-${BT_USERNAME:-}}"
echo "  Auth:       ${CDS_AUTH_USER:+enabled (user: $CDS_AUTH_USER)}${CDS_AUTH_USER:-disabled}"
CDS_NGINX="${CDS_NGINX_ENABLE:-${BT_NGINX_ENABLE:-}}"
echo "  Nginx:      ${CDS_NGINX:+enabled (port 58000)}${CDS_NGINX:-disabled}"
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

# ── 1.5 Ensure inotify watcher limit is high enough for Node.js dev containers ──
# Vite/chokidar watches many files; the default 65536/128000 is too low and
# causes ENOSPC errors inside containers. 1048576 is the recommended value.
CURRENT_WATCHES=$(cat /proc/sys/fs/inotify/max_user_watches 2>/dev/null || echo 0)
REQUIRED_WATCHES=524288
if [ "$CURRENT_WATCHES" -lt "$REQUIRED_WATCHES" ]; then
  echo "  inotify: max_user_watches=$CURRENT_WATCHES (too low, need >= $REQUIRED_WATCHES)"
  if command -v sysctl >/dev/null 2>&1; then
    sysctl -w fs.inotify.max_user_watches=$REQUIRED_WATCHES >/dev/null 2>&1 && \
      echo "  inotify: ✓ increased to $REQUIRED_WATCHES" || \
      echo "  inotify: ✗ failed (try: sudo sysctl -w fs.inotify.max_user_watches=$REQUIRED_WATCHES)"
  else
    echo "  inotify: ✗ sysctl not found. Run manually: echo $REQUIRED_WATCHES > /proc/sys/fs/inotify/max_user_watches"
  fi
else
  echo "  inotify: OK ($CURRENT_WATCHES)"
fi
echo ""

# ── 2. Install dependencies if needed ──
if [ ! -d "node_modules" ]; then
  echo "[1/3] Installing dependencies..."
  pnpm install --frozen-lockfile 2>/dev/null || pnpm install
else
  echo "[1/3] Dependencies OK"
fi

# ── 3. Setup nginx (optional) ──
if [ "${CDS_NGINX}" = "1" ]; then
  echo "[2/3] Setting up nginx reverse proxy on :58000..."
  NGINX_CONF_DIR="/etc/nginx/conf.d"
  CDS_NGINX_CONF="$SCRIPT_DIR/nginx/cds-nginx.conf"

  if [ -f "$CDS_NGINX_CONF" ]; then
    if [ -d "$NGINX_CONF_DIR" ]; then
      sudo cp "$CDS_NGINX_CONF" "$NGINX_CONF_DIR/cds.conf"
      sudo nginx -t 2>/dev/null && sudo nginx -s reload 2>/dev/null && echo "  Nginx: OK (port 58000)" || echo "  Nginx: config test failed (skipped)"
    else
      echo "  Nginx: $NGINX_CONF_DIR not found (skipped)"
    fi
  fi
else
  echo "[2/3] Nginx: skipped (set CDS_NGINX_ENABLE=1 to enable)"
fi

# ── 4. Start CDS ──
# Migrate old .bt/ to .cds/ if needed
if [ -d ".bt" ] && [ ! -d ".cds" ]; then
  mv .bt .cds
elif [ -d ".bt" ] && [ -d ".cds" ]; then
  # Both exist, prefer .cds, remove old
  rm -rf .bt
fi
mkdir -p .cds

echo "[3/3] Starting CDS..."

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
  # Also check legacy PID file
  LEGACY_PID_FILE=".bt/bt.pid"
  if [ -f "$LEGACY_PID_FILE" ]; then
    OLD_PID=$(cat "$LEGACY_PID_FILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
      echo "  Stopping legacy instance (PID: $OLD_PID)..."
      kill "$OLD_PID" 2>/dev/null || true
      sleep 1
    fi
    rm -f "$LEGACY_PID_FILE"
  fi

  # Start in background
  nohup pnpm dev -- "$CONFIG_FILE" > "$LOG_FILE" 2>&1 &
  CDS_PID=$!
  echo "$CDS_PID" > "$PID_FILE"

  echo ""
  echo "  CDS started in background"
  echo "  PID:        $CDS_PID"
  echo "  Log:        $SCRIPT_DIR/$LOG_FILE"
  echo "  Dashboard:  http://localhost:9900"
  echo "  Gateway:    http://localhost:5500"
  [ "${CDS_NGINX}" = "1" ] && echo "  Nginx:      http://localhost:58000"
  echo ""
  echo "  Stop: kill \$(cat $PID_FILE)"
  echo "  Logs: tail -f $LOG_FILE"
else
  echo ""
  exec pnpm dev -- "$CONFIG_FILE"
fi
