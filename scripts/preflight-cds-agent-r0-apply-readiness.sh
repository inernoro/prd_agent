#!/usr/bin/env bash
# Local-only R0 apply/deploy readiness check.
# It reads the latest remote-host dry-run summary and current env names, but never
# calls CDS and never prints secret values.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SUMMARY="${CDS_AGENT_REMOTE_HOST_SUMMARY:-/tmp/cds-agent-remote-host-pool-current-readonly-live/summary.json}"
REPORT="${CDS_AGENT_R0_READINESS_REPORT:-/tmp/cds-agent-r0-apply-readiness-current.json}"
EXPECTED_CDS_HOST="${CDS_AGENT_EXPECTED_CDS_HOST:-https://cds.miduo.org}"
SIDECAR_DOCKERFILE="${CDS_AGENT_SIDECAR_DOCKERFILE:-claude-sdk-sidecar/Dockerfile}"
SIDECAR_BUILD_CONTEXT="${CDS_AGENT_SIDECAR_BUILD_CONTEXT:-claude-sdk-sidecar}"
SIDECAR_CANDIDATE_IMAGE="${CDS_AGENT_SIDECAR_CANDIDATE_IMAGE:-prd-agent/claude-sidecar:latest}"
SIDECAR_IMAGE_PREFLIGHT_REPORT="${CDS_AGENT_SIDECAR_IMAGE_PREFLIGHT_REPORT:-/tmp/cds-agent-sidecar-image-preflight-current.json}"
SIDECAR_REGISTRY_VERIFY_REPORT="${CDS_AGENT_SIDECAR_REGISTRY_VERIFY_REPORT:-/tmp/cds-agent-sidecar-registry-image-current.json}"
REMOTE_PULL_REPORT="${CDS_AGENT_REMOTE_PULL_REPORT:-/tmp/cds-agent-remote-sidecar-pull-current.json}"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || fail "missing dependency: jq"
[[ -f "$SUMMARY" ]] || fail "remote host summary not found: $SUMMARY"

has_env() {
  local name="$1"
  [[ -n "${!name:-}" ]]
}

append_json_string() {
  jq --arg value "$2" '. + [$value]' <<< "$1"
}

missing='[]'
invalid='[]'
warnings='[]'

summary_verdict=$(jq -r '.verdict // .status // "unknown"' "$SUMMARY")
target_host_id=$(jq -r '(if has("prepare") and .prepare != null then .prepare.targetHostId else null end) // ""' "$SUMMARY")
enabled_hosts=$(jq -r '(if has("prepare") and .prepare != null then .prepare.enabledHostCount else .beforeEnabledRemoteHostCount end) // 0' "$SUMMARY")
shared_running=$(jq -r '.beforeSharedRunning // 0' "$SUMMARY")
will_create_host=$(jq -r '(if has("prepare") and .prepare != null then .prepare.willCreateHost else true end) // true' "$SUMMARY")

cds_host="${CDS_HOST:-}"
if [[ -z "$cds_host" ]]; then
  missing=$(append_json_string "$missing" "CDS_HOST")
elif [[ "${cds_host%/}" != "${EXPECTED_CDS_HOST%/}" ]]; then
  warnings=$(append_json_string "$warnings" "CDS_HOST is ${cds_host}; expected ${EXPECTED_CDS_HOST} for remote CDS recovery commands")
fi

if ! has_env AI_ACCESS_KEY && ! has_env CDS_PROJECT_KEY; then
  missing=$(append_json_string "$missing" "AI_ACCESS_KEY or CDS_PROJECT_KEY")
fi

if [[ -z "${CDS_REMOTE_HOST_ID:-$target_host_id}" ]]; then
  will_create_host="true"
  has_env CDS_REMOTE_HOST_NAME || missing=$(append_json_string "$missing" "CDS_REMOTE_HOST_NAME")
  has_env CDS_REMOTE_HOST_HOST || missing=$(append_json_string "$missing" "CDS_REMOTE_HOST_HOST")
  has_env CDS_REMOTE_HOST_SSH_USER || missing=$(append_json_string "$missing" "CDS_REMOTE_HOST_SSH_USER")
  if ! has_env CDS_REMOTE_HOST_SSH_PRIVATE_KEY && ! has_env CDS_REMOTE_HOST_SSH_PRIVATE_KEY_FILE; then
    missing=$(append_json_string "$missing" "CDS_REMOTE_HOST_SSH_PRIVATE_KEY or CDS_REMOTE_HOST_SSH_PRIVATE_KEY_FILE")
  fi
