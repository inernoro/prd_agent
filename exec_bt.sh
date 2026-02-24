#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════
# PRD Agent Branch-Tester 一键部署
#
# 一条命令完成：基础设施 + Branch-Tester + 公网 Nginx
#
# 用法：
#   ./exec_bt.sh                              # 默认前台运行
#   ./exec_bt.sh --background                 # 后台运行
#   ./exec_bt.sh --stop                       # 停止所有服务
#   ./exec_bt.sh --status                     # 查看运行状态
#
# 环境变量：
#   ROOT_ACCESS_USERNAME  — Root 管理员用户名（默认 admin）
#   ROOT_ACCESS_PASSWORD  — Root 管理员密码（默认 PrdAgent123!）
#   JWT_SECRET            — JWT 密钥（默认自动生成）
#   ASSETS_PROVIDER       — 资产存储：local / tencentCos（默认 local）
#   BT_USERNAME           — Dashboard 认证用户名（不设则不启用）
#   BT_PASSWORD           — Dashboard 认证密码
#   NGINX_APP_PORT        — 应用公网端口（默认 80）
#   SKIP_NGINX            — 设为 1 跳过 nginx 配置
#
# 端口分配：
#   :80   — 宿主机 Nginx → gateway(:5500)     应用入口
#   :5500 — Docker gateway（内部 nginx）       可切换网关
#   :9900 — Branch-Tester dashboard（直连）    分支管理面板
#   :9001+— 各分支 API 容器直连端口           调试用
# ══════════════════════════════════════════════════════════

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
BT_DIR="${REPO_ROOT}/branch-tester"
LOG_FILE="${BT_DIR}/bt.log"
PID_FILE="${BT_DIR}/.bt/bt.pid"
BACKGROUND=false
ACTION="start"

# ── Parse args ──
for arg in "$@"; do
  case "$arg" in
    --background|-d) BACKGROUND=true ;;
    --stop)          ACTION="stop" ;;
    --status)        ACTION="status" ;;
  esac
done

# ── Colors ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; exit 1; }
info() { echo -e "  ${CYAN}▸${NC} $1"; }

# ══════════════════════════════════════════
# Stop
# ══════════════════════════════════════════
do_stop() {
  echo ""
  echo "  Stopping Branch-Tester..."
  echo ""

  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
      kill "$PID" 2>/dev/null || true
      sleep 1
      ok "Branch-Tester stopped (PID: $PID)"
    else
      warn "Branch-Tester not running (stale PID: $PID)"
    fi
    rm -f "$PID_FILE"
  else
    warn "No PID file found"
  fi

  echo ""
  read -p "  Also stop infrastructure containers (mongo/redis/gateway)? [y/N] " -n 1 -r
  echo ""
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    cd "$REPO_ROOT"
    if command -v docker-compose >/dev/null 2>&1; then
      docker-compose stop mongodb redis gateway 2>/dev/null || true
    else
      docker compose stop mongodb redis gateway 2>/dev/null || true
    fi
    ok "Infrastructure stopped"
  fi
  exit 0
}

# ══════════════════════════════════════════
# Status
# ══════════════════════════════════════════
do_status() {
  echo ""
  echo "  Branch-Tester Status"
  echo "  ────────────────────"

  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    ok "Branch-Tester: running (PID: $(cat "$PID_FILE"))"
  else
    warn "Branch-Tester: not running"
  fi

  for name in prdagent-mongodb prdagent-redis prdagent-gateway; do
    if docker inspect --format='{{.State.Running}}' "$name" 2>/dev/null | grep -q true; then
      ok "$name: running"
    else
      warn "$name: not running"
    fi
  done

  if command -v nginx >/dev/null 2>&1 && systemctl is-active --quiet nginx 2>/dev/null; then
    ok "Nginx: running"
    # Show our config status
    for f in /etc/nginx/conf.d/prdagent-app.conf /etc/nginx/sites-enabled/prdagent-app.conf; do
      [ -f "$f" ] && ok "  App config: $f" && break
    done
  else
    warn "Nginx: not running or not installed"
  fi

  echo ""
  info "Ports:"
  for port in 80 5500 9900; do
    PID_INFO=$(ss -tlnp 2>/dev/null | grep ":${port} " | head -1)
    if [ -n "$PID_INFO" ]; then
      ok "  :${port} — listening"
    else
      warn "  :${port} — not listening"
    fi
  done

  echo ""
  exit 0
}

[ "$ACTION" = "stop" ] && do_stop
[ "$ACTION" = "status" ] && do_status

# ══════════════════════════════════════════
# Defaults
# ══════════════════════════════════════════
export ROOT_ACCESS_USERNAME="${ROOT_ACCESS_USERNAME:-admin}"
export ROOT_ACCESS_PASSWORD="${ROOT_ACCESS_PASSWORD:-PrdAgent123!}"
export JWT_SECRET="${JWT_SECRET:-$(openssl rand -base64 32 2>/dev/null || echo 'dev-only-change-me-32bytes-minimum!!')}"
export ASSETS_PROVIDER="${ASSETS_PROVIDER:-local}"
APP_PORT="${NGINX_APP_PORT:-80}"

