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
SDK_TOOLING_FILE="$ROOT_DIR/claude-sdk-sidecar/app/sdk_tooling.py"
UPSTREAM_FILE="$ROOT_DIR/claude-sdk-sidecar/app/upstream.py"
SDK_EVENTS_FILE="$ROOT_DIR/claude-sdk-sidecar/app/sdk_events.py"
WORKSPACE_FILE="$ROOT_DIR/claude-sdk-sidecar/app/workspace.py"
LEGACY_FILE="$ROOT_DIR/claude-sdk-sidecar/app/agent_loop.py"
REQ_FILE="$ROOT_DIR/claude-sdk-sidecar/requirements.txt"
REPORT="${SMOKE_CDS_AGENT_BOUNDARY_REPORT:-}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
OFFICIAL_ADAPTER_MAX_LINES="${SMOKE_CDS_AGENT_OFFICIAL_ADAPTER_MAX_LINES:-320}"
ROUTING_TEST="claude-sdk-sidecar/tests/test_sidecar_readiness.py"
ROUTING_TEST_LOG=""

failures=()
SUPPORT_FILES=("$SDK_TOOLING_FILE" "$UPSTREAM_FILE" "$SDK_EVENTS_FILE" "$WORKSPACE_FILE")
BOUNDARY_FILES=("$OFFICIAL_FILE" "${SUPPORT_FILES[@]}")

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
support_lines_json=$(
  for file in "${SUPPORT_FILES[@]}"; do
    rel="${file#$ROOT_DIR/}"
    lines=$(line_count "$file")
    jq -n --arg file "$rel" --argjson lines "$lines" '{file:$file,lines:$lines}'
  done | jq -s .
)
support_total_lines=$(jq -r '[.[].lines] | add // 0' <<< "$support_lines_json")
bridge_total_lines=$((official_lines + support_total_lines))
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
require_contains "$SDK_TOOLING_FILE" 'create_sdk_mcp_server' \
  "MAP SDK tooling helper must own SDK MCP server construction"
require_contains "$SDK_TOOLING_FILE" 'can_use_tool' \
  "MAP SDK tooling helper must own SDK permission callback"
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

for file in "${BOUNDARY_FILES[@]}"; do
  rel="${file#$ROOT_DIR/}"
  require_not_contains "$file" 'from anthropic import' \
    "$rel must not use raw anthropic client loop"
  require_not_contains "$file" 'AsyncAnthropic' \
    "$rel must not use AsyncAnthropic"
  require_not_contains "$file" 'client.messages.stream' \
    "$rel must not rebuild Anthropic message streaming"
  require_not_contains "$file" 'chat/completions' \
    "$rel must not rebuild OpenAI-compatible chat loop"
  require_not_contains "$file" 'run_agent' \
    "$rel must not call the legacy sidecar loop"
done

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
    --argjson supportLines "$support_lines_json" \
    --argjson supportTotalLines "$support_total_lines" \
    --argjson bridgeTotalLines "$bridge_total_lines" \
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
        bridgeSupportFiles: $supportLines,
        bridgeSupportLines: $supportTotalLines,
        bridgeTotalLines: $bridgeTotalLines,
        legacyLoopLines: $legacyLines,
        officialAdapterMaxLines: $officialMaxLines,
        officialAdapterWithinBudget: ($officialLines <= $officialMaxLines),
        boundaryFilesScannedForLoopRegression: ([$officialFile] + ($supportLines | map(.file)))
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
printf 'Bridge support lines: %s\n' "$support_total_lines"
printf 'Bridge total lines: %s\n' "$bridge_total_lines"
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
