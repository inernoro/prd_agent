#!/usr/bin/env sh
set -eu

repo_root="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
tmp_root="$(mktemp -d)"
trap 'rm -rf "$tmp_root"' EXIT HUP INT TERM

project_root="$tmp_root/production-project"
host_static="$project_root/deploy/web/dist"
host_nginx="$project_root/deploy/nginx/conf.d"
container_static="$tmp_root/container-static"
container_nginx="$tmp_root/container-nginx"
release_root="$tmp_root/release-tree"
fake_bin="$tmp_root/bin"
compose_log="$tmp_root/compose.log"
reload_log="$tmp_root/reload.log"
mkdir -p "$host_static/.releases/new/assets" "$host_nginx/branches" \
  "$container_static/.releases/new/assets" "$container_nginx/branches" "$release_root" "$fake_bin"
printf 'services:\n  gateway:\n    image: nginx:alpine\n' > "$project_root/docker-compose.yml"
printf 'services:\n  gateway:\n    image: nginx:alpine\n' > "$release_root/docker-compose.yml"
printf '<script src="/assets/new.js"></script>\n' > "$host_static/.releases/new/index.html"
printf 'new\n' > "$host_static/.releases/new/assets/new.js"
printf 'root /usr/share/nginx/html/current;\n' > "$host_nginx/branches/_standalone.conf"
cp -R "$host_static/.releases/new/." "$container_static/.releases/new/"
cp "$host_nginx/branches/_standalone.conf" "$container_nginx/branches/_standalone.conf"
ln -s .releases/new "$host_static/current"
ln -s .releases/new "$container_static/current"

cat > "$fake_bin/docker" <<'SH'
#!/usr/bin/env sh
set -eu
[ "$1" = "exec" ]
shift 2
if [ "${FAKE_PROBE_FAILURE:-0}" = "1" ]; then
  exit 3
fi
case "$1:$2" in
  readlink:/usr/share/nginx/html/current)
    readlink "$FAKE_CONTAINER_STATIC/current"
    ;;
  sha256sum:/usr/share/nginx/html/current/index.html)
    sha256sum "$FAKE_CONTAINER_STATIC/current/index.html"
    ;;
  sha256sum:/etc/nginx/conf.d/branches/_standalone.conf)
    sha256sum "$FAKE_CONTAINER_NGINX/branches/_standalone.conf"
    ;;
  *)
    echo "unexpected fake docker command: $*" >&2
    exit 2
    ;;
esac
SH
chmod +x "$fake_bin/docker"

export FAKE_CONTAINER_STATIC="$container_static"
export FAKE_CONTAINER_NGINX="$container_nginx"
export FAKE_PROBE_FAILURE=0
export FAKE_REPAIR_MODE=success
export FAKE_RELOAD_FAILURE=0
export COMPOSE_FILE="$release_root/docker-compose.yml"
PATH="$fake_bin:$PATH"
export PATH

compose_run() {
  case "$1" in
    up)
      printf '%s\n' "$*" >> "$compose_log"
      if [ "$FAKE_REPAIR_MODE" = "command-fail" ]; then
        return 7
      fi
      if [ "$FAKE_REPAIR_MODE" = "success" ]; then
        rm -rf "$container_static" "$container_nginx"
        mkdir -p "$container_static/.releases/new" "$container_nginx/branches"
        cp -R "$host_static/.releases/new/." "$container_static/.releases/new/"
        cp "$host_nginx/branches/_standalone.conf" "$container_nginx/branches/_standalone.conf"
        ln -s .releases/new "$container_static/current"
        if [ "$FAKE_PROBE_FAILURE" = "after-recreate" ]; then
          export FAKE_PROBE_FAILURE=1
        fi
      fi
      ;;
    ps)
      printf 'fake-recreated-gateway\n'
      ;;
    *)
      echo "unexpected compose command: $*" >&2
      return 2
      ;;
  esac
}

reload_active_gateway() {
  printf 'reload\n' >> "$reload_log"
  if [ "$FAKE_RELOAD_FAILURE" = "1" ]; then
    return 9
  fi
}

make_container_stale() {
  mkdir -p "$container_static/.releases/old/assets"
  printf '<script src="/assets/old.js"></script>\n' > "$container_static/.releases/old/index.html"
  printf 'old\n' > "$container_static/.releases/old/assets/old.js"
  rm -f "$container_static/current"
  ln -s .releases/old "$container_static/current"
}

# shellcheck source=scripts/lib/gateway-bind-mount.sh
. "$repo_root/scripts/lib/gateway-bind-mount.sh"

# Coherent mounts never recreate, even without a Compose project directory.
gateway_reconcile_bind_mounts fake-gateway "$host_static" "$host_nginx" "" gateway
[ ! -s "$compose_log" ]
[ "$GATEWAY_BIND_STATE" = "coherent" ]

