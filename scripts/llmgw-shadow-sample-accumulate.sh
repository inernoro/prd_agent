#!/usr/bin/env sh
set -eu

# Controlled multi-batch shadow evidence accumulator for LLM Gateway rollout.
# Each batch delegates to llmgw-shadow-sample-window.sh so production sampling
# is raised only for the seed window and restored after every batch.

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
window_script="$script_dir/llmgw-shadow-sample-window.sh"
seed_script="$script_dir/llmgw-map-shadow-seed.py"
coverage_script="$script_dir/llmgw-shadow-coverage-report.py"

profile="${LLMGW_SHADOW_ACCUMULATE_PROFILE:-}"
dry_run="${LLMGW_SHADOW_ACCUMULATE_DRY_RUN:-1}"
force_sample="${LLMGW_SHADOW_ACCUMULATE_FORCE_SAMPLE:-0}"
batches="${LLMGW_SHADOW_ACCUMULATE_BATCHES:-1}"
sleep_seconds="${LLMGW_SHADOW_ACCUMULATE_SLEEP_SECONDS:-0}"
seed_flags="${LLMGW_SHADOW_ACCUMULATE_SEED_FLAGS:-}"
evidence_root="${LLMGW_SHADOW_ACCUMULATE_EVIDENCE_ROOT:-$repo_root/.llmgw-release-evidence}"
run_id="${LLMGW_SHADOW_ACCUMULATE_RUN_ID:-$(date -u '+%Y%m%dT%H%M%SZ')}"
run_dir="${LLMGW_SHADOW_ACCUMULATE_RUN_DIR:-$evidence_root/shadow-accumulate-$run_id}"
coverage_base="${LLMGW_SHADOW_ACCUMULATE_COVERAGE_BASE:-${GW_BASE:-${LLMGW_GATE_BASE:-}}}"
coverage_kinds="${LLMGW_SHADOW_ACCUMULATE_COVERAGE_KINDS:-send,stream,raw}"
coverage_apps="${LLMGW_SHADOW_ACCUMULATE_COVERAGE_APP_CALLERS:-}"
coverage_required_kinds="${LLMGW_SHADOW_ACCUMULATE_REQUIRED_KINDS:-}"
coverage_required_app_kinds="${LLMGW_SHADOW_ACCUMULATE_REQUIRED_APP_KINDS:-}"
coverage_min_per_cell="${LLMGW_SHADOW_ACCUMULATE_MIN_PER_CELL:-30}"
coverage_since_hours="${LLMGW_SHADOW_ACCUMULATE_SINCE_HOURS:-24}"
coverage_min_hours="${LLMGW_SHADOW_ACCUMULATE_MIN_COVERAGE_HOURS:-24}"
release_commit="${LLMGW_SHADOW_ACCUMULATE_RELEASE_COMMIT:-${GIT_COMMIT:-}}"
run_coverage="${LLMGW_SHADOW_ACCUMULATE_RUN_COVERAGE:-1}"

case "$profile" in
  "")
    ;;
  canary-intent-text)
    force_sample="${LLMGW_SHADOW_ACCUMULATE_FORCE_SAMPLE:-1}"
    seed_flags="${LLMGW_SHADOW_ACCUMULATE_SEED_FLAGS:---iterations 1 --skip-preview-ask --include-report-agent-generate --continue-on-error}"
    coverage_kinds="${LLMGW_SHADOW_ACCUMULATE_COVERAGE_KINDS:-send}"
    coverage_apps="${LLMGW_SHADOW_ACCUMULATE_COVERAGE_APP_CALLERS:-report-agent.generate::chat}"
    coverage_required_kinds="${LLMGW_SHADOW_ACCUMULATE_REQUIRED_KINDS:-send:30}"
    coverage_required_app_kinds="${LLMGW_SHADOW_ACCUMULATE_REQUIRED_APP_KINDS:-report-agent.generate::chat:send:30}"
    ;;
  *)
    echo "ERROR: unknown LLMGW_SHADOW_ACCUMULATE_PROFILE: $profile" >&2
    echo "Supported profiles: canary-intent-text" >&2
    exit 1
    ;;
esac

