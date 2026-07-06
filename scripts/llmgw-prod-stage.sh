#!/usr/bin/env sh
set -eu

# LLM Gateway production stage runner.
#
# This script is the operator-facing entrypoint for S4-S6 rollout stages. It
# deliberately does not accept gateway keys as CLI flags; pass keys through
# LLMGW_GATE_KEY, GW_KEY, or LLMGW_SERVE_KEY so they do not land in shell history.

usage() {
  cat <<'EOF'
Usage:
  scripts/llmgw-prod-stage.sh --stage <stage> --commit <40-char-sha> [--execute]

Stages:
  shadow-start       Deploy shadow mode and start collecting evidence samples
  canary-intent-text Canary low-risk intent/text entry
  canary-chat        Canary normal chat entries
  canary-streaming   Canary streaming entries
  canary-vision      Canary vision raw entry
  canary-image       Canary text2img/img2img raw entries
  canary-video-asr   Canary video and ASR raw entries
  http-full          Full LLMGW_MODE=http cutover, gated by all core evidence
  rollback-inproc    Execute rollback script to return MAP API to inproc mode

Required environment for deploy stages:
  LLMGW_GATE_BASE or GW_BASE   Serving base URL, for example https://host/gw/v1
  LLMGW_GATE_KEY, GW_KEY, or LLMGW_SERVE_KEY

Options:
  --execute                   Actually run fast.sh/exec_dep.sh or rollback
  --dry-run                   Print the exact stage plan without mutating state
  --repo owner/repo           Pass repository through to fast.sh and exec_dep.sh
  --sample-percent N          Shadow full sample percent for shadow/canary stages, default 1
  --evidence-dir PATH         Evidence output directory, default .llmgw-release-evidence
EOF
}

stage=""
commit=""
repo=""
execute=0
sample_percent="${LLMGW_STAGE_SHADOW_FULL_SAMPLE_PERCENT:-1}"
evidence_dir="${LLMGW_STAGE_EVIDENCE_DIR:-.llmgw-release-evidence}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --stage)
      shift
      [ "$#" -gt 0 ] || { echo "ERROR: --stage requires a value" >&2; exit 1; }
      stage="$1"
      ;;
    --stage=*)
      stage="${1#--stage=}"
      ;;
    --commit)
      shift
      [ "$#" -gt 0 ] || { echo "ERROR: --commit requires a value" >&2; exit 1; }
      commit="$1"
      ;;
    --commit=*)
      commit="${1#--commit=}"
      ;;
    --repo)
      shift
      [ "$#" -gt 0 ] || { echo "ERROR: --repo requires owner/repo" >&2; exit 1; }
      repo="$1"
      ;;
    --repo=*)
      repo="${1#--repo=}"
      ;;
    --sample-percent)
      shift
      [ "$#" -gt 0 ] || { echo "ERROR: --sample-percent requires a number" >&2; exit 1; }
      sample_percent="$1"
      ;;
    --sample-percent=*)
      sample_percent="${1#--sample-percent=}"
      ;;
    --evidence-dir)
      shift
      [ "$#" -gt 0 ] || { echo "ERROR: --evidence-dir requires a path" >&2; exit 1; }
      evidence_dir="$1"
      ;;
    --evidence-dir=*)
      evidence_dir="${1#--evidence-dir=}"
      ;;
    --execute)
      execute=1
      ;;
    --dry-run)
      execute=0
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

if [ -z "$stage" ]; then
  echo "ERROR: missing --stage" >&2
  usage >&2
  exit 1
fi

case "$stage" in
  rollback-inproc)
    ;;
  *)
    if ! printf '%s' "$commit" | grep -Eq '^[0-9a-fA-F]{40}$'; then
      echo "ERROR: deploy stages require --commit <40-char-sha>; got: ${commit:-empty}" >&2
      exit 1
    fi
    ;;
esac

if ! printf '%s' "$sample_percent" | grep -Eq '^[0-9]+$'; then
  echo "ERROR: --sample-percent must be an integer percent" >&2
  exit 1
fi

gate_base="${LLMGW_GATE_BASE:-${GW_BASE:-}}"
gate_key="${LLMGW_GATE_KEY:-${GW_KEY:-${LLMGW_SERVE_KEY:-}}}"

mode=""
allowlist=""
canary_stage=""
shadow_percent="0"

