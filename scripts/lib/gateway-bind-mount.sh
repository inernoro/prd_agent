#!/usr/bin/env sh

GATEWAY_BIND_HOST_STATIC_TARGET=""
GATEWAY_BIND_CONTAINER_STATIC_TARGET=""
GATEWAY_BIND_HOST_STATIC_SHA=""
GATEWAY_BIND_CONTAINER_STATIC_SHA=""
GATEWAY_BIND_HOST_NGINX_SHA=""
GATEWAY_BIND_CONTAINER_NGINX_SHA=""

gateway_bind_mounts_are_coherent() {
  gateway_container_id="$1"
  active_static_root="$2"
  active_nginx_conf_root="$3"

  GATEWAY_BIND_HOST_STATIC_TARGET="$(readlink "$active_static_root/current" 2>/dev/null || true)"
  GATEWAY_BIND_CONTAINER_STATIC_TARGET="$(docker exec "$gateway_container_id" readlink /usr/share/nginx/html/current 2>/dev/null || true)"
  GATEWAY_BIND_HOST_STATIC_SHA="$(sha256sum "$active_static_root/current/index.html" 2>/dev/null | awk '{print $1}' || true)"
  GATEWAY_BIND_CONTAINER_STATIC_SHA="$(docker exec "$gateway_container_id" sha256sum /usr/share/nginx/html/current/index.html 2>/dev/null | awk '{print $1}' || true)"
  GATEWAY_BIND_HOST_NGINX_SHA="$(sha256sum "$active_nginx_conf_root/branches/_standalone.conf" 2>/dev/null | awk '{print $1}' || true)"
  GATEWAY_BIND_CONTAINER_NGINX_SHA="$(docker exec "$gateway_container_id" sha256sum /etc/nginx/conf.d/branches/_standalone.conf 2>/dev/null | awk '{print $1}' || true)"

  [ -n "$GATEWAY_BIND_HOST_STATIC_TARGET" ] \
    && [ -n "$GATEWAY_BIND_HOST_STATIC_SHA" ] \
    && [ -n "$GATEWAY_BIND_HOST_NGINX_SHA" ] \
    && [ "$GATEWAY_BIND_CONTAINER_STATIC_TARGET" = "$GATEWAY_BIND_HOST_STATIC_TARGET" ] \
    && [ "$GATEWAY_BIND_CONTAINER_STATIC_SHA" = "$GATEWAY_BIND_HOST_STATIC_SHA" ] \
    && [ "$GATEWAY_BIND_CONTAINER_NGINX_SHA" = "$GATEWAY_BIND_HOST_NGINX_SHA" ]
}