# A recreated container is recorded even if its reload subsequently fails.
make_container_stale
: > "$compose_log"
: > "$reload_log"
export FAKE_RELOAD_FAILURE=1
if gateway_reconcile_bind_mounts fake-gateway "$host_static" "$host_nginx" "$project_root" gateway; then
  echo "expected reload failure to stop the release" >&2
  exit 1
else
  [ "$?" -eq 2 ]
fi
[ "$GATEWAY_BIND_RECREATED" = "1" ]
[ "$GATEWAY_BIND_CONTAINER_AFTER" = "fake-recreated-gateway" ]
[ "$GATEWAY_BIND_REASON" = "recreated-gateway-reload-failed" ]
export FAKE_RELOAD_FAILURE=0
: > "$compose_log"
: > "$reload_log"

# A probe error fails closed and must never be converted into a recreation.
export FAKE_PROBE_FAILURE=1
if gateway_reconcile_bind_mounts fake-gateway "$host_static" "$host_nginx" "$project_root" gateway; then
  echo "expected probe error to stop the release" >&2
  exit 1
else
  [ "$?" -eq 2 ]
fi
[ "$GATEWAY_BIND_STATE" = "probe-error" ]
[ ! -s "$compose_log" ]
export FAKE_PROBE_FAILURE=0

# Confirmed drift without an explicit stable project directory fails without mutation.
make_container_stale
if gateway_reconcile_bind_mounts fake-gateway "$host_static" "$host_nginx" "" gateway; then
  echo "expected missing project directory to stop the release" >&2
  exit 1
else
  [ "$?" -eq 2 ]
fi
[ ! -s "$compose_log" ]

# A wrong or unrelated project directory is rejected before Compose can run.
unrelated_root="$tmp_root/unrelated"
mkdir -p "$unrelated_root"
printf 'services:\n  gateway:\n    image: nginx:alpine\n' > "$unrelated_root/docker-compose.yml"
if gateway_reconcile_bind_mounts fake-gateway "$host_static" "$host_nginx" "$unrelated_root" gateway; then
  echo "expected unrelated project directory to be rejected" >&2
  exit 1
else
  [ "$?" -eq 2 ]
fi
[ ! -s "$compose_log" ]

# A failed Compose recreation is reported as a repair failure and remains stopped.
export FAKE_REPAIR_MODE=command-fail
if gateway_reconcile_bind_mounts fake-gateway "$host_static" "$host_nginx" "$project_root" gateway; then
  echo "expected failed Compose recreation to stop the release" >&2
  exit 1
else
  [ "$?" -eq 2 ]
fi
[ "$GATEWAY_BIND_STATE" = "repair-failed" ]
[ "$GATEWAY_BIND_REASON" = "gateway-compose-recreation-failed" ]
: > "$compose_log"
export FAKE_REPAIR_MODE=success

# Confirmed drift with the owning project directory recreates only gateway and rechecks it.
gateway_reconcile_bind_mounts fake-gateway "$host_static" "$host_nginx" "$project_root" gateway
grep -Fx 'up -d --no-deps --force-recreate gateway' "$compose_log" >/dev/null
[ "$(wc -l < "$compose_log" | tr -d ' ')" = "1" ]
[ "$(cat "$reload_log")" = "reload" ]
[ "$GATEWAY_BIND_RECREATED" = "1" ]
[ "$GATEWAY_BIND_CONTAINER_BEFORE" = "fake-gateway" ]
[ "$GATEWAY_BIND_CONTAINER_AFTER" = "fake-recreated-gateway" ]
[ "$GATEWAY_BIND_STATE" = "coherent" ]

# If recreation does not repair the drift, the release remains failed.
make_container_stale
export FAKE_REPAIR_MODE=stale
if gateway_reconcile_bind_mounts fake-gateway "$host_static" "$host_nginx" "$project_root" gateway; then
  echo "expected unrepaired drift to stop the release" >&2
  exit 1
else
  [ "$?" -eq 2 ]
fi
[ "$GATEWAY_BIND_STATE" = "repair-failed" ]

# A second probe failure must not retain measurements from the initial probe.
make_container_stale
: > "$compose_log"
: > "$reload_log"
export FAKE_REPAIR_MODE=success
export FAKE_PROBE_FAILURE=after-recreate
if gateway_reconcile_bind_mounts fake-gateway "$host_static" "$host_nginx" "$project_root" gateway; then
  echo "expected second probe failure to stop the release" >&2
  exit 1
else
  [ "$?" -eq 2 ]
fi
[ "$GATEWAY_BIND_RECREATED" = "1" ]
[ "$GATEWAY_BIND_HOST_STATIC_TARGET" = ".releases/new" ]
[ -z "$GATEWAY_BIND_CONTAINER_STATIC_TARGET" ]
[ -z "$GATEWAY_BIND_HOST_STATIC_SHA" ]
[ -z "$GATEWAY_BIND_CONTAINER_STATIC_SHA" ]
[ -z "$GATEWAY_BIND_HOST_NGINX_SHA" ]
[ -z "$GATEWAY_BIND_CONTAINER_NGINX_SHA" ]

echo "Gateway bind mount decision test: PASS"
