#!/usr/bin/env bash
# Verify that the sidecar image tag is visible in the registry.
# Default mode is dry-run/validation. It only calls the registry when
# CDS_AGENT_SIDECAR_REGISTRY_VERIFY=1.

set -euo pipefail

REPORT="${CDS_AGENT_SIDECAR_REGISTRY_VERIFY_REPORT:-/tmp/cds-agent-sidecar-registry-image-current.json}"
LOG="${CDS_AGENT_SIDECAR_REGISTRY_VERIFY_LOG:-/tmp/cds-agent-sidecar-registry-image-current.log}"
VERIFY="${CDS_AGENT_SIDECAR_REGISTRY_VERIFY:-0}"
IMAGE="${CDS_AGENT_SIDECAR_IMAGE:-}"

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

append_json_string() {
  jq --arg value "$2" '. + [$value]' <<< "$1"
}

parse_image() {
  registry="${IMAGE%%/*}"
  remainder="${IMAGE#*/}"
  if [[ "$IMAGE" == *@sha256:* ]]; then
    repository="${remainder%@sha256:*}"
    reference="sha256:${IMAGE##*@sha256:}"
  else
    repository="${remainder%:*}"
    reference="${IMAGE##*:}"
  fi
}

write_report() {
  local status="$1"
  local detail="$2"
  local registry_attempted="$3"
  local manifest_visible="$4"
  local exit_code="$5"
  mkdir -p "$(dirname "$REPORT")"
  local tmp_report="${REPORT}.tmp.$$"
  jq -n \
    --arg generatedAt "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    --arg report "$REPORT" \
    --arg status "$status" \
    --arg detail "$detail" \
    --arg image "$IMAGE" \
    --arg registry "${registry:-}" \
    --arg repository "${repository:-}" \
    --arg reference "${reference:-}" \
    --arg log "$LOG" \
    --argjson verifyEnabled "$([[ "$VERIFY" == "1" ]] && printf true || printf false)" \
    --argjson registryAttempted "$registry_attempted" \
    --argjson manifestVisible "$manifest_visible" \
    --argjson missing "$missing" \
    --argjson invalid "$invalid" \
    --argjson exitCode "$exit_code" \
    '{
      generatedAt: $generatedAt,
      report: $report,
      status: $status,
      detail: $detail,
      image: (if $image == "" then null else $image end),
      registry: (if $registry == "" then null else $registry end),
      repository: (if $repository == "" then null else $repository end),
      reference: (if $reference == "" then null else $reference end),
      verifyEnabled: $verifyEnabled,
      registryAttempted: $registryAttempted,
      manifestVisible: $manifestVisible,
      missingConfig: $missing,
      invalidConfig: $invalid,
      exitCode: $exitCode,
      log: $log,
      nextAction: (
        if $status == "manifest_visible" then
          "verify the target remote host can docker pull this image"
        elif $status == "dry_run_ready" then
          "set CDS_AGENT_SIDECAR_REGISTRY_VERIFY=1 to query the registry manifest"
        else
          "publish the image or fix the image reference before remote host pull verification"
        end
      )
    }' > "$tmp_report"
  mv "$tmp_report" "$REPORT"
}

missing='[]'
invalid='[]'
registry=""
repository=""
reference=""

[[ -n "$IMAGE" ]] || missing=$(append_json_string "$missing" "CDS_AGENT_SIDECAR_IMAGE")

if [[ -n "$IMAGE" ]]; then
  if ! safe_docker_image_ref "$IMAGE"; then
    invalid=$(append_json_string "$invalid" "CDS_AGENT_SIDECAR_IMAGE is not safe for registry lookup")
  fi
  if ! has_tag_or_digest "$IMAGE"; then
    invalid=$(append_json_string "$invalid" "CDS_AGENT_SIDECAR_IMAGE must include a tag or digest")
  fi
  if ! looks_registry_qualified "$IMAGE"; then
    invalid=$(append_json_string "$invalid" "CDS_AGENT_SIDECAR_IMAGE must include an explicit registry host")
  fi
fi

missing_count=$(jq 'length' <<< "$missing")
invalid_count=$(jq 'length' <<< "$invalid")
: > "$LOG"

if [[ "$missing_count" -gt 0 ]]; then
  write_report "missing_config" "provide CDS_AGENT_SIDECAR_IMAGE before registry verification" false false 2
elif [[ "$invalid_count" -gt 0 ]]; then
  write_report "invalid_config" "fix image reference before registry verification" false false 2
else
  parse_image
  if [[ "$VERIFY" != "1" ]]; then
    write_report "dry_run_ready" "set CDS_AGENT_SIDECAR_REGISTRY_VERIFY=1 to query the registry manifest" false false 0
  elif [[ "$registry" != "ghcr.io" ]]; then
    write_report "unsupported_registry" "registry manifest verification currently supports ghcr.io; use remote host docker pull for other registries" false false 2
  elif ! command -v curl >/dev/null 2>&1; then
    write_report "missing_curl" "missing dependency: curl" false false 127
  else
    token_url="https://ghcr.io/token?service=ghcr.io&scope=repository:${repository}:pull"
    manifest_url="https://ghcr.io/v2/${repository}/manifests/${reference}"
    if token="$(curl -fsSL "$token_url" 2>>"$LOG" | jq -r '.token // empty')" && [[ -n "$token" ]]; then
      if curl -fsSIL \
        -H "Authorization: Bearer $token" \
        -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json" \
        "$manifest_url" >>"$LOG" 2>&1; then
        write_report "manifest_visible" "registry manifest is visible for this image reference" true true 0
      else
        code=$?
        write_report "manifest_missing" "registry manifest lookup failed; inspect log" true false "$code"
      fi
    else
      code=$?
      [[ "$code" -eq 0 ]] && code=1
      write_report "token_failed" "failed to obtain registry pull token; inspect log" true false "$code"
    fi
  fi
fi

printf '# CDS Agent Sidecar Registry Image\n\n'
jq -r '
  "- report: `" + .report + "`",
  "- status: `" + .status + "`",
  "- image: `" + (.image // "missing") + "`",
  "- verifyEnabled: `" + (.verifyEnabled|tostring) + "`",
  "- registryAttempted: `" + (.registryAttempted|tostring) + "`",
  "- manifestVisible: `" + (.manifestVisible|tostring) + "`",
  "- detail: `" + .detail + "`",
  "- nextAction: `" + .nextAction + "`",
  "- log: `" + .log + "`"
' "$REPORT"

status="$(jq -r '.status' "$REPORT")"
[[ "$status" == "dry_run_ready" || "$status" == "manifest_visible" ]]
