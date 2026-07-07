#!/usr/bin/env sh
set -eu

# Short, reversible production shadow sampling window for LLM Gateway evidence.
# It raises LLMGW_SHADOW_FULL_SAMPLE_PERCENT only around a real MAP seed run,
# then force-recreates API back to a known restore value even when the seed fails.

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
compose_file="${LLMGW_SHADOW_SAMPLE_WINDOW_COMPOSE_FILE:-$repo_root/docker-compose.yml}"
env_file="${LLMGW_SHADOW_SAMPLE_WINDOW_ENV_FILE:-$repo_root/.env}"
api_service="${LLMGW_SHADOW_SAMPLE_WINDOW_API_SERVICE:-api}"
api_container="${LLMGW_SHADOW_SAMPLE_WINDOW_API_CONTAINER:-prdagent-api}"
map_base="${LLMGW_SHADOW_SAMPLE_WINDOW_MAP_BASE:-${PRD_AGENT_BASE:-http://127.0.0.1:5500}}"
gw_base="${LLMGW_SHADOW_SAMPLE_WINDOW_GW_BASE:-${GW_BASE:-${LLMGW_GATE_BASE:-$map_base/gw/v1}}}"
sample_percent="${LLMGW_SHADOW_SAMPLE_WINDOW_PERCENT:-100}"
restore_percent="${LLMGW_SHADOW_SAMPLE_WINDOW_RESTORE_PERCENT:-1}"
seed_flags="${LLMGW_SHADOW_SAMPLE_WINDOW_SEED_FLAGS:-}"
dry_run="${LLMGW_SHADOW_SAMPLE_WINDOW_DRY_RUN:-1}"
backup_root="${LLMGW_SHADOW_SAMPLE_WINDOW_BACKUP_ROOT:-/root/backups}"
evidence_root="${LLMGW_SHADOW_SAMPLE_WINDOW_EVIDENCE_ROOT:-$repo_root/.llmgw-release-evidence}"
backup_stamp="$(date '+%Y%m%dT%H%M%S%z' 2>/dev/null || date '+%Y%m%dT%H%M%S')"
backup_dir="${LLMGW_SHADOW_SAMPLE_WINDOW_BACKUP_DIR:-$backup_root/llmgw-before-shadow-sample-window-$backup_stamp}"
evidence_out="${LLMGW_SHADOW_SAMPLE_WINDOW_EVIDENCE_OUT:-$evidence_root/$(date -u '+%Y%m%dT%H%M%SZ')_shadow-sample-window.json}"

if [ ! -f "$compose_file" ]; then
  echo "ERROR: 找不到 compose 文件: $compose_file" >&2
  exit 1
fi

if [ ! -f "$env_file" ] && [ "$dry_run" != "1" ] && [ "$dry_run" != "true" ]; then
  echo "ERROR: 找不到 .env 文件: $env_file" >&2
  exit 1
fi

if [ ! -f "$script_dir/llmgw-map-shadow-seed.py" ]; then
  echo "ERROR: 找不到 llmgw-map-shadow-seed.py" >&2
  exit 1
fi

case "$sample_percent" in
  ''|*[!0-9]*)
    echo "ERROR: LLMGW_SHADOW_SAMPLE_WINDOW_PERCENT 必须是 0-100 的整数" >&2
    exit 1
    ;;
esac

case "$restore_percent" in
  ''|*[!0-9]*)
    echo "ERROR: LLMGW_SHADOW_SAMPLE_WINDOW_RESTORE_PERCENT 必须是 0-100 的整数" >&2
    exit 1
    ;;
esac

if [ "$sample_percent" -gt 100 ] || [ "$restore_percent" -gt 100 ]; then
  echo "ERROR: shadow sample percent 必须在 0-100 之间" >&2
  exit 1
fi

if [ "$dry_run" != "1" ] && [ "$dry_run" != "true" ] && [ -z "$(printf '%s' "$seed_flags" | xargs || true)" ]; then
  echo "ERROR: 执行模式必须设置 LLMGW_SHADOW_SAMPLE_WINDOW_SEED_FLAGS，避免空跑采样窗口" >&2
  exit 1
fi

compose_timeout_seconds="${LLMGW_SHADOW_SAMPLE_WINDOW_COMPOSE_TIMEOUT_SECONDS:-180}"
if command -v docker-compose >/dev/null 2>&1; then
  compose_kind="docker-compose"
elif command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  compose_kind="docker-compose-plugin"
else
  echo "ERROR: 未找到 docker-compose 或 docker compose" >&2
  exit 1
fi

set_env_value() {
  key="$1"
  value="$2"
  tmp="$(mktemp)"
  grep -v "^$key=" "$env_file" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$env_file"
}

