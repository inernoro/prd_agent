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
  rollback-rehearsal Dry-run rollback command and record same-commit rehearsal
  http-full          Full LLMGW_MODE=http cutover, gated by all core evidence
  rollback-inproc    Execute rollback script to return MAP API to inproc mode

Required environment for deploy stages:
  LLMGW_GATE_BASE or GW_BASE   Serving base URL, for example https://host/gw/v1
  LLMGW_GATE_KEY, GW_KEY, or LLMGW_SERVE_KEY
  LLMGW_STAGE_RUN_SHADOW_SEED=1 enables MAP shadow seed evidence after shadow-start deploy
  LLMGW_STAGE_MAP_BASE          MAP base URL for shadow seed, for example https://host
  LLMGW_STAGE_SHADOW_SEED_FLAGS Extra llmgw-map-shadow-seed.py flags, for example --include-video-direct
  LLMGW_STAGE_RUN_UPSTREAM_READINESS=1 enables /gw/v1/resolve upstream readiness evidence

Options:
  --execute                   Actually run fast.sh/exec_dep.sh or rollback
  --dry-run                   Print the exact stage plan without mutating state
  --repo owner/repo           Pass repository through to fast.sh and exec_dep.sh
  --sample-percent N          Shadow full sample percent for shadow/canary stages, default 1
  --min-observation-hours N   Require previous stage success to be at least N hours old, default 24
  --main-ref REF              Mainline ref that must be included by --commit, default origin/main
  --evidence-dir PATH         Evidence output directory, default .llmgw-release-evidence
  --ledger PATH               Append-only rollout ledger, default <evidence-dir>/rollout-ledger.jsonl
  --allow-out-of-order        Skip ledger stage order validation; requires an explicit release note
  --allow-out-of-order-reason TEXT
                              Required with --allow-out-of-order; written to stage evidence and ledger
EOF
}

stage=""
commit=""
repo=""
execute=0
sample_percent="${LLMGW_STAGE_SHADOW_FULL_SAMPLE_PERCENT:-1}"
min_observation_hours="${LLMGW_STAGE_MIN_OBSERVATION_HOURS:-24}"
main_ref="${LLMGW_RELEASE_MAIN_REF:-origin/main}"
evidence_dir="${LLMGW_STAGE_EVIDENCE_DIR:-.llmgw-release-evidence}"
ledger=""
allow_out_of_order=0
allow_out_of_order_reason="${LLMGW_ALLOW_OUT_OF_ORDER_REASON:-}"

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
    --min-observation-hours)
      shift
      [ "$#" -gt 0 ] || { echo "ERROR: --min-observation-hours requires a number" >&2; exit 1; }
      min_observation_hours="$1"
      ;;
    --min-observation-hours=*)
      min_observation_hours="${1#--min-observation-hours=}"
      ;;
    --main-ref)
      shift
      [ "$#" -gt 0 ] || { echo "ERROR: --main-ref requires a git ref" >&2; exit 1; }
      main_ref="$1"
      ;;
    --main-ref=*)
      main_ref="${1#--main-ref=}"
      ;;
    --evidence-dir)
      shift
      [ "$#" -gt 0 ] || { echo "ERROR: --evidence-dir requires a path" >&2; exit 1; }
      evidence_dir="$1"
      ;;
    --evidence-dir=*)
      evidence_dir="${1#--evidence-dir=}"
      ;;
    --ledger)
      shift
      [ "$#" -gt 0 ] || { echo "ERROR: --ledger requires a path" >&2; exit 1; }
      ledger="$1"
      ;;
    --ledger=*)
      ledger="${1#--ledger=}"
      ;;
    --allow-out-of-order)
      allow_out_of_order=1
      ;;
    --allow-out-of-order-reason)
      shift
      [ "$#" -gt 0 ] || { echo "ERROR: --allow-out-of-order-reason requires text" >&2; exit 1; }
      allow_out_of_order_reason="$1"
      ;;
    --allow-out-of-order-reason=*)
      allow_out_of_order_reason="${1#--allow-out-of-order-reason=}"
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
if ! printf '%s' "$min_observation_hours" | grep -Eq '^[0-9]+([.][0-9]+)?$'; then
  echo "ERROR: --min-observation-hours must be a non-negative number" >&2
  exit 1
