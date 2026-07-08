#!/usr/bin/env sh
set -eu

# Production helper for the LLM Gateway cutover: create a Volcengine Seedance
# video ModelExchange, then optionally move video-gen pools to that exchange.
# Dry-run is the default; execute mode takes a Mongo backup first.

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
compose_file="${LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_COMPOSE_FILE:-$repo_root/docker-compose.yml}"
mongo_service="${LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_MONGO_SERVICE:-mongodb}"
mongo_db="${LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_DB:-prdagent}"
dry_run="${LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_DRY_RUN:-1}"
backup_root="${LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_BACKUP_ROOT:-/root/backups}"
backup_stamp="$(date '+%Y%m%dT%H%M%S%z' 2>/dev/null || date '+%Y%m%dT%H%M%S')"
backup_dir="${LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_BACKUP_DIR:-$backup_root/llmgw-prod-before-video-exchange-bootstrap-$backup_stamp}"

if [ ! -f "$compose_file" ]; then
  echo "ERROR: 找不到 compose 文件: $compose_file" >&2
  exit 1
fi

if [ ! -f "$script_dir/llmgw-prod-video-exchange-bootstrap.js" ]; then
  echo "ERROR: 找不到 video exchange bootstrap JS: $script_dir/llmgw-prod-video-exchange-bootstrap.js" >&2
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

echo "LLM Gateway video exchange bootstrap"
echo "  compose: $compose_file"
echo "  mongoService: $mongo_service"
echo "  database: $mongo_db"
echo "  dryRun: $dry_run"
echo "  exchangeId: ${LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_EXCHANGE_ID:-volcengine-seedance-video}"
echo "  poolId: ${LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_POOL_ID:-video_seedance_2_0_fast_pool}"
echo "  resetHealth: ${LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_RESET_HEALTH:-0}"
echo "  bindCallers: ${LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_BIND_CALLERS:-1}"
echo "  backupDir: $backup_dir"

if [ "$dry_run" = "1" ] || [ "$dry_run" = "true" ]; then
  echo "LLM Gateway video exchange bootstrap dry-run: backup skipped"
else
  "$script_dir/llmgw-disk-space-guard.sh" "$backup_dir" "${LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_MIN_FREE_MB:-6144}" "LLM Gateway video exchange bootstrap backup"
  mkdir -p "$backup_dir"
  echo "LLM Gateway video exchange bootstrap: writing Mongo backup"
  # shellcheck disable=SC2086
  $COMPOSE -f "$compose_file" exec -T "$mongo_service" \
    mongodump --db "$mongo_db" --archive \
    | gzip > "$backup_dir/mongo-$mongo_db-video-exchange-bootstrap.archive.gz"
fi

# shellcheck disable=SC2086
$COMPOSE -f "$compose_file" exec -T \
  -e LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_DRY_RUN="$dry_run" \
  -e LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_EXCHANGE_ID="${LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_EXCHANGE_ID:-volcengine-seedance-video}" \
  -e LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_EXCHANGE_NAME="${LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_EXCHANGE_NAME:-火山方舟 Seedance 视频生成}" \
  -e LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_POOL_ID="${LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_POOL_ID:-video_seedance_2_0_fast_pool}" \
  -e LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_POOL_NAME="${LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_POOL_NAME:-视频 Seedance 2.0 Fast}" \
  -e LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_POOL_CODE="${LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_POOL_CODE:-video-seedance-2-fast}" \
  -e LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_MODEL_ID="${LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_MODEL_ID:-doubao-seedance-2-0-fast-260128}" \
  -e LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_MODEL_DISPLAY_NAME="${LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_MODEL_DISPLAY_NAME:-Doubao Seedance 2.0 Fast}" \
  -e LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_TARGET_URL="${LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_TARGET_URL:-https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks}" \
  -e LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_SOURCE_PLATFORM_ID="${LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_SOURCE_PLATFORM_ID:-}" \
  -e LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_RESET_HEALTH="${LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_RESET_HEALTH:-0}" \
  -e LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_BIND_CALLERS="${LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_BIND_CALLERS:-1}" \
  -e LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_TARGET_CALLERS="${LLMGW_VIDEO_EXCHANGE_BOOTSTRAP_TARGET_CALLERS:-video-agent.videogen::video-gen,visual-agent.videogen::video-gen}" \
  "$mongo_service" mongosh "$mongo_db" --quiet < "$script_dir/llmgw-prod-video-exchange-bootstrap.js"

if [ "$dry_run" = "1" ] || [ "$dry_run" = "true" ]; then
  echo "LLM Gateway video exchange bootstrap dry-run completed"
else
  echo "LLM Gateway video exchange bootstrap completed with backup: $backup_dir"
fi
