#!/usr/bin/env bash
# Smoke: CDS Agent managed-runtime capacity gate.
#
# This is local/read-only. It verifies that the product-facing blocker is
# CDS_MANAGED_RUNTIME_CAPACITY and that remote host/env/image remain legacy
# operator fallback evidence.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROGRESS_OUTPUT="${CDS_AGENT_R0_PROGRESS_OUTPUT:-/tmp/cds-agent-current-progress-current.md}"
AUDIT_REPORT="${CDS_AGENT_CAPACITY_AUDIT_REPORT:-/tmp/cds-agent-capacity-audit-current.json}"
AUDIT_LOG="${CDS_AGENT_CAPACITY_AUDIT_LOG:-/tmp/cds-agent-capacity-audit-current.log}"
RUNTIME_POOL_SUMMARY="${CDS_AGENT_GOAL_RUNTIME_POOL_SUMMARY:-/tmp/cds-agent-runtime-pool-evidence-latest/summary.json}"

fail() {
  printf 'CDS Agent managed-runtime capacity smoke: FAIL - %s\n' "$*" >&2
  exit 1
}

require_file() {
  local file="$1"
  [[ -f "$file" ]] || fail "missing file: $file"
}

require_contains() {
  local file="$1"
  local needle="$2"
  local label="$3"
  grep -Fq "$needle" "$file" || fail "$label missing: $needle"
  printf 'ok - %s\n' "$label"
}

require_not_contains() {
  local file="$1"
  local needle="$2"
  local label="$3"
  if grep -Fq "$needle" "$file"; then
    fail "$label must not contain: $needle"
  fi
  printf 'ok - %s\n' "$label"
}

printf 'CDS Agent managed-runtime capacity smoke\n'

cd "$ROOT_DIR"

bash scripts/check-cds-agent-progress-consistency.sh >/dev/null
require_file "$PROGRESS_OUTPUT"
require_contains "$PROGRESS_OUTPUT" 'R0 managed runtime capacity: sharedRunning=' 'progress exposes managed runtime capacity'
require_contains "$PROGRESS_OUTPUT" '| R0.5 CDS-managed runtime capacity contract | done_minimal |' 'progress task board has R0.5 contract'
require_contains "$PROGRESS_OUTPUT" '| R0.6 CDS-managed runtime capacity reconciler | done_minimal |' 'progress task board has R0.6 reconciler'
require_contains "$PROGRESS_OUTPUT" '| R0.7 CDS-managed runtime live apply | in_progress |' 'progress task board has R0.7 live apply'
require_contains "$PROGRESS_OUTPUT" 'Operator fallback remote host verdict:' 'progress demotes remote host to fallback'
require_not_contains "$PROGRESS_OUTPUT" 'R0 remote host verdict:' 'progress does not promote remote host as product gate'

set +e
CDS_AGENT_GOAL_AUDIT_LIVE=0 \
CDS_AGENT_GOAL_AUDIT_REPORT="$AUDIT_REPORT" \
CDS_AGENT_GOAL_RUNTIME_POOL_SUMMARY="$RUNTIME_POOL_SUMMARY" \
  bash scripts/audit-cds-agent-goal.sh >"$AUDIT_LOG" 2>&1
audit_rc=$?
set -e

if [[ "$audit_rc" -eq 0 ]]; then
  fail "goal audit unexpectedly completed; R0.7 should remain blocked until runtime capacity exists"
fi

require_contains "$AUDIT_LOG" 'CDS-managed runtime live apply has not produced running official SDK runtime' 'audit blocks on live apply'
require_contains "$AUDIT_LOG" 'Next cycle plan: r0-cds-managed-runtime-live-apply state=cds-managed-runtime-live-capacity-missing items=D1,R0.3,R0.4,R0V,R0.5,R0.6,R0.7' 'audit next cycle is R0.7 live apply'
require_contains "$AUDIT_LOG" 'Legacy fallback blockers (not product path):' 'audit keeps fallback blockers separate'
require_not_contains "$AUDIT_LOG" 'R0V managed-runtime post-check is not complete' 'audit no longer blocks on old R0V wording'
require_not_contains "$AUDIT_LOG" 'r0-managed-runtime-postcheck' 'audit no longer uses old R0V cycle'

require_contains "$ROOT_DIR/prd-api/src/PrdAgent.Api/Controllers/Api/InfraAgentSessionsController.cs" 'CDS_MANAGED_RUNTIME_CAPACITY=missing' 'runtime-status exposes capacity blocker'
require_contains "$ROOT_DIR/prd-api/src/PrdAgent.Api/Controllers/Api/InfraAgentSessionsController.cs" 'smoke-cds-agent-managed-runtime-capacity.sh' 'runtime-status points to capacity smoke'
require_contains "$ROOT_DIR/cds/src/routes/remote-hosts.ts" '/projects/:id/runtime-capacity' 'CDS exposes runtime capacity endpoint'
require_contains "$ROOT_DIR/cds/src/routes/remote-hosts.ts" '/projects/:id/runtime-capacity/reconcile' 'CDS exposes runtime capacity reconciler'
require_contains "$ROOT_DIR/cds/src/routes/remote-hosts.ts" 'liveApply' 'CDS reconciler exposes live apply path'
require_contains "$ROOT_DIR/cds/src/routes/remote-hosts.ts" 'containerService.runService' 'CDS reconciler uses CDS container service'
require_contains "$ROOT_DIR/cds/src/routes/remote-hosts.ts" 'productPathOnly: true' 'CDS reconciler stays on product runtime path'
require_contains "$ROOT_DIR/cds/src/routes/remote-hosts.ts" "requirement: 'CDS_MANAGED_RUNTIME_CAPACITY'" 'CDS capacity contract names product gate'
require_contains "$ROOT_DIR/cds/src/routes/remote-hosts.ts" "capacityRole: 'operator-fallback'" 'CDS separates operator fallback capacity'
require_contains "$ROOT_DIR/cds/tests/routes/remote-hosts-instances.test.ts" 'exposes CDS-managed runtime capacity as product gate separate from fallback hosts' 'CDS route test covers capacity contract'
require_contains "$ROOT_DIR/cds/tests/routes/remote-hosts-instances.test.ts" 'reconciles CDS-managed official SDK runtime capacity without remote host fallback' 'CDS route test covers capacity reconciler'
require_contains "$ROOT_DIR/cds/tests/routes/remote-hosts-instances.test.ts" 'live-applies CDS-managed official SDK runtime through the injected CDS container service' 'CDS route test covers live apply path'
require_contains "$ROOT_DIR/scripts/run-cds-agent-remote-host-pool-with-evidence.sh" 'do not ask product users for remote host variables' 'remote host wrapper is fallback-only'
require_contains "$ROOT_DIR/scripts/collect-cds-agent-runtime-pool-evidence.sh" 'CDS-managed runtime capacity is absent in live evidence' 'runtime pool evidence names capacity'

printf 'CDS Agent managed-runtime capacity smoke: pass\n'
