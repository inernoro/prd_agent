#!/usr/bin/env bash
# Local-only R0 apply/deploy readiness check.
# It reads the latest remote-host dry-run summary and current env names, but never
# calls CDS and never prints secret values.

set -euo pipefail

SUMMARY="${CDS_AGENT_REMOTE_HOST_SUMMARY:-/tmp/cds-agent-remote-host-pool-current-readonly-live/summary.json}"
REPORT="${CDS_AGENT_R0_READINESS_REPORT:-/tmp/cds-agent-r0-apply-readiness-current.json}"
EXPECTED_CDS_HOST="${CDS_AGENT_EXPECTED_CDS_HOST:-https://cds.miduo.org}"
SIDECAR_DOCKERFILE="${CDS_AGENT_SIDECAR_DOCKERFILE:-claude-sdk-sidecar/Dockerfile}"
SIDECAR_BUILD_CONTEXT="${CDS_AGENT_SIDECAR_BUILD_CONTEXT:-claude-sdk-sidecar}"
SIDECAR_CANDIDATE_IMAGE="${CDS_AGENT_SIDECAR_CANDIDATE_IMAGE:-prd-agent/claude-sidecar:latest}"

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

next_action="provide missing env before apply"
if [[ "$invalid_count" -gt 0 ]]; then
  next_action="fix invalid env before any apply"
elif [[ "$ready_for_r0_apply" == "true" ]]; then
  next_action="run remote host apply + shared runtime deploy with evidence"
elif [[ "$ready_for_host_apply" == "true" ]]; then
  next_action="provide CDS_AGENT_SIDECAR_IMAGE before shared runtime deploy"
fi

mkdir -p "$(dirname "$REPORT")"
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
      nextAction: $imageNextAction
    },
    safeHandoffCommand: ("scripts/print-cds-agent-remote-host-handoff.sh " + $summary)
  }' > "$REPORT"

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
  "- imageNextAction: `" + (.imageReadiness.nextAction // "unknown") + "`"
' "$REPORT"
