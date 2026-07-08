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
plan_script="$script_dir/llmgw-shadow-sample-plan.py"

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
release_commit_trimmed="$(printf '%s' "$release_commit" | xargs || true)"
run_coverage="${LLMGW_SHADOW_ACCUMULATE_RUN_COVERAGE:-1}"
preflight_coverage="${LLMGW_SHADOW_ACCUMULATE_PREFLIGHT_COVERAGE:-1}"
allow_after_pass="${LLMGW_SHADOW_ACCUMULATE_ALLOW_AFTER_PASS:-0}"
max_batches="${LLMGW_SHADOW_ACCUMULATE_MAX_BATCHES:-0}"
enforce_plan="${LLMGW_SHADOW_ACCUMULATE_ENFORCE_PLAN:-1}"

case "$profile" in
  "")
    ;;
  canary-intent-text)
    force_sample="${LLMGW_SHADOW_ACCUMULATE_FORCE_SAMPLE:-1}"
    max_batches="${LLMGW_SHADOW_ACCUMULATE_MAX_BATCHES:-3}"
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

if [ ! -f "$plan_script" ]; then
  echo "ERROR: 找不到 shadow sample plan 脚本: $plan_script" >&2
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

case "$max_batches" in
  ''|*[!0-9]*)
    echo "ERROR: LLMGW_SHADOW_ACCUMULATE_MAX_BATCHES 必须是非负整数" >&2
    exit 1
    ;;
esac

if [ "$max_batches" -gt 0 ] && [ "$batches" -gt "$max_batches" ]; then
  echo "ERROR: LLMGW_SHADOW_ACCUMULATE_BATCHES=${batches} 超过本 profile 默认上限 ${max_batches}。" >&2
  echo "如已确认预算并需要继续补样本，显式设置 LLMGW_SHADOW_ACCUMULATE_MAX_BATCHES=${batches} 后重跑。" >&2
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
echo "  maxBatches: $max_batches"
echo "  sleepSeconds: $sleep_seconds"
echo "  runDir: $run_dir"
echo "  seedFlags: $(redact_seed_flags "$seed_flags")"
echo "  runCoverage: $run_coverage"
echo "  preflightCoverage: $preflight_coverage"
echo "  enforcePlan: $enforce_plan"
echo "  coverageKinds: $coverage_kinds"
echo "  coverageApps: $coverage_apps"
echo "  coverageRequiredKinds: $coverage_required_kinds"
echo "  coverageRequiredAppKinds: $coverage_required_app_kinds"
echo "  releaseCommit: $release_commit_trimmed"

if [ "$dry_run" = "1" ] || [ "$dry_run" = "true" ]; then
  echo "LLM Gateway shadow sample accumulator dry-run completed"
  exit 0
fi

if [ -n "$profile" ] && [ -z "$release_commit_trimmed" ]; then
  echo "ERROR: LLMGW_SHADOW_ACCUMULATE_PROFILE=$profile 执行模式必须设置 LLMGW_SHADOW_ACCUMULATE_RELEASE_COMMIT 或 GIT_COMMIT，避免混用旧 commit shadow 样本" >&2
  exit 1
fi

seed_run_flags="$seed_flags"
if [ -n "$release_commit_trimmed" ]; then
  seed_run_flags="$seed_run_flags --release-commit $release_commit_trimmed"
fi

mkdir -p "$run_dir"

gate_key="${LLMGW_GATE_KEY:-${GW_KEY:-${LLMGW_SERVE_KEY:-}}}"
if [ "$force_sample" = "1" ] || [ "$force_sample" = "true" ]; then
  if [ -z "$(printf '%s' "$gate_key" | xargs || true)" ]; then
    echo "ERROR: force sample 模式缺少 LLMGW_GATE_KEY/GW_KEY/LLMGW_SERVE_KEY" >&2
    exit 1
  fi
fi

build_coverage_args() {
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
  if [ -n "$release_commit_trimmed" ]; then
    coverage_args="$coverage_args --release-commit $release_commit_trimmed"
  fi
}

