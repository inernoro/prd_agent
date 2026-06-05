#!/usr/bin/env bash
#
# perf-smoke.sh — CDS dashboard front-end performance smoke test.
#
# Catches the "feels slow" regressions that are invisible in unit tests:
#   1. Static JS/CSS served UNCOMPRESSED (should be gzip/br).
#   2. Content-hashed /assets served with `no-cache` (forces a revalidation
#      round-trip on every load, defeating immutable caching).
#   3. Main bundle transfer size over budget.
#   4. Homepage TTFB over budget.
#
# Usage:
#   cds/scripts/perf-smoke.sh [host]
#   CDS_HOST=cds.miduo.org cds/scripts/perf-smoke.sh
#
# Exit code is non-zero if any budget/assertion fails — safe to wire into CI
# or to run by hand after a deploy.
#
# Budgets are overridable via env:
#   PERF_JS_KB_MAX       max main-bundle transfer size in KB (default 90)
#   PERF_TTFB_MS_MAX     max homepage warm TTFB in ms       (default 600)

set -u

HOST="${1:-${CDS_HOST:-}}"
if [ -z "$HOST" ]; then
  echo "usage: perf-smoke.sh <host>   (or set CDS_HOST)" >&2
  exit 2
fi
case "$HOST" in http://*|https://*) ;; *) HOST="https://$HOST" ;; esac

JS_KB_MAX="${PERF_JS_KB_MAX:-90}"
TTFB_MS_MAX="${PERF_TTFB_MS_MAX:-600}"

pass=0
fail=0
ok()   { echo "  [PASS] $1"; pass=$((pass+1)); }
bad()  { echo "  [FAIL] $1"; fail=$((fail+1)); }
info() { echo "  [INFO] $1"; }

echo "CDS perf smoke -> $HOST"
echo "budgets: bundle <= ${JS_KB_MAX}KB, homepage TTFB <= ${TTFB_MS_MAX}ms"
echo

# --- warm the connection (first hit after a restart is cold) -------------
curl -s -o /dev/null "$HOST/" 2>/dev/null

# --- 1. homepage TTFB ----------------------------------------------------
echo "1) homepage TTFB"
ttfb_s=$(curl -s -o /dev/null -w '%{time_starttransfer}' "$HOST/")
ttfb_ms=$(awk "BEGIN{printf \"%d\", $ttfb_s*1000}")
if [ "$ttfb_ms" -le "$TTFB_MS_MAX" ]; then ok "TTFB ${ttfb_ms}ms"; else bad "TTFB ${ttfb_ms}ms > ${TTFB_MS_MAX}ms"; fi

# --- locate main bundle from index.html ----------------------------------
echo "2) discover main JS bundle"
asset=$(curl -s "$HOST/" | grep -oE '/assets/[^"]+\.js' | head -1)
if [ -z "$asset" ]; then bad "could not find /assets/*.js in index.html"; echo; echo "summary: $pass passed, $fail failed"; exit 1; fi
info "bundle: $asset"

# --- 3. compression ------------------------------------------------------
echo "3) compression (gzip/br)"
enc=$(curl -s -D - -o /dev/null -H 'Accept-Encoding: br, gzip' "$HOST$asset" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-encoding"{print $2}')
if [ -n "$enc" ]; then ok "Content-Encoding: $enc"; else bad "no Content-Encoding (served uncompressed)"; fi

# --- 4. transfer size budget --------------------------------------------
echo "4) bundle transfer size"
enc_bytes=$(curl -s -o /dev/null -H 'Accept-Encoding: br, gzip' -w '%{size_download}' "$HOST$asset")
enc_kb=$(( enc_bytes / 1024 ))
if [ "$enc_kb" -le "$JS_KB_MAX" ]; then ok "transfer ${enc_kb}KB"; else bad "transfer ${enc_kb}KB > ${JS_KB_MAX}KB"; fi

# --- 5. immutable caching (no no-cache on hashed assets) -----------------
echo "5) /assets caching"
cc=$(curl -s -D - -o /dev/null "$HOST$asset" | tr -d '\r' | awk -F': ' 'tolower($1)=="cache-control"{print $2}' | paste -sd ',' -)
info "Cache-Control: $cc"
case "$cc" in
  *immutable*) ok "immutable present" ;;
  *) bad "missing immutable on hashed asset" ;;
esac
case "$cc" in
  *no-cache*|*no-store*) bad "no-cache/no-store on hashed asset (forces revalidation every load)" ;;
  *) ok "no revalidation directive" ;;
esac

echo
echo "summary: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
