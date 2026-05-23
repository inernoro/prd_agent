#!/usr/bin/env bash
# Local-only sidecar image readiness check.
# It validates the build context and image reference shape, but never calls a
# registry and never claims the remote host can pull the image.

set -euo pipefail

REPORT="${CDS_AGENT_SIDECAR_IMAGE_PREFLIGHT_REPORT:-/tmp/cds-agent-sidecar-image-preflight-current.json}"
SIDECAR_DOCKERFILE="${CDS_AGENT_SIDECAR_DOCKERFILE:-claude-sdk-sidecar/Dockerfile}"
SIDECAR_BUILD_CONTEXT="${CDS_AGENT_SIDECAR_BUILD_CONTEXT:-claude-sdk-sidecar}"
SIDECAR_CANDIDATE_IMAGE="${CDS_AGENT_SIDECAR_CANDIDATE_IMAGE:-prd-agent/claude-sidecar:latest}"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || fail "missing dependency: jq"

append_json_string() {
  jq --arg value "$2" '. + [$value]' <<< "$1"
}

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

missing_files='[]'
warnings='[]'
required_files=(
  "$SIDECAR_DOCKERFILE"
  "$SIDECAR_BUILD_CONTEXT/requirements.txt"
  "$SIDECAR_BUILD_CONTEXT/app/main.py"
  "$SIDECAR_BUILD_CONTEXT/app/official_agent_sdk.py"
)

for file in "${required_files[@]}"; do
  if [[ ! -f "$file" ]]; then
    missing_files=$(append_json_string "$missing_files" "$file")
  fi
done

dockerfile_has_python=false
dockerfile_installs_requirements=false
dockerfile_exposes_7400=false
dockerfile_has_healthcheck=false
app_has_healthz=false
app_has_readyz=false
requirements_has_official_sdk=false

if [[ -f "$SIDECAR_DOCKERFILE" ]]; then
  grep -Eq '^FROM[[:space:]]+python:' "$SIDECAR_DOCKERFILE" && dockerfile_has_python=true
  grep -Eq 'pip[[:space:]]+install[[:space:]]+-r[[:space:]]+requirements\.txt' "$SIDECAR_DOCKERFILE" && dockerfile_installs_requirements=true
  grep -Eq '^EXPOSE[[:space:]]+7400([[:space:]]|$)' "$SIDECAR_DOCKERFILE" && dockerfile_exposes_7400=true
  if grep -Eq 'HEALTHCHECK' "$SIDECAR_DOCKERFILE" && grep -Eq 'healthz' "$SIDECAR_DOCKERFILE"; then
    dockerfile_has_healthcheck=true
  fi
fi

if [[ -f "$SIDECAR_BUILD_CONTEXT/app/main.py" ]]; then
  grep -Eq '@app\.get\("/healthz"\)' "$SIDECAR_BUILD_CONTEXT/app/main.py" && app_has_healthz=true
  grep -Eq '@app\.get\("/readyz"\)' "$SIDECAR_BUILD_CONTEXT/app/main.py" && app_has_readyz=true
fi

if [[ -f "$SIDECAR_BUILD_CONTEXT/requirements.txt" ]]; then
  grep -Eq '^claude-agent-sdk([<>=~! ]|$)' "$SIDECAR_BUILD_CONTEXT/requirements.txt" && requirements_has_official_sdk=true
fi

[[ "$dockerfile_has_python" == "true" ]] || warnings=$(append_json_string "$warnings" "Dockerfile should use a python base image")
[[ "$dockerfile_installs_requirements" == "true" ]] || warnings=$(append_json_string "$warnings" "Dockerfile should install requirements.txt")
[[ "$dockerfile_exposes_7400" == "true" ]] || warnings=$(append_json_string "$warnings" "Dockerfile should expose port 7400")
[[ "$dockerfile_has_healthcheck" == "true" ]] || warnings=$(append_json_string "$warnings" "Dockerfile should define a /healthz healthcheck")
[[ "$app_has_healthz" == "true" ]] || warnings=$(append_json_string "$warnings" "sidecar app should expose /healthz")
[[ "$app_has_readyz" == "true" ]] || warnings=$(append_json_string "$warnings" "sidecar app should expose /readyz")
[[ "$requirements_has_official_sdk" == "true" ]] || warnings=$(append_json_string "$warnings" "requirements.txt should include claude-agent-sdk")

missing_count=$(jq 'length' <<< "$missing_files")
context_warning_count=$(jq 'length' <<< "$warnings")
build_context_status="pass"
if [[ "$missing_count" -gt 0 ]]; then
  build_context_status="invalid"
elif [[ "$context_warning_count" -gt 0 ]]; then
  build_context_status="warning"
fi

image_status="missing"
image_value=""
image_safe=false
image_has_tag=false
image_registry_qualified=false
image_next_action="operator fallback only: publish a pullable image only when explicitly using fallback recovery"