run_coverage_report() {
  coverage_json="$1"
  coverage_md="$2"
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
}

read_plan_field() {
  plan_json="$1"
  field="$2"
  python3 - "$plan_json" "$field" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as fh:
    data = json.load(fh)
value = data.get(sys.argv[2])
if isinstance(value, bool):
    print("true" if value else "false")
elif value is None:
    print("")
else:
    print(value)
PY
}

if [ "$run_coverage" = "1" ] || [ "$run_coverage" = "true" ]; then
  build_coverage_args
fi

if { [ "$preflight_coverage" = "1" ] || [ "$preflight_coverage" = "true" ]; } && { [ "$run_coverage" = "1" ] || [ "$run_coverage" = "true" ]; }; then
  preflight_json="$run_dir/preflight-shadow-coverage.json"
  preflight_md="$run_dir/preflight-shadow-coverage.md"
  echo "LLM Gateway shadow sample preflight coverage"
  set +e
  run_coverage_report "$preflight_json" "$preflight_md"
  preflight_status="$?"
  set -e
  if [ "$preflight_status" = "0" ]; then
    echo "LLM Gateway shadow sample accumulator: coverage already satisfies gate; skip seeding."
    if [ "$allow_after_pass" != "1" ] && [ "$allow_after_pass" != "true" ]; then
      exit 0
    fi
    echo "WARN: LLMGW_SHADOW_ACCUMULATE_ALLOW_AFTER_PASS is enabled; continuing despite satisfied coverage." >&2
  else
    echo "LLM Gateway shadow sample preflight coverage did not pass; continuing with bounded seed batches."
    if [ "$enforce_plan" = "1" ] || [ "$enforce_plan" = "true" ]; then
      plan_json="$run_dir/preflight-shadow-sample-plan.json"
      plan_md="$run_dir/preflight-shadow-sample-plan.md"
      plan_max_batches="$batches"
      if [ "$max_batches" -gt 0 ]; then
        plan_max_batches="$max_batches"
      fi
      python3 "$plan_script" \
        --coverage-json "$preflight_json" \
        --max-batches "$plan_max_batches" \
        --json-out "$plan_json" \
        --report-md "$plan_md"
      plan_can_run="$(read_plan_field "$plan_json" canRunRecommendedBatches)"
      plan_recommended="$(read_plan_field "$plan_json" recommendedBatches)"
      plan_reason="$(read_plan_field "$plan_json" reason)"
      echo "LLM Gateway shadow sample plan: canRun=$plan_can_run recommendedBatches=$plan_recommended reason=$plan_reason"
      if [ "$plan_can_run" != "true" ]; then
        if [ "$plan_reason" = "wait-coverage-window" ] || [ "$plan_reason" = "already-ready" ]; then
          echo "LLM Gateway shadow sample accumulator: planner says no more seed batches are needed now."
          exit 0
        fi
        echo "ERROR: shadow sample planner blocked seeding: $plan_reason" >&2
        exit 1
      fi
      case "$plan_recommended" in
        ''|*[!0-9]*)
          echo "ERROR: shadow sample planner returned invalid recommendedBatches: $plan_recommended" >&2
          exit 1
          ;;
      esac
      if [ "$batches" -gt "$plan_recommended" ]; then
        echo "ERROR: requested batches=$batches exceeds planner recommendation=$plan_recommended; refusing to over-sample." >&2
        echo "Set LLMGW_SHADOW_ACCUMULATE_BATCHES=$plan_recommended or rerun after a fresh coverage report." >&2
        exit 1
      fi
    fi
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
      $seed_run_flags
  else
    # shellcheck disable=SC2086
    LLMGW_SHADOW_SAMPLE_WINDOW_DRY_RUN=0 \
    LLMGW_SHADOW_SAMPLE_WINDOW_SEED_FLAGS="$seed_run_flags" \
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
  run_coverage_report "$coverage_json" "$coverage_md"
fi

echo "LLM Gateway shadow sample accumulator evidence: $run_dir"
