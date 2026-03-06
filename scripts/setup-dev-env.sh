#!/usr/bin/env bash
# ============================================================
# PrdAgent - Dev Environment One-Click Setup
# Auto-detects: Local CLI vs Claude Code Web sandbox
# Installs: .NET 8 SDK, Node.js 22 + pnpm, Rust (stable), system libs
# Then: dotnet restore (with proxy relay for Web sandbox), pnpm install
# ============================================================
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ---------- detect OS & mode ----------
OS="$(uname -s)"
case "$OS" in
  Linux*)  PLATFORM="linux" ;;
  Darwin*) PLATFORM="mac" ;;
  *)       error "Unsupported OS: $OS" ;;
esac

IS_WEB_SANDBOX=false
if [ -n "${HTTPS_PROXY:-}" ] && echo "${HTTPS_PROXY:-}" | grep -q "container_" 2>/dev/null; then
  IS_WEB_SANDBOX=true
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

info "Project root: $PROJECT_ROOT"
info "Platform: $PLATFORM"
info "Mode: $([ "$IS_WEB_SANDBOX" = true ] && echo 'Claude Code Web (sandbox)' || echo 'Local CLI')"

# ============================================================
# 1. System dependencies (skip in Web sandbox - most tools preinstalled)
# ============================================================
install_system_deps() {
  if [ "$IS_WEB_SANDBOX" = true ]; then
    info "Web sandbox detected, skipping apt-get (use dotnet-install.sh instead)"
    return
  fi

  info "Installing system dependencies..."
  if [ "$PLATFORM" = "linux" ]; then
    sudo apt-get update -qq
    sudo apt-get install -y -qq \
      curl wget git build-essential pkg-config \
      libssl-dev libwebkit2gtk-4.1-dev libgtk-3-dev \
      libayatana-appindicator3-dev librsvg2-dev \
      libjavascriptcoregtk-4.1-dev libsoup-3.0-dev \
      ca-certificates gnupg unzip python3 python3-pip \
      2>/dev/null
  elif [ "$PLATFORM" = "mac" ]; then
    if ! command -v brew &>/dev/null; then
      warn "Homebrew not found, installing..."
      /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    fi
    brew install curl wget git pkg-config openssl python3 2>/dev/null || true
  fi
}

# ============================================================
# 2. .NET 8 SDK (dotnet-install.sh works in both modes)
# ============================================================
install_dotnet() {
  # Check existing install (including ~/.dotnet)
  export DOTNET_ROOT="${DOTNET_ROOT:-$HOME/.dotnet}"
  export PATH="$DOTNET_ROOT:$DOTNET_ROOT/tools:$PATH"

  if command -v dotnet &>/dev/null && dotnet --list-sdks 2>/dev/null | grep -q "^8\."; then
    info ".NET 8 SDK already installed: $(dotnet --version)"
    return
  fi

  info "Installing .NET 8 SDK via dotnet-install.sh..."
  curl -sSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh
  chmod +x /tmp/dotnet-install.sh
  /tmp/dotnet-install.sh --channel 8.0 --install-dir "$HOME/.dotnet"
  rm -f /tmp/dotnet-install.sh

  # Persist PATH
  grep -q 'DOTNET_ROOT' "$HOME/.bashrc" 2>/dev/null || {
    cat >> "$HOME/.bashrc" <<'DOTNET_EOF'

# .NET SDK
export DOTNET_ROOT="$HOME/.dotnet"
export PATH="$DOTNET_ROOT:$DOTNET_ROOT/tools:$PATH"
DOTNET_EOF
  }
  info ".NET SDK version: $(dotnet --version)"
}

# ============================================================
# 3. Node.js 22 (via nvm) + pnpm
# ============================================================
install_node() {
  local REQUIRED_MAJOR=22

  # Load nvm if available
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

  if command -v node &>/dev/null; then
    local CURRENT_MAJOR
    CURRENT_MAJOR=$(node -v | sed 's/^v//' | cut -d. -f1)
    if [ "$CURRENT_MAJOR" -ge "$REQUIRED_MAJOR" ]; then
      info "Node.js already installed: $(node -v)"
    else
      warn "Node.js $(node -v) found, need v${REQUIRED_MAJOR}+. Upgrading..."
      install_nvm_and_node "$REQUIRED_MAJOR"
    fi
  else
    install_nvm_and_node "$REQUIRED_MAJOR"
  fi

  # Install pnpm
  if ! command -v pnpm &>/dev/null; then
    info "Installing pnpm..."
    npm install -g pnpm
  fi
  info "pnpm version: $(pnpm -v)"
  info "Node.js version: $(node -v)"
}

install_nvm_and_node() {
  local MAJOR=$1
  if ! command -v nvm &>/dev/null; then
    info "Installing nvm..."
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  fi
  info "Installing Node.js v${MAJOR} via nvm..."
  nvm install "$MAJOR"
  nvm use "$MAJOR"
  nvm alias default "$MAJOR"
}

# ============================================================
# 4. Rust (stable, edition 2021)
# ============================================================
install_rust() {
  if command -v rustc &>/dev/null; then
    info "Rust already installed: $(rustc --version)"
    rustup update stable 2>/dev/null || true
  else
    info "Installing Rust via rustup..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
    source "$HOME/.cargo/env"
  fi

  # Tauri CLI
  if ! command -v cargo-tauri &>/dev/null && ! cargo install --list 2>/dev/null | grep -q "tauri-cli"; then
    info "Installing Tauri CLI..."
    cargo install tauri-cli 2>/dev/null || warn "tauri-cli install failed, install later if needed"
  fi

  info "Rust version: $(rustc --version)"
  info "Cargo version: $(cargo --version)"
}

