#!/usr/bin/env bash
set -euo pipefail

# Production governance acceptance. Default is dry-run. Execute only on the
# production host after the target commit is deployed:
#   LLMGW_GOVERNANCE_ACCEPTANCE_EXECUTE=1 \
#     bash scripts/llmgw-prod-governance-acceptance.sh
#
# The runtime calls use a temporary host-local OpenAI-compatible fake upstream,
# so budget and concurrency checks never call a paid provider.

execute="${LLMGW_GOVERNANCE_ACCEPTANCE_EXECUTE:-0}"
root="${LLMGW_GOVERNANCE_ACCEPTANCE_ROOT:-https://map.ebcone.net}"
console_base="${LLMGW_CONSOLE_API_BASE:-$root/gw}"
env_file="${LLMGW_ENV_FILE:-.env}"
mongo_container="${LLMGW_MONGO_CONTAINER:-prdagent-mongodb}"
primary_container="${LLMGW_SERVE_PRIMARY_CONTAINER:-prdagent-llmgw-serve}"
fake_port="${LLMGW_GOVERNANCE_ACCEPTANCE_FAKE_PORT:-18999}"
temp_caller="llmgw-acceptance.governance::chat"
temp_platform="llmgw-acceptance-platform"
temp_model_id="llmgw-acceptance-model"
temp_model_name="llmgw-acceptance-fake"
temp_pool="llmgw-acceptance-pool"

if [[ "$execute" != "1" ]]; then
  cat <<EOF
LLM Gateway production governance acceptance dry-run
- root: $root
- temporary caller: $temp_caller
- tenant: resolved from the authenticated console session
- checks: scoped key allow/deny/revoke, budget reservation, provider concurrency, lifecycle dry-run, serving failover
- paid upstream calls: 0 (host-local fake upstream)
- database changes: tenant-scoped temporary records only; cleanup trap removes all records
Set LLMGW_GOVERNANCE_ACCEPTANCE_EXECUTE=1 to execute.
EOF
  exit 0
fi

for command in docker curl python3; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "missing command: $command" >&2
    exit 1
  }
done
[[ -f "$env_file" ]] || {
  echo "env file not found: $env_file" >&2
  exit 1
}

set -a
# shellcheck disable=SC1090
source "$env_file"
set +a
export LLMGW_CONSOLE_PASSWORD="${LLMGW_CONSOLE_PASSWORD:-${LLMGW_ADMIN_PASSWORD:-}}"

tmp_dir="$(mktemp -d /tmp/llmgw-governance-acceptance.XXXXXX)"
fake_pid=""
token=""
tenant_id=""
key_id=""
scoped_key=""
primary_stopped=0

cleanup_database() {
  [[ -n "$tenant_id" ]] || return 0
  docker exec "$mongo_container" mongosh --quiet llm_gateway --eval "
    const tenantId = '$tenant_id';
    const caller = "llmgw-acceptance.governance::chat";
    db.llmgw_app_callers.deleteMany({ TenantId: tenantId, AppCallerCode: caller });
    db.llmgw_model_pools.deleteMany({ TenantId: tenantId, _id: "llmgw-acceptance-pool" });
    db.llmgw_models.deleteMany({ TenantId: tenantId, _id: "llmgw-acceptance-model" });
    db.llmgw_platforms.deleteMany({ TenantId: tenantId, _id: "llmgw-acceptance-platform" });
    db.llmgw_budget_reservations.deleteMany({ TenantId: tenantId, AppCallerCode: caller });
    db.llmgw_budget_months.deleteMany({ TenantId: tenantId, AppCallerCode: caller });
    db.llmgw_provider_concurrency_slots.deleteMany({ TenantId: tenantId, ResourceKey: /llmgw-acceptance/ });
    db.llmgw_service_keys.deleteMany({ TenantId: tenantId, Name: "governance-acceptance-temporary" });
    db.llmrequestlogs.deleteMany({ TenantId: tenantId, AppCallerCode: caller });
    db.llmshadow_comparisons.deleteMany({ TenantId: tenantId, AppCallerCode: caller });
  " >/dev/null 2>&1 || true
}

