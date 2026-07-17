#!/usr/bin/env sh
set -eu

repo_root="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
. "$repo_root/scripts/lib/static-release.sh"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Static release nginx test: SKIP docker unavailable"
  exit 0
fi

tmp_root="$(mktemp -d)"
container_name="static-release-nginx-$$"
cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  rm -rf "$tmp_root"
}
trap cleanup EXIT HUP INT TERM

static_root="$tmp_root/web"
staging="$static_root/.staging-restricted"
mkdir -p "$static_root/assets" "$staging/assets"
printf '<div>old</div>\n' > "$static_root/index.html"
printf 'old\n' > "$static_root/assets/app.js"
printf '<script src="/assets/app.js"></script>\n' > "$staging/index.html"
printf 'new\n' > "$staging/assets/app.js"
chmod 700 "$static_root" "$static_root/assets" "$staging" "$staging/assets"
chmod 600 "$static_root/index.html" "$static_root/assets/app.js" "$staging/index.html" "$staging/assets/app.js"

(
  umask 077
  static_release_activate "$staging" "$static_root" "restricted" >/dev/null
)

nginx_conf="$tmp_root/default.conf"
printf '%s\n' \
  'server {' \
  '  listen 80;' \
  '  server_name _;' \
  '  root /usr/share/nginx/html/current;' \
  '  index index.html;' \
  '  location ^~ /assets/ { try_files $uri =404; }' \
  '  location / { try_files $uri /index.html; }' \
  '}' > "$nginx_conf"
chmod 644 "$nginx_conf"

docker run --rm -d \
  --name "$container_name" \
  -p 127.0.0.1::80 \
  -v "$static_root:/usr/share/nginx/html:ro" \
  -v "$nginx_conf:/etc/nginx/conf.d/default.conf:ro" \
  nginx:1.27-alpine >/dev/null

port="$(docker port "$container_name" 80/tcp | awk -F: 'NR == 1 {print $NF}')"
[ -n "$port" ] || { echo "ERROR: nginx test port unavailable" >&2; exit 1; }

attempt=1
while [ "$attempt" -le 20 ]; do
  if curl -fsS "http://127.0.0.1:$port/" > "$tmp_root/root.html" 2>/dev/null; then
    break
  fi
  sleep 1
  attempt=$((attempt + 1))
done

grep -F '/assets/app.js' "$tmp_root/root.html" >/dev/null
test "$(curl -fsS "http://127.0.0.1:$port/assets/app.js")" = "new"

echo "Static release nginx test: PASS"
