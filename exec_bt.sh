#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════
# PRD Agent Branch-Tester 一键部署
#
# 用法：
#   ./exec_bt.sh                # 前台运行
#   ./exec_bt.sh -d             # 后台运行
#   ./exec_bt.sh --test         # 自检（不启动，只验证所有组件）
#   ./exec_bt.sh --status       # 查看状态
#   ./exec_bt.sh --stop         # 停止
#
# 架构文档：doc/arch.exec-bt.md
# ══════════════════════════════════════════════════════════

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
BT_DIR="${REPO_ROOT}/branch-tester"
LOG_FILE="${BT_DIR}/bt.log"
PID_FILE="${BT_DIR}/.bt/bt.pid"
BACKGROUND=false
ACTION="start"

for arg in "$@"; do
  case "$arg" in
    --background|-d) BACKGROUND=true ;;
    --stop)          ACTION="stop" ;;
    --status)        ACTION="status" ;;
    --test)          ACTION="test" ;;
  esac
done

# ── Colors ──
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
die()  { echo -e "  ${RED}✗${NC} $1"; exit 1; }
info() { echo -e "  ${CYAN}▸${NC} $1"; }

# ══════════════════════════════════════════
# --stop
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
  read -rp "  Also stop infrastructure containers (mongo/redis/gateway)? [y/N] " -n 1
  echo ""
  if [[ ${REPLY:-} =~ ^[Yy]$ ]]; then
    cd "$REPO_ROOT"
    docker compose stop mongodb redis gateway 2>/dev/null \
      || docker-compose stop mongodb redis gateway 2>/dev/null \
      || true
    ok "Infrastructure stopped"
  fi
  exit 0
}

# ══════════════════════════════════════════
# --status
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
      ok "$name"
    else
      warn "$name: not running"
    fi
  done

  if docker inspect --format='{{.State.Running}}' prdagent-api 2>/dev/null | grep -q true; then
    warn "prdagent-api: running (独立部署残留, BT 模式下应停止)"
  fi

  if command -v nginx >/dev/null 2>&1 && systemctl is-active --quiet nginx 2>/dev/null; then
    ok "Host Nginx: running"
  else
    warn "Host Nginx: not running"
  fi

  echo ""
  info "Ports:"
  for port in 80 5500 9900; do
    if ss -tlnp 2>/dev/null | grep -q ":${port} "; then
      ok "  :${port} listening"
    else
      warn "  :${port} not listening"
    fi
  done

  echo ""
  exit 0
}

