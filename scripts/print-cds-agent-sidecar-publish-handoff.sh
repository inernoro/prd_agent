#!/usr/bin/env bash
# Print the safe handoff for publishing the CDS Agent sidecar image.
# This is read-only. It does not call GitHub, push images, or deploy services.

set -euo pipefail

OUTPUT="${CDS_AGENT_SIDECAR_PUBLISH_HANDOFF:-/tmp/cds-agent-sidecar-publish-handoff-current.md}"
PUBLISH_REPORT="${CDS_AGENT_SIDECAR_IMAGE_PUBLISH_REPORT:-/tmp/cds-agent-sidecar-image-publish-current.json}"
WORKFLOW=".github/workflows/cds-sidecar-image.yml"
REMOTE="${CDS_AGENT_GITHUB_REMOTE:-origin}"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || fail "missing dependency: jq"

repo_url="$(git remote get-url "$REMOTE" 2>/dev/null || printf '')"
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

short_sha="$(git rev-parse --short=12 HEAD 2>/dev/null || printf local)"
tag="$short_sha"
if [[ -n "${CDS_AGENT_SIDECAR_IMAGE_REPOSITORY:-}" ]]; then
  candidate_image="${CDS_AGENT_SIDECAR_IMAGE_REPOSITORY%:}:$tag"
  candidate_source="CDS_AGENT_SIDECAR_IMAGE_REPOSITORY"
else
  candidate_image="ghcr.io/${owner_repo%/*}/${owner_repo#*/}/claude-sidecar:$tag"
  candidate_source="github-repository-ghcr-candidate"
fi
candidate_image="$(printf '%s' "$candidate_image" | tr '[:upper:]_' '[:lower:]-')"
reported_candidate=""

if [[ -f "$PUBLISH_REPORT" ]]; then
  reported_candidate="$(jq -r '.candidateTargetImage // .targetImage // empty' "$PUBLISH_REPORT")"
fi

actions_url="https://github.com/$owner_repo/actions/workflows/cds-sidecar-image.yml"

mkdir -p "$(dirname "$OUTPUT")"
{
  printf '# CDS Agent Sidecar Publish Handoff\n\n'
  printf -- '- generatedAt: `%s`\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf -- '- workflow: `%s`\n' "$WORKFLOW"
  printf -- '- actionsUrl: `%s`\n' "$actions_url"
  printf -- '- operatorFallbackImageInput: `CDS_AGENT_SIDECAR_IMAGE`\n'
  printf -- '- candidateImage: `%s`\n' "$candidate_image"
  printf -- '- candidateSource: `%s`\n' "$candidate_source"
  if [[ -n "$reported_candidate" && "$reported_candidate" != "$candidate_image" ]]; then
    printf -- '- previousLocalCandidate: `%s`\n' "$reported_candidate"
  fi
  printf -- '- imageTag: `%s`\n' "$tag"
  printf -- '- publishReport: `%s`\n\n' "$PUBLISH_REPORT"

  printf '## Recommended Path\n\n'
  printf 'Use any registry image that the target remote host can `docker pull`. GitHub Actions/GHCR is only the built-in auditable candidate path for this repository.\n\n'
  printf 'If you already have a registry image, set `CDS_AGENT_SIDECAR_IMAGE` to that image and skip publishing the GHCR candidate.\n\n'

  printf '## Optional GitHub Actions Path\n\n'
  printf '1. Open `%s`.\n' "$actions_url"
  printf '2. Click `Run workflow`.\n'
  printf '3. Set `image_tag` to `%s`.\n' "$tag"
  printf '4. Keep `docker_platforms=linux/amd64` unless the remote host needs multi-arch.\n'
  printf '5. After it completes, copy `CDS_AGENT_SIDECAR_IMAGE` from the workflow summary.\n\n'
  printf '6. Verify the registry manifest before trying remote host SSH pull:\n\n'
  printf '```bash\n'
  printf 'CDS_AGENT_SIDECAR_IMAGE=%s CDS_AGENT_SIDECAR_REGISTRY_VERIFY=1 scripts/verify-cds-agent-sidecar-registry-image.sh\n' "$candidate_image"
  printf '```\n\n'

  printf '## CLI Equivalent\n\n'
  printf 'This is also an external write. Run it only from an approved GitHub session.\n\n'
  printf '```bash\n'
  printf 'gh workflow run cds-sidecar-image.yml --repo %s -f image_tag=%s -f docker_platforms=linux/amd64\n' "$owner_repo" "$tag"
  printf '```\n\n'

  printf '## Local Push Alternative\n\n'
  printf 'This writes to the registry in `CDS_AGENT_SIDECAR_IMAGE`. It still requires explicit approval if Codex performs the push. Retag first so the local image matches the chosen tag.\n\n'
  printf 'Use this path when GitHub Actions cannot dispatch the workflow, or when you choose a non-GHCR registry.\n\n'
  printf '```bash\n'
  printf 'CDS_AGENT_SIDECAR_IMAGE=%s CDS_AGENT_SIDECAR_IMAGE_TAG=1 scripts/publish-cds-agent-sidecar-image.sh\n' "$candidate_image"
  printf 'CDS_AGENT_SIDECAR_IMAGE=%s CDS_AGENT_SIDECAR_IMAGE_PUSH=1 scripts/publish-cds-agent-sidecar-image.sh\n' "$candidate_image"
  printf 'CDS_AGENT_SIDECAR_IMAGE=%s CDS_AGENT_SIDECAR_REGISTRY_VERIFY=1 scripts/verify-cds-agent-sidecar-registry-image.sh\n' "$candidate_image"
  printf '```\n'
} > "$OUTPUT"

printf 'CDS Agent sidecar publish handoff: %s\n' "$OUTPUT"
