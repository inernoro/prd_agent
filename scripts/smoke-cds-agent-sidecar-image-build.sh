#!/usr/bin/env bash
# Build-smoke for the official SDK sidecar image.
# This does not push or deploy anything. It records whether the local Docker
# daemon can build the candidate image before R0.3 attempts remote docker pull.

set -euo pipefail

REPORT="${CDS_AGENT_SIDECAR_IMAGE_BUILD_REPORT:-/tmp/cds-agent-sidecar-image-build-current.json}"
PREFLIGHT_REPORT="${CDS_AGENT_SIDECAR_IMAGE_PREFLIGHT_REPORT:-/tmp/cds-agent-sidecar-image-preflight-current.json}"
IMAGE="${CDS_AGENT_SIDECAR_IMAGE:-${CDS_AGENT_SIDECAR_CANDIDATE_IMAGE:-prd-agent/claude-sidecar:latest}}"
BUILD_CONTEXT="${CDS_AGENT_SIDECAR_BUILD_CONTEXT:-claude-sdk-sidecar}"
DOCKERFILE="${CDS_AGENT_SIDECAR_DOCKERFILE:-$BUILD_CONTEXT/Dockerfile}"
LOG="${CDS_AGENT_SIDECAR_IMAGE_BUILD_LOG:-/tmp/cds-agent-sidecar-image-build-current.log}"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || fail "missing dependency: jq"

safe_docker_image_ref() {
  local value="$1"
  [[ -n "$value" && ${#value} -le 256 && "$value" =~ ^[a-zA-Z0-9._/:@-]+$ ]]
}

write_report() {
  local status="$1"
  local detail="$2"
  local docker_available="$3"
  local exit_code="$4"
  mkdir -p "$(dirname "$REPORT")"
  local tmp_report="${REPORT}.tmp.$$"
  jq -n \
    --arg generatedAt "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    --arg report "$REPORT" \
    --arg preflightReport "$PREFLIGHT_REPORT" \
    --arg status "$status" \
    --arg detail "$detail" \
    --arg image "$IMAGE" \
    --arg buildContext "$BUILD_CONTEXT" \
    --arg dockerfile "$DOCKERFILE" \
    --arg log "$LOG" \
    --argjson dockerAvailable "$docker_available" \
    --argjson exitCode "$exit_code" \
    '{
      generatedAt: $generatedAt,
      report: $report,
      preflightReport: $preflightReport,
      status: $status,
      detail: $detail,
      image: $image,
      buildContext: $buildContext,
      dockerfile: $dockerfile,
      log: $log,
      dockerAvailable: $dockerAvailable,
      exitCode: $exitCode,
      pushAttempted: false,
      deployAttempted: false
    }' > "$tmp_report"
  mv "$tmp_report" "$REPORT"
}

if [[ -x scripts/preflight-cds-agent-sidecar-image.sh ]]; then
  CDS_AGENT_SIDECAR_IMAGE_PREFLIGHT_REPORT="$PREFLIGHT_REPORT" \
  CDS_AGENT_SIDECAR_DOCKERFILE="$DOCKERFILE" \
  CDS_AGENT_SIDECAR_BUILD_CONTEXT="$BUILD_CONTEXT" \
  CDS_AGENT_SIDECAR_CANDIDATE_IMAGE="$IMAGE" \
    bash scripts/preflight-cds-agent-sidecar-image.sh >/dev/null
fi

if ! safe_docker_image_ref "$IMAGE"; then
  write_report "invalid_image" "image reference is not safe for docker build/tag" false 2
elif [[ ! -f "$DOCKERFILE" ]]; then
  write_report "missing_dockerfile" "dockerfile not found" false 2
elif ! docker version >/dev/null 2>"$LOG"; then
  if grep -qi 'permission denied' "$LOG"; then
    write_report "docker_permission_denied" "docker socket access was denied; run this smoke with Docker permissions" false 125
  else
    write_report "docker_unavailable" "docker daemon is not reachable" false 125
  fi
else
  if docker build -t "$IMAGE" -f "$DOCKERFILE" "$BUILD_CONTEXT" >"$LOG" 2>&1; then
    write_report "build_pass" "local docker build succeeded" true 0
  else
    code=$?
    write_report "build_failed" "local docker build failed; inspect log" true "$code"
  fi
fi

printf '# CDS Agent Sidecar Image Build Smoke\n\n'
jq -r '
  "- report: `" + .report + "`",
  "- status: `" + .status + "`",
  "- image: `" + .image + "`",
  "- dockerAvailable: `" + (.dockerAvailable|tostring) + "`",
  "- detail: `" + .detail + "`",
  "- log: `" + .log + "`"
' "$REPORT"

[[ "$(jq -r '.status' "$REPORT")" == "build_pass" ]]
