#!/usr/bin/env bash
# ============================================
# CDS Agent official SDK boundary smoke
# ============================================
#
# Local-only guardrail. It does not call CDS, does not deploy, and does not
# consume provider tokens. The goal is to prove the default CDS Agent code path
# remains a thin official SDK adapter instead of growing a second agent loop.
#
# Optional:
#   SMOKE_CDS_AGENT_BOUNDARY_REPORT=/tmp/boundary.json
# ============================================

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAIN_FILE="$ROOT_DIR/claude-sdk-sidecar/app/main.py"
OFFICIAL_FILE="$ROOT_DIR/claude-sdk-sidecar/app/official_agent_sdk.py"
LEGACY_FILE="$ROOT_DIR/claude-sdk-sidecar/app/agent_loop.py"
REQ_FILE="$ROOT_DIR/claude-sdk-sidecar/requirements.txt"
REPORT="${SMOKE_CDS_AGENT_BOUNDARY_REPORT:-}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
OFFICIAL_ADAPTER_MAX_LINES="${SMOKE_CDS_AGENT_OFFICIAL_ADAPTER_MAX_LINES:-380}"
ROUTING_TEST="claude-sdk-sidecar/tests/test_sidecar_readiness.py"
ROUTING_TEST_LOG=""

failures=()

if ! [[ "$OFFICIAL_ADAPTER_MAX_LINES" =~ ^[0-9]+$ ]]; then
  printf 'Invalid SMOKE_CDS_AGENT_OFFICIAL_ADAPTER_MAX_LINES: %s\n' "$OFFICIAL_ADAPTER_MAX_LINES" >&2
  exit 2
fi

require_contains() {
  local file="$1"
  local needle="$2"
  local label="$3"
  if ! grep -Fq "$needle" "$file"; then
    failures+=("$label")
  fi
}

require_not_contains() {
  local file="$1"
  local needle="$2"
  local label="$3"
  if grep -Fq "$needle" "$file"; then
    failures+=("$label")
  fi
}

line_count() {
  awk 'END { print NR }' "$1"
}

official_lines=$(line_count "$OFFICIAL_FILE")
legacy_lines=$(line_count "$LEGACY_FILE")
routing_test_status="pass"

require_contains "$MAIN_FILE" 'DEFAULT_AGENT_ADAPTER = os.environ.get("SIDECAR_AGENT_ADAPTER", "claude-agent-sdk").strip()' \
  "sidecar default adapter must remain claude-agent-sdk"
require_contains "$MAIN_FILE" 'return "legacy-sidecar"' \
  "legacy fallback route should stay explicit"
require_contains "$OFFICIAL_FILE" 'from claude_agent_sdk import' \
  "official adapter must import claude_agent_sdk"
require_contains "$OFFICIAL_FILE" 'ClaudeSDKClient' \
  "official adapter must use ClaudeSDKClient"
require_contains "$OFFICIAL_FILE" 'ClaudeAgentOptions' \
  "official adapter must use ClaudeAgentOptions"
require_contains "$OFFICIAL_FILE" 'create_sdk_mcp_server' \
  "MAP tools must be exposed through SDK MCP server"
require_contains "$OFFICIAL_FILE" 'can_use_tool' \
  "MAP approval must bridge through SDK permission callback"
require_contains "$OFFICIAL_FILE" 'await client.query(' \
  "official adapter must delegate turn execution through ClaudeSDKClient.query"
require_contains "$OFFICIAL_FILE" 'async for message in client.receive_response():' \
  "official adapter must consume the official SDK response stream"
require_contains "$OFFICIAL_FILE" '"loopOwner": "claude-agent-sdk"' \
  "runtime_init must report official loop owner"
require_contains "$OFFICIAL_FILE" '"sdkLoopEnabled": True' \
  "runtime_init must report SDK loop enabled"
require_contains "$REQ_FILE" 'claude-agent-sdk' \
  "sidecar requirements must include official claude-agent-sdk"

