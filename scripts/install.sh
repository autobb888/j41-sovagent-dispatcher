#!/bin/bash
#
# J41 Dispatcher Installer
# One-line setup: curl -fsSL https://.../install.sh | bash
#
# Automatically installs Node.js, yarn, and detects Docker.
# If Docker is not available, offers local process mode.
#

set -e

J41_VERSION="1.0.0"
INSTALL_DIR="${HOME}/.j41/dispatcher"
REPO_URL="https://github.com/autobb888/j41-dispatcher"

echo "╔══════════════════════════════════════════╗"
echo "║     J41 Dispatcher Installer             ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ─────────────────────────────────────────
# STEP 1: Install Node.js if missing
# ─────────────────────────────────────────
echo "→ Checking dependencies..."

if ! command -v node &> /dev/null; then
    echo ""
    echo "  Node.js not found. Installing..."

    # Try nvm first (no sudo required)
    if [ -s "$HOME/.nvm/nvm.sh" ]; then
        . "$HOME/.nvm/nvm.sh"
        nvm install 22
    elif command -v curl &> /dev/null; then
        echo "  → Installing via nvm (no sudo needed)..."
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash 2>/dev/null
        export NVM_DIR="$HOME/.nvm"
        . "$NVM_DIR/nvm.sh"
        nvm install 22
    elif command -v apt-get &> /dev/null; then
        echo "  → Installing via apt (requires sudo)..."
        curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
        sudo apt-get install -y nodejs
    elif command -v dnf &> /dev/null; then
        echo "  → Installing via dnf (requires sudo)..."
        curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo -E bash -
        sudo dnf install -y nodejs
    elif command -v brew &> /dev/null; then
        echo "  → Installing via Homebrew..."
        brew install node@22
    else
        echo "  ❌ Cannot auto-install Node.js."
        echo "     Install manually: https://nodejs.org/"
        exit 1
    fi
fi

# Ensure nvm is loaded if installed
if [ -s "$HOME/.nvm/nvm.sh" ] && ! command -v node &> /dev/null; then
    . "$HOME/.nvm/nvm.sh"
fi

echo "  ✓ Node.js $(node --version)"

# ─────────────────────────────────────────
# STEP 2: Install yarn if missing
# ─────────────────────────────────────────
if ! command -v yarn &> /dev/null; then
    echo "  → Installing yarn..."
    npm install -g yarn
fi
echo "  ✓ yarn $(yarn --version)"

# ─────────────────────────────────────────
# STEP 3: Detect Docker and choose runtime
# ─────────────────────────────────────────
RUNTIME="docker"

if command -v docker &> /dev/null; then
    # Verify Docker daemon is actually running
    if docker info &> /dev/null; then
        echo "  ✓ Docker found and running"
    else
        echo "  ⚠️  Docker installed but daemon not running"
        DOCKER_AVAILABLE=false
    fi
    DOCKER_AVAILABLE=${DOCKER_AVAILABLE:-true}
else
    DOCKER_AVAILABLE=false
fi

if [ "$DOCKER_AVAILABLE" = "false" ]; then
    echo ""
    echo "  Docker is not available."
    echo ""

    # Check if running non-interactively (piped)
    if [ ! -t 0 ]; then
        RUNTIME="local"
        echo "  → Non-interactive mode: using local process mode"
    else
        echo "  Choose runtime mode:"
        echo "    1) Install Docker (recommended for production — container isolation)"
        echo "    2) Local process mode (no Docker needed — great for dev/testing)"
        echo ""
        read -p "  Enter choice [1/2] (default: 2): " CHOICE
        CHOICE=${CHOICE:-2}

        case "$CHOICE" in
            1)
                echo ""
                echo "  → Installing Docker..."
                if command -v curl &> /dev/null; then
                    curl -fsSL https://get.docker.com | sh
                    sudo usermod -aG docker "$USER" 2>/dev/null || true
                    echo "  ✓ Docker installed"
                    echo "  ℹ️  You may need to log out and back in for Docker group permissions"
                    RUNTIME="docker"
                else
                    echo "  ❌ curl not found — install Docker manually: https://get.docker.com"
                    RUNTIME="local"
                fi
                ;;
            *)
                RUNTIME="local"
                echo "  ✓ Using local process mode"
                ;;
        esac
    fi
fi

echo ""
echo "  Runtime: ${RUNTIME}"

# ─────────────────────────────────────────
# STEP 4: Clone/update dispatcher
# ─────────────────────────────────────────
echo ""
echo "→ Installing dispatcher..."

mkdir -p "$INSTALL_DIR"

if [ -d "$INSTALL_DIR/.git" ]; then
    cd "$INSTALL_DIR"
    git pull
else
    git clone "$REPO_URL" "$INSTALL_DIR" 2>/dev/null || {
        echo "  ⚠️  Clone failed, trying release download"
        curl -fsSL "$REPO_URL/releases/download/v${J41_VERSION}/j41-dispatcher-${J41_VERSION}.tar.gz" | tar -xz -C "$INSTALL_DIR" --strip-components=1 2>/dev/null || {
            echo "  ❌ Could not install dispatcher"
            exit 1
        }
    }
fi

# ─────────────────────────────────────────
# STEP 5: Install dependencies
# ─────────────────────────────────────────
cd "$INSTALL_DIR"
echo ""
echo "→ Installing dependencies..."
yarn install
echo "  ✓ Dependencies installed"

# ─────────────────────────────────────────
# STEP 6: Save runtime config
# ─────────────────────────────────────────
mkdir -p "${HOME}/.j41/dispatcher"
cat > "${HOME}/.j41/dispatcher/config.json" << EOJSON
{
  "runtime": "${RUNTIME}"
}
EOJSON
echo "  ✓ Config saved (runtime: ${RUNTIME})"

# ─────────────────────────────────────────
# STEP 7: Build Docker image (if Docker mode)
# ─────────────────────────────────────────
if [ "$RUNTIME" = "docker" ]; then
    echo ""
    echo "→ Building Docker image..."
    ./scripts/build-image.sh && echo "  ✓ Image built" || echo "  ⚠️  Image build failed (can retry later with: ./scripts/build-image.sh)"
else
    echo ""
    echo "  → Skipping Docker image build (local process mode)"
fi

# ─────────────────────────────────────────
# STEP 8: Create symlink
# ─────────────────────────────────────────
echo ""
echo "→ Creating command shortcut..."
mkdir -p "$HOME/.local/bin"
ln -sf "$INSTALL_DIR/src/cli.js" "$HOME/.local/bin/j41-dispatcher"
chmod +x "$INSTALL_DIR/src/cli.js"

# Add to PATH if needed
if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
    SHELL_RC="$HOME/.bashrc"
    [ -f "$HOME/.zshrc" ] && SHELL_RC="$HOME/.zshrc"
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$SHELL_RC"
    echo "  ✓ Added ~/.local/bin to PATH (restart terminal to use)"
fi

# ─────────────────────────────────────────
# Done
# ─────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║     Installation Complete!               ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "Runtime mode: ${RUNTIME}"
echo ""
echo "Next steps:"
echo "  1. Initialize agents:  j41-dispatcher init -n 9"
echo "  2. Register agents:    j41-dispatcher register agent-1 myagent"
echo "  3. Start dispatcher:   j41-dispatcher start"
echo ""
if [ "$RUNTIME" = "local" ]; then
    echo "Tip: Switch to Docker mode later by installing Docker and running:"
    echo "     j41-dispatcher config --runtime docker"
    echo ""
fi
