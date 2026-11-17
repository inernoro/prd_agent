#!/bin/sh
set -eu
umask 077
stamp=${1:-$(date -u +%Y%m%dT%H%M%SZ)}
case "$stamp" in *[!0-9TZ]*|'') exit 64;; esac
[ "${#stamp}" = 16 ] || exit 64
root=/var/lib/prd-agent/business-backups/$stamp
mkdir -p "$root"
exec 9>/run/lock/prd-agent-business-backup.lock
flock -n 9 || exit 75
printf '%s\n' running > "$root/status"
trap 'printf "%s\n" failed > "$root/status"' EXIT
for name in prdagent llm_gateway admin; do
  if [ -f "$root/$name.archive.gz.sha256" ]; then continue; fi
  available=$(df -Pk /var/lib/prd-agent | awk 'NR==2 {print $4}')
  [ "$available" -gt 10485760 ] || { echo 'Less than 10 GiB free; refusing new dump' >&2; exit 1; }
  date -u +%FT%TZ > "$root/$name.started"
  # df reports KiB; use an explicit byte ceiling, independent of shell ulimit units.
  prlimit --fsize="$(((available - 10485760) * 1024))" -- timeout 2h docker exec prdagent-mongodb nice -n 19 ionice -c 3 mongodump --numParallelCollections=1 --db "$name" --archive --gzip > "$root/$name.archive.gz.partial" 2> "$root/$name.dump.log"
  nice -n 19 ionice -c 3 gzip -t "$root/$name.archive.gz.partial"
  mv "$root/$name.archive.gz.partial" "$root/$name.archive.gz"
  (cd "$root" && nice -n 19 ionice -c 3 sha256sum "$name.archive.gz" > "$name.archive.gz.sha256")
  date -u +%FT%TZ > "$root/$name.completed"
done
# Capture after all hot-log dumps: every cold pointer in them predates this
# immutable archive-directory snapshot, including cross-database pointers.
name=log-archive-index
available=$(df -Pk /var/lib/prd-agent | awk 'NR==2 {print $4}')
[ "$available" -gt 10485760 ] || { echo 'Less than 10 GiB free; refusing archive-directory dump' >&2; exit 1; }
date -u +%FT%TZ > "$root/$name.started"
prlimit --fsize="$(((available - 10485760) * 1024))" -- timeout 10m docker exec prdagent-mongodb nice -n 19 ionice -c 3 mongodump --numParallelCollections=1 --db prdagent --collection log_archive_batches --archive --gzip > "$root/$name.archive.gz.partial" 2> "$root/$name.dump.log"
nice -n 19 ionice -c 3 gzip -t "$root/$name.archive.gz.partial"
mv "$root/$name.archive.gz.partial" "$root/$name.archive.gz"
(cd "$root" && nice -n 19 ionice -c 3 sha256sum "$name.archive.gz" > "$name.archive.gz.sha256")
date -u +%FT%TZ > "$root/$name.completed"
docker exec prdagent-mongodb mongosh --quiet --eval 'const names=["prdagent","llm_gateway","admin"];const out={};for(const name of names){const d=db.getSiblingDB(name);out[name]=d.getCollectionInfos().filter(c=>c.type==="collection").map(c=>({name:c.name,indexes:d.getCollection(c.name).getIndexes()}));}print(EJSON.stringify(out));' > "$root/indexes.json"
printf '%s\n' completed > "$root/status"
trap - EXIT
