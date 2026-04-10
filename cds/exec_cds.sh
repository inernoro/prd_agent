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
NGINX_DOMAIN_ENV="$SCRIPT_DIR/nginx/domain.env"
LOCAL_ENV_FILE="$SCRIPT_DIR/.cds.env"
BACKGROUND=false
LOG_FILE="cds.log"
PID_FILE=".cds/cds.pid"

# Parse args
for arg in "$@"; do
  case "$arg" in
    --background|-d) BACKGROUND=true ;;
  esac
done

ensure_domain_bootstrap() {
  local main_domain="${CDS_MAIN_DOMAIN:-${MAIN_DOMAIN:-}}"

  if [ -f "$NGINX_DOMAIN_ENV" ]; then
    return 0
  fi

  echo ""
  echo "  CDS 首次初始化"
  echo "  ─────────────────────"
  echo "  缺少域名初始化信息，将先执行 ./exec_setup.sh"
  echo ""

  if [ ! -t 0 ]; then
    echo "ERROR: 当前为非交互环境，且缺少 nginx/domain.env 或 CDS_MAIN_DOMAIN。"
    echo "请先手动执行: ./exec_setup.sh"
    exit 1
  fi

  ./exec_setup.sh

  if [ ! -f "$NGINX_DOMAIN_ENV" ]; then
    echo "ERROR: 初始化未完成，已取消启动。"
    exit 1
  fi
}

load_domain_env() {
  if [ -f "$LOCAL_ENV_FILE" ]; then
    set -a
    . "$LOCAL_ENV_FILE"
    set +a
  fi

  if [ ! -f "$NGINX_DOMAIN_ENV" ]; then
    return 0
  fi

  set -a
  . "$NGINX_DOMAIN_ENV"
  set +a

  export CDS_MAIN_DOMAIN="${CDS_MAIN_DOMAIN:-${MAIN_DOMAIN:-}}"
  export CDS_SWITCH_DOMAIN="${CDS_SWITCH_DOMAIN:-${SWITCH_DOMAIN:-}}"
  export CDS_PREVIEW_DOMAIN="${CDS_PREVIEW_DOMAIN:-${PREVIEW_DOMAIN:-${MAIN_DOMAIN:-}}}"
  export CDS_ACCESS_MODE="${CDS_ACCESS_MODE:-${ACCESS_MODE:-prefixed}}"
}

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

ensure_domain_bootstrap
load_domain_env

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

# ── Helper: stop CDS process occupying a port (safe — only kills node/tsx) ──
kill_cds_on_port() {
  local port="$1"
  local pids
  pids=$(ss -tlnp "( sport = :$port )" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true)
  [ -z "$pids" ] && return 0

  local killed=false
  for pid in $pids; do
    # Read the command name of the process
    local cmd
    cmd=$(ps -p "$pid" -o comm= 2>/dev/null || true)
    case "$cmd" in
      node|tsx|ts-node|npx|"")
        # Empty cmd means process is dying/zombie — still kill to release port.
        # Kill entire process group to prevent tsx watch from respawning children.
        local pgid
        pgid=$(ps -p "$pid" -o pgid= 2>/dev/null | tr -d ' ' || true)
        if [ -n "$pgid" ] && [ "$pgid" != "$$" ]; then
          echo "  Stopping CDS process group on port $port (PID: $pid, PGID: $pgid, cmd: $cmd)"
          kill -- -"$pgid" 2>/dev/null || kill "$pid" 2>/dev/null || true
        else
          echo "  Stopping CDS process on port $port (PID: $pid, cmd: $cmd)"
          kill "$pid" 2>/dev/null || true
        fi
        killed=true
        ;;
      *)
        echo "  [WARN] Port $port held by non-CDS process (PID: $pid, cmd: $cmd) — skipped"
        ;;
    esac
  done

  if [ "$killed" = true ]; then
    # Wait up to 5 seconds for process to exit (increased from 3 for reliability)
    for i in 1 2 3 4 5; do
      if ! ss -tlnp "( sport = :$port )" 2>/dev/null | grep -q 'pid='; then
        return 0
      fi
      sleep 1
    done
    # Force kill only node/tsx processes still alive (by process group)
    pids=$(ss -tlnp "( sport = :$port )" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true)
    for pid in $pids; do
      local cmd
      cmd=$(ps -p "$pid" -o comm= 2>/dev/null || true)
      case "$cmd" in
        node|tsx|ts-node|npx|"")
          local pgid
          pgid=$(ps -p "$pid" -o pgid= 2>/dev/null | tr -d ' ' || true)
          if [ -n "$pgid" ] && [ "$pgid" != "$$" ]; then
            echo "  Force killing CDS process group (PID: $pid, PGID: $pgid)"
            kill -9 -- -"$pgid" 2>/dev/null || kill -9 "$pid" 2>/dev/null || true
          else
            echo "  Force killing CDS process (PID: $pid)"
            kill -9 "$pid" 2>/dev/null || true
          fi
          ;;
      esac
    done
    sleep 1
  fi

  # Final check: if port still occupied (by non-CDS process), warn and abort
  if ss -tlnp "( sport = :$port )" 2>/dev/null | grep -q 'pid='; then
    echo "  [ERROR] Port $port is still in use by another program. Please free it manually."
    exit 1
  fi
}