case "$stage" in
  shadow-start)
    mode="shadow"
    shadow_percent="$sample_percent"
    ;;
  canary-intent-text)
    mode="shadow"
    canary_stage="intent-text"
    allowlist="report-agent.generate::chat"
    shadow_percent="$sample_percent"
    ;;
  canary-chat)
    mode="shadow"
    canary_stage="chat"
    allowlist="report-agent.generate::chat,prd-agent-desktop.chat.sendmessage::chat,open-platform-agent.proxy::chat"
    shadow_percent="$sample_percent"
    ;;
  canary-streaming)
    mode="shadow"
    canary_stage="streaming"
    allowlist="report-agent.generate::chat,prd-agent-desktop.chat.sendmessage::chat,open-platform-agent.proxy::chat"
    shadow_percent="$sample_percent"
    ;;
  canary-vision)
    mode="shadow"
    canary_stage="vision"
    allowlist="visual-agent.image.vision::generation"
    shadow_percent="$sample_percent"
    ;;
  canary-image)
    mode="shadow"
    canary_stage="image"
    allowlist="visual-agent.image.text2img::generation,visual-agent.image.img2img::generation"
    shadow_percent="$sample_percent"
    ;;
  canary-video-asr)
    mode="shadow"
    canary_stage="video-asr"
    allowlist="video-agent.videogen::video-gen,document-store.subtitle::asr,transcript-agent.transcribe::asr"
    shadow_percent="$sample_percent"
    ;;
  http-full)
    mode="http"
    ;;
  rollback-inproc)
    ;;
  *)
    echo "ERROR: invalid stage: $stage" >&2
    usage >&2
    exit 1
    ;;
esac

if [ "$stage" != "rollback-inproc" ]; then
  if [ -z "$gate_base" ]; then
    echo "ERROR: $stage requires LLMGW_GATE_BASE or GW_BASE" >&2
    exit 1
  fi
  if [ -z "$gate_key" ]; then
    echo "ERROR: $stage requires LLMGW_GATE_KEY, GW_KEY, or LLMGW_SERVE_KEY" >&2
    exit 1
  fi
fi

ts="$(date -u '+%Y%m%dT%H%M%SZ' 2>/dev/null || date '+%Y%m%dT%H%M%SZ')"
short_commit="$(printf '%s' "$commit" | cut -c1-12)"
evidence_prefix="$evidence_dir/${ts}_${stage}_${short_commit}"

print_plan() {
  echo "LLM Gateway production stage:"
  echo "  stage: $stage"
  echo "  execute: $execute"
  if [ "$stage" != "rollback-inproc" ]; then
    echo "  commit: $commit"
    echo "  mode: $mode"
    echo "  canaryStage: ${canary_stage:-none}"
    echo "  allowlist: ${allowlist:-empty}"
    echo "  shadowFullSamplePercent: $shadow_percent"
    echo "  gateBase: $gate_base"
    echo "  evidenceJson: ${evidence_prefix}.json"
    echo "  evidenceMarkdown: ${evidence_prefix}.md"
  fi
}

run_or_print() {
  if [ "$execute" = "1" ]; then
    "$@"
  else
    printf '+'
    for arg in "$@"; do
      printf ' %s' "$arg"
    done
    printf '\n'
  fi
}

print_plan

if [ "$stage" = "rollback-inproc" ]; then
  if [ "$execute" != "1" ]; then
    echo "Dry-run only. Add --execute to run scripts/llmgw-rollback-inproc.sh."
    echo "+ scripts/llmgw-rollback-inproc.sh"
    exit 0
  fi
  run_or_print scripts/llmgw-rollback-inproc.sh
  exit 0
fi

export LLMGW_MODE="$mode"
export LLMGW_HTTP_APP_CALLER_ALLOWLIST="$allowlist"
export LLMGW_CANARY_STAGE="$canary_stage"
export LLMGW_SHADOW_FULL_SAMPLE_PERCENT="$shadow_percent"
export LLMGW_GATE_BASE="$gate_base"
export PRD_AGENT_REQUIRE_FAST_INTENT="${PRD_AGENT_REQUIRE_FAST_INTENT:-1}"
export LLMGW_GATE_JSON_OUT="${LLMGW_GATE_JSON_OUT:-${evidence_prefix}.json}"
export LLMGW_GATE_REPORT_MD="${LLMGW_GATE_REPORT_MD:-${evidence_prefix}.md}"
export LLMGW_GATE_SHADOW_SINCE_HOURS="${LLMGW_GATE_SHADOW_SINCE_HOURS:-24}"
export LLMGW_GATE_HEALTH_SAMPLES="${LLMGW_GATE_HEALTH_SAMPLES:-3}"
export LLMGW_GATE_HEALTH_INTERVAL_SECONDS="${LLMGW_GATE_HEALTH_INTERVAL_SECONDS:-5}"

if [ "$execute" = "1" ]; then
  mkdir -p "$evidence_dir"
fi

if [ -n "$repo" ]; then
  run_or_print ./fast.sh --commit "$commit" --repo "$repo"
  run_or_print ./exec_dep.sh --commit "$commit" --repo "$repo"
else
  run_or_print ./fast.sh --commit "$commit"
  run_or_print ./exec_dep.sh --commit "$commit"
fi

if [ "$execute" != "1" ]; then
  echo "Dry-run only. Add --execute to run the stage."
fi
