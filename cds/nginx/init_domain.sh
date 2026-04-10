#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/domain.env"
SHOW_ONLY=0

usage() {
  cat <<'EOF'
Usage:
  ./nginx/init_domain.sh
  ./nginx/init_domain.sh --show
  ./nginx/init_domain.sh --config /path/to/domain.env

作用:
  - 从内部 domain.env 生成 nginx.conf / cds-nginx.conf / acme_apply.sh
  - 正常使用请在 cds 根目录执行: ./exec_cds.sh nginx render
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --config)
      CONFIG_FILE="$2"
      shift 2
      ;;
    --show)
      SHOW_ONLY=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1"
      usage
      exit 1
      ;;
  esac
done

if [ ! -f "$CONFIG_FILE" ]; then
  echo "ERROR: 内部配置文件不存在: $CONFIG_FILE"
  echo "请回到 cds 根目录执行: ./exec_setup.sh"
  exit 1
fi

set -a
. "$CONFIG_FILE"
set +a

MAIN_DOMAIN="${MAIN_DOMAIN:-}"
SWITCH_DOMAIN="${SWITCH_DOMAIN:-switch.${MAIN_DOMAIN}}"
DASHBOARD_DOMAIN="${DASHBOARD_DOMAIN:-cds.${MAIN_DOMAIN}}"
PREVIEW_DOMAIN="${PREVIEW_DOMAIN:-${MAIN_DOMAIN}}"
ENABLE_PREVIEW_SERVER="${ENABLE_PREVIEW_SERVER:-1}"
WORKER_PORT="${WORKER_PORT:-5500}"
DASHBOARD_PORT="${DASHBOARD_PORT:-9900}"
CERT_EMAIL="${CERT_EMAIL:-admin@${MAIN_DOMAIN}}"
NGINX_CONTAINER="${NGINX_CONTAINER:-nginx_miduo}"

if [ -z "${TLS_DOMAINS:-}" ]; then
  TLS_DOMAINS="${MAIN_DOMAIN},${SWITCH_DOMAIN}"
  if [ "$DASHBOARD_DOMAIN" != "$MAIN_DOMAIN" ] && [ "$DASHBOARD_DOMAIN" != "$SWITCH_DOMAIN" ]; then
    TLS_DOMAINS="${TLS_DOMAINS},${DASHBOARD_DOMAIN}"
  fi
fi

if [ -z "$MAIN_DOMAIN" ]; then
  echo "ERROR: MAIN_DOMAIN 不能为空"
  exit 1
fi

if [ "$SHOW_ONLY" = "1" ]; then
  cat <<EOF
MAIN_DOMAIN=${MAIN_DOMAIN}
SWITCH_DOMAIN=${SWITCH_DOMAIN}
DASHBOARD_DOMAIN=${DASHBOARD_DOMAIN}
PREVIEW_DOMAIN=${PREVIEW_DOMAIN}
ENABLE_PREVIEW_SERVER=${ENABLE_PREVIEW_SERVER}
WORKER_PORT=${WORKER_PORT}
DASHBOARD_PORT=${DASHBOARD_PORT}
CERT_EMAIL=${CERT_EMAIL}
NGINX_CONTAINER=${NGINX_CONTAINER}
TLS_DOMAINS=${TLS_DOMAINS}
EOF
  exit 0
fi

mkdir -p "${SCRIPT_DIR}/certs" "${SCRIPT_DIR}/www/.well-known/acme-challenge"

build_worker_exact_server() {
  if [ "$MAIN_DOMAIN" = "$DASHBOARD_DOMAIN" ]; then
    echo "# Worker exact domain omitted because MAIN_DOMAIN equals DASHBOARD_DOMAIN."
    return
  fi
  cat <<EOF
# ────────────────────────────────────────
# 1. Main domain → CDS Worker (gateway)
# ────────────────────────────────────────
server {
    listen 80;
    listen [::]:80;
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;

    server_name ${MAIN_DOMAIN};

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/html;
        allow all;
    }

    location / {
        proxy_pass http://cds_worker;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-Host  \$host;
        proxy_set_header X-Forwarded-Port  \$server_port;
        proxy_set_header Upgrade           \$http_upgrade;
        proxy_set_header Connection        \$connection_upgrade;
        proxy_buffering off;
        proxy_cache     off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        add_header Cache-Control    "no-store, must-revalidate" always;
        add_header Vary             "Cookie" always;
        add_header X-Accel-Buffering "no" always;
    }
}
EOF
}

build_worker_http_exact_server() {
  if [ "$MAIN_DOMAIN" = "$DASHBOARD_DOMAIN" ]; then
    echo "# Worker HTTP exact domain omitted because MAIN_DOMAIN equals DASHBOARD_DOMAIN."
    return
  fi
  cat <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${MAIN_DOMAIN};

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/html;
        allow all;
    }

    location / {
        proxy_pass http://cds_worker;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-Host  \$host;
        proxy_set_header X-Forwarded-Port  \$server_port;
        proxy_set_header Upgrade           \$http_upgrade;
        proxy_set_header Connection        \$connection_upgrade;
        proxy_buffering off;
        proxy_cache     off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
EOF
}

WORKER_EXACT_SERVER="$(build_worker_exact_server)"
WORKER_HTTP_EXACT_SERVER="$(build_worker_http_exact_server)"

sed \
  -e "s/{{MAIN_DOMAIN}}/${MAIN_DOMAIN}/g" \
  -e "s/{{DASHBOARD_DOMAIN}}/${DASHBOARD_DOMAIN}/g" \
  -e "s/{{PREVIEW_DOMAIN}}/${PREVIEW_DOMAIN}/g" \
  -e "s/{{WORKER_PORT}}/${WORKER_PORT}/g" \
  -e "s/{{MASTER_PORT}}/${DASHBOARD_PORT}/g" \
  "${SCRIPT_DIR}/cds-nginx.conf.template" | awk -v block="$WORKER_EXACT_SERVER" '
    { if ($0 == "__WORKER_EXACT_SERVER__") print block; else print }
  ' > "${SCRIPT_DIR}/cds-nginx.conf"

sed \
  -e "s/{{MAIN_DOMAIN}}/${MAIN_DOMAIN}/g" \
  -e "s/{{DASHBOARD_DOMAIN}}/${DASHBOARD_DOMAIN}/g" \
  -e "s/{{PREVIEW_DOMAIN}}/${PREVIEW_DOMAIN}/g" \
  -e "s/{{WORKER_PORT}}/${WORKER_PORT}/g" \
  -e "s/{{MASTER_PORT}}/${DASHBOARD_PORT}/g" \
  "${SCRIPT_DIR}/cds-nginx.http.conf.template" | awk -v block="$WORKER_HTTP_EXACT_SERVER" '
    { if ($0 == "__WORKER_HTTP_EXACT_SERVER__") print block; else print }
  ' > "${SCRIPT_DIR}/cds-nginx.http.conf"

cp "${SCRIPT_DIR}/nginx.conf.template" "${SCRIPT_DIR}/nginx.conf"

sed \
  -e "s|__CONFIG_FILE__|${CONFIG_FILE}|g" \
  "${SCRIPT_DIR}/acme.sh.template" > "${SCRIPT_DIR}/acme_apply.sh"

chmod +x "${SCRIPT_DIR}/acme_apply.sh"

echo "已生成:"
echo "  ${SCRIPT_DIR}/nginx.conf"
echo "  ${SCRIPT_DIR}/cds-nginx.conf"
echo "  ${SCRIPT_DIR}/cds-nginx.http.conf"
echo "  ${SCRIPT_DIR}/acme_apply.sh"