find_cds_listener_pid() {
  local port="$1"
  local pids
  pids=$(ss -tlnp "( sport = :$port )" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true)
  [ -z "$pids" ] && return 1

  for pid in $pids; do
    local cmd
    cmd=$(ps -p "$pid" -o comm= 2>/dev/null || true)
    case "$cmd" in
      node|tsx|ts-node|npx)
        printf '%s\n' "$pid"
        return 0
        ;;
    esac
  done

  return 1
}

wait_for_cds_listener() {
  local port="$1"
  local timeout_seconds="${2:-20}"
  local elapsed=0

  while [ "$elapsed" -lt "$timeout_seconds" ]; do
    local pid=""
    pid=$(find_cds_listener_pid "$port" || true)
    if [ -n "$pid" ]; then
      printf '%s\n' "$pid"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  return 1
}

reuse_running_cds_if_present() {
  local pid=""
  pid=$(find_cds_listener_pid "$MASTER_PORT" || true)
  if [ -z "$pid" ]; then
    return 1
  fi

  echo "$pid" > "$PID_FILE"
  echo ""
  echo "  CDS already running"
  echo "  PID:        $pid"
  echo "  Log:        $SCRIPT_DIR/$LOG_FILE"
  echo "  Dashboard:  http://localhost:${MASTER_PORT}"
  echo "  Gateway:    http://localhost:${WORKER_PORT}"
  [ "${CDS_NGINX}" = "1" ] && echo "  Nginx:      http://localhost:58000"
  echo ""
  echo "  Stop: kill \$(cat $PID_FILE)"
  echo "  Logs: tail -f $LOG_FILE"
  return 0
}

# Read masterPort and workerPort from config
MASTER_PORT=9900
WORKER_PORT=5500
if [ -f "$CONFIG_FILE" ]; then
  _mp=$(grep -o '"masterPort"\s*:\s*[0-9]*' "$CONFIG_FILE" 2>/dev/null | grep -o '[0-9]*' || true)
  _wp=$(grep -o '"workerPort"\s*:\s*[0-9]*' "$CONFIG_FILE" 2>/dev/null | grep -o '[0-9]*' || true)
  [ -n "$_mp" ] && MASTER_PORT="$_mp"
  [ -n "$_wp" ] && WORKER_PORT="$_wp"
fi

if [ "$BACKGROUND" = true ] && reuse_running_cds_if_present; then
  exit 0
fi

echo "[3/3] Starting CDS..."

# ── Stop any existing instance (both foreground and background) ──
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

# Stop any orphaned CDS processes on the ports (only kills node/tsx, not other programs)
kill_cds_on_port "$MASTER_PORT"
kill_cds_on_port "$WORKER_PORT"

if [ "$BACKGROUND" = true ]; then

  # Start in background — use "serve" (tsx without watch) instead of "dev" (tsx watch).
  # tsx watch monitors file changes and auto-restarts, which races with exec_cds.sh
  # during self-update (git pull changes files → tsx watch restarts → two instances
  # compete for port 9900 → ~20% chance of 502). Background mode doesn't need hot-reload.
  nohup pnpm serve -- "$CONFIG_FILE" > "$LOG_FILE" 2>&1 &
  BOOTSTRAP_PID=$!

  CDS_PID="$(wait_for_cds_listener "$MASTER_PORT" 20 || true)"
  if [ -z "$CDS_PID" ]; then
    echo "  [ERROR] CDS 未能在 ${MASTER_PORT} 端口完成启动。"
    echo "  请检查日志: $SCRIPT_DIR/$LOG_FILE"
    exit 1
  fi

  echo "$CDS_PID" > "$PID_FILE"

  echo ""
  echo "  CDS started in background"
  echo "  PID:        $CDS_PID"
  if [ "$BOOTSTRAP_PID" != "$CDS_PID" ]; then
    echo "  Bootstrap:  $BOOTSTRAP_PID"
  fi
  echo "  Log:        $SCRIPT_DIR/$LOG_FILE"
  echo "  Dashboard:  http://localhost:${MASTER_PORT}"
  echo "  Gateway:    http://localhost:${WORKER_PORT}"
  [ "${CDS_NGINX}" = "1" ] && echo "  Nginx:      http://localhost:58000"
  echo ""
  echo "  Stop: kill \$(cat $PID_FILE)"
  echo "  Logs: tail -f $LOG_FILE"
else
  echo ""
  exec pnpm dev -- "$CONFIG_FILE"
fi
