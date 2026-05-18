#!/usr/bin/env bash
# Refresh the local/read-only R0 status bundle.
# This does not push images, call GitHub, SSH to hosts, or deploy services.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

OUTPUT="${CDS_AGENT_R0_STATUS_REFRESH:-/tmp/cds-agent-r0-status-refresh-current.md}"
PROGRESS_OUTPUT="${CDS_AGENT_R0_PROGRESS_OUTPUT:-/tmp/cds-agent-current-progress-current.md}"
LIFECYCLE_OUTPUT="${CDS_AGENT_R0_LIFECYCLE_OUTPUT:-/tmp/cds-agent-lifecycle-overview-current.md}"
REMOTE="${CDS_AGENT_GITHUB_REMOTE:-origin}"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || fail "missing dependency: jq"

derive_current_sidecar_image() {
  local repo_url owner_repo short_sha image
  repo_url="$(git -C "$ROOT_DIR" remote get-url "$REMOTE" 2>/dev/null || printf '')"
  owner_repo="inernoro/prd_agent"
  case "$repo_url" in
    https://github.com/*/*.git|https://github.com/*/*)
      owner_repo="${repo_url#https://github.com/}"
      owner_repo="${owner_repo%.git}"
      ;;
    git@github.com:*/*.git|git@github.com:*/*)
      owner_repo="${repo_url#git@github.com:}"
      owner_repo="${owner_repo%.git}"
      ;;
  esac
  short_sha="$(git -C "$ROOT_DIR" rev-parse --short=12 HEAD 2>/dev/null || printf local)"
  image="ghcr.io/${owner_repo%/*}/${owner_repo#*/}/claude-sidecar:$short_sha"
  printf '%s' "$image" | tr '[:upper:]_' '[:lower:]-'
}

current_image="$(derive_current_sidecar_image)"
registry_image="${CDS_AGENT_SIDECAR_IMAGE:-$current_image}"

"$SCRIPT_DIR/print-cds-agent-sidecar-publish-handoff.sh" >/dev/null

# Keep the registry report aligned with either the operator-provided image or
# the current commit image. This is dry-run unless the caller explicitly sets
# CDS_AGENT_SIDECAR_REGISTRY_VERIFY=1.
CDS_AGENT_SIDECAR_IMAGE="$registry_image" \
  "$SCRIPT_DIR/verify-cds-agent-sidecar-registry-image.sh" >/dev/null || true

"$SCRIPT_DIR/preflight-cds-agent-r0-apply-readiness.sh" >/dev/null
"$SCRIPT_DIR/print-cds-agent-r0-operator-handoff.sh" >/dev/null
CDS_AGENT_LIFECYCLE_OVERVIEW="$LIFECYCLE_OUTPUT" \
  "$SCRIPT_DIR/print-cds-agent-lifecycle-overview.sh" >/dev/null
"$SCRIPT_DIR/print-cds-agent-current-progress.sh" > "$PROGRESS_OUTPUT"

readiness="${CDS_AGENT_R0_READINESS_REPORT:-/tmp/cds-agent-r0-apply-readiness-current.json}"
registry_report="${CDS_AGENT_SIDECAR_REGISTRY_VERIFY_REPORT:-/tmp/cds-agent-sidecar-registry-image-current.json}"
operator_handoff="${CDS_AGENT_R0_OPERATOR_HANDOFF:-/tmp/cds-agent-r0-operator-handoff-current.md}"
publish_handoff="${CDS_AGENT_SIDECAR_PUBLISH_HANDOFF:-/tmp/cds-agent-sidecar-publish-handoff-current.md}"

ready_for_r0="unknown"
next_action="unknown"
missing_config="unknown"
registry_status="unknown"
registry_visible="unknown"
remote_pull_status="unknown"
if [[ -f "$readiness" ]]; then
  ready_for_r0="$(jq -r '.readyForR0Apply // false' "$readiness")"
  next_action="$(jq -r '.nextAction // "unknown"' "$readiness")"
  missing_config="$(jq -r '(.missingConfig // []) | join(", ")' "$readiness")"
  registry_status="$(jq -r '.imageReadiness.registryManifest.status // "unknown"' "$readiness")"
  registry_visible="$(jq -r '.imageReadiness.registryManifest.visible // false' "$readiness")"
  remote_pull_status="$(jq -r '.imageReadiness.remotePull.status // "unknown"' "$readiness")"
fi

mkdir -p "$(dirname "$OUTPUT")"
{
  printf '# CDS Agent R0 Status Refresh\n\n'
  printf -- '- generatedAt: `%s`\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf -- '- branch: `%s`\n' "$(git -C "$ROOT_DIR" branch --show-current 2>/dev/null || printf unknown)"
  printf -- '- commit: `%s`\n' "$(git -C "$ROOT_DIR" rev-parse --short=12 HEAD 2>/dev/null || printf unknown)"
  printf -- '- currentSidecarImage: `%s`\n' "$current_image"
  printf -- '- registryCheckImage: `%s`\n' "$registry_image"
  printf -- '- readyForR0Apply: `%s`\n' "$ready_for_r0"
  printf -- '- nextAction: `%s`\n' "$next_action"
  printf -- '- missingConfig: `%s`\n' "${missing_config:-none}"
  printf -- '- registryManifestStatus: `%s`\n' "$registry_status"
  printf -- '- registryManifestVisible: `%s`\n' "$registry_visible"
  printf -- '- remotePullStatus: `%s`\n\n' "$remote_pull_status"

  printf '## Evidence\n\n'
  printf -- '- publish handoff: `%s`\n' "$publish_handoff"
  printf -- '- registry report: `%s`\n' "$registry_report"
  printf -- '- readiness report: `%s`\n' "$readiness"
  printf -- '- operator handoff: `%s`\n' "$operator_handoff"
  printf -- '- lifecycle overview: `%s`\n' "$LIFECYCLE_OUTPUT"
  printf -- '- progress board: `%s`\n\n' "$PROGRESS_OUTPUT"

  printf '## Next Command\n\n'
  printf '```bash\n'
  printf 'scripts/print-cds-agent-sidecar-publish-handoff.sh\n'
  printf '```\n'
} > "$OUTPUT"

printf 'CDS Agent R0 status refresh: %s\n' "$OUTPUT"
