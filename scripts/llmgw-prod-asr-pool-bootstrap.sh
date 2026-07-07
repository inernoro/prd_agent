#!/usr/bin/env sh
set -eu

# Production helper for the LLM Gateway cutover: create the ASR model pool and
# bind all ASR app callers after taking a Mongo backup. Dry-run is the default.

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
compose_file="${LLMGW_ASR_BOOTSTRAP_COMPOSE_FILE:-$repo_root/docker-compose.yml}"
mongo_service="${LLMGW_ASR_BOOTSTRAP_MONGO_SERVICE:-mongodb}"
mongo_db="${LLMGW_ASR_BOOTSTRAP_DB:-prdagent}"
dry_run="${LLMGW_ASR_BOOTSTRAP_DRY_RUN:-1}"
backup_root="${LLMGW_ASR_BOOTSTRAP_BACKUP_ROOT:-/root/backups}"
backup_stamp="$(date '+%Y%m%dT%H%M%S%z' 2>/dev/null || date '+%Y%m%dT%H%M%S')"
backup_dir="${LLMGW_ASR_BOOTSTRAP_BACKUP_DIR:-$backup_root/llmgw-prod-before-asr-pool-bootstrap-$backup_stamp}"

if [ ! -f "$compose_file" ]; then
  echo "ERROR: 找不到 compose 文件: $compose_file" >&2
  exit 1
fi

if [ ! -f "$script_dir/llmgw-prod-asr-pool-bootstrap.js" ]; then
  echo "ERROR: 找不到 ASR bootstrap JS: $script_dir/llmgw-prod-asr-pool-bootstrap.js" >&2
  exit 1
fi

if command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
elif command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
else
  echo "ERROR: 未找到 docker-compose 或 docker compose" >&2
  exit 1
fi

echo "LLM Gateway ASR pool bootstrap"
echo "  compose: $compose_file"
echo "  mongoService: $mongo_service"
echo "  database: $mongo_db"
echo "  dryRun: $dry_run"
echo "  backupDir: $backup_dir"

if [ "$dry_run" = "1" ] || [ "$dry_run" = "true" ]; then
  echo "LLM Gateway ASR pool bootstrap dry-run: backup skipped"
else
  mkdir -p "$backup_dir"
  echo "LLM Gateway ASR pool bootstrap: writing Mongo backup"
  # shellcheck disable=SC2086
  $COMPOSE -f "$compose_file" exec -T "$mongo_service" \
    mongodump --db "$mongo_db" --archive \
    | gzip > "$backup_dir/mongo-$mongo_db-asr-pool-bootstrap.archive.gz"
fi

# shellcheck disable=SC2086
$COMPOSE -f "$compose_file" exec -T \
  -e LLMGW_ASR_BOOTSTRAP_DRY_RUN="$dry_run" \
  -e LLMGW_ASR_BOOTSTRAP_POOL_ID="${LLMGW_ASR_BOOTSTRAP_POOL_ID:-asr_doubao_bigmodel_pool}" \
  -e LLMGW_ASR_BOOTSTRAP_POOL_NAME="${LLMGW_ASR_BOOTSTRAP_POOL_NAME:-ASR 豆包 BigModel}" \
  -e LLMGW_ASR_BOOTSTRAP_POOL_CODE="${LLMGW_ASR_BOOTSTRAP_POOL_CODE:-asr-doubao-bigmodel}" \
  -e LLMGW_ASR_BOOTSTRAP_MODEL_ID="${LLMGW_ASR_BOOTSTRAP_MODEL_ID:-doubao-asr-bigmodel}" \
  -e LLMGW_ASR_BOOTSTRAP_TRANSFORMER="${LLMGW_ASR_BOOTSTRAP_TRANSFORMER:-doubao-asr}" \
  "$mongo_service" mongosh "$mongo_db" --quiet < "$script_dir/llmgw-prod-asr-pool-bootstrap.js"

if [ "$dry_run" = "1" ] || [ "$dry_run" = "true" ]; then
  echo "LLM Gateway ASR pool bootstrap dry-run completed"
else
  echo "LLM Gateway ASR pool bootstrap completed with backup: $backup_dir"
fi
