#!/usr/bin/env sh
set -eu

dotenv_file="${PRD_AGENT_DOTENV_FILE:-.env}"
expected_base_url="${LLMGW_EXPECTED_SERVE_BASE_URL:-http://gateway/gw/v1}"

read_dotenv_value() {
  key="$1"
  if [ ! -f "$dotenv_file" ]; then
    return 0
  fi
  awk -v key="$key" '
    /^[[:space:]]*#/ { next }
    {
      line = $0
      sub(/^[[:space:]]*export[[:space:]]+/, "", line)
      pos = index(line, "=")
      if (pos == 0) next
      name = substr(line, 1, pos - 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
      if (name != key) next
      value = substr(line, pos + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      if ((substr(value, 1, 1) == "\"" && substr(value, length(value), 1) == "\"") ||
          (substr(value, 1, 1) == "\047" && substr(value, length(value), 1) == "\047")) {
        value = substr(value, 2, length(value) - 2)
      }
      print value
      exit
    }
  ' "$dotenv_file"
}

if [ "${LLMGW_SERVE_BASE_URL+x}" = x ]; then
  serve_base_url="$LLMGW_SERVE_BASE_URL"
else
  serve_base_url="$(read_dotenv_value LLMGW_SERVE_BASE_URL)"
fi
if [ "${LLMGW_READINESS_REQUIRE_ASSET_PROBE+x}" = x ]; then
  require_asset_probe="$LLMGW_READINESS_REQUIRE_ASSET_PROBE"
else
  require_asset_probe="$(read_dotenv_value LLMGW_READINESS_REQUIRE_ASSET_PROBE)"
fi
if [ "${LLMGW_READINESS_ASSET_PROBE_KEY+x}" = x ]; then
  asset_probe_key="$LLMGW_READINESS_ASSET_PROBE_KEY"
else
  asset_probe_key="$(read_dotenv_value LLMGW_READINESS_ASSET_PROBE_KEY)"
fi

serve_base_url="$(printf '%s' "$serve_base_url" | xargs || true)"
require_asset_probe="$(printf '%s' "$require_asset_probe" | xargs || true)"
asset_probe_key="$(printf '%s' "$asset_probe_key" | xargs || true)"

if [ -n "$serve_base_url" ] && [ "$serve_base_url" != "$expected_base_url" ]; then
  echo "ERROR: LLMGW_SERVE_BASE_URL must be $expected_base_url for production serving failover; found $serve_base_url" >&2
  exit 1
fi

case "$require_asset_probe" in
  ""|1|true|TRUE|yes|YES|on|ON)
    ;;
  *)
    echo "ERROR: production requires LLMGW_READINESS_REQUIRE_ASSET_PROBE=true" >&2
    exit 1
    ;;
esac

if [ -z "$asset_probe_key" ]; then
  echo "ERROR: production requires LLMGW_READINESS_ASSET_PROBE_KEY to reference an existing stable object" >&2
  exit 1
fi

echo "LLM Gateway production topology preflight: PASS"
echo "- serving route: gateway upstream"
echo "- asset readiness probe: required and configured"
