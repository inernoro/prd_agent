#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[local-prod] %s\n' "$*"
}

fail() {
  printf '[local-prod] ERROR %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"
}

require_command docker
require_command rsync

allowed_branch="${CDS_LOCAL_PROD_ALLOWED_BRANCH:-main}"
branch_name="${CDS_BRANCH_NAME:-}"
if [ -n "$allowed_branch" ] && [ "$branch_name" != "$allowed_branch" ]; then
  fail "only ${allowed_branch} can publish to local production, current branch is ${branch_name:-unknown}"
fi

project_id="${CDS_PROJECT_ID:-}"
branch_id="${CDS_BRANCH_ID:-}"
project_slug="${CDS_LOCAL_PROD_PROJECT_SLUG:-${project_id:-app}}"
prod_dir="${CDS_LOCAL_PROD_DIR:-$PWD}"
worktree_root="${CDS_WORKTREE_ROOT:-/root/inernoro/prd_agent/.cds-worktrees}"
source_dir="${CDS_LOCAL_PROD_SOURCE_DIR:-${CDS_ARTIFACT_PATH:-}}"
if [ -z "$source_dir" ]; then
  [ -n "$project_id" ] || fail "CDS_PROJECT_ID is required"
  [ -n "$branch_id" ] || fail "CDS_BRANCH_ID is required"
  source_dir="${worktree_root}/${project_id}/${branch_id}"
fi
[ -d "$source_dir" ] || fail "source worktree not found: $source_dir"

current_dir="${prod_dir}/current"
releases_dir="${prod_dir}/releases"
compose_file="${CDS_LOCAL_PROD_COMPOSE_FILE:-${prod_dir}/docker-compose.yml}"
compose_project="${CDS_LOCAL_PROD_COMPOSE_PROJECT:-${project_slug}-prod}"
health_url="${CDS_LOCAL_PROD_HEALTH_URL:-}"
health_timeout="${CDS_LOCAL_PROD_HEALTH_TIMEOUT_SECONDS:-180}"
web_port="${CDS_LOCAL_PROD_PORT:-}"
if [ -n "$health_url" ]; then
  require_command curl
fi

mkdir -p "$current_dir" "$releases_dir"

if [ -d "$current_dir" ] && [ "$(find "$current_dir" -mindepth 1 -maxdepth 1 2>/dev/null | head -n 1)" ]; then
  stamp="$(date +%Y%m%d%H%M%S)"
  log "backup current release to ${releases_dir}/${stamp}.tar.gz"
  tar -C "$current_dir" -czf "${releases_dir}/${stamp}.tar.gz" .
fi

log "sync source ${source_dir} -> ${current_dir}"
rsync -a --delete \
  --exclude '.git/' \
  --exclude '.next/cache/' \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude 'build/' \
  "$source_dir"/ "$current_dir"/

if [ ! -f "$compose_file" ]; then
  for candidate in \
    "$current_dir/docker-compose.prod.yml" \
    "$current_dir/compose.prod.yml" \
    "$current_dir/cds-prod-compose.yml" \
    "$current_dir/docker-compose.yml"; do
    if [ -f "$candidate" ]; then
      cp "$candidate" "$compose_file"
      log "created compose file from ${candidate}"
      break
    fi
  done
fi
[ -f "$compose_file" ] || fail "production compose file not found: $compose_file"

if [ ! -f "${prod_dir}/.env" ]; then
  for candidate in "$current_dir/cds-prod.env" "$current_dir/.env.production"; do
    if [ -f "$candidate" ]; then
      cp "$candidate" "${prod_dir}/.env"
      chmod 600 "${prod_dir}/.env" || true
      log "created .env from ${candidate}"
      break
    fi
  done
fi

cd "$prod_dir"
if docker compose version >/dev/null 2>&1; then
  compose=(docker compose)
else
  require_command docker-compose
  compose=(docker-compose)
fi

export CDS_LOCAL_PROD_DIR="$prod_dir"
export CDS_LOCAL_PROD_CURRENT_DIR="$current_dir"
export CDS_LOCAL_PROD_DOMAIN="${CDS_LOCAL_PROD_DOMAIN:-}"
export CDS_LOCAL_PROD_PORT="$web_port"
export PORT="$web_port"
export WEB_PORT="$web_port"

log "start docker compose project ${compose_project}"
"${compose[@]}" -p "$compose_project" -f "$compose_file" up -d --build --remove-orphans

if [ -n "$health_url" ]; then
  log "healthcheck ${health_url}"
  deadline=$(( $(date +%s) + health_timeout ))
  while true; do
    if curl -fsS --max-time 8 "$health_url" >/dev/null; then
      log "healthcheck passed"
      break
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      fail "healthcheck timeout: $health_url"
    fi
    sleep 3
  done
fi

log "release complete ${CDS_RELEASE_ID:-unknown}"