# ══════════════════════════════════════════
# --test
# ══════════════════════════════════════════
do_test() {
  echo ""
  echo "  Branch-Tester Self-Test"
  echo "  ═══════════════════════"
  echo ""
  PASS=0; TOTAL=0

  t() {
    TOTAL=$((TOTAL + 1))
    local id="$1"; local desc="$2"; shift 2
    if "$@" >/dev/null 2>&1; then
      ok "[$id] $desc"; PASS=$((PASS + 1))
    else
      fail "[$id] $desc"
    fi
  }

  t_not() {
    TOTAL=$((TOTAL + 1))
    local id="$1"; local desc="$2"; shift 2
    if ! "$@" >/dev/null 2>&1; then
      ok "[$id] $desc"; PASS=$((PASS + 1))
    else
      fail "[$id] $desc"
    fi
  }

  echo "  Pre-flight"
  echo "  ----------"
  t "T01" "docker daemon"                docker info
  t "T02" "docker compose"               docker compose version
  t "T03" "node >= 20"                   node -e "process.exit(parseInt(process.version.slice(1))>=20?0:1)"
  t "T04" "pnpm"                         pnpm -v
  t "T05" "git"                          git --version

  echo ""
  echo "  Infrastructure"
  echo "  --------------"
  t     "T10" "prdagent-network"              docker network inspect prdagent-network
  t     "T11" "prdagent-mongodb running"      docker inspect --format='{{.State.Running}}' prdagent-mongodb
  t     "T12" "prdagent-redis running"        docker inspect --format='{{.State.Running}}' prdagent-redis
  t     "T13" "prdagent-gateway running"      docker inspect --format='{{.State.Running}}' prdagent-gateway
  t     "T14" "gateway :5500 responds"        curl -sf --max-time 3 http://localhost:5500
  t_not "T15" "prdagent-api not running"      docker inspect --format='{{.State.Running}}' prdagent-api

  echo ""
  echo "  Branch-Tester"
  echo "  -------------"
  if [ -f "$PID_FILE" ]; then
    t "T20" "BT process alive"            kill -0 "$(cat "$PID_FILE")"
  else
    TOTAL=$((TOTAL + 1)); fail "[T20] BT PID file not found"
  fi
  t "T21" "dashboard :9900 responds"      curl -sf --max-time 3 http://localhost:9900
  t "T22" "state.json exists"             test -f "${REPO_ROOT}/.bt/state.json"

  echo ""
  echo "  Host Nginx"
  echo "  ----------"
  if command -v nginx >/dev/null 2>&1; then
    t "T30" "nginx running"               systemctl is-active --quiet nginx
    TOTAL=$((TOTAL + 1))
    if [ -f /etc/nginx/sites-available/prdagent-app.conf ] || [ -f /etc/nginx/conf.d/prdagent-app.conf ]; then
      ok "[T31] prdagent-app.conf exists"; PASS=$((PASS + 1))
    else
      fail "[T31] prdagent-app.conf not found"
    fi
    t "T32" "nginx -t passes"             nginx -t
    t "T33" ":80 responds"                curl -sf --max-time 3 http://localhost:80
  else
    for id in T30 T31 T32 T33; do
      TOTAL=$((TOTAL + 1)); warn "[$id] nginx not installed (skipped)"
    done
  fi

  echo ""
  echo "  End-to-End"
  echo "  ----------"
  PUBLIC_IP=$(curl -s --max-time 3 ifconfig.me 2>/dev/null || echo "")
  if [ -n "$PUBLIC_IP" ]; then
    t "T40" "public :80 ($PUBLIC_IP)"     curl -sf --max-time 5 "http://${PUBLIC_IP}"
    t "T41" "public :9900 ($PUBLIC_IP)"   curl -sf --max-time 5 "http://${PUBLIC_IP}:9900"
  else
    TOTAL=$((TOTAL + 2)); warn "[T40] cannot detect public IP"; warn "[T41] skipped"
  fi

  echo ""
  echo "  ────────────────────"
  if [ "$PASS" -eq "$TOTAL" ]; then
    echo -e "  ${GREEN}${PASS}/${TOTAL} ALL PASSED${NC}"
  else
    echo -e "  ${YELLOW}${PASS}/${TOTAL} passed${NC}"
  fi
  echo ""
  [ "$PASS" -eq "$TOTAL" ] && exit 0 || exit 1
}

[ "$ACTION" = "stop" ] && do_stop
[ "$ACTION" = "status" ] && do_status
[ "$ACTION" = "test" ] && do_test

# ══════════════════════════════════════════
# Defaults
# ══════════════════════════════════════════
export ROOT_ACCESS_USERNAME="${ROOT_ACCESS_USERNAME:-admin}"
export ROOT_ACCESS_PASSWORD="${ROOT_ACCESS_PASSWORD:-PrdAgent123!}"
export JWT_SECRET="${JWT_SECRET:-$(openssl rand -base64 32 2>/dev/null || echo 'dev-only-change-me-32bytes-minimum!!')}"
export ASSETS_PROVIDER="${ASSETS_PROVIDER:-local}"
APP_PORT="${NGINX_APP_PORT:-80}"

echo ""
echo -e "  ${CYAN}PRD Agent Branch-Tester${NC}"
echo "  ══════════════════════"
echo ""

# ══════════════════════════════════════════
# PRE-FLIGHT: 在做任何变更前检查冲突
# ══════════════════════════════════════════
echo "  [PRE] Pre-flight..."

command -v docker >/dev/null 2>&1       || die "docker not found"
docker compose version >/dev/null 2>&1 \
  || command -v docker-compose >/dev/null 2>&1 \
  || die "docker compose not found"