# ══════════════════════════════════════════
# Banner
# ══════════════════════════════════════════
echo ""
echo -e "  ${CYAN}PRD Agent Branch-Tester — 一键部署${NC}"
echo "  ══════════════════════════════════════"
echo ""
info "Repo root:     $REPO_ROOT"
info "Branch-Tester: $BT_DIR"
info "Mode:          $([ "$BACKGROUND" = true ] && echo 'background' || echo 'foreground')"
info "Root account:  ${ROOT_ACCESS_USERNAME} / ****"
info "Assets:        ${ASSETS_PROVIDER}"
echo ""

# ══════════════════════════════════════════
# Step 1: Prerequisites
# ══════════════════════════════════════════
echo "  [1/5] Checking prerequisites..."

if ! command -v docker >/dev/null 2>&1; then
  fail "Docker not found. Install: https://docs.docker.com/engine/install/"
fi
ok "Docker"

if command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
elif docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
else
  fail "Docker Compose not found"
fi
ok "Docker Compose ($COMPOSE)"

command -v git >/dev/null 2>&1 || fail "Git not found"
ok "Git"

if ! command -v node >/dev/null 2>&1; then
  warn "Node.js not found, installing via NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
NODE_V=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_V" -lt 20 ]; then
  fail "Node.js >= 20 required (found: v${NODE_V})"
fi
ok "Node.js $(node -v)"

if ! command -v pnpm >/dev/null 2>&1; then
  warn "pnpm not found, installing..."
  npm install -g pnpm
fi
ok "pnpm $(pnpm -v)"

echo ""

# ══════════════════════════════════════════
# Step 2: Infrastructure (Mongo + Redis + Gateway)
# ══════════════════════════════════════════
echo "  [2/5] Starting infrastructure..."

cd "$REPO_ROOT"

docker network inspect prdagent-network >/dev/null 2>&1 || docker network create prdagent-network
ok "Docker network: prdagent-network"

$COMPOSE up -d mongodb redis gateway
sleep 2

for name in prdagent-mongodb prdagent-redis prdagent-gateway; do
  if docker inspect --format='{{.State.Running}}' "$name" 2>/dev/null | grep -q true; then
    ok "$name"
  else
    fail "$name failed to start"
  fi
done

echo ""

# ══════════════════════════════════════════
# Step 3: Install Branch-Tester dependencies
# ══════════════════════════════════════════
echo "  [3/5] Preparing Branch-Tester..."

cd "$BT_DIR"

if [ ! -d "node_modules" ] || [ "package.json" -nt "node_modules/.package-lock.json" ] 2>/dev/null; then
  info "Installing dependencies..."
  pnpm install --frozen-lockfile 2>/dev/null || pnpm install
fi
ok "Dependencies installed"

mkdir -p .bt
echo ""

# ══════════════════════════════════════════
# Step 4: Nginx — 只代理应用(:80 → :5500)
#
# Dashboard(:9900) 不需要 Nginx 代理：
#   branch-tester 直接监听 0.0.0.0:9900，公网已可访问。
#   套一层 nginx 反而会端口冲突（两个进程都 listen :9900）。
# ══════════════════════════════════════════
if [ "${SKIP_NGINX:-}" = "1" ]; then
  echo "  [4/5] Nginx: skipped (SKIP_NGINX=1)"
