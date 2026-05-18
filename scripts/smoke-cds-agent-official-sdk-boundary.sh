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
PYTHON_BIN="${PYTHON_BIN:-}"
OFFICIAL_ADAPTER_MAX_LINES="${SMOKE_CDS_AGENT_OFFICIAL_ADAPTER_MAX_LINES:-320}"
BRIDGE_SUPPORT_MAX_LINES="${SMOKE_CDS_AGENT_BRIDGE_SUPPORT_MAX_LINES:-650}"
BRIDGE_TOTAL_MAX_LINES="${SMOKE_CDS_AGENT_BRIDGE_TOTAL_MAX_LINES:-850}"
ROUTING_TEST="claude-sdk-sidecar/tests/test_sidecar_readiness.py"
ROUTING_TEST_LOG=""

failures=()
SUPPORT_FILES=("$SDK_TOOLING_FILE" "$UPSTREAM_FILE" "$SDK_EVENTS_FILE" "$WORKSPACE_FILE")
BOUNDARY_FILES=("$OFFICIAL_FILE" "${SUPPORT_FILES[@]}")
LOOP_REGRESSION_BANNED_PATTERNS=(
  'from anthropic import'
  'AsyncAnthropic'
  'from openai import'
  'import openai'
  'AsyncOpenAI'
  'OpenAI('
  'client.messages.create'
  'client.messages.stream'
  'messages.create'
  'messages.stream'
  'chat.completions'
  'chat/completions'
  'from .agent_loop import'
  'run_agent'
)

if ! [[ "$OFFICIAL_ADAPTER_MAX_LINES" =~ ^[0-9]+$ ]]; then
  printf 'Invalid SMOKE_CDS_AGENT_OFFICIAL_ADAPTER_MAX_LINES: %s\n' "$OFFICIAL_ADAPTER_MAX_LINES" >&2
  exit 2
fi
if ! [[ "$BRIDGE_SUPPORT_MAX_LINES" =~ ^[0-9]+$ ]]; then
  printf 'Invalid SMOKE_CDS_AGENT_BRIDGE_SUPPORT_MAX_LINES: %s\n' "$BRIDGE_SUPPORT_MAX_LINES" >&2
  exit 2
fi
if ! [[ "$BRIDGE_TOTAL_MAX_LINES" =~ ^[0-9]+$ ]]; then
  printf 'Invalid SMOKE_CDS_AGENT_BRIDGE_TOTAL_MAX_LINES: %s\n' "$BRIDGE_TOTAL_MAX_LINES" >&2
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

python_can_import_sidecar_deps() {
  local candidate="$1"
  [[ -n "$candidate" ]] || return 1
  command -v "$candidate" >/dev/null 2>&1 || return 1
  "$candidate" - <<'PY' >/dev/null 2>&1
import fastapi  # noqa: F401
import pydantic  # noqa: F401
import starlette  # noqa: F401
PY
}

resolve_python_bin() {
  local candidates=()
  if [[ -n "${PYTHON_BIN:-}" ]]; then
    candidates+=("$PYTHON_BIN")
  fi
  candidates+=(
    python3
    /opt/anaconda3/bin/python3
    /opt/homebrew/bin/python3
    /usr/local/bin/python3
  )

  local candidate
  for candidate in "${candidates[@]}"; do
    if python_can_import_sidecar_deps "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  printf '%s\n' "${PYTHON_BIN:-python3}"
  return 0
}

PYTHON_BIN="$(resolve_python_bin)"
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
loop_regression_patterns_json=$(printf '%s\n' "${LOOP_REGRESSION_BANNED_PATTERNS[@]}" | jq -R . | jq -s .)

require_contains "$MAIN_FILE" 'DEFAULT_AGENT_ADAPTER = os.environ.get("SIDECAR_AGENT_ADAPTER", "claude-agent-sdk").strip()' \
  "sidecar default adapter must remain claude-agent-sdk"