command -v git >/dev/null 2>&1          || die "git not found"

if ! command -v node >/dev/null 2>&1; then
  warn "Node.js not found, installing..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs \
    || die "Failed to install Node.js"
fi
NODE_V=$(node -v | sed 's/v//' | cut -d. -f1)
[ "$NODE_V" -ge 20 ] || die "Node.js >= 20 required (found: v${NODE_V})"

if ! command -v pnpm >/dev/null 2>&1; then
  warn "pnpm not found, installing..."
  npm install -g pnpm || die "Failed to install pnpm"
fi

# Port :5500 — ours or free?
if ss -tlnp 2>/dev/null | grep -q ":5500 "; then
  if docker inspect --format='{{.Name}}' prdagent-gateway 2>/dev/null | grep -q prdagent-gateway; then
    ok ":5500 = prdagent-gateway"
  else
    die ":5500 occupied by unknown process"
  fi
fi

# Port :9900 — ours or free?
if ss -tlnp 2>/dev/null | grep -q ":9900 "; then
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    ok ":9900 = previous BT (will replace)"
  else
    warn ":9900 occupied, BT may fail to bind"
  fi
fi

ok "Pre-flight passed"
echo ""

# ══════════════════════════════════════════
# [1/4] Infrastructure
# ══════════════════════════════════════════
echo "  [1/4] Infrastructure..."
cd "$REPO_ROOT"

docker network inspect prdagent-network >/dev/null 2>&1 \
  || docker network create prdagent-network >/dev/null 2>&1

if docker compose version >/dev/null 2>&1; then COMPOSE="docker compose"; else COMPOSE="docker-compose"; fi

# compose up 会因 gateway.depends_on 尝试拉 api 镜像
# 即使 api 拉取失败, gateway 仍启动 (soft dependency)
$COMPOSE up -d mongodb redis gateway 2>&1 | tail -5
sleep 2

for name in prdagent-mongodb prdagent-redis prdagent-gateway; do
  docker inspect --format='{{.State.Running}}' "$name" 2>/dev/null | grep -q true \
    || die "$name failed to start. Check: docker logs $name"
  ok "$name"
done

# S1: 停掉独立部署的 prdagent-api (BT 接管 API 生命周期)
if docker inspect --format='{{.State.Running}}' prdagent-api 2>/dev/null | grep -q true; then
  warn "Stopping standalone prdagent-api (BT manages its own)"
  docker stop prdagent-api >/dev/null 2>&1 || true
  ok "prdagent-api stopped"
fi
echo ""

# ══════════════════════════════════════════
# [2/4] Dependencies
# ══════════════════════════════════════════
echo "  [2/4] Dependencies..."
cd "$BT_DIR"
[ -d "node_modules" ] || { info "Installing..."; pnpm install --frozen-lockfile 2>/dev/null || pnpm install; }
ok "Ready"
mkdir -p .bt
echo ""

# ══════════════════════════════════════════
# [3/4] Host Nginx
# 只写一个文件: prdagent-app.conf
# Dashboard(:9900) 直连, 不代理
# ══════════════════════════════════════════
if [ "${SKIP_NGINX:-}" = "1" ]; then
  echo "  [3/4] Nginx: skipped"
