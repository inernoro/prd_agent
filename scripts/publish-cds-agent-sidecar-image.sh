#!/usr/bin/env bash
# Registry handoff for the official SDK sidecar image.
# Default mode is dry-run: validate local image + target reference and print the
# exact tag/push commands. It only pushes when CDS_AGENT_SIDECAR_IMAGE_PUSH=1.

set -euo pipefail

REPORT="${CDS_AGENT_SIDECAR_IMAGE_PUBLISH_REPORT:-/tmp/cds-agent-sidecar-image-publish-current.json}"
BUILD_REPORT="${CDS_AGENT_SIDECAR_IMAGE_BUILD_REPORT:-/tmp/cds-agent-sidecar-image-build-current.json}"
LOG="${CDS_AGENT_SIDECAR_IMAGE_PUBLISH_LOG:-/tmp/cds-agent-sidecar-image-publish-current.log}"
SOURCE_IMAGE="${CDS_AGENT_SIDECAR_SOURCE_IMAGE:-}"
TARGET_IMAGE="${CDS_AGENT_SIDECAR_IMAGE:-}"
TAG_IMAGE="${CDS_AGENT_SIDECAR_IMAGE_TAG:-0}"
PUSH_IMAGE="${CDS_AGENT_SIDECAR_IMAGE_PUSH:-0}"
PULL_VERIFY="${CDS_AGENT_SIDECAR_IMAGE_PULL_VERIFY:-0}"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || fail "missing dependency: jq"

