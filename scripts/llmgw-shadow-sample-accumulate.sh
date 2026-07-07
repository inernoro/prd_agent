#!/usr/bin/env sh
set -eu

# Controlled multi-batch shadow evidence accumulator for LLM Gateway rollout.
# Each batch delegates to llmgw-shadow-sample-window.sh so production sampling
# is raised only for the seed window and restored after every batch.

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
window_script="$script_dir/llmgw-shadow-sample-window.sh"
coverage_script="$script_dir/llmgw-shadow-coverage-report.py"

dry_run="${LLMGW_SHADOW_ACCUMULATE_DRY_RUN:-1}"
batches="${LLMGW_SHADOW_ACCUMULATE_BATCHES:-1}"
sleep_seconds="${LLMGW_SHADOW_ACCUMULATE_SLEEP_SECONDS:-0}"
seed_flags="${LLMGW_SHADOW_ACCUMULATE_SEED_FLAGS:-}"
evidence_root="${LLMGW_SHADOW_ACCUMULATE_EVIDENCE_ROOT:-$repo_root/.llmgw-release-evidence}"
run_id="${LLMGW_SHADOW_ACCUMULATE_RUN_ID:-$(date -u '+%Y%m%dT%H%M%SZ')}"
run_dir="${LLMGW_SHADOW_ACCUMULATE_RUN_DIR:-$evidence_root/shadow-accumulate-$run_id}"
coverage_base="${LLMGW_SHADOW_ACCUMULATE_COVERAGE_BASE:-${GW_BASE:-${LLMGW_GATE_BASE:-}}}"
coverage_kinds="${LLMGW_SHADOW_ACCUMULATE_COVERAGE_KINDS:-send,stream,raw}"
coverage_apps="${LLMGW_SHADOW_ACCUMULATE_COVERAGE_APP_CALLERS:-}"
coverage_min_per_cell="${LLMGW_SHADOW_ACCUMULATE_MIN_PER_CELL:-30}"
coverage_since_hours="${LLMGW_SHADOW_ACCUMULATE_SINCE_HOURS:-24}"
coverage_min_hours="${LLMGW_SHADOW_ACCUMULATE_MIN_COVERAGE_HOURS:-24}"
release_commit="${LLMGW_SHADOW_ACCUMULATE_RELEASE_COMMIT:-${GIT_COMMIT:-}}"
run_coverage="${LLMGW_SHADOW_ACCUMULATE_RUN_COVERAGE:-1}"

if [ ! -x "$window_script" ]; then
  echo "ERROR: 找不到可执行采样窗口脚本: $window_script" >&2
  exit 1
fi

if [ ! -f "$coverage_script" ]; then
  echo "ERROR: 找不到 shadow coverage 脚本: $coverage_script" >&2
  exit 1
fi

case "$batches" in
  ''|*[!0-9]*)
    echo "ERROR: LLMGW_SHADOW_ACCUMULATE_BATCHES 必须是正整数" >&2
    exit 1
    ;;
esac

case "$sleep_seconds" in
  ''|*[!0-9]*)
    echo "ERROR: LLMGW_SHADOW_ACCUMULATE_SLEEP_SECONDS 必须是非负整数" >&2
    exit 1
    ;;
esac

if [ "$batches" -lt 1 ]; then
  echo "ERROR: LLMGW_SHADOW_ACCUMULATE_BATCHES 必须 >= 1" >&2
  exit 1
fi

if [ "$dry_run" != "1" ] && [ "$dry_run" != "true" ] && [ -z "$(printf '%s' "$seed_flags" | xargs || true)" ]; then
  echo "ERROR: 执行模式必须设置 LLMGW_SHADOW_ACCUMULATE_SEED_FLAGS，避免空跑累计窗口" >&2
  exit 1
fi

echo "LLM Gateway shadow sample accumulator"
echo "  dryRun: $dry_run"
echo "  batches: $batches"
echo "  sleepSeconds: $sleep_seconds"
echo "  runDir: $run_dir"
echo "  seedFlags: $seed_flags"
echo "  runCoverage: $run_coverage"
echo "  coverageKinds: $coverage_kinds"
echo "  coverageApps: $coverage_apps"
echo "  releaseCommit: $release_commit"

if [ "$dry_run" = "1" ] || [ "$dry_run" = "true" ]; then
  echo "LLM Gateway shadow sample accumulator dry-run completed"
  exit 0
fi

mkdir -p "$run_dir"

i=1
while [ "$i" -le "$batches" ]; do
  batch_id="$(printf '%03d' "$i")"
  evidence_out="$run_dir/batch-$batch_id-shadow-sample-window.json"
  echo "LLM Gateway shadow sample batch $batch_id/$batches"

  # shellcheck disable=SC2086
  LLMGW_SHADOW_SAMPLE_WINDOW_DRY_RUN=0 \
  LLMGW_SHADOW_SAMPLE_WINDOW_SEED_FLAGS="$seed_flags" \
  LLMGW_SHADOW_SAMPLE_WINDOW_EVIDENCE_OUT="$evidence_out" \
  "$window_script"

  if [ "$i" -lt "$batches" ] && [ "$sleep_seconds" -gt 0 ]; then
    sleep "$sleep_seconds"
  fi
  i=$((i + 1))
done

if [ "$run_coverage" = "1" ] || [ "$run_coverage" = "true" ]; then
  coverage_json="$run_dir/shadow-coverage.json"
  coverage_md="$run_dir/shadow-coverage.md"
  coverage_args=""

  old_ifs="$IFS"
  IFS=','
  for kind in $coverage_kinds; do
    trimmed="$(printf '%s' "$kind" | xargs || true)"
    if [ -n "$trimmed" ]; then
      coverage_args="$coverage_args --kind $trimmed"
    fi
  done
  for app in $coverage_apps; do
    trimmed="$(printf '%s' "$app" | xargs || true)"
    if [ -n "$trimmed" ]; then
      coverage_args="$coverage_args --app-caller $trimmed"
    fi
  done
  IFS="$old_ifs"

  if [ -n "$coverage_base" ]; then
    coverage_args="$coverage_args --base $coverage_base"
  fi
  if [ -n "$release_commit" ]; then
    coverage_args="$coverage_args --release-commit $release_commit"
  fi

  gate_key="${LLMGW_GATE_KEY:-${GW_KEY:-${LLMGW_SERVE_KEY:-}}}"
  if [ -z "$(printf '%s' "$gate_key" | xargs || true)" ]; then
    echo "ERROR: 缺少 LLMGW_GATE_KEY/GW_KEY/LLMGW_SERVE_KEY，无法生成 shadow coverage" >&2
    exit 1
  fi

  # shellcheck disable=SC2086
  GW_KEY="$gate_key" python3 "$coverage_script" \
    --min-per-cell "$coverage_min_per_cell" \
    --since-hours "$coverage_since_hours" \
    --min-coverage-hours "$coverage_min_hours" \
    --json-out "$coverage_json" \
    --report-md "$coverage_md" \
    $coverage_args
fi

echo "LLM Gateway shadow sample accumulator evidence: $run_dir"