else
  echo "  [3/4] Nginx (:${APP_PORT} → :5500)..."

  if ! command -v nginx >/dev/null 2>&1; then
    info "Installing nginx..."
    apt-get update -qq && apt-get install -y -qq nginx 2>/dev/null || { warn "Failed, skipping nginx"; SKIP_NGINX=1; }
  fi

  if [ "${SKIP_NGINX:-}" != "1" ]; then
    if [ -d "/etc/nginx/sites-available" ]; then
      CONF_DIR="/etc/nginx/sites-available"; ENABLED_DIR="/etc/nginx/sites-enabled"
    else
      CONF_DIR="/etc/nginx/conf.d"; ENABLED_DIR=""
    fi

    # P3/P4: port conflict scan
    PORT_CONFLICT=""
    for d in /etc/nginx/sites-enabled /etc/nginx/conf.d; do
      [ -d "$d" ] || continue
      for f in "$d"/*; do
        [ -f "$f" ] || continue
        BASENAME=$(basename "$(readlink -f "$f" 2>/dev/null || echo "$f")")
        case "$BASENAME" in prdagent-*) continue ;; esac
        grep -qE "listen\s+${APP_PORT}(\s|;)" "$f" 2>/dev/null && { PORT_CONFLICT="$f"; break 2; }
      done
    done
    [ -z "$PORT_CONFLICT" ] && ss -tlnp 2>/dev/null | grep -q ":${APP_PORT} " && PORT_CONFLICT="(non-nginx process)"

    if [ -n "$PORT_CONFLICT" ]; then
      warn ":${APP_PORT} conflict: $PORT_CONFLICT"
      warn "Try: NGINX_APP_PORT=8080 ./exec_bt.sh -d"
    else
      PUBLIC_IP=$(curl -s --max-time 5 ifconfig.me 2>/dev/null || curl -s --max-time 5 ipinfo.io/ip 2>/dev/null || echo "_")

      cat > "$CONF_DIR/prdagent-app.conf" <<NGINX_CONF
# exec_bt.sh auto-generated $(date -Iseconds)
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
NGINX_CONF

      if [ -n "$ENABLED_DIR" ] && [ -d "$ENABLED_DIR" ]; then
        ln -sf "$CONF_DIR/prdagent-app.conf" "$ENABLED_DIR/prdagent-app.conf"
        # N3: default conflict → backup then disable
        if [ -f "$ENABLED_DIR/default" ] && grep -qE "listen\s+${APP_PORT}(\s|;)" "$ENABLED_DIR/default" 2>/dev/null; then
          cp "$ENABLED_DIR/default" "$ENABLED_DIR/default.bak.$(date +%s)"
          rm -f "$ENABLED_DIR/default"
          warn "Disabled default site (backed up)"
        fi
      fi

      if nginx -t 2>&1; then
        systemctl reload nginx 2>/dev/null || nginx -s reload 2>/dev/null || true
        ok ":${APP_PORT} → :5500"
        [ "$PUBLIC_IP" != "_" ] && ok "Public IP: $PUBLIC_IP"
      else
        warn "nginx -t failed"
      fi
    fi
  fi
fi
echo ""

# ══════════════════════════════════════════
# [4/4] Start Branch-Tester
# ══════════════════════════════════════════
echo "  [4/4] Branch-Tester..."
cd "$BT_DIR"

if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    info "Replacing (PID: $OLD_PID)"
    kill "$OLD_PID" 2>/dev/null || true
    sleep 1
  fi
  rm -f "$PID_FILE"
fi

if [ "$BACKGROUND" = true ]; then
  nohup pnpm dev > "$LOG_FILE" 2>&1 &
  echo "$!" > "$PID_FILE"
  ok "Started (PID: $(cat "$PID_FILE"))"
fi

# ══════════════════════════════════════════
# Summary
# ══════════════════════════════════════════
echo ""
echo -e "  ${GREEN}Done!${NC}"
echo ""
if [ -n "${PUBLIC_IP:-}" ] && [ "${PUBLIC_IP:-}" != "_" ]; then
echo "  Application  http://${PUBLIC_IP}:${APP_PORT}"
echo "  Dashboard    http://${PUBLIC_IP}:9900"
else
echo "  Application  http://localhost:${APP_PORT}      (activate a branch first)"
echo "  Dashboard    http://localhost:9900"
fi
echo ""
echo "  Login: ${ROOT_ACCESS_USERNAME} / ${ROOT_ACCESS_PASSWORD}"
echo ""
if [ "$BACKGROUND" = true ]; then
  echo "  tail -f ${LOG_FILE}"
  echo "  ./exec_bt.sh --test"
  echo "  ./exec_bt.sh --stop"
  echo ""
else
  echo "  Foreground mode (Ctrl+C to stop)..."
  echo ""
  exec pnpm dev
fi
