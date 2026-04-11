#!/bin/bash
# install.sh - Void CLI Linux/macOS Installer
# Usage: curl -sSL https://raw.githubusercontent.com/SUSCookie12/void-cli/main/install.sh | bash

set -e

REPO="SUSCookie12/void-cli"
INSTALL_DIR="$HOME/.void"
BIN_NAME="voidmc"
BIN_URL="https://github.com/$REPO/releases/latest/download/void-server-linux"

echo "🌑 Initializing Void CLI Installation..."

# Detect OS
OS="linux"
if [[ "$OSTYPE" == "darwin"* ]]; then
    OS="macos"
fi

# Create directory
mkdir -p "$INSTALL_DIR"

# Download latest release
echo "Downloading Void CLI..."
curl -L "$BIN_URL" -o "$INSTALL_DIR/$BIN_NAME"
chmod +x "$INSTALL_DIR/$BIN_NAME"

echo "✅ Binary downloaded to $INSTALL_DIR"

# Path setup
if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
    SHELL_PROFILE=""
    if [ -f "$HOME/.bashrc" ]; then SHELL_PROFILE="$HOME/.bashrc"; fi
    if [ -f "$HOME/.zshrc" ]; then SHELL_PROFILE="$HOME/.zshrc"; fi
    
    if [ -n "$SHELL_PROFILE" ]; then
        echo "export PATH=\"\$PATH:$INSTALL_DIR\"" >> "$SHELL_PROFILE"
        echo "✨ Added $INSTALL_DIR to $SHELL_PROFILE"
    fi
fi

echo "🚀 Installation complete! Restart your shell or run: source $SHELL_PROFILE"
