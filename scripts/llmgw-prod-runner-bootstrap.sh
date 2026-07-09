#!/usr/bin/env bash
set -euo pipefail

# Register the production self-hosted runner used by LLM Gateway staged rollout.
# Run this on the production host that is allowed to execute fast.sh and
# exec_dep.sh against the live Docker/compose state.

usage() {
  cat <<'EOF'
Usage:
  scripts/llmgw-prod-runner-bootstrap.sh [options]

Options:
  --repo owner/repo           GitHub repository, default inernoro/prd_agent
  --runner-dir PATH           Runner install directory, default /opt/actions-runner/prd-agent-prod
  --name NAME                 Runner name, default <hostname>-prd-agent-prod
  --labels LABELS             Comma-separated labels, default self-hosted,prd-agent-prod
  --version VERSION           GitHub Actions runner version, default 2.335.1
  --replace                   Replace an existing runner registration in the same directory
  --install-service           Install and start the runner service through svc.sh
  --dry-run                   Print planned actions without downloading or registering
  -h, --help                  Show this help

Required environment:
  GITHUB_ADMIN_TOKEN or GH_TOKEN
    Token with permission to create repository self-hosted runner registration
    tokens for the target repo. The token is never printed.

Example on production host:
  GITHUB_ADMIN_TOKEN=<token> \
  scripts/llmgw-prod-runner-bootstrap.sh \
    --repo inernoro/prd_agent \
    --runner-dir /opt/actions-runner/prd-agent-prod \
    --install-service
EOF
}

repo="inernoro/prd_agent"
runner_dir="/opt/actions-runner/prd-agent-prod"
runner_name="$(hostname 2>/dev/null || printf 'prd-agent-prod')-prd-agent-prod"
labels="self-hosted,prd-agent-prod"
runner_version="${RUNNER_VERSION:-2.335.1}"
replace=0
install_service=0
dry_run=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)
      shift
      [ "$#" -gt 0 ] || { echo "ERROR: --repo requires owner/repo" >&2; exit 1; }
      repo="$1"
      ;;
    --repo=*)
      repo="${1#--repo=}"
      ;;
    --runner-dir)
      shift
      [ "$#" -gt 0 ] || { echo "ERROR: --runner-dir requires a path" >&2; exit 1; }
      runner_dir="$1"
      ;;
    --runner-dir=*)
      runner_dir="${1#--runner-dir=}"
      ;;
    --name)
      shift
      [ "$#" -gt 0 ] || { echo "ERROR: --name requires a value" >&2; exit 1; }
      runner_name="$1"
      ;;
    --name=*)
      runner_name="${1#--name=}"
      ;;
    --labels)
      shift
      [ "$#" -gt 0 ] || { echo "ERROR: --labels requires a value" >&2; exit 1; }
      labels="$1"
      ;;
    --labels=*)
      labels="${1#--labels=}"
      ;;
    --version)
      shift
      [ "$#" -gt 0 ] || { echo "ERROR: --version requires a value" >&2; exit 1; }
      runner_version="$1"
      ;;
    --version=*)
      runner_version="${1#--version=}"
      ;;
    --replace)
      replace=1
      ;;
    --install-service)
      install_service=1
      ;;
    --dry-run)
      dry_run=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

case "$repo" in
  */*) ;;
  *)
    echo "ERROR: --repo must be owner/repo; got $repo" >&2
    exit 1
    ;;
esac

if [ -z "$(printf '%s' "$runner_dir" | xargs)" ]; then
  echo "ERROR: --runner-dir must not be empty" >&2
  exit 1
fi
if [ -z "$(printf '%s' "$runner_name" | xargs)" ]; then
  echo "ERROR: --name must not be empty" >&2
  exit 1
fi
if [ -z "$(printf '%s' "$labels" | xargs)" ]; then
  echo "ERROR: --labels must not be empty" >&2
  exit 1
fi
if ! printf '%s' "$runner_version" | grep -Eq '^[0-9]+[.][0-9]+[.][0-9]+$'; then
  echo "ERROR: --version must look like 2.335.1; got $runner_version" >&2
  exit 1
fi

arch="$(uname -m)"
case "$arch" in
  x86_64|amd64)
    runner_arch="x64"
    ;;
  aarch64|arm64)
    runner_arch="arm64"
    ;;
  *)
    echo "ERROR: unsupported architecture: $arch" >&2
    exit 1
    ;;
esac

runner_url="https://github.com/actions/runner/releases/download/v${runner_version}/actions-runner-linux-${runner_arch}-${runner_version}.tar.gz"
github_url="https://github.com/${repo}"
api_url="https://api.github.com/repos/${repo}/actions/runners/registration-token"

echo "LLM Gateway production runner bootstrap"
echo "  repo: $repo"
echo "  runnerDir: $runner_dir"
echo "  runnerName: $runner_name"
echo "  labels: $labels"
echo "  runnerVersion: $runner_version"
echo "  runnerArch: $runner_arch"
echo "  installService: $install_service"
echo "  replace: $replace"

if [ "$dry_run" = "1" ]; then
  echo "Dry-run only. No files will be changed."
  exit 0
fi

for cmd in curl tar python3; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: missing required command: $cmd" >&2
    exit 1
  fi
done

admin_token="${GITHUB_ADMIN_TOKEN:-${GH_TOKEN:-}}"
if [ -z "$admin_token" ]; then
  echo "ERROR: set GITHUB_ADMIN_TOKEN or GH_TOKEN with permission to create repo runner registration tokens." >&2
  exit 1
fi

if [ -f "$runner_dir/.runner" ] && [ "$replace" != "1" ]; then
  echo "ERROR: runner already configured in $runner_dir. Re-run with --replace after confirming it is safe." >&2
  exit 1
fi

mkdir -p "$runner_dir"
cd "$runner_dir"

if [ ! -x ./config.sh ]; then
  archive="actions-runner-linux-${runner_arch}-${runner_version}.tar.gz"
  echo "Downloading GitHub Actions runner: $runner_url"
  curl -fsSL "$runner_url" -o "$archive"
  tar xzf "$archive"
fi

if [ -f ".runner" ] && [ "$replace" = "1" ]; then
  echo "Removing existing runner registration before replacement"
  if [ -x ./svc.sh ]; then
    sudo ./svc.sh stop >/dev/null 2>&1 || true
    sudo ./svc.sh uninstall >/dev/null 2>&1 || true
  fi
  ./config.sh remove --unattended >/dev/null 2>&1 || true
fi

echo "Requesting one-time runner registration token"
registration_payload="$(
  curl -fsSL \
    -X POST \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer ${admin_token}" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "$api_url"
)"
registration_token="$(printf '%s' "$registration_payload" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))')"
if [ -z "$registration_token" ]; then
  echo "ERROR: GitHub API did not return a runner registration token." >&2
  exit 1
fi

echo "Configuring runner"
./config.sh \
  --unattended \
  --url "$github_url" \
  --token "$registration_token" \
  --name "$runner_name" \
  --labels "$labels" \
  --work "_work"

if [ "$install_service" = "1" ]; then
  echo "Installing and starting runner service"
  sudo ./svc.sh install
  sudo ./svc.sh start
else
  echo "Runner configured. Start it manually from $runner_dir with: ./run.sh"
fi

echo "Runner bootstrap complete. Re-run LLM Gateway Production Stage after the runner is online."