cleanup() {
  if [[ "$primary_stopped" == "1" ]]; then
    docker start "$primary_container" >/dev/null 2>&1 || true
  fi
  if [[ -n "$token" && -n "$key_id" ]]; then
    curl -sS -o /dev/null -X DELETE \
      -H "Authorization: Bearer $token" \
      "$console_base/service-keys/$key_id" || true
  fi
  [[ -n "$fake_pid" ]] && kill "$fake_pid" >/dev/null 2>&1 || true
  cleanup_database
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

network="$(docker inspect "$primary_container" --format '{{range $name,$network := .NetworkSettings.Networks}}{{$name}} {{end}}' | awk '{print $1}')"
gateway_ip="$(docker network inspect "$network" --format '{{(index .IPAM.Config 0).Gateway}}')"
[[ -n "$gateway_ip" ]] || {
  echo "could not resolve Docker network gateway" >&2
  exit 1
}

cat >"$tmp_dir/fake_upstream.py" <<'PY'
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

lock = threading.Lock()
counter = os.environ["LLMGW_FAKE_COUNTER"]

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(length)
        with lock:
            with open(counter, "a", encoding="utf-8") as handle:
                handle.write("1\n")
        try:
            model = json.loads(body or b"{}").get("model", "llmgw-acceptance-fake")
        except Exception:
            model = "llmgw-acceptance-fake"
        time.sleep(3)
        payload = json.dumps({
            "id": "fake-governance",
            "object": "chat.completion",
            "model": model,
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": "ok"},
                "finish_reason": "stop",
            }],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_):
        return

ThreadingHTTPServer(("0.0.0.0", int(os.environ["LLMGW_FAKE_PORT"])), Handler).serve_forever()
PY

counter="$tmp_dir/upstream-count"
: >"$counter"
LLMGW_FAKE_COUNTER="$counter" LLMGW_FAKE_PORT="$fake_port" \
  python3 "$tmp_dir/fake_upstream.py" >/dev/null 2>&1 &
fake_pid=$!
sleep 1
docker exec "$primary_container" curl -fsS -o /dev/null -X POST \
  -H 'Content-Type: application/json' --data '{"model":"connectivity-probe"}' \
  "http://$gateway_ip:$fake_port/v1/chat/completions"
: >"$counter"

fake_url="http://$gateway_ip:$fake_port"
: "${LLMGW_CONSOLE_PASSWORD:?LLMGW_CONSOLE_PASSWORD or LLMGW_ADMIN_PASSWORD is required}"
login_body="$(python3 - <<'PY'
import json
import os
print(json.dumps({
    "username": os.environ.get("LLMGW_CONSOLE_USERNAME", "admin"),
    "password": os.environ["LLMGW_CONSOLE_PASSWORD"],
}))
PY
)"
login_response="$(curl -fsS -X POST -H 'Content-Type: application/json' \
  --data "$login_body" "$console_base/auth/login")"
token="$(printf '%s' "$login_response" | python3 -c '
import json, sys
payload = json.load(sys.stdin)
if payload.get("success") is not True:
    raise SystemExit("console login failed")
print(payload["data"]["token"])
')"
tenant_id="$(curl -fsS -H "Authorization: Bearer $token" "$console_base/auth/context" | python3 -c '
import json, sys
payload = json.load(sys.stdin)
if payload.get("success") is not True:
    raise SystemExit("tenant context failed")
print(payload["data"]["id"])
')"
[[ -n "$tenant_id" ]] || {
  echo "console token did not resolve a tenant" >&2
  exit 1
}

docker exec "$mongo_container" mongosh --quiet llm_gateway --eval "
  const now = new Date();
  const tenantId = '$tenant_id';
  const sourceCaller = db.llmgw_app_callers.findOne({ TenantId: tenantId, AppCallerCode: 'report-agent.generate::chat', RequestType: 'chat' });
  if (!sourceCaller || !sourceCaller.ModelPoolId) throw new Error('source appCaller pool missing');
  const sourcePool = db.llmgw_model_pools.findOne({ TenantId: tenantId, _id: sourceCaller.ModelPoolId });
  if (!sourcePool) throw new Error('source model pool missing');
  let sourceModel = null;
  let sourcePlatform = null;
  let sourceEntry = null;
  for (const entry of sourcePool.Models || []) {
    const model = db.llmgw_models.findOne({ TenantId: tenantId, PlatformId: entry.PlatformId, ModelName: entry.ModelId })
      || db.llmgw_models.findOne({ TenantId: tenantId, _id: entry.ModelId });
    const platform = model && db.llmgw_platforms.findOne({ TenantId: tenantId, _id: model.PlatformId, Enabled: true });
    if (model && platform) { sourceModel = model; sourcePlatform = platform; sourceEntry = entry; break; }
  }
  if (!sourceModel || !sourcePlatform || !sourceEntry) throw new Error('source model/platform missing');
  db.llmgw_platforms.insertOne({ ...sourcePlatform,
    _id: '$temp_platform', TenantId: tenantId, Name: 'LLMGW acceptance fake', ApiUrl: '$fake_url',
    PlatformType: 'openai', MaxConcurrency: 1, CreatedAt: now, UpdatedAt: now });
  db.llmgw_models.insertOne({ ...sourceModel,
    _id: '$temp_model_id', TenantId: tenantId, PlatformId: '$temp_platform', ModelName: '$temp_model_name',
    Name: 'LLMGW acceptance fake', ApiUrl: '$fake_url', Protocol: 'openai', MaxConcurrency: 1,
    MaxRetries: 0, Timeout: 15000, CreatedAt: now, UpdatedAt: now });
  db.llmgw_model_pools.insertOne({ ...sourcePool,
    _id: '$temp_pool', TenantId: tenantId, Code: '$temp_pool', Name: 'LLMGW acceptance pool',
    Models: [{ ModelId: '$temp_model_name', PlatformId: '$temp_platform', Protocol: 'openai', Priority: 1,
      HealthStatus: 0, ConsecutiveFailures: 0, ConsecutiveSuccesses: 0 }],
    IsDefaultForType: false, CreatedAt: now, UpdatedAt: now });
  db.llmgw_app_callers.insertOne({
    _id: 'llmgw-acceptance-caller', TenantId: tenantId, AppCallerCode: '$temp_caller',
    Title: 'LLMGW governance acceptance', RequestType: 'chat', SourceSystem: 'map',
    Status: 'configured', ModelPolicy: 'pool', ModelPoolId: '$temp_pool',
    ParameterPolicy: 'default-drop', MonthlyBudgetUsd: NumberDecimal('0.01'),
    BudgetReservationUsd: NumberDecimal('0.01'), TotalSeen: 0,
    ObservedIngressProtocols: ['gw-native'], CreatedAt: now, UpdatedAt: now,
    FirstSeenAt: now, LastSeenAt: now });
