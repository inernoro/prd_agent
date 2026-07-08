#!/usr/bin/env sh
set -eu

# Restore MAP API to conservative LLM Gateway shadow observation.
# Scope: keep shadow mode, clear any HTTP allowlist, lower full shadow sampling,
# and restart only api. This is for failed evidence windows where returning to
# inproc would discard shadow observability but leaving high sampling is risky.

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
compose_file="${LLMGW_RESTORE_COMPOSE_FILE:-$repo_root/docker-compose.yml}"
env_file="${LLMGW_RESTORE_ENV_FILE:-$repo_root/.env}"
service_name="${LLMGW_RESTORE_API_SERVICE:-api}"
gateway_service="${LLMGW_RESTORE_GATEWAY_SERVICE:-gateway}"
dry_run="${LLMGW_RESTORE_DRY_RUN:-0}"
sample_percent="${LLMGW_RESTORE_SHADOW_FULL_SAMPLE_PERCENT:-1}"
persist_env="${LLMGW_RESTORE_PERSIST_ENV:-1}"

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

preserve_image_var() {
  image_var="$1"
  container_name="$2"
  eval "existing_value=\${$image_var:-}"
  if [ -n "$existing_value" ]; then
    return
  fi
  if ! command -v docker >/dev/null 2>&1; then
    return
  fi
  running_image="$(docker inspect "$container_name" --format '{{.Config.Image}}' 2>/dev/null || true)"
  if [ -n "$running_image" ]; then
    export "$image_var=$running_image"
  fi
}

preserve_release_image_vars() {
  preserve_image_var PRD_AGENT_API_IMAGE prdagent-api
  preserve_image_var PRD_AGENT_LLMGW_IMAGE prdagent-llmgw
  preserve_image_var PRD_AGENT_LLMGW_SERVE_IMAGE prdagent-llmgw-serve
  preserve_image_var PRD_AGENT_LLMGW_WEB_IMAGE prdagent-llmgw-web
}

persist_env_file() {
  if [ "$persist_env" = "0" ] || [ "$persist_env" = "false" ]; then
    echo "LLM Gateway restore: env persistence disabled"
    return
  fi

  env_dir=$(dirname -- "$env_file")
  if [ ! -d "$env_dir" ]; then
    echo "ERROR: env file parent directory does not exist: $env_dir" >&2
    exit 1
  fi

  if [ "$dry_run" = "1" ] || [ "$dry_run" = "true" ]; then
    echo "LLM Gateway restore dry-run: env file would be updated: $env_file"
    return
  fi

  tmp_file="${env_file}.tmp.$$"
  ENV_FILE="$env_file" \
  TMP_FILE="$tmp_file" \
  RESTORE_SAMPLE_PERCENT="$sample_percent" \
  RESTORE_PRD_AGENT_API_IMAGE="${PRD_AGENT_API_IMAGE:-}" \
  RESTORE_PRD_AGENT_LLMGW_IMAGE="${PRD_AGENT_LLMGW_IMAGE:-}" \
  RESTORE_PRD_AGENT_LLMGW_SERVE_IMAGE="${PRD_AGENT_LLMGW_SERVE_IMAGE:-}" \
  RESTORE_PRD_AGENT_LLMGW_WEB_IMAGE="${PRD_AGENT_LLMGW_WEB_IMAGE:-}" \
  python3 - <<'PY'
import os
import re
from pathlib import Path

env_path = Path(os.environ["ENV_FILE"])
tmp_path = Path(os.environ["TMP_FILE"])
updates = {
    "LLMGW_MODE": "shadow",
    "LLMGW_HTTP_APP_CALLER_ALLOWLIST": "",
    "LLMGW_SHADOW_FULL_SAMPLE_PERCENT": os.environ["RESTORE_SAMPLE_PERCENT"],
    "LLMGW_SHADOW_FULL_SAMPLE_APP_CALLER_ALLOWLIST": "",
}
image_updates = {
    "PRD_AGENT_API_IMAGE": os.environ.get("RESTORE_PRD_AGENT_API_IMAGE", ""),
    "PRD_AGENT_LLMGW_IMAGE": os.environ.get("RESTORE_PRD_AGENT_LLMGW_IMAGE", ""),
    "PRD_AGENT_LLMGW_SERVE_IMAGE": os.environ.get("RESTORE_PRD_AGENT_LLMGW_SERVE_IMAGE", ""),
    "PRD_AGENT_LLMGW_WEB_IMAGE": os.environ.get("RESTORE_PRD_AGENT_LLMGW_WEB_IMAGE", ""),
}
updates.update({key: value for key, value in image_updates.items() if value})

lines = env_path.read_text(encoding="utf-8").splitlines() if env_path.exists() else []
seen = {key: False for key in updates}
out = []
pattern = re.compile(r"^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$")

for line in lines:
    match = pattern.match(line)
    if match and match.group(3) in updates:
        key = match.group(3)
        out.append(f"{match.group(1)}{match.group(2) or ''}{key}={updates[key]}")
        seen[key] = True
    else:
        out.append(line)

if out and out[-1] != "":
    out.append("")
for key, value in updates.items():
    if not seen[key]:
        out.append(f"{key}={value}")

tmp_path.write_text("\n".join(out) + "\n", encoding="utf-8")
PY
  mv "$tmp_file" "$env_file"
  echo "LLM Gateway restore: persisted conservative shadow env to $env_file"
}

echo "LLM Gateway restore: forcing MAP API back to conservative shadow mode"
echo "  compose: $compose_file"
echo "  envFile: $env_file"
echo "  service: $service_name"
echo "  gatewayService: ${gateway_service:-none}"
echo "  mode: shadow"
echo "  allowlist: empty"
echo "  shadowFullSamplePercent: $sample_percent"
echo "  persistEnv: $persist_env"
echo "  database: unchanged"
echo "  images: preserve running release pins"
echo "  dryRun: $dry_run"

preserve_release_image_vars

export LLMGW_MODE=shadow
export LLMGW_HTTP_APP_CALLER_ALLOWLIST=
export LLMGW_SHADOW_FULL_SAMPLE_PERCENT="$sample_percent"
export LLMGW_SHADOW_FULL_SAMPLE_APP_CALLER_ALLOWLIST=

persist_env_file

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
