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
  - 从 domain.env 生成 nginx.conf / cds-nginx.conf / acme_apply.sh
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
  echo "ERROR: 配置文件不存在: $CONFIG_FILE"
  echo "先执行: cp ${SCRIPT_DIR}/domain.env.example ${SCRIPT_DIR}/domain.env"
  exit 1
fi

set -a
. "$CONFIG_FILE"
set +a

MAIN_DOMAIN="${MAIN_DOMAIN:-}"
SWITCH_DOMAIN="${SWITCH_DOMAIN:-switch.${MAIN_DOMAIN}}"
ACCESS_MODE="${ACCESS_MODE:-prefixed}"
PREVIEW_DOMAIN="${PREVIEW_DOMAIN:-${MAIN_DOMAIN}}"
ENABLE_PREVIEW_SERVER="${ENABLE_PREVIEW_SERVER:-1}"
WORKER_PORT="${WORKER_PORT:-5500}"
DASHBOARD_PORT="${DASHBOARD_PORT:-9900}"
CERT_EMAIL="${CERT_EMAIL:-admin@${MAIN_DOMAIN}}"
NGINX_CONTAINER="${NGINX_CONTAINER:-nginx_miduo}"

case "$ACCESS_MODE" in
  prefixed)
    DEFAULT_WORKER_DOMAIN="${MAIN_DOMAIN}"
    DEFAULT_DASHBOARD_DOMAIN="cds.${MAIN_DOMAIN}"
    ;;
  root)
    DEFAULT_WORKER_DOMAIN="cds.${MAIN_DOMAIN}"
    DEFAULT_DASHBOARD_DOMAIN="${MAIN_DOMAIN}"
    ;;
  *)
    echo "ERROR: ACCESS_MODE 仅支持 prefixed 或 root"
    exit 1
    ;;
esac

WORKER_DOMAIN="${WORKER_DOMAIN:-${DEFAULT_WORKER_DOMAIN}}"
DASHBOARD_DOMAIN="${DASHBOARD_DOMAIN:-${DEFAULT_DASHBOARD_DOMAIN}}"

if [ -z "${TLS_DOMAINS:-}" ]; then
  TLS_DOMAINS="${MAIN_DOMAIN},${SWITCH_DOMAIN}"
  if [ "$WORKER_DOMAIN" != "$MAIN_DOMAIN" ] && [ "$WORKER_DOMAIN" != "$SWITCH_DOMAIN" ]; then
    TLS_DOMAINS="${TLS_DOMAINS},${WORKER_DOMAIN}"
  fi
  if [ "$DASHBOARD_DOMAIN" != "$MAIN_DOMAIN" ] && [ "$DASHBOARD_DOMAIN" != "$SWITCH_DOMAIN" ] && [ "$DASHBOARD_DOMAIN" != "$WORKER_DOMAIN" ]; then
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
ACCESS_MODE=${ACCESS_MODE}
WORKER_DOMAIN=${WORKER_DOMAIN}
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

sed \
  -e "s/{{MAIN_DOMAIN}}/${MAIN_DOMAIN}/g" \
  -e "s/{{WORKER_DOMAIN}}/${WORKER_DOMAIN}/g" \
  -e "s/{{DASHBOARD_DOMAIN}}/${DASHBOARD_DOMAIN}/g" \
  -e "s/{{PREVIEW_DOMAIN}}/${PREVIEW_DOMAIN}/g" \
  -e "s/{{WORKER_PORT}}/${WORKER_PORT}/g" \
  -e "s/{{MASTER_PORT}}/${DASHBOARD_PORT}/g" \
  "${SCRIPT_DIR}/cds-nginx.conf.template" > "${SCRIPT_DIR}/cds-nginx.conf"

sed \
  -e "s/{{MAIN_DOMAIN}}/${MAIN_DOMAIN}/g" \
  -e "s/{{WORKER_DOMAIN}}/${WORKER_DOMAIN}/g" \
  -e "s/{{DASHBOARD_DOMAIN}}/${DASHBOARD_DOMAIN}/g" \
  -e "s/{{PREVIEW_DOMAIN}}/${PREVIEW_DOMAIN}/g" \
  -e "s/{{WORKER_PORT}}/${WORKER_PORT}/g" \
  -e "s/{{MASTER_PORT}}/${DASHBOARD_PORT}/g" \
  "${SCRIPT_DIR}/cds-nginx.http.conf.template" > "${SCRIPT_DIR}/cds-nginx.http.conf"

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
