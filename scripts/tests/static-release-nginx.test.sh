#!/usr/bin/env sh
set -eu

repo_root="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
. "$repo_root/scripts/lib/static-release.sh"

runtime=docker
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  if command -v nginx >/dev/null 2>&1; then
    runtime=native
  else
    echo "Static release nginx test: SKIP docker and native nginx unavailable"
    exit 0
  fi
fi

tmp_root="$(mktemp -d)"
container_name="static-release-nginx-$$"
cleanup() {
  if [ "$runtime" = docker ]; then
    docker rm -f "$container_name" >/dev/null 2>&1 || true
  elif [ -f "$tmp_root/nginx.pid" ]; then
    nginx -p "$tmp_root/" -c "$tmp_root/nginx.conf" -s quit >/dev/null 2>&1 || true
  fi
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
python3 - "$repo_root/deploy/nginx/conf.d/branches/_standalone.conf" "$nginx_conf" <<'PYCONF'
import re
import sys
from pathlib import Path
source = Path(sys.argv[1]).read_text().split('## 独立 LLM 网关前端站点')[0]
source = re.sub(r'\b(?:api|llmgw|llmgw-serve|llmgw-serve-b):[0-9]+', '127.0.0.1:9', source)
Path(sys.argv[2]).write_text(source)
PYCONF
chmod 644 "$nginx_conf"

if [ "$runtime" = docker ]; then
  docker run --rm -d \
    --name "$container_name" \
    -p 127.0.0.1::80 \
    -v "$static_root:/usr/share/nginx/html:ro" \
    -v "$nginx_conf:/etc/nginx/conf.d/default.conf:ro" \
    nginx:1.27-alpine >/dev/null
  port="$(docker port "$container_name" 80/tcp | awk -F: 'NR == 1 {print $NF}')"
else
  # A root-started native nginx drops worker privileges; mktemp defaults to 700.
  chmod 755 "$tmp_root"
  port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
  {
    printf 'pid %s/nginx.pid;\nerror_log %s/error.log;\nevents {}\nhttp { access_log off; types { text/html html; application/javascript js; text/css css; }\n' "$tmp_root" "$tmp_root"
    sed -e "s/listen 80;/listen 127.0.0.1:$port;/" -e "s|/usr/share/nginx/html|$static_root|" "$nginx_conf"
    printf '}\n'
  } > "$tmp_root/nginx.conf"
  nginx -p "$tmp_root/" -c "$tmp_root/nginx.conf"
fi
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

# A/B differ only in content, not length or archive mtime. Confirm the fixture
# would collide in nginx before exercising the release metadata refresh.
for version in A B; do
  mkdir -p "$static_root/.staging-cache-$version/assets"
  printf '<!doctype html><html><head><link rel="stylesheet" href="/assets/%s.css"></head><body><div id="root"></div><script type="module" src="/assets/%s.js"></script></body></html>\n' "$version" "$version" > "$static_root/.staging-cache-$version/index.html"
  printf 'document.querySelector("#root").textContent="%s"; window.loadChunk=()=>import("./%s-chunk.js").then(m=>new Promise((resolve,reject)=>{const link=document.createElement("link");link.rel="stylesheet";link.href=new URL("./%s-lazy.css",import.meta.url).href;link.onload=()=>{document.querySelector("#root").textContent=m.value;resolve();};link.onerror=reject;document.head.append(link);}));\n' "$version" "$version" "$version" > "$static_root/.staging-cache-$version/assets/$version.js"
  printf 'export const value="%s chunk";\n' "$version" > "$static_root/.staging-cache-$version/assets/$version-chunk.js"
  if [ "$version" = A ]; then initial_color='10,11,12'; lazy_color='110,111,112'; else initial_color='20,21,22'; lazy_color='120,121,122'; fi
  printf '#root { color: rgb(%s); }\n' "$initial_color" > "$static_root/.staging-cache-$version/assets/$version.css"
  printf '#root { color: rgb(%s); }\n' "$lazy_color" > "$static_root/.staging-cache-$version/assets/$version-lazy.css"
done
python3 - "$static_root" <<'PYFIXTURE'
import os
import sys
from pathlib import Path
root = Path(sys.argv[1])
entries = [root / f'.staging-cache-{version}/index.html' for version in ['A', 'B']]
for entry in entries:
    os.utime(entry, (946656000, 946656000))
assert entries[0].stat().st_size == entries[1].stat().st_size
assert entries[0].stat().st_mtime == entries[1].stat().st_mtime
assert entries[0].read_bytes() != entries[1].read_bytes()
PYFIXTURE

entry_headers() {
  curl -fsS -D "$1" -o "$2" "http://127.0.0.1:$port/"
}
header_value() {
  awk -v field="$2" 'tolower($1) == tolower(field ":") { $1=""; sub(/^ /, ""); sub(/\r$/, ""); print; exit }' "$1"
}
expect_changed() {
  cached_headers="$1"
  expected_version="$2"
  # Check both validators individually, then together as browsers send them.
  for validator in etag modified both; do
    set --
    if [ "$validator" != modified ]; then
      set -- "$@" -H "If-None-Match: $(header_value "$cached_headers" ETag)"
    fi
    if [ "$validator" != etag ]; then
      set -- "$@" -H "If-Modified-Since: $(header_value "$cached_headers" Last-Modified)"
    fi
    status="$(curl -sS -o "$tmp_root/conditional.html" -w '%{http_code}' "$@" "http://127.0.0.1:$port/")"
    test "$status" = 200
    grep -F "/assets/$expected_version.js" "$tmp_root/conditional.html" >/dev/null
  done
}

static_release_activate "$static_root/.staging-cache-A" "$static_root" cache-A >/dev/null
entry_headers "$tmp_root/A.headers" "$tmp_root/A.html"
test "$(header_value "$tmp_root/A.headers" Cache-Control)" = "no-cache, must-revalidate"
test -n "$(header_value "$tmp_root/A.headers" ETag)"
test -n "$(header_value "$tmp_root/A.headers" Last-Modified)"
# A validator against unchanged A must really yield 304, not a cache bypass.
test "$(curl -sS -o /dev/null -w '%{http_code}' -H "If-None-Match: $(header_value "$tmp_root/A.headers" ETag)" "http://127.0.0.1:$port/")" = 304
test "$(curl -sS -o /dev/null -w '%{http_code}' -H "If-Modified-Since: $(header_value "$tmp_root/A.headers" Last-Modified)" "http://127.0.0.1:$port/")" = 304
static_release_activate "$static_root/.staging-cache-B" "$static_root" cache-B >/dev/null
entry_headers "$tmp_root/B.headers" "$tmp_root/B.html"
expect_changed "$tmp_root/A.headers" B
# Both original entry URLs and lazy chunks must survive the switch.
for version in A B; do
  curl -fsS "http://127.0.0.1:$port/assets/$version.js" > /dev/null
  curl -fsS "http://127.0.0.1:$port/assets/$version-chunk.js" > /dev/null
  curl -fsS "http://127.0.0.1:$port/assets/$version.css" > /dev/null
  curl -fsS "http://127.0.0.1:$port/assets/$version-lazy.css" > /dev/null
done
static_release_rollback "$static_root" .releases/cache-A
for version in A B; do
  curl -fsS "http://127.0.0.1:$port/assets/$version.js" > /dev/null
  curl -fsS "http://127.0.0.1:$port/assets/$version-chunk.js" > /dev/null
  curl -fsS "http://127.0.0.1:$port/assets/$version.css" > /dev/null
  curl -fsS "http://127.0.0.1:$port/assets/$version-lazy.css" > /dev/null
done
entry_headers "$tmp_root/rollback.headers" "$tmp_root/rollback.html"
expect_changed "$tmp_root/B.headers" A
expect_changed "$tmp_root/A.headers" A
python3 - "$static_root" "$tmp_root" <<'PYVERIFY'
import sys
from pathlib import Path
root, tmp = map(Path, sys.argv[1:])
for version in ['A', 'B']:
    deployed = root / f'.releases/cache-{version}/index.html'
    assert deployed.read_bytes() == (tmp / f'{version}.html').read_bytes()
    assert deployed.stat().st_mode & 0o777 == 0o644
assert (root / 'current/index.html').read_bytes() == (tmp / 'A.html').read_bytes()
PYVERIFY

test "$(curl -sS -D "$tmp_root/missing.headers" -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/assets/does-not-exist.js")" = 404
test "$(header_value "$tmp_root/missing.headers" Cache-Control)" = no-store

if [ "${STATIC_RELEASE_BROWSER_TEST:-0}" = 1 ]; then
  node "$repo_root/scripts/tests/static-release-browser.mjs" "$repo_root" "$static_root" "http://127.0.0.1:$port"
fi

echo "Static release nginx test: PASS ($runtime)"
