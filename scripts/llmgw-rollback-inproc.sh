#!/usr/bin/env sh
set -eu

# Emergency rollback for LLM Gateway http/canary rollout.
# Scope: switch MAP API back to in-process gateway routing and restart only api.
# This intentionally does not roll back images, MongoDB, llm_gateway data, or logs.

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
compose_file="${LLMGW_ROLLBACK_COMPOSE_FILE:-$repo_root/docker-compose.yml}"
service_name="${LLMGW_ROLLBACK_API_SERVICE:-api}"
gateway_service="${LLMGW_ROLLBACK_GATEWAY_SERVICE:-gateway}"
dry_run="${LLMGW_ROLLBACK_DRY_RUN:-0}"

if [ ! -f "$compose_file" ]; then
  echo "ERROR: 找不到 compose 文件: $compose_file" >&2
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

echo "LLM Gateway rollback: forcing MAP API back to inproc mode"
echo "  compose: $compose_file"
echo "  service: $service_name"
echo "  gatewayService: ${gateway_service:-none}"
echo "  database: unchanged"
echo "  images: unchanged"
echo "  dryRun: $dry_run"

export LLMGW_MODE=inproc
export LLMGW_HTTP_APP_CALLER_ALLOWLIST=
export LLMGW_SHADOW_FULL_SAMPLE_PERCENT=0

if [ "$dry_run" = "1" ] || [ "$dry_run" = "true" ]; then
  echo "LLM Gateway rollback dry-run: $COMPOSE -f $compose_file up -d --no-deps --force-recreate $service_name"
  if [ -n "$(printf '%s' "$gateway_service" | xargs || true)" ]; then
    echo "LLM Gateway rollback dry-run: $COMPOSE -f $compose_file up -d --no-deps --force-recreate $gateway_service"
  fi
  echo "LLM Gateway rollback dry-run completed: API would restart with LLMGW_MODE=inproc"
else
  # shellcheck disable=SC2086
  $COMPOSE -f "$compose_file" up -d --no-deps --force-recreate "$service_name"
  if [ -n "$(printf '%s' "$gateway_service" | xargs || true)" ]; then
    if $COMPOSE -f "$compose_file" config --services 2>/dev/null | grep -Fxq "$gateway_service"; then
      # shellcheck disable=SC2086
      $COMPOSE -f "$compose_file" up -d --no-deps --force-recreate "$gateway_service"
      echo "LLM Gateway rollback: gateway service refreshed after API restart"
    else
      echo "LLM Gateway rollback: gateway service '$gateway_service' not found, refresh skipped"
    fi
  fi
  echo "LLM Gateway rollback completed: API restarted with LLMGW_MODE=inproc"
fi
