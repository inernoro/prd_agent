#!/usr/bin/env sh
set -eu

repo_root="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
validator="$repo_root/scripts/validate-static-dist.sh"
tmp_root="$(mktemp -d)"
cleanup() { rm -rf "$tmp_root"; }
trap cleanup EXIT HUP INT TERM

file_mode() {
  if stat -c '%a' "$1" >/dev/null 2>&1; then
    stat -c '%a' "$1"
  else
    stat -f '%Lp' "$1"
  fi
}

good="$tmp_root/good"
umask 077
mkdir -p "$good/assets"
printf '%s\n' '<!doctype html><script type="module" src="/assets/app.js"></script><link rel="stylesheet" href="/assets/app.css">' > "$good/index.html"
printf '%s\n' 'console.log("ok")' > "$good/assets/app.js"
printf '%s\n' 'body { color: black; }' > "$good/assets/app.css"

"$validator" --normalize "$good"
[ "$(file_mode "$good")" = "755" ]
[ "$(file_mode "$good/assets")" = "755" ]
[ "$(file_mode "$good/index.html")" = "644" ]
[ "$(file_mode "$good/assets/app.js")" = "644" ]

ln -s "$good" "$tmp_root/good-link"
chmod 700 "$good/assets"
"$validator" --normalize "$tmp_root/good-link"
[ "$(file_mode "$good/assets")" = "755" ]

missing_index="$tmp_root/missing-index"
mkdir -p "$missing_index/assets"
printf '%s\n' 'console.log("orphan")' > "$missing_index/assets/app.js"
if "$validator" --normalize "$missing_index" >"$tmp_root/missing-index.log" 2>&1; then
  echo "expected missing index validation to fail" >&2
  exit 1
fi
grep -F "index.html is missing or empty" "$tmp_root/missing-index.log" >/dev/null

missing_asset="$tmp_root/missing-asset"
mkdir -p "$missing_asset"
printf '%s\n' '<!doctype html><script type="module" src="/assets/missing.js"></script>' > "$missing_asset/index.html"
if "$validator" --normalize "$missing_asset" >"$tmp_root/missing-asset.log" 2>&1; then
  echo "expected missing entry asset validation to fail" >&2
  exit 1
fi
grep -F "referenced entry asset is missing or empty" "$tmp_root/missing-asset.log" >/dev/null

echo "validate-static-dist tests: PASS"
