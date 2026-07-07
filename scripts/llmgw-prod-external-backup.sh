#!/usr/bin/env sh
set -eu

# Stream production Mongo backups to the operator machine without writing large
# archives to the production root filesystem. This script is intended to be run
# from a trusted operator workstation.

remote_host="${LLMGW_EXTERNAL_BACKUP_HOST:-root@map.ebcone.net}"
remote_repo="${LLMGW_EXTERNAL_BACKUP_REMOTE_REPO:-/root/inernoro/prd_agent}"
compose_file="${LLMGW_EXTERNAL_BACKUP_COMPOSE_FILE:-cds-compose.yml}"
mongo_service="${LLMGW_EXTERNAL_BACKUP_MONGO_SERVICE:-mongodb}"
databases="${LLMGW_EXTERNAL_BACKUP_DATABASES:-prdagent llm_gateway}"
stamp="$(date '+%Y%m%dT%H%M%S%z' 2>/dev/null || date '+%Y%m%dT%H%M%S')"
backup_root="${LLMGW_EXTERNAL_BACKUP_ROOT:-$HOME/prd-agent-prod-backups}"
backup_dir="${LLMGW_EXTERNAL_BACKUP_DIR:-$backup_root/llmgw-prod-external-$stamp}"
dry_run="${LLMGW_EXTERNAL_BACKUP_DRY_RUN:-0}"
include_secrets="${LLMGW_EXTERNAL_BACKUP_INCLUDE_SECRETS:-0}"

run_remote() {
  ssh "$remote_host" "$@"
}

echo "LLM Gateway production external backup"
echo "  remoteHost: $remote_host"
echo "  remoteRepo: $remote_repo"
echo "  compose: $compose_file"
echo "  mongoService: $mongo_service"
echo "  databases: $databases"
echo "  localDir: $backup_dir"
echo "  dryRun: $dry_run"

if [ "$dry_run" = "1" ] || [ "$dry_run" = "true" ]; then
  echo "LLM Gateway external backup dry-run: no local files will be written"
  run_remote "cd '$remote_repo' && pwd && df -Pm / | tail -1 && docker compose -f '$compose_file' ps --format json | head -20"
  exit 0
fi

mkdir -p "$backup_dir"
chmod 700 "$backup_dir"

run_remote "cd '$remote_repo' && pwd" > "$backup_dir/remote-pwd.txt"
run_remote "cd '$remote_repo' && df -Pm /" > "$backup_dir/remote-df-root.txt"
run_remote "cd '$remote_repo' && docker compose -f '$compose_file' ps" > "$backup_dir/docker-ps.txt"
run_remote "cd '$remote_repo' && cat '$compose_file'" > "$backup_dir/$compose_file"
if run_remote "cd '$remote_repo' && test -f docker-compose.yml"; then
  run_remote "cd '$remote_repo' && cat docker-compose.yml" > "$backup_dir/docker-compose.yml"
fi

if [ "$include_secrets" = "1" ] || [ "$include_secrets" = "true" ]; then
  if run_remote "cd '$remote_repo' && test -f .env"; then
    run_remote "cd '$remote_repo' && cat .env" > "$backup_dir/env.snapshot"
    chmod 600 "$backup_dir/env.snapshot"
  fi
else
  if run_remote "cd '$remote_repo' && test -f .env"; then
    run_remote "cd '$remote_repo' && sed -E 's/(PASSWORD|SECRET|TOKEN|KEY|URI|CONNECTION_STRING)([^=]*)=.*/\\1\\2=***REDACTED***/I' .env" > "$backup_dir/env.snapshot.redacted"
    chmod 600 "$backup_dir/env.snapshot.redacted"
  fi
fi

for db in $databases; do
  case "$db" in
    *[!A-Za-z0-9_-]*|"")
      echo "ERROR: invalid database name: $db" >&2
      exit 1
      ;;
  esac
  echo "LLM Gateway external backup: streaming Mongo database $db"
  run_remote "cd '$remote_repo' && docker compose -f '$compose_file' exec -T '$mongo_service' mongodump --db '$db' --archive" \
    | gzip > "$backup_dir/$db.archive.gz"
  gzip -t "$backup_dir/$db.archive.gz"
done

(
  cd "$backup_dir"
  shasum -a 256 ./*.archive.gz > SHA256SUMS
)

echo "LLM Gateway external backup completed: $backup_dir"
cat "$backup_dir/SHA256SUMS"