if [[ -n "${CDS_AGENT_SIDECAR_IMAGE:-}" ]]; then
  image_value="$CDS_AGENT_SIDECAR_IMAGE"
  if safe_docker_image_ref "$CDS_AGENT_SIDECAR_IMAGE"; then
    image_safe=true
    image_status="provided_unverified"
    image_next_action="operator fallback only: verify the target remote host can docker pull this image"
  else
    image_status="invalid"
    image_next_action="use only CDS-safe docker image characters: [a-zA-Z0-9._-/:@]"
  fi
  if [[ "$image_safe" == "true" ]]; then
    has_tag_or_digest "$CDS_AGENT_SIDECAR_IMAGE" && image_has_tag=true
    looks_registry_qualified "$CDS_AGENT_SIDECAR_IMAGE" && image_registry_qualified=true
    [[ "$image_has_tag" == "true" ]] || warnings=$(append_json_string "$warnings" "CDS_AGENT_SIDECAR_IMAGE should include a tag or digest")
    [[ "$image_registry_qualified" == "true" ]] || warnings=$(append_json_string "$warnings" "CDS_AGENT_SIDECAR_IMAGE is not registry-qualified; Docker may resolve it via Docker Hub namespace")
  fi
fi

status="missing_image"
if [[ "$build_context_status" == "invalid" || "$image_status" == "invalid" ]]; then
  status="invalid"
elif [[ "$image_status" == "provided_unverified" ]]; then
  status="provided_unverified"
fi

mkdir -p "$(dirname "$REPORT")"
tmp_report="${REPORT}.tmp.$$"
trap 'rm -f "$tmp_report"' EXIT
jq -n \
  --arg generatedAt "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
  --arg report "$REPORT" \
  --arg status "$status" \
  --arg imageStatus "$image_status" \
  --arg imageValue "$image_value" \
  --argjson imageSafe "$image_safe" \
  --argjson imageHasTag "$image_has_tag" \
  --argjson imageRegistryQualified "$image_registry_qualified" \
  --arg imageNextAction "$image_next_action" \
  --arg dockerfile "$SIDECAR_DOCKERFILE" \
  --arg buildContext "$SIDECAR_BUILD_CONTEXT" \
  --arg candidateImage "$SIDECAR_CANDIDATE_IMAGE" \
  --arg buildContextStatus "$build_context_status" \
  --argjson missingFiles "$missing_files" \
  --argjson warnings "$warnings" \
  --argjson dockerfileHasPython "$dockerfile_has_python" \
  --argjson dockerfileInstallsRequirements "$dockerfile_installs_requirements" \
  --argjson dockerfileExposes7400 "$dockerfile_exposes_7400" \
  --argjson dockerfileHasHealthcheck "$dockerfile_has_healthcheck" \
  --argjson appHasHealthz "$app_has_healthz" \
  --argjson appHasReadyz "$app_has_readyz" \
  --argjson requirementsHasOfficialSdk "$requirements_has_official_sdk" \
  '{
    generatedAt: $generatedAt,
    report: $report,
    status: $status,
    deployerMode: "docker-pull-only",
    remoteHostRequirement: "image reference must be pullable from the target remote host",
    image: {
      status: $imageStatus,
      value: (if $imageValue == "" then null else $imageValue end),
      safeForCdsDeployer: $imageSafe,
      hasTagOrDigest: $imageHasTag,
      registryQualified: $imageRegistryQualified,
      nextAction: $imageNextAction
    },
    buildContext: {
      status: $buildContextStatus,
      dockerfile: $dockerfile,
      buildContext: $buildContext,
      missingFiles: $missingFiles,
      checks: {
        dockerfileHasPython: $dockerfileHasPython,
        dockerfileInstallsRequirements: $dockerfileInstallsRequirements,
        dockerfileExposes7400: $dockerfileExposes7400,
        dockerfileHasHealthcheck: $dockerfileHasHealthcheck,
        appHasHealthz: $appHasHealthz,
        appHasReadyz: $appHasReadyz,
        requirementsHasOfficialSdk: $requirementsHasOfficialSdk
      },
      candidateImage: $candidateImage,
      candidateBuildCommand: ("docker build -t " + $candidateImage + " " + $buildContext),
      candidatePushCommand: ("docker push " + $candidateImage)
    },
    warnings: $warnings
  }' > "$tmp_report"
mv "$tmp_report" "$REPORT"

printf '# CDS Agent Sidecar Image Preflight\n\n'
jq -r '
  "- report: `" + .report + "`",
  "- status: `" + .status + "`",
  "- deployerMode: `" + .deployerMode + "`",
  "- buildContext: `" + .buildContext.status + "`",
  "- image: `" + .image.status + "`",
  "- remoteHostRequirement: `" + .remoteHostRequirement + "`",
  "- nextAction: `" + .image.nextAction + "`",
  "- warnings: `" + ((.warnings // []) | join(", ")) + "`"
' "$REPORT"