require_contains "$MAIN_FILE" 'LEGACY_AGENT_ADAPTER_ALIASES = {"legacy", "legacy-sidecar"}' \
  "legacy fallback must require an explicit legacy adapter alias"
require_contains "$MAIN_FILE" 'return "legacy-sidecar"' \
  "legacy fallback route should stay explicit"
require_contains "$MAIN_FILE" 'unsupported_runtime_adapter' \
  "unknown runtimeAdapter values must not silently fall back to legacy loop"
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
  for pattern in "${LOOP_REGRESSION_BANNED_PATTERNS[@]}"; do
    require_not_contains "$file" "$pattern" \
      "$rel must not contain loop-regression pattern: $pattern"
  done
done

if (( official_lines > OFFICIAL_ADAPTER_MAX_LINES )); then
  failures+=("official adapter should stay thin: ${official_lines} lines exceeds budget ${OFFICIAL_ADAPTER_MAX_LINES}; split MAP/CDS bridge helpers before growing a second loop")
fi
if (( support_total_lines > BRIDGE_SUPPORT_MAX_LINES )); then
  failures+=("official bridge helpers should stay bounded: ${support_total_lines} lines exceeds support budget ${BRIDGE_SUPPORT_MAX_LINES}; split domain-specific helpers and confirm they do not rebuild a loop")
fi
if (( bridge_total_lines > BRIDGE_TOTAL_MAX_LINES )); then
  failures+=("official SDK bridge should stay bounded: ${bridge_total_lines} lines exceeds total budget ${BRIDGE_TOTAL_MAX_LINES}; prefer official SDK features before adding MAP/CDS glue")
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
    --arg pythonBin "$PYTHON_BIN" \
    --argjson officialLines "$official_lines" \
    --argjson legacyLines "$legacy_lines" \
    --argjson officialMaxLines "$OFFICIAL_ADAPTER_MAX_LINES" \
    --argjson supportMaxLines "$BRIDGE_SUPPORT_MAX_LINES" \
    --argjson bridgeTotalMaxLines "$BRIDGE_TOTAL_MAX_LINES" \
    --argjson supportLines "$support_lines_json" \
    --argjson supportTotalLines "$support_total_lines" \
    --argjson bridgeTotalLines "$bridge_total_lines" \
    --argjson loopRegressionBannedPatterns "$loop_regression_patterns_json" \
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
        bridgeSupportMaxLines: $supportMaxLines,
        bridgeSupportWithinBudget: ($supportTotalLines <= $supportMaxLines),
        bridgeTotalLines: $bridgeTotalLines,
        bridgeTotalMaxLines: $bridgeTotalMaxLines,
        bridgeTotalWithinBudget: ($bridgeTotalLines <= $bridgeTotalMaxLines),
        legacyLoopLines: $legacyLines,
        officialAdapterMaxLines: $officialMaxLines,
        officialAdapterWithinBudget: ($officialLines <= $officialMaxLines),
        boundaryFilesScannedForLoopRegression: ([$officialFile] + ($supportLines | map(.file))),
        loopRegressionBannedPatterns: $loopRegressionBannedPatterns
      },
      executableEvidence: {
        routingTest: $routingTest,
        routingTestStatus: $routingTestStatus,
        pythonBin: $pythonBin
      },
      assertionsFailed: $failures
    }' > "$REPORT"
fi

printf 'Official SDK boundary: %s\n' "$status"
printf 'Official adapter lines: %s/%s\n' "$official_lines" "$OFFICIAL_ADAPTER_MAX_LINES"
printf 'Bridge support lines: %s/%s\n' "$support_total_lines" "$BRIDGE_SUPPORT_MAX_LINES"
printf 'Bridge total lines: %s/%s\n' "$bridge_total_lines" "$BRIDGE_TOTAL_MAX_LINES"
printf 'Legacy loop lines: %s\n' "$legacy_lines"
printf 'Routing unit test: %s (%s via %s)\n' "$routing_test_status" "$ROUTING_TEST" "$PYTHON_BIN"
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