fi
if [ -z "$(printf '%s' "$main_ref" | xargs)" ]; then
  echo "ERROR: --main-ref must not be empty" >&2
  exit 1
fi

if [ -z "$ledger" ]; then
  ledger="$evidence_dir/rollout-ledger.jsonl"
fi

allow_out_of_order_reason="$(printf '%s' "$allow_out_of_order_reason" | xargs || true)"
if [ "$allow_out_of_order" = "1" ] && [ -z "$allow_out_of_order_reason" ]; then
  echo "ERROR: --allow-out-of-order requires --allow-out-of-order-reason or LLMGW_ALLOW_OUT_OF_ORDER_REASON" >&2
  exit 1
fi

gate_base="${LLMGW_GATE_BASE:-${GW_BASE:-}}"
gate_key="${LLMGW_GATE_KEY:-${GW_KEY:-${LLMGW_SERVE_KEY:-}}}"

mode=""
allowlist=""
canary_stage=""
shadow_percent="0"
main_sha=""

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
    allowlist="visual-agent.image-gen.generate::generation,visual-agent.image.text2img::generation,visual-agent.image.img2img::generation"
    shadow_percent="$sample_percent"
    ;;
  canary-video-asr)
    mode="shadow"
    canary_stage="video-asr"
    allowlist="video-agent.videogen::video-gen,document-store.subtitle::asr,transcript-agent.transcribe::asr"
    shadow_percent="$sample_percent"
    ;;
  rollback-rehearsal)
    mode="inproc"
    canary_stage="rollback-rehearsal"
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

if [ "$stage" != "rollback-inproc" ] && [ "$stage" != "rollback-rehearsal" ]; then
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
release_gate_json="${evidence_prefix}.release-gate.json"
release_gate_md="${evidence_prefix}.release-gate.md"
serving_probe_json="${evidence_prefix}.serving-probe.json"
serving_probe_md="${evidence_prefix}.serving-probe.md"
smoke_json="${evidence_prefix}.gw-smoke.json"
smoke_md="${evidence_prefix}.gw-smoke.md"
prod_preflight_json="${evidence_prefix}.prod-preflight.json"
shadow_seed_json="${evidence_prefix}.map-shadow-seed.json"
upstream_readiness_json="${evidence_prefix}.upstream-readiness.json"
upstream_readiness_md="${evidence_prefix}.upstream-readiness.md"
stage_json="${evidence_prefix}.stage.json"
stage_md="${evidence_prefix}.stage.md"

case "$stage" in
  canary-video-asr|http-full)
    upstream_readiness_default=1
    ;;
  *)
    upstream_readiness_default=0
    ;;
esac
run_upstream_readiness="${LLMGW_STAGE_RUN_UPSTREAM_READINESS:-$upstream_readiness_default}"

print_plan() {
  echo "LLM Gateway production stage:"
  echo "  stage: $stage"
  echo "  execute: $execute"
  echo "  ledger: $ledger"
  echo "  allowOutOfOrder: $allow_out_of_order"
  echo "  allowOutOfOrderReason: ${allow_out_of_order_reason:-none}"
  echo "  minObservationHours: $min_observation_hours"
  echo "  mainRef: $main_ref"
  if [ "$stage" != "rollback-inproc" ]; then
    echo "  commit: $commit"
    echo "  mode: $mode"
    echo "  canaryStage: ${canary_stage:-none}"
    echo "  allowlist: ${allowlist:-empty}"
    echo "  shadowFullSamplePercent: $shadow_percent"
    echo "  gateBase: ${gate_base:-none}"
    echo "  releaseGateJson: $release_gate_json"
    echo "  servingProbeJson: $serving_probe_json"
    echo "  smokeJson: $smoke_json"
    echo "  prodPreflightJson: $prod_preflight_json"
    echo "  shadowSeedJson: $shadow_seed_json"
    echo "  upstreamReadinessJson: $upstream_readiness_json"
    echo "  upstreamReadinessEnabled: $run_upstream_readiness"
    echo "  stageJson: $stage_json"
  fi
}

