#!/usr/bin/env sh
set -eu

# Best-effort warmup for production deploys. The real deploy is done by
# exec_dep.sh, so this script must not block a frontend-only release forever.
release_ref="${PRD_AGENT_RELEASE_REF:-}"
if [ -z "$release_ref" ] && [ -n "${PRD_AGENT_DEPLOY_COMMIT:-}" ]; then
  release_ref="sha-${PRD_AGENT_DEPLOY_COMMIT}"
fi
if [ -z "$release_ref" ] && [ -n "${PRD_AGENT_RELEASE_TAG:-}" ]; then
  release_ref="$PRD_AGENT_RELEASE_TAG"
fi
release_ref="${release_ref:-latest}"

normalize_ref() {
  raw="$1"
  case "$raw" in
    latest)
      printf '%s' "latest"
      return 0
      ;;
    sha-*)
      commit="${raw#sha-}"
      ;;
    *)
      commit="$raw"
      ;;
  esac

  lower_commit="$(printf '%s' "$commit" | tr 'A-F' 'a-f')"
  if printf '%s' "$lower_commit" | grep -Eq '^[0-9a-f]{7,40}$'; then
    printf 'sha-%s' "$lower_commit"
    return 0
  fi

  if printf '%s' "$raw" | grep -Eq '^[A-Za-z0-9._-]+$'; then
    printf '%s' "$raw"
    return 0
  fi

  echo "ERROR: 发布 ref 只能是 latest、commit sha、sha-<commit> 或仅含 A-Z/a-z/0-9/._- 的 tag：$raw" >&2
  return 1
}

tag="$(normalize_ref "$release_ref")"
image="${PRD_AGENT_API_IMAGE:-get.miduo.org/ghcr.io/inernoro/prd_agent/prdagent-server:${tag}}"
timeout_seconds="${FAST_PULL_TIMEOUT_SECONDS:-30}"

echo "Warming api image: $image"
if command -v timeout >/dev/null 2>&1; then
  if timeout "$timeout_seconds" docker pull "$image"; then
    echo "Api image warmup completed"
  else
    echo "WARN: api image warmup skipped or timed out after ${timeout_seconds}s; exec_dep.sh will continue release" >&2
  fi
else
  if docker pull "$image"; then
    echo "Api image warmup completed"
  else
    echo "WARN: api image warmup failed; exec_dep.sh will continue release" >&2
  fi
fi
