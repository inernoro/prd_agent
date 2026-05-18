#!/usr/bin/env bash
# Verify that the published CDS Agent workbench bundle contains the execution
# runbook UI. This is a build-artifact check, not an authenticated visual check.
#
# Required:
#   SMOKE_CDS_AGENT_WORKBENCH_URL=https://.../cds-agent
#
# Optional:
#   SMOKE_CDS_AGENT_RUNBOOK_PUBLISH_DIR=/tmp/cds-agent-runbook-published
#   SMOKE_CDS_AGENT_RUNBOOK_ASSET=assets/index-xxxx-local.js

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
URL="${SMOKE_CDS_AGENT_WORKBENCH_URL:-https://cds-agent-workbench-ui-codex-prd-agent.miduo.org/cds-agent}"
OUT_DIR="${SMOKE_CDS_AGENT_RUNBOOK_PUBLISH_DIR:-/tmp/cds-agent-runbook-published}"
EXPLICIT_ASSET="${SMOKE_CDS_AGENT_RUNBOOK_ASSET:-}"

mkdir -p "$OUT_DIR"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

ok() {
  printf 'OK: %s\n' "$*"
}

for bin in curl rg jq; do
  command -v "$bin" >/dev/null 2>&1 || fail "missing dependency: $bin"
done

origin="$(printf '%s' "$URL" | sed -E 's#(https?://[^/]+).*#\1#')"
index_html="$OUT_DIR/index.html"
entry_js="$OUT_DIR/entry.js"
report="$OUT_DIR/summary.json"

printf '==========================================\n'
printf 'CDS Agent runbook publish verification\n'
printf 'URL: %s\n' "$URL"
printf 'Out: %s\n' "$OUT_DIR"
printf '==========================================\n'

http_code=$(curl --max-time 20 --show-error --silent --location \
  --output "$index_html" \
  --write-out '%{http_code}' \
  "$URL" || true)
[[ "$http_code" == "200" ]] || fail "workbench HTTP status=$http_code"
ok "workbench HTTP 200"

entry_src=$(rg -o 'src="[^"]+\.js"' "$index_html" | head -1 | sed -E 's/src="([^"]+)"/\1/' || true)
[[ -n "$entry_src" ]] || fail "entry JS not found in HTML"
entry_url="$origin${entry_src}"
curl --max-time 20 --show-error --silent --location "$entry_url" --output "$entry_js"
ok "entry bundle downloaded: $entry_src"

declare -a candidates=()
if [[ -n "$EXPLICIT_ASSET" ]]; then
  candidates+=("$EXPLICIT_ASSET")
fi
while IFS= read -r asset; do
  candidates+=("$asset")
done < <(rg -o 'assets/[^" ]+local\.js' "$entry_js" \
  | sort -u \
  | rg '(^assets/index-|^assets/infraAgentSessions-)' || true)

(( ${#candidates[@]} > 0 )) || fail "entry JS did not list inspectable candidate chunks"

matched_asset=""
matched_file=""
matched_patterns=()
patterns=(
  "执行 runbook"
  "branch-isolation-apply-confirmed"
  "requires approval"
  "provider opt-in"
  "commandCode"
)

for asset in "${candidates[@]}"; do
  [[ -n "$asset" ]] || continue
  safe_name="$(basename "$asset")"
  file="$OUT_DIR/$safe_name"
  curl --max-time 12 --show-error --silent --location "$origin/$asset" --output "$file" || continue
  hits=0
  current_patterns=()
  for pattern in "${patterns[@]}"; do
    if rg -q "$pattern" "$file"; then
      hits=$((hits + 1))
      current_patterns+=("$pattern")
    fi
  done
  if (( hits >= 3 )); then
    matched_asset="$asset"
    matched_file="$file"
    matched_patterns=("${current_patterns[@]}")
    break
  fi
done

[[ -n "$matched_asset" ]] || fail "runbook UI publish markers not found in candidate chunks"

patterns_json=$(printf '%s\n' "${matched_patterns[@]}" | jq -R 'select(length > 0)' | jq -s .)
jq -n \
  --arg url "$URL" \
  --arg entry "$entry_src" \
  --arg matchedAsset "$matched_asset" \
  --arg matchedFile "$matched_file" \
  --argjson candidateCount "${#candidates[@]}" \
  --argjson matchedPatterns "$patterns_json" \
  '{
    status: "pass",
    url: $url,
    entryAsset: $entry,
    candidateCount: $candidateCount,
    matchedAsset: $matchedAsset,
    matchedFile: $matchedFile,
    matchedPatterns: $matchedPatterns,
    note: "build-artifact verification only; authenticated pixel screenshot still requires login token"
  }' > "$report"

ok "runbook UI published in $matched_asset"
printf 'Summary: %s\n' "$report"
jq . "$report"