validate_main_ancestry() {
  if [ "$stage" = "rollback-inproc" ]; then
    return 0
  fi
  if [ "$execute" != "1" ]; then
    if printf '%s' "$main_ref" | grep -Eq '^origin/'; then
      echo "+ git fetch --quiet origin ${main_ref#origin/}"
    fi
    echo "+ git merge-base --is-ancestor \"$main_ref\" \"$commit\""
    return 0
  fi
  if printf '%s' "$main_ref" | grep -Eq '^origin/'; then
    git fetch --quiet origin "${main_ref#origin/}"
  fi
  if ! git rev-parse --verify "$main_ref^{commit}" >/dev/null 2>&1; then
    echo "ERROR: main ref not found: $main_ref. Fetch main before production rollout." >&2
    exit 1
  fi
  if ! git rev-parse --verify "$commit^{commit}" >/dev/null 2>&1; then
    echo "ERROR: release commit is not available locally: $commit" >&2
    exit 1
  fi
  main_sha="$(git rev-parse "$main_ref^{commit}")"
  if ! git merge-base --is-ancestor "$main_sha" "$commit"; then
    echo "ERROR: release commit does not include latest main. mainRef=$main_ref mainSha=$main_sha commit=$commit" >&2
    exit 1
  fi
  echo "LLM Gateway release main ancestry: OK mainRef=$main_ref mainSha=$main_sha"
}

validate_ledger_order() {
  if [ ! -f "scripts/llmgw-rollout-ledger.py" ]; then
    echo "ERROR: missing scripts/llmgw-rollout-ledger.py; refusing staged rollout without ledger validation." >&2
    exit 1
  fi
  if [ "$allow_out_of_order" = "1" ]; then
    python3 scripts/llmgw-rollout-ledger.py validate \
      --ledger "$ledger" \
      --stage "$stage" \
      --commit "$commit" \
      --min-observation-hours "$min_observation_hours" \
      --allow-out-of-order-reason "$allow_out_of_order_reason" \
      --allow-out-of-order
  else
    python3 scripts/llmgw-rollout-ledger.py validate \
      --ledger "$ledger" \
      --stage "$stage" \
      --commit "$commit" \
      --min-observation-hours "$min_observation_hours"
  fi
}

append_ledger_entry() {
  status="$1"
  if [ ! -f "scripts/llmgw-rollout-ledger.py" ]; then
    echo "ERROR: missing scripts/llmgw-rollout-ledger.py; cannot append rollout ledger." >&2
    exit 1
  fi
  python3 scripts/llmgw-rollout-ledger.py append \
    --ledger "$ledger" \
    --stage "$stage" \
    --status "$status" \
    --commit "$commit" \
    --mode "$mode" \
    --canary-stage "$canary_stage" \
    --allowlist "$allowlist" \
    --shadow-full-sample-percent "$shadow_percent" \
    --gate-base "$gate_base" \
    --evidence-json "$stage_json" \
    --evidence-md "$stage_md" \
    --release-gate-json "$release_gate_json" \
    --release-gate-required "${release_gate_required:-0}" \
    --prod-preflight-json "$prod_preflight_json" \
    --shadow-seed-json "$shadow_seed_json" \
    --upstream-readiness-json "$upstream_readiness_json" \
    --upstream-readiness-required "$run_upstream_readiness" \
    --serving-probe-json "$serving_probe_json" \
    --smoke-json "$smoke_json" \
    --main-ref "$main_ref" \
    --main-sha "$main_sha" \
    --allow-out-of-order "$allow_out_of_order" \
    --allow-out-of-order-reason "$allow_out_of_order_reason" \
    --min-stage-observation-hours "$min_observation_hours"
}

