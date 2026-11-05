#!/bin/bash
# install.sh - Void CLI Linux/macOS Installer
# Preferred: curl -fsSL https://get.void.borgov.dev/install.sh | bash

set -e

REPO="SUSCookie12/void-cli"
INSTALL_DIR="$HOME/.void"
BIN_NAME="voidmc"
VERSION_TAG="v0.1.7"
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

# Use HTTP/1.1 and retry to prevent HTTP/2 PROTOCOL_ERROR (err 1) on large GitHub/Azure assets
download_binary() {
    local url="$1"
    local dest="$2"

    if command -v curl >/dev/null 2>&1; then
        if curl -fSL --http1.1 --retry 3 --retry-delay 2 "$url" -o "$dest"; then
            return 0
        fi
    fi

    if command -v wget >/dev/null 2>&1; then
        echo "Retrying download with wget..."
        if wget -q --show-progress -O "$dest" "$url"; then
            return 0
        fi
    fi

    return 1
}

if ! download_binary "$BIN_URL_PINNED" "$INSTALL_DIR/$BIN_NAME"; then
    echo "Warning: Could not download ${VERSION_TAG}, trying latest release..."
    if ! download_binary "$BIN_URL_LATEST" "$INSTALL_DIR/$BIN_NAME"; then
        echo "❌ Download failed. Please check your network connection or download manually from:"
        echo "   $BIN_URL_PINNED"
        exit 1
    fi
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
