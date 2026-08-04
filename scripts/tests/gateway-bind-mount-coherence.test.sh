#!/usr/bin/env sh
set -eu

repo_root="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
tmp_root="$(mktemp -d)"
trap 'rm -rf "$tmp_root"' EXIT HUP INT TERM

host_static="$tmp_root/host-static"
host_nginx="$tmp_root/host-nginx"
container_static="$tmp_root/container-static"
container_nginx="$tmp_root/container-nginx"
fake_bin="$tmp_root/bin"
mkdir -p "$host_static/.releases/new/assets" "$host_nginx/branches" \
  "$container_static/.releases/new/assets" "$container_nginx/branches" "$fake_bin"
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
PATH="$fake_bin:$PATH"
export PATH

# shellcheck source=scripts/lib/gateway-bind-mount.sh
. "$repo_root/scripts/lib/gateway-bind-mount.sh"

gateway_bind_mounts_are_coherent fake-gateway "$host_static" "$host_nginx"

mkdir -p "$container_static/.releases/old/assets"
printf '<script src="/assets/old.js"></script>\n' > "$container_static/.releases/old/index.html"
printf 'old\n' > "$container_static/.releases/old/assets/old.js"
rm "$container_static/current"
ln -s .releases/old "$container_static/current"
if gateway_bind_mounts_are_coherent fake-gateway "$host_static" "$host_nginx"; then
  echo "expected stale static bind mount to be rejected" >&2
  exit 1
fi

rm "$container_static/current"
ln -s .releases/new "$container_static/current"
printf 'root /usr/share/nginx/html;\n' > "$container_nginx/branches/_standalone.conf"
if gateway_bind_mounts_are_coherent fake-gateway "$host_static" "$host_nginx"; then
  echo "expected stale nginx bind mount to be rejected" >&2
  exit 1
fi

echo "Gateway bind mount coherence test: PASS"
