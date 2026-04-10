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
  - 从内部 domain.env 生成 nginx.conf / cds-nginx.conf / cds-nginx.http.conf / acme_apply.sh
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

ROOT_DOMAINS="${ROOT_DOMAINS:-}"
PRIMARY_DOMAIN="${PRIMARY_DOMAIN:-}"
WORKER_PORT="${WORKER_PORT:-5500}"
DASHBOARD_PORT="${DASHBOARD_PORT:-9900}"
CERT_EMAIL="${CERT_EMAIL:-}"
NGINX_CONTAINER="${NGINX_CONTAINER:-nginx_miduo}"

if [ -z "$ROOT_DOMAINS" ]; then
  echo "ERROR: ROOT_DOMAINS 不能为空"
  exit 1
fi

if [ -z "$PRIMARY_DOMAIN" ]; then
  PRIMARY_DOMAIN="$(printf '%s' "$ROOT_DOMAINS" | cut -d',' -f1 | xargs)"
fi

if [ -z "${TLS_DOMAINS:-}" ]; then
  TLS_DOMAINS="$ROOT_DOMAINS"
fi

parse_domains() {
  local raw="$1"
  local -n out_ref="$2"
  local item
  IFS=',' read -r -a out_ref <<< "$raw"
  for item in "${!out_ref[@]}"; do
    out_ref[$item]="$(printf '%s' "${out_ref[$item]}" | xargs)"
  done
}

DOMAIN_ARRAY=()
parse_domains "$ROOT_DOMAINS" DOMAIN_ARRAY

if [ "${#DOMAIN_ARRAY[@]}" -eq 0 ] || [ -z "${DOMAIN_ARRAY[0]}" ]; then
  echo "ERROR: ROOT_DOMAINS 不能为空"
  exit 1
fi

if [ "$SHOW_ONLY" = "1" ]; then
  cat <<EOF
ROOT_DOMAINS=${ROOT_DOMAINS}
PRIMARY_DOMAIN=${PRIMARY_DOMAIN}
WORKER_PORT=${WORKER_PORT}
DASHBOARD_PORT=${DASHBOARD_PORT}
CERT_EMAIL=${CERT_EMAIL}
NGINX_CONTAINER=${NGINX_CONTAINER}
TLS_DOMAINS=${TLS_DOMAINS}
EOF
  exit 0
fi

mkdir -p "${SCRIPT_DIR}/certs" "${SCRIPT_DIR}/www/.well-known/acme-challenge"

build_dashboard_server_tls() {
  local domain="$1"
  cat <<EOF
server {
    listen 80;
    listen [::]:80;
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;

    server_name ${domain};

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/html;
        allow all;
    }

    location / {
        proxy_pass http://cds_dashboard;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
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

build_preview_server_tls() {
  local domain="$1"
  cat <<EOF
server {
    listen 80;
    listen [::]:80;
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;

    server_name *.${domain};

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
        add_header Cache-Control    "no-cache" always;
        add_header X-Accel-Buffering "no"      always;
    }
}
EOF
}

build_dashboard_server_http() {
  local domain="$1"
  cat <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/html;
        allow all;
    }

    location / {
        proxy_pass http://cds_dashboard;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
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

build_preview_server_http() {
  local domain="$1"
  cat <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name *.${domain};

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

{
  cat <<EOF
# ──────────────────────────────────────────────────────────────
# CDS Nginx Configuration (generated)
#
# Routing:
#   - Any exact root domain -> CDS Dashboard (:${DASHBOARD_PORT})
#   - Any subdomain under each root domain -> CDS Worker (:${WORKER_PORT})
#   - Example: feature.${PRIMARY_DOMAIN} -> preview branch
#
# TLS:
#   - Shared certificate file: /etc/nginx/certs/${PRIMARY_DOMAIN}.crt
#   - If you need HTTPS for *.domain, ensure the certificate SANs include wildcard entries.
# ──────────────────────────────────────────────────────────────

ssl_certificate     /etc/nginx/certs/${PRIMARY_DOMAIN}.crt;
ssl_certificate_key /etc/nginx/certs/${PRIMARY_DOMAIN}.key;
ssl_protocols       TLSv1.2 TLSv1.3;

upstream cds_worker {
    server 127.0.0.1:${WORKER_PORT};
    keepalive 16;
}

upstream cds_dashboard {
    server 127.0.0.1:${DASHBOARD_PORT};
    keepalive 8;
}

EOF

  for domain in "${DOMAIN_ARRAY[@]}"; do
    [ -n "$domain" ] || continue
    build_dashboard_server_tls "$domain"
    printf '\n'
    build_preview_server_tls "$domain"
    printf '\n'
  done
} > "${SCRIPT_DIR}/cds-nginx.conf"

{
  cat <<EOF
# ──────────────────────────────────────────────────────────────
# CDS HTTP Bootstrap Config (generated)
# ──────────────────────────────────────────────────────────────

upstream cds_worker {
    server 127.0.0.1:${WORKER_PORT};
    keepalive 16;
}

upstream cds_dashboard {
    server 127.0.0.1:${DASHBOARD_PORT};
    keepalive 8;
}

EOF

  for domain in "${DOMAIN_ARRAY[@]}"; do
    [ -n "$domain" ] || continue
    build_dashboard_server_http "$domain"
    printf '\n'
    build_preview_server_http "$domain"
    printf '\n'
  done
} > "${SCRIPT_DIR}/cds-nginx.http.conf"

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