write_dry_run_stage_report() {
  if [ "$execute" = "1" ]; then
    return 0
  fi

  mkdir -p "$evidence_dir"
  LLMGW_DRY_RUN_STAGE_JSON="$stage_json" \
  LLMGW_DRY_RUN_STAGE_MD="$stage_md" \
  LLMGW_DRY_RUN_STAGE="$stage" \
  LLMGW_DRY_RUN_COMMIT="$commit" \
  LLMGW_DRY_RUN_MODE="${mode:-}" \
  LLMGW_DRY_RUN_CANARY_STAGE="${canary_stage:-}" \
  LLMGW_DRY_RUN_ALLOWLIST="${allowlist:-}" \
  LLMGW_DRY_RUN_SHADOW_PERCENT="${shadow_percent:-}" \
  LLMGW_DRY_RUN_GATE_BASE="${gate_base:-}" \
  LLMGW_DRY_RUN_RELEASE_GATE_REQUIRED="${release_gate_required:-0}" \
  LLMGW_DRY_RUN_PROD_PREFLIGHT_JSON="${prod_preflight_json:-}" \
  LLMGW_DRY_RUN_SHADOW_SEED_JSON="${shadow_seed_json:-}" \
  LLMGW_DRY_RUN_UPSTREAM_READINESS_JSON="${upstream_readiness_json:-}" \
  LLMGW_DRY_RUN_UPSTREAM_READINESS_ENABLED="${run_upstream_readiness:-0}" \
  LLMGW_DRY_RUN_SERVING_PROBE_JSON="${serving_probe_json:-}" \
  LLMGW_DRY_RUN_SMOKE_JSON="${smoke_json:-}" \
  LLMGW_DRY_RUN_RELEASE_GATE_JSON="${release_gate_json:-}" \
  LLMGW_DRY_RUN_MAIN_REF="$main_ref" \
  LLMGW_DRY_RUN_MIN_OBSERVATION_HOURS="$min_observation_hours" \
  LLMGW_DRY_RUN_ALLOW_OUT_OF_ORDER="$allow_out_of_order" \
  LLMGW_DRY_RUN_ALLOW_OUT_OF_ORDER_REASON="$allow_out_of_order_reason" \
  python3 - <<'PY'
import json
import os
from datetime import datetime, timezone

stage = os.environ["LLMGW_DRY_RUN_STAGE"]
commit = os.environ["LLMGW_DRY_RUN_COMMIT"]
commands = []
if stage == "rollback-inproc":
    commands.append("scripts/llmgw-rollback-inproc.sh")
elif stage == "rollback-rehearsal":
    commands.append("LLMGW_ROLLBACK_DRY_RUN=1 scripts/llmgw-rollback-inproc.sh")
else:
    commands.append(
        "python3 scripts/llmgw-prod-preflight.py --mode start --expect-commit "
        + commit
    )
    commands.append("./fast.sh --commit " + commit)
    commands.append("./exec_dep.sh --commit " + commit)
    if os.environ.get("LLMGW_DRY_RUN_UPSTREAM_READINESS_ENABLED", "0") == "1":
        commands.append(
            "python3 scripts/llmgw-upstream-readiness.py --gw-base ${LLMGW_GATE_BASE} "
            "--gw-key-env LLMGW_GATE_KEY --json-out "
            + os.environ.get("LLMGW_DRY_RUN_UPSTREAM_READINESS_JSON", "")
        )
    if stage == "shadow-start" and os.environ.get("LLMGW_STAGE_RUN_SHADOW_SEED", "0") == "1":
        flags = os.environ.get("LLMGW_STAGE_SHADOW_SEED_FLAGS", "").strip()
        seed = (
            "python3 scripts/llmgw-map-shadow-seed.py --base ${LLMGW_STAGE_MAP_BASE} "
            "--gw-base ${LLMGW_GATE_BASE} --gw-key ${LLMGW_GATE_KEY} "
            "--continue-on-error --evidence-out "
            + os.environ.get("LLMGW_DRY_RUN_SHADOW_SEED_JSON", "")
        )
        if flags:
            seed += " " + flags
        commands.append(seed)

report = {
    "generatedAt": datetime.now(timezone.utc).isoformat(),
    "verdict": "pass",
    "stage": stage,
    "status": "dry-run",
    "execute": False,
    "commit": commit.lower(),
    "mode": os.environ.get("LLMGW_DRY_RUN_MODE", ""),
    "canaryStage": os.environ.get("LLMGW_DRY_RUN_CANARY_STAGE", ""),
    "allowlist": os.environ.get("LLMGW_DRY_RUN_ALLOWLIST", ""),
    "shadowFullSamplePercent": os.environ.get("LLMGW_DRY_RUN_SHADOW_PERCENT", ""),
    "gateBase": os.environ.get("LLMGW_DRY_RUN_GATE_BASE", ""),
    "releaseGateRequired": os.environ.get("LLMGW_DRY_RUN_RELEASE_GATE_REQUIRED", "0") == "1",
    "prodPreflightJson": os.environ.get("LLMGW_DRY_RUN_PROD_PREFLIGHT_JSON", ""),
    "shadowSeedJson": os.environ.get("LLMGW_DRY_RUN_SHADOW_SEED_JSON", ""),
    "shadowSeedEnabled": os.environ.get("LLMGW_STAGE_RUN_SHADOW_SEED", "0") == "1",
    "upstreamReadinessJson": os.environ.get("LLMGW_DRY_RUN_UPSTREAM_READINESS_JSON", ""),
    "upstreamReadinessEnabled": os.environ.get("LLMGW_DRY_RUN_UPSTREAM_READINESS_ENABLED", "0") == "1",
    "servingProbeJson": os.environ.get("LLMGW_DRY_RUN_SERVING_PROBE_JSON", ""),
    "smokeJson": os.environ.get("LLMGW_DRY_RUN_SMOKE_JSON", ""),
    "releaseGateJson": os.environ.get("LLMGW_DRY_RUN_RELEASE_GATE_JSON", ""),
    "releaseMainRef": os.environ.get("LLMGW_DRY_RUN_MAIN_REF", ""),
    "minStageObservationHours": os.environ.get("LLMGW_DRY_RUN_MIN_OBSERVATION_HOURS", ""),
    "allowOutOfOrder": os.environ.get("LLMGW_DRY_RUN_ALLOW_OUT_OF_ORDER", "0") == "1",
    "allowOutOfOrderReason": os.environ.get("LLMGW_DRY_RUN_ALLOW_OUT_OF_ORDER_REASON", ""),
    "plannedCommands": commands,
}

json_path = os.environ["LLMGW_DRY_RUN_STAGE_JSON"]
md_path = os.environ["LLMGW_DRY_RUN_STAGE_MD"]
os.makedirs(os.path.dirname(json_path) or ".", exist_ok=True)
with open(json_path, "w", encoding="utf-8") as fh:
    json.dump(report, fh, ensure_ascii=False, indent=2, sort_keys=True)
    fh.write("\n")

with open(md_path, "w", encoding="utf-8") as fh:
    fh.write("# LLM Gateway Rollout Stage Dry Run\n\n")
    for key in (
        "generatedAt",
        "verdict",
        "stage",
        "status",
        "commit",
        "mode",
        "canaryStage",
        "allowlist",
        "releaseGateRequired",
        "shadowSeedEnabled",
        "shadowSeedJson",
        "upstreamReadinessEnabled",
        "upstreamReadinessJson",
        "releaseMainRef",
        "minStageObservationHours",
    ):
        fh.write(f"- {key}: `{report[key]}`\n")
    fh.write("\n## Planned Commands\n\n")
    for command in commands:
        fh.write(f"- `{command}`\n")
PY
  echo "LLM Gateway dry-run evidence written: $stage_json"
}