else
  will_create_host="false"
fi

if [[ -n "${CDS_REMOTE_HOST_HOST:-}" && "$CDS_REMOTE_HOST_HOST" == *"://"* ]]; then
  invalid=$(append_json_string "$invalid" "CDS_REMOTE_HOST_HOST must be hostname/IP, not URL")
fi
if [[ -n "${CDS_REMOTE_HOST_SSH_PORT:-}" && ! "$CDS_REMOTE_HOST_SSH_PORT" =~ ^[0-9]+$ ]]; then
  invalid=$(append_json_string "$invalid" "CDS_REMOTE_HOST_SSH_PORT must be numeric")
fi
if [[ -n "${CDS_REMOTE_HOST_SSH_PRIVATE_KEY_FILE:-}" ]]; then
  if [[ ! -f "$CDS_REMOTE_HOST_SSH_PRIVATE_KEY_FILE" ]]; then
    invalid=$(append_json_string "$invalid" "CDS_REMOTE_HOST_SSH_PRIVATE_KEY_FILE does not exist")
  elif ! grep -q -- 'BEGIN .*PRIVATE KEY' "$CDS_REMOTE_HOST_SSH_PRIVATE_KEY_FILE"; then
    invalid=$(append_json_string "$invalid" "CDS_REMOTE_HOST_SSH_PRIVATE_KEY_FILE does not look like a private key")
  fi
elif [[ -n "${CDS_REMOTE_HOST_SSH_PRIVATE_KEY:-}" && "$CDS_REMOTE_HOST_SSH_PRIVATE_KEY" != *"BEGIN "*PRIVATE\ KEY* ]]; then
  invalid=$(append_json_string "$invalid" "CDS_REMOTE_HOST_SSH_PRIVATE_KEY does not look like a private key")
fi

image_status="missing"
image_value=""
image_next_action="publish a pullable sidecar image and set CDS_AGENT_SIDECAR_IMAGE"
if ! has_env CDS_AGENT_SIDECAR_IMAGE; then
  missing=$(append_json_string "$missing" "CDS_AGENT_SIDECAR_IMAGE")
elif [[ "$CDS_AGENT_SIDECAR_IMAGE" =~ [[:space:]] ]]; then
  image_status="invalid"
  image_value="$CDS_AGENT_SIDECAR_IMAGE"
  image_next_action="remove whitespace from CDS_AGENT_SIDECAR_IMAGE"
  invalid=$(append_json_string "$invalid" "CDS_AGENT_SIDECAR_IMAGE must not contain whitespace")
else
  image_status="provided_unverified"
  image_value="$CDS_AGENT_SIDECAR_IMAGE"
  image_next_action="ensure the remote host can docker pull this image"
fi

image_preflight='null'
image_build_context_status="unknown"
registry_manifest_status="not checked"
registry_manifest_visible=false
registry_report_image=""
remote_pull_status="not checked"
remote_pull_passed=false
remote_pull_report_image=""
if [[ -x "$SCRIPT_DIR/preflight-cds-agent-sidecar-image.sh" ]]; then
  CDS_AGENT_SIDECAR_IMAGE_PREFLIGHT_REPORT="$SIDECAR_IMAGE_PREFLIGHT_REPORT" \
  CDS_AGENT_SIDECAR_DOCKERFILE="$SIDECAR_DOCKERFILE" \
  CDS_AGENT_SIDECAR_BUILD_CONTEXT="$SIDECAR_BUILD_CONTEXT" \
  CDS_AGENT_SIDECAR_CANDIDATE_IMAGE="$SIDECAR_CANDIDATE_IMAGE" \
    bash "$SCRIPT_DIR/preflight-cds-agent-sidecar-image.sh" >/dev/null 2>&1 || true
fi
if [[ -f "$SIDECAR_IMAGE_PREFLIGHT_REPORT" ]]; then
  image_preflight=$(jq -c '.' "$SIDECAR_IMAGE_PREFLIGHT_REPORT")
  image_status=$(jq -r '.image.status // "unknown"' "$SIDECAR_IMAGE_PREFLIGHT_REPORT")
  image_value=$(jq -r '.image.value // ""' "$SIDECAR_IMAGE_PREFLIGHT_REPORT")
  image_next_action=$(jq -r '.image.nextAction // "unknown"' "$SIDECAR_IMAGE_PREFLIGHT_REPORT")
  image_build_context_status=$(jq -r '.buildContext.status // "unknown"' "$SIDECAR_IMAGE_PREFLIGHT_REPORT")
  if [[ "$image_build_context_status" == "invalid" ]]; then
    invalid=$(append_json_string "$invalid" "sidecar build context is invalid")
  fi
  if [[ "$image_status" == "invalid" ]]; then
    invalid=$(append_json_string "$invalid" "CDS_AGENT_SIDECAR_IMAGE is not safe for CDS docker pull/run")
  fi
