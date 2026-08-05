#!/usr/bin/env sh

GATEWAY_BIND_STATE="not-checked"
GATEWAY_BIND_REASON=""
GATEWAY_BIND_INITIAL_STATE="not-checked"
GATEWAY_BIND_INITIAL_REASON=""
GATEWAY_BIND_RECREATED="0"
GATEWAY_BIND_CONTAINER_BEFORE=""
GATEWAY_BIND_CONTAINER_AFTER=""
GATEWAY_BIND_HOST_STATIC_TARGET=""
GATEWAY_BIND_CONTAINER_STATIC_TARGET=""
GATEWAY_BIND_HOST_STATIC_SHA=""
GATEWAY_BIND_CONTAINER_STATIC_SHA=""
GATEWAY_BIND_HOST_NGINX_SHA=""
GATEWAY_BIND_CONTAINER_NGINX_SHA=""
GATEWAY_BIND_INITIAL_HOST_STATIC_TARGET=""
GATEWAY_BIND_INITIAL_CONTAINER_STATIC_TARGET=""
GATEWAY_BIND_INITIAL_HOST_STATIC_SHA=""
GATEWAY_BIND_INITIAL_CONTAINER_STATIC_SHA=""
GATEWAY_BIND_INITIAL_HOST_NGINX_SHA=""
GATEWAY_BIND_INITIAL_CONTAINER_NGINX_SHA=""

gateway_bind_mount_probe() {
  gateway_container_id="$1"
  active_static_root="$2"
  active_nginx_conf_root="$3"
  GATEWAY_BIND_REASON=""
  GATEWAY_BIND_HOST_STATIC_TARGET=""
  GATEWAY_BIND_CONTAINER_STATIC_TARGET=""
  GATEWAY_BIND_HOST_STATIC_SHA=""
  GATEWAY_BIND_CONTAINER_STATIC_SHA=""
  GATEWAY_BIND_HOST_NGINX_SHA=""
  GATEWAY_BIND_CONTAINER_NGINX_SHA=""

  if ! GATEWAY_BIND_HOST_STATIC_TARGET="$(readlink "$active_static_root/current" 2>/dev/null)"; then
    GATEWAY_BIND_STATE="probe-error"
    GATEWAY_BIND_REASON="host-static-target-unreadable"
    return 2
  fi
  if ! GATEWAY_BIND_CONTAINER_STATIC_TARGET="$(docker exec "$gateway_container_id" readlink /usr/share/nginx/html/current 2>/dev/null)"; then
    GATEWAY_BIND_STATE="probe-error"
    GATEWAY_BIND_REASON="container-static-target-unreadable"
    return 2
  fi
  if [ -z "$GATEWAY_BIND_HOST_STATIC_TARGET" ] || [ -z "$GATEWAY_BIND_CONTAINER_STATIC_TARGET" ]; then
    GATEWAY_BIND_STATE="probe-error"
    GATEWAY_BIND_REASON="empty-static-target-probe-output"
    return 2
  fi
  if ! host_static_line="$(sha256sum "$active_static_root/current/index.html" 2>/dev/null)"; then
    GATEWAY_BIND_STATE="probe-error"
    GATEWAY_BIND_REASON="host-static-index-unreadable"
    return 2
  fi
  GATEWAY_BIND_HOST_STATIC_SHA="$(printf '%s\n' "$host_static_line" | awk '{print $1}')"
  if ! container_static_line="$(docker exec "$gateway_container_id" sha256sum /usr/share/nginx/html/current/index.html 2>/dev/null)"; then
    GATEWAY_BIND_STATE="probe-error"
    GATEWAY_BIND_REASON="container-static-index-unreadable"
    return 2
  fi
  GATEWAY_BIND_CONTAINER_STATIC_SHA="$(printf '%s\n' "$container_static_line" | awk '{print $1}')"
  if ! host_nginx_line="$(sha256sum "$active_nginx_conf_root/branches/_standalone.conf" 2>/dev/null)"; then
    GATEWAY_BIND_STATE="probe-error"
    GATEWAY_BIND_REASON="host-nginx-config-unreadable"
    return 2
  fi
  GATEWAY_BIND_HOST_NGINX_SHA="$(printf '%s\n' "$host_nginx_line" | awk '{print $1}')"
  if ! container_nginx_line="$(docker exec "$gateway_container_id" sha256sum /etc/nginx/conf.d/branches/_standalone.conf 2>/dev/null)"; then
    GATEWAY_BIND_STATE="probe-error"
    GATEWAY_BIND_REASON="container-nginx-config-unreadable"
    return 2
  fi
  GATEWAY_BIND_CONTAINER_NGINX_SHA="$(printf '%s\n' "$container_nginx_line" | awk '{print $1}')"

  for required_hash in \
    "$GATEWAY_BIND_HOST_STATIC_SHA" \
    "$GATEWAY_BIND_CONTAINER_STATIC_SHA" \
    "$GATEWAY_BIND_HOST_NGINX_SHA" \
    "$GATEWAY_BIND_CONTAINER_NGINX_SHA"; do
    if ! printf '%s' "$required_hash" | grep -Eq '^[0-9a-fA-F]{64}$'; then
      GATEWAY_BIND_STATE="probe-error"
      GATEWAY_BIND_REASON="invalid-sha256-probe-output"
      return 2
    fi
  done

  if [ "$GATEWAY_BIND_CONTAINER_STATIC_TARGET" = "$GATEWAY_BIND_HOST_STATIC_TARGET" ] \
    && [ "$GATEWAY_BIND_CONTAINER_STATIC_SHA" = "$GATEWAY_BIND_HOST_STATIC_SHA" ] \
    && [ "$GATEWAY_BIND_CONTAINER_NGINX_SHA" = "$GATEWAY_BIND_HOST_NGINX_SHA" ]; then
    GATEWAY_BIND_STATE="coherent"
    return 0
  fi

  GATEWAY_BIND_STATE="confirmed-drift"
  GATEWAY_BIND_REASON="host-container-values-differ"
  return 1
}