compose_up_api() {
  if command -v timeout >/dev/null 2>&1; then
    if [ "$compose_kind" = "docker-compose" ]; then
      timeout "$compose_timeout_seconds" docker-compose -f "$compose_file" up -d --force-recreate "$api_service"
    else
      timeout "$compose_timeout_seconds" docker compose -f "$compose_file" up -d --force-recreate "$api_service"
    fi
  elif [ "$compose_kind" = "docker-compose" ]; then
    docker-compose -f "$compose_file" up -d --force-recreate "$api_service"
  else
    docker compose -f "$compose_file" up -d --force-recreate "$api_service"
  fi
}

wait_api_ready() {
  expected_sample="$1"
  max_attempts="${LLMGW_SHADOW_SAMPLE_WINDOW_READY_ATTEMPTS:-90}"
  interval="${LLMGW_SHADOW_SAMPLE_WINDOW_READY_INTERVAL_SECONDS:-2}"
  attempt=1
  while [ "$attempt" -le "$max_attempts" ]; do
    mode="$(docker exec "$api_container" printenv LlmGateway__Mode 2>/dev/null || true)"
    current_sample="$(docker exec "$api_container" printenv LlmGateway__ShadowFullSamplePercent 2>/dev/null || true)"
    code="$(curl -sS -o /tmp/llmgw-shadow-sample-window-login-probe -w '%{http_code}' \
      "$map_base/api/v1/auth/login" \
      -X POST \
      -H 'Content-Type: application/json' \
      -d '{}' || true)"
    if [ "$mode" = "shadow" ] && [ "$current_sample" = "$expected_sample" ] && [ "$code" != "502" ] && [ "$code" != "000" ]; then
      return 0
    fi
    sleep "$interval"
    attempt=$((attempt + 1))
  done
  echo "ERROR: API 未进入预期状态 mode=shadow sample=$expected_sample" >&2
  return 1
}

restore_sampling() {
  rc=$?
  trap - EXIT INT TERM
  if [ "$dry_run" = "1" ] || [ "$dry_run" = "true" ]; then
    exit "$rc"
  fi
  set +e
  restore_failed=0
  set_env_value LLMGW_SHADOW_FULL_SAMPLE_PERCENT "$restore_percent"
  compose_up_api >/tmp/llmgw-shadow-sample-window-restore.log 2>&1 || restore_failed=1
  wait_api_ready "$restore_percent" >/tmp/llmgw-shadow-sample-window-restore-wait.log 2>&1 || restore_failed=1
  restored="$(docker exec "$api_container" printenv LlmGateway__ShadowFullSamplePercent 2>/dev/null || true)"
  echo "LLM Gateway shadow sample window restored: sample=$restored"
  if [ "$restore_failed" != "0" ] || [ "$restored" != "$restore_percent" ]; then
    echo "ERROR: shadow sample restore failed; see /tmp/llmgw-shadow-sample-window-restore.log and /tmp/llmgw-shadow-sample-window-restore-wait.log" >&2
    exit 1
  fi
  exit "$rc"
}

echo "LLM Gateway shadow sample window"
echo "  compose: $compose_file"
echo "  env: $env_file"
echo "  apiService: $api_service"
echo "  apiContainer: $api_container"
echo "  composeTimeoutSeconds: $compose_timeout_seconds"
echo "  mapBase: $map_base"
echo "  gwBase: $gw_base"
echo "  samplePercent: $sample_percent"
echo "  restorePercent: $restore_percent"
echo "  dryRun: $dry_run"
echo "  backupDir: $backup_dir"
echo "  evidenceOut: $evidence_out"
echo "  seedFlags: $seed_flags"

if [ "$dry_run" = "1" ] || [ "$dry_run" = "true" ]; then
  echo "LLM Gateway shadow sample window dry-run completed"
  exit 0
fi

trap restore_sampling EXIT INT TERM

mkdir -p "$backup_dir"
cp -a "$env_file" "$backup_dir/.env"
cp -a "$compose_file" "$backup_dir/docker-compose.yml"
if [ -f "$repo_root/cds-compose.yml" ]; then
  cp -a "$repo_root/cds-compose.yml" "$backup_dir/cds-compose.yml"
fi
mkdir -p "$(dirname "$evidence_out")"

set_env_value LLMGW_SHADOW_FULL_SAMPLE_PERCENT "$sample_percent"
compose_up_api
wait_api_ready "$sample_percent"

set -a
# shellcheck disable=SC1090
. "$env_file"
set +a

gate_key="${LLMGW_GATE_KEY:-${GW_KEY:-${LLMGW_SERVE_KEY:-}}}"
if [ -z "$(printf '%s' "$gate_key" | xargs || true)" ]; then
  echo "ERROR: 缺少 LLMGW_GATE_KEY/GW_KEY/LLMGW_SERVE_KEY，无法读取 shadow summary" >&2
  exit 1
fi

# shellcheck disable=SC2086
LLMGW_GATE_KEY="$gate_key" python3 "$script_dir/llmgw-map-shadow-seed.py" \
  --base "$map_base" \
  --gw-base "$gw_base" \
  --continue-on-error \
  --evidence-out "$evidence_out" \
  $seed_flags

echo "LLM Gateway shadow sample window evidence: $evidence_out"
