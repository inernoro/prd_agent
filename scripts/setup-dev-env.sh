#!/usr/bin/env bash
# ============================================================
# PrdAgent - Dev Environment One-Click Setup
# Supported: Ubuntu/Debian (apt), macOS (brew)
# Installs: .NET 8 SDK, Node.js 22 + pnpm, Rust (stable), system libs
# Then: dotnet restore, npm install for all frontend projects
# ============================================================
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ---------- detect OS ----------
OS="$(uname -s)"
case "$OS" in
  Linux*)  PLATFORM="linux" ;;
  Darwin*) PLATFORM="mac" ;;
  *)       error "Unsupported OS: $OS" ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

info "Project root: $PROJECT_ROOT"
info "Platform: $PLATFORM"

# ============================================================
# 1. System dependencies
# ============================================================
install_system_deps() {
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
# 2. .NET 8 SDK
# ============================================================
install_dotnet() {
  if command -v dotnet &>/dev/null && dotnet --list-sdks 2>/dev/null | grep -q "^8\."; then
    info ".NET 8 SDK already installed: $(dotnet --version)"
    return
  fi
  info "Installing .NET 8 SDK..."
  if [ "$PLATFORM" = "linux" ]; then
    # Microsoft official install script
    curl -sSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh
    chmod +x /tmp/dotnet-install.sh
    /tmp/dotnet-install.sh --channel 8.0 --install-dir "$HOME/.dotnet"
    export DOTNET_ROOT="$HOME/.dotnet"
    export PATH="$DOTNET_ROOT:$DOTNET_ROOT/tools:$PATH"
    # persist to profile
    grep -q 'DOTNET_ROOT' "$HOME/.bashrc" 2>/dev/null || {
      cat >> "$HOME/.bashrc" <<'DOTNET_EOF'

# .NET SDK
export DOTNET_ROOT="$HOME/.dotnet"
export PATH="$DOTNET_ROOT:$DOTNET_ROOT/tools:$PATH"
DOTNET_EOF
    }
  elif [ "$PLATFORM" = "mac" ]; then
    brew install --cask dotnet-sdk 2>/dev/null || brew install dotnet@8
  fi
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
    # Ensure stable and up to date
    rustup update stable 2>/dev/null || true
  else
    info "Installing Rust via rustup..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
    source "$HOME/.cargo/env"
  fi

  # Tauri CLI
  if ! command -v cargo-tauri &>/dev/null && ! cargo install --list 2>/dev/null | grep -q "tauri-cli"; then
    info "Installing Tauri CLI..."
    cargo install tauri-cli 2>/dev/null || warn "tauri-cli install failed, you can install it later"
  fi

  info "Rust version: $(rustc --version)"
  info "Cargo version: $(cargo --version)"
}

# ============================================================
# 5. Project restore / install
# ============================================================
restore_dotnet() {
  info "Restoring .NET packages (dotnet restore)..."
  cd "$PROJECT_ROOT/prd-api"
  dotnet restore PrdAgent.sln
  info "dotnet restore completed."

  info "Verifying build..."
  dotnet build --no-restore 2>&1 | tail -5
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
# 6. Summary
# ============================================================
print_summary() {
  echo ""
  echo "============================================================"
  info "Dev environment setup complete!"
  echo "============================================================"
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
  echo ""
  echo "  NOTE: Run 'source ~/.bashrc' or open a new terminal if PATH is not updated."
  echo "============================================================"
}

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
  restore_dotnet
  install_frontend_deps
  print_summary
}

main "$@"
