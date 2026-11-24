#!/usr/bin/env bash
set -euo pipefail
: "${DTS_RUNTIME_IMAGE:?Set the immutable locally built runtime image}"
DTS_SMOKE_DIR=$(mktemp -d /tmp/cds-dts-image-smoke.XXXXXX)
export DTS_DRILL_DIRECTORY="$DTS_SMOKE_DIR"
DTS_SMOKE_TAG=${DTS_SMOKE_DIR##*/}
run_owned() { docker run --label "cds.dts-smoke=$DTS_SMOKE_TAG" "$@"; }
cleanup() {
 if [[ -n "${DTS_INTERFACE_PID:-}" ]]; then kill -TERM "$DTS_INTERFACE_PID" 2>/dev/null || true; wait "$DTS_INTERFACE_PID" 2>/dev/null || true; fi
 for name in cds-dts-engine-ci cds-dts-mongo-source-ci cds-dts-mongo-target-ci cds-dts-redis-ci cds-dts-qa-mysql-1117 cds-dts-qa-postgres-1117 cds-dts-rabbit-ci; do
  owner=$(docker inspect -f '{{ index .Config.Labels "cds.dts-smoke" }}' "$name" 2>/dev/null || true)
  if [[ "$owner" == "$DTS_SMOKE_TAG" ]]; then
   if [[ "$name" == cds-dts-engine-ci ]]; then docker logs "$name" > "$DTS_SMOKE_DIR/engine.log" 2>&1 || true; fi
   docker rm -fv "$name" >/dev/null 2>&1 || true
  fi
 done
}
trap cleanup EXIT
# Each runner owns these names; the script refuses to replace any existing container.
for name in cds-dts-engine-ci cds-dts-mongo-source-ci cds-dts-mongo-target-ci cds-dts-redis-ci cds-dts-qa-mysql-1117 cds-dts-qa-postgres-1117 cds-dts-rabbit-ci; do
  if docker inspect "$name" >/dev/null 2>&1; then echo 'Existing fixture name; no resource changed' >&2; trap - EXIT; exit 1; fi
done
printf '%s\n' '{"username":"ci-dts","password":"ci-disposable-engine-password-20261117"}' > "$DTS_SMOKE_DIR/engine-private.json"
chmod 600 "$DTS_SMOKE_DIR/engine-private.json"
run_owned -d --name cds-dts-mongo-source-ci -p 127.0.0.1:18881:27017 --memory 512m mongo:8.0 >/dev/null
run_owned -d --name cds-dts-mongo-target-ci -p 127.0.0.1:18882:27017 --memory 512m mongo:8.0 >/dev/null
run_owned -d --name cds-dts-redis-ci -p 127.0.0.1:18883:6379 --memory 128m redis:7.4.2-alpine redis-server --maxmemory 64mb --maxmemory-policy noeviction --save '' --appendonly no >/dev/null
run_owned -d --name cds-dts-qa-mysql-1117 -p 127.0.0.1:18891:3306 --memory 512m -e MYSQL_ROOT_PASSWORD=dts_disposable_1117 -e MYSQL_ROOT_HOST=% mysql:8.0 >/dev/null
run_owned -d --name cds-dts-qa-postgres-1117 -p 127.0.0.1:18892:5432 --memory 256m -e POSTGRES_PASSWORD=dts_disposable_1117 postgres:16-alpine >/dev/null
run_owned -d --name cds-dts-rabbit-ci -p 127.0.0.1:18893:15672 --memory 384m -e RABBITMQ_DEFAULT_USER=dts_qa -e RABBITMQ_DEFAULT_PASS=dts_disposable_1117 rabbitmq@sha256:606d8c0d6b3c18d1da9afc53bc7cdb2a8d5486df91b5a9830e9e07626c9ae281 >/dev/null
run_owned -d --name cds-dts-engine-ci --network host --memory 1536m --cpus 2 -e DTS_RUNTIME_PORT=18885 -e DTS_ENGINE_USER=ci-dts -e DTS_ENGINE_PASSWORD=ci-disposable-engine-password-20261117 "$DTS_RUNTIME_IMAGE" >/dev/null
ready=0
for attempt in $(seq 1 120); do
  if curl --fail --silent --user ci-dts:ci-disposable-engine-password-20261117 http://127.0.0.1:18885/overview > "$DTS_SMOKE_DIR/overview.json"; then ready=1; break; fi
  if [[ "$(docker inspect -f '{{.State.Running}}' cds-dts-engine-ci)" != true ]]; then docker logs cds-dts-engine-ci > "$DTS_SMOKE_DIR/engine.log" 2>&1; echo 'Native engine exited before readiness' >&2; exit 1; fi
  sleep 2
done
if [[ "$ready" != 1 ]]; then docker logs cds-dts-engine-ci > "$DTS_SMOKE_DIR/engine.log" 2>&1; echo 'Native engine readiness budget exceeded' >&2; exit 1; fi
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync(process.env.DTS_DRILL_DIRECTORY+'/overview.json'));if(p.projectVersion!=='3.0.0'||p.cdsDtsAdapters?.['redis-shake']!=='4.7.0'||p.cdsDtsAdapters?.['rabbitmq-definitions']!=='1')process.exit(1)"
# Native readiness covers the longest startup. Check the remaining fixture services without rewriting any state.
for attempt in $(seq 1 90); do
 if docker exec cds-dts-qa-mysql-1117 mysqladmin ping --silent >/dev/null 2>&1 && docker exec cds-dts-qa-postgres-1117 pg_isready -U postgres >/dev/null 2>&1 && curl --fail --silent --user dts_qa:dts_disposable_1117 http://127.0.0.1:18893/api/overview >/dev/null; then break; fi
 sleep 2
done
pnpm exec tsx scripts/dts-native-drill.ts
DTS_DRILL_LOCAL_DOCKER=1 pnpm exec tsx scripts/dts-sql-drill.ts
DTS_DRILL_ENGINE_PORT=18885 pnpm exec tsx scripts/dts-redis-drill.ts
DTS_DRILL_ENGINE_PORT=18885 pnpm exec tsx scripts/dts-rabbitmq-drill.ts
DTS_DRILL_EXPANDED=1 DTS_DRILL_LOCAL_DOCKER=1 DTS_DRILL_ENGINE_PORT=18885 pnpm exec tsx scripts/dts-interface-drill.ts > "$DTS_SMOKE_DIR/interface-server.log" 2>&1 &
DTS_INTERFACE_PID=$!
for attempt in $(seq 1 60); do
 if rg -q 'Local DTS interface fixture ready' "$DTS_SMOKE_DIR/interface-server.log"; then break; fi
 if ! kill -0 "$DTS_INTERFACE_PID" 2>/dev/null; then echo 'Expanded API fixture failed readiness' >&2; exit 1; fi
 sleep 1
done
pnpm exec tsx scripts/dts-interface-smoke.ts
docker logs cds-dts-engine-ci > "$DTS_SMOKE_DIR/engine.log" 2>&1
if rg -q 'ci-disposable-engine-password-20261117|dts_disposable_1117' "$DTS_SMOKE_DIR/engine.log"; then echo 'Native credential escaped runtime log filter' >&2; exit 1; fi
printf 'All five native connector drills passed; evidence: %s\n' "$DTS_SMOKE_DIR"
