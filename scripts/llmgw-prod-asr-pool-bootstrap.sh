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
bootstrap_mode="$(printf '%s' "${LLMGW_ASR_BOOTSTRAP_MODE:-bigmodel}" | tr 'A-Z' 'a-z' | xargs || true)"
backup_root="${LLMGW_ASR_BOOTSTRAP_BACKUP_ROOT:-/root/backups}"
backup_stamp="$(date '+%Y%m%dT%H%M%S%z' 2>/dev/null || date '+%Y%m%dT%H%M%S')"
backup_dir="${LLMGW_ASR_BOOTSTRAP_BACKUP_DIR:-$backup_root/llmgw-prod-before-asr-pool-bootstrap-$backup_stamp}"

case "$bootstrap_mode" in
  bigmodel|"")
    default_pool_id="asr_doubao_bigmodel_pool"
    default_pool_name="ASR 豆包 BigModel"
    default_pool_code="asr-doubao-bigmodel"
    default_model_id="doubao-asr-bigmodel"
    default_transformer="doubao-asr"
    default_description="LLM Gateway ASR 发布门默认池：豆包 BigModel 异步 ASR exchange"
    ;;
  stream)
    default_pool_id="asr_doubao_stream_pool"
    default_pool_name="ASR 豆包 Stream"
    default_pool_code="asr-doubao-stream"
    default_model_id="doubao-asr-stream"
    default_transformer="doubao-asr-stream"
    default_description="LLM Gateway ASR 发布门候选池：豆包 WebSocket Stream ASR exchange"
    ;;
  *)
    echo "ERROR: LLMGW_ASR_BOOTSTRAP_MODE=$bootstrap_mode 不合法；允许 bigmodel 或 stream。" >&2
    exit 1
    ;;
esac

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
echo "  mode: $bootstrap_mode"
echo "  bindCallers: ${LLMGW_ASR_BOOTSTRAP_BIND_CALLERS:-1}"
echo "  defaultForType: ${LLMGW_ASR_BOOTSTRAP_DEFAULT_FOR_TYPE:-auto}"
echo "  backupDir: $backup_dir"

if [ "$dry_run" = "1" ] || [ "$dry_run" = "true" ]; then
  echo "LLM Gateway ASR pool bootstrap dry-run: backup skipped"
else
  "$script_dir/llmgw-disk-space-guard.sh" "$backup_dir" "${LLMGW_ASR_BOOTSTRAP_MIN_FREE_MB:-6144}" "LLM Gateway ASR pool bootstrap backup"
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
  -e LLMGW_ASR_BOOTSTRAP_POOL_ID="${LLMGW_ASR_BOOTSTRAP_POOL_ID:-$default_pool_id}" \
  -e LLMGW_ASR_BOOTSTRAP_POOL_NAME="${LLMGW_ASR_BOOTSTRAP_POOL_NAME:-$default_pool_name}" \
  -e LLMGW_ASR_BOOTSTRAP_POOL_CODE="${LLMGW_ASR_BOOTSTRAP_POOL_CODE:-$default_pool_code}" \
  -e LLMGW_ASR_BOOTSTRAP_MODEL_ID="${LLMGW_ASR_BOOTSTRAP_MODEL_ID:-$default_model_id}" \
  -e LLMGW_ASR_BOOTSTRAP_TRANSFORMER="${LLMGW_ASR_BOOTSTRAP_TRANSFORMER:-$default_transformer}" \
  -e LLMGW_ASR_BOOTSTRAP_DESCRIPTION="${LLMGW_ASR_BOOTSTRAP_DESCRIPTION:-$default_description}" \
  -e LLMGW_ASR_BOOTSTRAP_BIND_CALLERS="${LLMGW_ASR_BOOTSTRAP_BIND_CALLERS:-1}" \
  -e LLMGW_ASR_BOOTSTRAP_DEFAULT_FOR_TYPE="${LLMGW_ASR_BOOTSTRAP_DEFAULT_FOR_TYPE:-}" \
  "$mongo_service" mongosh "$mongo_db" --quiet < "$script_dir/llmgw-prod-asr-pool-bootstrap.js"

if [ "$dry_run" = "1" ] || [ "$dry_run" = "true" ]; then
  echo "LLM Gateway ASR pool bootstrap dry-run completed"
else
  echo "LLM Gateway ASR pool bootstrap completed with backup: $backup_dir"
fi
