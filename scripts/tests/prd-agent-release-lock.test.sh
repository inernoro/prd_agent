#!/bin/sh
set -eu
# Test the real wrapper's argv handling and inherited-lock branch without /run writes.
wrapper="$(dirname "$0")/../prd-agent-with-release-lock.sh"
actual="$(PRD_AGENT_PRODUCTION_LOCK_HELD=1 sh "$wrapper" printf '%s' 'a b;$literal')"
[ "$actual" = 'a b;$literal' ]
if command -v flock >/dev/null 2>&1; then
  # An isolated lock proves the cleanup/deployment exclusion primitive.
  path="$(mktemp)"
  trap 'rm -f "$path"' EXIT
  ( flock -x 9; if flock -n "$path" true; then exit 1; fi ) 9>"$path"
fi
printf '%s\n' 'production release lock: PASS'
