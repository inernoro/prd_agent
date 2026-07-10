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
  canary-image       Canary image-gen/text2img/img2img raw entries
  canary-asr         Canary ASR/subtitle raw entries without video generation
  canary-video-asr   Canary video and ASR raw entries
  config-authority   Claim MAP model config into llm_gateway and bind active appCallers
  rollback-rehearsal Dry-run rollback command and record same-commit rehearsal
  http-full          Full LLMGW_MODE=http cutover, gated by all core evidence
  rollback-inproc    Execute rollback script to return MAP API to inproc mode

Required environment for deploy stages:
  LLMGW_GATE_BASE or GW_BASE   Serving base URL, for example https://host/gw/v1
  LLMGW_GATE_KEY, GW_KEY, or LLMGW_SERVE_KEY
  LLMGW_STAGE_RUN_SHADOW_SEED=1 enables MAP shadow seed evidence after shadow-start deploy
  LLMGW_SHADOW_FULL_SAMPLE_APP_CALLER_ALLOWLIST
                              Optional appCaller list forced to full shadow sampling for deterministic raw evidence
  LLMGW_STAGE_MAP_BASE or PRD_AGENT_BASE
                              MAP base URL for preflight, ASR canary, and shadow seed
  LLMGW_STAGE_ALLOW_MISSING_MAP_LOGS=1
                              Allow production preflight to defer MAP LLM log scan when the operator has no MAP Bearer token.
                              This does not bypass gateway release gates or completion-mode direct-transport checks.
  LLMGW_STAGE_SHADOW_SEED_FLAGS Extra llmgw-map-shadow-seed.py flags, for example --include-video-direct
  LLMGW_STAGE_RUN_UPSTREAM_READINESS=1 enables /gw/v1/resolve upstream readiness evidence
  LLMGW_GATE_SMOKE_ROUTE_MATRIX=1 enables /gw/v1/resolve auto/pool/pinned route matrix evidence
  LLMGW_GATE_SMOKE_ROUTE_POOL_ID and LLMGW_GATE_SMOKE_ROUTE_PINNED_PLATFORM_ID/MODEL_ID
                              Required when LLMGW_GATE_SMOKE_ROUTE_MATRIX=1
  LLMGW_STAGE_RUN_PROVIDER_AUDIT=1 enables read-only video/ASR provider config audit
  LLMGW_STAGE_RUN_VIDEO_CANARY=1 enables /gw/v1/raw video exchange canary evidence
  LLMGW_CONSOLE_BASE and LLMGW_CONSOLE_TOKEN, or LLMGW_CONSOLE_USER/PASSWORD
                              Required for config-authority and http-full stages
  LLMGW_STAGE_MIN_FREE_MB minimum free disk MB before execute deploy stages, default 4096
  LLMGW_STAGE_AUTO_RESTORE_SHADOW_ON_FAILURE=1 restores shadow/low-sample after failed high-sample shadow-start (default)

Options:
  --execute                   Actually run fast.sh/exec_dep.sh or rollback
  --dry-run                   Print the exact stage plan without mutating state
  --repo owner/repo           Pass repository through to fast.sh and exec_dep.sh
  --sample-percent N          Shadow full sample percent for shadow/canary stages, default 1
  --min-observation-hours N   Require previous stage success to be at least N hours old, default 24
  --main-ref REF              Mainline ref that must be included by --commit, default origin/main
  --evidence-dir PATH         Evidence output directory, default .llmgw-release-evidence
  --ledger PATH               Append-only rollout ledger, default <evidence-dir>/rollout-ledger.jsonl
  LLMGW_STAGE_ALLOW_RELEASE_TREE_MISMATCH=1
  LLMGW_STAGE_ALLOW_SCRIPT_TREE_MISMATCH=1
                              Emergency bypass when local rollout/deploy files differ from --commit
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
shadow_full_sample_allowlist="${LLMGW_SHADOW_FULL_SAMPLE_APP_CALLER_ALLOWLIST:-}"
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
  canary-asr)
    mode="shadow"
    canary_stage="asr"
    allowlist="document-store.subtitle::asr,transcript-agent.transcribe::asr,video-agent.v2d.transcribe::asr,video-agent.video-to-text::asr"
    shadow_percent="$sample_percent"
    ;;
  canary-video-asr)
    mode="shadow"
    canary_stage="video-asr"
    allowlist="video-agent.videogen::video-gen,visual-agent.videogen::video-gen,document-store.subtitle::asr,transcript-agent.transcribe::asr,video-agent.v2d.transcribe::asr,video-agent.video-to-text::asr"
    shadow_percent="$sample_percent"
    ;;
  config-authority)
    mode="config-authority"
    canary_stage="config-authority"
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

if [ "$stage" != "rollback-inproc" ] && [ "$stage" != "rollback-rehearsal" ] && [ "$stage" != "config-authority" ]; then
  if [ -z "$gate_base" ]; then
    echo "ERROR: $stage requires LLMGW_GATE_BASE or GW_BASE" >&2
    exit 1
  fi
  if [ -z "$gate_key" ]; then
    echo "ERROR: $stage requires LLMGW_GATE_KEY, GW_KEY, or LLMGW_SERVE_KEY" >&2
    exit 1
  fi
fi
if [ "$stage" = "config-authority" ] || [ "$stage" = "http-full" ]; then
  console_base="$(printf '%s' "${LLMGW_CONSOLE_BASE:-}" | xargs || true)"
  console_token="$(printf '%s' "${LLMGW_CONSOLE_TOKEN:-}" | xargs || true)"
  console_user="$(printf '%s' "${LLMGW_CONSOLE_USER:-}" | xargs || true)"
  console_password="$(printf '%s' "${LLMGW_CONSOLE_PASSWORD:-}" | xargs || true)"
  if [ -z "$console_base" ]; then
    echo "ERROR: $stage requires LLMGW_CONSOLE_BASE" >&2
    exit 1
  fi
  if [ -z "$console_token" ] && { [ -z "$console_user" ] || [ -z "$console_password" ]; }; then
    echo "ERROR: $stage requires LLMGW_CONSOLE_TOKEN or LLMGW_CONSOLE_USER/LLMGW_CONSOLE_PASSWORD" >&2
    exit 1
  fi
fi

