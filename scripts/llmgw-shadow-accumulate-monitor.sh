#!/usr/bin/env sh
set -eu

# Read-only monitor for long-running LLM Gateway shadow evidence accumulators.
# It detects the unsafe state where sampling stayed high after the sample
# window process disappeared, and prints the latest batch evidence summary.

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
cd "$repo_root"

run_dir="${LLMGW_SHADOW_ACCUMULATE_MONITOR_RUN_DIR:-}"
if [ -z "$(printf '%s' "$run_dir" | xargs || true)" ]; then
  run_dir="$(find .llmgw-release-evidence -maxdepth 1 -type d -name 'shadow-accumulate-*' 2>/dev/null | sort | tail -1 || true)"
fi

env_file="${LLMGW_SHADOW_ACCUMULATE_MONITOR_ENV_FILE:-.env}"
api_container="${LLMGW_SHADOW_ACCUMULATE_MONITOR_API_CONTAINER:-prdagent-api}"
safe_sample_percent="${LLMGW_SHADOW_ACCUMULATE_MONITOR_SAFE_PERCENT:-1}"
accumulate_pattern="${LLMGW_SHADOW_ACCUMULATE_MONITOR_ACCUMULATE_PATTERN:-llmgw-shadow-sample-accumulate}"
window_pattern="${LLMGW_SHADOW_ACCUMULATE_MONITOR_WINDOW_PATTERN:-llmgw-shadow-sample-window}"

read_env_value() {
  name="$1"
  file="$2"
  if [ -f "$file" ]; then
    awk -F= -v key="$name" '$1 == key {print $2; exit}' "$file"
  fi
}

env_sample_percent="$(read_env_value LLMGW_SHADOW_FULL_SAMPLE_PERCENT "$env_file" || true)"
container_sample_percent=""
if command -v docker >/dev/null 2>&1 && docker inspect "$api_container" >/dev/null 2>&1; then
  container_sample_percent="$(
    docker inspect "$api_container" --format '{{range .Config.Env}}{{println .}}{{end}}' \
      | awk -F= '/^LlmGateway__ShadowFullSamplePercent=/{print $2; exit}'
  )"
fi

accumulate_running=0
window_running=0
if pgrep -af "$accumulate_pattern" >/dev/null 2>&1; then
  accumulate_running=1
fi
if pgrep -af "$window_pattern" >/dev/null 2>&1; then
  window_running=1
fi

echo "LLM Gateway shadow accumulator monitor"
echo "  runDir: ${run_dir:-<none>}"
echo "  envSamplePercent: ${env_sample_percent:-<unset>}"
echo "  containerSamplePercent: ${container_sample_percent:-<unset>}"
echo "  accumulateRunning: $accumulate_running"
echo "  windowRunning: $window_running"

if [ -n "$run_dir" ] && [ -d "$run_dir" ]; then
  latest_batch="$(find "$run_dir" -maxdepth 1 -type f -name 'batch-*-shadow-sample-window.json' 2>/dev/null | sort | tail -1 || true)"
  echo "  latestBatch: ${latest_batch:-<none>}"
  if [ -n "$latest_batch" ]; then
    python3 - "$latest_batch" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path, encoding="utf-8") as fh:
    data = json.load(fh)

steps = data.get("steps") or []
failed = [item for item in steps if not item.get("ok")]
print(f"  batchOk: {data.get('ok')}")
print(f"  batchEndedAt: {data.get('endedAt') or '<running>'}")
print(f"  batchExpectedGrowth: {data.get('expectedGrowth')}")
print(f"  batchStepCount: {len(steps)}")
print(f"  batchFailedStepCount: {len(failed)}")
for item in failed[:5]:
    print(f"  failedStep: {item.get('name')} error={str(item.get('error') or '')[:240]}")
PY
  fi
fi

if [ "$window_running" = "0" ]; then
  if [ -n "$env_sample_percent" ] && [ "$env_sample_percent" != "$safe_sample_percent" ]; then
    echo "ERROR: env sampling percent is $env_sample_percent but no sample window is running" >&2
    exit 2
  fi
  if [ -n "$container_sample_percent" ] && [ "$container_sample_percent" != "$safe_sample_percent" ]; then
    echo "ERROR: container sampling percent is $container_sample_percent but no sample window is running" >&2
    exit 2
  fi
fi

echo "LLM Gateway shadow accumulator monitor: OK"
