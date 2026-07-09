#!/usr/bin/env sh
set -eu

# Backup data touched by the LLM Gateway config-authority migration.
# Dry-run is the default. Execute mode writes Mongo archives on the production
# host and emits small JSON/Markdown evidence files for rollout ledger checks.

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
compose_file="${LLMGW_CONFIG_AUTHORITY_BACKUP_COMPOSE_FILE:-$repo_root/docker-compose.yml}"
mongo_service="${LLMGW_CONFIG_AUTHORITY_BACKUP_MONGO_SERVICE:-mongodb}"
mode="$(printf '%s' "${LLMGW_CONFIG_AUTHORITY_BACKUP_MODE:-critical}" | tr 'A-Z' 'a-z' | xargs || true)"
critical_collections="${LLMGW_CONFIG_AUTHORITY_BACKUP_COLLECTIONS:-prdagent.model_groups prdagent.llmplatforms prdagent.llmmodels prdagent.model_exchanges llm_gateway.*}"
databases="${LLMGW_CONFIG_AUTHORITY_BACKUP_DATABASES:-prdagent llm_gateway}"
dry_run="${LLMGW_CONFIG_AUTHORITY_BACKUP_DRY_RUN:-1}"
backup_root="${LLMGW_CONFIG_AUTHORITY_BACKUP_ROOT:-/root/backups}"
backup_stamp="$(date '+%Y%m%dT%H%M%S%z' 2>/dev/null || date '+%Y%m%dT%H%M%S')"
backup_dir="${LLMGW_CONFIG_AUTHORITY_BACKUP_DIR:-$backup_root/llmgw-prod-before-config-authority-$backup_stamp}"
json_out="${LLMGW_CONFIG_AUTHORITY_BACKUP_JSON_OUT:-}"
report_md="${LLMGW_CONFIG_AUTHORITY_BACKUP_REPORT_MD:-}"

if [ ! -f "$compose_file" ]; then
  echo "ERROR: 找不到 compose 文件: $compose_file" >&2
  exit 1
fi

case "$mode" in
  full|critical)
    ;;
  *)
    echo "ERROR: LLMGW_CONFIG_AUTHORITY_BACKUP_MODE=$mode is invalid; allowed: full, critical" >&2
    exit 1
    ;;
esac

if command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
elif command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
else
  echo "ERROR: 未找到 docker-compose 或 docker compose" >&2
  exit 1
fi

write_report() {
  verdict="$1"
  if [ -z "$json_out" ] && [ -z "$report_md" ]; then
    return 0
  fi
  LLMGW_CONFIG_AUTHORITY_BACKUP_REPORT_VERDICT="$verdict" \
  LLMGW_CONFIG_AUTHORITY_BACKUP_REPORT_JSON="$json_out" \
  LLMGW_CONFIG_AUTHORITY_BACKUP_REPORT_MD="$report_md" \
  LLMGW_CONFIG_AUTHORITY_BACKUP_REPORT_DIR="$backup_dir" \
  LLMGW_CONFIG_AUTHORITY_BACKUP_REPORT_COMPOSE="$compose_file" \
  LLMGW_CONFIG_AUTHORITY_BACKUP_REPORT_SERVICE="$mongo_service" \
  LLMGW_CONFIG_AUTHORITY_BACKUP_REPORT_MODE="$mode" \
  LLMGW_CONFIG_AUTHORITY_BACKUP_REPORT_DATABASES="$databases" \
  LLMGW_CONFIG_AUTHORITY_BACKUP_REPORT_COLLECTIONS="$critical_collections" \
  LLMGW_CONFIG_AUTHORITY_BACKUP_REPORT_DRY_RUN="$dry_run" \
  python3 - <<'PY'
import json
import os
from datetime import datetime, timezone
from pathlib import Path

backup_dir = Path(os.environ["LLMGW_CONFIG_AUTHORITY_BACKUP_REPORT_DIR"])
archives = []
if backup_dir.exists():
    archives = sorted(str(path) for path in backup_dir.glob("*.archive.gz"))
sha_path = backup_dir / "SHA256SUMS"
report = {
    "generatedAt": datetime.now(timezone.utc).isoformat(),
    "verdict": os.environ["LLMGW_CONFIG_AUTHORITY_BACKUP_REPORT_VERDICT"],
    "backupDir": str(backup_dir),
    "composeFile": os.environ["LLMGW_CONFIG_AUTHORITY_BACKUP_REPORT_COMPOSE"],
    "mongoService": os.environ["LLMGW_CONFIG_AUTHORITY_BACKUP_REPORT_SERVICE"],
    "mode": os.environ["LLMGW_CONFIG_AUTHORITY_BACKUP_REPORT_MODE"],
    "databases": os.environ["LLMGW_CONFIG_AUTHORITY_BACKUP_REPORT_DATABASES"].split(),
    "criticalCollections": os.environ["LLMGW_CONFIG_AUTHORITY_BACKUP_REPORT_COLLECTIONS"].split(),
    "dryRun": os.environ["LLMGW_CONFIG_AUTHORITY_BACKUP_REPORT_DRY_RUN"].lower() in {"1", "true", "yes"},
    "archiveCount": len(archives),
    "archives": archives,
    "sha256Sums": str(sha_path) if sha_path.exists() else "",
}
json_out = os.environ.get("LLMGW_CONFIG_AUTHORITY_BACKUP_REPORT_JSON", "")
if json_out:
    path = Path(json_out)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
md_out = os.environ.get("LLMGW_CONFIG_AUTHORITY_BACKUP_REPORT_MD", "")
if md_out:
    path = Path(md_out)
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "# LLM Gateway Config Authority Backup Report",
        "",
        f"- generatedAt: `{report['generatedAt']}`",
        f"- verdict: `{report['verdict']}`",
        f"- dryRun: `{report['dryRun']}`",
        f"- mode: `{report['mode']}`",
        f"- backupDir: `{report['backupDir']}`",
        f"- archiveCount: `{report['archiveCount']}`",
        f"- sha256Sums: `{report['sha256Sums']}`",
        "",
        "## Archives",
        "",
    ]
    if archives:
        lines.extend(f"- `{item}`" for item in archives)
    else:
        lines.append("- none")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY
}

