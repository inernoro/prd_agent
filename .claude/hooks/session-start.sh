#!/bin/bash
set -euo pipefail

# Only run in Claude Code Web (remote) environment
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"

log() { echo "[session-start] $*"; }

ensure_pnpm() {
  if command -v pnpm &>/dev/null; then
    return
  fi

  log "pnpm not found, enabling via corepack..."
  if command -v corepack &>/dev/null; then
    corepack enable
    corepack prepare pnpm@latest --activate
  fi

  if ! command -v pnpm &>/dev/null; then
    log "WARNING: pnpm still unavailable, skip frontend setup"
    return 1
  fi
  return 0
}

# ------------------------------------------------------------------
# 1. Install .NET 8 SDK (if not already installed)
# ------------------------------------------------------------------
export DOTNET_ROOT="$HOME/.dotnet"
export PATH="$DOTNET_ROOT:$DOTNET_ROOT/tools:$PATH"

if ! command -v dotnet &>/dev/null || ! dotnet --list-sdks 2>/dev/null | grep -q "^8\."; then
  log "Installing .NET 8 SDK..."
  curl -sSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh
  chmod +x /tmp/dotnet-install.sh
  /tmp/dotnet-install.sh --channel 8.0 --install-dir "$HOME/.dotnet"
  rm -f /tmp/dotnet-install.sh
fi

log ".NET SDK: $(dotnet --version)"

# Persist PATH via CLAUDE_ENV_FILE
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export DOTNET_ROOT=\"$HOME/.dotnet\"" >> "$CLAUDE_ENV_FILE"
  echo "export PATH=\"$HOME/.dotnet:$HOME/.dotnet/tools:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi

# ------------------------------------------------------------------
# 2. Start NuGet Proxy Relay (workaround for dotnet/runtime#114066)
#    .NET HttpClient cannot send Proxy-Authorization with URL-embedded
#    JWT credentials used by the Claude Code Web sandbox proxy.
# ------------------------------------------------------------------
RELAY_SCRIPT="$PROJECT_DIR/scripts/nuget-proxy-relay.py"
if [ -f "$RELAY_SCRIPT" ]; then
  # Kill any stale relay
  pkill -f "nuget-proxy-relay.py" 2>/dev/null || true
  sleep 0.5

  log "Starting NuGet proxy relay..."
  python3 "$RELAY_SCRIPT" &
  RELAY_PID=$!
  sleep 1

  if kill -0 "$RELAY_PID" 2>/dev/null; then
    log "NuGet proxy relay running (PID: $RELAY_PID, port 18080)"
  else
    log "WARNING: NuGet proxy relay failed to start"
    RELAY_PID=""
  fi
else
  log "WARNING: nuget-proxy-relay.py not found at $RELAY_SCRIPT"
  RELAY_PID=""
fi

# ------------------------------------------------------------------
# 3. dotnet restore (through proxy relay)
# ------------------------------------------------------------------
SLN="$PROJECT_DIR/prd-api/PrdAgent.sln"
if [ -f "$SLN" ]; then
  log "Restoring NuGet packages..."
  cd "$PROJECT_DIR/prd-api"
  if [ -n "${RELAY_PID:-}" ]; then
    HTTPS_PROXY=http://127.0.0.1:18080 HTTP_PROXY=http://127.0.0.1:18080 \
      dotnet restore PrdAgent.sln
  else
    dotnet restore PrdAgent.sln || log "WARNING: dotnet restore failed (proxy auth issue?)"
  fi
  log "NuGet restore done"
fi

# ------------------------------------------------------------------
# 4. Frontend dependencies (pnpm install)
# ------------------------------------------------------------------
cd "$PROJECT_DIR"

if ensure_pnpm; then
  if [ -f "$PROJECT_DIR/prd-admin/package.json" ]; then
    if [ -f "$PROJECT_DIR/prd-admin/pnpm-lock.yaml" ]; then
      log "Warming pnpm store for prd-admin..."
      pnpm -C "$PROJECT_DIR/prd-admin" fetch --frozen-lockfile 2>&1 || log "WARNING: pnpm fetch failed for prd-admin"
    fi

    log "Installing prd-admin dependencies (prefer offline)..."
    pnpm -C "$PROJECT_DIR/prd-admin" install --frozen-lockfile --prefer-offline 2>&1 || log "WARNING: prd-admin install failed"
  fi

  for subdir in prd-desktop prd-video; do
    if [ -f "$PROJECT_DIR/$subdir/package.json" ]; then
      log "Installing $subdir dependencies (pnpm)..."
      pnpm -C "$PROJECT_DIR/$subdir" install --frozen-lockfile --prefer-offline 2>&1 || log "WARNING: $subdir install failed"
    fi
  done
fi

cd "$PROJECT_DIR"

# ------------------------------------------------------------------
# 5. Verification commands required by cloud setup
# ------------------------------------------------------------------
if [ -d "$PROJECT_DIR/prd-api" ]; then
  log "Verifying backend build command: dotnet build prd-api"
  cd "$PROJECT_DIR"
  dotnet build prd-api 2>&1 || log "WARNING: dotnet build prd-api failed"
fi

if command -v pnpm &>/dev/null && [ -d "$PROJECT_DIR/prd-admin" ]; then
  log "Verifying frontend command: pnpm -C prd-admin tsc --noEmit"
  pnpm -C "$PROJECT_DIR/prd-admin" tsc --noEmit 2>&1 || log "WARNING: pnpm -C prd-admin tsc --noEmit failed"
fi

cd "$PROJECT_DIR"

# ------------------------------------------------------------------
# 6. Stop proxy relay (no longer needed after restore)
# ------------------------------------------------------------------
if [ -n "${RELAY_PID:-}" ] && kill -0 "$RELAY_PID" 2>/dev/null; then
  kill "$RELAY_PID" 2>/dev/null || true
  wait "$RELAY_PID" 2>/dev/null || true
  log "NuGet proxy relay stopped"
fi

log "Session setup complete!"
