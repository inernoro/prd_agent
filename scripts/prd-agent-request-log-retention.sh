#!/bin/sh
set -eu
# Separate DB cleanup lock; does not hold up deployments or artifact reclamation.
exec 9>/run/lock/prd-agent-request-log-retention.lock
flock -n 9 || exit 0
script=${PRD_LOG_RETENTION_SCRIPT:-/usr/local/lib/prd-agent/request-log-retention.js}
[ -s "$script" ]
docker exec -i \
  -e PRD_LOG_RETENTION_DAYS="${PRD_LOG_RETENTION_DAYS:-30}" \
  -e PRD_LOG_RETENTION_EXECUTE="${PRD_LOG_RETENTION_EXECUTE:-0}" \
  -e PRD_LOG_RETENTION_MAX_BATCHES="${PRD_LOG_RETENTION_MAX_BATCHES:-100}" \
  -e PRD_LOG_RETENTION_MAX_SECONDS="${PRD_LOG_RETENTION_MAX_SECONDS:-120}" \
  prdagent-mongodb mongosh --quiet --file /dev/stdin < "$script"
