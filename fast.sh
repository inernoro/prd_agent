#!/usr/bin/env sh
set -eu

# Best-effort warmup for production deploys. The real deploy is done by
# exec_dep.sh, so this script must not block a frontend-only release forever.
image="${PRD_AGENT_API_IMAGE:-get.miduo.org/ghcr.io/inernoro/prd_agent/prdagent-server:latest}"
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
