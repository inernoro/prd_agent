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
gateway_db="${LLMGW_CHAT_BOOTSTRAP_GW_DB:-llm_gateway}"
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
echo "  gatewayDatabase: $gateway_db"
echo "  dryRun: $dry_run"
echo "  modelName: ${LLMGW_CHAT_BOOTSTRAP_MODEL_NAME:-deepseek-ai/DeepSeek-V4-Flash}"
echo "  platformId: ${LLMGW_CHAT_BOOTSTRAP_PLATFORM_ID:-auto}"
echo "  poolCode: ${LLMGW_CHAT_BOOTSTRAP_POOL_CODE:-report-agent-weekly}"
echo "  poolName: ${LLMGW_CHAT_BOOTSTRAP_POOL_NAME:-周报生成专属池}"
echo "  isolatePool: ${LLMGW_CHAT_BOOTSTRAP_ISOLATE_POOL:-1}"
echo "  targetCallers: ${LLMGW_CHAT_BOOTSTRAP_TARGET_CALLERS:-report-agent.generate::chat}"
echo "  backupDir: $backup_dir"

if [ "$dry_run" = "1" ] || [ "$dry_run" = "true" ]; then
  echo "LLM Gateway chat pool bootstrap dry-run: backup skipped"
else
  "$script_dir/llmgw-disk-space-guard.sh" "$backup_dir" "${LLMGW_CHAT_BOOTSTRAP_MIN_FREE_MB:-6144}" "LLM Gateway chat pool bootstrap backup"
  mkdir -p "$backup_dir"
  echo "LLM Gateway chat pool bootstrap: writing affected-collection backups"
  backup_collection() {
    backup_database="$1"
    backup_collection_name="$2"
    backup_file="$backup_dir/mongo-$backup_database-$backup_collection_name.archive.gz"
    # 使用 mongodump 内建 gzip，避免管道末端成功掩盖 dump 失败。
    # shellcheck disable=SC2086
    $COMPOSE -f "$compose_file" exec -T "$mongo_service" \
      mongodump --db "$backup_database" --collection "$backup_collection_name" --archive --gzip \
      > "$backup_file"
    test -s "$backup_file"
  }
  backup_collection "$mongo_db" model_groups
  backup_collection "$mongo_db" llm_app_callers
  backup_collection "$gateway_db" llmgw_model_pools
  backup_collection "$gateway_db" llmgw_app_callers
  backup_collection "$gateway_db" llmgw_operation_audits
  sha256sum "$backup_dir"/*.archive.gz > "$backup_dir/SHA256SUMS"
fi

# shellcheck disable=SC2086
$COMPOSE -f "$compose_file" exec -T \
  -e LLMGW_CHAT_BOOTSTRAP_DRY_RUN="$dry_run" \
  -e LLMGW_CHAT_BOOTSTRAP_MODEL_NAME="${LLMGW_CHAT_BOOTSTRAP_MODEL_NAME:-deepseek-ai/DeepSeek-V4-Flash}" \
  -e LLMGW_CHAT_BOOTSTRAP_PLATFORM_ID="${LLMGW_CHAT_BOOTSTRAP_PLATFORM_ID:-}" \
  -e LLMGW_CHAT_BOOTSTRAP_POOL_ID="${LLMGW_CHAT_BOOTSTRAP_POOL_ID:-}" \
  -e LLMGW_CHAT_BOOTSTRAP_POOL_CODE="${LLMGW_CHAT_BOOTSTRAP_POOL_CODE:-report-agent-weekly}" \
  -e LLMGW_CHAT_BOOTSTRAP_POOL_NAME="${LLMGW_CHAT_BOOTSTRAP_POOL_NAME:-周报生成专属池}" \
  -e LLMGW_CHAT_BOOTSTRAP_ISOLATE_POOL="${LLMGW_CHAT_BOOTSTRAP_ISOLATE_POOL:-1}" \
  -e LLMGW_CHAT_BOOTSTRAP_TARGET_CALLERS="${LLMGW_CHAT_BOOTSTRAP_TARGET_CALLERS:-report-agent.generate::chat}" \
  -e LLMGW_CHAT_BOOTSTRAP_BIND_CALLERS="${LLMGW_CHAT_BOOTSTRAP_BIND_CALLERS:-1}" \
  -e LLMGW_CHAT_BOOTSTRAP_PRIORITY="${LLMGW_CHAT_BOOTSTRAP_PRIORITY:-1}" \
  -e LLMGW_CHAT_BOOTSTRAP_GW_DB="$gateway_db" \
  -e LLMGW_INTERNAL_TENANT_ID="${LLMGW_INTERNAL_TENANT_ID:-tenant_map_internal}" \
  "$mongo_service" mongosh "$mongo_db" --quiet --file /dev/stdin < "$script_dir/llmgw-prod-chat-pool-bootstrap.js"

if [ "$dry_run" = "1" ] || [ "$dry_run" = "true" ]; then
  echo "LLM Gateway chat pool bootstrap dry-run completed"
else
  echo "LLM Gateway chat pool bootstrap completed with backup: $backup_dir"
fi
