#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION_SERVICE="$ROOT_DIR/prd-api/src/PrdAgent.Infrastructure/Services/InfraAgentSessions/InfraAgentSessionService.cs"
TOOLBOX_ADAPTER="$ROOT_DIR/prd-api/src/PrdAgent.Api/Services/Toolbox/Adapters/CdsAgentAdapter.cs"
COMPAT_TEST="$ROOT_DIR/prd-api/tests/PrdAgent.Api.Tests/Services/CdsAgentRuntimeCompatibilityTests.cs"

fail() {
  printf 'CDS Agent MAP session transport smoke: FAIL - %s\n' "$1" >&2
  exit 1
}

ok() {
  printf 'ok - %s\n' "$1"
}

require_contains() {
  local file="$1"
  local needle="$2"
  local label="$3"
  if ! grep -Fq "$needle" "$file"; then
    fail "$label missing: $needle"
  fi
  ok "$label"
}

require_not_contains() {
  local file="$1"
  local needle="$2"
  local label="$3"
  if grep -Fq "$needle" "$file"; then
    fail "$label still contains: $needle"
  fi
  ok "$label"
}

printf 'CDS Agent MAP session transport smoke\n'

require_contains "$SESSION_SERVICE" 'SendCdsJsonAsync(' 'MAP sends through CDS HTTP session API'
require_contains "$SESSION_SERVICE" '/agent-sessions/{Uri.EscapeDataString(session.CdsSessionId!)}/messages' 'MAP message path targets CDS agent session'
require_contains "$SESSION_SERVICE" 'ImportCdsStreamEventsAsync(connection, token, session, 0, ct)' 'MAP imports CDS-owned runtime events'
require_contains "$SESSION_SERVICE" 'message dispatched through CDS session transport; MAP direct runtime queue skipped' 'MAP records direct runtime queue skip'
require_contains "$SESSION_SERVICE" 'INFRA_AGENT_ENABLE_MAP_DIRECT_RUNTIME_FALLBACK' 'direct runtime fallback requires explicit env'
require_contains "$SESSION_SERVICE" 'MAP direct runtime job skipped; CDS session transport owns execution' 'runtime worker is guarded by CDS-owned transport'
require_not_contains "$SESSION_SERVICE" 'message = "runtime job queued"' 'default product path must not queue MAP direct runtime job'

if grep -Fq 'await _runtimeJobs.EnqueueAsync' "$SESSION_SERVICE"; then
  if ! grep -Fq 'if (IsMapDirectRuntimeFallbackEnabled())' "$SESSION_SERVICE"; then
    fail 'runtime job enqueue exists without explicit fallback gate'
  fi
fi
ok 'runtime enqueue is gated behind explicit fallback'

require_not_contains "$TOOLBOX_ADAPTER" 'IInfraAgentRuntimeAdapter' 'Toolbox CDS adapter must not inject direct runtime adapter'
require_not_contains "$TOOLBOX_ADAPTER" 'runtime pool 不可用，已阻止 Toolbox 委托' 'Toolbox must not block CDS session delegation on MAP sidecar pool'
require_contains "$TOOLBOX_ADAPTER" 'StartAsync(' 'Toolbox starts CDS session via session service'
require_contains "$TOOLBOX_ADAPTER" 'SendMessageAsync(' 'Toolbox sends work through CDS session service'

require_contains "$COMPAT_TEST" 'ToolboxAdapters_ShouldNotDependOnInfraRuntimeAdapter' 'compatibility test guards toolbox runtime dependency'
require_contains "$COMPAT_TEST" 'ToolboxAdapters_ShouldNotOwnRuntimeAdapterConstructorDependency' 'compatibility test guards constructor injection'

printf 'CDS Agent MAP session transport smoke: pass\n'
