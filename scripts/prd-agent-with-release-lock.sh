#!/bin/sh
set -eu
# Reuse a parent's lock for fast.sh -> exec_dep.sh and CDS's whole release command.
if [ "${PRD_AGENT_PRODUCTION_LOCK_HELD:-0}" = 1 ]; then
  exec "$@"
fi
exec flock -w 1800 /run/lock/prd-agent-production.lock env PRD_AGENT_PRODUCTION_LOCK_HELD=1 "$@"