safe_docker_image_ref() {
  local value="$1"
  [[ -n "$value" && ${#value} -le 256 && "$value" =~ ^[a-zA-Z0-9._/:@-]+$ ]]
}

has_tag_or_digest() {
  local value="$1"
  [[ "$value" == *@sha256:* || "$value" =~ :[^/]+$ ]]
}

looks_registry_qualified() {
  local value="$1"
  local first="${value%%/*}"
  [[ "$value" == */* && ( "$first" == *.* || "$first" == *:* || "$first" == "localhost" ) ]]
}

if [[ -z "$SOURCE_IMAGE" && -f "$BUILD_REPORT" ]]; then
  SOURCE_IMAGE="$(jq -r '.image // empty' "$BUILD_REPORT")"
fi
if [[ -z "$SOURCE_IMAGE" ]]; then
  SOURCE_IMAGE="${CDS_AGENT_SIDECAR_CANDIDATE_IMAGE:-prd-agent/claude-sidecar:latest}"
fi

write_report() {
  local status="$1"
  local detail="$2"
  local docker_available="$3"
  local source_exists="$4"
  local tag_attempted="$5"
  local tag_passed="$6"
  local push_attempted="$7"
  local push_passed="$8"
  local pull_verify_attempted="$9"
  local pull_verify_passed="${10}"
  local exit_code="${11}"
  mkdir -p "$(dirname "$REPORT")"
  local tmp_report="${REPORT}.tmp.$$"
  jq -n \
    --arg generatedAt "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    --arg report "$REPORT" \
    --arg buildReport "$BUILD_REPORT" \
    --arg status "$status" \
    --arg detail "$detail" \
    --arg sourceImage "$SOURCE_IMAGE" \
    --arg targetImage "$TARGET_IMAGE" \
    --arg log "$LOG" \
    --arg tagCommand "docker tag $SOURCE_IMAGE $TARGET_IMAGE" \
    --arg pushCommand "docker push $TARGET_IMAGE" \
    --arg pullCommand "docker pull $TARGET_IMAGE" \
    --argjson dockerAvailable "$docker_available" \
    --argjson sourceImageExists "$source_exists" \
    --argjson tagAttempted "$tag_attempted" \
    --argjson tagPassed "$tag_passed" \
    --argjson pushAttempted "$push_attempted" \
    --argjson pushPassed "$push_passed" \
    --argjson pullVerifyAttempted "$pull_verify_attempted" \
    --argjson pullVerifyPassed "$pull_verify_passed" \
    --argjson exitCode "$exit_code" \
    '{
      generatedAt: $generatedAt,
      report: $report,
      buildReport: $buildReport,
      status: $status,
      detail: $detail,
      sourceImage: $sourceImage,
      targetImage: (if $targetImage == "" then null else $targetImage end),
      dockerAvailable: $dockerAvailable,
      sourceImageExists: $sourceImageExists,
      tagAttempted: $tagAttempted,
      tagPassed: $tagPassed,
      pushAttempted: $pushAttempted,
      pushPassed: $pushPassed,
      pullVerifyAttempted: $pullVerifyAttempted,
      pullVerifyPassed: $pullVerifyPassed,
      exitCode: $exitCode,
      log: $log,
      commands: {
        tag: $tagCommand,
        push: $pushCommand,
        pullVerify: $pullCommand
      }
    }' > "$tmp_report"
  mv "$tmp_report" "$REPORT"
}

: > "$LOG"

if [[ -z "$TARGET_IMAGE" ]]; then
  write_report "missing_target_image" "set CDS_AGENT_SIDECAR_IMAGE to a registry-qualified image tag" false false false false false false false false 2
elif ! safe_docker_image_ref "$SOURCE_IMAGE"; then
  write_report "invalid_source_image" "source image is not safe for docker commands" false false false false false false false false 2
elif ! safe_docker_image_ref "$TARGET_IMAGE"; then
  write_report "invalid_target_image" "target image is not safe for CDS docker pull/run" false false false false false false false false 2
elif ! has_tag_or_digest "$TARGET_IMAGE"; then
  write_report "invalid_target_image" "target image must include a tag or digest" false false false false false false false false 2
elif ! looks_registry_qualified "$TARGET_IMAGE"; then
  write_report "target_not_registry_qualified" "target image should include an explicit registry host" false false false false false false false false 2
elif ! docker version >/dev/null 2>"$LOG"; then
  if grep -qi 'permission denied' "$LOG"; then
    write_report "docker_permission_denied" "docker socket access was denied; run this with Docker permissions" false false false false false false false false 125
  else
    write_report "docker_unavailable" "docker daemon is not reachable" false false false false false false false false 125
  fi
elif ! docker image inspect "$SOURCE_IMAGE" >/dev/null 2>>"$LOG"; then
  write_report "source_image_missing" "build the source image before tagging or pushing" true false false false false false false false 1
else
  tag_attempted=false
  tag_passed=false
  push_attempted=false
  push_passed=false
  pull_attempted=false
  pull_passed=false

  if [[ "$TAG_IMAGE" == "1" || "$PUSH_IMAGE" == "1" ]]; then
    tag_attempted=true
    if docker tag "$SOURCE_IMAGE" "$TARGET_IMAGE" >>"$LOG" 2>&1; then
      tag_passed=true
    else
      write_report "tag_failed" "docker tag failed; inspect log" true true true false false false false false 1
      printf '# CDS Agent Sidecar Image Publish\n\n'
      jq -r '"- report: `" + .report + "`", "- status: `" + .status + "`", "- detail: `" + .detail + "`", "- log: `" + .log + "`"' "$REPORT"
      exit 1
    fi
  fi

  if [[ "$PUSH_IMAGE" != "1" ]]; then
    write_report "push_ready" "dry-run only; set CDS_AGENT_SIDECAR_IMAGE_PUSH=1 to push" true true "$tag_attempted" "$tag_passed" false false false false 0
  else
    push_attempted=true
    if docker push "$TARGET_IMAGE" >>"$LOG" 2>&1; then
      push_passed=true
      if [[ "$PULL_VERIFY" == "1" ]]; then
        pull_attempted=true
        if docker pull "$TARGET_IMAGE" >>"$LOG" 2>&1; then
          pull_passed=true
        else
          write_report "pull_verify_failed" "push passed but local pull verify failed; inspect log" true true "$tag_attempted" "$tag_passed" true true true false 1
          printf '# CDS Agent Sidecar Image Publish\n\n'
          jq -r '"- report: `" + .report + "`", "- status: `" + .status + "`", "- detail: `" + .detail + "`", "- log: `" + .log + "`"' "$REPORT"
          exit 1
        fi
      fi
      write_report "push_pass" "image pushed; remote host pullability still must be verified from target host" true true "$tag_attempted" "$tag_passed" true true "$pull_attempted" "$pull_passed" 0
    else
      write_report "push_failed" "docker push failed; inspect log" true true "$tag_attempted" "$tag_passed" true false false false 1
    fi
  fi
fi

printf '# CDS Agent Sidecar Image Publish\n\n'
jq -r '
  "- report: `" + .report + "`",
  "- status: `" + .status + "`",
  "- sourceImage: `" + .sourceImage + "`",
  "- targetImage: `" + (.targetImage // "missing") + "`",
  "- pushAttempted: `" + (.pushAttempted|tostring) + "`",
  "- detail: `" + .detail + "`",
  "- log: `" + .log + "`"
' "$REPORT"

status="$(jq -r '.status' "$REPORT")"
[[ "$status" == "push_ready" || "$status" == "push_pass" ]]
