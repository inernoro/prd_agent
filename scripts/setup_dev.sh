#!/bin/bash
set -e

echo "Starting Environment Setup for PRD Agent..."
echo "This script installs specific versions of SDKs locally (Rust, Node.js, .NET)."

# 1. Rust (Rustup)
if ! command -v cargo &> /dev/null; then
    if [ -f "$HOME/.cargo/env" ]; then
        source "$HOME/.cargo/env"
    fi
fi

if ! command -v cargo &> /dev/null; then
    echo "Installing Rust (via rustup)..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    
    # Source environment to use it immediately in this script
    source "$HOME/.cargo/env"
else
    echo "Rust is already installed."
fi

# 2. Node.js (via NVM)
# Check if nvm is already loaded or installed
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
    \. "$NVM_DIR/nvm.sh"
fi

if ! command -v node &> /dev/null; then
    echo "Installing NVM..."
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
    
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    
    echo "Installing Node.js 18..."
    nvm install 18
    nvm use 18
    echo "Enabling corepack (for pnpm)..."
    corepack enable
else
    echo "Node.js is already installed."
fi

# 3. .NET 8 SDK (via dotnet-install.sh)
if ! command -v dotnet &> /dev/null; then
    # check default location
    if [ -f "$HOME/.dotnet/dotnet" ]; then
        export DOTNET_ROOT=$HOME/.dotnet
        export PATH=$PATH:$DOTNET_ROOT:$DOTNET_ROOT/tools
    fi
fi

if ! command -v dotnet &> /dev/null; then
    echo "Installing .NET 8 SDK..."
    curl -L https://dot.net/v1/dotnet-install.sh -o dotnet-install.sh
    chmod +x dotnet-install.sh
    ./dotnet-install.sh --channel 8.0
    rm dotnet-install.sh
    
    # Export for current session
    export DOTNET_ROOT=$HOME/.dotnet
    export PATH=$PATH:$DOTNET_ROOT:$DOTNET_ROOT/tools
else
    echo ".NET SDK is already installed."
fi

echo ""
echo "========================================================"
echo "Installation complete!"
echo "========================================================"
echo "1. Rust: Installed."
echo "2. Node.js: Installed (v18)."
echo "3. .NET 8: Installed."
echo ""
echo "IMPORTANT STEPS REMAINING:"
echo "1. Docker Desktop: You must install this MANUALLY."
echo "   Download: https://www.docker.com/products/docker-desktop/"
echo ""
echo "2. Shell Configuration: Please restart your terminal or source your profiles."
echo "   - For .NET, add these lines to your ~/.zshrc or ~/.bashrc:"
echo "     export DOTNET_ROOT=\$HOME/.dotnet"
echo "     export PATH=\$PATH:\$DOTNET_ROOT:\$DOTNET_ROOT/tools"
echo "========================================================"
