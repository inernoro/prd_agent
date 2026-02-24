#!/usr/bin/env bash
# ──────────────────────────────────────────────────────
# PRD Agent Nginx 公网转发一键配置
#
# 用法：
#   ./exec_nginx_setup.sh                          # 用公网 IP 自动检测
#   ./exec_nginx_setup.sh --domain your-domain.com # 指定域名
#   ./exec_nginx_setup.sh --ip 1.2.3.4             # 指定 IP
#   ./exec_nginx_setup.sh --remove                 # 卸载 nginx 配置
#
# 功能：
#   1. 安装宿主机 nginx（如未安装）
#   2. 生成并安装两个站点配置：
#      - 应用入口：80 端口 → gateway(:5500)
#      - Dashboard：指定端口 → branch-tester(:9900)
#   3. 验证配置 + reload nginx
#
# 环境变量（可选）：
#   NGINX_APP_PORT      — 应用监听端口（默认 80）
#   NGINX_DASHBOARD_PORT — Dashboard 监听端口（默认 9900，设为 0 则不配置）
#   GATEWAY_PORT        — 内部 gateway 端口（默认 5500）
#   DASHBOARD_PORT      — 内部 dashboard 端口（默认 9900）
# ──────────────────────────────────────────────────────

set -euo pipefail

# ── Defaults ──
APP_PORT="${NGINX_APP_PORT:-80}"
DASH_PORT="${NGINX_DASHBOARD_PORT:-9900}"
GW_PORT="${GATEWAY_PORT:-5500}"
BT_PORT="${DASHBOARD_PORT:-9900}"
DOMAIN=""
IP=""
REMOVE=false

# ── Parse args ──
while [ $# -gt 0 ]; do
  case "$1" in
    --domain)  DOMAIN="$2"; shift 2 ;;
    --ip)      IP="$2"; shift 2 ;;
    --remove)  REMOVE=true; shift ;;
    *)         echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# ── Detect nginx conf directory ──
if [ -d "/etc/nginx/sites-available" ]; then
  CONF_DIR="/etc/nginx/sites-available"
  ENABLED_DIR="/etc/nginx/sites-enabled"
  USE_SITES=true
elif [ -d "/etc/nginx/conf.d" ]; then
  CONF_DIR="/etc/nginx/conf.d"
  ENABLED_DIR=""
  USE_SITES=false
else
  CONF_DIR="/etc/nginx/conf.d"
  ENABLED_DIR=""
  USE_SITES=false
fi

APP_CONF="prdagent-app.conf"
DASH_CONF="prdagent-dashboard.conf"

# ── Remove mode ──
if [ "$REMOVE" = true ]; then
  echo "Removing nginx configs..."
  rm -f "$CONF_DIR/$APP_CONF" "$CONF_DIR/$DASH_CONF"
  if [ "$USE_SITES" = true ] && [ -n "$ENABLED_DIR" ]; then
    rm -f "$ENABLED_DIR/$APP_CONF" "$ENABLED_DIR/$DASH_CONF"
  fi
  nginx -t && systemctl reload nginx
  echo "Done. Configs removed."
  exit 0
fi

# ── Detect server name ──
if [ -n "$DOMAIN" ]; then
  SERVER_NAME="$DOMAIN"
elif [ -n "$IP" ]; then
  SERVER_NAME="$IP"
else
  # Auto-detect public IP
  SERVER_NAME=$(curl -s --max-time 5 ifconfig.me 2>/dev/null || curl -s --max-time 5 ipinfo.io/ip 2>/dev/null || echo "_")
  if [ "$SERVER_NAME" = "_" ] || [ -z "$SERVER_NAME" ]; then
    echo "WARN: Could not detect public IP, using server_name _"
    SERVER_NAME="_"
  else
    echo "Detected public IP: $SERVER_NAME"
  fi
fi

echo ""
echo "  PRD Agent Nginx Setup"
echo "  ─────────────────────"
echo "  Server name:   $SERVER_NAME"
echo "  App:           :${APP_PORT} → 127.0.0.1:${GW_PORT} (gateway)"
if [ "$DASH_PORT" != "0" ]; then
  echo "  Dashboard:     :${DASH_PORT} → 127.0.0.1:${BT_PORT} (branch-tester)"
fi
echo "  Conf dir:      $CONF_DIR"
echo ""

# ── 1. Ensure nginx is installed ──
if ! command -v nginx >/dev/null 2>&1; then
  echo "[1/4] Installing nginx..."
  apt-get update -qq && apt-get install -y -qq nginx
else
  echo "[1/4] Nginx already installed"
fi

# ── 2. Generate app config ──
echo "[2/4] Writing app config → $CONF_DIR/$APP_CONF"
cat > "$CONF_DIR/$APP_CONF" <<NGINX_APP
# PRD Agent 应用入口 — 自动生成，勿手动修改
# 生成时间: $(date -Iseconds)
# 命令: $0 $*

server {
    listen ${APP_PORT};
    server_name ${SERVER_NAME};

    client_max_body_size 30m;

    location / {
        proxy_pass http://127.0.0.1:${GW_PORT};
        proxy_http_version 1.1;

        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # WebSocket / Vite HMR
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";

        # SSE 流式响应
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 60s;
    }
}
NGINX_APP

# ── 3. Generate dashboard config ──
if [ "$DASH_PORT" != "0" ]; then
  echo "[3/4] Writing dashboard config → $CONF_DIR/$DASH_CONF"
  cat > "$CONF_DIR/$DASH_CONF" <<NGINX_DASH
# Branch-Tester Dashboard — 自动生成，勿手动修改
# 生成时间: $(date -Iseconds)

server {
    listen ${DASH_PORT};
    server_name ${SERVER_NAME};

    location / {
        proxy_pass http://127.0.0.1:${BT_PORT};
        proxy_http_version 1.1;

        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # WebSocket
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";

        # SSE support
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
NGINX_DASH
else
  echo "[3/4] Dashboard: skipped (NGINX_DASHBOARD_PORT=0)"
fi

# ── 4. Enable & reload ──
if [ "$USE_SITES" = true ] && [ -n "$ENABLED_DIR" ]; then
  ln -sf "$CONF_DIR/$APP_CONF" "$ENABLED_DIR/$APP_CONF"
  [ "$DASH_PORT" != "0" ] && ln -sf "$CONF_DIR/$DASH_CONF" "$ENABLED_DIR/$DASH_CONF"
fi

echo "[4/4] Validating & reloading nginx..."
if nginx -t 2>&1; then
  systemctl reload nginx
  echo ""
  echo "  ✓ Setup complete!"
  echo ""
  echo "  Application:  http://${SERVER_NAME}:${APP_PORT}"
  [ "$DASH_PORT" != "0" ] && echo "  Dashboard:    http://${SERVER_NAME}:${DASH_PORT}"
  echo ""
  echo "  Next steps:"
  echo "    1. Ensure gateway(:${GW_PORT}) and dashboard(:${BT_PORT}) are running"
  echo "    2. Open firewall: ufw allow ${APP_PORT}/tcp"
  [ "$DASH_PORT" != "0" ] && echo "    3. Open firewall: ufw allow ${DASH_PORT}/tcp"
  echo "    4. (Optional) Add HTTPS: certbot --nginx -d ${SERVER_NAME}"
  echo ""
  echo "  Remove: $0 --remove"
else
  echo ""
  echo "  ✗ Nginx config validation failed!"
  echo "  Fix errors above, then: nginx -t && systemctl reload nginx"
  exit 1
fi
