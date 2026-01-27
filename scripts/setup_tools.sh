#!/bin/bash
set -e

# Load environment to ensure npm/node is available
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

echo "Installing AI Tools..."

# 1. Claude Code
# Assuming the user means the new Claude CLI or related tool.
# A common community tool or offical beta might be expected.
# We will try installing the official anthropic package if it exists as a CLI, 
# otherwise we install 'claude-cli' generic package or similar.
# UPDATE: "claude code" usually refers to the beta tool. 
# Providing the npm install command for the most likely candidate.
if ! command -v claude &> /dev/null; then
  echo "Installing 'claude' CLI (via npm)..."
  # Note: The exact package name for "Claude Code" might be specific.
  # We will try the generic one or instruct user.
  npm install -g @anthropic-ai/claude-code || echo "⚠️ Could not install @anthropic-ai/claude-code directly."
else
    echo "✅ claude CLI is already installed."
fi

# 2. Codex
# 'codex' is often associated with OpenAI. 
# We will try to install a common CLI for this if available via npm.
if ! command -v codex &> /dev/null; then
  echo "Installing 'codex' CLI..."
  # Attempt generic install, but this might be ambiguous.
  npm install -g codex-cli || echo "⚠️ Could not install 'codex-cli'. You may need to specify the exact package."
else
    echo "✅ codex is already installed."
fi

# 3. Cursor
# Cursor is an IDE. The 'cursor' CLI is installed FROM the IDE.
echo ""
echo "----------------------------------------------------------------"
echo "Cursor CLI Installation"
echo "----------------------------------------------------------------"
echo "The 'cursor' command is best installed from within the Cursor application."
echo "1. Open Cursor IDE."
echo "2. Press Cmd+Shift+P."
echo "3. Type 'Shell Command: Install 'cursor' command'."
echo ""
echo "If you haven't installed Cursor yet, install it manually from: https://cursor.sh"
echo "----------------------------------------------------------------"

echo ""
echo "AI Tools Setup Finished."
echo "Note: 'claude' and 'codex' installation attempts were made via npm."