fi

if [[ -f "$SIDECAR_REGISTRY_VERIFY_REPORT" ]]; then
  registry_manifest_status=$(jq -r '.status // "unknown"' "$SIDECAR_REGISTRY_VERIFY_REPORT")
  registry_manifest_visible=$(jq -r '.manifestVisible // false' "$SIDECAR_REGISTRY_VERIFY_REPORT")
  registry_report_image=$(jq -r '.image // ""' "$SIDECAR_REGISTRY_VERIFY_REPORT")
fi
if [[ -f "$REMOTE_PULL_REPORT" ]]; then
  remote_pull_status=$(jq -r '.status // "unknown"' "$REMOTE_PULL_REPORT")
  remote_pull_passed=$(jq -r '.pullPassed // false' "$REMOTE_PULL_REPORT")
  remote_pull_report_image=$(jq -r '.image // ""' "$REMOTE_PULL_REPORT")
fi

if [[ -n "$image_value" ]]; then
  if [[ "$registry_manifest_visible" != "true" || "$registry_report_image" != "$image_value" ]]; then
    warnings=$(append_json_string "$warnings" "sidecar registry manifest has not been verified for CDS_AGENT_SIDECAR_IMAGE")
  fi
  if [[ "$remote_pull_passed" != "true" || "$remote_pull_report_image" != "$image_value" ]]; then
    warnings=$(append_json_string "$warnings" "remote host docker pull has not passed for CDS_AGENT_SIDECAR_IMAGE")
  fi
fi

missing_count=$(jq 'length' <<< "$missing")
invalid_count=$(jq 'length' <<< "$invalid")
ready_for_host_apply=false
ready_for_deploy_request=false
ready_for_r0_apply=false
if [[ "$invalid_count" -eq 0 ]]; then
  create_missing_count=$(jq '[.[] | select(. != "CDS_AGENT_SIDECAR_IMAGE")] | length' <<< "$missing")
  if [[ "$create_missing_count" -eq 0 ]]; then
    ready_for_host_apply=true
  fi
  if has_env CDS_AGENT_SIDECAR_IMAGE && { [[ -n "${CDS_REMOTE_HOST_ID:-$target_host_id}" ]] || [[ "$ready_for_host_apply" == "true" ]]; }; then
    ready_for_deploy_request=true
  fi
  if [[ "$missing_count" -eq 0 ]]; then
    ready_for_r0_apply=true
  fi
fi

next_action="continue R0.2.4 MAP adapter session transport and managed-runtime smoke before any fallback env handoff"
if [[ "$invalid_count" -gt 0 ]]; then
  next_action="fix invalid fallback env before any operator apply"
elif [[ "$ready_for_r0_apply" == "true" ]]; then
  next_action="operator fallback ready: run remote host apply + shared runtime deploy with evidence"
elif [[ "$ready_for_host_apply" == "true" ]]; then
  next_action="operator fallback image input required before shared runtime deploy"
fi