run_prod_preflight() {
  if [ ! -f "scripts/llmgw-prod-preflight.py" ]; then
    echo "ERROR: missing scripts/llmgw-prod-preflight.py; refusing staged rollout without production preflight." >&2
    exit 1
  fi

  if [ "$execute" = "1" ]; then
    mkdir -p "$evidence_dir"
    preflight_args="--mode start --expect-commit $commit --json-out $prod_preflight_json"
    if [ "$stage" = "shadow-start" ]; then
      preflight_args="$preflight_args --allow-missing-gateway --allow-missing-map-logs"
    fi
    # shellcheck disable=SC2086
    python3 scripts/llmgw-prod-preflight.py \
      $preflight_args
  else
    suffix=""
    if [ "$stage" = "shadow-start" ]; then
      suffix=" --allow-missing-gateway --allow-missing-map-logs"
    fi
    echo "+ python3 scripts/llmgw-prod-preflight.py --mode start --expect-commit \"$commit\" --json-out \"$prod_preflight_json\"$suffix"
  fi
}

run_shadow_seed_evidence() {
  if [ "$stage" != "shadow-start" ]; then
    return 0
  fi
  if [ "${LLMGW_STAGE_RUN_SHADOW_SEED:-0}" != "1" ]; then
    if [ "$execute" = "1" ]; then
      echo "LLM Gateway MAP shadow seed skipped: LLMGW_STAGE_RUN_SHADOW_SEED is not 1"
    else
      echo "LLM Gateway MAP shadow seed dry-run skipped by default; set LLMGW_STAGE_RUN_SHADOW_SEED=1 to include it"
    fi
    return 0
  fi
  if [ ! -f "scripts/llmgw-map-shadow-seed.py" ]; then
    echo "ERROR: missing scripts/llmgw-map-shadow-seed.py; cannot collect MAP shadow seed evidence." >&2
    exit 1
  fi
  map_base="${LLMGW_STAGE_MAP_BASE:-${PRD_AGENT_BASE:-}}"
  if [ -z "$(printf '%s' "$map_base" | xargs || true)" ]; then
    echo "ERROR: LLMGW_STAGE_RUN_SHADOW_SEED=1 requires LLMGW_STAGE_MAP_BASE or PRD_AGENT_BASE." >&2
    exit 1
  fi
  seed_flags="${LLMGW_STAGE_SHADOW_SEED_FLAGS:-}"
  if [ "$execute" = "1" ]; then
    mkdir -p "$evidence_dir"
    # shellcheck disable=SC2086
    python3 scripts/llmgw-map-shadow-seed.py \
      --base "$map_base" \
      --gw-base "$gate_base" \
      --gw-key "$gate_key" \
      --continue-on-error \
      --evidence-out "$shadow_seed_json" \
      $seed_flags
  else
    echo "+ python3 scripts/llmgw-map-shadow-seed.py --base \"$map_base\" --gw-base \"$gate_base\" --gw-key \"<redacted>\" --continue-on-error --evidence-out \"$shadow_seed_json\" $seed_flags"
  fi
}