dump_db() {
  db="$1"
  case "$db" in
    *[!A-Za-z0-9_-]*|"")
      echo "ERROR: invalid database name: $db" >&2
      exit 1
      ;;
  esac
  # shellcheck disable=SC2086
  $COMPOSE -f "$compose_file" exec -T "$mongo_service" \
    mongodump --db "$db" --archive \
    | gzip > "$backup_dir/$db.archive.gz"
  gzip -t "$backup_dir/$db.archive.gz"
}

dump_collection() {
  db="$1"
  collection="$2"
  case "$db" in
    *[!A-Za-z0-9_-]*|"")
      echo "ERROR: invalid database name: $db" >&2
      exit 1
      ;;
  esac
  case "$collection" in
    *[!A-Za-z0-9_-]*|"")
      echo "ERROR: invalid collection name: $collection" >&2
      exit 1
      ;;
  esac
  # shellcheck disable=SC2086
  $COMPOSE -f "$compose_file" exec -T "$mongo_service" \
    mongodump --db "$db" --collection "$collection" --archive \
    | gzip > "$backup_dir/$db.$collection.archive.gz"
  gzip -t "$backup_dir/$db.$collection.archive.gz"
}

echo "LLM Gateway config authority backup"
echo "  compose: $compose_file"
echo "  mongoService: $mongo_service"
echo "  mode: $mode"
echo "  databases: $databases"
echo "  criticalCollections: $critical_collections"
echo "  dryRun: $dry_run"
echo "  backupDir: $backup_dir"

if [ "$dry_run" = "1" ] || [ "$dry_run" = "true" ]; then
  echo "LLM Gateway config authority backup dry-run: no archives will be written"
  write_report pass
  exit 0
fi

"$script_dir/llmgw-disk-space-guard.sh" "$backup_dir" "${LLMGW_CONFIG_AUTHORITY_BACKUP_MIN_FREE_MB:-6144}" "LLM Gateway config authority backup"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
cp -a "$compose_file" "$backup_dir/$(basename "$compose_file")"

if [ "$mode" = "full" ]; then
  for db in $databases; do
    echo "LLM Gateway config authority backup: dumping database $db"
    dump_db "$db"
  done
else
  for spec in $critical_collections; do
    case "$spec" in
      *.*)
        db="${spec%%.*}"
        collection="${spec#*.}"
        ;;
      *)
        echo "ERROR: invalid critical collection spec: $spec; expected db.collection or db.*" >&2
        exit 1
        ;;
    esac
    if [ "$collection" = "*" ]; then
      echo "LLM Gateway config authority backup: dumping database $db"
      dump_db "$db"
    else
      echo "LLM Gateway config authority backup: dumping collection $db.$collection"
      dump_collection "$db" "$collection"
    fi
  done
fi

(
  cd "$backup_dir"
  shasum -a 256 ./*.archive.gz > SHA256SUMS
)

write_report pass
echo "LLM Gateway config authority backup completed: $backup_dir"
cat "$backup_dir/SHA256SUMS"