ts="$(date -u '+%Y%m%dT%H%M%SZ' 2>/dev/null || date '+%Y%m%dT%H%M%SZ')"
short_commit="$(printf '%s' "$commit" | cut -c1-12)"
evidence_prefix="$evidence_dir/${ts}_${stage}_${short_commit}"
release_gate_json="${evidence_prefix}.release-gate.json"
release_gate_md="${evidence_prefix}.release-gate.md"
rollout_status_json="${evidence_prefix}.rollout-status.json"
rollout_status_md="${evidence_prefix}.rollout-status.md"
serving_probe_json="${evidence_prefix}.serving-probe.json"
serving_probe_md="${evidence_prefix}.serving-probe.md"
smoke_json="${evidence_prefix}.gw-smoke.json"
smoke_md="${evidence_prefix}.gw-smoke.md"
prod_preflight_json="${evidence_prefix}.prod-preflight.json"
shadow_seed_json="${evidence_prefix}.map-shadow-seed.json"
upstream_readiness_json="${evidence_prefix}.upstream-readiness.json"
upstream_readiness_md="${evidence_prefix}.upstream-readiness.md"
provider_audit_json="${evidence_prefix}.provider-audit.json"
provider_audit_md="${evidence_prefix}.provider-audit.md"
protocol_router_audit_json="${evidence_prefix}.protocol-router-audit.json"
protocol_router_audit_md="${evidence_prefix}.protocol-router-audit.md"
video_canary_json="${evidence_prefix}.video-canary.json"
asr_http_canary_json="${evidence_prefix}.asr-http-canary.json"
config_authority_backup_json="${evidence_prefix}.config-authority-backup.json"
config_authority_backup_md="${evidence_prefix}.config-authority-backup.md"
config_authority_json="${evidence_prefix}.config-authority.json"
config_authority_md="${evidence_prefix}.config-authority.md"
stage_json="${evidence_prefix}.stage.json"
stage_md="${evidence_prefix}.stage.md"

case "$stage" in
  canary-asr|canary-video-asr|http-full)
    upstream_readiness_default=1
    ;;
  *)
    upstream_readiness_default=0
    ;;
esac
run_upstream_readiness="${LLMGW_STAGE_RUN_UPSTREAM_READINESS:-$upstream_readiness_default}"

case "$stage" in
  canary-video-asr|http-full)
    provider_audit_default=1
    ;;
  *)
    provider_audit_default=0
    ;;
esac
run_provider_audit="${LLMGW_STAGE_RUN_PROVIDER_AUDIT:-$provider_audit_default}"

case "$stage" in
  canary-video-asr|http-full)
    video_canary_default=1
    ;;
  *)
    video_canary_default=0
    ;;
esac
run_video_canary="${LLMGW_STAGE_RUN_VIDEO_CANARY:-$video_canary_default}"

case "$stage" in
  canary-asr|canary-video-asr|http-full)
    asr_http_canary_default=1
    ;;
  *)
    asr_http_canary_default=0
    ;;
esac
run_asr_http_canary="${LLMGW_STAGE_RUN_ASR_HTTP_CANARY:-$asr_http_canary_default}"
case "$stage" in
  http-full)
    disable_map_fallback_default=true
    ;;
  *)
    disable_map_fallback_default=false
    ;;
esac
disable_map_fallback_for_active_app_callers="${LLMGW_STAGE_DISABLE_MAP_CONFIG_FALLBACK_FOR_ACTIVE_APP_CALLERS:-$disable_map_fallback_default}"
smoke_required=1
if [ "${LLMGW_GATE_RUN_SMOKE:-1}" = "0" ]; then
  smoke_required=0
fi
route_matrix_raw="$(printf '%s' "${LLMGW_GATE_SMOKE_ROUTE_MATRIX:-0}" | xargs || true)"
case "$route_matrix_raw" in
  1|true|TRUE|yes|YES|on|ON)
    smoke_route_matrix=1
    ;;
  *)
    smoke_route_matrix=0
    ;;
esac
smoke_route_app_caller="$(printf '%s' "${LLMGW_GATE_SMOKE_ROUTE_APP_CALLER:-report-agent.generate::chat}" | xargs || true)"
smoke_route_model_type="$(printf '%s' "${LLMGW_GATE_SMOKE_ROUTE_MODEL_TYPE:-chat}" | xargs || true)"
smoke_route_pool_id="$(printf '%s' "${LLMGW_GATE_SMOKE_ROUTE_POOL_ID:-}" | xargs || true)"
smoke_route_pinned_platform_id="$(printf '%s' "${LLMGW_GATE_SMOKE_ROUTE_PINNED_PLATFORM_ID:-}" | xargs || true)"
smoke_route_pinned_model_id="$(printf '%s' "${LLMGW_GATE_SMOKE_ROUTE_PINNED_MODEL_ID:-}" | xargs || true)"
if [ "$smoke_route_matrix" = "1" ]; then
  if [ "$smoke_required" = "0" ]; then
    echo "ERROR: LLMGW_GATE_SMOKE_ROUTE_MATRIX=1 requires LLMGW_GATE_RUN_SMOKE to stay enabled." >&2
    exit 1
  fi
  if [ -z "$smoke_route_app_caller" ] || [ -z "$smoke_route_model_type" ]; then
    echo "ERROR: route matrix requires LLMGW_GATE_SMOKE_ROUTE_APP_CALLER and LLMGW_GATE_SMOKE_ROUTE_MODEL_TYPE." >&2
    exit 1
  fi
  if [ -z "$smoke_route_pool_id" ]; then
    echo "ERROR: route matrix requires LLMGW_GATE_SMOKE_ROUTE_POOL_ID." >&2
    exit 1
  fi
  if [ -z "$smoke_route_pinned_platform_id" ] || [ -z "$smoke_route_pinned_model_id" ]; then
    echo "ERROR: route matrix requires LLMGW_GATE_SMOKE_ROUTE_PINNED_PLATFORM_ID and LLMGW_GATE_SMOKE_ROUTE_PINNED_MODEL_ID." >&2
    exit 1
  fi
