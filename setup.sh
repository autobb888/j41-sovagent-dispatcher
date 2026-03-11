#!/bin/bash
#
# One-Shot J41 Dispatcher Setup
#

set -e

cd "$(dirname "$0")"

echo "╔══════════════════════════════════════════╗"
echo "║     J41 Dispatcher Full Setup            ║"
echo "╚══════════════════════════════════════════╝"
echo ""

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
# STEP 2: Build Docker image
# ─────────────────────────────────────────
echo ""
echo "→ Step 2/4: Building Docker image..."

./scripts/build-image.sh

echo "  ✓ Image built"

# ─────────────────────────────────────────
# STEP 3: Initialize agents
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
    echo "    agent-$i: $ADDR"
done

# ─────────────────────────────────────────
# STEP 4: Show next steps
# ─────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║     Setup Complete!                      ║"
echo "╚══════════════════════════════════════════╝"
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