mkdir -p "$(dirname "$REPORT")"
tmp_report="${REPORT}.tmp.$$"
trap 'rm -f "$tmp_report"' EXIT
jq -n \
  --arg generatedAt "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
  --arg summary "$SUMMARY" \
  --arg report "$REPORT" \
  --arg summaryVerdict "$summary_verdict" \
  --arg targetHostId "${CDS_REMOTE_HOST_ID:-$target_host_id}" \
  --argjson enabledHostCount "$enabled_hosts" \
  --argjson sharedRunning "$shared_running" \
  --argjson willCreateHost "$will_create_host" \
  --argjson readyForHostApply "$ready_for_host_apply" \
  --argjson readyForDeployRequest "$ready_for_deploy_request" \
  --argjson readyForR0Apply "$ready_for_r0_apply" \
  --arg nextAction "$next_action" \
  --argjson missing "$missing" \
  --argjson invalid "$invalid" \
  --argjson warnings "$warnings" \
  --arg sidecarDockerfile "$SIDECAR_DOCKERFILE" \
  --arg sidecarBuildContext "$SIDECAR_BUILD_CONTEXT" \
  --arg sidecarCandidateImage "$SIDECAR_CANDIDATE_IMAGE" \
  --arg imageStatus "$image_status" \
  --arg imageValue "$image_value" \
  --arg imageNextAction "$image_next_action" \
  --arg imagePreflightReport "$SIDECAR_IMAGE_PREFLIGHT_REPORT" \
  --arg imageBuildContextStatus "$image_build_context_status" \
  --arg registryReport "$SIDECAR_REGISTRY_VERIFY_REPORT" \
  --arg registryManifestStatus "$registry_manifest_status" \
  --arg registryReportImage "$registry_report_image" \
  --argjson registryManifestVisible "$registry_manifest_visible" \
  --arg remotePullReport "$REMOTE_PULL_REPORT" \
  --arg remotePullStatus "$remote_pull_status" \
  --arg remotePullReportImage "$remote_pull_report_image" \
  --argjson remotePullPassed "$remote_pull_passed" \
  --argjson imagePreflight "$image_preflight" \
  '{
    generatedAt: $generatedAt,
    summary: $summary,
    report: $report,
    summaryVerdict: $summaryVerdict,
    remoteState: {
      targetHostId: (if $targetHostId == "" then null else $targetHostId end),
      enabledHostCount: $enabledHostCount,
      sharedRunning: $sharedRunning,
      willCreateHost: $willCreateHost
    },
    readyForHostApply: $readyForHostApply,
    readyForDeployRequest: $readyForDeployRequest,
    readyForR0Apply: $readyForR0Apply,
    nextAction: $nextAction,
    missingConfig: $missing,
    invalidConfig: $invalid,
    warnings: $warnings,
    imageReadiness: {
      status: $imageStatus,
      value: (if $imageValue == "" then null else $imageValue end),
      dockerfile: $sidecarDockerfile,
      buildContext: $sidecarBuildContext,
      deployerMode: "docker-pull-only",
      remoteHostRequirement: "image reference must be pullable from the target remote host",
      candidateImage: $sidecarCandidateImage,
      candidateBuildCommand: ("docker build -t " + $sidecarCandidateImage + " " + $sidecarBuildContext),
      candidatePushCommand: ("docker push " + $sidecarCandidateImage),
      nextAction: $imageNextAction,
      preflightReport: $imagePreflightReport,
      buildContextStatus: $imageBuildContextStatus,
      preflight: $imagePreflight,
      registryManifest: {
        report: $registryReport,
        status: $registryManifestStatus,
        visible: $registryManifestVisible,
        image: (if $registryReportImage == "" then null else $registryReportImage end),
        matchesCurrentImage: ($registryReportImage != "" and $registryReportImage == $imageValue)
      },
      remotePull: {
        report: $remotePullReport,
        status: $remotePullStatus,
        passed: $remotePullPassed,
        image: (if $remotePullReportImage == "" then null else $remotePullReportImage end),
        matchesCurrentImage: ($remotePullReportImage != "" and $remotePullReportImage == $imageValue)
      }
    },
    safeHandoffCommand: ("scripts/print-cds-agent-remote-host-handoff.sh " + $summary)
  }' > "$tmp_report"
mv "$tmp_report" "$REPORT"

printf '# CDS Agent R0 Apply Readiness\n\n'
jq -r '
  "- report: `" + .report + "`",
  "- summary: `" + .summary + "`",
  "- summaryVerdict: `" + .summaryVerdict + "`",
  "- readyForHostApply: `" + (.readyForHostApply|tostring) + "`",
  "- readyForDeployRequest: `" + (.readyForDeployRequest|tostring) + "`",
  "- readyForR0Apply: `" + (.readyForR0Apply|tostring) + "`",
  "- nextAction: `" + .nextAction + "`",
  "- missingConfig: `" + ((.missingConfig // []) | join(", ")) + "`",
  "- invalidConfig: `" + ((.invalidConfig // []) | join(", ")) + "`",
  "- warnings: `" + ((.warnings // []) | join(", ")) + "`",
  "- imageReadiness: `" + (.imageReadiness.status // "unknown") + "`",
  "- imageBuildContext: `" + (.imageReadiness.buildContextStatus // "unknown") + "`",
  "- imageRegistryManifest: `" + (.imageReadiness.registryManifest.status // "unknown") + "`",
  "- imageRemotePull: `" + (.imageReadiness.remotePull.status // "unknown") + "`",
  "- imageNextAction: `" + (.imageReadiness.nextAction // "unknown") + "`"
' "$REPORT"