run_upstream_readiness_evidence() {
  if [ "$run_upstream_readiness" != "1" ]; then
    if [ "$execute" = "1" ]; then
      echo "LLM Gateway upstream readiness skipped: LLMGW_STAGE_RUN_UPSTREAM_READINESS is not 1"
    else
      echo "LLM Gateway upstream readiness dry-run skipped for this stage"
    fi
    return 0
  fi
  if [ ! -f "scripts/llmgw-upstream-readiness.py" ]; then
    echo "ERROR: missing scripts/llmgw-upstream-readiness.py; cannot collect upstream readiness evidence." >&2
    exit 1
  fi
  if [ "$execute" = "1" ]; then
    mkdir -p "$evidence_dir"
    python3 scripts/llmgw-upstream-readiness.py \
      --gw-base "$gate_base" \
      --gw-key-env LLMGW_GATE_KEY \
      --json-out "$upstream_readiness_json" \
      --report-md "$upstream_readiness_md"
  else
    echo "+ python3 scripts/llmgw-upstream-readiness.py --gw-base \"$gate_base\" --gw-key-env LLMGW_GATE_KEY --json-out \"$upstream_readiness_json\" --report-md \"$upstream_readiness_md\""
  fi
}

rollout_ledger_status="pending"
record_failed_stage_on_exit() {
  exit_code="$?"
  if [ "$exit_code" = "0" ]; then
    return 0
  fi
  if [ "$execute" != "1" ]; then
    return 0
  fi
  if [ "${rollout_ledger_status:-pending}" != "pending" ]; then
    return 0
  fi

  echo "LLM Gateway production stage failed; appending failed rollout ledger entry." >&2
  if append_ledger_entry failed >/dev/null 2>&1; then
    rollout_ledger_status="failed"
  else
    echo "WARN: failed to append failed rollout ledger entry." >&2
  fi
}
trap record_failed_stage_on_exit EXIT

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
    write_dry_run_stage_report
    echo "Dry-run only. Add --execute to run scripts/llmgw-rollback-inproc.sh."
    echo "+ scripts/llmgw-rollback-inproc.sh"
    exit 0
  fi
  run_or_print scripts/llmgw-rollback-inproc.sh
  append_ledger_entry rollback
  rollout_ledger_status="rollback"
  exit 0