fi
disk_guard_path="${LLMGW_STAGE_DISK_GUARD_PATH:-$evidence_dir}"
disk_guard_min_free_mb="${LLMGW_STAGE_MIN_FREE_MB:-4096}"
allow_release_tree_mismatch="${LLMGW_STAGE_ALLOW_RELEASE_TREE_MISMATCH:-${LLMGW_STAGE_ALLOW_SCRIPT_TREE_MISMATCH:-0}}"

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
    echo "  shadowFullSampleAppCallerAllowlist: ${shadow_full_sample_allowlist:-empty}"
    echo "  disableMapConfigFallbackForActiveAppCallers: $disable_map_fallback_for_active_app_callers"
    echo "  gateBase: ${gate_base:-none}"
    echo "  releaseGateJson: $release_gate_json"
    echo "  rolloutStatusJson: $rollout_status_json"
    echo "  servingProbeJson: $serving_probe_json"
    echo "  smokeJson: $smoke_json"
    echo "  smokeRouteMatrix: $smoke_route_matrix"
    echo "  smokeRouteAppCaller: ${smoke_route_app_caller:-none}"
    echo "  smokeRouteModelType: ${smoke_route_model_type:-none}"
    echo "  smokeRoutePoolId: ${smoke_route_pool_id:-none}"
    echo "  smokeRoutePinnedPlatformId: ${smoke_route_pinned_platform_id:-none}"
    echo "  smokeRoutePinnedModelId: ${smoke_route_pinned_model_id:-none}"
    echo "  prodPreflightJson: $prod_preflight_json"
    echo "  shadowSeedJson: $shadow_seed_json"
    echo "  upstreamReadinessJson: $upstream_readiness_json"
    echo "  upstreamReadinessEnabled: $run_upstream_readiness"
    echo "  providerAuditJson: $provider_audit_json"
    echo "  providerAuditEnabled: $run_provider_audit"
    echo "  protocolRouterAuditJson: $protocol_router_audit_json"
    echo "  videoCanaryJson: $video_canary_json"
    echo "  videoCanaryEnabled: $run_video_canary"
    echo "  asrHttpCanaryJson: $asr_http_canary_json"
    echo "  asrHttpCanaryEnabled: $run_asr_http_canary"
    echo "  configAuthorityBackupJson: $config_authority_backup_json"
    echo "  configAuthorityJson: $config_authority_json"
    echo "  diskGuardPath: $disk_guard_path"
    echo "  diskGuardMinFreeMb: $disk_guard_min_free_mb"
    echo "  stageJson: $stage_json"
  fi
}

run_stage_disk_guard() {
  if [ "$stage" = "rollback-inproc" ] || [ "$stage" = "rollback-rehearsal" ]; then
    return 0
  fi
  if [ "$execute" != "1" ]; then
    echo "+ scripts/llmgw-disk-space-guard.sh \"$disk_guard_path\" \"$disk_guard_min_free_mb\" \"LLM Gateway production stage $stage\""
    return 0
  fi
  if [ ! -f "scripts/llmgw-disk-space-guard.sh" ]; then
    echo "ERROR: missing scripts/llmgw-disk-space-guard.sh; refusing production rollout without disk guard." >&2
    exit 1
  fi
  scripts/llmgw-disk-space-guard.sh "$disk_guard_path" "$disk_guard_min_free_mb" "LLM Gateway production stage $stage"
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
  if [ "$stage" = "rollback-rehearsal" ]; then
    echo "LLM Gateway rollback rehearsal: release main SHA recorded without ancestry enforcement mainRef=$main_ref mainSha=$main_sha"
    return 0
  fi
  if ! git merge-base --is-ancestor "$main_sha" "$commit"; then
    echo "ERROR: release commit does not include latest main. mainRef=$main_ref mainSha=$main_sha commit=$commit" >&2
    exit 1
  fi
  echo "LLM Gateway release main ancestry: OK mainRef=$main_ref mainSha=$main_sha"
}