" >/dev/null

key_body="$(python3 - <<'PY'
import datetime
import json
print(json.dumps({
    "name": "governance-acceptance-temporary",
    "sourceSystem": "map",
    "appCallerCodes": ["llmgw-acceptance.governance::chat"],
    "ingressProtocols": ["gw-native"],
    "scopes": ["invoke", "route:read"],
    "expiresAt": (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=15)).isoformat(),
}))
PY
)"
created="$(curl -fsS -X POST -H "Authorization: Bearer $token" \
  -H 'Content-Type: application/json' --data "$key_body" "$console_base/service-keys")"
mapfile -t key_pair < <(printf '%s' "$created" | python3 -c '
import json, sys
data = json.load(sys.stdin).get("data", {})
print(data["id"])
print(data["key"])
')
key_id="${key_pair[0]}"
scoped_key="${key_pair[1]}"

status_for() {
  curl -sS -o /dev/null -w '%{http_code}' "$@"
}

allowed_scope="$(status_for -H "X-Gateway-Key: $scoped_key" \
  -H 'X-Gateway-Source: map' -H "X-Gateway-App-Caller: $temp_caller" \
  "$root/gw/v1/route-self-test")"
denied_scope="$(status_for -H "X-Gateway-Key: $scoped_key" \
  -H 'X-Gateway-Source: map' -H "X-Gateway-App-Caller: $temp_caller" \
  "$root/gw/v1/readyz")"
[[ "$allowed_scope" == "200" && "$denied_scope" == "403" ]] || {
  echo "scoped key acceptance failed: allow=$allowed_scope deny=$denied_scope" >&2
  exit 1
}

invoke() {
  local request_id="$1" output="$2" status_file="$3"
  curl -sS -o "$output" -w '%{http_code}' \
    -H "X-Gateway-Key: $scoped_key" -H 'X-Gateway-Source: map' \
    -H "X-Gateway-App-Caller: $temp_caller" -H 'Content-Type: application/json' \
    --data "{\"AppCallerCode\":\"$temp_caller\",\"ModelType\":\"chat\",\"Stream\":false,\"RequestBody\":{\"messages\":[{\"role\":\"user\",\"content\":\"governance acceptance\"}],\"max_tokens\":1},\"Context\":{\"RequestId\":\"$request_id\",\"SourceSystem\":\"map\"}}" \
    "$root/gw/v1/invoke" >"$status_file"
}

run_pair() {
  local prefix="$1"
  invoke "$prefix-a" "$tmp_dir/$prefix-a.json" "$tmp_dir/$prefix-a.code" &
  local first=$!
  sleep 0.4
  invoke "$prefix-b" "$tmp_dir/$prefix-b.json" "$tmp_dir/$prefix-b.code" &
  local second=$!
  wait "$first" "$second"
  python3 - "$tmp_dir" "$prefix" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
prefix = sys.argv[2]
rows = []
for suffix in ("a", "b"):
    stem = root / f"{prefix}-{suffix}"
    status = stem.with_suffix(".code").read_text().strip()
    payload = json.loads(stem.with_suffix(".json").read_text())
    error = payload.get("error") or {}
    error_code = error.get("code", "") if isinstance(error, dict) else ""
    error_code = error_code or payload.get("ErrorCode", "") or payload.get("errorCode", "")
    success = payload.get("Success", payload.get("success", False))
    rows.append((status, bool(success), error_code))
print(json.dumps(rows, separators=(",", ":")))
PY
}

budget_rows="$(run_pair budget)"
budget_calls="$(wc -l <"$counter" | tr -d ' ')"
python3 - "$budget_rows" "$budget_calls" <<'PY'
import json, sys
rows = json.loads(sys.argv[1])
calls = int(sys.argv[2])
successes = sum(1 for status, success, _ in rows if status == "200" and success)
rejections = sum(1 for status, _, code in rows if status == "429" and code == "APP_CALLER_MONTHLY_BUDGET_EXCEEDED")
if successes != 1 or rejections != 1 or calls != 1:
    raise SystemExit(f"budget acceptance failed rows={rows} upstreamCalls={calls}")
print("budget_atomic_reservation=pass")
PY

docker exec "$mongo_container" mongosh --quiet llm_gateway --eval "
  const tenantId = '$tenant_id';
  const caller = "llmgw-acceptance.governance::chat";
  db.llmgw_app_callers.updateOne({ TenantId: tenantId, AppCallerCode: caller },
    { \$unset: { MonthlyBudgetUsd: "", BudgetReservationUsd: "" } });
  db.llmgw_budget_reservations.deleteMany({ TenantId: tenantId, AppCallerCode: caller });
  db.llmgw_budget_months.deleteMany({ TenantId: tenantId, AppCallerCode: caller });
" >/dev/null
: >"$counter"

concurrency_rows="$(run_pair concurrency)"
concurrency_calls="$(wc -l <"$counter" | tr -d ' ')"
active_leases="$(docker exec "$mongo_container" mongosh --quiet llm_gateway --eval "
  const tenantId = '$tenant_id';
  print(db.llmgw_provider_concurrency_slots.countDocuments({
    TenantId: tenantId,
    ResourceKey: /llmgw-acceptance/,
    LeaseId: { \$nin: ["", null] }, ExpiresAt: { \$gt: new Date() }
  }))
")"
python3 - "$concurrency_rows" "$concurrency_calls" "$active_leases" <<'PY'
import json, sys
rows = json.loads(sys.argv[1])
calls = int(sys.argv[2])
active = int(sys.argv[3])
successes = sum(1 for status, success, _ in rows if status == "200" and success)
rejections = sum(1 for status, _, code in rows if status == "429" and code == "PROVIDER_CONCURRENCY_EXHAUSTED")
if successes != 1 or rejections != 1 or calls != 1 or active != 0:
    raise SystemExit(f"concurrency acceptance failed rows={rows} upstreamCalls={calls} activeLeases={active}")
print("provider_concurrency=pass")
PY

lifecycle_line="$(docker logs --since 24h "$primary_container" 2>&1 \
  | grep '\[GatewayLifecycle\]' | tail -1 || true)"
[[ "$lifecycle_line" == *"mode=dry-run"* ]] || {
  echo "lifecycle dry-run evidence missing" >&2
  exit 1
}
echo "lifecycle_dry_run=pass"

docker stop -t 20 "$primary_container" >/dev/null
primary_stopped=1
sleep 3
failover_status="$(status_for -H "X-Gateway-Key: $scoped_key" \
  -H 'X-Gateway-Source: map' -H "X-Gateway-App-Caller: $temp_caller" \
  "$root/gw/v1/route-self-test")"
[[ "$failover_status" == "200" ]] || {
  echo "serving failover failed: status=$failover_status" >&2
  exit 1
}
docker start "$primary_container" >/dev/null
primary_stopped=0
for _ in $(seq 1 30); do
  state="$(docker inspect "$primary_container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')"
  [[ "$state" == "healthy" ]] && break
  sleep 2
done
[[ "$state" == "healthy" ]] || {
  echo "primary serving did not recover: $state" >&2
  exit 1
}
echo "serving_failover=pass"

revoke_status="$(status_for -X DELETE -H "Authorization: Bearer $token" \
  "$console_base/service-keys/$key_id")"
[[ "$revoke_status" == "200" ]] || {
  echo "service key revoke failed: status=$revoke_status" >&2
  exit 1
}
revoked_status="$(status_for -H "X-Gateway-Key: $scoped_key" \
  -H 'X-Gateway-Source: map' -H "X-Gateway-App-Caller: $temp_caller" \
  "$root/gw/v1/route-self-test")"
[[ "$revoked_status" == "401" ]] || {
  echo "revoked service key was not rejected: status=$revoked_status" >&2
  exit 1
}
key_id=""
echo "scoped_service_key=pass"

cleanup_database
echo "temporary_data_cleanup=pass"
echo "LLM Gateway production governance acceptance: PASS"
