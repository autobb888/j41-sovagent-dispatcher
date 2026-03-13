#!/bin/bash
#
# One-Shot J41 Dispatcher Setup
# Installs everything needed and configures runtime mode.
#

set -e

cd "$(dirname "$0")"

echo "╔══════════════════════════════════════════╗"
echo "║     J41 Dispatcher Full Setup            ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ─────────────────────────────────────────
# STEP 0: Ensure nvm/node is available
# ─────────────────────────────────────────

# Load nvm if installed
for NVM_PATH in "$HOME/.nvm/nvm.sh" "/usr/local/share/nvm/nvm.sh" "$NVM_DIR/nvm.sh"; do
    [ -s "$NVM_PATH" ] && . "$NVM_PATH" && break
done

if ! command -v node > /dev/null 2>&1; then
    echo "→ Node.js not found. Installing via nvm..."
    if ! command -v nvm > /dev/null 2>&1; then
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash 2>/dev/null
        export NVM_DIR="$HOME/.nvm"
        . "$NVM_DIR/nvm.sh"
    fi
    nvm install 22
    echo ""
fi
echo "✓ node: $(node --version)"

# Check for yarn
if ! command -v yarn > /dev/null 2>&1; then
    echo "→ Installing yarn..."
    npm install -g yarn
fi
echo "✓ yarn: $(yarn --version)"

# ─────────────────────────────────────────
# STEP 1: Install dependencies
# ─────────────────────────────────────────
echo ""
echo "→ Step 1/4: Installing dependencies with yarn..."

yarn install

echo "  ✓ Dependencies installed"

# ─────────────────────────────────────────
# STEP 2: Detect Docker and choose runtime
# ─────────────────────────────────────────
echo ""

# Read existing config if available
CONFIG_FILE="${HOME}/.j41/dispatcher/config.json"
RUNTIME=""
if [ -f "$CONFIG_FILE" ]; then
    RUNTIME=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$CONFIG_FILE','utf8')).runtime||'')}catch{console.log('')}" 2>/dev/null)
fi

if [ -z "$RUNTIME" ]; then
    if command -v docker > /dev/null 2>&1 && docker info > /dev/null 2>&1; then
        RUNTIME="docker"
        echo "✓ Docker detected — using container mode"
    else
        echo "⚠️  Docker not available."
        echo ""
        if [ -t 0 ]; then
            echo "  Choose runtime mode:"
            echo "    1) Install Docker (recommended for production)"
            echo "    2) Local process mode (no Docker needed)"
            echo ""
            read -p "  Enter choice [1/2] (default: 2): " CHOICE
            CHOICE=${CHOICE:-2}
            case "$CHOICE" in
                1)
                    echo "  → Installing Docker..."
                    curl -fsSL https://get.docker.com | sh
                    sudo usermod -aG docker "$USER" 2>/dev/null || true
                    RUNTIME="docker"
                    echo "  ✓ Docker installed (log out/in for group permissions)"
                    ;;
                *)
                    RUNTIME="local"
                    echo "  ✓ Using local process mode"
                    ;;
            esac
        else
            RUNTIME="local"
            echo "  → Non-interactive: defaulting to local process mode"
        fi
    fi

    # Persist runtime choice
    mkdir -p "${HOME}/.j41/dispatcher"
    node -e "require('fs').writeFileSync('$CONFIG_FILE', JSON.stringify({runtime:'$RUNTIME'},null,2))"
fi

echo "  Runtime: ${RUNTIME}"

# ─────────────────────────────────────────
# STEP 3: Build Docker image (or skip)
# ─────────────────────────────────────────
echo ""
if [ "$RUNTIME" = "docker" ]; then
    echo "→ Step 2/4: Building Docker image..."
    ./scripts/build-image.sh
    echo "  ✓ Image built"
else
    echo "→ Step 2/4: Skipping Docker image build (local process mode)"
fi

# ─────────────────────────────────────────
# STEP 4: Initialize agents
# ─────────────────────────────────────────
echo ""
echo "→ Step 3/4: Initializing 9 agent identities..."

node src/cli.js init -n 9

echo ""
echo "  ✓ 9 agents created"
echo ""
echo "  Agent addresses (pre-funded on VRSCTEST):"
for i in {1..9}; do
    ADDR=$(cat ~/.j41/dispatcher/agents/agent-$i/keys.json 2>/dev/null | grep '"address"' | cut -d'"' -f4)
    if [ -n "$ADDR" ]; then
        echo "    agent-$i: $ADDR"
    fi
done

# ─────────────────────────────────────────
# STEP 5: Show next steps
# ─────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║     Setup Complete!                      ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "Runtime mode: ${RUNTIME}"
echo ""
echo "Next steps:"
echo ""
echo "1. Register agents on platform:"
echo "   yarn cli register agent-1 myagent1"
echo "   yarn cli register agent-2 myagent2"
echo ""
echo "2. Wait for confirmations (~5-15 min each)"
echo ""
echo "3. Start dispatcher:"
echo "   yarn start"
echo ""
echo "4. Post jobs from dashboard and watch!"
echo ""
if [ "$RUNTIME" = "local" ]; then
    echo "Tip: To switch to Docker mode later:"
    echo "   node src/cli.js config --runtime docker"
    echo "   ./scripts/build-image.sh"
    echo ""
fi