fi

validate_ledger_order
validate_main_ancestry

if [ "$stage" = "rollback-rehearsal" ]; then
  release_gate_required=0
  if [ "$execute" = "1" ]; then
    mkdir -p "$evidence_dir"
    LLMGW_ROLLBACK_DRY_RUN=1 scripts/llmgw-rollback-inproc.sh
    python3 scripts/llmgw-rollout-ledger.py stage-report \
      --json-out "$stage_json" \
      --report-md "$stage_md" \
      --stage "$stage" \
      --status success \
      --commit "$commit" \
      --mode "$mode" \
      --canary-stage "$canary_stage" \
      --allowlist "$allowlist" \
      --shadow-full-sample-percent "$shadow_percent" \
      --gate-base "$gate_base" \
      --release-gate-json "$release_gate_json" \
      --release-gate-required "$release_gate_required" \
      --prod-preflight-json "$prod_preflight_json" \
      --shadow-seed-json "$shadow_seed_json" \
      --upstream-readiness-json "$upstream_readiness_json" \
      --upstream-readiness-required "$run_upstream_readiness" \
      --serving-probe-json "$serving_probe_json" \
      --smoke-json "$smoke_json" \
      --main-ref "$main_ref" \
      --main-sha "$main_sha" \
      --allow-out-of-order "$allow_out_of_order" \
      --allow-out-of-order-reason "$allow_out_of_order_reason" \
      --min-stage-observation-hours "$min_observation_hours"
    append_ledger_entry success
    rollout_ledger_status="success"
  else
    echo "+ LLMGW_ROLLBACK_DRY_RUN=1 scripts/llmgw-rollback-inproc.sh"
    write_dry_run_stage_report
    echo "Dry-run only. Add --execute to record rollback rehearsal success."
  fi
  exit 0
fi