require_not_contains "$OFFICIAL_FILE" 'from anthropic import' \
  "official adapter must not use raw anthropic client loop"
require_not_contains "$OFFICIAL_FILE" 'AsyncAnthropic' \
  "official adapter must not use AsyncAnthropic"
require_not_contains "$OFFICIAL_FILE" 'client.messages.stream' \
  "official adapter must not rebuild Anthropic message streaming"
require_not_contains "$OFFICIAL_FILE" 'chat/completions' \
  "official adapter must not rebuild OpenAI-compatible chat loop"
require_not_contains "$OFFICIAL_FILE" 'run_agent' \
  "official adapter must not call the legacy sidecar loop"

if (( official_lines > OFFICIAL_ADAPTER_MAX_LINES )); then
  failures+=("official adapter should stay thin: ${official_lines} lines exceeds budget ${OFFICIAL_ADAPTER_MAX_LINES}; split MAP/CDS bridge helpers before growing a second loop")
fi

ROUTING_TEST_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cds-agent-boundary-routing.XXXXXX")"
ROUTING_TEST_LOG="$ROUTING_TEST_TMP_DIR/unittest.log"
if ! (cd "$ROOT_DIR" && "$PYTHON_BIN" -m unittest "$ROUTING_TEST") >"$ROUTING_TEST_LOG" 2>&1; then
  routing_test_status="failed"
  failures+=("sidecar routing unit tests must prove default official adapter and explicit legacy fallback")
fi

status="pass"
if (( ${#failures[@]} > 0 )); then
  status="failed"
fi

if [[ -n "$REPORT" ]]; then
  mkdir -p "$(dirname "$REPORT")"
  failures_json='[]'
  if (( ${#failures[@]} > 0 )); then
    failures_json=$(printf '%s\n' "${failures[@]}" | jq -R . | jq -s .)
  fi
  jq -n \
    --arg status "$status" \
    --arg mainFile "claude-sdk-sidecar/app/main.py" \
    --arg officialFile "claude-sdk-sidecar/app/official_agent_sdk.py" \
    --arg legacyFile "claude-sdk-sidecar/app/agent_loop.py" \
    --arg routingTest "$ROUTING_TEST" \
    --arg routingTestStatus "$routing_test_status" \
    --argjson officialLines "$official_lines" \
    --argjson legacyLines "$legacy_lines" \
    --argjson officialMaxLines "$OFFICIAL_ADAPTER_MAX_LINES" \
    --argjson failures "$failures_json" \
    '{
      status: $status,
      defaultAdapter: "claude-agent-sdk",
      legacyFallback: "explicit-only",
      officialLoopOwnerEvidence: {
        mainFile: $mainFile,
        officialFile: $officialFile,
        legacyFile: $legacyFile,
        officialAdapterLines: $officialLines,
        legacyLoopLines: $legacyLines,
        officialAdapterMaxLines: $officialMaxLines,
        officialAdapterWithinBudget: ($officialLines <= $officialMaxLines)
      },
      executableEvidence: {
        routingTest: $routingTest,
        routingTestStatus: $routingTestStatus
      },
      assertionsFailed: $failures
    }' > "$REPORT"
fi

printf 'Official SDK boundary: %s\n' "$status"
printf 'Official adapter lines: %s/%s\n' "$official_lines" "$OFFICIAL_ADAPTER_MAX_LINES"
printf 'Legacy loop lines: %s\n' "$legacy_lines"
printf 'Routing unit test: %s (%s)\n' "$routing_test_status" "$ROUTING_TEST"
if (( ${#failures[@]} > 0 )); then
  printf 'Boundary failures:\n' >&2
  for failure in "${failures[@]}"; do
    printf '  - %s\n' "$failure" >&2
  done
  if [[ -s "$ROUTING_TEST_LOG" ]]; then
    printf '\nRouting unit test log:\n' >&2
    cat "$ROUTING_TEST_LOG" >&2
  fi
  exit 1
fi