gateway_validate_compose_project_directory() {
  compose_project_directory="$1"
  active_static_root="$2"
  active_nginx_conf_root="$3"
  compose_file="${COMPOSE_FILE:-$compose_project_directory/docker-compose.yml}"

  case "$compose_project_directory" in
    /*) ;;
    *)
      GATEWAY_BIND_REASON="compose-project-directory-not-absolute"
      return 1
      ;;
  esac
  if [ ! -d "$compose_project_directory" ]; then
    GATEWAY_BIND_REASON="compose-project-directory-missing"
    return 1
  fi
  if [ ! -f "$compose_file" ]; then
    GATEWAY_BIND_REASON="compose-file-missing"
    return 1
  fi

  resolved_project="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$compose_project_directory")"
  resolved_static="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$active_static_root")"
  resolved_nginx="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$active_nginx_conf_root")"
  if [ "$resolved_static" != "$resolved_project/deploy/web/dist" ] \
    || [ "$resolved_nginx" != "$resolved_project/deploy/nginx/conf.d" ]; then
    GATEWAY_BIND_REASON="compose-project-directory-does-not-own-active-mounts"
    return 1
  fi
}

gateway_reconcile_bind_mounts() {
  gateway_container_id="$1"
  active_static_root="$2"
  active_nginx_conf_root="$3"
  compose_project_directory="$4"
  gateway_service="$5"

  GATEWAY_BIND_RECREATED="0"
  GATEWAY_BIND_CONTAINER_BEFORE="$gateway_container_id"
  GATEWAY_BIND_CONTAINER_AFTER=""
  if gateway_bind_mount_probe "$gateway_container_id" "$active_static_root" "$active_nginx_conf_root"; then
    probe_result=0
  else
    probe_result=$?
  fi
  GATEWAY_BIND_INITIAL_STATE="$GATEWAY_BIND_STATE"
  GATEWAY_BIND_INITIAL_REASON="$GATEWAY_BIND_REASON"
  GATEWAY_BIND_INITIAL_HOST_STATIC_TARGET="$GATEWAY_BIND_HOST_STATIC_TARGET"
  GATEWAY_BIND_INITIAL_CONTAINER_STATIC_TARGET="$GATEWAY_BIND_CONTAINER_STATIC_TARGET"
  GATEWAY_BIND_INITIAL_HOST_STATIC_SHA="$GATEWAY_BIND_HOST_STATIC_SHA"
  GATEWAY_BIND_INITIAL_CONTAINER_STATIC_SHA="$GATEWAY_BIND_CONTAINER_STATIC_SHA"
  GATEWAY_BIND_INITIAL_HOST_NGINX_SHA="$GATEWAY_BIND_HOST_NGINX_SHA"
  GATEWAY_BIND_INITIAL_CONTAINER_NGINX_SHA="$GATEWAY_BIND_CONTAINER_NGINX_SHA"

  if [ "$probe_result" -eq 0 ]; then
    GATEWAY_BIND_CONTAINER_AFTER="$gateway_container_id"
    return 0
  fi

  if [ "$probe_result" -eq 2 ]; then
    echo "ERROR: gateway bind mount probe failed: $GATEWAY_BIND_REASON" >&2
    return 2
  fi
  if ! gateway_validate_compose_project_directory "$compose_project_directory" "$active_static_root" "$active_nginx_conf_root"; then
    echo "ERROR: refusing gateway recreation: $GATEWAY_BIND_REASON" >&2
    return 2
  fi

  echo "Gateway bind mount drift confirmed; recreating only the gateway from the stable production project directory..."
  if ! compose_run up -d --no-deps --force-recreate "$gateway_service"; then
    GATEWAY_BIND_STATE="repair-failed"
    GATEWAY_BIND_REASON="gateway-compose-recreation-failed"
    return 2
  fi
  gateway_container_id="$(compose_run ps -q "$gateway_service" 2>/dev/null | head -n 1)"
  if [ -z "$gateway_container_id" ]; then
    GATEWAY_BIND_STATE="repair-failed"
    GATEWAY_BIND_REASON="recreated-gateway-container-missing"
    return 2
  fi
  GATEWAY_BIND_CONTAINER_AFTER="$gateway_container_id"
  GATEWAY_BIND_RECREATED="1"
  if ! reload_active_gateway; then
    GATEWAY_BIND_STATE="repair-failed"
    GATEWAY_BIND_REASON="recreated-gateway-reload-failed"
    return 2
  fi
  if gateway_bind_mount_probe "$gateway_container_id" "$active_static_root" "$active_nginx_conf_root"; then
    echo "Gateway bind mount drift repaired: static and nginx configuration now match the host release roots"
    return 0
  fi

  repair_probe_result=$?
  GATEWAY_BIND_STATE="repair-failed"
  if [ "$repair_probe_result" -eq 1 ]; then
    GATEWAY_BIND_REASON="host-container-values-still-differ-after-recreation"
  fi
  echo "ERROR: gateway bind mount verification failed after targeted recreation: $GATEWAY_BIND_REASON" >&2
  return 2
}