validate_release_tree() {
  if [ "$stage" = "rollback-inproc" ]; then
    return 0
  fi

  critical_paths="
docker-compose.yml
cds-compose.yml
fast.sh
exec_dep.sh
execdep.sh
deploy/nginx/Dockerfile
deploy/nginx/nginx.conf
deploy/nginx/conf.d/branches/_disconnected.conf
deploy/nginx/conf.d/branches/_standalone.conf
scripts/llmgw-prod-stage.sh
scripts/llmgw-rollout-ledger.py
scripts/llmgw-rollout-status.py
scripts/llmgw-prod-preflight.py
scripts/llmgw-upstream-readiness.py
scripts/llmgw-prod-provider-config-audit.py
scripts/llmgw-protocol-router-audit.py
scripts/llmgw-map-shadow-seed.py
scripts/llmgw-report-agent-shadow-seed.py
scripts/llmgw-video-exchange-canary.py
scripts/llmgw-asr-http-canary.py
scripts/llmgw-release-gate.py
scripts/llmgw-config-authority-backup.sh
scripts/llmgw-config-authority-apply.py
scripts/llmgw-serving-probe.py
scripts/gw-smoke.py
scripts/llmgw-disk-space-guard.sh
scripts/llmgw-rollback-inproc.sh
scripts/llmgw-restore-shadow-safe.sh
"

  if [ "$execute" != "1" ]; then
    echo '+ git show "$commit:<critical rollout/deploy files>" | cmp local files'
    return 0
  fi

  mismatches=""
  for path in $critical_paths; do
    if [ ! -f "$path" ]; then
      mismatches="${mismatches}
missing local file: $path"
      continue
    fi
    if ! git cat-file -e "$commit:$path" 2>/dev/null; then
      mismatches="${mismatches}
missing in release commit: $path"
      continue
    fi
    if ! git show "$commit:$path" | cmp -s - "$path"; then
      mismatches="${mismatches}
release file differs from release commit: $path"
    fi
  done

  if [ -n "$mismatches" ]; then
    if [ "$allow_release_tree_mismatch" = "1" ] || [ "$allow_release_tree_mismatch" = "true" ]; then
      echo "WARN: local rollout/deploy files differ from release commit; continuing because release tree mismatch bypass is enabled." >&2
      printf '%s\n' "$mismatches" >&2
      return 0
    fi
    echo "ERROR: local rollout/deploy files must match --commit before executing LLM Gateway production stages." >&2
    echo "This prevents deploying one image commit with another commit's release gates, compose files, or nginx config." >&2
    printf '%s\n' "$mismatches" >&2
    echo "Checkout the release commit on the production runner, or set LLMGW_STAGE_ALLOW_RELEASE_TREE_MISMATCH=1 only for an explicitly reviewed emergency." >&2
    exit 1
  fi

  echo "LLM Gateway release tree: OK critical rollout/deploy files match commit=$commit"
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
    --disable-map-config-fallback-for-active-app-callers "$disable_map_fallback_for_active_app_callers" \
    --gate-base "$gate_base" \
    --evidence-json "$stage_json" \
    --evidence-md "$stage_md" \
    --release-gate-json "$release_gate_json" \
    --release-gate-required "${release_gate_required:-0}" \
    --prod-preflight-json "$prod_preflight_json" \
    --shadow-seed-json "$shadow_seed_json" \
    --upstream-readiness-json "$upstream_readiness_json" \
    --upstream-readiness-required "$run_upstream_readiness" \
    --provider-audit-json "$provider_audit_json" \
    --provider-audit-required "$run_provider_audit" \
    --protocol-router-audit-json "$protocol_router_audit_json" \
    --video-canary-json "$video_canary_json" \
    --video-canary-required "$run_video_canary" \
    --asr-http-canary-json "$asr_http_canary_json" \
    --asr-http-canary-required "$run_asr_http_canary" \
    --config-authority-json "$config_authority_json" \
    --external-backup-json "$config_authority_backup_json" \
    --serving-probe-json "$serving_probe_json" \
    --smoke-json "$smoke_json" \
    --smoke-required "$smoke_required" \
    --smoke-route-matrix-required "$smoke_route_matrix" \
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
  rollout_status_gate_enabled=0
  if rollout_status_ready_gate_required; then
    rollout_status_gate_enabled=1
  fi
  LLMGW_DRY_RUN_STAGE_JSON="$stage_json" \
  LLMGW_DRY_RUN_STAGE_MD="$stage_md" \
  LLMGW_DRY_RUN_STAGE="$stage" \
  LLMGW_DRY_RUN_COMMIT="$commit" \
  LLMGW_DRY_RUN_MODE="${mode:-}" \
  LLMGW_DRY_RUN_CANARY_STAGE="${canary_stage:-}" \
  LLMGW_DRY_RUN_ALLOWLIST="${allowlist:-}" \
  LLMGW_DRY_RUN_SHADOW_PERCENT="${shadow_percent:-}" \
  LLMGW_DRY_RUN_DISABLE_MAP_FALLBACK="${disable_map_fallback_for_active_app_callers:-false}" \
  LLMGW_DRY_RUN_GATE_BASE="${gate_base:-}" \
  LLMGW_DRY_RUN_ROLLOUT_STATUS_JSON="${rollout_status_json:-}" \
  LLMGW_DRY_RUN_ROLLOUT_STATUS_ENABLED="$rollout_status_gate_enabled" \
  LLMGW_DRY_RUN_REUSE_STATIC_DIST="${PRD_AGENT_REUSE_EXISTING_STATIC_DIST:-0}" \
  LLMGW_DRY_RUN_RELEASE_GATE_REQUIRED="${release_gate_required:-0}" \
  LLMGW_DRY_RUN_PROD_PREFLIGHT_JSON="${prod_preflight_json:-}" \
  LLMGW_DRY_RUN_SHADOW_SEED_JSON="${shadow_seed_json:-}" \
  LLMGW_DRY_RUN_UPSTREAM_READINESS_JSON="${upstream_readiness_json:-}" \
  LLMGW_DRY_RUN_UPSTREAM_READINESS_ENABLED="${run_upstream_readiness:-0}" \
  LLMGW_DRY_RUN_PROVIDER_AUDIT_JSON="${provider_audit_json:-}" \
  LLMGW_DRY_RUN_PROVIDER_AUDIT_ENABLED="${run_provider_audit:-0}" \
  LLMGW_DRY_RUN_PROTOCOL_ROUTER_AUDIT_JSON="${protocol_router_audit_json:-}" \
  LLMGW_DRY_RUN_PROTOCOL_ROUTER_AUDIT_MD="${protocol_router_audit_md:-}" \
  LLMGW_DRY_RUN_VIDEO_CANARY_JSON="${video_canary_json:-}" \
  LLMGW_DRY_RUN_VIDEO_CANARY_ENABLED="${run_video_canary:-0}" \
  LLMGW_DRY_RUN_ASR_HTTP_CANARY_JSON="${asr_http_canary_json:-}" \
  LLMGW_DRY_RUN_ASR_HTTP_CANARY_ENABLED="${run_asr_http_canary:-0}" \
  LLMGW_DRY_RUN_CONFIG_AUTHORITY_BACKUP_JSON="${config_authority_backup_json:-}" \
  LLMGW_DRY_RUN_CONFIG_AUTHORITY_BACKUP_MD="${config_authority_backup_md:-}" \
  LLMGW_DRY_RUN_CONFIG_AUTHORITY_JSON="${config_authority_json:-}" \
  LLMGW_DRY_RUN_CONFIG_AUTHORITY_MD="${config_authority_md:-}" \
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
if stage != "rollback-inproc":
    commands.append(
        "python3 scripts/llmgw-protocol-router-audit.py --json-out "
        + os.environ.get("LLMGW_DRY_RUN_PROTOCOL_ROUTER_AUDIT_JSON", "")
        + " --report-md "
        + os.environ.get("LLMGW_DRY_RUN_PROTOCOL_ROUTER_AUDIT_MD", "")
    )
if stage == "rollback-inproc":
    commands.append("scripts/llmgw-rollback-inproc.sh")
elif stage == "rollback-rehearsal":
    commands.append("LLMGW_ROLLBACK_DRY_RUN=1 scripts/llmgw-rollback-inproc.sh")
elif stage == "config-authority":
    commands.append(
        "LLMGW_CONFIG_AUTHORITY_BACKUP_DRY_RUN=1 "
        "LLMGW_CONFIG_AUTHORITY_BACKUP_JSON_OUT="
        + os.environ.get("LLMGW_DRY_RUN_CONFIG_AUTHORITY_BACKUP_JSON", "")
        + " LLMGW_CONFIG_AUTHORITY_BACKUP_REPORT_MD="
        + os.environ.get("LLMGW_DRY_RUN_CONFIG_AUTHORITY_BACKUP_MD", "")
        + " scripts/llmgw-config-authority-backup.sh"
    )
    commands.append(
        "python3 scripts/llmgw-config-authority-apply.py --base ${LLMGW_CONSOLE_BASE} "
        "--json-out "
        + os.environ.get("LLMGW_DRY_RUN_CONFIG_AUTHORITY_JSON", "")
        + " --report-md "
        + os.environ.get("LLMGW_DRY_RUN_CONFIG_AUTHORITY_MD", "")
        + " --require-ready"
    )
else:
    preflight = (
        "python3 scripts/llmgw-prod-preflight.py --mode start --expect-commit "
        + commit
    )
    map_base = os.environ.get("LLMGW_STAGE_MAP_BASE", "").strip() or os.environ.get("PRD_AGENT_BASE", "").strip()
    if map_base:
        preflight += " --map-base ${LLMGW_STAGE_MAP_BASE:-${PRD_AGENT_BASE:-}}"
    commands.append(
        preflight
    )
    if os.environ.get("LLMGW_DRY_RUN_ROLLOUT_STATUS_ENABLED", "0") == "1":
        commands.append(
            "GW_KEY=${LLMGW_GATE_KEY} "
            "python3 scripts/llmgw-rollout-status.py --base ${LLMGW_GATE_BASE} "
            "--release-commit "
            + commit
            + " --skip-global-cells --allow-window-extension --json-out "
            + os.environ.get("LLMGW_DRY_RUN_ROLLOUT_STATUS_JSON", "")
            + " --require-ready"
        )
    if os.environ.get("LLMGW_DRY_RUN_UPSTREAM_READINESS_ENABLED", "0") == "1":
        commands.append(
            "python3 scripts/llmgw-upstream-readiness.py --gw-base ${LLMGW_GATE_BASE} "
            "--gw-key-env LLMGW_GATE_KEY --json-out "
            + os.environ.get("LLMGW_DRY_RUN_UPSTREAM_READINESS_JSON", "")
        )
    if os.environ.get("LLMGW_DRY_RUN_PROVIDER_AUDIT_ENABLED", "0") == "1":
        commands.append(
            "python3 scripts/llmgw-prod-provider-config-audit.py --json-out "
            + os.environ.get("LLMGW_DRY_RUN_PROVIDER_AUDIT_JSON", "")
        )
    commands.append("./fast.sh --commit " + commit)
    exec_dep = "./exec_dep.sh --commit " + commit
    if os.environ.get("LLMGW_DRY_RUN_REUSE_STATIC_DIST", "0") in ("1", "true", "yes"):
        exec_dep = "PRD_AGENT_REUSE_EXISTING_STATIC_DIST=1 " + exec_dep
    commands.append(exec_dep)
    if os.environ.get("LLMGW_DRY_RUN_ASR_HTTP_CANARY_ENABLED", "0") == "1":
        commands.append(
            "PRD_AGENT_BASE=${PRD_AGENT_BASE:-${LLMGW_STAGE_MAP_BASE:-}} "
            "LLMGW_ASR_CANARY_JSON_OUT="
            + os.environ.get("LLMGW_DRY_RUN_ASR_HTTP_CANARY_JSON", "")
            + " python3 scripts/llmgw-asr-http-canary.py"
        )
    if os.environ.get("LLMGW_DRY_RUN_VIDEO_CANARY_ENABLED", "0") == "1":
        commands.append(
            "GW_BASE=${LLMGW_GATE_BASE} "
            "LLMGW_VIDEO_CANARY_JSON_OUT="
            + os.environ.get("LLMGW_DRY_RUN_VIDEO_CANARY_JSON", "")
            + " python3 scripts/llmgw-video-exchange-canary.py"
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
    "disableMapConfigFallbackForActiveAppCallers": os.environ.get("LLMGW_DRY_RUN_DISABLE_MAP_FALLBACK", ""),
    "gateBase": os.environ.get("LLMGW_DRY_RUN_GATE_BASE", ""),
    "rolloutStatusJson": os.environ.get("LLMGW_DRY_RUN_ROLLOUT_STATUS_JSON", ""),
    "rolloutStatusRequired": os.environ.get("LLMGW_DRY_RUN_ROLLOUT_STATUS_ENABLED", "0") == "1",
    "reuseExistingStaticDist": os.environ.get("LLMGW_DRY_RUN_REUSE_STATIC_DIST", "0") in ("1", "true", "yes"),
    "releaseGateRequired": os.environ.get("LLMGW_DRY_RUN_RELEASE_GATE_REQUIRED", "0") == "1",
    "prodPreflightJson": os.environ.get("LLMGW_DRY_RUN_PROD_PREFLIGHT_JSON", ""),
    "shadowSeedJson": os.environ.get("LLMGW_DRY_RUN_SHADOW_SEED_JSON", ""),
    "shadowSeedEnabled": os.environ.get("LLMGW_STAGE_RUN_SHADOW_SEED", "0") == "1",
    "upstreamReadinessJson": os.environ.get("LLMGW_DRY_RUN_UPSTREAM_READINESS_JSON", ""),
    "upstreamReadinessEnabled": os.environ.get("LLMGW_DRY_RUN_UPSTREAM_READINESS_ENABLED", "0") == "1",
    "providerAuditJson": os.environ.get("LLMGW_DRY_RUN_PROVIDER_AUDIT_JSON", ""),
    "providerAuditRequired": os.environ.get("LLMGW_DRY_RUN_PROVIDER_AUDIT_ENABLED", "0") == "1",
    "protocolRouterAuditJson": os.environ.get("LLMGW_DRY_RUN_PROTOCOL_ROUTER_AUDIT_JSON", ""),
    "protocolRouterAuditMd": os.environ.get("LLMGW_DRY_RUN_PROTOCOL_ROUTER_AUDIT_MD", ""),
    "videoCanaryJson": os.environ.get("LLMGW_DRY_RUN_VIDEO_CANARY_JSON", ""),
    "videoCanaryRequired": os.environ.get("LLMGW_DRY_RUN_VIDEO_CANARY_ENABLED", "0") == "1",
    "asrHttpCanaryJson": os.environ.get("LLMGW_DRY_RUN_ASR_HTTP_CANARY_JSON", ""),
    "asrHttpCanaryRequired": os.environ.get("LLMGW_DRY_RUN_ASR_HTTP_CANARY_ENABLED", "0") == "1",
    "configAuthorityBackupJson": os.environ.get("LLMGW_DRY_RUN_CONFIG_AUTHORITY_BACKUP_JSON", ""),
    "configAuthorityJson": os.environ.get("LLMGW_DRY_RUN_CONFIG_AUTHORITY_JSON", ""),
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
        "disableMapConfigFallbackForActiveAppCallers",
        "rolloutStatusRequired",
        "rolloutStatusJson",
        "releaseGateRequired",
        "shadowSeedEnabled",
        "shadowSeedJson",
        "upstreamReadinessEnabled",
        "upstreamReadinessJson",
        "configAuthorityBackupJson",
        "configAuthorityJson",
        "protocolRouterAuditJson",
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

allow_missing_map_logs_waiver_for_stage() {
  case "$stage" in
    canary-*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

run_prod_preflight() {
  if [ ! -f "scripts/llmgw-prod-preflight.py" ]; then
    echo "ERROR: missing scripts/llmgw-prod-preflight.py; refusing staged rollout without production preflight." >&2
    exit 1
  fi

  if [ "$execute" = "1" ]; then
    mkdir -p "$evidence_dir"
    preflight_args="--mode start --expect-commit $commit --json-out $prod_preflight_json"
    map_base="$(printf '%s' "${LLMGW_STAGE_MAP_BASE:-${PRD_AGENT_BASE:-}}" | xargs || true)"
    if [ -n "$map_base" ]; then
      preflight_args="$preflight_args --map-base $map_base"
    fi
    if [ "$stage" = "shadow-start" ]; then
      preflight_args="$preflight_args --allow-missing-gateway --allow-missing-map-logs"
    elif [ "${LLMGW_STAGE_ALLOW_MISSING_MAP_LOGS:-0}" = "1" ] && allow_missing_map_logs_waiver_for_stage; then
      preflight_args="$preflight_args --allow-missing-map-logs"
    fi
    # shellcheck disable=SC2086
    python3 scripts/llmgw-prod-preflight.py \
      $preflight_args
  else
    suffix=""
    map_base="$(printf '%s' "${LLMGW_STAGE_MAP_BASE:-${PRD_AGENT_BASE:-}}" | xargs || true)"
    if [ -n "$map_base" ]; then
      suffix="$suffix --map-base \"$map_base\""
    fi
    if [ "$stage" = "shadow-start" ]; then
      suffix="$suffix --allow-missing-gateway --allow-missing-map-logs"
    elif [ "${LLMGW_STAGE_ALLOW_MISSING_MAP_LOGS:-0}" = "1" ] && allow_missing_map_logs_waiver_for_stage; then
      suffix="$suffix --allow-missing-map-logs"
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

run_provider_audit_evidence() {
  if [ "$run_provider_audit" != "1" ]; then
    if [ "$execute" = "1" ]; then
      echo "LLM Gateway provider config audit skipped: LLMGW_STAGE_RUN_PROVIDER_AUDIT is not 1"
    else
      echo "LLM Gateway provider config audit dry-run skipped for this stage"
    fi
    return 0
  fi
  if [ ! -f "scripts/llmgw-prod-provider-config-audit.py" ]; then
    echo "ERROR: missing scripts/llmgw-prod-provider-config-audit.py; cannot collect provider config audit evidence." >&2
    exit 1
  fi
  seed_evidence_arg=""
  seed_evidence_path="${LLMGW_STAGE_PROVIDER_AUDIT_SEED_EVIDENCE_JSON:-}"
  if [ -n "$(printf '%s' "$seed_evidence_path" | xargs || true)" ]; then
    seed_evidence_arg=" --seed-evidence-json $seed_evidence_path"
  fi
  if [ "$execute" = "1" ]; then
    mkdir -p "$evidence_dir"
    # shellcheck disable=SC2086
    python3 scripts/llmgw-prod-provider-config-audit.py \
      --json-out "$provider_audit_json" \
      --report-md "$provider_audit_md" \
      $seed_evidence_arg
  else
    echo "+ python3 scripts/llmgw-prod-provider-config-audit.py --json-out \"$provider_audit_json\" --report-md \"$provider_audit_md\"$seed_evidence_arg"
  fi
}

run_protocol_router_audit_evidence() {
  if [ "$stage" = "rollback-inproc" ]; then
    return 0
  fi
  if [ ! -f "scripts/llmgw-protocol-router-audit.py" ]; then
    echo "ERROR: missing scripts/llmgw-protocol-router-audit.py; cannot collect protocol router target evidence." >&2
    exit 1
  fi
  if [ "$execute" = "1" ]; then
    mkdir -p "$evidence_dir"
    python3 scripts/llmgw-protocol-router-audit.py \
      --json-out "$protocol_router_audit_json" \
      --report-md "$protocol_router_audit_md"
  else
    echo "+ python3 scripts/llmgw-protocol-router-audit.py --json-out \"$protocol_router_audit_json\" --report-md \"$protocol_router_audit_md\""
  fi
}

run_asr_http_canary_evidence() {
  if [ "$run_asr_http_canary" != "1" ]; then
    if [ "$execute" = "1" ]; then
      echo "LLM Gateway ASR HTTP canary skipped: LLMGW_STAGE_RUN_ASR_HTTP_CANARY is not 1"
    else
      echo "LLM Gateway ASR HTTP canary dry-run skipped for this stage"
    fi
    return 0
  fi
  if [ ! -f "scripts/llmgw-asr-http-canary.py" ]; then
    echo "ERROR: missing scripts/llmgw-asr-http-canary.py; cannot collect ASR HTTP canary evidence." >&2
    exit 1
  fi
  map_base="$(printf '%s' "${PRD_AGENT_BASE:-${LLMGW_STAGE_MAP_BASE:-}}" | xargs || true)"
  if [ -z "$map_base" ]; then
    echo "ERROR: ASR HTTP canary requires PRD_AGENT_BASE or LLMGW_STAGE_MAP_BASE, for example https://host" >&2
    exit 1
  fi
  if [ "$execute" = "1" ]; then
    mkdir -p "$evidence_dir"
    PRD_AGENT_BASE="$map_base" \
    LLMGW_ASR_CANARY_JSON_OUT="$asr_http_canary_json" \
    python3 scripts/llmgw-asr-http-canary.py
  else
    echo "+ PRD_AGENT_BASE=\"$map_base\" LLMGW_ASR_CANARY_JSON_OUT=\"$asr_http_canary_json\" python3 scripts/llmgw-asr-http-canary.py"
  fi
}

run_video_canary_evidence() {
  if [ "$run_video_canary" != "1" ]; then
    if [ "$execute" = "1" ]; then
      echo "LLM Gateway video canary skipped: LLMGW_STAGE_RUN_VIDEO_CANARY is not 1"
    else
      echo "LLM Gateway video canary dry-run skipped for this stage"
    fi
    return 0
  fi
  if [ ! -f "scripts/llmgw-video-exchange-canary.py" ]; then
    echo "ERROR: missing scripts/llmgw-video-exchange-canary.py; cannot collect video canary evidence." >&2
    exit 1
  fi
  if [ "$execute" = "1" ]; then
    mkdir -p "$evidence_dir"
    GW_BASE="$gate_base" \
    GW_KEY="$gate_key" \
    LLMGW_VIDEO_CANARY_JSON_OUT="$video_canary_json" \
    python3 scripts/llmgw-video-exchange-canary.py
  else
    echo "+ GW_BASE=\"$gate_base\" LLMGW_VIDEO_CANARY_JSON_OUT=\"$video_canary_json\" python3 scripts/llmgw-video-exchange-canary.py"
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
  if [ "$stage" = "shadow-start" ] && [ "${shadow_percent:-0}" != "0" ] && [ "${shadow_percent:-0}" != "1" ]; then
    echo "WARN: shadow-start failed while ShadowFullSamplePercent=$shadow_percent. Restore a low sampling value before leaving production unattended." >&2
    if [ "${LLMGW_STAGE_AUTO_RESTORE_SHADOW_ON_FAILURE:-1}" = "1" ]; then
      if [ -f "scripts/llmgw-restore-shadow-safe.sh" ]; then
        echo "LLM Gateway production stage failed; restoring conservative shadow sampling." >&2
        if LLMGW_RESTORE_SHADOW_FULL_SAMPLE_PERCENT="${LLMGW_STAGE_RESTORE_SHADOW_FULL_SAMPLE_PERCENT:-1}" \
          scripts/llmgw-restore-shadow-safe.sh >/dev/null 2>&1; then
          echo "LLM Gateway production stage: conservative shadow sampling restored." >&2
        else
          echo "WARN: failed to restore conservative shadow sampling automatically; run scripts/llmgw-restore-shadow-safe.sh manually." >&2
        fi
      else
        echo "WARN: missing scripts/llmgw-restore-shadow-safe.sh; cannot restore conservative shadow sampling automatically." >&2
      fi
    else
      echo "WARN: automatic shadow sampling restore disabled by LLMGW_STAGE_AUTO_RESTORE_SHADOW_ON_FAILURE." >&2
    fi
  fi
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

rollout_status_ready_gate_required() {
  case "$stage" in
    canary-intent-text)
      return 0
      ;;
    *)
      [ "${LLMGW_STAGE_RUN_ROLLOUT_STATUS_GATE:-0}" = "1" ]
      ;;
  esac
}

run_rollout_status_ready_gate() {
  if ! rollout_status_ready_gate_required; then
    return 0
  fi
  if [ ! -f "scripts/llmgw-rollout-status.py" ]; then
    echo "ERROR: missing scripts/llmgw-rollout-status.py; cannot check rollout readiness before $stage." >&2
    exit 1
  fi
  status_since_hours="${LLMGW_STATUS_SINCE_HOURS:-${LLMGW_GATE_SHADOW_SINCE_HOURS:-48}}"
  status_min_coverage_hours="${LLMGW_STATUS_MIN_COVERAGE_HOURS:-${LLMGW_GATE_MIN_COVERAGE_HOURS:-24}}"
  if [ "$execute" = "1" ]; then
    mkdir -p "$evidence_dir"
    GW_KEY="$gate_key" \
    python3 scripts/llmgw-rollout-status.py \
      --base "$gate_base" \
      --release-commit "$commit" \
      --since-hours "$status_since_hours" \
      --min-coverage-hours "$status_min_coverage_hours" \
      --skip-global-cells \
      --allow-window-extension \
      --json-out "$rollout_status_json" \
      --report-md "$rollout_status_md" \
      --require-ready
  else
    echo "+ GW_KEY=\"***\" python3 scripts/llmgw-rollout-status.py --base \"$gate_base\" --release-commit \"$commit\" --since-hours \"$status_since_hours\" --min-coverage-hours \"$status_min_coverage_hours\" --skip-global-cells --allow-window-extension --json-out \"$rollout_status_json\" --report-md \"$rollout_status_md\" --require-ready"
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

run_stage_disk_guard

validate_ledger_order
validate_main_ancestry
validate_release_tree
run_protocol_router_audit_evidence
run_rollout_status_ready_gate

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
      --disable-map-config-fallback-for-active-app-callers "$disable_map_fallback_for_active_app_callers" \
      --gate-base "$gate_base" \
      --release-gate-json "$release_gate_json" \
      --release-gate-required "$release_gate_required" \
      --prod-preflight-json "$prod_preflight_json" \
      --shadow-seed-json "$shadow_seed_json" \
      --upstream-readiness-json "$upstream_readiness_json" \
      --upstream-readiness-required "$run_upstream_readiness" \
      --provider-audit-json "$provider_audit_json" \
      --provider-audit-required "$run_provider_audit" \
      --protocol-router-audit-json "$protocol_router_audit_json" \
      --video-canary-json "$video_canary_json" \
      --video-canary-required "$run_video_canary" \
      --asr-http-canary-json "$asr_http_canary_json" \
      --asr-http-canary-required "$run_asr_http_canary" \
      --config-authority-json "$config_authority_json" \
      --serving-probe-json "$serving_probe_json" \
      --smoke-json "$smoke_json" \
      --smoke-required "$smoke_required" \
      --smoke-route-matrix-required "$smoke_route_matrix" \
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

if [ "$stage" = "config-authority" ]; then
  release_gate_required=0
  if [ "$execute" = "1" ]; then
    mkdir -p "$evidence_dir"
    LLMGW_CONFIG_AUTHORITY_BACKUP_DRY_RUN=0 \
    LLMGW_CONFIG_AUTHORITY_BACKUP_JSON_OUT="$config_authority_backup_json" \
    LLMGW_CONFIG_AUTHORITY_BACKUP_REPORT_MD="$config_authority_backup_md" \
    scripts/llmgw-config-authority-backup.sh
    python3 scripts/llmgw-config-authority-apply.py \
      --base "$console_base" \
      --execute \
      --require-ready \
      --json-out "$config_authority_json" \
      --report-md "$config_authority_md"
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
      --disable-map-config-fallback-for-active-app-callers "$disable_map_fallback_for_active_app_callers" \
      --gate-base "$gate_base" \
      --release-gate-json "$release_gate_json" \
      --release-gate-required "$release_gate_required" \
      --prod-preflight-json "$prod_preflight_json" \
      --shadow-seed-json "$shadow_seed_json" \
      --upstream-readiness-json "$upstream_readiness_json" \
      --upstream-readiness-required "$run_upstream_readiness" \
      --provider-audit-json "$provider_audit_json" \
      --provider-audit-required "$run_provider_audit" \
      --protocol-router-audit-json "$protocol_router_audit_json" \
      --video-canary-json "$video_canary_json" \
      --video-canary-required "$run_video_canary" \
      --asr-http-canary-json "$asr_http_canary_json" \
      --asr-http-canary-required "$run_asr_http_canary" \
      --config-authority-json "$config_authority_json" \
      --external-backup-json "$config_authority_backup_json" \
      --serving-probe-json "$serving_probe_json" \
      --smoke-json "$smoke_json" \
      --smoke-required "$smoke_required" \
      --smoke-route-matrix-required "$smoke_route_matrix" \
      --main-ref "$main_ref" \
      --main-sha "$main_sha" \
      --allow-out-of-order "$allow_out_of_order" \
      --allow-out-of-order-reason "$allow_out_of_order_reason" \
      --min-stage-observation-hours "$min_observation_hours"
    append_ledger_entry success
    rollout_ledger_status="success"
  else
    write_dry_run_stage_report
    echo "Dry-run only. Add --execute to run config authority migration."
  fi
  exit 0
fi

export LLMGW_MODE="$mode"
export LLMGW_PROD_STAGE_ACTIVE=1
export LLMGW_PROD_STAGE="$stage"
export LLMGW_HTTP_APP_CALLER_ALLOWLIST="$allowlist"
export LLMGW_CANARY_STAGE="$canary_stage"
export LLMGW_SHADOW_FULL_SAMPLE_PERCENT="$shadow_percent"
export LLMGW_SHADOW_FULL_SAMPLE_APP_CALLER_ALLOWLIST="$shadow_full_sample_allowlist"
export LLMGW_DISABLE_MAP_CONFIG_FALLBACK_FOR_ACTIVE_APP_CALLERS="$disable_map_fallback_for_active_app_callers"
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
export LLMGW_SERVING_PROBE_REQUIRE_ROUTE_SELF_TEST="${LLMGW_SERVING_PROBE_REQUIRE_ROUTE_SELF_TEST:-1}"
export GW_SMOKE_JSON_OUT="${GW_SMOKE_JSON_OUT:-$smoke_json}"
export GW_SMOKE_REPORT_MD="${GW_SMOKE_REPORT_MD:-$smoke_md}"
export GW_SMOKE_ROUTE_MATRIX="${GW_SMOKE_ROUTE_MATRIX:-$smoke_route_matrix}"
export GW_SMOKE_ROUTE_APP_CALLER="${GW_SMOKE_ROUTE_APP_CALLER:-$smoke_route_app_caller}"
export GW_SMOKE_ROUTE_MODEL_TYPE="${GW_SMOKE_ROUTE_MODEL_TYPE:-$smoke_route_model_type}"
export GW_SMOKE_ROUTE_POOL_ID="${GW_SMOKE_ROUTE_POOL_ID:-$smoke_route_pool_id}"
export GW_SMOKE_ROUTE_PINNED_PLATFORM_ID="${GW_SMOKE_ROUTE_PINNED_PLATFORM_ID:-$smoke_route_pinned_platform_id}"
export GW_SMOKE_ROUTE_PINNED_MODEL_ID="${GW_SMOKE_ROUTE_PINNED_MODEL_ID:-$smoke_route_pinned_model_id}"
export LLMGW_GATE_SHADOW_SINCE_HOURS="${LLMGW_GATE_SHADOW_SINCE_HOURS:-48}"
export LLMGW_GATE_HEALTH_SAMPLES="${LLMGW_GATE_HEALTH_SAMPLES:-3}"
export LLMGW_GATE_HEALTH_INTERVAL_SECONDS="${LLMGW_GATE_HEALTH_INTERVAL_SECONDS:-5}"
case "$stage" in
  canary-intent-text|canary-chat|canary-streaming)
    export GW_SMOKE_MODEL_TYPES="${GW_SMOKE_MODEL_TYPES:-chat}"
    ;;
esac
if [ "$stage" = "shadow-start" ]; then
  export PRD_AGENT_REUSE_EXISTING_STATIC_DIST="${PRD_AGENT_REUSE_EXISTING_STATIC_DIST:-1}"
fi

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

run_upstream_readiness_evidence

run_provider_audit_evidence

if [ -n "$repo" ]; then
  run_or_print ./fast.sh --commit "$commit" --repo "$repo"
  run_or_print ./exec_dep.sh --commit "$commit" --repo "$repo"
else
  run_or_print ./fast.sh --commit "$commit"
  run_or_print ./exec_dep.sh --commit "$commit"
fi

run_video_canary_evidence

run_asr_http_canary_evidence

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
    --disable-map-config-fallback-for-active-app-callers "$disable_map_fallback_for_active_app_callers" \
    --gate-base "$gate_base" \
    --release-gate-json "$release_gate_json" \
    --release-gate-required "$release_gate_required" \
    --prod-preflight-json "$prod_preflight_json" \
    --shadow-seed-json "$shadow_seed_json" \
    --upstream-readiness-json "$upstream_readiness_json" \
    --upstream-readiness-required "$run_upstream_readiness" \
    --provider-audit-json "$provider_audit_json" \
    --provider-audit-required "$run_provider_audit" \
    --protocol-router-audit-json "$protocol_router_audit_json" \
    --video-canary-json "$video_canary_json" \
    --video-canary-required "$run_video_canary" \
    --asr-http-canary-json "$asr_http_canary_json" \
    --asr-http-canary-required "$run_asr_http_canary" \
    --config-authority-json "$config_authority_json" \
    --external-backup-json "$config_authority_backup_json" \
    --serving-probe-json "$serving_probe_json" \
    --smoke-json "$smoke_json" \
    --smoke-required "$smoke_required" \
    --smoke-route-matrix-required "$smoke_route_matrix" \
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
