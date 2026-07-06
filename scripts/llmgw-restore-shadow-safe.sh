#!/usr/bin/env sh
set -eu

# Restore MAP API to conservative LLM Gateway shadow observation.
# Scope: keep shadow mode, clear any HTTP allowlist, lower full shadow sampling,
# and restart only api. This is for failed evidence windows where returning to
# inproc would discard shadow observability but leaving high sampling is risky.

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
compose_file="${LLMGW_RESTORE_COMPOSE_FILE:-$repo_root/docker-compose.yml}"
service_name="${LLMGW_RESTORE_API_SERVICE:-api}"
gateway_service="${LLMGW_RESTORE_GATEWAY_SERVICE:-gateway}"
dry_run="${LLMGW_RESTORE_DRY_RUN:-0}"
sample_percent="${LLMGW_RESTORE_SHADOW_FULL_SAMPLE_PERCENT:-1}"

if [ ! -f "$compose_file" ]; then
  echo "ERROR: 找不到 compose 文件: $compose_file" >&2
  exit 1
fi

if ! printf '%s' "$sample_percent" | grep -Eq '^[0-9]+$'; then
  echo "ERROR: LLMGW_RESTORE_SHADOW_FULL_SAMPLE_PERCENT must be an integer percent" >&2
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

echo "LLM Gateway restore: forcing MAP API back to conservative shadow mode"
echo "  compose: $compose_file"
echo "  service: $service_name"
echo "  gatewayService: ${gateway_service:-none}"
echo "  mode: shadow"
echo "  allowlist: empty"
echo "  shadowFullSamplePercent: $sample_percent"
echo "  database: unchanged"
echo "  images: unchanged"
echo "  dryRun: $dry_run"

export LLMGW_MODE=shadow
export LLMGW_HTTP_APP_CALLER_ALLOWLIST=
export LLMGW_SHADOW_FULL_SAMPLE_PERCENT="$sample_percent"

if [ "$dry_run" = "1" ] || [ "$dry_run" = "true" ]; then
  echo "LLM Gateway restore dry-run: $COMPOSE -f $compose_file up -d --no-deps --force-recreate $service_name"
  if [ -n "$(printf '%s' "$gateway_service" | xargs || true)" ]; then
    echo "LLM Gateway restore dry-run: $COMPOSE -f $compose_file up -d --no-deps --force-recreate $gateway_service"
  fi
  echo "LLM Gateway restore dry-run completed: API would restart with LLMGW_MODE=shadow and sample=$sample_percent"
else
  # shellcheck disable=SC2086
  $COMPOSE -f "$compose_file" up -d --no-deps --force-recreate "$service_name"
  if [ -n "$(printf '%s' "$gateway_service" | xargs || true)" ]; then
    if $COMPOSE -f "$compose_file" config --services 2>/dev/null | grep -Fxq "$gateway_service"; then
      # shellcheck disable=SC2086
      $COMPOSE -f "$compose_file" up -d --no-deps --force-recreate "$gateway_service"
      echo "LLM Gateway restore: gateway service refreshed after API restart"
    else
      echo "LLM Gateway restore: gateway service '$gateway_service' not found, refresh skipped"
    fi
  fi
  echo "LLM Gateway restore completed: API restarted with LLMGW_MODE=shadow and sample=$sample_percent"
fi
