#!/bin/bash
# install.sh - Void CLI Linux/macOS Installer
# Usage: curl -sSL https://raw.githubusercontent.com/SUSCookie12/void-cli/main/install.sh | bash

set -e

REPO="SUSCookie12/void-cli"
INSTALL_DIR="$HOME/.void"
BIN_NAME="void"

echo "🌑 Initializing Void CLI Installation..."

# Detect OS
OS="linux"
if [[ "$OSTYPE" == "darwin"* ]]; then
    OS="macos"
fi

# Create directory
mkdir -p "$INSTALL_DIR"

# Download latest release (example logic using GitHub API)
# LATEST_URL=$(curl -s https://api.github.com/repos/$REPO/releases/latest | grep "browser_download_url.*$OS" | cut -d '"' -f 4)
# curl -L "$LATEST_URL" -o "$INSTALL_DIR/void.tar.gz"
# tar -xzf "$INSTALL_DIR/void.tar.gz" -C "$INSTALL_DIR"

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