if [ ! -x "$window_script" ]; then
  echo "ERROR: 找不到可执行采样窗口脚本: $window_script" >&2
  exit 1
fi

if [ ! -f "$seed_script" ]; then
  echo "ERROR: 找不到 MAP seed 脚本: $seed_script" >&2
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

redact_seed_flags() {
  printf '%s' "$1" | sed -E 's/(--gw-key|--admin-token|--root-password|--seed-password|--asr-video-url)([= ]+)[^ ]+/\1\2<redacted>/g'
}

echo "LLM Gateway shadow sample accumulator"
echo "  profile: ${profile:-<none>}"
echo "  dryRun: $dry_run"
echo "  forceSample: $force_sample"
echo "  batches: $batches"
echo "  sleepSeconds: $sleep_seconds"
echo "  runDir: $run_dir"
echo "  seedFlags: $(redact_seed_flags "$seed_flags")"
echo "  runCoverage: $run_coverage"
echo "  coverageKinds: $coverage_kinds"
echo "  coverageApps: $coverage_apps"
echo "  coverageRequiredKinds: $coverage_required_kinds"
echo "  coverageRequiredAppKinds: $coverage_required_app_kinds"
echo "  releaseCommit: $release_commit"

if [ "$dry_run" = "1" ] || [ "$dry_run" = "true" ]; then
  echo "LLM Gateway shadow sample accumulator dry-run completed"
  exit 0
fi

if [ -n "$profile" ] && [ -z "$(printf '%s' "$release_commit" | xargs || true)" ]; then
  echo "ERROR: LLMGW_SHADOW_ACCUMULATE_PROFILE=$profile 执行模式必须设置 LLMGW_SHADOW_ACCUMULATE_RELEASE_COMMIT 或 GIT_COMMIT，避免混用旧 commit shadow 样本" >&2
  exit 1
fi

mkdir -p "$run_dir"

gate_key="${LLMGW_GATE_KEY:-${GW_KEY:-${LLMGW_SERVE_KEY:-}}}"
if [ "$force_sample" = "1" ] || [ "$force_sample" = "true" ]; then
  if [ -z "$(printf '%s' "$gate_key" | xargs || true)" ]; then
    echo "ERROR: force sample 模式缺少 LLMGW_GATE_KEY/GW_KEY/LLMGW_SERVE_KEY" >&2
    exit 1
  fi
fi

i=1
while [ "$i" -le "$batches" ]; do
  batch_id="$(printf '%03d' "$i")"
  evidence_out="$run_dir/batch-$batch_id-shadow-sample-window.json"
  echo "LLM Gateway shadow sample batch $batch_id/$batches"

  if [ "$force_sample" = "1" ] || [ "$force_sample" = "true" ]; then
    # shellcheck disable=SC2086
    LLMGW_GATE_KEY="$gate_key" python3 "$seed_script" \
      --force-shadow-sample \
      --evidence-out "$evidence_out" \
      $seed_flags
  else
    # shellcheck disable=SC2086
    LLMGW_SHADOW_SAMPLE_WINDOW_DRY_RUN=0 \
    LLMGW_SHADOW_SAMPLE_WINDOW_SEED_FLAGS="$seed_flags" \
    LLMGW_SHADOW_SAMPLE_WINDOW_EVIDENCE_OUT="$evidence_out" \
    "$window_script"
  fi

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
  for kind_req in $coverage_required_kinds; do
    trimmed="$(printf '%s' "$kind_req" | xargs || true)"
    if [ -n "$trimmed" ]; then
      coverage_args="$coverage_args --require-kind $trimmed"
    fi
  done
  for app_kind_req in $coverage_required_app_kinds; do
    trimmed="$(printf '%s' "$app_kind_req" | xargs || true)"
    if [ -n "$trimmed" ]; then
      coverage_args="$coverage_args --require-app-kind $trimmed"
    fi
  done
  IFS="$old_ifs"

  if [ -n "$coverage_base" ]; then
    coverage_args="$coverage_args --base $coverage_base"
  fi
  if [ -n "$release_commit" ]; then
    coverage_args="$coverage_args --release-commit $release_commit"
  fi

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
