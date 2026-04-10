#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/domain.env"
COMPOSE_TEMPLATE="${SCRIPT_DIR}/nginx.compose.template.yml"
COMPOSE_FILE="${SCRIPT_DIR}/nginx.compose.yml"
SERVER_CONF_FILE="cds-nginx.conf"

usage() {
  cat <<'EOF'
Usage:
  ./start_nginx.sh
  ./start_nginx.sh up
  ./start_nginx.sh down
  ./start_nginx.sh restart
  ./start_nginx.sh reload
  ./start_nginx.sh status
  ./start_nginx.sh logs

说明:
  - 默认动作是 up
  - 会读取内部生成的 ./domain.env
  - 正常使用请在 cds 根目录执行: ./exec_cds.sh nginx <action>
  - 会自动检查 ./nginx.conf 与 ./cds-nginx.conf 是否存在
EOF
}

ACTION="${1:-up}"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "ERROR: 内部配置文件不存在: $CONFIG_FILE"
  echo "请回到 cds 根目录执行:"
  echo "  ./exec_setup.sh"
  echo "或"
  echo "  ./exec_cds.sh nginx render"
  exit 1
fi

if [ ! -f "$COMPOSE_TEMPLATE" ]; then
  echo "ERROR: Compose 模板不存在: $COMPOSE_TEMPLATE"
  exit 1
fi

set -a
. "$CONFIG_FILE"
set +a

NGINX_CONTAINER="${NGINX_CONTAINER:-nginx_miduo}"
PRIMARY_DOMAIN="${PRIMARY_DOMAIN:-${MAIN_DOMAIN:-}}"

has_cert() {
  [ -f "${SCRIPT_DIR}/certs/${PRIMARY_DOMAIN}.crt" ] && [ -f "${SCRIPT_DIR}/certs/${PRIMARY_DOMAIN}.key" ]
}

render_compose() {
  sed \
    -e "s|__NGINX_CONTAINER__|${NGINX_CONTAINER}|g" \
    -e "s|__SERVER_CONF_FILE__|${SERVER_CONF_FILE}|g" \
    "$COMPOSE_TEMPLATE" > "$COMPOSE_FILE"
}

ensure_rendered() {
  if [ ! -f "${SCRIPT_DIR}/nginx.conf" ] || [ ! -f "${SCRIPT_DIR}/cds-nginx.conf" ]; then
    echo "ERROR: nginx 配置不存在，请回到 cds 根目录执行:"
    echo "  ./exec_cds.sh nginx render"
    exit 1
  fi
  mkdir -p "${SCRIPT_DIR}/certs" "${SCRIPT_DIR}/www/.well-known/acme-challenge"
  if has_cert; then
    SERVER_CONF_FILE="cds-nginx.conf"
  else
    SERVER_CONF_FILE="cds-nginx.http.conf"
    if [ ! -f "${SCRIPT_DIR}/${SERVER_CONF_FILE}" ]; then
      echo "ERROR: 缺少 HTTP bootstrap 配置: ${SCRIPT_DIR}/${SERVER_CONF_FILE}"
      echo "请回到 cds 根目录执行: ./exec_cds.sh nginx render"
      exit 1
    fi
    echo "No certificate found for ${PRIMARY_DOMAIN}, starting nginx in HTTP bootstrap mode."
  fi
  render_compose
}

compose() {
  docker compose -f "$COMPOSE_FILE" "$@"
}

case "$ACTION" in
  up)
    ensure_rendered
    compose up -d
    echo "Nginx started: ${NGINX_CONTAINER}"
    echo "Compose file: ${COMPOSE_FILE}"
    ;;
  down)
    render_compose
    compose down
    ;;
  restart)
    ensure_rendered
    compose down
    compose up -d
    ;;
  reload)
    ensure_rendered
    docker exec "$NGINX_CONTAINER" nginx -t
    docker exec "$NGINX_CONTAINER" nginx -s reload
    ;;
  status)
    render_compose
    compose ps
    ;;
  logs)
    render_compose
    compose logs --tail=200
    ;;
  --help|-h|help)
    usage
    ;;
  *)
    echo "Unknown action: $ACTION"
    usage
    exit 1
    ;;
esac
