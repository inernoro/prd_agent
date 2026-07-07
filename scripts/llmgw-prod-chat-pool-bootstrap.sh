#!/usr/bin/env sh
set -eu

# Production helper for the LLM Gateway cutover: make a verified chat model the
# first healthy candidate in the configured chat pool. Dry-run is the default;
# execute mode takes a Mongo backup first.

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
compose_file="${LLMGW_CHAT_BOOTSTRAP_COMPOSE_FILE:-$repo_root/docker-compose.yml}"
mongo_service="${LLMGW_CHAT_BOOTSTRAP_MONGO_SERVICE:-mongodb}"
mongo_db="${LLMGW_CHAT_BOOTSTRAP_DB:-prdagent}"
dry_run="${LLMGW_CHAT_BOOTSTRAP_DRY_RUN:-1}"
backup_root="${LLMGW_CHAT_BOOTSTRAP_BACKUP_ROOT:-/root/backups}"
backup_stamp="$(date '+%Y%m%dT%H%M%S%z' 2>/dev/null || date '+%Y%m%dT%H%M%S')"
backup_dir="${LLMGW_CHAT_BOOTSTRAP_BACKUP_DIR:-$backup_root/llmgw-prod-before-chat-pool-bootstrap-$backup_stamp}"

if [ ! -f "$compose_file" ]; then
  echo "ERROR: 找不到 compose 文件: $compose_file" >&2
  exit 1
fi

if [ ! -f "$script_dir/llmgw-prod-chat-pool-bootstrap.js" ]; then
  echo "ERROR: 找不到 chat pool bootstrap JS: $script_dir/llmgw-prod-chat-pool-bootstrap.js" >&2
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

echo "LLM Gateway chat pool bootstrap"
echo "  compose: $compose_file"
echo "  mongoService: $mongo_service"
echo "  database: $mongo_db"
echo "  dryRun: $dry_run"
echo "  modelName: ${LLMGW_CHAT_BOOTSTRAP_MODEL_NAME:-deepseek-ai/DeepSeek-V4-Flash}"
echo "  platformId: ${LLMGW_CHAT_BOOTSTRAP_PLATFORM_ID:-auto}"
echo "  targetCallers: ${LLMGW_CHAT_BOOTSTRAP_TARGET_CALLERS:-report-agent.generate::chat}"
echo "  backupDir: $backup_dir"

if [ "$dry_run" = "1" ] || [ "$dry_run" = "true" ]; then
  echo "LLM Gateway chat pool bootstrap dry-run: backup skipped"
else
  "$script_dir/llmgw-disk-space-guard.sh" "$backup_dir" "${LLMGW_CHAT_BOOTSTRAP_MIN_FREE_MB:-6144}" "LLM Gateway chat pool bootstrap backup"
  mkdir -p "$backup_dir"
  echo "LLM Gateway chat pool bootstrap: writing Mongo backup"
  # shellcheck disable=SC2086
  $COMPOSE -f "$compose_file" exec -T "$mongo_service" \
    mongodump --db "$mongo_db" --archive \
    | gzip > "$backup_dir/mongo-$mongo_db-chat-pool-bootstrap.archive.gz"
fi

# shellcheck disable=SC2086
$COMPOSE -f "$compose_file" exec -T \
  -e LLMGW_CHAT_BOOTSTRAP_DRY_RUN="$dry_run" \
  -e LLMGW_CHAT_BOOTSTRAP_MODEL_NAME="${LLMGW_CHAT_BOOTSTRAP_MODEL_NAME:-deepseek-ai/DeepSeek-V4-Flash}" \
  -e LLMGW_CHAT_BOOTSTRAP_PLATFORM_ID="${LLMGW_CHAT_BOOTSTRAP_PLATFORM_ID:-}" \
  -e LLMGW_CHAT_BOOTSTRAP_POOL_ID="${LLMGW_CHAT_BOOTSTRAP_POOL_ID:-}" \
  -e LLMGW_CHAT_BOOTSTRAP_TARGET_CALLERS="${LLMGW_CHAT_BOOTSTRAP_TARGET_CALLERS:-report-agent.generate::chat}" \
  -e LLMGW_CHAT_BOOTSTRAP_BIND_CALLERS="${LLMGW_CHAT_BOOTSTRAP_BIND_CALLERS:-1}" \
  -e LLMGW_CHAT_BOOTSTRAP_PRIORITY="${LLMGW_CHAT_BOOTSTRAP_PRIORITY:-1}" \
  "$mongo_service" mongosh "$mongo_db" --quiet < "$script_dir/llmgw-prod-chat-pool-bootstrap.js"

if [ "$dry_run" = "1" ] || [ "$dry_run" = "true" ]; then
  echo "LLM Gateway chat pool bootstrap dry-run completed"
else
  echo "LLM Gateway chat pool bootstrap completed with backup: $backup_dir"
fi
