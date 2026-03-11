#!/bin/bash
#
# J41 Dispatcher Installer
# One-line setup: curl -fsSL https://.../install.sh | bash
#

set -e

J41_VERSION="1.0.0"
INSTALL_DIR="${HOME}/.j41/dispatcher"
REPO_URL="https://github.com/autobb888/j41-dispatcher"

echo "╔══════════════════════════════════════════╗"
echo "║     J41 Dispatcher Installer             ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# Check dependencies
echo "→ Checking dependencies..."

if ! command -v docker &> /dev/null; then
    echo "❌ Docker is required but not installed"
    echo "   Install: https://docs.docker.com/get-docker/"
    exit 1
fi
echo "✓ Docker found"

if ! command -v node &> /dev/null; then
    echo "❌ Node.js is required but not installed"
    echo "   Install: https://nodejs.org/"
    exit 1
fi
echo "✓ Node.js found"

if ! command -v yarn &> /dev/null; then
    echo "→ Installing yarn..."
    npm install -g yarn
fi
echo "✓ yarn found"

# Create directories
echo ""
echo "→ Creating directories..."
mkdir -p "$INSTALL_DIR"

# Clone or update dispatcher
echo ""
echo "→ Installing dispatcher..."

if [ -d "$INSTALL_DIR/.git" ]; then
    cd "$INSTALL_DIR"
    git pull
else
    git clone "$REPO_URL" "$INSTALL_DIR" 2>/dev/null || {
        echo "⚠️  Clone failed, trying release download"
        curl -fsSL "$REPO_URL/releases/download/v${J41_VERSION}/j41-dispatcher-${J41_VERSION}.tar.gz" | tar -xz -C "$INSTALL_DIR" --strip-components=1 2>/dev/null || {
            echo "❌ Could not install dispatcher"
            exit 1
        }
    }
fi

# Install dependencies
cd "$INSTALL_DIR"
yarn install

# Create symlink
echo ""
echo "→ Creating command shortcut..."
mkdir -p "$HOME/.local/bin"
ln -sf "$INSTALL_DIR/src/cli.js" "$HOME/.local/bin/j41-dispatcher"
chmod +x "$INSTALL_DIR/src/cli.js"

# Add to PATH if needed
if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
    echo "✓ Added ~/.local/bin to PATH (restart terminal to use)"
fi

# Final message
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║     Installation Complete!               ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo "  1. Ensure ~/.local/bin is in your PATH"
echo "  2. Initialize agents: j41-dispatcher init -n 9"
echo "  3. Register agents:   j41-dispatcher register agent-1 myagent"
echo "  4. Start dispatcher:  j41-dispatcher start"
echo ""
