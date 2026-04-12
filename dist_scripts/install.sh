#!/bin/bash
# install.sh - Void CLI Linux/macOS Installer
# Preferred: curl -fsSL https://raw.githubusercontent.com/SUSCookie12/void-cli/main/dist_scripts/install.sh | bash
# Legacy mirror (update when releasing): https://voidmc.cspack.online/install.sh

set -e

REPO="SUSCookie12/void-cli"
INSTALL_DIR="$HOME/.void"
BIN_NAME="voidmc"
VERSION_TAG="v0.1.4"
BIN_URL_PINNED="https://github.com/${REPO}/releases/download/${VERSION_TAG}/voidmc-linux"
BIN_URL_LATEST="https://github.com/${REPO}/releases/latest/download/voidmc-linux"

echo "🌑 Initializing Void CLI Installation..."

# Detect OS
OS="linux"
if [[ "$OSTYPE" == "darwin"* ]]; then
    OS="macos"
fi

mkdir -p "$INSTALL_DIR"

echo "Downloading Void CLI..."
if ! curl -fSL "$BIN_URL_PINNED" -o "$INSTALL_DIR/$BIN_NAME" 2>/dev/null; then
    echo "Warning: Could not download ${VERSION_TAG}, trying latest release..."
    curl -fSL "$BIN_URL_LATEST" -o "$INSTALL_DIR/$BIN_NAME"
fi

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
