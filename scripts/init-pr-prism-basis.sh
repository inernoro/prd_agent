#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/init-pr-prism-basis.sh [--repo owner/repo] [--architect architect] [--context engineering-governance]

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
  - When --repo is omitted, auto-detects from git remote origin.
  - When --architect/--owner is omitted, auto-detects from `gh api user` or git user.name.
EOF
}

REPO=""
ARCHITECT=""
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

detect_repo_from_git() {
  local remote_url
  remote_url="$(git config --get remote.origin.url 2>/dev/null || true)"
  if [[ -z "$remote_url" ]]; then
    return 1
  fi

  # Supports:
  # - https://github.com/org/repo.git
  # - git@github.com:org/repo.git
  # - https://x-access-token:***@github.com/org/repo
  local normalized="$remote_url"
  normalized="${normalized%.git}"

  if [[ "$normalized" == *github.com* ]]; then
    normalized="${normalized#*github.com[:/]}"
  elif [[ "$normalized" == *:*/* ]]; then
    normalized="${normalized#*:}"
  fi

  # For HTTPS with embedded credentials, strip only credentials segment.
  # Keep owner/repo intact for plain URLs like https://github.com/owner/repo.
  if [[ "$normalized" == *"@"* ]]; then
    normalized="${normalized#*@}"
  fi

  if [[ "$normalized" == */* ]]; then
    local owner="${normalized%%/*}"
    local repo="${normalized##*/}"
    if [[ -n "$owner" && -n "$repo" ]]; then
      printf '%s/%s\n' "$owner" "$repo"
      return 0
    fi
  fi

  return 1
}

detect_architect() {
  if [[ -n "$ARCHITECT" ]]; then
    return 0
  fi

  if command -v gh >/dev/null 2>&1; then
    local gh_login
    gh_login="$(gh api user --jq '.login' 2>/dev/null || true)"
    if [[ -n "$gh_login" ]]; then
      ARCHITECT="$gh_login"
      return 0
    fi
  fi

  local git_user
  git_user="$(git config user.name 2>/dev/null || true)"
  if [[ -n "$git_user" ]]; then
    ARCHITECT="$git_user"
    return 0
  fi

  ARCHITECT="architect"
}

if [[ -z "$REPO" ]]; then
  if REPO="$(detect_repo_from_git)"; then
    echo "Auto-detected repo: $REPO"
  else
    echo "Error: unable to detect repo from git remote. Please pass --repo owner/repo." >&2
    usage
    exit 1
  fi
fi

if [[ "$REPO" != */* ]]; then
  echo "Error: --repo must be in owner/repo format." >&2
  exit 1
fi

detect_architect

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
echo "Architect: ${ARCHITECT}"