# ============================================================
# 5. NuGet Proxy Relay (Web sandbox only)
# ============================================================
RELAY_PID=""

start_nuget_relay() {
  if [ "$IS_WEB_SANDBOX" != true ]; then
    return
  fi

  local RELAY_SCRIPT="$PROJECT_ROOT/scripts/nuget-proxy-relay.py"
  if [ ! -f "$RELAY_SCRIPT" ]; then
    warn "nuget-proxy-relay.py not found, dotnet restore may fail"
    return
  fi

  # Kill any existing relay
  pkill -f "nuget-proxy-relay.py" 2>/dev/null || true

  info "Starting NuGet proxy relay (Web sandbox workaround for dotnet/runtime#114066)..."
  python3 "$RELAY_SCRIPT" &
  RELAY_PID=$!
  sleep 1

  if kill -0 $RELAY_PID 2>/dev/null; then
    info "NuGet proxy relay running (PID: $RELAY_PID)"
  else
    warn "NuGet proxy relay failed to start"
    RELAY_PID=""
  fi
}

stop_nuget_relay() {
  if [ -n "$RELAY_PID" ] && kill -0 $RELAY_PID 2>/dev/null; then
    kill $RELAY_PID 2>/dev/null || true
    wait $RELAY_PID 2>/dev/null || true
    info "NuGet proxy relay stopped"
  fi
}

# ============================================================
# 6. Project restore / install
# ============================================================
restore_dotnet() {
  info "Restoring .NET packages (dotnet restore)..."
  cd "$PROJECT_ROOT/prd-api"

  if [ "$IS_WEB_SANDBOX" = true ] && [ -n "$RELAY_PID" ]; then
    # Route NuGet traffic through proxy relay
    HTTPS_PROXY=http://127.0.0.1:18080 HTTP_PROXY=http://127.0.0.1:18080 \
      dotnet restore PrdAgent.sln
  else
    dotnet restore PrdAgent.sln
  fi
  info "dotnet restore completed."

  info "Verifying build..."
  BUILD_OUTPUT=$(dotnet build --no-restore 2>&1)
  if echo "$BUILD_OUTPUT" | grep -q "Build succeeded"; then
    ERRORS=$(echo "$BUILD_OUTPUT" | grep -c "error CS" || true)
    WARNINGS=$(echo "$BUILD_OUTPUT" | grep -c "warning CS" || true)
    info "Build succeeded. ${ERRORS} error(s), ${WARNINGS} warning(s)"
  else
    warn "Build output (last 10 lines):"
    echo "$BUILD_OUTPUT" | tail -10
  fi
  cd "$PROJECT_ROOT"
}

install_frontend_deps() {
  info "Installing prd-admin dependencies..."
  cd "$PROJECT_ROOT/prd-admin"
  pnpm install
  cd "$PROJECT_ROOT"

  info "Installing prd-desktop dependencies..."
  cd "$PROJECT_ROOT/prd-desktop"
  pnpm install
  cd "$PROJECT_ROOT"

  if [ -d "$PROJECT_ROOT/prd-video" ]; then
    info "Installing prd-video dependencies..."
    cd "$PROJECT_ROOT/prd-video"
    pnpm install || npm install
    cd "$PROJECT_ROOT"
  fi
}

# ============================================================
# 7. Summary
# ============================================================
print_summary() {
  echo ""
  echo "============================================================"
  info "Dev environment setup complete!"
  echo "============================================================"
  echo ""
  echo "  Mode: $([ "$IS_WEB_SANDBOX" = true ] && echo 'Claude Code Web (sandbox)' || echo 'Local CLI')"
  echo ""
  echo "  Installed SDKs:"
  command -v dotnet &>/dev/null && echo "    .NET SDK     : $(dotnet --version)"
  command -v node   &>/dev/null && echo "    Node.js      : $(node -v)"
  command -v pnpm   &>/dev/null && echo "    pnpm         : $(pnpm -v)"
  command -v rustc  &>/dev/null && echo "    Rust         : $(rustc --version | awk '{print $2}')"
  command -v cargo  &>/dev/null && echo "    Cargo        : $(cargo --version | awk '{print $2}')"
  echo ""
  echo "  Quick start commands:"
  echo "    # Backend API (hot reload)"
  echo "    cd prd-api && dotnet watch run --project src/PrdAgent.Api"
  echo ""
  echo "    # Admin frontend"
  echo "    cd prd-admin && pnpm dev"
  echo ""
  echo "    # Desktop app"
  echo "    cd prd-desktop && pnpm tauri:dev"
  echo ""
  echo "    # Video project"
  echo "    cd prd-video && npx remotion studio"
  echo ""
  echo "    # Docker (full stack)"
  echo "    docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build"

  if [ "$IS_WEB_SANDBOX" = true ]; then
    echo ""
    echo "  Web sandbox notes:"
    echo "    - NuGet restore requires proxy relay: python3 scripts/nuget-proxy-relay.py &"
    echo "    - Then: HTTPS_PROXY=http://127.0.0.1:18080 dotnet restore"
    echo "    - External DB connections may be blocked by sandbox network"
  fi

  echo ""
  echo "  NOTE: Run 'source ~/.bashrc' or open a new terminal if PATH is not updated."
  echo "============================================================"
}

# ============================================================
# Cleanup
# ============================================================
cleanup() {
  stop_nuget_relay
}
trap cleanup EXIT

# ============================================================
# Main
# ============================================================
main() {
  info "Starting PrdAgent dev environment setup..."
  echo ""

  install_system_deps
  install_dotnet
  install_node
  install_rust
  start_nuget_relay
  restore_dotnet
  install_frontend_deps
  print_summary
}

main "$@"