export LLMGW_MODE="$mode"
export LLMGW_PROD_STAGE_ACTIVE=1
export LLMGW_PROD_STAGE="$stage"
export LLMGW_HTTP_APP_CALLER_ALLOWLIST="$allowlist"
export LLMGW_CANARY_STAGE="$canary_stage"
export LLMGW_SHADOW_FULL_SAMPLE_PERCENT="$shadow_percent"
export LLMGW_GATE_BASE="$gate_base"
export LLMGW_GATE_KEY="${LLMGW_GATE_KEY:-$gate_key}"
export LLMGW_SERVE_KEY="${LLMGW_SERVE_KEY:-$gate_key}"
export LLMGW_GATE_SHADOW_RELEASE_COMMIT="${LLMGW_GATE_SHADOW_RELEASE_COMMIT:-$commit}"
export LLMGW_SHADOW_COVERAGE_RELEASE_COMMIT="${LLMGW_SHADOW_COVERAGE_RELEASE_COMMIT:-$commit}"
export PRD_AGENT_REQUIRE_FAST_INTENT="${PRD_AGENT_REQUIRE_FAST_INTENT:-1}"
export LLMGW_GATE_JSON_OUT="${LLMGW_GATE_JSON_OUT:-$release_gate_json}"
export LLMGW_GATE_REPORT_MD="${LLMGW_GATE_REPORT_MD:-$release_gate_md}"
export LLMGW_SERVING_PROBE_JSON_OUT="${LLMGW_SERVING_PROBE_JSON_OUT:-$serving_probe_json}"
export LLMGW_SERVING_PROBE_REPORT_MD="${LLMGW_SERVING_PROBE_REPORT_MD:-$serving_probe_md}"
export GW_SMOKE_JSON_OUT="${GW_SMOKE_JSON_OUT:-$smoke_json}"
export GW_SMOKE_REPORT_MD="${GW_SMOKE_REPORT_MD:-$smoke_md}"
export LLMGW_GATE_SHADOW_SINCE_HOURS="${LLMGW_GATE_SHADOW_SINCE_HOURS:-24}"
export LLMGW_GATE_HEALTH_SAMPLES="${LLMGW_GATE_HEALTH_SAMPLES:-3}"
export LLMGW_GATE_HEALTH_INTERVAL_SECONDS="${LLMGW_GATE_HEALTH_INTERVAL_SECONDS:-5}"

case "$stage" in
  shadow-start)
    release_gate_required=0
    ;;
  *)
    release_gate_required=1
    ;;
esac

if [ "$execute" = "1" ]; then
  mkdir -p "$evidence_dir"
fi

run_prod_preflight

if [ -n "$repo" ]; then
  run_or_print ./fast.sh --commit "$commit" --repo "$repo"
  run_or_print ./exec_dep.sh --commit "$commit" --repo "$repo"
else
  run_or_print ./fast.sh --commit "$commit"
  run_or_print ./exec_dep.sh --commit "$commit"
fi

run_upstream_readiness_evidence
run_shadow_seed_evidence

if [ "$execute" = "1" ]; then
  python3 scripts/llmgw-rollout-ledger.py stage-report \
    --json-out "$stage_json" \
    --report-md "$stage_md" \
    --stage "$stage" \
    --status success \
    --commit "$commit" \
    --mode "$mode" \
    --canary-stage "$canary_stage" \
    --allowlist "$allowlist" \
    --shadow-full-sample-percent "$shadow_percent" \
    --gate-base "$gate_base" \
    --release-gate-json "$release_gate_json" \
    --release-gate-required "$release_gate_required" \
    --prod-preflight-json "$prod_preflight_json" \
    --shadow-seed-json "$shadow_seed_json" \
    --upstream-readiness-json "$upstream_readiness_json" \
    --upstream-readiness-required "$run_upstream_readiness" \
    --serving-probe-json "$serving_probe_json" \
    --smoke-json "$smoke_json" \
    --main-ref "$main_ref" \
    --main-sha "$main_sha" \
    --allow-out-of-order "$allow_out_of_order" \
    --allow-out-of-order-reason "$allow_out_of_order_reason" \
    --min-stage-observation-hours "$min_observation_hours"
  append_ledger_entry success
  rollout_ledger_status="success"
fi

if [ "$execute" != "1" ]; then
  write_dry_run_stage_report
  echo "Dry-run only. Add --execute to run the stage."
fi