else
  echo "  [4/5] Configuring Nginx (app :${APP_PORT} → gateway :5500)..."

  # Install nginx if missing
  if ! command -v nginx >/dev/null 2>&1; then
    info "Installing nginx..."
    apt-get update -qq && apt-get install -y -qq nginx
  fi
  ok "Nginx installed"

  # Detect conf directory
  if [ -d "/etc/nginx/sites-available" ]; then
    CONF_DIR="/etc/nginx/sites-available"
    ENABLED_DIR="/etc/nginx/sites-enabled"
  else
    CONF_DIR="/etc/nginx/conf.d"
    ENABLED_DIR=""
  fi

  CONF_FILE="$CONF_DIR/prdagent-app.conf"
  CONF_NAME="prdagent-app.conf"

  # ── Safety check: port conflict ──
  # Check if anything else already listens on APP_PORT
  EXISTING_LISTENER=""
  if [ -n "$ENABLED_DIR" ] && [ -d "$ENABLED_DIR" ]; then
    # Scan enabled configs for 'listen APP_PORT' (excluding our own config)
    for f in "$ENABLED_DIR"/*; do
      [ -f "$f" ] || continue
      REAL_F=$(readlink -f "$f" 2>/dev/null || echo "$f")
      # Skip our own config
      case "$(basename "$REAL_F")" in prdagent-*) continue ;; esac
      if grep -qE "listen\s+${APP_PORT}(\s|;)" "$f" 2>/dev/null; then
        EXISTING_LISTENER="$f"
        break
      fi
    done
  fi
  if [ -d "/etc/nginx/conf.d" ]; then
    for f in /etc/nginx/conf.d/*.conf; do
      [ -f "$f" ] || continue
      case "$(basename "$f")" in prdagent-*) continue ;; esac
      if grep -qE "listen\s+${APP_PORT}(\s|;)" "$f" 2>/dev/null; then
        EXISTING_LISTENER="$f"
        break
      fi
    done
  fi

  if [ -n "$EXISTING_LISTENER" ]; then
    warn "Port ${APP_PORT} already in use by: $EXISTING_LISTENER"
    warn "Skipping nginx config to avoid conflict."
    warn "Options:"
    warn "  1. NGINX_APP_PORT=8080 ./exec_bt.sh  (use different port)"
    warn "  2. Remove $EXISTING_LISTENER manually, then re-run"
    warn "  3. SKIP_NGINX=1 ./exec_bt.sh  (skip nginx entirely)"
  else
    # Detect public IP
    PUBLIC_IP=$(curl -s --max-time 5 ifconfig.me 2>/dev/null || curl -s --max-time 5 ipinfo.io/ip 2>/dev/null || echo "")
    if [ -n "$PUBLIC_IP" ]; then
      ok "Public IP: $PUBLIC_IP"
    else
      PUBLIC_IP="_"
      warn "Could not detect public IP, using server_name _"
    fi

    # Write app config (only this one file, never touch others)
    cat > "$CONF_FILE" <<NGINX_APP
# PRD Agent 应用入口 — exec_bt.sh 自动生成
# :${APP_PORT} → gateway(:5500) → 当前激活分支
# Dashboard(:9900) 由 branch-tester 直接提供，无需代理
server {
    listen ${APP_PORT};
    server_name ${PUBLIC_IP};
    client_max_body_size 30m;

    location / {
        proxy_pass http://127.0.0.1:5500;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 60s;
    }
}
NGINX_APP
    ok "Config written: $CONF_FILE"

    # Enable (sites-available → sites-enabled pattern)
    if [ -n "$ENABLED_DIR" ] && [ -d "$ENABLED_DIR" ]; then
      ln -sf "$CONF_FILE" "$ENABLED_DIR/$CONF_NAME"
      ok "Symlink: $ENABLED_DIR/$CONF_NAME"

      # Check if default site conflicts on same port
      DEFAULT_CONF="$ENABLED_DIR/default"
      if [ -f "$DEFAULT_CONF" ] && grep -qE "listen\s+${APP_PORT}(\s|;)" "$DEFAULT_CONF" 2>/dev/null; then
        warn "default site also listens on :${APP_PORT}"
        warn "Disabling default (backed up to $DEFAULT_CONF.bak)"
        cp "$DEFAULT_CONF" "$DEFAULT_CONF.bak"
        rm -f "$DEFAULT_CONF"
      fi
    fi

    # Validate & reload
    if nginx -t 2>&1; then
      systemctl reload nginx 2>/dev/null || nginx -s reload 2>/dev/null || true
      ok "Nginx reloaded"
    else
      warn "Nginx config test failed — check: nginx -t"
    fi
  fi
fi

echo ""

# ══════════════════════════════════════════
# Step 5: Start Branch-Tester
# ══════════════════════════════════════════
echo "  [5/5] Starting Branch-Tester..."

cd "$BT_DIR"

# Stop old instance if running
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    info "Stopping old instance (PID: $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 1
  fi
fi

if [ "$BACKGROUND" = true ]; then
  nohup pnpm dev > "$LOG_FILE" 2>&1 &
  BT_PID=$!
  echo "$BT_PID" > "$PID_FILE"
  ok "Branch-Tester started (PID: $BT_PID)"
fi

# ══════════════════════════════════════════
# Summary
# ══════════════════════════════════════════
echo ""
echo -e "  ${GREEN}══════════════════════════════════════${NC}"
echo -e "  ${GREEN}  Deployment complete!${NC}"
echo -e "  ${GREEN}══════════════════════════════════════${NC}"
echo ""

if [ -n "${PUBLIC_IP:-}" ] && [ "$PUBLIC_IP" != "_" ]; then
  echo "  Public access:"
  echo "    Application:  http://${PUBLIC_IP}:${APP_PORT}"
  echo "    Dashboard:    http://${PUBLIC_IP}:9900   (直连，无需 nginx)"
  echo ""
fi

echo "  Internal access:"
echo "    Gateway:      http://localhost:5500   (Docker nginx, 可切换分支)"
echo "    Dashboard:    http://localhost:9900   (分支管理面板)"
echo ""
echo "  Login (激活分支后):"
echo "    Username: ${ROOT_ACCESS_USERNAME}"
echo "    Password: ${ROOT_ACCESS_PASSWORD}"
echo ""

if [ "$BACKGROUND" = true ]; then
  echo "  Next steps:"
  echo "    1. 访问 Dashboard 激活一个分支"
  echo "    2. 访问应用入口登录"
  echo ""
  echo "  Management:"
  echo "    Logs:     tail -f ${LOG_FILE}"
  echo "    Status:   $0 --status"
  echo "    Stop:     $0 --stop"
  echo ""
else
  echo "  Starting in foreground (Ctrl+C to stop)..."
  echo ""
  exec pnpm dev
fi
