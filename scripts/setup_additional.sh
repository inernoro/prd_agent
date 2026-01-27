#!/bin/bash
set -e

echo "Starting Additional Setup (Python, NVM check, .NET check)..."

# 1. Verify NVM
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
    \. "$NVM_DIR/nvm.sh"
    echo "✅ NVM is installed: $(nvm --version)"
    echo "✅ Node is installed: $(node --version)"
else
    echo "⚠️ NVM not detected in current shell. Attempting to reinstall/repair..."
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
    \. "$NVM_DIR/nvm.sh"
    echo "✅ NVM installed: $(nvm --version)"
fi

# 2. Verify .NET 8
if [ -f "$HOME/.dotnet/dotnet" ]; then
    export DOTNET_ROOT=$HOME/.dotnet
    export PATH=$PATH:$DOTNET_ROOT:$DOTNET_ROOT/tools
fi

if command -v dotnet >/dev/null; then
    VERSION=$(dotnet --version)
    if [[ "$VERSION" == 8.* ]]; then
        echo "✅ .NET 8 SDK is installed: $VERSION"
    else
        echo "⚠️ .NET installed but version is $VERSION. Installing .NET 8..."
        curl -L https://dot.net/v1/dotnet-install.sh -o dotnet-install.sh
        chmod +x dotnet-install.sh
        ./dotnet-install.sh --channel 8.0
        echo "✅ .NET 8 SDK installed."
    fi
else
    echo "⚠️ .NET not found. Installing..."
    curl -L https://dot.net/v1/dotnet-install.sh -o dotnet-install.sh
    chmod +x dotnet-install.sh
    ./dotnet-install.sh --channel 8.0
    echo "✅ .NET 8 SDK installed."
fi

# 3. Install Python (via uv)
# Using uv is the modern, fast, sudo-less way to manage Python versions
if ! command -v uv >/dev/null; then
    echo "Installing uv (Python manager)..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    source "$HOME/.cargo/env" 2>/dev/null || true
    # Add ~/.local/bin to PATH if not there (uv standard location)
    export PATH="$HOME/.local/bin:$PATH"
else
    echo "✅ uv is already installed."
fi

echo "Installing Python 3.12 via uv..."
# uv python install will install a managed python version
"$HOME/.local/bin/uv" python install 3.12

echo ""
echo "========================================================"
echo "Additional Setup Complete!"
echo "========================================================"
echo "1. NVM: Verified."
echo "2. .NET 8: Verified."
echo "3. Python: Installed 3.12 via 'uv'."
echo ""
echo "To use the new Python 3.12, you can use 'uv run python' or add it to your path."
echo "('uv' is installed to ~/.local/bin)"
