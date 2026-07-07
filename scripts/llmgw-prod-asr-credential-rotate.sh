#!/usr/bin/env sh
set -eu

# Rotate the production Doubao ASR ModelExchange credential through the MAP API.
# Dry-run is the default. Execute mode writes a Mongo backup first and never
# prints the secret. The actual encryption is performed by ExchangeController.

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
compose_file="${LLMGW_ASR_CREDENTIAL_COMPOSE_FILE:-$repo_root/docker-compose.yml}"
mongo_service="${LLMGW_ASR_CREDENTIAL_MONGO_SERVICE:-mongodb}"
api_service="${LLMGW_ASR_CREDENTIAL_API_SERVICE:-api}"
mongo_db="${LLMGW_ASR_CREDENTIAL_DB:-prdagent}"
dry_run="${LLMGW_ASR_CREDENTIAL_ROTATE_DRY_RUN:-1}"
api_base="${LLMGW_ASR_CREDENTIAL_API_BASE:-http://127.0.0.1:5500}"
backup_root="${LLMGW_ASR_CREDENTIAL_BACKUP_ROOT:-/root/backups}"
backup_stamp="$(date '+%Y%m%dT%H%M%S%z' 2>/dev/null || date '+%Y%m%dT%H%M%S')"
backup_dir="${LLMGW_ASR_CREDENTIAL_BACKUP_DIR:-$backup_root/llmgw-prod-before-asr-credential-rotate-$backup_stamp}"

if [ ! -f "$compose_file" ]; then
  echo "ERROR: compose file not found: $compose_file" >&2
  exit 1
fi

if [ ! -f "$script_dir/llmgw-prod-asr-credential-rotate.py" ]; then
  echo "ERROR: rotate helper not found: $script_dir/llmgw-prod-asr-credential-rotate.py" >&2
  exit 1
fi

if [ -z "${LLMGW_ASR_NEW_KEY:-}" ]; then
  echo "ERROR: LLMGW_ASR_NEW_KEY is required and must be provided through environment." >&2
  exit 1
fi

if command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
elif command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
else
  echo "ERROR: docker compose is required" >&2
  exit 1
fi

root_username="${ROOT_ACCESS_USERNAME:-}"
root_password="${ROOT_ACCESS_PASSWORD:-}"
if [ -z "$root_username" ]; then
  root_username="$($COMPOSE -f "$compose_file" exec -T "$api_service" sh -lc 'printenv ROOT_ACCESS_USERNAME' 2>/dev/null || true)"
fi
if [ -z "$root_password" ]; then
  root_password="$($COMPOSE -f "$compose_file" exec -T "$api_service" sh -lc 'printenv ROOT_ACCESS_PASSWORD' 2>/dev/null || true)"
fi

echo "LLM Gateway ASR credential rotate"
echo "  apiBase: $api_base"
echo "  compose: $compose_file"
echo "  database: $mongo_db"
echo "  exchangeId: ${LLMGW_ASR_EXCHANGE_ID:-auto}"
echo "  modelId: ${LLMGW_ASR_MODEL_ID:-doubao-asr-bigmodel}"
echo "  authScheme: ${LLMGW_ASR_TARGET_AUTH_SCHEME:-auto}"
echo "  dryRun: $dry_run"
echo "  backupDir: $backup_dir"

if [ "$dry_run" = "1" ] || [ "$dry_run" = "true" ]; then
  echo "LLM Gateway ASR credential rotate dry-run: backup skipped"
else
  "$script_dir/llmgw-disk-space-guard.sh" "$backup_dir" "${LLMGW_ASR_CREDENTIAL_MIN_FREE_MB:-4096}" "LLM Gateway ASR credential rotate backup"
  mkdir -p "$backup_dir"
  echo "LLM Gateway ASR credential rotate: writing Mongo backup"
  # shellcheck disable=SC2086
  $COMPOSE -f "$compose_file" exec -T "$mongo_service" \
    mongodump --db "$mongo_db" --collection model_exchanges --archive \
    | gzip > "$backup_dir/mongo-$mongo_db-model_exchanges-before-asr-credential-rotate.archive.gz"
fi

ROOT_ACCESS_USERNAME="$root_username" \
ROOT_ACCESS_PASSWORD="$root_password" \
python3 "$script_dir/llmgw-prod-asr-credential-rotate.py" \
  --api-base "$api_base" \
  --exchange-id "${LLMGW_ASR_EXCHANGE_ID:-}" \
  --model-id "${LLMGW_ASR_MODEL_ID:-doubao-asr-bigmodel}" \
  --target-auth-scheme "${LLMGW_ASR_TARGET_AUTH_SCHEME:-}" \
  --new-key-env LLMGW_ASR_NEW_KEY \
  --timeout "${LLMGW_ASR_CREDENTIAL_TIMEOUT:-60}" \
  --json-out "${LLMGW_ASR_CREDENTIAL_JSON_OUT:-}"

if [ "$dry_run" = "1" ] || [ "$dry_run" = "true" ]; then
  echo "LLM Gateway ASR credential rotate dry-run completed"
else
  echo "LLM Gateway ASR credential rotate completed with backup: $backup_dir"
fi
