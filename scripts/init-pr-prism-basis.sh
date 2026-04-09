#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/init-pr-prism-basis.sh --repo owner/repo [--architect architect] [--context engineering-governance]

Description:
  Initialize the minimum PR Review Prism top-design basis for a new repository.
  This script writes/overwrites:
    - doc/top-design/main.md
    - doc/top-design/anchors.yml
    - doc/top-design/contexts.yml
    - doc/top-design/slices.yml
    - .github/pr-architect/design-sources.yml
    - .github/pr-architect/repo-bindings.yml

Notes:
  - Safe for repeated runs (idempotent overwrite of the above files).
  - Designed for V1 checker (repo-file manifests only).
EOF
}

REPO=""
ARCHITECT="architect"
CONTEXT="engineering-governance"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO="${2:-}"
      shift 2
      ;;
    --architect|--owner)
      ARCHITECT="${2:-}"
      shift 2
      ;;
    --context)
      CONTEXT="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$REPO" ]]; then
  echo "Error: --repo is required (example: --repo inernoro/prd_agent)." >&2
  usage
  exit 1
fi

if [[ "$REPO" != */* ]]; then
  echo "Error: --repo must be in owner/repo format." >&2
  exit 1
fi

REPO_SLUG="${REPO//\//-}"
SOURCE_ID="local-ddd-anchor"
SOURCE_VERSION="v1.0.0"
ANCHOR_ID="ANCHOR-${REPO_SLUG^^}-01"
SLICE_ID="slice-${REPO_SLUG}-core"

mkdir -p "doc/top-design" ".github/pr-architect"

cat > "doc/top-design/main.md" <<EOF
# Top Design Baseline

Repository: \`${REPO}\`

## Goal

Provide a minimal, enforceable top-design baseline for PR Review Prism gate.

## Bounded Context

- \`${CONTEXT}\`: owns PR governance and review flow constraints.

## Core Anchor

- \`${ANCHOR_ID}\`: all PR review process changes must keep metadata, boundary, and evidence consistency.
EOF

cat > "doc/top-design/anchors.yml" <<EOF
version: 1
anchors:
  - id: "${ANCHOR_ID}"
    title: "Core PR review governance anchor"
    description: "Minimal anchor for PR Review Prism gate initialization."
EOF

cat > "doc/top-design/contexts.yml" <<EOF
version: 1
contexts:
  - id: "${CONTEXT}"
    name: "${CONTEXT}"
    description: "Primary governance bounded context for this repository."
EOF

cat > "doc/top-design/slices.yml" <<EOF
version: 1
slices:
  - id: "${SLICE_ID}"
    owner: "${ARCHITECT}"
    context: "${CONTEXT}"
    description: "Initial vertical slice for PR governance baseline."
EOF

cat > ".github/pr-architect/design-sources.yml" <<EOF
version: 1
profile: top-design-sources

defaults:
  active_source_id: "${SOURCE_ID}"
  active_version: "${SOURCE_VERSION}"
  enforce_manifests: true

sources:
  - id: "${SOURCE_ID}"
    type: "repo-file"
    location: "doc/top-design/main.md"
    version: "${SOURCE_VERSION}"
    checksum: "sha256:replace-with-real-checksum"
    owner: "${ARCHITECT}"
    description: "Repository local top-design baseline for PR Review Prism"
    manifests:
      anchors: "doc/top-design/anchors.yml"
      slices: "doc/top-design/slices.yml"
      contexts: "doc/top-design/contexts.yml"
EOF

cat > ".github/pr-architect/repo-bindings.yml" <<EOF
version: 1
profile: pr-architect-repo-bindings

defaults:
  enabled: true
  required_checks:
    - "PR审查棱镜 L1 Gate"
    - "PR审查棱镜 Advisory"
  architects:
    - "${ARCHITECT}"

repositories:
  - repo: "${REPO}"
    enabled: true
    design_source_id: "${SOURCE_ID}"
    design_source_version: "${SOURCE_VERSION}"
    default_owner: "${ARCHITECT}"
    default_context: "${CONTEXT}"
    default_anchor_refs:
      - "${ANCHOR_ID}"
    required_checks:
      - "PR审查棱镜 L1 Gate"
      - "PR审查棱镜 Advisory"
    architects:
      - "${ARCHITECT}"
EOF

echo "Initialized PR Review Prism basis for ${REPO}"
echo "Generated source: ${SOURCE_ID}@${SOURCE_VERSION}"
echo "Anchor: ${ANCHOR_ID}"
echo "Slice: ${SLICE_ID}"
